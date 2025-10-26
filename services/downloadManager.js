// services/downloadManager.js (упрощенная версия с плейлистами)

import ytdl from 'youtube-dl-exec';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import ffmpegPath from 'ffmpeg-static';
import { fileURLToPath } from 'url';

import { bot } from '../bot.js';
import * as db from '../db.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import { STORAGE_CHANNEL_ID, PROXY_URL } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));

// ========================= КОНФИГУРАЦИЯ =========================
const cacheDir = path.join(os.tmpdir(), 'soundcloud-cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

const MAX_FILE_SIZE = 49 * 1024 * 1024; // 49 МБ
const MAX_CONCURRENT = 2; // Для бесплатного Render.com

// Лимиты плейлистов по тарифам
const PLAYLIST_LIMITS = {
  free: 10,
  plus: 30,
  pro: 100,
  unlimited: 200
};

// Базовые опции для yt-dlp
const YTDL_OPTIONS = {
  'ffmpeg-location': ffmpegPath,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'no-warnings': true,
  'socket-timeout': 60,
  proxy: PROXY_URL || undefined
};

// ========================= УТИЛИТЫ =========================

function sanitizeFilename(name) {
  return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim() || 'track';
}

function getCacheKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function getPlaylistLimit(dailyLimit) {
  if (dailyLimit >= 10000) return PLAYLIST_LIMITS.unlimited;
  if (dailyLimit >= 100) return PLAYLIST_LIMITS.pro;
  if (dailyLimit >= 30) return PLAYLIST_LIMITS.plus;
  return PLAYLIST_LIMITS.free;
}

// ========================= ОСНОВНОЙ ВОРКЕР =========================

async function processDownload(task) {
  const { userId, url, metadata } = task;
  let tempFile = null;
  
  try {
    // 1. Проверяем кэш
    const cacheKey = getCacheKey(url);
    const cached = await db.findCachedTrack(cacheKey);
    
    if (cached?.fileId) {
      console.log(`[Cache HIT] ${cached.trackName}`);
      try {
        await bot.telegram.sendAudio(userId, cached.fileId, {
          title: cached.trackName,
          performer: cached.artist,
          duration: cached.duration
        });
        
        await db.incrementDownloadsAndSaveTrack(
          userId, 
          cached.trackName, 
          cached.fileId, 
          cacheKey
        );
        return;
      } catch (err) {
        if (err?.description?.includes('file_id')) {
          await db.deleteCachedTrack(cacheKey);
        }
      }
    }
    
    // 2. Получаем метаданные (если их нет)
    let info = metadata;
    if (!info) {
      console.log(`[Download] Получаю метаданные: ${url}`);
      info = await ytdl(url, {
        'dump-single-json': true,
        'no-playlist': true,
        ...YTDL_OPTIONS
      });
    }
    
    if (!info) throw new Error('Не удалось получить метаданные');
    
    const title = sanitizeFilename(info.title || 'Unknown');
    const artist = info.uploader || 'Unknown Artist';
    const duration = Math.round(info.duration || 0);
    
    // 3. Скачиваем файл
    const tempFileName = `${crypto.randomUUID()}.mp3`;
    tempFile = path.join(cacheDir, tempFileName);
    
    console.log(`[Download] Скачиваю: ${title}`);
    await ytdl(url, {
      output: tempFile,
      'extract-audio': true,
      'audio-format': 'mp3',
      'audio-quality': 5,
      ...YTDL_OPTIONS
    });
    
    // 4. Проверяем размер
    const stats = await fs.promises.stat(tempFile);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error('FILE_TOO_LARGE');
    }
    
    // 5. Отправляем и кэшируем
    let fileId = null;
    
    if (STORAGE_CHANNEL_ID) {
      try {
        const stored = await bot.telegram.sendAudio(
          STORAGE_CHANNEL_ID,
          { source: fs.createReadStream(tempFile), filename: `${title}.mp3` },
          { title, performer: artist, duration }
        );
        fileId = stored.audio?.file_id;
      } catch (err) {
        console.error('[Storage] Ошибка:', err.message);
      }
    }
    
    if (fileId) {
      await bot.telegram.sendAudio(userId, fileId, {
        title,
        performer: artist,
        duration
      });
    } else {
      const sent = await bot.telegram.sendAudio(
        userId,
        { source: fs.createReadStream(tempFile), filename: `${title}.mp3` },
        { title, performer: artist, duration }
      );
      fileId = sent.audio?.file_id;
    }
    
    if (fileId) {
      await db.cacheTrack({
        url: cacheKey,
        fileId,
        title,
        artist,
        duration
      });
      
      await db.incrementDownloadsAndSaveTrack(userId, title, fileId, cacheKey);
    }
    
  } catch (err) {
    console.error(`[Download] Ошибка:`, err.message);
    
    let errorMsg = '❌ Не удалось скачать трек';
    if (err.message === 'FILE_TOO_LARGE') errorMsg = '❌ Файл слишком большой';
    else if (err.message?.includes('404')) errorMsg = '❌ Трек не найден';
    
    await bot.telegram.sendMessage(userId, errorMsg).catch(() => {});
    
  } finally {
    if (tempFile) {
      fs.promises.unlink(tempFile).catch(() => {});
    }
  }
}

// ========================= ОЧЕРЕДЬ =========================

export const downloadQueue = new TaskQueue({
  maxConcurrent: MAX_CONCURRENT,
  taskProcessor: processDownload
});

// ========================= ГЛАВНАЯ ФУНКЦИЯ =========================

export async function enqueue(ctx, userId, url) {
  try {
    // 1. Проверка пользователя и лимитов
    const user = await db.getUser(userId);
    if (user.downloads_today >= user.premium_limit) {
      await bot.telegram.sendMessage(userId, '❌ Дневной лимит исчерпан');
      return;
    }
    
    const remaining = user.premium_limit - user.downloads_today;
    const playlistLimit = Math.min(getPlaylistLimit(user.premium_limit), remaining);
    
    // 2. Получаем метаданные (с учетом плейлистов)
    console.log(`[Enqueue] Анализирую URL: ${url}`);
    const info = await ytdl(url, {
      'dump-single-json': true,
      'playlist-end': playlistLimit,
      ...YTDL_OPTIONS
    });
    
    if (!info) {
      throw new Error('Не удалось получить метаданные');
    }
    
    // 3. Определяем, это плейлист или одиночный трек
    const isPlaylist = Array.isArray(info.entries) && info.entries.length > 1;
    const tracks = isPlaylist ? info.entries : [info];
    
    // 4. Уведомление о плейлисте
    if (isPlaylist) {
      await bot.telegram.sendMessage(
        userId,
        `📋 Обнаружен плейлист\n` +
        `📊 Треков: ${tracks.length}/${info.entries.length}\n` +
        `⏳ Начинаю обработку...`
      );
    }
    
    // 5. Обрабатываем треки
    let sentFromCache = 0;
    let addedToQueue = 0;
    
    for (const track of tracks.slice(0, playlistLimit)) {
      if (!track) continue;
      
      const trackUrl = track.webpage_url || track.url || url;
      const cacheKey = getCacheKey(trackUrl);
      
      // Проверяем кэш
      const cached = await db.findCachedTrack(cacheKey);
      
      if (cached?.fileId) {
        try {
          await bot.telegram.sendAudio(userId, cached.fileId, {
            title: cached.trackName,
            performer: cached.artist,
            duration: cached.duration
          });
          
          await db.incrementDownloadsAndSaveTrack(
            userId,
            cached.trackName,
            cached.fileId,
            cacheKey
          );
          
          sentFromCache++;
          continue;
        } catch (err) {
          if (err?.description?.includes('file_id')) {
            await db.deleteCachedTrack(cacheKey);
          }
        }
      }
      
      // Добавляем в очередь
      downloadQueue.add({
        userId,
        url: trackUrl,
        metadata: track,
        priority: user.premium_limit || 0
      });
      addedToQueue++;
    }
    
    // 6. Итоговое сообщение
    let statusMsg = '';
    if (sentFromCache > 0) {
      statusMsg += `✅ Из кэша: ${sentFromCache}\n`;
    }
    if (addedToQueue > 0) {
      statusMsg += `⏳ В очереди: ${addedToQueue}\n`;
      statusMsg += `📍 Позиция: ${downloadQueue.size}`;
    }
    
    if (statusMsg) {
      await bot.telegram.sendMessage(userId, statusMsg);
    }
    
  } catch (err) {
    console.error('[Enqueue] Ошибка:', err.message);
    await bot.telegram.sendMessage(userId, '❌ Ошибка обработки').catch(() => {});
  }
}

// ========================= ОЧИСТКА КЭША =========================

setInterval(() => {
  fs.readdir(cacheDir, (err, files) => {
    if (err) return;
    
    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(cacheDir, file);
      fs.stat(filePath, (err, stats) => {
        if (!err && now - stats.mtimeMs > 1800000) {
          fs.unlink(filePath, () => {});
        }
      });
    });
  });
}, 1800000);

// ========================= ИНИЦИАЛИЗАЦИЯ =========================

export function initializeDownloadManager() {
  console.log('[DownloadManager] Инициализирован');
  console.log(`[DownloadManager] Макс. загрузок: ${MAX_CONCURRENT}`);
  console.log(`[DownloadManager] Хранилище: ${STORAGE_CHANNEL_ID ? '✅' : '❌'}`);
}