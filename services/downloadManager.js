// services/downloadManager.js (yt-dlp, /tmp, no-reencode mp3, батч-кэш, sc:<id>)

import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME, PROXY_URL } from '../config.js';
import { Markup } from 'telegraf';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import ytdl from 'yt-dlp-exec';
import ffmpegPath from 'ffmpeg-static';
import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';

// Импортируем db как namespace, чтобы безопасно проверять наличие новых функций
import * as db from '../db.js';

// Настройка путей
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));

// Храним временные файлы в /tmp (на Render это быстрее)
const cacheDir = path.join(os.tmpdir(), 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

// Константы
const YTDL_TIMEOUT = 120; // чуть короче, чтобы быстрее отваливаться при плохой сети
const MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024; // лимит телеграма ~50 MB, оставим запас
const UNLIMITED_PLAYLIST_LIMIT = 100;
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

// Общие опции yt-dlp
const YTDL_COMMON = {
  ffmpegLocation: ffmpegPath || undefined,
  userAgent: FAKE_USER_AGENT,
  proxy: PROXY_URL || undefined,
  retries: 3,
  socketTimeout: YTDL_TIMEOUT,
  noWarnings: true,
  // concurrentFragments: 4, // можно включить для HLS-фрагментов при необходимости
};

function sanitizeFilename(name) {
  return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim();
}

function getCacheKey(meta, fallbackUrl) {
  if (meta?.id) return `sc:${meta.id}`;
  return fallbackUrl || 'unknown';
}

async function safeSendMessage(userId, text, extra = {}) {
  try {
    return await bot.telegram.sendMessage(userId, text, extra);
  } catch (e) {
    if (e.response?.error_code === 403) {
      try { await db.updateUserField(userId, 'active', false); } catch {}
    }
    return null;
  }
}

function canCopyMp3(ext, acodec) {
  if (!ext && !acodec) return false;
  return ext === 'mp3' || /mp3/i.test(acodec || '');
}

async function mapLimit(items, limit, worker) {
  const queue = [...items];
  const running = new Set();
  const results = [];
  while (queue.length || running.size) {
    while (queue.length && running.size < limit) {
      const item = queue.shift();
      const p = Promise.resolve().then(() => worker(item));
      running.add(p);
      p.finally(() => running.delete(p));
      results.push(p);
    }
    if (running.size) await Promise.race(running);
  }
  return Promise.allSettled(results);
}

// Используем новую транзакционную запись, если есть; иначе — старую
async function incrementDownload(userId, trackTitle, fileId, cacheKey) {
  if (typeof db.incrementDownloadsAndLogPg === 'function') {
    return await db.incrementDownloadsAndLogPg(userId, trackTitle, fileId, cacheKey);
  }
  return await db.incrementDownloadsAndSaveTrack(userId, trackTitle, fileId, cacheKey);
}

// Лёгкая выборка пользователя (если доступна), иначе падаем на getUser
async function getUserUsage(userId) {
  if (typeof db.getUserUsage === 'function') {
    return await db.getUserUsage(userId);
  }
  if (typeof db.getUserLite === 'function') {
    return await db.getUserLite(userId);
  }
  return await db.getUser(userId);
}

async function trackDownloadProcessor(task) {
  try {
    const { userId, source, url, originalUrl, metadata, cacheKey } = task;
    const { title, uploader, id: trackId, duration, thumbnail, ext, acodec, filesize } = metadata;
    const roundedDuration = duration ? Math.round(duration) : undefined;

    let tempFilePath = null;
    let statusMessage = null;

    try {
      statusMessage = await safeSendMessage(userId, `⏳ Начинаю скачивание трека: "${title}"`);
      console.log(`[Worker] Получена задача для "${title}" (источник: ${source}).`);

      // Ранний отказ по известному размеру
      if (filesize && filesize > MAX_FILE_SIZE_BYTES) {
        throw new Error('FILE_TOO_LARGE');
      }

      const tempFileName = `${trackId || 'track'}-${crypto.randomUUID()}.mp3`;
      tempFilePath = path.join(cacheDir, tempFileName);

      const ytdlArgs = {
        output: tempFilePath,
        embedThumbnail: true,     // вшивка обложки
        addMetadata: true,        // ID3
        convertThumbnails: true,  // конвертирует webp -> jpg для корректной вшивки
        ...YTDL_COMMON,
      };

      if (canCopyMp3(ext, acodec)) {
        // Уже mp3 — скачиваем как есть и вшиваем обложку без перекодирования (ffmpeg copy)
        await ytdl(url, ytdlArgs);
      } else {
        // Не mp3 — только тут перекодируем
        await ytdl(url, {
          ...ytdlArgs,
          extractAudio: true,
          audioFormat: 'mp3',
        });
      }

      if (!fs.existsSync(tempFilePath)) throw new Error(`Файл не был создан.`);
      const stats = await fs.promises.stat(tempFilePath);
      if (stats.size > MAX_FILE_SIZE_BYTES) throw new Error(`FILE_TOO_LARGE`);

      if (statusMessage) {
        await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, `✅ Скачал. Отправляю...`).catch(() => {});
      }

      const sentToUserMessage = await bot.telegram.sendAudio(
        userId,
        { source: fs.createReadStream(tempFilePath) },
        {
          title,
          performer: uploader || 'Unknown Artist',
          duration: roundedDuration,
        }
      );

      if (statusMessage) {
        await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
      }

      // Логируем и увеличиваем счётчики
      if (sentToUserMessage?.audio?.file_id) {
        await incrementDownload(userId, title, sentToUserMessage.audio.file_id, cacheKey);

        // Кэшируем в канале и в БД
        if (STORAGE_CHANNEL_ID) {
          try {
            const sentToStorage = await bot.telegram.sendAudio(STORAGE_CHANNEL_ID, sentToUserMessage.audio.file_id);
            await db.cacheTrack({
              url: cacheKey,
              fileId: sentToStorage.audio.file_id,
              title,
              artist: uploader,
              duration: roundedDuration,
              thumbnail,
            });
            console.log(`✅ [Cache] Трек "${title}" успешно закэширован.`);
          } catch (e) {
            console.error(`❌ [Cache] Ошибка при кэшировании трека "${title}":`, e.message);
          }
        }
      }
    } catch (err) {
      const errorDetails = err?.stderr || err?.message || String(err);
      let userErrorMessage = `❌ Не удалось обработать трек: "${title}"`;
      if (errorDetails.includes('FILE_TOO_LARGE')) userErrorMessage += '. Он слишком большой.';
      else if (errorDetails.includes('timed out')) userErrorMessage += '. Ошибка сети.';
      console.error(`❌ Ошибка воркера при обработке "${title}":`, errorDetails);
      if (statusMessage) {
        await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, userErrorMessage).catch(() => {});
      } else {
        await safeSendMessage(userId, userErrorMessage);
      }
    } finally {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        fs.promises.unlink(tempFilePath).catch(e => console.error("Ошибка удаления временного файла:", e));
      }
    }
  } catch (e) {
    console.error('🔴 КРИТИЧЕСКАЯ НЕПЕРЕХВАЧЕННАЯ ОШИБКА В ВОРКЕРЕ!', e);
  }
}

// Очередь: maxConcurrent=1 (CPU-экономно на Render free)
export const downloadQueue = new TaskQueue({
  maxConcurrent: 1,
  taskProcessor: trackDownloadProcessor,
});

// no-op для совместимости с index.js (если вызывается initializeDownloadManager(bot))
export function initializeDownloadManager() {
  // зарезервировано для будущих расширений
}

export function enqueue(ctx, userId, url) {
  (async () => {
    let statusMessage = null;
    try {
      // Отключаем Spotify (защита)
      if (url.includes('spotify.com')) return;

      await db.resetDailyLimitIfNeeded(userId);

      // Лёгкая выборка, если есть; иначе полная
      let user = await getUserUsage(userId);

      // Проверка лимита
      if ((user.downloads_today || 0) >= (user.premium_limit || 0)) {
        // Для бонусной кнопки нам нужен subscribed_bonus_used — достанем полный профиль при необходимости
        const fullUser = (user.subscribed_bonus_used === undefined) ? await db.getUser(userId) : user;
        let message = T('limitReached');
        let bonusMessageText = '';
        if (!fullUser.subscribed_bonus_used) {
          const cleanUsername = CHANNEL_USERNAME.replace('@', '');
          const channelLink = `[${CHANNEL_USERNAME}](https://t.me/${cleanUsername})`;
          bonusMessageText = `\n\n🎁 У тебя есть доступный бонус! Подпишись на ${channelLink} и получи *7 дней тарифа Plus*.`;
        }
        message = message.replace('{bonus_message}', bonusMessageText);
        const extra = { parse_mode: 'Markdown' };
        if (!fullUser.subscribed_bonus_used) {
          extra.reply_markup = { inline_keyboard: [[Markup.button.callback('✅ Я подписался, забрать бонус', 'check_subscription')]] };
        }
        await safeSendMessage(userId, message, extra);
        return;
      }

      statusMessage = await safeSendMessage(userId, '🔍 Получаю информацию о треке...');

      // Остаток лимита нужен, чтобы ограничить плейлист прямо в yt-dlp
      const remainingDailyLimit = Math.max(0, (user.premium_limit || 0) - (user.downloads_today || 0));
      const playlistLimit = (user.premium_limit || 0) <= 10 ? 5 : UNLIMITED_PLAYLIST_LIMIT;
      const playlistEnd = Math.max(1, Math.min(remainingDailyLimit || 1, playlistLimit));

      // Получаем метаданные
      const info = await ytdl(url, {
        dumpSingleJson: true,
        playlistEnd, // ограничиваем парсинг плейлиста на стороне yt-dlp
        ...YTDL_COMMON,
      });

      if (!info) throw new Error('Не удалось получить метаданные');

      const isPlaylist = Array.isArray(info.entries);
      const entries = isPlaylist ? info.entries : [info];

      let tracksToProcess = entries
        .filter(e => e && (e.webpage_url || e.url))
        .map(e => {
          // Иногда ext/acodec/файлы на верхнем уровне; fallback — попробуем requested_downloads[0]
          const ext = e.ext || e.requested_downloads?.[0]?.ext || null;
          const acodec = e.acodec || e.requested_downloads?.[0]?.acodec || null;
          const filesize = e.filesize || e.filesize_approx || e.requested_downloads?.[0]?.filesize || null;

          const md = {
            id: e.id,
            title: sanitizeFilename(e.title || 'Unknown Title'),
            uploader: e.uploader || 'Unknown Artist',
            duration: e.duration,
            thumbnail: e.thumbnail,
            ext,
            acodec,
            filesize,
          };
          const realUrl = e.webpage_url || e.url;
          const key = getCacheKey(md, realUrl);
          return {
            url: realUrl,
            originalUrl: realUrl,
            source: 'soundcloud',
            cacheKey: key,
            metadata: md,
          };
        });

      if (tracksToProcess.length === 0) {
        await safeSendMessage(userId, 'Не удалось найти треки для загрузки.');
        return;
      }

      // Если это плейлист, укажем пользователю, сколько максимум будем обрабатывать (без точного общего размера)
      if (isPlaylist && (tracksToProcess.length > playlistEnd)) {
        await safeSendMessage(userId, `ℹ️ С учетом вашего тарифа и дневного лимита будет обработано до ${playlistEnd} трек(ов).`);
        tracksToProcess = tracksToProcess.slice(0, playlistEnd);
      }

      if (statusMessage) {
        await bot.telegram
          .editMessageText(userId, statusMessage.message_id, undefined, '🔄 Проверяю кэш...')
          .catch(() => {});
      }

      // Батч-поиск кэша, если функция доступна
      let cacheMap = new Map();
      const keys = tracksToProcess.map(t => t.cacheKey);
      if (typeof db.findCachedTracks === 'function') {
        cacheMap = await db.findCachedTracks(keys);
      } else {
        // Фоллбек: поштучный поиск
        for (const k of keys) {
          const c = await db.findCachedTrack(k);
          if (c) cacheMap.set(k, c);
        }
      }

      let tasksToDownload = [];
      let cachedToSend = [];

      // Локальный остаток лимита
      user = await getUserUsage(userId); // обновим usage на всякий случай
      let remaining = Math.max(0, (user.premium_limit || 0) - (user.downloads_today || 0));

      for (const track of tracksToProcess) {
        if (remaining <= 0) break;
        const cached = cacheMap.get(track.cacheKey);
        if (cached) {
          cachedToSend.push({ track, cached });
        } else {
          tasksToDownload.push(track);
        }
      }

      let sentFromCacheCount = 0;

      // Отправляем из кэша параллельно (до 3 одновременно)
      await mapLimit(cachedToSend, 3, async ({ track, cached }) => {
        if (remaining <= 0) return;
        try {
          await bot.telegram.sendAudio(
            userId,
            cached.fileId,
            { title: cached.trackName, performer: track.metadata.uploader }
          );
          const ok = await incrementDownload(userId, cached.trackName, cached.fileId, track.cacheKey);
          if (ok !== null) {
            // ok может быть true/объект; для фоллбека null значит не инкрементнули
            remaining -= 1;
            sentFromCacheCount++;
          }
        } catch (err) {
          if (err?.description?.includes('FILE_REFERENCE_EXPIRED')) {
            tasksToDownload.push(track);
          } else {
            console.error(`⚠️ Ошибка отправки из кэша для ${userId}:`, err.message || err);
          }
        }
      });

      let finalMessage = '';
      if (sentFromCacheCount > 0) {
        finalMessage += `✅ ${sentFromCacheCount} трек(ов) отправлено из кэша.\n`;
      }

      // Подготовим к скачиванию с учетом остатка лимита
      if (remaining > 0 && tasksToDownload.length > 0) {
        const tasksToReallyDownload = tasksToDownload.slice(0, remaining);
        finalMessage += `⏳ ${tasksToReallyDownload.length} трек(ов) добавлено в очередь.`;
        // Используем приоритет как premium_limit (как у тебя было)
        const prio = user.premium_limit || 0;
        for (const task of tasksToReallyDownload) {
          downloadQueue.add({ userId, ...task, priority: prio });
        }
      } else if (sentFromCacheCount === 0) {
        finalMessage += `🚫 Ваш дневной лимит исчерпан.`;
      }

      if (statusMessage) {
        await bot.telegram
          .editMessageText(userId, statusMessage.message_id, undefined, finalMessage || "Все треки отправлены.")
          .catch(() => {});
      } else if (finalMessage) {
        await safeSendMessage(userId, finalMessage);
      }
    } catch (err) {
      const errorMessage = err?.stderr || err?.message || String(err);
      let userMessage = `❌ Произошла ошибка при обработке ссылки.`;
      if (errorMessage.includes('timed out')) userMessage = '❌ Ошибка сети при получении информации о треке.';
      else if (errorMessage.includes('404')) userMessage = '❌ Трек по этой ссылке не найден.';
      else console.error(`❌ Глобальная ошибка в enqueue для ${userId}:`, err);
      if (statusMessage) {
        await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, userMessage).catch(() => {});
      } else {
        await safeSendMessage(userId, userMessage);
      }
    }
  })();
}