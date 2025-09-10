// services/downloadManager.js (ФИНАЛЬНАЯ ВЕРСИЯ С ЕДИНОЙ ТОЧКОЙ ОБРАБОТКИ)

import { STORAGE_CHANNEL_ID, PROXY_URL } from '../config.js';
import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import PQueue from 'p-queue';
import {
    getUser,
    updateUserField,
    findCachedTrack,
    cacheTrack,
    incrementDownloadsAndSaveTrack
} from '../db.js';

// --- Инициализация ---
let botInstance;
export function initializeDownloadManager(bot) {
    botInstance = bot;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir); // Убедимся, что папка для кэша существует

const YTDL_TIMEOUT = 180;
const MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024;
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

// --- Главный воркер очереди ---

export async function trackDownloadProcessor(task) {
    // Внешний try...catch для защиты от "замерзания" очереди
    try {
        // --- 1. Извлекаем ВСЕ нужные данные из задачи в самом начале ---
        const { userId, source, url, originalUrl, metadata } = task;
        const { title, uploader, id: trackId, duration, thumbnail } = metadata;
        const roundedDuration = duration ? Math.round(duration) : undefined;
        
        // --- 2. Проверяем кэш ---
        const cacheKey = originalUrl || url;
        const cached = await findCachedTrack(cacheKey);
        
        if (cached) {
            console.log(`[Worker/Cache] Отправляю "${cached.title || title}" из кэша для ${userId}`);
            try {
                const user = await getUser(userId);
                if (user.downloads_today < user.premium_limit) {
                    await botInstance.telegram.sendAudio(userId, cached.fileId, { title: cached.title, performer: cached.artist });
                    await incrementDownloadsAndSaveTrack(userId, cached.title, cached.fileId, cacheKey);
                } else {
                    await botInstance.telegram.sendMessage(userId, `Трек "${cached.title}" найден в кэше, но ваш дневной лимит исчерпан.`);
                }
                return; // Успешно выходим, если отправили из кэша
            } catch (e) {
                if (e.response?.error_code === 403) await updateUserField(userId, 'active', false);
                console.warn(`[Worker/Cache] Ошибка отправки из кэша для "${title}" (возможно, FILE_REFERENCE_EXPIRED), продолжаем скачивание...`);
            }
        }
        
        // --- 3. Если в кэше нет - скачиваем ---
        let tempFilePath = null;
        let statusMessage = null;
        
        try {
            statusMessage = await botInstance.telegram.sendMessage(userId, `⏳ Начинаю скачивание трека: "${title}"`).catch(() => null);
            console.log(`[Worker] Скачиваю "${title}" для ${userId}`);
            
            const tempFileName = `${trackId || 'track'}-${crypto.randomUUID()}.mp3`;
            tempFilePath = path.join(cacheDir, tempFileName);
            
            await ytdl(url, {
                output: tempFilePath,
                extractAudio: true,
                audioFormat: 'mp3',
                embedThumbnail: true,
                retries: 3,
                "socket-timeout": YTDL_TIMEOUT,
                'user-agent': FAKE_USER_AGENT,
                proxy: PROXY_URL || undefined,
            });
            
            if (!fs.existsSync(tempFilePath)) throw new Error(`Файл не был создан.`);
            const stats = await fs.promises.stat(tempFilePath);
            if (stats.size > MAX_FILE_SIZE_BYTES) throw new Error(`FILE_TOO_LARGE`);
            
            if (statusMessage) await botInstance.telegram.editMessageText(userId, statusMessage.message_id, undefined, `✅ Скачал. Отправляю...`).catch(() => {});
            
            const sentToUserMessage = await botInstance.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
                title, performer: uploader || 'Unknown Artist', duration: roundedDuration
            });
            
            if (statusMessage) await botInstance.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
            
            if (sentToUserMessage?.audio?.file_id) {
                await incrementDownloadsAndSaveTrack(userId, title, sentToUserMessage.audio.file_id, cacheKey);
                if (STORAGE_CHANNEL_ID) {
                    try {
                        const sentToStorage = await botInstance.telegram.sendAudio(STORAGE_CHANNEL_ID, sentToUserMessage.audio.file_id);
                        await cacheTrack({ url: cacheKey, fileId: sentToStorage.audio.file_id, title, artist: uploader, duration: roundedDuration, thumbnail });
                        console.log(`✅ [Cache] Трек "${title}" успешно закэширован.`);
                    } catch (e) { console.error(`❌ [Cache] Ошибка при кэшировании трека "${title}":`, e.message); }
                }
            }
        } catch (err) {
            const errorDetails = err.stderr || err.message || '';
            let userErrorMessage = `❌ Не удалось обработать трек: "${title}"`;
            if (errorDetails.includes('FILE_TOO_LARGE')) userErrorMessage += '. Он слишком большой.';
            else if (errorDetails.includes('timed out')) userErrorMessage += '. Ошибка сети.';
            else if (errorDetails.includes('geo restriction')) userErrorMessage += '. Трек недоступен в вашем регионе.';
            console.error(`❌ Ошибка воркера при обработке "${title}":`, errorDetails);
            if (statusMessage) await botInstance.telegram.editMessageText(userId, statusMessage.message_id, undefined, userErrorMessage).catch(() => {});
            else await botInstance.telegram.sendMessage(userId, userErrorMessage).catch(() => {});
        } finally {
            if (tempFilePath && fs.existsSync(tempFilePath)) {
                fs.promises.unlink(tempFilePath).catch(e => console.error("Ошибка удаления временного файла:", e));
            }
        }
    } catch (e) {
        console.error('🔴 КРИТИЧЕСКАЯ НЕПЕРЕХВАЧЕННАЯ ОШИБКА В ВОРКЕРЕ!', e);
    }
}

// --- Экспорт очереди ---
export const downloadQueue = new PQueue({ concurrency: 1 });