// =====================================================================================
//      СКОПИРУЙТЕ ВЕСЬ ЭТОТ КОД И ПОЛНОСТЬЮ ЗАМЕНИТЕ ИМ СОДЕРЖИМОЕ
//                       ФАЙЛА services/downloadManager.js
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

// Папка для временных файлов (нужна для yt-dlp fallback)
const TEMP_DIR = path.join(os.tmpdir(), 'sc-cache');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 2;

// Настройки для yt-dlp
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

async function safeSendMessage(userId, text, extra = {}) {
  try {
    return await bot.telegram.sendMessage(userId, text, extra);
  } catch (e) {
    // Если юзер заблокировал бота (403)
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

// Преобразует данные от ytdl/scdl в наш формат
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

// Гарантирует наличие метаданных (если их нет, качает через ytdl)
async function ensureTaskMetadata(task) {
  let { metadata, cacheKey } = task;
  const url = task.url || task.originalUrl;
  
  if (!metadata) {
    if (!url) throw new Error('TASK_MISSING_URL');
    console.warn('[Worker] metadata отсутствует, получаю через ytdl для URL:', url);
    // Добавляем ignore-errors, чтобы не падать на playlist entries
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
    
    if (!fullUrl) throw new Error(`Нет ссылки на трек: ${title}`);

    // 3. КЭШ
    let cached = await db.findCachedTrack(cacheKey) || await db.findCachedTrack(fullUrl);
    if (cached?.fileId) {
      console.log(`[Worker/Cache] ХИТ! Отправляю "${cached.title}" из кэша.`);
      await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.title, performer: cached.artist || uploader, duration: roundedDuration });
      await incrementDownload(userId, cached.title, cached.fileId, cacheKey);
      return;
    }

    statusMessage = await safeSendMessage(userId, `⏳ Начинаю обработку: "${title}"`);
    
    let stream;
    let usedFallback = false;
    let finalFileId = null;

    // ========================================================
    // 4. СКАЧИВАНИЕ (SCDL STREAM - БЫСТРО)
    // ========================================================
    try {
        console.log(`[Worker/Stream] (SCDL) Пробую скачать: ${fullUrl}`);
        stream = await scdl.default.download(fullUrl);
        
        // === ГЛАВНОЕ ИЗМЕНЕНИЕ ЗДЕСЬ ===
        if (STORAGE_CHANNEL_ID) {
            console.log(`[Worker/Stream] Отправка в хранилище для проверки...`);
            const sentMsg = await bot.telegram.sendAudio(
                STORAGE_CHANNEL_ID,
                { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
                { title, performer: uploader, duration: roundedDuration }
            );
            
            // ПРОВЕРКА ОБРУБКА СРЕДСТВАМИ ТЕЛЕГРАМА
            const realDuration = sentMsg.audio?.duration || 0;
            
            // Если трек должен быть длинным (>60 сек), а пришло меньше 35 сек
            if (roundedDuration > 60 && realDuration < 35) {
                console.warn(`[Worker] ОБРУБОК DETECTED! Ожидали ${roundedDuration}s, получили ${realDuration}s.`);
                // Удаляем плохой файл из канала
                await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentMsg.message_id).catch(()=>{});
                throw new Error('SCDL_INCOMPLETE_FILE'); // Вызываем ошибку, чтобы сработал YT-DLP
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
            // Создаем стрим из файла
            stream = fs.createReadStream(tempFilePath);
        } else {
            throw new Error(`YT-DLP не смог скачать файл.`);
        }
    }

    // ========================================================
    // 5. ОТПРАВКА ПОЛЬЗОВАТЕЛЮ
    // ========================================================
    
    if (finalFileId) {
        // Если уже залили в канал (успешный SCDL)
        const urlAliases = [];
        if (task.originalUrl && task.originalUrl !== fullUrl) urlAliases.push(task.originalUrl);
        if (cacheKey) urlAliases.push(cacheKey);
        
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

    } else {
        // Если сработал YT-DLP или нет канала-хранилища
        // Заливаем пользователю (или в канал, если YT-DLP)
        
        if (STORAGE_CHANNEL_ID && usedFallback) {
             // Если это был YT-DLP, зальем в канал, чтобы закэшировать нормальную версию
             const sentToStorage = await bot.telegram.sendAudio(
                STORAGE_CHANNEL_ID, 
                { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
                { title, performer: uploader, duration: roundedDuration }
             );
             finalFileId = sentToStorage?.audio?.file_id;
             
             // Кэшируем "хорошую" версию
             if (finalFileId) {
                 await db.cacheTrack({ url: fullUrl, fileId: finalFileId, title, artist: uploader, duration: roundedDuration, thumbnail: metadata.thumbnail });
             }
             
             // И пользователю
             await bot.telegram.sendAudio(userId, finalFileId || { source: fs.createReadStream(tempFilePath) }, { title, performer: uploader, duration: roundedDuration });
             
        } else {
             // Прямая отправка (крайний случай)
             await bot.telegram.sendAudio(userId, { source: stream, filename: `${sanitizeFilename(title)}.mp3` }, { title, performer: uploader, duration: roundedDuration });
        }
        
        await incrementDownload(userId, title, finalFileId, task.originalUrl || fullUrl);
    }

  } catch (err) {
    console.error(`❌ Ошибка (User ${userId}):`, err.message);
    await safeSendMessage(userId, `❌ Не удалось скачать трек. Возможно, он удален или недоступен.`);
  } finally {
    if (statusMessage) try { await bot.telegram.deleteMessage(userId, statusMessage.message_id); } catch (e) {}
    if (tempFilePath && fs.existsSync(tempFilePath)) try { fs.unlinkSync(tempFilePath); } catch (e) {}
  }
}
// Создаем экземпляр очереди, передавая ей функцию-процессор
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
        const { webpage_url: fullUrl, id } = metadata;
        const cacheKey = id ? `sc:${id}` : null;

        // Проверка кэша
        const cached = await db.findCachedTrack(url) || await db.findCachedTrack(fullUrl) || (cacheKey && await db.findCachedTrack(cacheKey));
        if (cached?.fileId) {
          console.log(`[Enqueue/Fast] ХИТ КЭША!`);
          await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.title, performer: cached.artist });
          await incrementDownload(userId, cached.title, cached.fileId, url);
          return;
        }

        // Добавляем в очередь
        const task = { userId, url: fullUrl, originalUrl: url, source: 'soundcloud', cacheKey, metadata };
        downloadQueue.add({ ...task, priority: user.premium_limit || 5 });
        await safeSendMessage(userId, `✅ Трек "${metadata.title}" добавлен в очередь.`);
        return;
      }

      // 2. SLOW PATH (Если просто кинули ссылку)
      // Сначала проверим кэш по URL, чтобы не делать лишних запросов
      const quickCache = await db.findCachedTrack(url);
      if (quickCache?.fileId) {
          console.log(`[Enqueue/Slow] ХИТ КЭША по URL!`);
          await bot.telegram.sendAudio(userId, quickCache.fileId, { title: quickCache.title, performer: quickCache.artist });
          await incrementDownload(userId, quickCache.title, quickCache.fileId, url);
          return;
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
