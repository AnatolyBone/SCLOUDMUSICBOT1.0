// =====================================================================================
//      ГИБРИДНАЯ ВЕРСИЯ - SCDL STREAMING + YT-DLP FALLBACK
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
import { PassThrough } from 'stream';

import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import * as db from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = path.join(os.tmpdir(), 'sc-cache');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 2;

// =====================================================================================
//                         КОНФИГУРАЦИЯ
// =====================================================================================

const YTDL_OPTIONS = {
  'ffmpeg-location': ffmpegPath,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'no-warnings': true,
  'no-check-certificates': true,
  retries: 3,
  'socket-timeout': 60,
  ...(PROXY_URL ? { proxy: PROXY_URL } : {})
};

// --- Вспомогательные функции ---

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'track';
  return name.replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, ' ').trim() || 'track';
}

function getCacheKey(meta, fallbackUrl) {
  if (meta?.id) return `sc:${meta.id}`;
  return fallbackUrl || 'unknown';
}

function isCacheValid(cached, expectedDuration) {
  if (!cached) return false;
  if (!cached.duration || !expectedDuration) return true;
  if (expectedDuration > 60 && cached.duration < 35) return false;
  if (cached.duration < expectedDuration * 0.5) return false;
  return true;
}

async function invalidateCache(url, cacheKey) {
  try {
    if (url) await db.deleteCachedTrack(url);
    if (cacheKey && cacheKey !== url) await db.deleteCachedTrack(cacheKey);
  } catch (e) {}
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
    uploader: e.uploader || e.artist || 'Unknown Artist',
    duration: e.duration,
    thumbnail: e.thumbnail,
  };
}

async function ensureTaskMetadata(task) {
  let { metadata, cacheKey } = task;
  const url = task.url || task.originalUrl;
  
  if (!metadata) {
    if (!url) throw new Error('TASK_MISSING_URL');
    const info = await ytdl(url, { 
      'dump-single-json': true, 
      'no-playlist': true, 
      'skip-download': true,
      ...YTDL_OPTIONS 
    });
    metadata = extractMetadataFromInfo(info);
    if (!metadata) throw new Error('META_MISSING');
  }
  
  if (!cacheKey) cacheKey = getCacheKey(metadata, task.originalUrl || url);
  return { metadata, cacheKey, url };
}

// =====================================================================================
//                   МЕТОД 1: SCDL STREAMING (БЫСТРО, БЕЗ RAM)
// =====================================================================================

async function downloadWithScdlStream(url, title, uploader, expectedDuration) {
  console.log(`[SCDL/Stream] Пробую: ${url.substring(0, 60)}...`);
  
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('SCDL_TIMEOUT'));
    }, 30000); // 30 сек таймаут
    
    try {
      const stream = await scdl.default.download(url);
      
      // Проверяем что stream не пустой
      let receivedData = false;
      let dataSize = 0;
      
      const passThrough = new PassThrough();
      
      stream.on('data', (chunk) => {
        receivedData = true;
        dataSize += chunk.length;
        passThrough.write(chunk);
      });
      
      stream.on('end', () => {
        clearTimeout(timeout);
        passThrough.end();
        
        if (!receivedData || dataSize < 10000) {
          reject(new Error('SCDL_EMPTY_STREAM'));
        } else {
          console.log(`[SCDL/Stream] Получено ${(dataSize / 1024).toFixed(0)} KB`);
          resolve({ stream: passThrough, size: dataSize });
        }
      });
      
      stream.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`SCDL_STREAM_ERROR: ${err.message}`));
      });
      
      // Прерываем через timeout если данные не идут
      setTimeout(() => {
        if (!receivedData) {
          stream.destroy();
          reject(new Error('SCDL_NO_DATA'));
        }
      }, 10000);
      
    } catch (err) {
      clearTimeout(timeout);
      reject(new Error(`SCDL_INIT_ERROR: ${err.message}`));
    }
  });
}

// =====================================================================================
//                   МЕТОД 2: YT-DLP FALLBACK (НАДЕЖНО, МЕДЛЕННЕЕ)
// =====================================================================================

async function downloadWithYtdlpFile(url, expectedDuration) {
  console.log(`[YT-DLP/File] Fallback для: ${url.substring(0, 60)}...`);
  
  const tempFile = path.join(TEMP_DIR, `ytdl_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
  
  try {
    await ytdl(url, {
      output: tempFile,
      format: 'bestaudio[ext=mp3]/bestaudio',
      'extract-audio': true,
      'audio-format': 'mp3',
      'no-playlist': true,
      ...YTDL_OPTIONS
    });
    
    if (!fs.existsSync(tempFile)) {
      throw new Error('YTDL_FILE_NOT_CREATED');
    }
    
    const stats = fs.statSync(tempFile);
    if (stats.size < 10000) {
      fs.unlinkSync(tempFile);
      throw new Error('YTDL_FILE_TOO_SMALL');
    }
    
    console.log(`[YT-DLP/File] ✅ Скачано: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    return { filePath: tempFile, size: stats.size };
    
  } catch (err) {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    throw err;
  }
}

// =====================================================================================
//                   УНИВЕРСАЛЬНАЯ ФУНКЦИЯ СКАЧИВАНИЯ (для API)
// =====================================================================================

/**
 * Скачивает трек и возвращает file_id из Telegram
 * Используется для "Исправить и отправить"
 */
export async function downloadTrackForUser(url, userId, metadata = null) {
  let tempFilePath = null;
  
  try {
    // Получаем метаданные если нет
    if (!metadata) {
      const info = await ytdl(url, { 
        'dump-single-json': true, 
        'skip-download': true,
        ...YTDL_OPTIONS 
      });
      metadata = extractMetadataFromInfo(info);
    }
    
    if (!metadata) throw new Error('META_MISSING');
    
    const { title, uploader, duration, webpage_url: fullUrl } = metadata;
    const roundedDuration = duration ? Math.round(duration) : null;
    
    console.log(`[DownloadForUser] Скачиваю: "${title}" для User ${userId}`);
    
    let audioSource;
    let method = 'unknown';
    
    // Пробуем SCDL Stream
    try {
      const result = await downloadWithScdlStream(fullUrl || url, title, uploader, roundedDuration);
      audioSource = { source: result.stream, filename: `${sanitizeFilename(title)}.mp3` };
      method = 'SCDL';
    } catch (scdlErr) {
      console.log(`[DownloadForUser] SCDL failed: ${scdlErr.message}, trying YT-DLP...`);
      
      // Fallback на YT-DLP
      const result = await downloadWithYtdlpFile(fullUrl || url, roundedDuration);
      tempFilePath = result.filePath;
      audioSource = { source: fs.createReadStream(tempFilePath), filename: `${sanitizeFilename(title)}.mp3` };
      method = 'YT-DLP';
    }
    
    // Отправляем в хранилище
    if (STORAGE_CHANNEL_ID) {
      const sentMsg = await bot.telegram.sendAudio(
        STORAGE_CHANNEL_ID,
        audioSource,
        { title, performer: uploader }
      );
      
      const realDuration = sentMsg.audio?.duration || 0;
      const fileId = sentMsg.audio?.file_id;
      
      // Проверка на превью
      if (roundedDuration && roundedDuration > 60 && realDuration < 35) {
        await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentMsg.message_id).catch(() => {});
        throw new Error('PREVIEW_ONLY');
      }
      
      // Кэшируем
      await db.cacheTrack({
        url: fullUrl || url,
        fileId,
        title,
        artist: uploader,
        duration: realDuration,
        thumbnail: metadata.thumbnail
      });
      
      // Отправляем пользователю
      await bot.telegram.sendAudio(userId, fileId, {
        title,
        performer: uploader,
        duration: realDuration
      });
      
      console.log(`[DownloadForUser] ✅ Успешно (${method}): "${title}" → User ${userId}`);
      
      return { success: true, fileId, title, method };
    } else {
      throw new Error('STORAGE_NOT_CONFIGURED');
    }
    
  } catch (err) {
    console.error(`[DownloadForUser] ❌ Ошибка:`, err.message);
    throw err;
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
    const { title, uploader, duration, webpage_url: fullUrl, thumbnail } = metadata;
    const roundedDuration = duration ? Math.round(duration) : undefined;
    
    console.log(`[Worker] ====== НАЧАЛО ======`);
    console.log(`[Worker] "${title}" by ${uploader} (${roundedDuration || '?'}s)`);
    
    if (!fullUrl) throw new Error(`Нет URL для: ${title}`);

    // 3. КЭШ
    let cached = await db.findCachedTrack(cacheKey) || await db.findCachedTrack(fullUrl);
    
    if (cached?.fileId && isCacheValid(cached, roundedDuration)) {
      console.log(`[Worker/Cache] ✅ ХИТ`);
      await bot.telegram.sendAudio(userId, cached.fileId, { 
        title: cached.title, 
        performer: cached.artist || uploader, 
        duration: cached.duration || roundedDuration 
      });
      await incrementDownload(userId, cached.title, cached.fileId, cacheKey);
      return;
    } else if (cached?.fileId) {
      console.warn(`[Worker/Cache] Превью, очищаю...`);
      await invalidateCache(fullUrl, cacheKey);
    }

    statusMessage = await safeSendMessage(userId, `⏳ Скачиваю: "${title}"`);
    
    let audioSource;
    let method = 'unknown';
    let realDuration = roundedDuration;
    let finalFileId = null;
    
    // ========================================================
    // 4. SCDL STREAMING (БЫСТРО)
    // ========================================================
    try {
      const result = await downloadWithScdlStream(fullUrl, title, uploader, roundedDuration);
      
      // Отправляем stream напрямую в Telegram
      if (STORAGE_CHANNEL_ID) {
        const sentMsg = await bot.telegram.sendAudio(
          STORAGE_CHANNEL_ID,
          { source: result.stream, filename: `${sanitizeFilename(title)}.mp3` },
          { title, performer: uploader }
        );
        
        realDuration = sentMsg.audio?.duration || 0;
        finalFileId = sentMsg.audio?.file_id;
        
        // Проверка на превью
        if (roundedDuration && roundedDuration > 60 && realDuration < 35) {
          console.warn(`[Worker] ПРЕВЬЮ! ${realDuration}s vs ${roundedDuration}s`);
          await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentMsg.message_id).catch(() => {});
          throw new Error('SCDL_PREVIEW');
        }
        
        method = 'SCDL';
      }
      
    } catch (scdlError) {
      console.log(`[Worker] SCDL failed (${scdlError.message}), trying YT-DLP...`);
      
      // ========================================================
      // 5. YT-DLP FALLBACK (НАДЕЖНО)
      // ========================================================
      try {
        const result = await downloadWithYtdlpFile(fullUrl, roundedDuration);
        tempFilePath = result.filePath;
        
        if (STORAGE_CHANNEL_ID) {
          const sentMsg = await bot.telegram.sendAudio(
            STORAGE_CHANNEL_ID,
            { source: fs.createReadStream(tempFilePath), filename: `${sanitizeFilename(title)}.mp3` },
            { title, performer: uploader }
          );
          
          realDuration = sentMsg.audio?.duration || 0;
          finalFileId = sentMsg.audio?.file_id;
          
          // Проверка на превью
          if (roundedDuration && roundedDuration > 60 && realDuration < 35) {
            console.error(`[Worker] YT-DLP тоже превью!`);
            await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentMsg.message_id).catch(() => {});
            throw new Error('YTDLP_PREVIEW');
          }
          
          method = 'YT-DLP';
        }
        
      } catch (ytErr) {
        // Оба метода не сработали
        await db.logBrokenTrack(fullUrl, title, userId, 'DOWNLOAD_FAILED');
        throw new Error(`BOTH_METHODS_FAILED: ${ytErr.message}`);
      }
    }

    // ========================================================
    // 6. УСПЕХ - КЭШИРУЕМ И ОТПРАВЛЯЕМ
    // ========================================================
    if (finalFileId) {
      // Кэшируем
      const urlAliases = [];
      if (task.originalUrl && task.originalUrl !== fullUrl) urlAliases.push(task.originalUrl);
      if (cacheKey && cacheKey !== fullUrl) urlAliases.push(cacheKey);
      
      await db.cacheTrack({ 
        url: fullUrl, 
        fileId: finalFileId, 
        title, 
        artist: uploader, 
        duration: realDuration,
        thumbnail,
        aliases: urlAliases 
      });
      
      // Отправляем пользователю
      await bot.telegram.sendAudio(userId, finalFileId, { 
        title, 
        performer: uploader, 
        duration: realDuration 
      });
      
      await incrementDownload(userId, title, finalFileId, task.originalUrl || fullUrl);
      console.log(`[Worker] ✅ Успех (${method}): "${title}"`);
    }

  } catch (err) {
    // ==========================================
    // ОБРАБОТКА ОШИБОК
    // ==========================================
    let failureReason = 'UNKNOWN';
    let userMessage = `❌ Не удалось скачать трек.`;
    
    const errMsg = err.message || '';
    
    if (errMsg.includes('PREVIEW')) {
      failureReason = 'PREVIEW_ONLY';
      userMessage = `⚠️ <b>Доступно только превью</b>\n\nПравообладатель ограничил доступ.`;
    } else if (errMsg.includes('413') || errMsg.includes('Large')) {
      failureReason = 'FILE_TOO_LARGE';
      userMessage = `❌ <b>Файл слишком большой</b> (лимит Telegram 50 МБ)`;
    } else if (errMsg.includes('403')) {
      failureReason = '403_FORBIDDEN';
      userMessage = `❌ Доступ заблокирован.`;
    } else if (errMsg.includes('BOTH_METHODS_FAILED')) {
      failureReason = 'DOWNLOAD_FAILED';
      userMessage = `❌ Не удалось скачать. Попробуйте позже.`;
    }

    try {
      await db.logBrokenTrack(
        task.originalUrl || task.url || 'Unknown', 
        task.metadata?.title || 'Unknown', 
        userId, 
        failureReason
      );
    } catch (e) {}

    console.error(`❌ User ${userId}:`, errMsg);
    await safeSendMessage(userId, userMessage, { parse_mode: 'HTML' });
    
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
//                                 ENQUEUE
// =====================================================================================

export function enqueue(ctx, userId, url, earlyData = {}) {
  (async () => {
    let statusMessage = null;
    console.log(`[Enqueue] User ${userId}, URL: ${url}`);
    
    try {
      const user = await db.getUser(userId);
      if ((user.downloads_today || 0) >= user.premium_limit) {
        const bonusAvailable = Boolean(CHANNEL_USERNAME && !user?.subscribed_bonus_used);
        const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
        const bonusText = bonusAvailable 
          ? `\n\n🎁 Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> — получишь <b>7 дней Plus</b>!` 
          : '';
        
        const text = `${T('limitReached')}${bonusText}`;
        const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
        
        if (bonusAvailable) {
          extra.reply_markup = { 
            inline_keyboard: [[Markup.button.callback('✅ Проверить подписку', 'check_subscription')]] 
          };
        }
        
        await safeSendMessage(userId, text, extra);
        return;
      }

      // FAST PATH
      if (earlyData.isSingleTrack && earlyData.metadata) {
        const metadata = extractMetadataFromInfo(earlyData.metadata);
        const { webpage_url: fullUrl, id, duration } = metadata;
        const cacheKey = id ? `sc:${id}` : null;
        const expectedDuration = duration ? Math.round(duration) : null;

        const cached = await db.findCachedTrack(url) 
          || await db.findCachedTrack(fullUrl) 
          || (cacheKey && await db.findCachedTrack(cacheKey));
        
        if (cached?.fileId && isCacheValid(cached, expectedDuration)) {
          await bot.telegram.sendAudio(userId, cached.fileId, { 
            title: cached.title, 
            performer: cached.artist,
            duration: cached.duration
          });
          await incrementDownload(userId, cached.title, cached.fileId, url);
          return;
        } else if (cached?.fileId) {
          await invalidateCache(url, cacheKey);
        }

        downloadQueue.add({ 
          userId, 
          url: fullUrl, 
          originalUrl: url, 
          source: 'soundcloud', 
          cacheKey, 
          metadata,
          priority: user.premium_limit || 5 
        });
        await safeSendMessage(userId, `✅ "${metadata.title}" в очереди.`);
        return;
      }

      // SLOW PATH
      const quickCache = await db.findCachedTrack(url);
      if (quickCache?.fileId && (!quickCache.duration || quickCache.duration > 35)) {
        await bot.telegram.sendAudio(userId, quickCache.fileId, { 
          title: quickCache.title, 
          performer: quickCache.artist,
          duration: quickCache.duration
        });
        await incrementDownload(userId, quickCache.title, quickCache.fileId, url);
        return;
      }

      statusMessage = await safeSendMessage(userId, '🔍 Анализирую...');
      
      const info = await ytdl(url, { 
        'dump-single-json': true, 
        'flat-playlist': true,
        'skip-download': true,
        ...YTDL_OPTIONS 
      });
      
      if (statusMessage) {
        await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
        statusMessage = null;
      }

      if (info.entries && info.entries.length > 0) {
        await safeSendMessage(userId, `📂 Плейлист: ${info.entries.length} треков...`);
        
        let added = 0;
        for (const entry of info.entries) {
          const meta = extractMetadataFromInfo(entry);
          if (meta) {
            downloadQueue.add({ 
              userId, 
              url: meta.webpage_url, 
              originalUrl: url, 
              source: 'soundcloud', 
              metadata: meta,
              priority: user.premium_limit || 5 
            });
            added++;
          }
        }
        await safeSendMessage(userId, `✅ Добавлено: ${added} треков.`);
      } else {
        const meta = extractMetadataFromInfo(info);
        if (meta) {
          downloadQueue.add({ 
            userId, 
            url: meta.webpage_url, 
            originalUrl: url, 
            source: 'soundcloud', 
            metadata: meta,
            priority: user.premium_limit || 5 
          });
          await safeSendMessage(userId, `✅ "${meta.title}" в очереди.`);
        } else {
          throw new Error('Не удалось получить данные.');
        }
      }

    } catch (err) {
      console.error(`[Enqueue] Ошибка:`, err.message);
      if (statusMessage) await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
      await safeSendMessage(userId, `❌ Ошибка при чтении ссылки.`);
    }
  })().catch(e => console.error('Enqueue Error:', e));
}

export function initializeDownloadManager() {
  console.log('[DownloadManager] ✅ Готов.');
}
