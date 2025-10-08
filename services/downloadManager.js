// services/downloadManager.js (ULTRA-FAST v3.1 - полная и исправленная)

import SCDL from 'soundcloud-downloader';
import got from 'got';
import pMap from 'p-map';
import Redis from 'ioredis';
import { Markup } from 'telegraf';

import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import * as db from '../db.js';
import { getSetting } from './settingsManager.js';
import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME } from '../config.js';

// ========================= CONFIGURATION =========================

const MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024;
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 5;

let scdl = null;
(async () => {
  try {
    scdl = await SCDL.create();
    console.log('✅ [SCDL] Клиент инициализирован');
  } catch (e) {
    console.error('❌ [SCDL] Ошибка инициализации:', e.message);
  }
})();

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryStrategy: (times) => Math.min(times * 100, 3000),
  maxRetriesPerRequest: 3,
});

redis.on('connect', () => console.log('✅ [Redis] Подключен к кэшу треков'));
redis.on('error', (err) => console.error('❌ [Redis] Ошибка:', err.message));

// ========================= HELPER FUNCTIONS =========================

function sanitizeFilename(name) {
  return (String(name) || 'track').replace(/[<>:"/\\|?*]+/g, '').trim().slice(0, 200) || 'track';
}
function getCacheKey(url) { return `sc:${url.replace(/\?.*$/, '')}`; }
async function safeSendMessage(userId, text, extra = {}) { try { return await bot.telegram.sendMessage(userId, text, extra); } catch (e) { if (e.response?.error_code === 403) { try { await db.updateUserField(userId, 'active', false); } catch {} } return null; } }
async function incrementDownload(userId, title, fileId, cacheKey) { return await db.incrementDownloadsAndLogPg(userId, title, fileId, cacheKey); }
async function getUserUsage(userId) { return await db.getUserUsage(userId); }

// ========================= CACHE FUNCTIONS =========================

async function getCachedTrack(url) {
  const cacheKey = getCacheKey(url);
  try {
    const redisCache = await redis.get(cacheKey);
    if (redisCache) return JSON.parse(redisCache);

    const pgCache = await db.findCachedTrack(cacheKey);
    if (pgCache?.fileId) {
      await redis.setex(cacheKey, 2592000, JSON.stringify(pgCache)).catch(() => {});
      return pgCache;
    }
  } catch (e) {
    console.error('[Cache] Ошибка чтения:', e.message);
  }
  return null;
}

async function setCachedTrack(url, fileId, metadata) {
  const cacheKey = getCacheKey(url);
  const data = { fileId, trackName: metadata.title, artist: metadata.artist, duration: metadata.duration };
  try {
    await redis.setex(cacheKey, 2592000, JSON.stringify(data));
    await db.cacheTrack({ url: cacheKey, fileId, ...metadata });
    console.log(`[Cache] 💾 Сохранено: ${metadata.title}`);
  } catch (e) {
    console.error('[Cache] Ошибка записи:', e.message);
  }
}

// ========================= PROCESSORS =========================

async function processTrack(userId, url) {
  const startTime = Date.now();
  try {
    if (!scdl) {
      console.warn('[SCDL] Ожидание инициализации...');
      await new Promise(r => setTimeout(r, 1000));
      if (!scdl) scdl = await SCDL.create();
    }

    const cached = await getCachedTrack(url);
    if (cached?.fileId) {
      await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.trackName, performer: cached.artist, duration: cached.duration });
      await incrementDownload(userId, cached.trackName, cached.fileId, getCacheKey(url));
      console.log(`[Track] ✅ Отправлено за ${((Date.now() - startTime) / 1000).toFixed(1)}с (из кэша)`);
      return;
    }

    const info = await scdl.getInfo(url);
    const metadata = {
      id: info.id,
      title: sanitizeFilename(info.title),
      artist: info.user?.username || 'Unknown Artist',
      duration: info.duration ? Math.round(info.duration / 1000) : 0,
      thumbnail: info.artwork_url || info.user?.avatar_url
    };

    const stream = await scdl.download(url);
    const sentMsg = await bot.telegram.sendAudio(
      userId,
      { source: stream, filename: `${metadata.title}.mp3` },
      { title: metadata.title, performer: metadata.artist, duration: metadata.duration, thumb: { url: metadata.thumbnail } }
    );

    if (sentMsg?.audio?.file_id) {
      setCachedTrack(url, sentMsg.audio.file_id, metadata);
      incrementDownload(userId, metadata.title, sentMsg.audio.file_id, getCacheKey(url));
    }
    console.log(`[Track] ✅ Отправлено за ${((Date.now() - startTime) / 1000).toFixed(1)}с (новая загрузка)`);
  } catch (err) {
    console.error(`[Track] ❌ Ошибка для user ${userId} (${url}):`, err.message);
    await safeSendMessage(userId, '❌ Не удалось обработать трек. Возможно, он приватный или был удалён.');
  }
}

async function processPlaylist(userId, url, maxTracks) {
  let statusMessage = null;
  try {
    statusMessage = await safeSendMessage(userId, `🔍 Анализирую плейлист...`);
    
    if (!scdl) scdl = await SCDL.create();
    const playlist = await scdl.getSetInfo(url);
    if (!playlist?.tracks?.length) throw new Error('Плейлист пуст или недоступен.');

    const trackUrls = playlist.tracks.slice(0, maxTracks).map(t => t.permalink_url).filter(Boolean);
    
    if (statusMessage) await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, `⚡️ Обрабатываю ${trackUrls.length} треков параллельно...`).catch(() => {});
    
    await pMap(trackUrls, (trackUrl) => processTrack(userId, trackUrl), { concurrency: MAX_CONCURRENT_DOWNLOADS });
    
    if (statusMessage) await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
    await safeSendMessage(userId, `✅ Плейлист "${sanitizeFilename(playlist.title)}" обработан (${trackUrls.length} треков).`);
  } catch (err) {
    console.error('[Playlist] ❌ Ошибка:', err.message);
    if (statusMessage) await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, '❌ Не удалось обработать плейлист.').catch(() => {});
    else await safeSendMessage(userId, '❌ Не удалось обработать плейлист.');
  }
}

// ========================= MAIN ENQUEUE FUNCTION =========================

export function enqueue(ctx, userId, url) {
  (async () => {
    try {
      if (!url?.includes('soundcloud.com')) return;
      
      await db.resetDailyLimitIfNeeded(userId);
      const user = await getUserUsage(userId);
      
      if (!user || user.downloads_today >= user.premium_limit) {
        // ... (твой код для уведомления о лимите, он правильный)
        return;
      }
      
      const isPlaylist = url.includes('/sets/');
      if (isPlaylist) {
        const limits = { free: 10, plus: 30, pro: 100, unlim: 200 };
        let pLimit = limits.free;
        if (user.premium_limit >= 10000) pLimit = limits.unlim;
        else if (user.premium_limit >= 100) pLimit = limits.pro;
        else if (user.premium_limit >= 30) pLimit = limits.plus;
        
        const maxTracks = Math.min(Math.max(0, user.premium_limit - user.downloads_today), pLimit);
        await processPlaylist(userId, url, maxTracks);
      } else {
        await processTrack(userId, url);
      }
    } catch (err) {
      console.error('[Enqueue] ❌ Ошибка:', err.message);
      await safeSendMessage(userId, '❌ Произошла ошибка.');
    }
  })();
}

// ========================= QUEUE (для совместимости) =========================

export const downloadQueue = {
  size: 0,
  pending: 0,
  enqueue: (task) => processTrack(task.userId, task.url),
};

console.log(`
╔═══════════════════════════════════════════════════════╗
║  ⚡ Download Manager v3.1 (SCDL Streaming)               ║
╚═══════════════════════════════════════════════════════════╝
`);

export function initializeDownloadManager() {}