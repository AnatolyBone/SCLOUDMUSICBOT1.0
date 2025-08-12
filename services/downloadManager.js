// services/downloadManager.js

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import pLimit from 'p-limit';

// <<< ИСПРАВЛЕНО: Правильные, прямые импорты >>>
import { bot } from '../bot.js';
import redisService from './redisClient.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
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
const YTDL_TIMEOUT = 60; // 60 секунд

// Ограничиваем ytdl для получения метаданных, чтобы не перегружать CPU
const ytdlLimit = pLimit(1);

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
        
        if (!fs.existsSync(tempFilePath)) {
            throw new Error(`Файл не был создан после скачивания: ${tempFilePath}`);
        }

        const stats = await fs.promises.stat(tempFilePath);
        if (stats.size / (1024 * 1024) > TELEGRAM_FILE_LIMIT_MB) {
            throw new Error(`Трек "${trackName}" слишком большой (больше ${TELEGRAM_FILE_LIMIT_MB} МБ).`);
        }

        if (statusMessage) {
            await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, `✅ Скачал. Отправляю вам "${trackName}"...`).catch(() => {});
        }
        
        const sentMessage = await bot.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
             title: trackName, performer: uploader || 'SoundCloud'
        });
        
        if (statusMessage) {
            await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
        }
        
        if (sentMessage?.audio?.file_id) {
            console.log(`[Worker] Трек "${trackName}" отправлен, кэширую...`);
            await cacheTrack(url, sentMessage.audio.file_id, trackName);
            await saveTrackForUser(userId, trackName, sentMessage.audio.file_id);
            await incrementDownloads(userId, trackName, url);
        }
        
        if (playlistUrl) {
            const redisClient = redisService.getClient();
            const playlistKey = `playlist:${userId}:${playlistUrl}`;
            const remaining = await redisClient.decr(playlistKey);
            if (remaining <= 0) {
                await safeSendMessage(userId, '✅ Все треки из плейлиста загружены.');
                await redisClient.del(playlistKey);
            }
        }
        
    } catch (err) {
        let userErrorMessage = `❌ Не удалось обработать трек: "${trackName}"`;
        const errorDetails = err.stderr || err.message || '';

        if (err.name === 'TimeoutError' || errorDetails.includes('timed out')) {
            userErrorMessage += '. Причина: слишком долгое скачивание (таймаут).';
            console.error(`❌ Таймаут воркера при обработке "${trackName}"`);
        } else {
            console.error(`❌ Ошибка воркера при обработке "${trackName}":`, errorDetails, err);
        }

        if (statusMessage) {
            await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, userErrorMessage).catch(() => {});
        } else {
            await safeSendMessage(userId, userErrorMessage);
        }
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath).catch(e => console.error(`Не удалось удалить временный файл ${tempFilePath}:`, e));
        }
    }
}

export const downloadQueue = new TaskQueue({
    maxConcurrent: 4, // Оптимально для бесплатного тарифа
    taskProcessor: trackDownloadProcessor
});

export async function enqueue(ctx, userId, url) {
    let processingMessage = null;
    try {
        await logUserActivity(userId);
        await resetDailyLimitIfNeeded(userId);
        
        processingMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');
        
        // Оборачиваем вызов ytdl в наш лимит, чтобы не перегружать CPU на старте
        const info = await ytdlLimit(() => ytdl(url, { dumpSingleJson: true, retries: 2, "socket-timeout": YTDL_TIMEOUT }));
        
        if (!info) {
            throw new Error('Не удалось получить метаданные по ссылке.');
        }

        if (processingMessage) {
            await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
            processingMessage = null;
        }

        // <<< ИСПРАВЛЕНО: Запрет плейлистов для экономии памяти на бесплатном тарифе >>>
        const isPlaylist = Array.isArray(info.entries) && info.entries.length > 0;
        
        if (isPlaylist) {
            console.warn(`[OPTIMIZATION] Отклонен плейлист от ${userId} для экономии ресурсов.`);
            await safeSendMessage(userId, 'ℹ️ Обработка плейлистов временно ограничена для повышения стабильности. Пожалуйста, отправляйте треки по одной ссылке.');
            return;
        }

        let tracksToProcess = [{
            url: info.webpage_url || url, trackId: info.id,
            trackName: sanitizeFilename(info.title).slice(0, TRACK_TITLE_LIMIT),
            uploader: info.uploader || 'SoundCloud'
        }];
        
        const user = await getUser(userId);
        let remainingLimit = user.premium_limit - user.downloads_today;
        
        if (remainingLimit <= 0) {
            return await safeSendMessage(userId, T('limitReached'));
        }
        
        const tasksFromCache = [];
        const tasksToDownload = [];
        
        for (const track of tracksToProcess) {
            const cachedTrack = await findCachedTrack(track.url);
            if (cachedTrack) {
                tasksFromCache.push({ ...track, ...cachedTrack });
            } else {
                tasksToDownload.push(track);
            }
        }
        
        if (tasksFromCache.length > 0) {
            let sentFromCacheCount = 0;
            for (const track of tasksFromCache) {
                try {
                    await bot.telegram.sendAudio(userId, track.fileId, { caption: track.trackName, title: track.trackName });
                    await saveTrackForUser(userId, track.trackName, track.fileId);
                    await incrementDownloads(userId, track.trackName, track.url);
                    sentFromCacheCount++;
                } catch (err) {
                    if (err.response?.error_code === 403) { await updateUserField(userId, 'active', false); return; }
                    else if (err.description?.includes('FILE_REFERENCE_EXPIRED')) {
                        tasksToDownload.push(track);
                    } else {
                        console.error(`⚠️ Ошибка отправки из кэша для ${userId}: ${err.message}`);
                    }
                }
            }
            if (sentFromCacheCount > 0) {
                await safeSendMessage(userId, `✅ ${sentFromCacheCount} трек(ов) отправлено мгновенно из кэша.`);
            }
        }
        
        if (tasksToDownload.length > 0) {
            const userAfterCache = await getUser(userId);
            const currentLimit = userAfterCache.premium_limit - userAfterCache.downloads_today;
            if (currentLimit <= 0) {
                return await safeSendMessage(userId, '🚫 Ваш лимит исчерпан треками из кэша.');
            }

            const tasksToReallyDownload = tasksToDownload.slice(0, currentLimit);
            
            if (tasksToReallyDownload.length > 0) {
                await safeSendMessage(userId, `⏳ ${tasksToReallyDownload.length} трек(ов) добавлено в очередь. Вы получите их по мере готовности.`);
                
                for (const track of tasksToReallyDownload) {
                    downloadQueue.add({ userId, ...track, playlistUrl: null, priority: user.premium_limit });
                    await logEvent(userId, 'download');
                }
            }
        }
    } catch (err) {
        if (processingMessage) {
            await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
        }

        const errorMessage = err.stderr || err.message || '';

        if (err.name === 'TimeoutError' || errorMessage.includes('timed out')) {
            console.error(`❌ Таймаут в enqueue для ${userId}:`, errorMessage);
            await safeSendMessage(userId, '❌ Ошибка: SoundCloud отвечает слишком долго. Пожалуйста, попробуйте позже.');
        } else if (errorMessage.includes('404: Not Found')) {
            console.warn(`[User Error] Трек не найден (404) для ${userId}.`);
            await safeSendMessage(userId, '❌ Трек по этой ссылке не найден. Возможно, он был удален или ссылка неверна.');
        } else {
            console.error(`❌ Глобальная ошибка в enqueue для ${userId}:`, err);
            await safeSendMessage(userId, `❌ Произошла неизвестная ошибка при обработке вашей ссылки.`);
        }
    }
}