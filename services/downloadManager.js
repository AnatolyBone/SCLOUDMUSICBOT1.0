// =====================================================================================
//      ОБНОВЛЁННАЯ ВЕРСИЯ С ПРОВЕРКОЙ ПРЕВЬЮ В КЭШЕ
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

const YTDL_COMMON = {
  'format': 'bestaudio[ext=mp3]/bestaudio[ext=opus]/bestaudio',
  'ffmpeg-location': ffmpegPath,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
  proxy: PROXY_URL,
  retries: 3,
  'socket-timeout': 120,
  'no-warnings': true,
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
 */
function isCacheValid(cached, expectedDuration) {
  if (!cached) return false;
  if (!cached.duration || !expectedDuration) return true;
  
  // Превью обычно 30 секунд
  if (expectedDuration > 60 && cached.duration < 35) {
    console.warn(`[Cache] ПРЕВЬЮ обнаружено! cached=${cached.duration}s, expected=${expectedDuration}s`);
    return false;
  }
  
  // Если меньше 50% от ожидаемой длительности
  if (cached.duration < expectedDuration * 0.5) {
    console.warn(`[Cache] Подозрительно короткий: ${cached.duration}s vs ${expectedDuration}s`);
    return false;
  }
  
  return true;
}

/**
 * Удаляет невалидный кэш
 */
async function invalidateCache(url, cacheKey) {
  try {
    if (url) await db.deleteCachedTrack?.(url);
    if (cacheKey && cacheKey !== url) await db.deleteCachedTrack?.(cacheKey);
    console.log(`[Cache] Инвалидирован: ${url}`);
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
    
    console.log(`[Worker] Обработка: "${title}" (ожидаемая длительность: ${roundedDuration}s)`);
    
    if (!fullUrl) throw new Error(`Нет ссылки на трек: ${title}`);

    // 3. КЭШ С ПРОВЕРКОЙ НА ПРЕВЬЮ
    let cached = await db.findCachedTrack(cacheKey) || await db.findCachedTrack(fullUrl);
    
    if (cached?.fileId) {
      if (isCacheValid(cached, roundedDuration)) {
        console.log(`[Worker/Cache] ХИТ! Отправляю "${cached.title}" из кэша.`);
        await bot.telegram.sendAudio(userId, cached.fileId, { 
          title: cached.title, 
          performer: cached.artist || uploader, 
          duration: cached.duration || roundedDuration 
        });
        await incrementDownload(userId, cached.title, cached.fileId, cacheKey);
        return;
      } else {
        console.warn(`[Worker/Cache] В кэше превью! Удаляю и качаю заново...`);
        await invalidateCache(fullUrl, cacheKey);
        cached = null;
      }
    }

    statusMessage = await safeSendMessage(userId, `⏳ Скачиваю: "${title}"`);
    
    let stream;
    let usedFallback = false;
    let finalFileId = null;

    // ========================================================
    // 4. СКАЧИВАНИЕ
    // ========================================================
    try {
        console.log(`[Worker/Stream] (SCDL) Пробую скачать: ${fullUrl}`);
        stream = await scdl.default.download(fullUrl);
        
        if (STORAGE_CHANNEL_ID) {
            console.log(`[Worker/Stream] Отправка в хранилище...`);
            const sentMsg = await bot.telegram.sendAudio(
                STORAGE_CHANNEL_ID,
                { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
                { title, performer: uploader, duration: roundedDuration }
            );
            
            const realDuration = sentMsg.audio?.duration || 0;
            console.log(`[Worker] Проверка: получено ${realDuration}s, ожидалось ${roundedDuration}s`);
            
            // ПРОВЕРКА НА ПРЕВЬЮ
            if (roundedDuration > 60 && realDuration < 35) {
                console.warn(`[Worker] ПРЕВЬЮ DETECTED! ${realDuration}s вместо ${roundedDuration}s`);
                await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentMsg.message_id).catch(()=>{});
                throw new Error('SCDL_INCOMPLETE_FILE');
            }
            
            // Дополнительная проверка - если меньше 50% от ожидаемой
            if (roundedDuration && realDuration < roundedDuration * 0.5) {
                console.warn(`[Worker] Подозрительно короткий файл! ${realDuration}s vs ${roundedDuration}s`);
                await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentMsg.message_id).catch(()=>{});
                throw new Error('SCDL_INCOMPLETE_FILE');
            }
            
            finalFileId = sentMsg.audio?.file_id;
        }
        
    } catch (scdlError) {
        console.warn(`[Worker] Переключаюсь на YT-DLP (Причина: ${scdlError.message})...`);
        
        tempFilePath = path.join(TEMP_DIR, `dl_${Date.now()}_${userId}.mp3`);
        usedFallback = true;

        await ytdl(fullUrl, {
            output: tempFilePath,
            format: 'bestaudio[ext=mp3]/bestaudio',
            noPlaylist: true,
            ...YTDL_COMMON
        });

        if (fs.existsSync(tempFilePath)) {
            console.log(`[Worker/Fallback] YT-DLP скачал файл`);
            stream = fs.createReadStream(tempFilePath);
        } else {
            throw new Error(`YT-DLP не смог скачать файл.`);
        }
    }

    // ========================================================
    // 5. ОТПРАВКА И КЭШИРОВАНИЕ
    // ========================================================
    
    if (finalFileId) {
        // SCDL успешно скачал полную версию
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
                { title, performer: uploader, duration: roundedDuration }
             );
             
             const realDuration = sentToStorage.audio?.duration || 0;
             finalFileId = sentToStorage?.audio?.file_id;
             
             // Проверяем и YT-DLP результат!
             if (roundedDuration > 60 && realDuration < 35) {
                 console.error(`[Worker] YT-DLP тоже скачал превью! Трек недоступен.`);
                 await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentToStorage.message_id).catch(()=>{});
                 throw new Error('TRACK_PREVIEW_ONLY');
             }
             
             // Кэшируем хорошую версию
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
             await bot.telegram.sendAudio(userId, { source: stream, filename: `${sanitizeFilename(title)}.mp3` }, { title, performer: uploader, duration: roundedDuration });
        }
        
        await incrementDownload(userId, title, finalFileId, task.originalUrl || fullUrl);
    }

  } catch (err) {
    console.error(`❌ Ошибка (User ${userId}):`, err.message);
    
    // Специальное сообщение для превью
    if (err.message === 'TRACK_PREVIEW_ONLY' || err.message === 'SCDL_INCOMPLETE_FILE') {
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

      // 1. FAST PATH
      if (earlyData.isSingleTrack && earlyData.metadata) {
        console.log('[Enqueue/Fast] Метаданные получены заранее.');
        const metadata = extractMetadataFromInfo(earlyData.metadata);
        const { webpage_url: fullUrl, id, duration } = metadata;
        const cacheKey = id ? `sc:${id}` : null;
        const expectedDuration = duration ? Math.round(duration) : null;

        // Проверка кэша С ВАЛИДАЦИЕЙ
        const cached = await db.findCachedTrack(url) || await db.findCachedTrack(fullUrl) || (cacheKey && await db.findCachedTrack(cacheKey));
        
        if (cached?.fileId) {
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
          }
        }

        const task = { userId, url: fullUrl, originalUrl: url, source: 'soundcloud', cacheKey, metadata };
        downloadQueue.add({ ...task, priority: user.premium_limit || 5 });
        await safeSendMessage(userId, `✅ Трек "${metadata.title}" добавлен в очередь.`);
        return;
      }

      // 2. SLOW PATH
      const quickCache = await db.findCachedTrack(url);
      if (quickCache?.fileId) {
          // Для slow path у нас нет expectedDuration, поэтому просто проверяем на очень короткие
          if (!quickCache.duration || quickCache.duration > 35) {
            console.log(`[Enqueue/Slow] ХИТ КЭША по URL!`);
            await bot.telegram.sendAudio(userId, quickCache.fileId, { title: quickCache.title, performer: quickCache.artist });
            await incrementDownload(userId, quickCache.title, quickCache.fileId, url);
            return;
          } else {
            console.warn(`[Enqueue/Slow] Кэш слишком короткий (${quickCache.duration}s), качаем заново`);
            await invalidateCache(url, null);
          }
      }

      statusMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');
      
      const info = await ytdl(url, { 'dump-single-json': true, 'flat-playlist': true, ...YTDL_COMMON });
      
      if (statusMessage) {
        await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
      }

      if (info.entries && info.entries.length > 0) {
          await safeSendMessage(userId, `📂 Найден плейлист: "${info.title || 'Playlist'}".\nДобавляю ${info.entries.length} треков...`);
          
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
