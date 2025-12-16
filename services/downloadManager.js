// =====================================================================================
//      ОБНОВЛЁННАЯ ВЕРСИЯ С ПРОВЕРКОЙ ПРЕВЬЮ В КЭШЕ
//                       services/downloadManager.js
// =====================================================================================

import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME, PROXY_URL } from '../config.js';
import { Markup } from 'telegraf';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import scdl from 'soundcloud-downloader';
import os from 'os';
import { fileURLToPath } from 'url';
import ytdl from 'youtube-dl-exec';

import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import * as db from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = path.join(os.tmpdir(), 'sc-cache');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 2;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];

const pickUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const COMMON_HEADERS = [
  'Accept-Language:en-US,en;q=0.9,ru;q=0.8',
  'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Referer:https://soundcloud.com/',
  'Sec-Fetch-Dest:document',
  'Sec-Fetch-Mode:navigate',
  'Sec-Fetch-Site:same-origin',
  'Sec-Fetch-User:?1',
  'Upgrade-Insecure-Requests:1'
];

const YTDL_COMMON = {
  'format': 'bestaudio[ext=mp3]/bestaudio[ext=opus]/bestaudio',
  'ffmpeg-location': ffmpegPath,
  'user-agent': pickUserAgent(),
  proxy: PROXY_URL,
  retries: 3,
  'socket-timeout': 120,
  'no-warnings': true,
  referer: 'https://soundcloud.com/',
  'add-header': COMMON_HEADERS,
  'geo-bypass': true
};

// --- Вспомогательные функции ---

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'track';
  return name.replace(/[<>:"/\\|?*]+/g, '').trim() || 'track';
}

function getCacheKey(meta, fallbackUrl) {
  if (meta?.id) return `sc:${meta.id}`;
  return fallbackUrl || 'unknown';
}

/**
 * Проверяет, является ли закэшированный трек полноценным (не превью)
 * @param {Object} cached - закэшированный трек
 * @param {number} expectedDuration - ожидаемая длительность в секундах
 * @returns {boolean} true если кэш валиден, false если это превью
 */
function isCacheValid(cached, expectedDuration) {
  if (!cached) return false;
  
  // Если нет информации о длительности - используем кэш (доверяем)
  if (!cached.duration || !expectedDuration) return true;
  
  // Превью обычно ~30 секунд
  // Если ожидаемая длительность > 60 сек, а в кэше < 35 сек - это превью
  if (expectedDuration > 60 && cached.duration < 35) {
    console.warn(`[Cache] ПРЕВЬЮ обнаружено! cached=${cached.duration}s, expected=${expectedDuration}s`);
    return false;
  }
  
  // Если кэшированная версия меньше 50% от ожидаемой - подозрительно
  if (cached.duration < expectedDuration * 0.5) {
    console.warn(`[Cache] Подозрительно короткий: ${cached.duration}s vs ${expectedDuration}s`);
    return false;
  }
  
  return true;
}

/**
 * Удаляет невалидный кэш (превью)
 */
async function invalidateCache(url, cacheKey) {
  try {
    if (url) {
      await db.deleteCachedTrack(url);
    }
    if (cacheKey && cacheKey !== url) {
      await db.deleteCachedTrack(cacheKey);
    }
    console.log(`[Cache] Инвалидирован: ${url || cacheKey}`);
  } catch (e) {
    console.error('[Cache] Ошибка удаления:', e.message);
  }
}

async function safeSendMessage(userId, text, extra = {}) {
  try {
    return await bot.telegram.sendMessage(userId, text, extra);
  } catch (e) {
    if (e.response?.error_code === 403) {
      await db.updateUserField(userId, 'active', false).catch(() => {});
    }
    return null;
  }
}

async function incrementDownload(userId, trackTitle, fileId, cacheKey) {
  return await db.incrementDownloadsAndSaveTrack(userId, trackTitle, fileId, cacheKey);
}

async function getUserUsage(userId) {
  return await db.getUser(userId);
}

function extractMetadataFromInfo(info) {
  const e = Array.isArray(info?.entries) ? info.entries[0] : info;
  if (!e) return null;
  return {
    id: e.id,
    webpage_url: e.webpage_url || e.url,
    title: sanitizeFilename(e.title || 'Unknown Title'),
    uploader: e.uploader || 'Unknown Artist',
    duration: e.duration,
    thumbnail: e.thumbnail,
  };
}

async function ensureTaskMetadata(task) {
  let { metadata, cacheKey } = task;
  const url = task.url || task.originalUrl;
  
  if (!metadata) {
    if (!url) throw new Error('TASK_MISSING_URL');
    console.warn('[Worker] metadata отсутствует, получаю через ytdl для URL:', url);
    const info = await ytdl(url, { 'dump-single-json': true, 'no-playlist': true, 'ignore-errors': true, ...YTDL_COMMON });
    metadata = extractMetadataFromInfo(info);
    if (!metadata) throw new Error('META_MISSING');
  }
  
  if (!cacheKey) {
    cacheKey = getCacheKey(metadata, task.originalUrl || url);
  }
  return { metadata, cacheKey, url };
}
// =====================================================================================
//                    НОВОЕ: ФУНКЦИЯ ДЛЯ АДМИНКИ
// =====================================================================================

/**
 * Скачивает трек и отправляет пользователю
 * Используется для кнопки "Исправить и отправить" в админке
 * 
 * @param {string} url - URL трека
 * @param {number} userId - ID пользователя
 * @param {object} metadata - Метаданные (опционально)
 * @returns {Promise<{success: boolean, fileId?: string, title?: string, error?: string}>}
 */
export async function downloadTrackForUser(url, userId, metadata = null) {
  let tempFilePath = null;
  
  try {
    console.log(`[DownloadForUser] Скачиваю для User ${userId}: ${url.substring(0, 60)}...`);
    
    // Получаем метаданные если нет
    if (!metadata) {
      const info = await ytdl(url, { 
        'dump-single-json': true, 
        'skip-download': true,
        'no-playlist': true,
        ...YTDL_COMMON 
      });
      metadata = extractMetadataFromInfo(info);
    }
    
    if (!metadata) throw new Error('META_MISSING');
    
    const { title, uploader, duration, webpage_url: fullUrl, thumbnail } = metadata;
    const roundedDuration = duration ? Math.round(duration) : null;
    const trackUrl = fullUrl || url;
    
    let stream;
    let usedFallback = false;
    
    // Попытка 1: SCDL (быстро, streaming)
    try {
      console.log(`[DownloadForUser/SCDL] Пробую: ${trackUrl}`);
      stream = await scdl.default.download(trackUrl);
    } catch (scdlError) {
      // Попытка 2: YT-DLP fallback
      console.log(`[DownloadForUser] SCDL failed (${scdlError.message}), trying YT-DLP...`);
      
      tempFilePath = path.join(TEMP_DIR, `admin_${Date.now()}_${userId}.mp3`);
      usedFallback = true;
      
      await ytdl(trackUrl, {
        output: tempFilePath,
        format: 'bestaudio[ext=mp3]/bestaudio',
        noPlaylist: true,
        ...YTDL_COMMON
      });
      
      if (!fs.existsSync(tempFilePath)) {
        throw new Error('YT-DLP failed to create file');
      }
      
      stream = fs.createReadStream(tempFilePath);
    }
    
    // Отправляем в хранилище
    if (!STORAGE_CHANNEL_ID) {
      throw new Error('STORAGE_CHANNEL_ID not configured');
    }
    
    const sentMsg = await bot.telegram.sendAudio(
      STORAGE_CHANNEL_ID,
      { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
      { title, performer: uploader }
    );
    
    const realDuration = sentMsg.audio?.duration || 0;
    const fileId = sentMsg.audio?.file_id;
    
    // Проверка на превью
    if (isPreview(realDuration, roundedDuration)) {
      console.warn(`[DownloadForUser] ПРЕВЬЮ! ${realDuration}s vs ${roundedDuration}s`);
      await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentMsg.message_id).catch(() => {});
      throw new Error('PREVIEW_ONLY');
    }
    
    // Кэшируем
    await db.cacheTrack({
      url: trackUrl,
      fileId,
      title,
      artist: uploader,
      duration: realDuration,
      thumbnail
    });
    
    // Отправляем пользователю
    await bot.telegram.sendAudio(userId, fileId, {
      title,
      performer: uploader,
      duration: realDuration
    });
    
    console.log(`[DownloadForUser] ✅ Успешно: "${title}" → User ${userId}`);
    
    return { success: true, fileId, title };
    
  } catch (err) {
    console.error(`[DownloadForUser] ❌ Ошибка:`, err.message);
    return { success: false, error: err.message };
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }
  }
}

// =====================================================================================
//                             ГЛАВНЫЙ ПРОЦЕССОР ЗАГРУЗКИ
// =====================================================================================

export async function trackDownloadProcessor(task) {
  let statusMessage = null;
  let tempFilePath = null;
  const userId = parseInt(task.userId, 10);
  
  try {
    // 1. Лимиты
    const usage = await getUserUsage(userId);
    if (!usage || usage.downloads_today >= usage.premium_limit) {
      await safeSendMessage(userId, T('limitReached'));
      return;
    }

    // 2. Метаданные
    const ensured = await ensureTaskMetadata(task);
    const { metadata, cacheKey } = ensured;
    const { title, uploader, duration, webpage_url: fullUrl } = metadata;
    const roundedDuration = duration ? Math.round(duration) : undefined;
    
    console.log(`[Worker] ====== НАЧАЛО ОБРАБОТКИ ======`);
    console.log(`[Worker] Трек: "${title}" by ${uploader}`);
    console.log(`[Worker] URL: ${fullUrl}`);
    console.log(`[Worker] Ожидаемая длительность: ${roundedDuration || 'N/A'}s`);
    console.log(`[Worker] CacheKey: ${cacheKey}`);
    
    if (!fullUrl) throw new Error(`Нет ссылки на трек: ${title}`);

    // 3. КЭШ С ПРОВЕРКОЙ НА ПРЕВЬЮ
    let cached = await db.findCachedTrack(cacheKey) || await db.findCachedTrack(fullUrl);
    
    console.log(`[Worker] Результат поиска в кэше:`, cached ? {
      title: cached.title,
      duration: cached.duration,
      hasFileId: !!cached.fileId
    } : 'НЕ НАЙДЕН');
    
    if (cached?.fileId) {
      console.log(`[Worker] Проверка валидности кэша: cachedDuration=${cached.duration}, expectedDuration=${roundedDuration}`);
      
      // === ПРОВЕРКА ВАЛИДНОСТИ КЭША ===
      if (isCacheValid(cached, roundedDuration)) {
        console.log(`[Worker/Cache] ✅ Кэш валиден, отправляю из кэша`);
        await bot.telegram.sendAudio(userId, cached.fileId, { 
          title: cached.title, 
          performer: cached.artist || uploader, 
          duration: cached.duration || roundedDuration 
        });
        await incrementDownload(userId, cached.title, cached.fileId, cacheKey);
        return;
      } else {
        // Это превью! Удаляем из кэша и качаем заново
        console.warn(`[Worker/Cache] ❌ В кэше превью! Удаляю и качаю заново...`);
        await invalidateCache(fullUrl, cacheKey);
        cached = null;
      }
    } else {
      console.log(`[Worker] Кэш пуст, будем скачивать`);
    }

    statusMessage = await safeSendMessage(userId, `⏳ Скачиваю: "${title}"`);
    
    let stream;
    let usedFallback = false;
    let finalFileId = null;

    // ========================================================
    // 4. СКАЧИВАНИЕ (SCDL STREAM - БЫСТРО)
    // ========================================================
    try {
        console.log(`[Worker/Stream] (SCDL) Пробую скачать: ${fullUrl}`);
        const ua = pickUserAgent();
        stream = await scdl.default.download(fullUrl, { 
            proxy: PROXY_URL, 
            headers: { 
              'User-Agent': ua,
              'Referer': 'https://soundcloud.com/'
            } 
        });
        
        if (STORAGE_CHANNEL_ID) {
            console.log(`[Worker/Stream] Отправка в хранилище БЕЗ duration для проверки...`);
            const sentMsg = await bot.telegram.sendAudio(
                STORAGE_CHANNEL_ID,
                { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
                { title, performer: uploader }
            );
            
            // ПРОВЕРКА ОБРУБКА СРЕДСТВАМИ ТЕЛЕГРАМА
            const realDuration = sentMsg.audio?.duration || 0;
            console.log(`[Worker] Проверка: получено ${realDuration}s, ожидалось ${roundedDuration || 'N/A'}s`);
            
            // Если трек должен быть длинным (>60 сек), а пришло меньше 35 сек
            if (roundedDuration > 60 && realDuration < 35) {
                console.warn(`[Worker] ПРЕВЬЮ DETECTED! ${realDuration}s вместо ${roundedDuration}s`);
                // Удаляем плохой файл из канала
                await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentMsg.message_id).catch(()=>{});
                
                // ЗАПИСЬ В РЕЕСТР ОШИБОК (ПРЕВЬЮ)
                try { await db.logBrokenTrack(fullUrl, title, userId, 'PREVIEW_ONLY'); } catch (e) {}
                
                throw new Error('SCDL_INCOMPLETE_FILE');
            }
            
            finalFileId = sentMsg.audio?.file_id;
        }
        
    } catch (scdlError) {
        // Если SCDL упал ИЛИ мы сами выбросили ошибку 'SCDL_INCOMPLETE_FILE'
        console.warn(`[Worker] Переключаюсь на YT-DLP (Причина: ${scdlError.message})...`);
        
        // YT-DLP Fallback (Медленно, но надежно)
        tempFilePath = path.join(TEMP_DIR, `dl_${Date.now()}_${userId}.mp3`);
        usedFallback = true;

        await ytdl(fullUrl, {
            output: tempFilePath,
            format: 'bestaudio[ext=mp3]/bestaudio',
            noPlaylist: true,
            ...YTDL_COMMON
        });

        if (fs.existsSync(tempFilePath)) {
            console.log(`[Worker/Fallback] Файл скачан YT-DLP: ${tempFilePath}`);
            stream = fs.createReadStream(tempFilePath);
        } else {
            throw new Error(`YT-DLP не смог скачать файл.`);
        }
    }

    // ========================================================
    // 5. ОТПРАВКА ПОЛЬЗОВАТЕЛЮ И КЭШИРОВАНИЕ
    // ========================================================
    
    if (finalFileId) {
        // SCDL успешно скачал полную версию, уже в канале
        const urlAliases = [];
        if (task.originalUrl && task.originalUrl !== fullUrl) urlAliases.push(task.originalUrl);
        if (cacheKey) urlAliases.push(cacheKey);
        
        // Кэшируем С ДЛИТЕЛЬНОСТЬЮ для будущих проверок
        await db.cacheTrack({ 
            url: fullUrl, 
            fileId: finalFileId, 
            title, 
            artist: uploader, 
            duration: roundedDuration, 
            thumbnail: metadata.thumbnail, 
            aliases: urlAliases 
        });
        
        await bot.telegram.sendAudio(userId, finalFileId, { title, performer: uploader, duration: roundedDuration });
        await incrementDownload(userId, title, finalFileId, task.originalUrl || fullUrl);

    } else if (usedFallback) {
        // YT-DLP скачал файл
        if (STORAGE_CHANNEL_ID) {
             const sentToStorage = await bot.telegram.sendAudio(
                STORAGE_CHANNEL_ID, 
                { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
                { title, performer: uploader }
             );
             
             const realDuration = sentToStorage.audio?.duration || 0;
             finalFileId = sentToStorage?.audio?.file_id;
             
             console.log(`[Worker/YT-DLP] Получено ${realDuration}s, ожидалось ${roundedDuration || 'N/A'}s`);
             
             // Проверяем и YT-DLP результат!
             if (roundedDuration > 60 && realDuration < 35) {
                 console.error(`[Worker] YT-DLP тоже скачал превью! Трек недоступен.`);
                 await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentToStorage.message_id).catch(()=>{});
                 
                 // ЗАПИСЬ В РЕЕСТР ОШИБОК (ПРЕВЬЮ ЧЕРЕЗ YTDL)
                 try { await db.logBrokenTrack(fullUrl, title, userId, 'PREVIEW_ONLY_YTDL'); } catch (e) {}
                 
                 throw new Error('TRACK_PREVIEW_ONLY');
             }
             
             // Кэшируем "хорошую" версию с реальной длительностью
             if (finalFileId) {
                 await db.cacheTrack({ 
                   url: fullUrl, 
                   fileId: finalFileId, 
                   title, 
                   artist: uploader, 
                   duration: realDuration, // Реальная длительность!
                   thumbnail: metadata.thumbnail 
                 });
             }
             
             await bot.telegram.sendAudio(userId, finalFileId, { title, performer: uploader, duration: realDuration });
             
        } else {
             // Прямая отправка (без канала-хранилища)
             await bot.telegram.sendAudio(userId, { source: stream, filename: `${sanitizeFilename(title)}.mp3` }, { title, performer: uploader, duration: roundedDuration });
        }
        
        await incrementDownload(userId, title, finalFileId, task.originalUrl || fullUrl);
    }

  } catch (err) {
// ==========================================
    // ЛОГИРОВАНИЕ В РЕЕСТР И ОБРАБОТКА ОШИБОК
    // ==========================================
    let failureReason = 'UNKNOWN_ERROR';
    
    // Определяем тип ошибки
    if (err.message.includes('413') || err.message.includes('Too Large')) {
        failureReason = 'FILE_TOO_LARGE';
    } else if (err.message === 'TRACK_PREVIEW_ONLY' || err.message === 'SCDL_INCOMPLETE_FILE') {
        failureReason = 'PREVIEW_ONLY';
    } else if (err.message.includes('HTTP Error 403') || err.message.includes('Forbidden') || err.message.includes('403')) {
        failureReason = '403_FORBIDDEN'; 
    } else if (err.message.includes('429')) {
        failureReason = 'RATE_LIMIT';
    } else if (err.message.includes('YT-DLP не смог скачать')) {
        failureReason = 'DOWNLOAD_ERROR';
    }

    // Записываем в БД
    try {
        await db.logBrokenTrack(
            task.originalUrl || task.url || 'Unknown URL', 
            task.metadata?.title || 'Unknown Title', 
            userId, 
            failureReason
        );
    } catch (dbErr) {
        console.error('Ошибка записи в реестр broken tracks:', dbErr);
    }

    console.error(`❌ Ошибка (User ${userId}):`, err.message);
    
    // Отправляем сообщение пользователю
    if (failureReason === 'FILE_TOO_LARGE') {
        const durationMin = task.metadata?.duration ? Math.round(task.metadata.duration / 60) : '?';
        await safeSendMessage(userId, 
            `❌ <b>Файл слишком большой!</b>\n\n` +
            `Telegram не позволяет ботам отправлять файлы больше 50 МБ.\n` +
            `Этот трек (длительность: ${durationMin} мин) превышает лимит.`,
            { parse_mode: 'HTML' }
        );
    } else if (failureReason === 'PREVIEW_ONLY') {
        await safeSendMessage(userId, 
            `⚠️ <b>Трек доступен только как превью</b>\n\n` +
            `Правообладатель ограничил доступ к полной версии на SoundCloud.\n\n` +
            `💡 Попробуйте найти этот трек на другой платформе.`,
            { parse_mode: 'HTML' }
        );
    } else {
        await safeSendMessage(userId, `❌ Не удалось скачать трек. Возможно, он удален или недоступен.`);
    }
  } finally {
    if (statusMessage) try { await bot.telegram.deleteMessage(userId, statusMessage.message_id); } catch (e) {}
    if (tempFilePath && fs.existsSync(tempFilePath)) try { fs.unlinkSync(tempFilePath); } catch (e) {}
  }
}

// =====================================================================================
//                                 ОЧЕРЕДЬ
// =====================================================================================

export const downloadQueue = new TaskQueue({
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
  taskProcessor: trackDownloadProcessor
});

console.log(`[DownloadManager] Очередь (threads=${MAX_CONCURRENT_DOWNLOADS})`);

// =====================================================================================
//                                 ФУНКЦИЯ ENQUEUE
// =====================================================================================

export function enqueue(ctx, userId, url, earlyData = {}) {
  (async () => {
    let statusMessage = null;
    console.log(`[Enqueue] User ${userId}, URL: ${url}`);
    
    try {
      // Проверка бонусов/лимитов
      const user = await db.getUser(userId);
      if ((user.downloads_today || 0) >= user.premium_limit) {
          const bonusAvailable = Boolean(CHANNEL_USERNAME && !user?.subscribed_bonus_used);
          const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
          const bonusText = bonusAvailable ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.` : '';
          const text = `${T('limitReached')}${bonusText}`;
          const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
          if (bonusAvailable) {
            extra.reply_markup = { inline_keyboard: [[Markup.button.callback('✅ Я подписался, забрать бонус', 'check_subscription')]] };
          }
          await safeSendMessage(userId, text, extra);
          return;
      }

      // 1. FAST PATH (если метаданные уже есть из поиска)
      if (earlyData.isSingleTrack && earlyData.metadata) {
        console.log('[Enqueue/Fast] Метаданные получены заранее.');
        const metadata = extractMetadataFromInfo(earlyData.metadata);
        const { webpage_url: fullUrl, id, duration } = metadata;
        const cacheKey = id ? `sc:${id}` : null;
        const expectedDuration = duration ? Math.round(duration) : null;

        // Проверка кэша С ВАЛИДАЦИЕЙ НА ПРЕВЬЮ
        const cached = await db.findCachedTrack(url) || await db.findCachedTrack(fullUrl) || (cacheKey && await db.findCachedTrack(cacheKey));
        
        if (cached?.fileId) {
          // === ПРОВЕРКА НА ПРЕВЬЮ ===
          if (isCacheValid(cached, expectedDuration)) {
            console.log(`[Enqueue/Fast] ХИТ КЭША!`);
            await bot.telegram.sendAudio(userId, cached.fileId, { 
              title: cached.title, 
              performer: cached.artist,
              duration: cached.duration
            });
            await incrementDownload(userId, cached.title, cached.fileId, url);
            return;
          } else {
            console.warn(`[Enqueue/Fast] Кэш = превью! Качаем заново...`);
            await invalidateCache(url, cacheKey);
            // НЕ делаем return, продолжаем добавлять в очередь
          }
        }

        // Добавляем в очередь
        const task = { userId, url: fullUrl, originalUrl: url, source: 'soundcloud', cacheKey, metadata };
        downloadQueue.add({ ...task, priority: user.premium_limit || 5 });
        await safeSendMessage(userId, `✅ Трек "${metadata.title}" добавлен в очередь.`);
        return;
      }

      // 2. SLOW PATH (Если просто кинули ссылку)
      // Сначала проверим кэш по URL
      const quickCache = await db.findCachedTrack(url);
      if (quickCache?.fileId) {
          // Для slow path у нас нет expectedDuration, 
          // поэтому просто проверяем на очень короткие (< 35 сек)
          if (!quickCache.duration || quickCache.duration > 35) {
            console.log(`[Enqueue/Slow] ХИТ КЭША по URL!`);
            await bot.telegram.sendAudio(userId, quickCache.fileId, { 
              title: quickCache.title, 
              performer: quickCache.artist,
              duration: quickCache.duration
            });
            await incrementDownload(userId, quickCache.title, quickCache.fileId, url);
            return;
          } else {
            console.warn(`[Enqueue/Slow] Кэш слишком короткий (${quickCache.duration}s), качаем заново`);
            await invalidateCache(url, null);
          }
      }

      statusMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');
      
      // Получаем инфо через yt-dlp
      const info = await ytdl(url, { 'dump-single-json': true, 'flat-playlist': true, ...YTDL_COMMON });
      
      // Удаляем сообщение "Анализирую..."
      if (statusMessage) {
        await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
      }

      // Это плейлист?
      if (info.entries && info.entries.length > 0) {
          await safeSendMessage(userId, `📂 Найден плейлист/альбом: "${info.title || 'Playlist'}".\nДобавляю ${info.entries.length} треков...`);
          
          let addedCount = 0;
          for (const entry of info.entries) {
              const meta = extractMetadataFromInfo(entry);
              if (meta) {
                  const task = { userId, url: meta.webpage_url, originalUrl: url, source: 'soundcloud', metadata: meta };
                  downloadQueue.add({ ...task, priority: user.premium_limit || 5 });
                  addedCount++;
              }
          }
          await safeSendMessage(userId, `✅ Добавлено в очередь: ${addedCount} треков.`);
      } else {
          // Одиночный трек
          const meta = extractMetadataFromInfo(info);
          if (meta) {
              const task = { userId, url: meta.webpage_url, originalUrl: url, source: 'soundcloud', metadata: meta };
              downloadQueue.add({ ...task, priority: user.premium_limit || 5 });
              await safeSendMessage(userId, `✅ Трек "${meta.title}" добавлен в очередь.`);
          } else {
              throw new Error('Не удалось извлечь данные о треке.');
          }
      }

    } catch (err) {
      console.error(`[Enqueue] Ошибка:`, err.message);
      if (statusMessage) {
        await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
      }
      await safeSendMessage(userId, `❌ Ошибка при чтении ссылки. Возможно, она приватная или неверная.`);
    }
  })().catch(e => console.error('Async Enqueue Error:', e));
}

export function initializeDownloadManager() {
  console.log('[DownloadManager] Готов к работе.');
}
