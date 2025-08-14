// services/downloadManager.js

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import pLimit from 'p-limit';

import { bot } from '../bot.js';
import redisService from './redisClient.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import {
    getUser,
    resetDailyLimitIfNeeded,
    logEvent,
    updateUserField,
    findCachedTrack,
    cacheTrack,
    incrementDownloadsAndSaveTrack
} from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

const YTDL_TIMEOUT = 60;
const TRACK_TITLE_LIMIT = 100;
const UNLIMITED_PLAYLIST_LIMIT = 100;

const ytdlLimit = pLimit(1);

function sanitizeFilename(name) {
    return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim();
}

async function safeSendMessage(userId, text, extra = {}) {
    try {
        if (!bot) throw new Error("Bot is not initialized");
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
    const { userId, url, trackName, trackId, uploader, playlistInfo } = task;
    let tempFilePath = null;
    let statusMessage = null;
    
    try {
        statusMessage = await safeSendMessage(userId, `⏳ Начинаю обработку трека: "${trackName}"`);
        console.log(`[Worker] Начинаю скачивание: ${trackName}`);
        tempFilePath = path.join(cacheDir, `${trackId}-${crypto.randomUUID()}.mp3`);
        
        await ytdl(url, {
            output: tempFilePath,
            extractAudio: true, audioFormat: 'mp3',
            retries: 3, "socket-timeout": YTDL_TIMEOUT
        });
        
        if (!fs.existsSync(tempFilePath)) throw new Error(`Файл не был создан`);
        
        if (statusMessage) await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, `✅ Скачал. Отправляю...`).catch(()=>{});
        
        const sentMessage = await bot.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, { 
            title: trackName, 
            performer: uploader || 'SoundCloud' 
        });
        
        if (statusMessage) await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(()=>{});
        
        if (sentMessage?.audio?.file_id) {
            await cacheTrack(url, sentMessage.audio.file_id, trackName);
            await incrementDownloadsAndSaveTrack(userId, trackName, sentMessage.audio.file_id, url);
        }
        
        if (playlistInfo) {
            const redisClient = redisService.getClient();
            const playlistKey = `playlist:${userId}:${playlistInfo.id}`;
            const remaining = await redisClient.decr(playlistKey);
            if (remaining <= 0) {
                await safeSendMessage(userId, `✅ Все треки из плейлиста "${playlistInfo.title}" загружены.`);
                await redisClient.del(playlistKey);
            }
        }
    } catch (err) {
        let userErrorMessage = `❌ Не удалось обработать трек: "${trackName}"`;
        const errorDetails = err.stderr || err.message || '';
        if (err.name === 'TimeoutError' || errorDetails.includes('timed out')) {
            userErrorMessage += '. Причина: таймаут.';
        }
        console.error(`❌ Ошибка воркера при обработке "${trackName}":`, errorDetails);
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

export const downloadQueue = new TaskQueue({
    maxConcurrent: 2,
    taskProcessor: trackDownloadProcessor
});

export async function enqueue(ctx, userId, url) {
    let processingMessage = null;
    try {
        await resetDailyLimitIfNeeded(userId);
        processingMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');
        
        const info = await ytdlLimit(() => ytdl(url, { dumpSingleJson: true, retries: 2, "socket-timeout": YTDL_TIMEOUT }));
        if (!info) throw new Error('Не удалось получить метаданные');

        if (processingMessage) {
            await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
            processingMessage = null;
        }

        const isPlaylist = Array.isArray(info.entries) && info.entries.length > 0;
        const user = await getUser(userId);
        const remainingLimit = user.premium_limit - (user.downloads_today || 0);

        if (remainingLimit <= 0) {
            return await safeSendMessage(userId, T('limitReached'));
        }

        let tracksToProcess = [];
        let playlistInfo = null;

        if (isPlaylist) {
            console.log(`[Enqueue] Обнаружен плейлист от ${userId}. Треков: ${info.entries.length}`);
            playlistInfo = { id: info.id, title: info.title };
            tracksToProcess = info.entries
                .filter(e => e && e.webpage_url)
                .map(e => ({
                    url: e.webpage_url, trackId: e.id,
                    trackName: sanitizeFilename(e.title).slice(0, TRACK_TITLE_LIMIT),
                    uploader: e.uploader
                }));

            let maxTracksForPlaylist;
            if (user.premium_limit <= 10) maxTracksForPlaylist = 5;
            else if (user.premium_limit >= 10000) maxTracksForPlaylist = UNLIMITED_PLAYLIST_LIMIT;
            else maxTracksForPlaylist = Infinity;
            
            const originalCount = tracksToProcess.length;
            const limitToProcess = Math.min(originalCount, maxTracksForPlaylist, remainingLimit);

            if (limitToProcess < originalCount) {
                 await safeSendMessage(userId, `ℹ️ В плейлисте ${originalCount} треков. С учетом вашего тарифа и дневного лимита будет загружено: ${limitToProcess}.`);
            }
            tracksToProcess = tracksToProcess.slice(0, limitToProcess);
        } else {
            tracksToProcess.push({
                url: info.webpage_url || url, trackId: info.id,
                trackName: sanitizeFilename(info.title).slice(0, TRACK_TITLE_LIMIT),
                uploader: info.uploader
            });
        }
        
        if (tracksToProcess.length === 0) {
            return await safeSendMessage(userId, 'Не удалось найти треки для загрузки.');
        }

        const tasksFromCache = [];
        const tasksToDownload = [];
        for (const track of tracksToProcess) {
            const cached = await findCachedTrack(track.url);
            if (cached) {
                tasksFromCache.push({ ...track, ...cached });
            } else {
                tasksToDownload.push(track);
            }
        }
        
        if (tasksFromCache.length > 0) {
            let sentFromCacheCount = 0;
            const userForCache = await getUser(userId);
            let remainingLimitForCache = userForCache.premium_limit - (userForCache.downloads_today || 0);

            for (const track of tasksFromCache) {
                if (remainingLimitForCache <= 0) break;
                try {
                    await bot.telegram.sendAudio(userId, track.fileId, { title: track.trackName, performer: track.uploader });
                    await incrementDownloadsAndSaveTrack(userId, track.trackName, track.fileId, track.url);
                    sentFromCacheCount++;
                    remainingLimitForCache--;
                } catch (err) {
                    if (err.response?.error_code === 403) { await updateUserField(userId, 'active', false); return; }
                    else if (err.description?.includes('FILE_REFERENCE_EXPIRED')) tasksToDownload.push(track);
                    else console.error(`⚠️ Ошибка отправки из кэша для ${userId}: ${err.message}`);
                }
            }
            if (sentFromCacheCount > 0) {
                await safeSendMessage(userId, `✅ ${sentFromCacheCount} трек(ов) отправлено мгновенно из кэша.`);
            }
        }
        
        if (tasksToDownload.length > 0) {
            const userAfterCache = await getUser(userId);
            const currentLimitAfterCache = userAfterCache.premium_limit - (userAfterCache.downloads_today || 0);
            if (currentLimitAfterCache <= 0) return await safeSendMessage(userId, '🚫 Ваш лимит исчерпан треками из кэша.');
            
            const tasksToReallyDownload = tasksToDownload.slice(0, currentLimitAfterCache);

            if (tasksToReallyDownload.length > 0) {
                await safeSendMessage(userId, `⏳ ${tasksToReallyDownload.length} трек(ов) добавлено в очередь. Вы получите их по мере готовности.`);
                
                if (isPlaylist && playlistInfo) {
                    const redisClient = redisService.getClient();
                    const playlistKey = `playlist:${userId}:${playlistInfo.id}`;
                    await redisClient.setEx(playlistKey, 3600, tasksToReallyDownload.length.toString());
                    await logEvent(userId, 'download_playlist');
                }
                
                for (const track of tasksToReallyDownload) {
                    downloadQueue.add({ userId, ...track, playlistInfo, priority: user.premium_limit });
                    if(!isPlaylist) await logEvent(userId, 'download');
                }
            }
        }
    } catch (err) {
        if (processingMessage) await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
        const errorMessage = err.stderr || err.message || '';
        if (err.name === 'TimeoutError' || errorMessage.includes('timed out')) {
            console.error(`❌ Таймаут в enqueue для ${userId}:`, errorMessage);
            await safeSendMessage(userId, '❌ Ошибка: SoundCloud отвечает слишком долго. Попробуйте позже.');
        } else if (errorMessage.includes('404: Not Found')) {
            console.warn(`[User Error] Трек не найден (404) для ${userId}.`);
            await safeSendMessage(userId, '❌ Трек по этой ссылке не найден.');
        } else {
            console.error(`❌ Глобальная ошибка в enqueue для ${userId}:`, err);
            await safeSendMessage(userId, `❌ Произошла ошибка при обработке ссылки.`);
        }
    }
}