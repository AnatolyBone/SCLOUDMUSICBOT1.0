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

const YTDL_COMMON = {
  'ffmpeg-location': ffmpegPath || undefined,
  'user-agent': FAKE_USER_AGENT,
  proxy: PROXY_URL || undefined,
  retries: 3,
  'socket-timeout': YTDL_TIMEOUT,
  'no-warnings': true
};

// ========================= HELPER FUNCTIONS =========================

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

function canCopyMp3(ext, acodec) {
  if (!ext && !acodec) return false;
  return ext === 'mp3' || /mp3/i.test(acodec || '');
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
  return { id: e.id, title: sanitizeFilename(e.title || 'Unknown Title'), uploader: e.uploader || 'Unknown Artist', duration: e.duration, thumbnail: e.thumbnail, ext, acodec, filesize };
}

function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase();
    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254'];
    if (blockedHosts.includes(hostname)) return false;
    if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(hostname)) return false;
    return true;
  } catch { return false; }
}

async function getFileSizeFromHead(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', timeout: 5000, headers: { 'User-Agent': FAKE_USER_AGENT } });
    const contentLength = res.headers.get('content-length');
    return contentLength ? parseInt(contentLength, 10) : null;
  } catch (e) { return null; }
}

async function getFileSizeFromRange(url) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'Range': 'bytes=0-0', 'User-Agent': FAKE_USER_AGENT }, timeout: 5000 });
    const rangeHeader = res.headers.get('content-range');
    if (rangeHeader) { const match = rangeHeader.match(/\/(\d+)$/); if (match) return parseInt(match[1], 10); }
  } catch (e) { return null; }
  return null;
}

async function checkFileSize(url) {
  try {
    let streamUrl = await ytdl(url, { 'get-url': true, ...YTDL_COMMON });
    if (Array.isArray(streamUrl)) streamUrl = streamUrl[0];
    if (!streamUrl || typeof streamUrl !== 'string') return { ok: false, reason: 'NO_STREAM_URL' };
    if (!isSafeUrl(streamUrl)) { console.warn('[Pre-flight] Небезопасный URL:', streamUrl); return { ok: false, reason: 'UNSAFE_URL' }; }
    let size = await getFileSizeFromHead(streamUrl);
    if (!size) { size = await getFileSizeFromRange(streamUrl); }
    if (!size) { console.warn('[Pre-flight] Не удалось определить размер файла, продолжаю.'); return { ok: true, reason: 'SIZE_UNKNOWN' }; }
    if (size > MAX_FILE_SIZE_BYTES) { console.warn(`[Pre-flight] Файл слишком большой: ${(size / 1024 / 1024).toFixed(2)} МБ`); return { ok: false, reason: 'FILE_TOO_LARGE', size }; }
    console.log(`[Pre-flight] Размер файла: ${(size / 1024 / 1024).toFixed(2)} МБ — OK`);
    return { ok: true, size };
  } catch (e) {
    console.warn('[Pre-flight] Ошибка проверки размера:', e.message);
    return { ok: true, reason: 'CHECK_FAILED' };
  }
}

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
  if (!cacheKey) { cacheKey = getCacheKey(metadata, task.originalUrl || url); }
  return { metadata, cacheKey, source: task.source || 'soundcloud', url };
}

function startCacheCleanup() {
  const cleanupInterval = setInterval(() => {
    fs.readdir(cacheDir, (err, files) => {
      if (err) { console.error('[Cache Cleanup] Ошибка чтения директории:', err.message); return; }
      const now = Date.now();
      let cleaned = 0;
      files.forEach(file => {
        const filePath = path.join(cacheDir, file);
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          if (now - stats.mtimeMs > 3600000) { fs.unlink(filePath, (err) => { if (!err) cleaned++; }); }
        });
      });
      if (cleaned > 0) { console.log(`[Cache Cleanup] Удалено ${cleaned} старых файлов из кеша.`); }
    });
  }, 3600000);
  process.on('SIGTERM', () => clearInterval(cleanupInterval));
  process.on('SIGINT', () => clearInterval(cleanupInterval));
}
startCacheCleanup();

// ========================= CORE WORKER & QUEUE =========================

export async function trackDownloadProcessor(task) {
  let tempFilePath = null;
  let statusMessage = null;
  try {
    const userId = parseInt(task.userId, 10);
    if (!userId || isNaN(userId)) { console.error('[Worker] Invalid userId:', task.userId); return; }
    
    const usage = await getUserUsage(userId);
    if (!usage) { console.error(`[Worker] Не удалось получить данные пользователя ${userId}`); return; }
    if (usage.downloads_today >= usage.premium_limit) { console.warn(`[Worker] Пользователь ${userId} исчерпал дневной лимит`); await safeSendMessage(userId, T('limitReached')); return; }

    const ensured = await ensureTaskMetadata(task);
    const { metadata, cacheKey, source, url: ensuredUrl } = ensured;
    const { title, uploader, id: trackId, duration, thumbnail, ext, acodec } = metadata;
    const roundedDuration = duration ? Math.round(duration) : undefined;
    
    // <-- НАЧАЛО ЗАВЕРШЕНИЯ КОДА
    // --- Ранняя проверка кеша (продолжение) ---
      if (cached?.fileId) {
        console.log(`[Worker/Cache] ХИТ! Отправляю "${cached.trackName || title}" из кэша.`);
        await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.trackName || title, performer: uploader || 'Unknown Artist', duration: roundedDuration });
        await incrementDownload(userId, cached.trackName || title, cached.fileId, primaryKey);
        return;
      }
    } catch (e) {
      console.error('[Worker] Ошибка раннего чека кэша:', e.message);
    }

    statusMessage = await safeSendMessage(userId, `⏳ Начинаю скачивание трека: "${title}"`);
    console.log(`[Worker] Получена задача для "${title}" (источник: ${source}).`);

    // --- Предварительная проверка размера ---
    const sizeCheck = await checkFileSize(ensuredUrl);
    if (!sizeCheck.ok && sizeCheck.reason === 'FILE_TOO_LARGE') {
      throw new Error('FILE_TOO_LARGE');
    }
    
    // --- Скачивание файла ---
    let ytdlArgs;
    if (FFMPEG_AVAILABLE) {
      const tempFileName = `${trackId || 'track'}-${crypto.randomUUID()}.mp3`;
      tempFilePath = path.join(cacheDir, tempFileName);
      ytdlArgs = canCopyMp3(ext, acodec)
        ? { output: tempFilePath, 'embed-thumbnail': true, 'add-metadata': true, ...YTDL_COMMON }
        : { output: tempFilePath, 'extract-audio': true, 'audio-format': 'mp3', 'embed-thumbnail': true, 'add-metadata': true, ...YTDL_COMMON };
      await ytdl(ensuredUrl, ytdlArgs);
    } else {
      const baseName = `${trackId || 'track'}-${crypto.randomUUID()}`;
      const outputTemplate = path.join(cacheDir, `${baseName}.%(ext)s`);
      await ytdl(ensuredUrl, { output: outputTemplate, ...YTDL_COMMON });
      const files = await fs.promises.readdir(cacheDir);
      const found = files.find(f => f.startsWith(`${baseName}.`));
      if (!found) throw new Error('Файл не был создан.');
      tempFilePath = path.join(cacheDir, found);
    }
    
    if (!fs.existsSync(tempFilePath)) throw new Error(`Файл не был создан.`);
    const stats = await fs.promises.stat(tempFilePath);
    if (stats.size > MAX_FILE_SIZE_BYTES) throw new Error(`FILE_TOO_LARGE`);

    if (statusMessage) { await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, `✅ Скачал. Отправляю...`).catch(() => {}); }

    const sentToUserMessage = await bot.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, { title, performer: uploader || 'Unknown Artist', duration: roundedDuration });
    if (statusMessage) { await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {}); }

    if (sentToUserMessage?.audio?.file_id) {
      await incrementDownload(userId, title, sentToUserMessage.audio.file_id, cacheKey);
      if (STORAGE_CHANNEL_ID) {
        try {
          const sentToStorage = await bot.telegram.sendAudio(STORAGE_CHANNEL_ID, sentToUserMessage.audio.file_id);
          const normalizedKey = cacheKey || getCacheKey(metadata, ensuredUrl);
          await db.cacheTrack({ url: normalizedKey, fileId: sentToStorage.audio.file_id, title, artist: uploader, duration: roundedDuration, thumbnail });
          console.log(`✅ [Cache] Трек "${title}" успешно закэширован.`);
        } catch (e) { console.error(`❌ [Cache] Ошибка при кэшировании трека "${title}":`, e.message); }
      }
    }
  } catch (err) {
    const errorDetails = err?.stderr || err?.message || String(err);
    let userErrorMessage = '❌ Не удалось обработать трек.';
    if (errorDetails.includes('TASK_MISSING_URL')) userErrorMessage = '❌ Внутренняя ошибка (нет URL).';
    else if (errorDetails.includes('META_MISSING')) userErrorMessage = '❌ Не удалось получить информацию о треке.';
    else if (errorDetails.includes('FILE_TOO_LARGE')) userErrorMessage = '❌ Файл слишком большой (обычно это диджей-сеты или миксы).';
    else if (errorDetails.includes('timed out')) userErrorMessage = '❌ Ошибка сети при обработке трека.';
    console.error('❌ Ошибка воркера:', errorDetails);
    if (statusMessage) await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, userErrorMessage).catch(() => {});
    else await safeSendMessage(task.userId, userErrorMessage);
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.promises.unlink(tempFilePath).catch(e => console.error('Ошибка удаления временного файла:', e));
    }
  }
}

export const downloadQueue = new TaskQueue({
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
  taskProcessor: trackDownloadProcessor
});

export function initializeDownloadManager() {}

export function enqueue(ctx, userId, url) {
  (async () => {
    let statusMessage = null;
    try {
      if (!url || url.includes('spotify.com')) return;
      await db.resetDailyLimitIfNeeded(userId);
      const fullUser = await getUserUsage(userId);
      if (fullUser.downloads_today >= fullUser.premium_limit) {
        const bonusAvailable = Boolean(CHANNEL_USERNAME && !fullUser?.subscribed_bonus_used);
        const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
        const bonusText = bonusAvailable ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.` : '';
        const text = `${T('limitReached')}${bonusText}`;
        const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
        if (bonusAvailable) { extra.reply_markup = { inline_keyboard: [[ Markup.button.callback('✅ Я подписался, забрать бонус', 'check_subscription') ]] }; }
        await safeSendMessage(userId, text, extra);
        return;
      }
      statusMessage = await safeSendMessage(userId, '🔍 Получаю информацию о треке...');
      const remainingDailyLimit = Math.max(0, fullUser.premium_limit - fullUser.downloads_today);
      const playlistLimit = fullUser.premium_limit <= 10 ? 5 : UNLIMITED_PLAYLIST_LIMIT;
      const playlistEnd = Math.max(1, Math.min(remainingDailyLimit, playlistLimit));
      const info = await ytdl(url, { 'dump-single-json': true, 'playlist-end': playlistEnd, ...YTDL_COMMON });
      if (!info) throw new Error('Не удалось получить метаданные');
      const entries = Array.isArray(info.entries) ? info.entries : [info];
      let tracksToProcess = entries.filter(e => e && (e.webpage_url || e.url)).map(e => {
        const md = extractMetadataFromInfo(e);
        const realUrl = e.webpage_url || e.url;
        const key = getCacheKey(md, realUrl);
        return { url: realUrl, originalUrl: realUrl, source: 'soundcloud', cacheKey: key, metadata: md };
      });
      if (tracksToProcess.length === 0) { await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, 'Не удалось найти треки для загрузки.').catch(() => {}); return; }
      if (Array.isArray(info.entries) && (tracksToProcess.length > playlistEnd)) { await safeSendMessage(userId, `ℹ️ С учетом вашего тарифа будет обработано до ${playlistEnd} трек(ов).`); tracksToProcess = tracksToProcess.slice(0, playlistEnd); }
      if (statusMessage) { await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, '🔄 Проверяю кэш...').catch(() => {}); }
      
      const uniqueKeys = Array.from(new Set(tracksToProcess.flatMap(t => [t.cacheKey, t.originalUrl].filter(Boolean))));
      const cacheMap = typeof db.findCachedTracks === 'function' ? await db.findCachedTracks(uniqueKeys) : new Map();
      
      let remaining = Math.max(0, fullUser.premium_limit - fullUser.downloads_today);
      const tasksToDownload = [];
      const cachedToSend = [];
      for (const track of tracksToProcess) {
        if (remaining <= 0) break;
        const cached = cacheMap.get(track.cacheKey) || cacheMap.get(track.originalUrl);
        if (cached) cachedToSend.push({ track, cached });
        else tasksToDownload.push(track);
      }
      let sentFromCacheCount = 0;
      await pMap(cachedToSend, async ({ track, cached }) => {
        if (remaining <= 0) return;
        try {
          await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.trackName || track.metadata.title, performer: track.metadata.uploader });
          const ok = await incrementDownload(userId, cached.trackName || track.metadata.title, cached.fileId, track.cacheKey);
          if (ok) { remaining--; sentFromCacheCount++; }
        } catch (err) { if (err?.description?.includes('FILE_REFERENCE_EXPIRED')) { tasksToDownload.push(track); } else { console.error(`⚠️ Ошибка отправки из кэша для ${userId}:`, err.message); } }
      }, { concurrency: 3 });
      
      let finalMessage = '';
      if (sentFromCacheCount > 0) { finalMessage += `✅ ${sentFromCacheCount} трек(ов) отправлено из кэша.\n`; }
      if (remaining > 0 && tasksToDownload.length > 0) {
        const tasksToReallyDownload = tasksToDownload.slice(0, remaining);
        const currentQueueSize = downloadQueue.size;
        finalMessage += `\n⏳ ${tasksToReallyDownload.length} трек(ов) добавлено в очередь.\n📍 Ваша позиция в очереди: ~${currentQueueSize + 1}.`;
        const prio = fullUser.premium_limit || 0;
        for (const task of tasksToReallyDownload) {
          downloadQueue.add({ userId, ...task, priority: prio });
        }
      } else if (tasksToDownload.length > 0 && remaining <= 0) { finalMessage += `🚫 Ваш дневной лимит исчерпан. Оставшиеся треки не были добавлены в очередь.`; }
      if (finalMessage.trim() === '' && sentFromCacheCount === 0) { finalMessage = '✅ Все треки уже были отправлены ранее или обработаны.'; }
      
      if (statusMessage) { await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, finalMessage.trim() || 'Готово.').catch(() => {}); }
      else if (finalMessage.trim()) { await safeSendMessage(userId, finalMessage.trim()); }
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
// <-- КОНЕЦ КОДА