// services/downloadManager.js (ULTRA-FAST FINAL — ПРАВИЛЬНЫЙ API)

import SCDL from 'soundcloud-downloader';
import pMap from 'p-map';
import Redis from 'ioredis';
import { Markup } from 'telegraf';

import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import * as db from '../db.js';
import { getSetting } from './settingsManager.js';
import { CHANNEL_USERNAME } from '../config.js';

// ========================= CONFIGURATION =========================

const MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024;
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 5;

// 🔥 Создаём экземпляр SCDL
let scdl = null;
(async () => {
  try {
    scdl = await SCDL.create();
    console.log('✅ [SCDL] Клиент инициализирован');
  } catch (e) {
    console.error('❌ [SCDL] Ошибка инициализации:', e.message);
  }
})();

// 🔥 Redis для мгновенного кэша
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryStrategy: (times) => {
    if (times > 10) return null;
    return Math.min(times * 100, 3000);
  },
  maxRetriesPerRequest: 3,
  lazyConnect: false
});

redis.on('connect', () => console.log('✅ [Redis] Подключен к кэшу треков'));
redis.on('error', (err) => console.error('❌ [Redis] Ошибка:', err.message));

// ========================= HELPER FUNCTIONS =========================

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'track';
  return name.replace(/[<>:"/\\|?*]+/g, '').trim().slice(0, 200) || 'track';
}

function getCacheKey(url, metadata) {
  if (metadata?.id) return `sc:${metadata.id}`;
  return `sc:${url.replace(/\?.*$/, '')}`;
}

async function safeSendMessage(userId, text, extra = {}) {
  try {
    return await bot.telegram.sendMessage(userId, text, extra);
  } catch (e) {
    if (e.response?.error_code === 403) {
      try { 
        await db.updateUserField(userId, 'active', false); 
      } catch (dbErr) {
        console.error(`[DB] Деактивация user ${userId}:`, dbErr.message);
      }
    }
    return null;
  }
}

async function incrementDownload(userId, trackTitle, fileId, cacheKey) {
  if (typeof db.incrementDownloadsAndLogPg === 'function') {
    return await db.incrementDownloadsAndLogPg(userId, trackTitle, fileId, cacheKey);
  }
  return await db.incrementDownloadsAndSaveTrack(userId, trackTitle, fileId, cacheKey);
}

async function getUserUsage(userId) {
  if (typeof db.getUserUsage === 'function') return await db.getUserUsage(userId);
  if (typeof db.getUserLite === 'function') return await db.getUserLite(userId);
  return await db.getUser(userId);
}

// ========================= REDIS CACHE =========================

async function getCachedTrack(url, metadata) {
  try {
    const cacheKey = getCacheKey(url, metadata);
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      const data = JSON.parse(cached);
      console.log(`[Cache] ⚡ Redis HIT: ${data.trackName}`);
      return data;
    }
    
    const pgCached = await db.findCachedTrack(cacheKey);
    
    if (pgCached?.fileId) {
      console.log(`[Cache] 💾 PostgreSQL HIT: ${pgCached.trackName}`);
      await redis.setex(cacheKey, 2592000, JSON.stringify(pgCached)).catch(() => {});
      return pgCached;
    }
    
    console.log(`[Cache] ❌ MISS для ${url}`);
    return null;
  } catch (e) {
    console.error('[Cache] Ошибка чтения:', e.message);
    return null;
  }
}

async function setCachedTrack(url, fileId, metadata) {
  try {
    const cacheKey = getCacheKey(url, metadata);
    const data = {
      fileId,
      trackName: metadata.title,
      artist: metadata.artist,
      duration: metadata.duration,
      cachedAt: Date.now()
    };
    
    await redis.setex(cacheKey, 2592000, JSON.stringify(data));
    
    db.cacheTrack({
      url: cacheKey,
      fileId,
      title: metadata.title,
      artist: metadata.artist,
      duration: metadata.duration,
      thumbnail: metadata.thumbnail
    }).catch(e => console.error('[DB Cache] Ошибка:', e.message));
    
    console.log(`[Cache] 💾 Сохранено: ${metadata.title}`);
    
  } catch (e) {
    console.error('[Cache] Ошибка записи:', e.message);
  }
}

// ========================= TRACK PROCESSOR =========================

async function processTrack(userId, url) {
  const startTime = Date.now();
  
  try {
    // 🔥 Ждём инициализации SCDL
    if (!scdl) {
      console.log('[SCDL] Ожидание инициализации...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      if (!scdl) {
        scdl = await SCDL.create();
      }
    }
    
    // 1️⃣ Получение метаданных (ПРАВИЛЬНЫЙ API!)
    const info = await scdl.getInfo(url);
    
    if (!info) {
      throw new Error('Трек не найден или недоступен');
    }
    
    const metadata = {
      id: info.id,
      title: sanitizeFilename(info.title || 'Unknown Track'),
      artist: info.user?.username || 'Unknown Artist',
      duration: info.duration ? Math.round(info.duration / 1000) : undefined,
      thumbnail: info.artwork_url || info.user?.avatar_url
    };
    
    console.log(`[Track] 📝 "${metadata.title}" by ${metadata.artist}`);
    
    // 2️⃣ Проверка кэша
    const cached = await getCachedTrack(url, metadata);
    
    if (cached?.fileId) {
      await bot.telegram.sendAudio(userId, cached.fileId, {
        title: cached.trackName,
        performer: cached.artist,
        duration: cached.duration
      });
      
      await incrementDownload(userId, cached.trackName, cached.fileId, getCacheKey(url, metadata));
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Track] ✅ ${elapsed}с (кэш)`);
      return;
    }
    
    // 3️⃣ 🔥 STREAMING DOWNLOAD (ПРАВИЛЬНЫЙ API!)
    console.log(`[Track] 🚀 Скачиваю: ${metadata.title}`);
    
    const stream = await scdl.download(url);
    
    // 4️⃣ 🔥 МГНОВЕННАЯ отправка
    const sentMsg = await bot.telegram.sendAudio(
      userId,
      { 
        source: stream, 
        filename: `${metadata.title}.mp3` 
      },
      { 
        title: metadata.title, 
        performer: metadata.artist, 
        duration: metadata.duration,
        thumb: metadata.thumbnail 
      }
    );
    
    const fileId = sentMsg?.audio?.file_id;
    
    // 5️⃣ Кэширование (в фоне)
    if (fileId) {
      setCachedTrack(url, fileId, metadata);
      incrementDownload(userId, metadata.title, fileId, getCacheKey(url, metadata));
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Track] ✅ ${elapsed}с`);
    
  } catch (err) {
    const errorDetails = err?.message || '';
    let userMsg = '❌ Не удалось обработать трек.';
    
    if (errorDetails.includes('Not a SoundCloud')) {
      userMsg = '❌ Неверная ссылка на SoundCloud.';
    } else if (errorDetails.includes('timed out')) {
      userMsg = '❌ Превышено время ожидания.';
    } else if (errorDetails.includes('404')) {
      userMsg = '❌ Трек не найден или удалён.';
    } else if (errorDetails.includes('403')) {
      userMsg = '❌ Доступ к треку ограничен.';
    } else if (errorDetails.includes('private')) {
      userMsg = '❌ Трек приватный.';
    }
    
    console.error(`[Track] ❌ Ошибка для user ${userId}:`, errorDetails);
    await safeSendMessage(userId, userMsg);
  }
}

// ========================= ENQUEUE =========================

export function enqueue(ctx, userId, url) {
  (async () => {
    try {
      if (!url || typeof url !== 'string' || !url.includes('soundcloud.com')) {
        await safeSendMessage(userId, '❌ Некорректная ссылка на SoundCloud');
        return;
      }
      
      await db.resetDailyLimitIfNeeded(userId);
      const user = await getUserUsage(userId);
      
      if (!user || user.downloads_today >= user.premium_limit) {
        const bonusAvailable = Boolean(CHANNEL_USERNAME && !user?.subscribed_bonus_used);
        const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
        const bonusText = bonusAvailable
          ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a>.`
          : '';

        const text = `${T('limitReached')}${bonusText}`;
        const extra = { parse_mode: 'HTML', disable_web_page_preview: true };

        if (bonusAvailable) {
          extra.reply_markup = {
            inline_keyboard: [[ 
              Markup.button.callback('✅ Забрать бонус', 'check_subscription') 
            ]]
          };
        }

        await safeSendMessage(userId, text, extra);
        return;
      }
      
      await processTrack(userId, url);
      
    } catch (err) {
      console.error('[Enqueue] ❌ Ошибка:', err.message);
      await safeSendMessage(userId, '❌ Произошла ошибка.');
    }
  })();
}

// ========================= QUEUE =========================

export const downloadQueue = new TaskQueue({
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
  taskProcessor: async (task) => {
    await processTrack(task.userId, task.url);
  }
});

console.log(`
╔═══════════════════════════════════════════════════════════╗
║  ⚡ Download Manager v3.0 (ULTRA-FAST MODE)              ║
╟───────────────────────────────────────────────────────────╢
║  🚀 Режим: Мгновенная отправка                           ║
║    ✅ Streaming download (БЕЗ временных файлов)          ║
║    ✅ Streaming upload (прямая отправка)                 ║
║    ✅ Redis кэш (< 100 мс)                               ║
║    ✅ Обложки из SoundCloud API                          ║
║    ✅ Нет очереди для одиночных треков                   ║
╟───────────────────────────────────────────────────────────╢
║  📊 Параметры:                                            ║
║    • Max Concurrent: ${MAX_CONCURRENT_DOWNLOADS} (только для плейлистов)      ║
║    • Cache TTL: 30 дней                                  ║
║    • Временные файлы: НЕТ ⚡                              ║
╚═══════════════════════════════════════════════════════════╝
`);

export default {
  enqueue,
  downloadQueue,
  processTrack
};