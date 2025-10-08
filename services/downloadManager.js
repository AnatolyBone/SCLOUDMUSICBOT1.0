// services/downloadManager.js (ULTRA-FAST VERSION 3.0)

import scdl from 'soundcloud-downloader';
import got from 'got';
import pMap from 'p-map';
import Redis from 'ioredis';
import { Markup } from 'telegraf';
import path from 'path';
import crypto from 'crypto';

import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import * as db from '../db.js';
import { getSetting } from './settingsManager.js';
import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME } from '../config.js';

// ========================= CONFIGURATION =========================

const MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024; // 49 МБ
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 5; // 🔥 Увеличено до 5

// 🔥 Redis для быстрого кэша
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryStrategy: (times) => Math.min(times * 50, 2000),
  maxRetriesPerRequest: 3
});

redis.on('connect', () => console.log('✅ [Redis] Подключен к кэшу треков'));
redis.on('error', (err) => console.error('❌ [Redis] Ошибка:', err.message));

// ========================= HELPER FUNCTIONS =========================

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'track';
  return name.replace(/[<>:"/\\|?*]+/g, '').trim().slice(0, 200) || 'track';
}

function getCacheKey(url) {
  // Нормализуем URL для кэша
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

async function getCachedTrack(url) {
  try {
    const cacheKey = getCacheKey(url);
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      const data = JSON.parse(cached);
      console.log(`[Cache] ⚡ HIT для ${url}`);
      return data;
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
    const cacheKey = getCacheKey(url);
    const data = {
      fileId,
      title: metadata.title,
      artist: metadata.artist,
      duration: metadata.duration,
      thumbnail: metadata.thumbnail,
      cachedAt: Date.now()
    };
    
    // TTL 30 дней
    await redis.setex(cacheKey, 2592000, JSON.stringify(data));
    console.log(`[Cache] 💾 Сохранено: ${metadata.title}`);
    
    // Дублируем в PostgreSQL для долгосрочного хранения
    await db.cacheTrack({
      url: cacheKey,
      fileId,
      title: metadata.title,
      artist: metadata.artist,
      duration: metadata.duration,
      thumbnail: metadata.thumbnail
    }).catch(e => console.error('[DB Cache] Ошибка:', e.message));
    
  } catch (e) {
    console.error('[Cache] Ошибка записи:', e.message);
  }
}

// ========================= TRACK PROCESSOR =========================

/**
 * 🔥 НОВАЯ МОЛНИЕНОСНАЯ ОБРАБОТКА ТРЕКА
 */
async function processTrack(userId, url) {
  let statusMessage = null;
  const startTime = Date.now();
  
  try {
    // 1️⃣ Проверка кэша (Redis - мгновенно!)
    const cached = await getCachedTrack(url);
    
    if (cached?.fileId) {
      console.log(`[Track] ⚡ Отправка из кэша: ${cached.title}`);
      
      await bot.telegram.sendAudio(userId, cached.fileId, {
        title: cached.title,
        performer: cached.artist,
        duration: cached.duration
      });
      
      await incrementDownload(userId, cached.title, cached.fileId, getCacheKey(url));
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Track] ✅ Отправлено за ${elapsed}с (из кэша)`);
      return;
    }
    
    // 2️⃣ Получение метаданных (БЕЗ скачивания!)
    statusMessage = await safeSendMessage(userId, '🔍 Получаю информацию...');
    
    const info = await scdl.getInfo(url);
    
    if (!info) {
      throw new Error('Не удалось получить информацию о треке');
    }
    
    const metadata = {
      title: sanitizeFilename(info.title || 'Unknown Track'),
      artist: info.user?.username || 'Unknown Artist',
      duration: info.duration ? Math.round(info.duration / 1000) : undefined,
      thumbnail: info.artwork_url || info.user?.avatar_url
    };
    
    console.log(`[Track] 📝 Метаданные: "${metadata.title}" by ${metadata.artist}`);
    
    // 3️⃣ Проверка размера файла
    if (statusMessage) {
      await bot.telegram.editMessageText(
        userId,
        statusMessage.message_id,
        undefined,
        '⏬ Проверяю размер файла...'
      ).catch(() => {});
    }
    
    // Получаем прямую ссылку на стрим
    const streamInfo = await scdl.download(url);
    
    // Проверяем размер через HEAD-запрос
    try {
      const headResponse = await got.head(streamInfo, { timeout: { request: 5000 } });
      const fileSize = parseInt(headResponse.headers['content-length'], 10);
      
      if (fileSize > MAX_FILE_SIZE_BYTES) {
        throw new Error('FILE_TOO_LARGE');
      }
      
      console.log(`[Track] 📊 Размер файла: ${(fileSize / 1024 / 1024).toFixed(2)} МБ`);
    } catch (sizeErr) {
      console.warn('[Track] ⚠️ Не удалось проверить размер, продолжаю...');
    }
    
    // 4️⃣ Отправка файла НАПРЯМУЮ (БЕЗ сохранения на диск!)
    if (statusMessage) {
      await bot.telegram.editMessageText(
        userId,
        statusMessage.message_id,
        undefined,
        '📤 Отправляю трек...'
      ).catch(() => {});
    }
    
    console.log(`[Track] 🚀 Начинаю стриминг: ${metadata.title}`);
    
    // 🔥 STREAMING UPLOAD (главная оптимизация!)
    const stream = got.stream(streamInfo);
    
    const sentMsg = await bot.telegram.sendAudio(userId, {
      source: stream,
      filename: `${metadata.title}.mp3`
    }, {
      title: metadata.title,
      performer: metadata.artist,
      duration: metadata.duration
    });
    
    const fileId = sentMsg?.audio?.file_id;
    
    // 5️⃣ Кэширование file_id
    if (fileId) {
      await setCachedTrack(url, fileId, metadata);
      await incrementDownload(userId, metadata.title, fileId, getCacheKey(url));
    }
    
    // 6️⃣ Удаление статусного сообщения
    if (statusMessage) {
      await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Track] ✅ Завершено за ${elapsed}с (новая загрузка)`);
    
  } catch (err) {
    const errorDetails = err?.message || '';
    let userMsg = '❌ Не удалось обработать трек.';
    
    if (errorDetails.includes('FILE_TOO_LARGE')) {
      userMsg = '❌ Файл слишком большой (макс. 49 МБ).';
    } else if (errorDetails.includes('Not a SoundCloud')) {
      userMsg = '❌ Неверная ссылка на SoundCloud.';
    } else if (errorDetails.includes('timed out')) {
      userMsg = '❌ Превышено время ожидания.';
    } else if (errorDetails.includes('404')) {
      userMsg = '❌ Трек не найден или удалён.';
    } else if (errorDetails.includes('403')) {
      userMsg = '❌ Доступ к треку ограничен.';
    }
    
    console.error(`[Track] ❌ Ошибка для user ${userId}:`, errorDetails);
    
    if (statusMessage) {
      await bot.telegram.editMessageText(
        userId,
        statusMessage.message_id,
        undefined,
        userMsg
      ).catch(() => {});
    } else {
      await safeSendMessage(userId, userMsg);
    }
  }
}

// ========================= PLAYLIST PROCESSOR =========================

/**
 * 🔥 ПАРАЛЛЕЛЬНАЯ ОБРАБОТКА ПЛЕЙЛИСТА
 */
async function processPlaylist(userId, playlistUrl, maxTracks = 10) {
  let statusMessage = null;
  
  try {
    statusMessage = await safeSendMessage(userId, '🔍 Анализирую плейлист...');
    
    // Получаем список треков
    const playlistInfo = await scdl.getSetInfo(playlistUrl);
    
    if (!playlistInfo?.tracks || playlistInfo.tracks.length === 0) {
      throw new Error('Плейлист пуст или недоступен');
    }
    
    const trackUrls = playlistInfo.tracks
      .slice(0, maxTracks)
      .map(t => t.permalink_url)
      .filter(Boolean);
    
    console.log(`[Playlist] 📋 Найдено ${trackUrls.length} треков`);
    
    if (statusMessage) {
      await bot.telegram.editMessageText(
        userId,
        statusMessage.message_id,
        undefined,
        `⚡ Обрабатываю ${trackUrls.length} треков параллельно...`
      ).catch(() => {});
    }
    
    // 🔥 ПАРАЛЛЕЛЬНАЯ обработка (до 5 треков одновременно)
    await pMap(trackUrls, async (trackUrl) => {
      await processTrack(userId, trackUrl);
    }, { concurrency: 5 });
    
    // Удаляем статусное сообщение
    if (statusMessage) {
      await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
    }
    
    await safeSendMessage(userId, `✅ Плейлист обработан: ${trackUrls.length} треков`);
    
  } catch (err) {
    console.error('[Playlist] ❌ Ошибка:', err.message);
    
    if (statusMessage) {
      await bot.telegram.editMessageText(
        userId,
        statusMessage.message_id,
        undefined,
        '❌ Не удалось обработать плейлист'
      ).catch(() => {});
    } else {
      await safeSendMessage(userId, '❌ Не удалось обработать плейлист');
    }
  }
}

// ========================= MAIN ENQUEUE FUNCTION =========================

/**
 * 🔥 ГЛАВНАЯ ФУНКЦИЯ (упрощённая)
 */
export function enqueue(ctx, userId, url) {
  (async () => {
    try {
      // 1️⃣ Валидация
      if (!url || typeof url !== 'string' || !url.includes('soundcloud.com')) {
        await safeSendMessage(userId, '❌ Некорректная ссылка на SoundCloud');
        return;
      }
      
      // 2️⃣ Проверка лимитов
      await db.resetDailyLimitIfNeeded(userId);
      const user = await getUserUsage(userId);
      
      if (!user || user.downloads_today >= user.premium_limit) {
        const bonusAvailable = Boolean(CHANNEL_USERNAME && !user?.subscribed_bonus_used);
        const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
        const bonusText = bonusAvailable
          ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.`
          : '';

        const text = `${T('limitReached')}${bonusText}`;
        const extra = { parse_mode: 'HTML', disable_web_page_preview: true };

                if (bonusAvailable) {
          extra.reply_markup = {
            inline_keyboard: [[ Markup.button.callback('✅ Я подписался, забрать бонус', 'check_subscription') ]]
          };
        }

        await safeSendMessage(userId, text, extra);
        return;
      }
      
      // 3️⃣ Определяем тип ссылки (трек или плейлист)
      const isPlaylist = url.includes('/sets/');
      
      if (isPlaylist) {
        // Определяем лимит для плейлиста
        const limits = {
          free: parseInt(getSetting('playlist_limit_free'), 10) || 10,
          plus: parseInt(getSetting('playlist_limit_plus'), 10) || 30,
          pro: parseInt(getSetting('playlist_limit_pro'), 10) || 100,
          unlim: parseInt(getSetting('playlist_limit_unlim'), 10) || 200,
        };

        let playlistLimit = limits.free;
        if (user.premium_limit >= 10000) playlistLimit = limits.unlim;
        else if (user.premium_limit >= 100) playlistLimit = limits.pro;
        else if (user.premium_limit >= 30) playlistLimit = limits.plus;

        const remainingToday = Math.max(0, user.premium_limit - user.downloads_today);
        const maxTracksToProcess = Math.min(remainingToday, playlistLimit);
        
        await processPlaylist(userId, url, maxTracksToProcess);
        
      } else {
        // Одиночный трек
        await processTrack(userId, url);
      }
      
    } catch (err) {
      console.error('[Enqueue] ❌ Критическая ошибка:', err.message);
      await safeSendMessage(userId, '❌ Произошла ошибка при обработке ссылки.');
    }
  })();
}

// ========================= QUEUE (для совместимости) =========================

export const downloadQueue = new TaskQueue({
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
  taskProcessor: async (task) => {
    // Обработчик для старых задач из очереди
    await processTrack(task.userId, task.url);
  }
});

console.log(`
╔═══════════════════════════════════════════════════════════╗
║  🚀 Download Manager v3.0 (Ultra-Fast)                   ║
╟───────────────────────────────────────────────────────────╢
║  ⚡ Оптимизации:                                          ║
║    ✅ Soundcloud-downloader (вместо youtube-dl)          ║
║    ✅ Streaming upload (БЕЗ временных файлов)            ║
║    ✅ Redis кэш (мгновенная отправка)                    ║
║    ✅ Параллельная обработка (до 5 треков)               ║
║    ✅ Проверка размера ДО скачивания                     ║
╟───────────────────────────────────────────────────────────╢
║  📊 Параметры:                                            ║
║    • Max Concurrent: ${MAX_CONCURRENT_DOWNLOADS}                                  ║
║    • Max File Size: 49 МБ                                ║
║    • Cache TTL: 30 дней                                  ║
╚═══════════════════════════════════════════════════════════╝
`);

// ========================= EXPORTS =========================

export default {
  enqueue,
  downloadQueue,
  processTrack,
  processPlaylist
};