// services/downloadManager.js (безопасная финальная версия для бесплатных тарифов)

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

const YTDL_TIMEOUT = 120;
const MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024; // 49 МБ (лимит Telegram)
const UNLIMITED_PLAYLIST_LIMIT = 100;
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

// Для бесплатных тарифов Render.com: 2 одновременных загрузки (чтобы не превышать лимиты CPU/RAM)
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 2;

const FFMPEG_AVAILABLE =
  (!!ffmpegPath && fs.existsSync(ffmpegPath)) &&
  process.env.FFMPEG_AVAILABLE !== '0' &&
  process.env.FFMPEG_STATIC_SKIP_DOWNLOAD !== '1';

// services/downloadManager.js

const YTDL_COMMON = {
  'ffmpeg-location': ffmpegPath || undefined,
  'user-agent': FAKE_USER_AGENT,
  proxy: PROXY_URL || undefined,
  retries: 3,
  'socket-timeout': YTDL_TIMEOUT,
  'no-warnings': true,
  
  // === ✅ ДОБАВЬ ЭТУ СТРОКУ ===
  'extractor-args': 'soundcloud:player_client_id=CLIENT_ID'
};

// ========================= HELPER FUNCTIONS =========================

/**
 * Очищает имя файла от недопустимых символов
 */
function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'track';
  return name.replace(/[<>:"/\\|?*]+/g, '').trim() || 'track';
}
async function resolveCanonicalUrl(url) {
  // Если это уже полная ссылка — возвращаем как есть
  if (!url.includes('on.soundcloud.com')) {
    return url;
  }
  
  try {
    console.log(`[resolveUrl] Резолвлю короткую ссылку: ${url}`);
    const info = await ytdl(url, { 
      'dump-single-json': true, 
      'no-playlist': true,
      ...YTDL_COMMON 
    });
    
    const canonical = info.webpage_url || info.url || url;
    console.log(`[resolveUrl] Канонический URL: ${canonical}`);
    return canonical;
    
  } catch (e) {
    console.warn('[resolveUrl] Не удалось резолвить, использую оригинальный:', e.message);
    return url;
  }
}

/**
 * Генерирует уникальный ключ кеша для трека
 */
function getCacheKey(meta, fallbackUrl) {
  if (meta?.id) return `sc:${meta.id}`;
  return fallbackUrl || 'unknown';
}

/**
 * Безопасная отправка сообщения пользователю с автоматической деактивацией при блокировке
 */
async function safeSendMessage(userId, text, extra = {}) {
  try {
    return await bot.telegram.sendMessage(userId, text, extra);
  } catch (e) {
    if (e.response?.error_code === 403) {
      try { 
        await db.updateUserField(userId, 'active', false); 
      } catch (dbErr) {
        console.error(`[DB] Не удалось деактивировать пользователя ${userId}:`, dbErr.message);
      }
    }
    return null;
  }
}

/**
 * Проверяет, можно ли копировать MP3 без конвертации
 */
function canCopyMp3(ext, acodec) {
  if (!ext && !acodec) return false;
  return ext === 'mp3' || /mp3/i.test(acodec || '');
}

/**
 * Инкрементирует счётчик загрузок (с поддержкой транзакционной версии)
 */
async function incrementDownload(userId, trackTitle, fileId, cacheKey) {
  if (typeof db.incrementDownloadsAndLogPg === 'function') {
    return await db.incrementDownloadsAndLogPg(userId, trackTitle, fileId, cacheKey);
  }
  return await db.incrementDownloadsAndSaveTrack(userId, trackTitle, fileId, cacheKey);
}

/**
 * Получает данные пользователя (минимальный набор для проверки лимитов)
 */
async function getUserUsage(userId) {
  if (typeof db.getUserUsage === 'function') return await db.getUserUsage(userId);
  if (typeof db.getUserLite === 'function') return await db.getUserLite(userId);
  return await db.getUser(userId);
}

/**
 * Извлекает метаданные трека из ответа youtube-dl
 */
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
    duration: e.duration,
    thumbnail: e.thumbnail,
    ext,
    acodec,
    filesize
  };
}

/**
 * Проверяет безопасность URL (защита от SSRF)
 */
function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    
    // Разрешаем только HTTP/HTTPS
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    
    // Блокируем localhost и внутренние IP
    const hostname = parsed.hostname.toLowerCase();
    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254'];
    if (blockedHosts.includes(hostname)) return false;
    
    // Блокируем приватные подсети
    if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(hostname)) return false;
    
    return true;
  } catch {
    return false;
  }
}

/**
 * Получает размер файла через HEAD-запрос
 */
async function getFileSizeFromHead(url) {
  try {
    const res = await fetch(url, { 
      method: 'HEAD', 
      timeout: 5000,
      headers: { 'User-Agent': FAKE_USER_AGENT }
    });
    const contentLength = res.headers.get('content-length');
    return contentLength ? parseInt(contentLength, 10) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Получает размер файла через Range-запрос (fallback для HEAD)
 */
async function getFileSizeFromRange(url) {
  try {
    const res = await fetch(url, { 
      method: 'GET', 
      headers: { 
        'Range': 'bytes=0-0',
        'User-Agent': FAKE_USER_AGENT
      },
      timeout: 5000 
    });
    
    const rangeHeader = res.headers.get('content-range');
    if (rangeHeader) {
      // Формат: "bytes 0-0/12345678"
      const match = rangeHeader.match(/\/(\d+)$/);
      if (match) return parseInt(match[1], 10);
    }
  } catch (e) {
    return null;
  }
  return null;
}

/**
 * Комплексная проверка размера файла ДО начала загрузки
 */
async function checkFileSize(url) {
  try {
    // 1. Получаем прямую ссылку на стрим
    let streamUrl = await ytdl(url, { 'get-url': true, ...YTDL_COMMON });
    
    // youtube-dl может вернуть массив ссылок
    if (Array.isArray(streamUrl)) streamUrl = streamUrl[0];
    
    if (!streamUrl || typeof streamUrl !== 'string') {
      return { ok: false, reason: 'NO_STREAM_URL' };
    }
    
    // 2. Валидация безопасности URL
    if (!isSafeUrl(streamUrl)) {
      console.warn('[Pre-flight] Небезопасный URL:', streamUrl);
      return { ok: false, reason: 'UNSAFE_URL' };
    }
    
    // 3. Пробуем получить размер через HEAD
    let size = await getFileSizeFromHead(streamUrl);
    
    // 4. Fallback на Range-запрос
    if (!size) {
      size = await getFileSizeFromRange(streamUrl);
    }
    
    // 5. Если размер неизвестен — разрешаем загрузку (проверим при скачивании)
    if (!size) {
      console.warn('[Pre-flight] Не удалось определить размер файла, продолжаю.');
      return { ok: true, reason: 'SIZE_UNKNOWN' };
    }
    
    // 6. Проверяем лимит
    if (size > MAX_FILE_SIZE_BYTES) {
      console.warn(`[Pre-flight] Файл слишком большой: ${(size / 1024 / 1024).toFixed(2)} МБ`);
      return { ok: false, reason: 'FILE_TOO_LARGE', size };
    }
    
    console.log(`[Pre-flight] Размер файла: ${(size / 1024 / 1024).toFixed(2)} МБ — OK`);
    return { ok: true, size };
    
  } catch (e) {
    console.warn('[Pre-flight] Ошибка проверки размера:', e.message);
    // В случае ошибки — разрешаем загрузку (может быть временная проблема сети)
    return { ok: true, reason: 'CHECK_FAILED' };
  }
}

/**
 * Восстанавливает метаданные задачи, если они отсутствуют
 */
async function ensureTaskMetadata(task) {
  let { metadata, cacheKey } = task;
  const url = task.url || task.originalUrl;

  if (!metadata) {
    if (!url) throw new Error('TASK_MISSING_URL');
    
    console.warn('[Worker] metadata отсутствует, получаю через youtube-dl для URL:', url);
    const info = await ytdl(url, { 'dump-single-json': true, ...YTDL_COMMON });
    const md = extractMetadataFromInfo(info);
    
    if (!md) throw new Error('META_MISSING');
    metadata = md;
  }

  if (!cacheKey) {
    cacheKey = getCacheKey(metadata, task.originalUrl || url);
  }

  return { 
    metadata, 
    cacheKey, 
    source: task.source || 'soundcloud', 
    url 
  };
}

/**
 * Периодическая очистка старых файлов из кеша (раз в час)
 */
function startCacheCleanup() {
  const cleanupInterval = setInterval(() => {
    fs.readdir(cacheDir, (err, files) => {
      if (err) {
        console.error('[Cache Cleanup] Ошибка чтения директории:', err.message);
        return;
      }
      
      const now = Date.now();
      let cleaned = 0;
      
      files.forEach(file => {
        const filePath = path.join(cacheDir, file);
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          
          // Удаляем файлы старше 1 часа
          if (now - stats.mtimeMs > 3600000) {
            fs.unlink(filePath, (err) => {
              if (!err) cleaned++;
            });
          }
        });
      });
      
      if (cleaned > 0) {
        console.log(`[Cache Cleanup] Удалено ${cleaned} старых файлов из кеша.`);
      }
    });
  }, 3600000); // Раз в час
  
  // Graceful shutdown
  process.on('SIGTERM', () => clearInterval(cleanupInterval));
  process.on('SIGINT', () => clearInterval(cleanupInterval));
}

// Запускаем очистку при импорте модуля
startCacheCleanup();

// ========================= CORE WORKER =========================

/**
 * Основной воркер для обработки задачи загрузки трека
 */
// ========================= CORE WORKER =========================

export async function trackDownloadProcessor(task) {
  let tempFilePath = null;
  let statusMessage = null;
  const userId = parseInt(task.userId, 10);
  
  // 1. Валидация
  if (!userId || isNaN(userId)) {
    console.error('[Worker] Invalid userId:', task.userId);
    return;
  }

  try {
    // 2. Проверка лимитов
    const usage = await getUserUsage(userId);
    if (!usage || usage.downloads_today >= usage.premium_limit) {
      await safeSendMessage(userId, T('limitReached'));
      return;
    }

    // 3. Получение метаданных
    const ensured = await ensureTaskMetadata(task);
    const { metadata, cacheKey, url: ensuredUrl } = ensured;
    const { title, uploader, id: trackId, duration, thumbnail, ext, acodec } = metadata;
    const roundedDuration = duration ? Math.round(duration) : undefined;
    
    // 4. Проверка кэша
    let cached = await db.findCachedTrack(cacheKey) || await db.findCachedTrack(task.originalUrl || ensuredUrl);
    if (!cached && typeof db.findCachedTrackByMeta === 'function') {
      cached = await db.findCachedTrackByMeta({ title, artist: uploader, duration: roundedDuration });
    }

    if (cached?.fileId) {
      console.log(`[Worker/Cache] ХИТ! Отправляю "${cached.trackName || title}" из кэша.`);
      
      const performer = cached.artist || uploader || 'Unknown Artist';
      
      await bot.telegram.sendAudio(
        userId,
        cached.fileId,
        {
          title: cached.trackName || title,
          performer: performer,
          duration: roundedDuration
        }
      );
      await incrementDownload(userId, cached.trackName || title, cached.fileId, cacheKey);
      return; // Выход, задача выполнена из кэша
    }

    // 5. Скачивание
    statusMessage = await safeSendMessage(userId, `⏳ Начинаю скачивание: "${title}"`);
    const sizeCheck = await checkFileSize(ensuredUrl);
    if (!sizeCheck.ok && sizeCheck.reason === 'FILE_TOO_LARGE') {
      throw new Error('FILE_TOO_LARGE');
    }

    const tempFileName = `${trackId || 'track'}-${crypto.randomUUID()}.mp3`;
    tempFilePath = path.join(cacheDir, tempFileName);
    const ytdlArgs = canCopyMp3(ext, acodec)
      ? { output: tempFilePath, 'embed-thumbnail': true, 'add-metadata': true, ...YTDL_COMMON }
      : { output: tempFilePath, 'extract-audio': true, 'audio-format': 'mp3', 'embed-thumbnail': true, 'add-metadata': true, ...YTDL_COMMON };
    
    await ytdl(ensuredUrl, ytdlArgs);

    if (!fs.existsSync(tempFilePath) || (await fs.promises.stat(tempFilePath)).size > MAX_FILE_SIZE_BYTES) {
      throw new Error('FILE_TOO_LARGE');
    }

    if (statusMessage) {
      await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, `✅ Скачал. Отправляю...`).catch(() => {});
    }

    // ========================================
    // 6. Отправка и кэширование
    // ========================================
    const safeFilename = `${sanitizeFilename(title)}.mp3`;
    let finalFileId = null;

    if (STORAGE_CHANNEL_ID) {
      try {
        console.log(`[Cache] Загружаю "${title}" в канал-хранилище...`);
        
        const sentToStorage = await bot.telegram.sendAudio(
          STORAGE_CHANNEL_ID,
          { source: fs.createReadStream(tempFilePath), filename: safeFilename },
          { title, performer: uploader, duration: roundedDuration }
        );
        
        if (sentToStorage?.audio?.file_id) {
          finalFileId = sentToStorage.audio.file_id;
          
          // ✅ DEBUG: Что сохраняем
          console.log(`[Cache/Debug] 💾 Сохраняю в БД:`, {
            originalUrl: task.originalUrl,
            ensuredUrl: ensuredUrl,
            cacheKey: cacheKey,
            willSave: task.originalUrl || ensuredUrl
          });
          
          // Сохраняем по оригинальному URL
          await db.cacheTrack({ 
            url: task.originalUrl || ensuredUrl,
            fileId: finalFileId, 
            title, 
            artist: uploader, 
            duration: roundedDuration, 
            thumbnail 
          });
          
          // Если есть отдельный cacheKey (sc:123456) - сохраняем и его
          if (cacheKey && cacheKey !== (task.originalUrl || ensuredUrl)) {
            await db.cacheTrack({ 
              url: cacheKey,
              fileId: finalFileId, 
              title, 
              artist: uploader, 
              duration: roundedDuration, 
              thumbnail 
            });
            console.log(`✅ [Cache] Также сохранён по ключу: ${cacheKey}`);
          }
          
          console.log(`✅ [Cache] Трек "${title}" успешно закэширован.`);
        }
      } catch (storageErr) {
        console.error(`❌ [Cache] Ошибка при кэшировании:`, storageErr.message);
      }
    }

    // Отправка пользователю
    if (finalFileId) {
      await bot.telegram.sendAudio(
        userId, 
        finalFileId, 
        { title, performer: uploader, duration: roundedDuration }
      );
    } else {
      console.warn('[Worker] Отправляю файл как поток (кэширование не удалось).');
      const sentMsg = await bot.telegram.sendAudio(
        userId, 
        { source: fs.createReadStream(tempFilePath), filename: safeFilename }, 
        { title, performer: uploader, duration: roundedDuration }
      );
      finalFileId = sentMsg?.audio?.file_id;
    }

    // Удаляем статус-сообщение
    if (statusMessage) {
      await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
    }
    
    // Логируем скачивание
    if (finalFileId) {
      await incrementDownload(userId, title, finalFileId, task.originalUrl || ensuredUrl);
    }

  } catch (err) {
    // ========================================
    // 7. Обработка ошибок
    // ========================================
    const errorDetails = err?.stderr || err?.message || '';
    let userMsg = '❌ Не удалось обработать трек.';
    
    if (errorDetails.includes('FILE_TOO_LARGE')) userMsg = '❌ Файл слишком большой.';
    else if (errorDetails.includes('UNSAFE_URL')) userMsg = '❌ Небезопасная ссылка.';
    else if (errorDetails.includes('timed out')) userMsg = '❌ Ошибка сети.';
    else if (errorDetails.includes('HTTP Error 404')) userMsg = '❌ Трек не найден.';
    
    console.error(`❌ Ошибка воркера для user ${userId}:`, errorDetails);
    
    if (statusMessage) {
      await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, userMsg).catch(() => {});
    } else {
      await safeSendMessage(userId, userMsg);
    }
    
  } finally {
    // ========================================
    // 8. Очистка
    // ========================================
    if (tempFilePath) {
      fs.promises.unlink(tempFilePath).catch(() => {});
    }
  }
}
// ========================= DOWNLOAD QUEUE =========================

/**
 * Глобальная очередь загрузок с приоритетами
 * Для бесплатных тарифов: maxConcurrent = 2 (безопасно для Render.com)
 */
export const downloadQueue = new TaskQueue({
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
  taskProcessor: trackDownloadProcessor
});

console.log(`[DownloadManager] Очередь загрузок инициализирована (maxConcurrent: ${MAX_CONCURRENT_DOWNLOADS})`);

// ========================= ENQUEUE FUNCTION =========================

/**
 * Основная функция для постановки треков в очередь
 * Вызывается из bot.js при получении ссылки от пользователя
 */
// ========================= ENQUEUE FUNCTION =========================

export function enqueue(ctx, userId, url) {
  (async () => {
        let statusMessage = null;
        const startTime = Date.now();
        
        try {
          // --- Валидация входных данных ---
          if (!url || typeof url !== 'string') {
            console.error('[Enqueue] Некорректный URL:', url);
            return;
          }
          
          if (url.includes('spotify.com')) {
            await safeSendMessage(userId, '🛠 К сожалению, скачивание из Spotify временно на техническом обслуживании.');
            return;
          }
          
          // ========================================
          // ✅ РАННЯЯ ПРОВЕРКА КЭША ПО URL
          // ========================================
          
          // Резолвим короткую ссылку в полную
          const canonicalUrl = await resolveCanonicalUrl(url);
          
          console.log(`[Enqueue/Debug] 🔍 Проверяю кэш для URL: ${canonicalUrl}`);
          
          const quickCached = await db.findCachedTrack(canonicalUrl);
          
          console.log(`[Enqueue/Debug] 📦 Результат findCachedTrack:`, {
            found: !!quickCached,
            fileId: quickCached?.fileId ? 'Есть' : 'Нет',
            trackName: quickCached?.trackName
          });
          
          if (quickCached?.fileId) {
            console.log(`[⚡ FAST CACHE HIT] Мгновенная отправка: ${quickCached.trackName}`);
            
            try {
              await bot.telegram.sendAudio(
                userId,
                quickCached.fileId,
                {
                  title: quickCached.trackName,
                  performer: quickCached.artist || 'Unknown Artist',
                  duration: quickCached.duration
                }
              );
              
              await incrementDownload(userId, quickCached.trackName, quickCached.fileId, canonicalUrl);
              
              console.log(`[⚡ Cache] Трек отправлен за ${(Date.now() - startTime) / 1000}с`);
              return; // ← ВЫХОД!
              
            } catch (sendErr) {
              console.error('[Enqueue/Debug] ❌ Ошибка отправки:', sendErr.message);
              
              if (sendErr?.description?.includes('FILE_REFERENCE_EXPIRED') ||
                sendErr?.description?.includes('file_id')) {
                console.warn('[Cache] file_id устарел, перезагружаю...');
                await db.deleteCachedTrack(canonicalUrl);
                // НЕ делаем return — продолжаем загрузку
              } else {
                throw sendErr;
              }
            }
          } else {
            console.log(`[Enqueue/Debug] ❌ Кэш не найден, продолжаю обычную загрузку`);
          }
          
          // ВАЖНО: используем canonicalUrl дальше!
          url = canonicalUrl;
          


// Резолвим короткую ссылку в полную

      await db.resetDailyLimitIfNeeded(userId);

      // --- Получение данных пользователя ---
      const fullUser = await db.getUser(userId);
      const downloadsToday = Number(fullUser?.downloads_today || 0);
      const dailyLimit = Number(fullUser?.premium_limit || 0);

      // --- Проверка лимита ---
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

      // --- Уведомление о начале обработки ---
      statusMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');

      const limits = {
        free: parseInt(getSetting('playlist_limit_free'), 10) || 10,
        plus: parseInt(getSetting('playlist_limit_plus'), 10) || 30,
        pro: parseInt(getSetting('playlist_limit_pro'), 10) || 100,
        unlim: parseInt(getSetting('playlist_limit_unlim'), 10) || 200,
      };

      let pLimit = limits.free;
      if (dailyLimit >= 10000) pLimit = limits.unlim;
      else if (dailyLimit >= 100) pLimit = limits.pro;
      else if (dailyLimit >= 30) pLimit = limits.plus;

      const pEnd = Math.min(Math.max(0, dailyLimit - downloadsToday), pLimit);

      // === Получение метаданных через youtube-dl ===
      let info;
      try {
        info = await ytdl(url, {
          'dump-single-json': true,
          'playlist-end': pEnd + 1,
          ...YTDL_COMMON
        });
      } catch (ytdlError) {
        console.error(`[youtube-dl] Ошибка для ${url}:`, ytdlError.stderr || ytdlError.message);
        throw new Error('Не удалось получить метаданные.');
      }

      if (!info) {
        throw new Error('Не удалось получить метаданные.');
      }

      const isPlaylist = Array.isArray(info.entries);
      const entries = isPlaylist ? info.entries : [info];
      
      // --- Уведомление об ограничении плейлиста ---
      if (isPlaylist && entries.length > pEnd) {
        await safeSendMessage(
          userId, 
          `ℹ️ С учетом вашего тарифа будет обработано до <b>${pEnd}</b> треков из плейлиста.`,
          { parse_mode: 'HTML' }
        );
      }
      
      let tracksToProcess = entries
        .slice(0, pEnd)
        .map(e => {
          const md = extractMetadataFromInfo(e);
          if (!md) return null;
          const realUrl = e.webpage_url || e.url;
          const key = getCacheKey(md, realUrl);
          return { 
            url: realUrl, 
            originalUrl: realUrl, 
            source: 'soundcloud', 
            cacheKey: key, 
            metadata: md 
          };
        })
        .filter(Boolean);

      if (tracksToProcess.length === 0) {
        throw new Error('Не удалось найти треки для загрузки.');
      }
      
      if (statusMessage) {
        await bot.telegram.editMessageText(
          userId, 
          statusMessage.message_id, 
          undefined, 
          '🔄 Проверяю наличие треков...'
        ).catch(() => {});
      }

      // --- Проверка кэша для плейлистов ---
      const keyPairs = tracksToProcess.map(t => ({ 
        track: t, 
        primary: t.cacheKey, 
        legacy: t.originalUrl 
      }));
      
      const uniqueKeys = Array.from(
        new Set(keyPairs.flatMap(k => [k.primary, k.legacy].filter(Boolean)))
      );
      
      const cacheMap = typeof db.findCachedTracks === 'function' 
        ? await db.findCachedTracks(uniqueKeys) 
        : new Map();
      
      let remaining = Math.max(0, dailyLimit - downloadsToday);
      const tasksToDownload = [];
      const cachedToSend = [];

      for (const pair of keyPairs) {
        if (remaining <= 0) break;
        const cached = cacheMap.get(pair.primary) || cacheMap.get(pair.legacy);
        if (cached) {
          cachedToSend.push({ track: pair.track, cached });
        } else {
          tasksToDownload.push(pair.track);
        }
      }
      
      // --- Отправка из кэша ---
      let sentFromCacheCount = 0;
      await pMap(cachedToSend, async ({ track, cached }) => {
        if (remaining <= 0) return;
        try {
          await bot.telegram.sendAudio(
            userId, 
            cached.fileId, 
            { 
              title: cached.trackName || track.metadata.title, 
              performer: cached.artist || track.metadata.uploader, 
              duration: track.metadata.duration 
            }
          );
          
          const ok = await incrementDownload(
            userId, 
            cached.trackName || track.metadata.title, 
            cached.fileId, 
            track.cacheKey
          );
          
          if (ok !== null) {
            remaining--;
            sentFromCacheCount++;
          }
        } catch (err) {
          if (err?.description?.includes('FILE_REFERENCE_EXPIRED') || 
              err?.description?.includes('file_id')) {
            tasksToDownload.push(track);
          } else {
            console.error(`⚠️ Ошибка отправки из кэша:`, err.message);
          }
        }
      }, { concurrency: 3 });

      // --- Добавление в очередь ---
      let finalMessage = '';
      if (tasksToDownload.length > 0 && remaining > 0) {
        const tasksToReallyDownload = tasksToDownload.slice(0, remaining);
        const currentQueueSize = downloadQueue.size;
        
        if (isPlaylist) {
          console.log(`[Queue] Плейлист: ${tasksToReallyDownload.length} треков от ${userId}`);
        }
        
        const prio = fullUser.premium_limit || 0;
        for (const task of tasksToReallyDownload) {
          downloadQueue.add({ userId, ...task, priority: prio })
            .catch(err => {
              if (!err.message.includes('cleared by admin')) {
                console.warn(`[Enqueue] Ошибка задачи для ${userId}:`, err.message);
              }
            });
        }
        
        finalMessage += `⏳ ${tasksToReallyDownload.length} трек(ов) в очереди.\n`;
        
        if (currentQueueSize > 0) {
          const avgTaskTimeSeconds = 90;
          const waitTimeSeconds = Math.ceil((currentQueueSize / MAX_CONCURRENT_DOWNLOADS) * avgTaskTimeSeconds);
          const waitTimeMinutes = Math.ceil(waitTimeSeconds / 60);
          finalMessage += `📍 Позиция: ~${currentQueueSize + 1}\n`;
          finalMessage += `⏱ Ожидание: ~${waitTimeMinutes} мин.`;
        } else {
          finalMessage += `🚀 Начинаю обработку!`;
        }
      } else if (tasksToDownload.length > 0 && remaining <= 0) {
        finalMessage += `\n🚫 Лимит исчерпан.`;
      }
      
      // ✅ НЕ ОТПРАВЛЯЕМ СООБЩЕНИЕ, ЕСЛИ ЭТО БЫЛ ОДИНОЧНЫЙ ТРЕК ИЗ КЭША
if (finalMessage.trim() === '') {
  // Если это был одиночный трек из кэша (отправлен в ранней проверке)
  // — просто выходим, не отправляя дополнительное сообщение
  if (!isPlaylist && sentFromCacheCount === 0 && tasksToDownload.length === 0) {
    return;
  }
  
  // Для плейлистов показываем итоги
  const duration = (Date.now() - startTime) / 1000;
  finalMessage = sentFromCacheCount > 0 ?
    `✅ ${sentFromCacheCount} трек(ов) за ${duration.toFixed(1)}с.` :
    '✅ Все треки обработаны.';
}

      if (statusMessage) {
        await bot.telegram.editMessageText(
          userId, 
          statusMessage.message_id, 
          undefined, 
          finalMessage.trim()
        ).catch(() => {});
      } else if (finalMessage.trim()) {
        await safeSendMessage(userId, finalMessage.trim());
      }

    } catch (err) {
      const errorMessage = err?.stderr || err?.message || String(err);
      let userMessage = `❌ Ошибка при обработке ссылки.`;
      
      if (errorMessage.includes('timed out')) userMessage = '❌ Превышено время ожидания.';
      else if (errorMessage.includes('HTTP Error 404')) userMessage = '❌ Трек не найден.';
      else if (errorMessage.includes('HTTP Error 403')) userMessage = '❌ Доступ ограничен.';
      else console.error(`❌ Ошибка enqueue для ${userId}:`, err);
      
      if (statusMessage) {
        await bot.telegram.editMessageText(
          userId, 
          statusMessage.message_id, 
          undefined, 
          userMessage
        ).catch(() => {});
      } else {
        await safeSendMessage(userId, userMessage);
      }
    }
  })();
}
// ========================= INITIALIZATION =========================

/**
 * Инициализация менеджера загрузок (для обратной совместимости)
 */
export function initializeDownloadManager() {
  console.log('[DownloadManager] Инициализация завершена.');
  console.log(`[DownloadManager] FFMPEG доступен: ${FFMPEG_AVAILABLE ? '✅' : '❌'}`);
  console.log(`[DownloadManager] Максимум одновременных загрузок: ${MAX_CONCURRENT_DOWNLOADS}`);
  console.log(`[DownloadManager] Канал-хранилище: ${STORAGE_CHANNEL_ID ? '✅ настроен' : '⚠️ не настроен'}`);
  console.log(`[DownloadManager] Автоочистка кэша: ✅ активна (каждые 60 мин)`);
}

// ========================= EXPORTS SUMMARY =========================
// Основные экспорты:
// - trackDownloadProcessor: воркер для обработки одной задачи
// - downloadQueue: глобальная очередь с приоритетами
// - enqueue: функция для добавления треков в очередь
// - initializeDownloadManager: инициализация (вызывается из index.js)

// Вспомогательные функции (не экспортируются):
// - sanitizeFilename, getCacheKey, safeSendMessage
// - canCopyMp3, extractMetadataFromInfo
// - isSafeUrl, checkFileSize (защита от SSRF и больших файлов)
// - ensureTaskMetadata, startCacheCleanup

// ========================= CONFIGURATION TIPS =========================
// 
// Для увеличения производительности (если сервер позволяет):
// Установи переменную окружения MAX_CONCURRENT_DOWNLOADS=3 или 4
// 
// Для экономии ресурсов на слабом сервере:
// Установи MAX_CONCURRENT_DOWNLOADS=1
// 
// Текущее значение оптимально для бесплатного тарифа Render.com
// 
// ========================= END OF FILE =========================