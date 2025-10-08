// services/downloadManager.js (ОПТИМИЗИРОВАННАЯ ВЕРСИЯ 2.0)

import fetch from 'node-fetch';
import pMap from 'p-map';
import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME, PROXY_URL } from '../config.js';
import { Markup } from 'telegraf';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import ytdl from 'youtube-dl-exec';
import got from 'got'; // npm install got

import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import * as db from '../db.js';
import { getSetting } from './settingsManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));

// ========================= CONFIGURATION =========================

const cacheDir = path.join(os.tmpdir(), 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

const YTDL_TIMEOUT = 90; // Уменьшено с 120
const MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024;
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 🔥 Оптимизировано для Render.com (можно увеличить до 4 при наличии RAM)
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 2;

const FFMPEG_AVAILABLE =
  (!!ffmpegPath && fs.existsSync(ffmpegPath)) &&
  process.env.FFMPEG_AVAILABLE !== '0' &&
  process.env.FFMPEG_STATIC_SKIP_DOWNLOAD !== '1';

// 🔥 Базовые аргументы youtube-dl (оптимизированы)
export const YTDL_COMMON = {
  'user-agent': FAKE_USER_AGENT,
  proxy: PROXY_URL || undefined,
  retries: 2, // Уменьшено с 3
  'socket-timeout': YTDL_TIMEOUT,
  'no-warnings': true,
  'no-check-certificate': true, // Ускоряет подключение
  'prefer-free-formats': true, // Приоритет открытым форматам
  'extractor-args': 'soundcloud:client_id=a3e059563d7fd3372b49b37f00a00bcf', // Публичный client_id
};

// 🔥 Аргументы для скачивания (без ffmpeg если не нужен)
const YTDL_DOWNLOAD = {
  ...YTDL_COMMON,
  'ffmpeg-location': FFMPEG_AVAILABLE ? ffmpegPath : undefined,
  'extract-audio': true,
  'audio-format': 'mp3',
  'audio-quality': 0,
  'embed-thumbnail': true,
  'add-metadata': true,
  'format': 'bestaudio[ext=mp3]/bestaudio/best', // Приоритет готовому MP3
};

// ========================= HELPER FUNCTIONS =========================

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'track';
  return name.replace(/[<>:"/\\|?*]+/g, '').trim().slice(0, 200) || 'track';
}

function getCacheKey(meta, fallbackUrl) {
  if (meta?.id) return `sc:${meta.id}`;
  if (meta?.title && meta?.uploader) {
    return `sc:${sanitizeFilename(meta.title)}_${sanitizeFilename(meta.uploader)}`.toLowerCase();
  }
  return fallbackUrl || 'unknown';
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

function extractMetadataFromInfo(info) {
  const e = Array.isArray(info?.entries) ? info.entries[0] : info;
  if (!e) return null;

  const ext = e.ext || e.requested_downloads?.[0]?.ext || null;
  const acodec = e.acodec || e.requested_downloads?.[0]?.acodec || null;
  const filesize = e.filesize || e.filesize_approx || e.requested_downloads?.[0]?.filesize || null;

  return {
    id: e.id,
    title: sanitizeFilename(e.title || 'Unknown Title'),
    uploader: e.uploader || 'Unknown Artist',
    duration: e.duration ? Math.round(e.duration) : undefined,
    thumbnail: e.thumbnail,
    ext,
    acodec,
    filesize
  };
}

// 🔥 Новая функция: проверка безопасности URL
function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    
    const hostname = parsed.hostname.toLowerCase();
    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254'];
    if (blockedHosts.includes(hostname)) return false;
    if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(hostname)) return false;
    
    return true;
  } catch {
    return false;
  }
}

// 🔥 Улучшенная проверка размера файла
async function checkFileSize(url) {
  try {
    let streamUrl = await ytdl(url, { 'get-url': true, ...YTDL_COMMON });
    if (Array.isArray(streamUrl)) streamUrl = streamUrl[0];
    
    if (!streamUrl || typeof streamUrl !== 'string') {
      return { ok: false, reason: 'NO_STREAM_URL' };
    }
    
    if (!isSafeUrl(streamUrl)) {
      console.warn('[Pre-flight] Небезопасный URL');
      return { ok: false, reason: 'UNSAFE_URL' };
    }
    
    // Используем got вместо fetch (быстрее)
    const response = await got.head(streamUrl, {
      timeout: { request: 5000 },
      headers: { 'User-Agent': FAKE_USER_AGENT },
      throwHttpErrors: false
    });
    
    const size = parseInt(response.headers['content-length'], 10);
    
    if (!size) {
      console.warn('[Pre-flight] Размер неизвестен, продолжаю');
      return { ok: true, reason: 'SIZE_UNKNOWN' };
    }
    
    if (size > MAX_FILE_SIZE_BYTES) {
      console.warn(`[Pre-flight] Файл слишком большой: ${(size / 1024 / 1024).toFixed(2)} МБ`);
      return { ok: false, reason: 'FILE_TOO_LARGE', size };
    }
    
    console.log(`[Pre-flight] ✅ Размер: ${(size / 1024 / 1024).toFixed(2)} МБ`);
    return { ok: true, size };
    
  } catch (e) {
    console.warn('[Pre-flight] Ошибка проверки:', e.message);
    return { ok: true, reason: 'CHECK_FAILED' };
  }
}

// 🔥 Периодическая очистка кеша (оптимизировано)
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
          
          // Удаляем файлы старше 30 минут (вместо 1 часа)
          if (now - stats.mtimeMs > 1800000) {
            await fs.promises.unlink(filePath);
            cleaned++;
          }
        } catch {}
      }));
      
      if (cleaned > 0) {
        console.log(`[Cache Cleanup] 🧹 Удалено ${cleaned} файлов`);
      }
    } catch (err) {
      console.error('[Cache Cleanup] Ошибка:', err.message);
    }
  }, 1800000); // Каждые 30 минут
  
  process.on('SIGTERM', () => clearInterval(cleanupInterval));
  process.on('SIGINT', () => clearInterval(cleanupInterval));
}

startCacheCleanup();

// ========================= CORE WORKER =========================

/**
 * 🔥 ОПТИМИЗИРОВАННЫЙ ВОРКЕР
 * Изменения:
 * - Streaming upload где возможно
 * - Меньше промежуточных статусов
 * - Параллельная проверка кеша
 */
export async function trackDownloadProcessor(task) {
  let tempFilePath = null;
  let statusMessage = null;
  const userId = parseInt(task.userId, 10);
  
  if (!userId || isNaN(userId)) {
    console.error('[Worker] Invalid userId:', task.userId);
    return;
  }

  try {
    // 1️⃣ Проверка лимитов
    const usage = await getUserUsage(userId);
    if (!usage || usage.downloads_today >= usage.premium_limit) {
      await safeSendMessage(userId, T('limitReached'));
      return;
    }

    // 2️⃣ Получение метаданных (ТОЛЬКО если их нет в задаче)
    let metadata = task.metadata;
    let cacheKey = task.cacheKey;
    const url = task.url || task.originalUrl;

    if (!metadata) {
      console.log(`[Worker] Получаю метаданные для: ${url}`);
      
      try {
        const info = await ytdl(url, { 
          'dump-single-json': true,
          'no-playlist': true, // 🔥 Важно: только один трек!
          ...YTDL_COMMON 
        });
        
        metadata = extractMetadataFromInfo(info);
        if (!metadata) throw new Error('META_MISSING');
        
        cacheKey = getCacheKey(metadata, url);
        
      } catch (ytdlErr) {
        console.error('[Worker] Ошибка youtube-dl:', ytdlErr.stderr || ytdlErr.message);
        throw new Error('Не удалось получить информацию о треке');
      }
    }

    const { title, uploader, id: trackId, duration, thumbnail } = metadata;

    // 3️⃣ Проверка кеша (параллельно несколько методов)
    const cacheChecks = await Promise.all([
      db.findCachedTrack(cacheKey),
      db.findCachedTrack(url),
      typeof db.findCachedTrackByMeta === 'function' 
        ? db.findCachedTrackByMeta({ title, artist: uploader, duration })
        : null
    ]);

    const cached = cacheChecks.find(c => c?.fileId);

    if (cached?.fileId) {
      console.log(`[Worker] ⚡ Кеш-попадание: "${title}"`);
      
      await bot.telegram.sendAudio(userId, cached.fileId, {
        title: cached.trackName || title,
        performer: cached.artist || uploader,
        duration
      });
      
      await incrementDownload(userId, cached.trackName || title, cached.fileId, cacheKey);
      return;
    }

    // 4️⃣ Начало скачивания
    console.log(`[Worker] 🎵 Скачиваю: "${title}"`);
    statusMessage = await safeSendMessage(userId, `⏳ Скачиваю: "${title}"`);

    // 5️⃣ Предварительная проверка размера
    const sizeCheck = await checkFileSize(url);
    if (!sizeCheck.ok && sizeCheck.reason === 'FILE_TOO_LARGE') {
      throw new Error('FILE_TOO_LARGE');
    }

    // 6️⃣ Скачивание файла
    const tempFileName = `${trackId || crypto.randomUUID()}.mp3`;
    tempFilePath = path.join(cacheDir, tempFileName);

    await ytdl(url, {
      output: tempFilePath,
      ...YTDL_DOWNLOAD
    });

    // 7️⃣ Проверка результата
    const stats = await fs.promises.stat(tempFilePath);
    
    if (stats.size === 0) {
      throw new Error('Скачанный файл пустой');
    }
    
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      throw new Error('FILE_TOO_LARGE');
    }

    console.log(`[Worker] ✅ Скачано ${(stats.size / 1024 / 1024).toFixed(2)} МБ`);

    // 8️⃣ Обновление статуса
    if (statusMessage) {
      await bot.telegram.editMessageText(
        userId, 
        statusMessage.message_id, 
        undefined, 
        `📤 Отправляю: "${title}"`
      ).catch(() => {});
    }

    const safeFilename = `${sanitizeFilename(title)}.mp3`;
    let finalFileId = null;

    // 9️⃣ Кэширование в канале (если настроено)
        // 9️⃣ Кэширование в канале (если настроено)
    if (STORAGE_CHANNEL_ID) {
      try {
        const sentToStorage = await bot.telegram.sendAudio(
          STORAGE_CHANNEL_ID,
          { source: fs.createReadStream(tempFilePath), filename: safeFilename },
          { title, performer: uploader, duration }
        );
        
        if (sentToStorage?.audio?.file_id) {
          finalFileId = sentToStorage.audio.file_id;
          
          await db.cacheTrack({
            url: cacheKey,
            fileId: finalFileId,
            title,
            artist: uploader,
            duration,
            thumbnail
          });
          
          console.log(`[Worker] 💾 Закэшировано: "${title}"`);
        }
      } catch (storageErr) {
        console.error(`[Worker] ⚠️ Ошибка кэширования:`, storageErr.message);
      }
    }

    // 🔟 Отправка пользователю
    if (finalFileId) {
      // Отправляем через file_id (быстрее)
      await bot.telegram.sendAudio(userId, finalFileId, {
        title,
        performer: uploader,
        duration
      });
    } else {
      // Отправляем файл напрямую
      const sentMsg = await bot.telegram.sendAudio(
        userId,
        { source: fs.createReadStream(tempFilePath), filename: safeFilename },
        { title, performer: uploader, duration }
      );
      
      finalFileId = sentMsg?.audio?.file_id;
      
      // Кэшируем file_id для будущего использования
      if (finalFileId) {
        await db.cacheTrack({
          url: cacheKey,
          fileId: finalFileId,
          title,
          artist: uploader,
          duration,
          thumbnail
        });
      }
    }

    // 1️⃣1️⃣ Удаление статусного сообщения
    if (statusMessage) {
      await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
    }

    // 1️⃣2️⃣ Инкремент счетчика
    if (finalFileId) {
      await incrementDownload(userId, title, finalFileId, cacheKey);
    }

    console.log(`[Worker] ✅ Завершено: "${title}" для user ${userId}`);

  } catch (err) {
    const errorDetails = err?.stderr || err?.message || '';
    let userMsg = '❌ Не удалось обработать трек.';
    
    // Детальная обработка ошибок
    if (errorDetails.includes('FILE_TOO_LARGE')) {
      userMsg = '❌ Файл слишком большой (макс. 49 МБ).';
    } else if (errorDetails.includes('UNSAFE_URL')) {
      userMsg = '❌ Небезопасная ссылка.';
    } else if (errorDetails.includes('timed out') || errorDetails.includes('timeout')) {
      userMsg = '❌ Превышено время ожидания. Попробуйте позже.';
    } else if (errorDetails.includes('HTTP Error 404') || errorDetails.includes('not found')) {
      userMsg = '❌ Трек не найден или удалён.';
    } else if (errorDetails.includes('HTTP Error 403') || errorDetails.includes('Forbidden')) {
      userMsg = '❌ Доступ к треку ограничен.';
    } else if (errorDetails.includes('private') || errorDetails.includes('geo')) {
      userMsg = '❌ Трек недоступен (приватный или geo-блок).';
    }
    
    console.error(`[Worker] ❌ Ошибка для user ${userId}:`, errorDetails);
    
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

// ========================= DOWNLOAD QUEUE =========================

export const downloadQueue = new TaskQueue({
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
  taskProcessor: trackDownloadProcessor
});

console.log(`[DownloadManager] 🚀 Очередь запущена (max: ${MAX_CONCURRENT_DOWNLOADS} параллельных)`);

// ========================= ENQUEUE FUNCTION =========================

/**
 * 🔥 ОПТИМИЗИРОВАННАЯ ФУНКЦИЯ ПОСТАНОВКИ В ОЧЕРЕДЬ
 * Основные улучшения:
 * - Использование flat-playlist для быстрого получения списка
 * - Метаданные получаются в воркере, а не заранее
 * - Параллельная проверка кеша
 * - Меньше промежуточных статусов
 */
export function enqueue(ctx, userId, url) {
  (async () => {
    let statusMessage = null;
    const startTime = Date.now();

    try {
      // 1️⃣ Валидация URL
      if (!url || typeof url !== 'string') {
        console.error('[Enqueue] Некорректный URL:', url);
        return;
      }

      // Блокировка Spotify (временно)
      if (url.includes('spotify.com')) {
        await safeSendMessage(
          userId,
          '🛠 К сожалению, скачивание из Spotify временно недоступно.'
        );
        return;
      }

      // 2️⃣ Сброс дневного лимита
      await db.resetDailyLimitIfNeeded(userId);

      // 3️⃣ Получение данных пользователя
      const fullUser = await db.getUser(userId);
      const downloadsToday = Number(fullUser?.downloads_today || 0);
      const dailyLimit = Number(fullUser?.premium_limit || 0);

      // 4️⃣ Проверка лимита
      if (downloadsToday >= dailyLimit) {
        const bonusAvailable = Boolean(CHANNEL_USERNAME && !fullUser?.subscribed_bonus_used);
        const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
        const bonusText = bonusAvailable
          ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.`
          : '';

        const text = `${T('limitReached')}${bonusText}`;
        const extra = {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        };

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

      // 5️⃣ Уведомление о начале
      statusMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');

      // 6️⃣ Определение лимитов плейлиста
      const limits = {
        free: parseInt(getSetting('playlist_limit_free'), 10) || 10,
        plus: parseInt(getSetting('playlist_limit_plus'), 10) || 30,
        pro: parseInt(getSetting('playlist_limit_pro'), 10) || 100,
        unlim: parseInt(getSetting('playlist_limit_unlim'), 10) || 200,
      };

      let playlistLimit = limits.free;
      if (dailyLimit >= 10000) playlistLimit = limits.unlim;
      else if (dailyLimit >= 100) playlistLimit = limits.pro;
      else if (dailyLimit >= 30) playlistLimit = limits.plus;

      const remainingToday = Math.max(0, dailyLimit - downloadsToday);
      const maxTracksToProcess = Math.min(remainingToday, playlistLimit);

      // 7️⃣ 🔥 БЫСТРОЕ получение списка треков (БЕЗ полных метаданных!)
      let trackUrls = [];
      let isPlaylist = false;

      try {
        console.log('[Enqueue] 🔍 Получаю список треков (flat-playlist)...');
        
        const info = await ytdl(url, {
          'flat-playlist': true, // 🔥 КЛЮЧЕВАЯ ОПТИМИЗАЦИЯ!
          'dump-single-json': true,
          'playlist-end': maxTracksToProcess,
          ...YTDL_COMMON
        });

        isPlaylist = Array.isArray(info?.entries) && info.entries.length > 1;

        if (isPlaylist) {
          trackUrls = info.entries
            .map(e => e.url || e.webpage_url || e.id)
            .filter(Boolean)
            .slice(0, maxTracksToProcess);
        } else {
          trackUrls = [url];
        }

        console.log(`[Enqueue] ✅ Найдено ${trackUrls.length} треков`);

      } catch (ytdlErr) {
        console.error('[Enqueue] Ошибка youtube-dl:', ytdlErr.stderr || ytdlErr.message);
        throw new Error('Не удалось получить информацию. Проверьте ссылку.');
      }

      if (trackUrls.length === 0) {
        throw new Error('Не найдено треков для загрузки.');
      }

      // 8️⃣ Уведомление об ограничении плейлиста
      if (isPlaylist && trackUrls.length >= maxTracksToProcess) {
        await safeSendMessage(
          userId,
          `ℹ️ С учётом вашего тарифа и дневного лимита будет обработано до <b>${maxTracksToProcess}</b> треков.`,
          { parse_mode: 'HTML' }
        );
      }

      // 9️⃣ Обновление статуса
      if (statusMessage) {
        await bot.telegram.editMessageText(
          userId,
          statusMessage.message_id,
          undefined,
          `🔄 Проверяю кеш для ${trackUrls.length} треков...`
        ).catch(() => {});
      }

      // 🔟 🔥 ПАРАЛЛЕЛЬНАЯ проверка кеша для всех треков
      const cacheCheckResults = await pMap(
        trackUrls,
        async (trackUrl) => {
          // Генерируем предварительный cache key из URL
          const preliminaryCacheKey = `sc:${trackUrl}`;
          
          const cached = await db.findCachedTrack(preliminaryCacheKey) ||
                         await db.findCachedTrack(trackUrl);
          
          return {
            url: trackUrl,
            cached: cached?.fileId ? cached : null
          };
        },
        { concurrency: 10 } // Быстрая параллельная проверка
      );

      // Разделяем на закэшированные и новые
      const cachedTracks = cacheCheckResults.filter(r => r.cached);
      const newTracks = cacheCheckResults.filter(r => !r.cached);

      console.log(`[Enqueue] 📊 Кеш: ${cachedTracks.length}, Новые: ${newTracks.length}`);

      // 1️⃣1️⃣ Мгновенная отправка закэшированных треков
      if (cachedTracks.length > 0) {
        if (statusMessage) {
          await bot.telegram.editMessageText(
            userId,
            statusMessage.message_id,
            undefined,
            `⚡ Отправляю ${cachedTracks.length} закэшированных треков...`
          ).catch(() => {});
        }

        await pMap(
          cachedTracks,
          async ({ cached }) => {
            try {
              await bot.telegram.sendAudio(userId, cached.fileId, {
                title: cached.trackName,
                performer: cached.artist,
                duration: cached.duration
              });
              
              await incrementDownload(userId, cached.trackName, cached.fileId, cached.url);
            } catch (sendErr) {
              console.error('[Enqueue] Ошибка отправки из кеша:', sendErr.message);
            }
          },
          { concurrency: 3 } // Отправляем по 3 трека параллельно
        );
      }

      // 1️⃣2️⃣ Постановка новых треков в очередь
      if (newTracks.length > 0) {
        if (statusMessage) {
          const msg = cachedTracks.length > 0
            ? `🔄 Обрабатываю ${newTracks.length} новых треков...`
            : `🔄 Обрабатываю ${newTracks.length} треков...`;
          
          await bot.telegram.editMessageText(
            userId,
            statusMessage.message_id,
            undefined,
            msg
          ).catch(() => {});
        }

        for (const { url: trackUrl } of newTracks) {
          await downloadQueue.enqueue({
            userId,
            url: trackUrl,
            originalUrl: trackUrl,
            source: 'soundcloud',
            // 🔥 Метаданные получим в воркере!
            metadata: null,
            cacheKey: null
          });
        }
      }

      // 1️⃣3️⃣ Удаление статусного сообщения
      if (statusMessage) {
        setTimeout(() => {
          bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
        }, 3000);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Enqueue] ✅ Завершено за ${elapsed}с (кеш: ${cachedTracks.length}, новые: ${newTracks.length})`);

    } catch (err) {
      console.error('[Enqueue] ❌ Критическая ошибка:', err.message);
      
      let userMsg = '❌ Произошла ошибка при обработке ссылки.';
      
      if (err.message.includes('Проверьте ссылку')) {
        userMsg = '❌ Не удалось получить треки. Проверьте ссылку.';
      } else if (err.message.includes('не найдено')) {
        userMsg = '❌ Треки не найдены.';
      }

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
  })();
}

// 