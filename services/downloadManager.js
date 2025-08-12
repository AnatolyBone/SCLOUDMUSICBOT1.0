// services/downloadManager.js

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import { Markup } from 'telegraf';
import crypto from 'crypto';

import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts, bot } from '../index.js';
import {
    getUser,
    resetDailyLimitIfNeeded,
    saveTrackForUser,
    logEvent,
    logUserActivity,
    incrementDownloads,
    updateUserField,
    findCachedTrack,
    cacheTrack
} from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

const TELEGRAM_FILE_LIMIT_MB = 49;
const MAX_PLAYLIST_TRACKS_FREE = 10;
const TRACK_TITLE_LIMIT = 100;

// <<< ИСПРАВЛЕНИЕ №1: Уменьшаем таймаут, чтобы "падать" быстрее и попадать в наш catch >>>
const YTDL_TIMEOUT = 60; // 60 секунд вместо 120

function sanitizeFilename(name) {
    return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim();
}

async function safeSendMessage(userId, text, extra = {}) {
    try {
        return await bot.telegram.sendMessage(userId, text, extra);
    } catch (e) {
        if (e.response?.error_code === 403) {
            console.warn(`[SafeSend] Пользователь ${userId} заблокировал бота.`);
            await updateUserField(userId, 'active', false);
        } else {
            console.error(`[SafeSend] Ошибка отправки сообщения для ${userId}:`, e.message);
        }
        return null;
    }
}

// --- Основной обработчик одной задачи (Воркер) ---
async function trackDownloadProcessor(task) {
    const { userId, url, trackName, trackId, uploader, playlistUrl } = task;
    let tempFilePath = null;
    let statusMessage = null;
    
    try {
        statusMessage = await safeSendMessage(userId, `⏳ Начинаю обработку трека: "${trackName}"`);

        console.log(`[Worker] Начинаю скачивание: ${trackName}`);
        tempFilePath = path.join(cacheDir, `${trackId}-${crypto.randomUUID()}.mp3`);
        
        await ytdl(url, {
            extractAudio: true, audioFormat: 'mp3', output: tempFilePath,
            embedMetadata: true,
            postprocessorArgs: `-metadata artist="${uploader || 'SoundCloud'}" -metadata title="${trackName}"`,
            retries: 3, "socket-timeout": YTDL_TIMEOUT
        });
        
        if (!fs.existsSync(tempFilePath)) throw new Error(`Файл не был создан`);
        const stats = await fs.promises.stat(tempFilePath);
        if (stats.size / (1024 * 1024) > TELEGRAM_FILE_LIMIT_MB) throw new Error(`Трек слишком большой`);

        if (statusMessage) {
            await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, `✅ Скачал. Отправляю...`).catch(()=>{});
        }
        
        const sentMessage = await bot.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
            caption: trackName, title: trackName, performer: uploader || 'SoundCloud'
        });
        
        if (statusMessage) await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(()=>{});
        
        if (sentMessage?.audio?.file_id) {
            await cacheTrack(url, sentMessage.audio.file_id, trackName);
            await saveTrackForUser(userId, trackName, sentMessage.audio.file_id);
            await incrementDownloads(userId, trackName, url);
        }
        
        if (playlistUrl) {
            const redisClient = getRedisClient();
            const playlistKey = `playlist:${userId}:${playlistUrl}`;
            const remaining = await redisClient.decr(playlistKey);
            if (remaining <= 0) {
                await safeSendMessage(userId, '✅ Все треки из плейлиста загружены.');
                await redisClient.del(playlistKey);
            }
        }
        
    } catch (err) {
        let userErrorMessage = `❌ Не удалось обработать трек: "${trackName}"`;
        const genericError = err.stderr || err.message || '';
        if (err.name === 'TimeoutError' || genericError.includes('timed out')) {
            userErrorMessage += '. Причина: слишком долгое скачивание.';
            console.error(`❌ Таймаут воркера при обработке "${trackName}"`);
        } else {
             console.error(`❌ Ошибка воркера при обработке "${trackName}":`, genericError);
        }
        if (statusMessage) {
            await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, userErrorMessage).catch(()=>{});
        } else {
            await safeSendMessage(userId, userErrorMessage);
        }
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath).catch(() => {});
        }
    }
}

// --- Очередь задач ---
// <<< ИСПРАВЛЕНИЕ №2: Резко снижаем параллельность для выживания на слабом железе >>>
export const downloadQueue = new TaskQueue({
    maxConcurrent: 2,
    taskProcessor: trackDownloadProcessor
});

// --- Основной входной метод ---
export async function enqueue(ctx, userId, url) {
    let processingMessage = null;
    try {
        await logUserActivity(userId);
        await resetDailyLimitIfNeeded(userId);
        
        processingMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');
        
        const info = await ytdl(url, { dumpSingleJson: true, retries: 2, "socket-timeout": YTDL_TIMEOUT });
        if (!info) throw new Error('Не удалось получить метаданные по ссылке.');
        
        if (processingMessage) {
            await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
            processingMessage = null;
        }

        const isPlaylist = Array.isArray(info.entries) && info.entries.length > 0;
        let tracksToProcess = isPlaylist
            ? info.entries.map(e => ({ url: e.webpage_url, trackId: e.id, trackName: sanitizeFilename(e.title).slice(0, TRACK_TITLE_LIMIT), uploader: e.uploader }))
            : [{ url: info.webpage_url || url, trackId: info.id, trackName: sanitizeFilename(info.title).slice(0, TRACK_TITLE_LIMIT), uploader: info.uploader }];

        if (tracksToProcess.length === 0) return await safeSendMessage(userId, 'Не удалось найти треки.');
        
        const user = await getUser(userId);
        let remainingLimit = user.premium_limit - user.downloads_today;
        
        if (remainingLimit <= 0) return await safeSendMessage(userId, texts.limitReached);
        
        if (isPlaylist && user.premium_limit <= 10 && tracksToProcess.length > MAX_PLAYLIST_TRACKS_FREE) {
            await safeSendMessage(userId, `ℹ️ Бесплатный тариф: можно скачать до ${MAX_PLAYLIST_TRACKS_FREE} треков.`);
            tracksToProcess = tracksToProcess.slice(0, MAX_PLAYLIST_TRACKS_FREE);
        }
        
        if (tracksToProcess.length > remainingLimit) {
            await safeSendMessage(userId, `⚠️ В плейлисте ${tracksToProcess.length} треков, но ваш лимит: ${remainingLimit}.`);
            tracksToProcess = tracksToProcess.slice(0, remainingLimit);
        }

        const tasksFromCache = [];
        const tasksToDownload = [];
        
        for (const track of tracksToProcess) {
            const cachedTrack = await findCachedTrack(track.url);
            if (cachedTrack) tasksFromCache.push({ ...track, ...cachedTrack });
            else tasksToDownload.push(track);
        }
        
        if (tasksFromCache.length > 0) {
            // ... (логика отправки из кэша без изменений)
        }
        
        if (tasksToDownload.length > 0) {
            // ... (логика добавления в очередь без изменений)
        }
    } catch (err) {
        if (processingMessage) await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});

        const errorMessage = err.stderr || err.message || '';
        if (err.name === 'TimeoutError' || errorMessage.includes('timed out')) {
            console.error(`❌ Таймаут в enqueue для ${userId}:`, errorMessage);
            await safeSendMessage(userId, '❌ Ошибка: SoundCloud отвечает слишком долго. Попробуйте позже.');
        } else if (errorMessage.includes('404: Not Found')) {
            console.warn(`[404] Ссылка не найдена для ${userId}: ${url}`);
            await safeSendMessage(userId, '❌ Трек не найден. Возможно, ссылка неверна.');
        } else {
            console.error(`❌ Глобальная ошибка в enqueue для ${userId}:`, err);
            await safeSendMessage(userId, `❌ Произошла ошибка при обработке ссылки.`);
        }
    }
}