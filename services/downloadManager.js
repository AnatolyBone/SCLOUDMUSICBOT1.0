// services/downloadManager.js (ULTRA-FAST FINAL VERSION with FFmpeg & Storage)

import scdl from 'soundcloud-downloader';
import pMap from 'p-map';
import Redis from 'ioredis';
import { Markup } from 'telegraf';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import ytdl from 'youtube-dl-exec';

import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import * as db from '../db.js';
import { getSetting } from './settingsManager.js';
import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME, PROXY_URL } from '../config.js';

// ========================= CONFIGURATION =========================

const cacheDir = path.join(os.tmpdir(), 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

const MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024; // 49 МБ
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 5;
const YTDL_TIMEOUT = 90;
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FFMPEG_AVAILABLE =
  (!!ffmpegPath && fs.existsSync(ffmpegPath)) &&
  process.env.FFMPEG_AVAILABLE !== '0' &&
  process.env.FFMPEG_STATIC_SKIP_DOWNLOAD !== '1';

// 🔥 Redis для быстрого кэша
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryStrategy: (times) => {
    if (times > 10) {
      console.error('[Redis] Превышен лимит попыток переподключения.');
      return null;
    }
    return Math.min(times * 100, 3000);
  },
  maxRetriesPerRequest: 3
});

redis.on('connect', () => console.log('✅ [Redis] Подключен к кэшу треков'));
redis.on('error', (err) => console.error('❌ [Redis] Ошибка:', err.message));

// Базовые аргументы для youtube-dl (для плейлистов в bot.js)
export const YTDL_COMMON = {
  'ffmpeg-location': ffmpegPath || undefined,
  'user-agent': FAKE_USER_AGENT,
  proxy: PROXY_URL || undefined,
  retries: 2,
  'socket-timeout': YTDL_TIMEOUT,
  'no-warnings': true,
  'no-check-certificate': true,
  'prefer-free-formats': true,
  'extractor-args': 'soundcloud:client_id=a3e059563d7fd3372b49b37f00a00bcf'
};

// ========================= HELPER FUNCTIONS =========================

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'track';
  return name.replace(/[<>:"/\\|?*]+/g, '').trim().slice(0, 200) || 'track';
}

function getCacheKey(url, metadata) {
  // Приоритет: ID трека > нормализованный URL
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
      console.log(`[Cache] ⚡ HIT для ${url}`);
      return data;
    }
    
    // Fallback на PostgreSQL
    const pgCached = await db.findCachedTrack(cacheKey) || await db.findCachedTrack(url);
    
    if (pgCached?.fileId) {
      console.log(`[Cache] ⚡ HIT в PostgreSQL для ${url}`);
      // Дублируем в Redis для быстрого доступа в будущем
      await redis.setex(cacheKey, 2592000, JSON.stringify(pgCached));
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
      thumbnail: metadata.thumbnail,
      cachedAt: Date.now()
    };
    
    // Сохраняем в Redis (30 дней)
    await redis.setex(cacheKey, 2592000, JSON.stringify(data));
    console.log(`[Cache] 💾 Redis: ${metadata.title}`);
    
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

// ========================= FILE SIZE CHECK =========================

async function checkFileSize(url) {
  try {
    // Для SoundCloud используем scdl API (быстрее)
    const info = await scdl.getInfo(url);
    
    // У SoundCloud треки обычно до 10 МБ, проверяем только duration
    if (info.duration && info.duration > 3600000) { // > 1 часа
      console.warn('[Pre-flight] Трек слишком длинный:', info.duration / 1000 / 60, 'мин');
      return { ok: false, reason: 'FILE_TOO_LONG' };
    }
    
    return { ok: true };
  } catch (e) {
    console.warn('[Pre-flight] Ошибка проверки:', e.message);
    return { ok: true, reason: 'CHECK_FAILED' };
  }
}

// ========================= CACHE CLEANUP =========================

function startCacheCleanup() {
  const cleanupInterval = setInterval(async () => {
    try {
      const files = await fs.promises.readdir(cacheDir);
      const now = Date.now();
      let cleaned = 0;
      
      await Promise.all(files.map(async (file) => {
        try {
          const filePath = path.join(cacheDir, file);
          const stats = await fs.promises.stat(filePath);
          
          // Удаляем файлы старше 30 минут
          if (now - stats.mtimeMs > 1800000) {
            await fs.promises.unlink(filePath);
            cleaned++;
          }
        } catch {}
      }));
      
      if (cleaned > 0) {
        console.log(`[Cache Cleanup] 🧹 Удалено ${cleaned} временных файлов`);
      }
    } catch (err) {
      console.error('[Cache Cleanup] Ошибка:', err.message);
    }
  }, 1800000); // Каждые 30 минут
  
  process.on('SIGTERM', () => clearInterval(cleanupInterval));
  process.on('SIGINT', () => clearInterval(cleanupInterval));
}

startCacheCleanup();

// ========================= TRACK PROCESSOR =========================

async function processTrack(userId, url) {
  let tempFilePath = null;
  let statusMessage = null;
  const startTime = Date.now();
  
  try {
    // 1️⃣ Получение метаданных
    let info;
    try {
      info = await scdl.getInfo(url);
    } catch (scdlError) {
      console.error(`[Track] Ошибка scdl.getInfo для ${url}:`, scdlError.message);
      throw new Error('Не удалось получить информацию о треке');
    }
    
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
    
    console.log(`[Track] 📝 Обрабатываю: "${metadata.title}" by ${metadata.artist}`);
    
    // 2️⃣ Проверка кэша
    const cached = await getCachedTrack(url, metadata);
    
    if (cached?.fileId) {
      console.log(`[Track] ⚡ Отправка из кэша: ${cached.trackName}`);
      
      await bot.telegram.sendAudio(userId, cached.fileId, {
        title: cached.trackName,
        performer: cached.artist,
        duration: cached.duration
      });
      
      await incrementDownload(userId, cached.trackName, cached.fileId, getCacheKey(url, metadata));
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Track] ✅ Отправлено за ${elapsed}с (кэш)`);
      return;
    }
    
    // 3️⃣ Проверка размера
    statusMessage = await safeSendMessage(userId, '🔍 Проверяю доступность...');
    
    const sizeCheck = await checkFileSize(url);
    if (!sizeCheck.ok && sizeCheck.reason === 'FILE_TOO_LONG') {
      throw new Error('FILE_TOO_LONG');
    }
    
    // 4️⃣ Скачивание с обложкой (через временный файл для FFmpeg)
    if (statusMessage) {
      await bot.telegram.editMessageText(
        userId,
        statusMessage.message_id,
        undefined,
        '⏬ Скачиваю трек...'
      ).catch(() => {});
    }
    
    const tempFileName = `${metadata.id || crypto.randomUUID()}.mp3`;
    tempFilePath = path.join(cacheDir, tempFileName);
    
    console.log(`[Track] 🚀 Скачиваю: ${metadata.title}`);
    
    // Скачиваем через scdl и сохраняем на диск (для встраивания обложки)
    const stream = await scdl.download(url);
    const writeStream = fs.createWriteStream(tempFilePath);
    
    await new Promise((resolve, reject) => {
      stream.pipe(writeStream);
      stream.on('error', reject);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    
    console.log(`[Track] ✅ Скачано: ${(await fs.promises.stat(tempFilePath)).size / 1024 / 1024} МБ`);
    
    // 5️⃣ Встраивание обложки через FFmpeg (если доступен)
    if (FFMPEG_AVAILABLE && metadata.thumbnail) {
      try {
        console.log(`[Track] 🎨 Встраиваю обложку...`);
        
        const tempWithCover = tempFilePath.replace('.mp3', '-cover.mp3');
        
        await ytdl(url, {
          output: tempWithCover,
          'extract-audio': true,
          'audio-format': 'mp3',
          'embed-thumbnail': true,
          'add-metadata': true,
          'ffmpeg-location': ffmpegPath,
          ...YTDL_COMMON
        });
        
        // Заменяем файл версией с обложкой
        await fs.promises.unlink(tempFilePath);
        tempFilePath = tempWithCover;
        
        console.log(`[Track] ✅ Обложка встроена`);
      } catch (ffmpegErr) {
        console.warn('[Track] ⚠️ Не удалось встроить обложку:', ffmpegErr.message);
        // Продолжаем с файлом без обложки
      }
    }
    
    // 6️⃣ Проверка размера файла
    const fileStats = await fs.promises.stat(tempFilePath);
    
    if (fileStats.size > MAX_FILE_SIZE_BYTES) {
      throw new Error('FILE_TOO_LARGE');
    }
    
    // 7️⃣ Отправка в канал-хранилище (если настроено)
    if (statusMessage) {
      await bot.telegram.editMessageText(
        userId,
        statusMessage.message_id,
        undefined,
        '📤 Отправляю трек...'
      ).catch(() => {});
    }
    
    let finalFileId = null;
    const safeFilename = `${metadata.title}.mp3`;
    
        if (STORAGE_CHANNEL_ID) {
      try {
        console.log(`[Track] 💾 Загружаю в канал-хранилище...`);
        
        const sentToStorage = await bot.telegram.sendAudio(
          STORAGE_CHANNEL_ID,
          { source: fs.createReadStream(tempFilePath), filename: safeFilename },
          { 
            title: metadata.title, 
            performer: metadata.artist, 
            duration: metadata.duration 
          }
        );
        
        if (sentToStorage?.audio?.file_id) {
          finalFileId = sentToStorage.audio.file_id;
          
          // Кэшируем file_id
          await setCachedTrack(url, finalFileId, metadata);
          
          console.log(`[Track] ✅ Закэшировано в хранилище: ${metadata.title}`);
        }
      } catch (storageErr) {
        console.error('[Track] ⚠️ Ошибка загрузки в хранилище:', storageErr.message);
        // Продолжаем без кэширования
      }
    }
    
    // 8️⃣ Отправка пользователю
    if (finalFileId) {
      // Отправляем через file_id (быстро)
      await bot.telegram.sendAudio(userId, finalFileId, {
        title: metadata.title,
        performer: metadata.artist,
        duration: metadata.duration
      });
    } else {
      // Отправляем файл напрямую
      console.warn('[Track] Отправляю файл напрямую (хранилище не настроено)');
      
      const sentMsg = await bot.telegram.sendAudio(
        userId,
        { source: fs.createReadStream(tempFilePath), filename: safeFilename },
        { 
          title: metadata.title, 
          performer: metadata.artist, 
          duration: metadata.duration 
        }
      );
      
      finalFileId = sentMsg?.audio?.file_id;
      
      // Кэшируем file_id для будущего использования
      if (finalFileId) {
        await setCachedTrack(url, finalFileId, metadata);
      }
    }
    
    // 9️⃣ Удаление статусного сообщения
    if (statusMessage) {
      await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
    }
    
    // 🔟 Инкремент счетчика
    if (finalFileId) {
      await incrementDownload(userId, metadata.title, finalFileId, getCacheKey(url, metadata));
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Track] ✅ Завершено за ${elapsed}с (новая загрузка)`);
    
  } catch (err) {
    const errorDetails = err?.message || '';
    let userMsg = '❌ Не удалось обработать трек.';
    
    if (errorDetails.includes('FILE_TOO_LARGE')) {
      userMsg = '❌ Файл слишком большой (макс. 49 МБ).';
    } else if (errorDetails.includes('FILE_TOO_LONG')) {
      userMsg = '❌ Трек слишком длинный (макс. 1 час).';
    } else if (errorDetails.includes('Not a SoundCloud')) {
      userMsg = '❌ Неверная ссылка на SoundCloud.';
    } else if (errorDetails.includes('timed out') || errorDetails.includes('timeout')) {
      userMsg = '❌ Превышено время ожидания.';
    } else if (errorDetails.includes('404') || errorDetails.includes('not found')) {
      userMsg = '❌ Трек не найден или удалён.';
    } else if (errorDetails.includes('403') || errorDetails.includes('Forbidden')) {
      userMsg = '❌ Доступ к треку ограничен.';
    } else if (errorDetails.includes('private') || errorDetails.includes('geo')) {
      userMsg = '❌ Трек недоступен (приватный или geo-блок).';
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
    
  } finally {
    // Очистка временного файла
    if (tempFilePath) {
      fs.promises.unlink(tempFilePath).catch(() => {});
    }
  }
}

// ========================= MAIN ENQUEUE FUNCTION =========================

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
            inline_keyboard: [[ 
              Markup.button.callback('✅ Я подписался, забрать бонус', 'check_subscription') 
            ]]
          };
        }

        await safeSendMessage(userId, text, extra);
        return;
      }
      
      // 3️⃣ Обработка трека
      await processTrack(userId, url);
      
    } catch (err) {
      console.error('[Enqueue] ❌ Критическая ошибка:', err.message);
      await safeSendMessage(userId, '❌ Произошла ошибка при обработке ссылки.');
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
║  🚀 Download Manager v3.0 (Ultra-Fast + Storage)         ║
╟───────────────────────────────────────────────────────────╢
║  ⚡ Оптимизации:                                          ║
║    ✅ Soundcloud-downloader (вместо youtube-dl)          ║
║    ✅ Redis кэш (мгновенная отправка)                    ║
║    ✅ FFmpeg для обложек                                 ║
║    ✅ Канал-хранилище для кэширования                    ║
║    ✅ Параллельная обработка (до ${MAX_CONCURRENT_DOWNLOADS} треков)               ║
║    ✅ Автоочистка временных файлов                       ║
╟───────────────────────────────────────────────────────────╢
║  📊 Параметры:                                            ║
║    • Max Concurrent: ${MAX_CONCURRENT_DOWNLOADS}                                  ║
║    • Max File Size: 49 МБ                                ║
║    • Cache TTL: 30 дней                                  ║
║    • FFmpeg: ${FFMPEG_AVAILABLE ? '✅ Доступен' : '❌ Отключен'}                                ║
║    • Storage: ${STORAGE_CHANNEL_ID ? '✅ Настроен' : '⚠️ Не настроен'}                             ║
╚═══════════════════════════════════════════════════════════╝
`);

// ========================= EXPORTS =========================

export default {
  enqueue,
  downloadQueue,
  processTrack
};