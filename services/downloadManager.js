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
            retries: 3, "socket-timeout": 120
        });
        
        if (!fs.existsSync(tempFilePath)) {
            throw new Error(`Файл не был создан после скачивания: ${tempFilePath}`);
        }

        const stats = await fs.promises.stat(tempFilePath);
        if (stats.size / (1024 * 1024) > TELEGRAM_FILE_LIMIT_MB) {
            throw new Error(`Трек слишком большой: ${trackName}`);
        }

        if (statusMessage) {
            await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, `✅ Скачал. Отправляю вам "${trackName}"...`);
        }
        
        const sentMessage = await bot.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
            caption: trackName, title: trackName, performer: uploader || 'SoundCloud'
        });
        
        if (statusMessage) {
            await bot.telegram.deleteMessage(userId, statusMessage.message_id);
        }
        
        if (sentMessage?.audio?.file_id) {
            console.log(`[Worker] Трек "${trackName}" отправлен, кэширую...`);
            await cacheTrack(url, sentMessage.audio.file_id, trackName);
            await saveTrackForUser(userId, trackName, sentMessage.audio.file_id);
            await incrementDownloads(userId, trackName, url); // Передаем url для логирования
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
        // <<< ИЗМЕНЕНО: Более детальная обработка ошибок, включая TimeoutError
        let errorMessage = `❌ Не удалось обработать трек: "${trackName}"`;
        if (err.name === 'TimeoutError' || (err.stderr && err.stderr.includes('timed out'))) {
            errorMessage += '. Причина: таймаут скачивания.';
            console.error(`❌ Таймаут воркера при обработке "${trackName}"`);
        } else if (err.response?.error_code === 403) {
            await updateUserField(userId, 'active', false);
        } else {
            console.error(`❌ Ошибка воркера при обработке "${trackName}":`, err.stderr || err.message || err);
        }

        if (statusMessage) {
            await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, errorMessage);
        } else {
            await safeSendMessage(userId, errorMessage);
        }
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath).catch(e => console.error(`Не удалось удалить временный файл ${tempFilePath}:`, e));
        }
    }
}

// --- Очередь задач ---
export const downloadQueue = new TaskQueue({
    maxConcurrent: 8,
    taskProcessor: trackDownloadProcessor
});

// --- Основной входной метод ---
export async function enqueue(ctx, userId, url) {
    let processingMessage = null;
    try {
        await logUserActivity(userId);
        await resetDailyLimitIfNeeded(userId);
        
        processingMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');
        
        const info = await ytdl(url, { dumpSingleJson: true, retries: 2, "socket-timeout": 120 });
        if (!info) throw new Error('Не удалось получить метаданные по ссылке.');
        
        const isPlaylist = Array.isArray(info.entries) && info.entries.length > 0;
        let tracksToProcess = [];
        
        if (isPlaylist) {
            tracksToProcess = info.entries.filter(e => e?.webpage_url && e?.id).map(e => ({
                url: e.webpage_url, trackId: e.id,
                trackName: sanitizeFilename(e.title).slice(0, TRACK_TITLE_LIMIT),
                uploader: e.uploader || 'SoundCloud'
            }));
        } else {
            tracksToProcess = [{
                url: info.webpage_url || url, trackId: info.id,
                trackName: sanitizeFilename(info.title).slice(0, TRACK_TITLE_LIMIT),
                uploader: info.uploader || 'SoundCloud'
            }];
        }

        if (processingMessage) {
            await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
            processingMessage = null;
        }

        if (tracksToProcess.length === 0) return await safeSendMessage(userId, 'Не удалось найти треки для загрузки.');
        
        const user = await getUser(userId);
        let remainingLimit = user.premium_limit - user.downloads_today;
        
        if (remainingLimit <= 0) return await safeSendMessage(userId, texts.limitReached, Markup.inlineKeyboard([]));
        
        if (isPlaylist && user.premium_limit <= 10 && tracksToProcess.length > MAX_PLAYLIST_TRACKS_FREE) {
            await safeSendMessage(userId, `ℹ️ Бесплатный тариф: можно скачать до ${MAX_PLAYLIST_TRACKS_FREE} треков из плейлиста.`);
            tracksToProcess = tracksToProcess.slice(0, MAX_PLAYLIST_TRACKS_FREE);
        }
        
        if (tracksToProcess.length > remainingLimit) {
            await safeSendMessage(userId, `⚠️ В плейлисте ${tracksToProcess.length} треков, но ваш лимит: ${remainingLimit}. Добавляю доступное количество.`);
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
            let sentFromCacheCount = 0;
            for (const track of tasksFromCache) {
                try {
                    await bot.telegram.sendAudio(userId, track.fileId, { caption: track.trackName, title: track.trackName });
                    await saveTrackForUser(userId, track.trackName, track.fileId);
                    await incrementDownloads(userId, track.trackName, track.url); // Передаем url
                    sentFromCacheCount++;
                } catch (err) {
                    if (err.response?.error_code === 403) { await updateUserField(userId, 'active', false); return; }
                    else if (err.description?.includes('FILE_REFERENCE_EXPIRED')) tasksToDownload.push(track);
                    else console.error(`⚠️ Ошибка отправки из кэша для ${userId}: ${err.message}`);
                }
            }
            if (sentFromCacheCount > 0) await safeSendMessage(userId, `✅ ${sentFromCacheCount} трек(ов) отправлено мгновенно из кэша.`);
        }
        
        if (tasksToDownload.length > 0) {
            const userAfterCache = await getUser(userId);
            const currentLimit = userAfterCache.premium_limit - userAfterCache.downloads_today;
            if (currentLimit <= 0) return await safeSendMessage(userId, '🚫 Ваш лимит исчерпан треками из кэша.');

            const tasksToReallyDownload = tasksToDownload.slice(0, currentLimit);
            
            if (tasksToReallyDownload.length > 0) {
                await safeSendMessage(userId, `⏳ ${tasksToReallyDownload.length} трек(ов) добавлено в очередь. Вы получите их по мере готовности.`);
                if (isPlaylist) {
                    const redisClient = getRedisClient();
                    const playlistKey = `playlist:${userId}:${url}`;
                    await redisClient.setEx(playlistKey, 3600, tasksToReallyDownload.length.toString());
                    await logEvent(userId, 'download_playlist');
                }
                
                for (const track of tasksToReallyDownload) {
                    downloadQueue.add({ userId, ...track, playlistUrl: isPlaylist ? url : null, priority: user.premium_limit });
                    await logEvent(userId, 'download');
                }
            }
        }
    } catch (err) {
        // <<< ИЗМЕНЕНО: Более надежная проверка на TimeoutError
        if (processingMessage) {
            await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
        }
        if (err.name === 'TimeoutError' || (err.message && err.message.includes('timed out'))) {
            console.error(`❌ TimeoutError в enqueue для userId ${userId}:`, err.message);
            await safeSendMessage(userId, '❌ Ошибка: SoundCloud отвечает слишком долго. Попробуйте позже.');
        } else {
            console.error(`❌ Глобальная ошибка в enqueue для userId ${userId}:`, err.stderr || err.message || err);
            await safeSendMessage(userId, texts.error + ' Не удалось обработать ссылку.');
        }
    }
}