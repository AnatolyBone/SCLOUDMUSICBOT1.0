// services/downloadManager.js

import { STORAGE_CHANNEL_ID, PROXY_URL } from '../config.js';
import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import PQueue from 'p-queue';
import {
    updateUserField,
    cacheTrack,
    incrementDownloadsAndSaveTrack
} from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

const YTDL_TIMEOUT = 180;
const MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024;
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

async function safeSendMessage(ctx, userId, text, extra = {}) {
    try {
        if (!ctx || !ctx.telegram?.sendMessage) return null;
        return await ctx.telegram.sendMessage(userId, text, extra);
    } catch (e) {
        if (e.response?.error_code === 403) await updateUserField(userId, 'active', false);
        else console.error(`[SafeSend] Ошибка отправки сообщения для ${userId}:`, e.message);
        return null;
    }
}

export async function trackDownloadProcessor(task) {
    const { userId, url, originalUrl, metadata, ctx } = task;
    const { title, uploader, id: trackId, duration } = metadata;
    let tempFilePath = null;
    let statusMessage = null;
    try {
        statusMessage = await safeSendMessage(ctx, userId, `⏳ Начинаю скачивание: "${title}"`);
        console.log(`[Worker] Получена задача для "${title}". URL: ${url}`);
        const tempFileName = `${trackId || 'track'}-${crypto.randomUUID()}.mp3`;
        tempFilePath = path.join(cacheDir, tempFileName);
        await ytdl(url, {
            output: tempFilePath,
            extractAudio: true, audioFormat: 'mp3', embedThumbnail: true,
            retries: 3, "socket-timeout": YTDL_TIMEOUT,
            'user-agent': FAKE_USER_AGENT, proxy: PROXY_URL || undefined,
        });
        if (!fs.existsSync(tempFilePath)) throw new Error(`Файл не был создан.`);
        const stats = await fs.promises.stat(tempFilePath);
        if (stats.size > MAX_FILE_SIZE_BYTES) throw new Error(`FILE_TOO_LARGE`);
        if (statusMessage) await ctx.telegram.editMessageText(userId, statusMessage.message_id, undefined, `✅ Скачал. Отправляю...`).catch(() => {});
        const sentToUserMessage = await ctx.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
            title: title, performer: uploader || 'Unknown Artist',
            duration: duration ? Math.round(duration) : undefined
        });
        if (statusMessage) await ctx.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
        const cacheKey = originalUrl || url;
        if (sentToUserMessage?.audio?.file_id) {
            await incrementDownloadsAndSaveTrack(userId, title, sentToUserMessage.audio.file_id, cacheKey);
            if (STORAGE_CHANNEL_ID) {
                cacheToChannel(ctx, sentToUserMessage.audio.file_id, { ...metadata, url: cacheKey });
            }
        }
    } catch (err) {
        let userErrorMessage = `❌ Не удалось обработать трек: "${title}"`;
        const errorDetails = err.stderr || err.message || '';
        if (errorDetails.includes('FILE_TOO_LARGE')) userErrorMessage += '. Он слишком большой.';
        else if (errorDetails.includes('timed out') || errorDetails.includes('Connection reset')) userErrorMessage += '. Проблема с сетью.';
        console.error(`❌ Ошибка воркера при обработке "${title}":`, errorDetails);
        if (statusMessage) await ctx.telegram.editMessageText(userId, statusMessage.message_id, undefined, userErrorMessage).catch(() => {});
        else await safeSendMessage(ctx, userId, userErrorMessage);
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.promises.unlink(tempFilePath).catch(e => console.error("Ошибка удаления временного файла:", e));
        }
    }
}

async function cacheToChannel(ctx, fileId, metadata) {
    const { title, uploader, duration, thumbnail, url: cacheKey } = metadata;
    try {
        const sentToStorageMessage = await ctx.telegram.sendAudio(STORAGE_CHANNEL_ID, fileId);
        if (sentToStorageMessage?.audio?.file_id) {
            await cacheTrack({ url: cacheKey, fileId: sentToStorageMessage.audio.file_id, title, artist: uploader, duration: duration ? Math.round(duration) : undefined, thumbnail });
            console.log(`✅ [Cache] Трек "${title}" успешно закэширован.`);
        }
    } catch (e) {
        console.error(`❌ [Cache] Ошибка при кэшировании трека "${title}":`, e.message);
    }
}

export const downloadQueue = new PQueue({ concurrency: 1 });