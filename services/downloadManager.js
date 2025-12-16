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

// Базовые опции для получения метаданных/скачиваний через yt-dlp
const YTDL_OPTIONS = {
  ...YTDL_COMMON,
  'no-playlist': true,
  'ignore-errors': true
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
  let tempFilePath = null; // Путь к файлу, если придется качать через yt-dlp
  const userId = parseInt(task.userId, 10);
  
  try {
    // 1. Проверка лимитов
    const usage = await getUserUsage(userId);
    if (!usage || usage.downloads_today >= usage.premium_limit) {
      await safeSendMessage(userId, T('limitReached'));
      return;
    }

    // 2. Получение метаданных
    const ensured = await ensureTaskMetadata(task);
    const { metadata, cacheKey } = ensured;
    const { title, uploader, duration, webpage_url: fullUrl } = metadata;
    const roundedDuration = duration ? Math.round(duration) : undefined;
    
    if (!fullUrl) throw new Error(`Нет ссылки на трек: ${title}`);

    // 3. Проверка КЭША (вдруг уже скачали, пока задача лежала в очереди)
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

    // 4. СКАЧИВАНИЕ
    // Попытка 1: SCDL (быстро, в оперативную память)
    try {
        console.log(`[Worker/Stream] (SCDL) Пробую скачать: ${fullUrl}`);
        stream = await scdl.default.download(fullUrl);
    } catch (scdlError) {
        // Попытка 2: Fallback YT-DLP (медленнее, через файл, но надежнее для 404/Geo)
        console.warn(`[Worker] SCDL ошибка (${scdlError.message}). Переключаюсь на YT-DLP...`);
        
        tempFilePath = path.join(TEMP_DIR, `dl_${Date.now()}_${userId}.mp3`);
        usedFallback = true;

        await ytdl(fullUrl, {
            output: tempFilePath,
            format: 'bestaudio[ext=mp3]/bestaudio',
            noPlaylist: true,
            ...YTDL_COMMON
        });

        if (fs.existsSync(tempFilePath)) {
            console.log(`[Worker/Fallback] Файл скачан: ${tempFilePath}`);
            stream = fs.createReadStream(tempFilePath);
        } else {
            throw new Error(`Не удалось скачать трек. Ошибка SCDL: ${scdlError.message}`);
        }
    }

    // 5. ОТПРАВКА В TELEGRAM
    let finalFileId = null;

    // А) В канал-хранилище (если настроен)
    if (STORAGE_CHANNEL_ID) {
      try {
        console.log(`[Worker/Stream] Отправка в хранилище...`);
        const sentToStorage = await bot.telegram.sendAudio(
          STORAGE_CHANNEL_ID,
          { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
          { title, performer: uploader, duration: roundedDuration }
        );
        finalFileId = sentToStorage?.audio?.file_id;
      } catch (e) {
        console.error(`❌ Ошибка отправки в хранилище:`, e.message);
        // Если использовали fallback (файл), можно пересоздать стрим
        if (usedFallback && fs.existsSync(tempFilePath)) {
            stream = fs.createReadStream(tempFilePath); 
        }
        // Если scdl, стрим умер, но код пойдет ниже в блок "else" и попробует отправить что есть или упадет
      }
    }

    // Б) Если получили file_id -> Сохраняем в БД и отправляем юзеру
    if (finalFileId) {
        const urlAliases = [];
        if (task.originalUrl && task.originalUrl !== fullUrl) urlAliases.push(task.originalUrl);
        if (cacheKey && !cacheKey.startsWith('http')) urlAliases.push(cacheKey);
        
        await db.cacheTrack({ 
            url: fullUrl, 
            fileId: finalFileId, 
            title, 
            artist: uploader, 
            duration: roundedDuration, 
            thumbnail: metadata.thumbnail, 
            aliases: urlAliases 
        });
        
        console.log(`✅ [Cache] Трек "${title}" сохранён.`);
        await bot.telegram.sendAudio(userId, finalFileId, { title, performer: uploader, duration: roundedDuration });
        await incrementDownload(userId, title, finalFileId, task.originalUrl || fullUrl);

    } else {
      // В) Если хранилище недоступно -> Отправляем файл напрямую юзеру
      console.warn('[Worker] Отправляю напрямую пользователю (без кэша)...');
      
      // Перестраховка для стрима
      if (usedFallback && fs.existsSync(tempFilePath)) {
          stream = fs.createReadStream(tempFilePath);
      } else if (!usedFallback && (!stream || stream.destroyed)) {
           // Если scdl стрим сдох, пробуем еще раз scdl (шанс мал, но все же)
           try { stream = await scdl.default.download(fullUrl); } catch(e) { throw new Error('Повторное скачивание failed'); }
      }

      await bot.telegram.sendAudio(
        userId, 
        { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
        { title, performer: uploader, duration: roundedDuration }
      );
    }

  } catch (err) {
    const errorDetails = err?.stderr || err?.message || 'Unknown error';
    console.error(`❌ Ошибка воркера (User ${userId}):`, errorDetails);
    
    let userMsg = `❌ Не удалось обработать трек`;
    if (task.metadata?.title) userMsg += `: "${task.metadata.title}"`;
    
    if (errorDetails.includes('404') || errorDetails.includes('Video unavailable')) {
         userMsg += "\n(Трек удален или приватный)";
    }

    await safeSendMessage(userId, userMsg);

  } finally {
    // 6. ОЧИСТКА
    // Удаляем сообщение "Начинаю обработку" ВСЕГДА
    if (statusMessage) {
      try {
        await bot.telegram.deleteMessage(userId, statusMessage.message_id);
      } catch (e) {}
    }
    
    // Удаляем временный файл
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        console.log(`[Worker] Временный файл удален.`);
      } catch (e) { console.error('Ошибка удаления tmp файла:', e); }
    }
  }
}

// =====================================================================================
//                                 ОЧЕРЕДЬ ЗАГРУЗОК
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
