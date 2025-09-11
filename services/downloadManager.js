// services/downloadManager.js

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));

const cacheDir = path.join(os.tmpdir(), 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

const YTDL_TIMEOUT = 120;
const MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024;
const UNLIMITED_PLAYLIST_LIMIT = 100;
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

// ffmpeg может отсутствовать (например, FFMPEG_STATIC_SKIP_DOWNLOAD=1)
const FFMPEG_AVAILABLE =
  (!!ffmpegPath && fs.existsSync(ffmpegPath)) &&
  process.env.FFMPEG_AVAILABLE !== '0' &&
  process.env.FFMPEG_STATIC_SKIP_DOWNLOAD !== '1';

const YTDL_COMMON = {
  'ffmpeg-location': ffmpegPath || undefined,
  'user-agent': FAKE_USER_AGENT,
  proxy: PROXY_URL || undefined,
  retries: 3,
  'socket-timeout': YTDL_TIMEOUT,
  'no-warnings': true
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
    duration: e.duration,
    thumbnail: e.thumbnail,
    ext, acodec, filesize
  };
}

async function ensureTaskMetadata(task) {
  let { metadata, cacheKey } = task;
  const url = task.url || task.originalUrl;

  if (!metadata) {
    if (!url) throw new Error('TASK_MISSING_URL');
    console.warn('[Worker] metadata отсутствует, тяну метаданные через youtube-dl-exec для URL:', url);
    const info = await ytdl(url, { 'dump-single-json': true, ...YTDL_COMMON });
    const md = extractMetadataFromInfo(info);
    if (!md) throw new Error('META_MISSING');
    metadata = md;
  }

  // ВСЕГДА проставляем cacheKey, даже если metadata уже была
  if (!cacheKey) {
    cacheKey = getCacheKey(metadata, task.originalUrl || url);
  }

  return { metadata, cacheKey, source: task.source || 'soundcloud', url };
}

export async function trackDownloadProcessor(task) {
  try {
    const { userId } = task;
    let tempFilePath = null;
    let statusMessage = null;

    try {
      const ensured = await ensureTaskMetadata(task);
      const { metadata, cacheKey, source, url: ensuredUrl } = ensured;

      // Сначала получаем поля и округляем длительность
      const { title, uploader, id: trackId, duration, thumbnail, ext, acodec, filesize } = metadata;
      const roundedDuration = duration ? Math.round(duration) : undefined;

      // ===================================================================
      //              ВСТАВЛЕННЫЙ БЛОК: ранний чек кэша
      // ===================================================================
      try {
        const primaryKey = cacheKey; // Новый ключ, sc:<id>
        const legacyKey = task.originalUrl || ensuredUrl; // Старый ключ по URL
        let cached = await db.findCachedTrack(primaryKey);
        if (!cached && legacyKey) {
          cached = await db.findCachedTrack(legacyKey);
        }
        if (!cached) {
          // Попытка найти по метаданным для самых старых записей с CDN-URL
          if (typeof db.findCachedTrackByMeta === 'function') {
            cached = await db.findCachedTrackByMeta({ title, artist: uploader, duration: roundedDuration });
          }
        }
        
        // Если что-то нашли любым из трех способов
        if (cached?.fileId) {
          console.log(`[Worker/Cache] ХИТ! Отправляю "${cached.trackName || title}" из кэша.`);
          await bot.telegram.sendAudio(
            userId,
            cached.fileId,
            {
              title: cached.trackName || title,
              performer: uploader || 'Unknown Artist',
              duration: roundedDuration
            }
          );
          // Записываем скачивание в лог и обновляем счетчики
          await incrementDownload(userId, cached.trackName || title, cached.fileId, primaryKey);
          return; // Нашли в кэше — выходим, не скачивая
        }
      } catch (e) {
        console.error('[Worker] Ошибка раннего чека кэша:', e.message);
        // Не страшно, просто продолжаем и пытаемся скачать
      }
      // ===================================================================

      statusMessage = await safeSendMessage(userId, `⏳ Начинаю скачивание трека: "${title}"`);
      console.log(`[Worker] Получена задача для "${title}" (источник: ${source}).`);

      if (filesize && filesize > MAX_FILE_SIZE_BYTES) throw new Error('FILE_TOO_LARGE');

      let ytdlArgs;
      if (FFMPEG_AVAILABLE) {
        const tempFileName = `${trackId || 'track'}-${crypto.randomUUID()}.mp3`;
        tempFilePath = path.join(cacheDir, tempFileName);

        if (canCopyMp3(ext, acodec)) {
          ytdlArgs = {
            output: tempFilePath,
            'embed-thumbnail': true,
            'add-metadata': true,
            ...YTDL_COMMON
          };
        } else {
          ytdlArgs = {
            output: tempFilePath,
            'extract-audio': true,
            'audio-format': 'mp3',
            'embed-thumbnail': true,
            'add-metadata': true,
            ...YTDL_COMMON
          };
        }

        await ytdl(ensuredUrl, ytdlArgs);
      } else {
        const baseName = `${trackId || 'track'}-${crypto.randomUUID()}`;
        const outputTemplate = path.join(cacheDir, `${baseName}.%(ext)s`);
        ytdlArgs = { output: outputTemplate, ...YTDL_COMMON };
        await ytdl(ensuredUrl, ytdlArgs);

        // Ищем реальный файл по baseName
        const files = await fs.promises.readdir(cacheDir);
        const found = files.find(f => f.startsWith(`${baseName}.`));
        if (!found) throw new Error('Файл не был создан.');
        tempFilePath = path.join(cacheDir, found);
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
          duration: roundedDuration
        }
      );

      if (statusMessage) {
        await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
      }

      if (sentToUserMessage?.audio?.file_id) {
        await incrementDownload(userId, title, sentToUserMessage.audio.file_id, cacheKey);

        if (STORAGE_CHANNEL_ID) {
          try {
            const sentToStorage = await bot.telegram.sendAudio(STORAGE_CHANNEL_ID, sentToUserMessage.audio.file_id);
            const normalizedKey = cacheKey || getCacheKey(metadata, ensuredUrl);
            await db.cacheTrack({
              url: normalizedKey,
              fileId: sentToStorage.audio.file_id,
              title,
              artist: uploader,
              duration: roundedDuration,
              thumbnail
            });
            console.log(`✅ [Cache] Трек "${title}" успешно закэширован.`);
          } catch (e) {
            console.error(`❌ [Cache] Ошибка при кэшировании трека "${title}":`, e.message);
          }
        }
      }
    } catch (err) {
      const errorDetails = err?.stderr || err?.message || String(err);
      let userErrorMessage = '❌ Не удалось обработать трек.';
      if (errorDetails.includes('TASK_MISSING_URL')) {
        userErrorMessage = '❌ Внутренняя ошибка постановки задачи (нет URL). Попробуйте ещё раз.';
        console.error('[Worker] Задача без URL. Источник задачи формирует некорректный payload:', task);
      } else if (errorDetails.includes('META_MISSING')) {
        userErrorMessage = '❌ Не удалось получить информацию о треке.';
      } else if (errorDetails.includes('FILE_TOO_LARGE')) {
        userErrorMessage = '❌ Файл слишком большой.';
      } else if (errorDetails.includes('timed out')) {
        userErrorMessage = '❌ Ошибка сети при обработке трека.';
      }
      console.error('❌ Ошибка воркера:', errorDetails);
      if (statusMessage) await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, userErrorMessage).catch(() => {});
      else await safeSendMessage(userId, userErrorMessage);
    } finally {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        fs.promises.unlink(tempFilePath).catch(e => console.error('Ошибка удаления временного файла:', e));
      }
    }
  } catch (e) {
    console.error('🔴 КРИТИЧЕСКАЯ НЕПЕРЕХВАЧЕННАЯ ОШИБКА В ВОРКЕРЕ!', e);
  }
}

export const downloadQueue = new TaskQueue({
  maxConcurrent: 1,
  taskProcessor: trackDownloadProcessor
});

export function initializeDownloadManager() {}

export function enqueue(ctx, userId, url) {
  (async () => {
    let statusMessage = null;
    try {
      if (url.includes('spotify.com')) return;
      await db.resetDailyLimitIfNeeded(userId);

      // --- РАННИЙ ЧЕК ЛИМИТА (до любого ytdl) ---
      const fullUser = (typeof db.getUser === 'function') ? await db.getUser(userId) : await getUserUsage(userId);
      const downloadsToday = Number(fullUser?.downloads_today || 0);
      const dailyLimit = Number(fullUser?.premium_limit || 0);

      if (downloadsToday >= dailyLimit) {
        const bonusAvailable = !!(CHANNEL_USERNAME && !fullUser?.subscribed_bonus_used);
        const cleanUsername = CHANNEL_USERNAME?.replace('@', '');

        const bonusPart = bonusAvailable
          ? `🎁 У тебя есть доступный бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.\n\n`
          : '';

        let message = T('limitReached') || '🚫 Дневной лимит загрузок исчерпан.\n\n{bonus_message}💡 Чтобы скачивать больше, перейди на платный тариф.';
        if (message.includes('{bonus_message}')) {
          message = message.replace('{bonus_message}', bonusPart);
        } else {
          message = bonusPart ? `${message}\n\n${bonusPart}` : message;
        }

        const extra = { 
          parse_mode: 'HTML', 
          disable_web_page_preview: true 
        };
        if (bonusAvailable) {
          extra.reply_markup = { 
            inline_keyboard: [[ Markup.button.callback('✅ Я подписался, забрать бонус', 'check_subscription') ]] 
          };
        }

        await safeSendMessage(userId, message, extra);
        return; // важно — выходим до анализа ссылки
      }

      statusMessage = await safeSendMessage(userId, '🔍 Получаю информацию о треке...');

      const remainingDailyLimit = Math.max(0, dailyLimit - downloadsToday);
      const playlistLimit = dailyLimit <= 10 ? 5 : UNLIMITED_PLAYLIST_LIMIT;
      const playlistEnd = Math.max(1, Math.min(remainingDailyLimit || 1, playlistLimit));

      const info = await ytdl(url, {
        'dump-single-json': true,
        'playlist-end': playlistEnd,
        ...YTDL_COMMON
      });
      if (!info) throw new Error('Не удалось получить метаданные');

      const isPlaylist = Array.isArray(info.entries);
      const entries = isPlaylist ? info.entries : [info];

      let tracksToProcess = entries
        .filter(e => e && (e.webpage_url || e.url))
        .map(e => {
          const ext = e.ext || e.requested_downloads?.[0]?.ext || null;
          const acodec = e.acodec || e.requested_downloads?.[0]?.acodec || null;
          const filesize = e.filesize || e.filesize_approx || e.requested_downloads?.[0]?.filesize || null;

          const md = {
            id: e.id,
            title: sanitizeFilename(e.title || 'Unknown Title'),
            uploader: e.uploader || 'Unknown Artist',
            duration: e.duration,
            thumbnail: e.thumbnail,
            ext, acodec, filesize
          };
          const realUrl = e.webpage_url || e.url;
          const key = getCacheKey(md, realUrl);
          return { url: realUrl, originalUrl: realUrl, source: 'soundcloud', cacheKey: key, metadata: md };
        });

      if (tracksToProcess.length === 0) {
        if (statusMessage) {
          await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, 'Не удалось найти треки для загрузки.').catch(() => {});
        } else {
          await safeSendMessage(userId, 'Не удалось найти треки для загрузки.');
        }
        return;
      }

      if (isPlaylist && (tracksToProcess.length > playlistEnd)) {
        await safeSendMessage(userId, `ℹ️ С учетом вашего тарифа и дневного лимита будет обработано до ${playlistEnd} трек(ов).`);
        tracksToProcess = tracksToProcess.slice(0, playlistEnd);
      }

      if (statusMessage) {
        await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, '🔄 Проверяю кэш...').catch(() => {});
      }

      // Собираем пары ключей: новый sc:<id> и старый (legacy) — по URL
      const keyPairs = tracksToProcess.map(t => ({
        primary: t.cacheKey,
        legacy: t.originalUrl || t.url
      }));
      const uniqueKeys = Array.from(new Set(
        keyPairs.flatMap(k => [k.primary, k.legacy].filter(Boolean))
      ));

      let cacheMap = new Map();
      if (typeof db.findCachedTracks === 'function') {
        cacheMap = await db.findCachedTracks(uniqueKeys);
      } else {
        for (const k of uniqueKeys) {
          const c = await db.findCachedTrack(k);
          if (c) cacheMap.set(k, c);
        }
      }

      const usage = await getUserUsage(userId);
      let remaining = Math.max(0, (usage.premium_limit || 0) - (usage.downloads_today || 0));

      const tasksToDownload = [];
      const cachedToSend = [];
      for (const track of tracksToProcess) {
        if (remaining <= 0) break;
        const primary = track.cacheKey;
        const legacy = track.originalUrl || track.url;
        const cached = cacheMap.get(primary) || (legacy ? cacheMap.get(legacy) : undefined);
        if (cached) cachedToSend.push({ track, cached });
        else tasksToDownload.push(track);
      }

      let sentFromCacheCount = 0;

      await mapLimit(cachedToSend, 3, async ({ track, cached }) => {
        if (remaining <= 0) return;
        try {
          await bot.telegram.sendAudio(
            userId,
            cached.fileId,
            { title: cached.trackName || cached.title || track.metadata.title, performer: track.metadata.uploader }
          );
          const ok = await incrementDownload(userId, cached.trackName || cached.title || track.metadata.title, cached.fileId, track.cacheKey);
          if (ok !== null) {
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
      if (sentFromCacheCount > 0) finalMessage += `✅ ${sentFromCacheCount} трек(ов) отправлено из кэша.\n`;

      if (remaining > 0 && tasksToDownload.length > 0) {
        const tasksToReallyDownload = tasksToDownload.slice(0, remaining);
        finalMessage += `⏳ ${tasksToReallyDownload.length} трек(ов) добавлено в очередь.`;
        const prio = usage.premium_limit || 0;
        for (const task of tasksToReallyDownload) {
          console.log('[Queue] Добавляю задачу', {
            userId,
            prio,
            url: task.url,
            hasMeta: !!task.metadata,
            cacheKey: task.cacheKey
          });
          downloadQueue.add({ userId, ...task, priority: prio });
        }
      } else if (sentFromCacheCount === 0) {
        finalMessage += `🚫 Ваш дневной лимит исчерпан.`;
      }

      if (statusMessage) {
        await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, finalMessage || "Все треки отправлены.").catch(() => {});
      } else if (finalMessage) {
        await safeSendMessage(userId, finalMessage);
      }
    } catch (err) {
      const errorMessage = err?.stderr || err?.message || String(err);
      let userMessage = `❌ Произошла ошибка при обработке ссылки.`;
      if (errorMessage.includes('timed out')) userMessage = '❌ Ошибка сети при получении информации о треке.';
      else if (errorMessage.includes('404')) userMessage = '❌ Трек по этой ссылке не найден.';
      else console.error(`❌ Глобальная ошибка в enqueue для ${userId}:`, err);
      if (statusMessage) await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, userMessage).catch(() => {});
      else await safeSendMessage(userId, userMessage);
    }
  })();
}