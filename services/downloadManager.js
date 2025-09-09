// services/downloadManager.js (ФИНАЛЬНАЯ ВЕРСИЯ БЕЗ ЦИКЛИЧЕСКИХ ЗАВИСИМОСТЕЙ)

import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME, PROXY_URL } from '../config.js';
// import { bot } from '../bot.js'; // <-- УДАЛЕНА ЭТА СТРОКА, РАЗРЫВАЕМ ЦИКЛ
import { Markup } from 'telegraf';
import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import PQueue from 'p-queue';
import { T } from '../config/texts.js';
import {
    getUser, resetDailyLimitIfNeeded, logEvent, updateUserField,
    findCachedTrack, cacheTrack, incrementDownloadsAndSaveTrack
} from '../db.js';
import { spotifyEnqueue } from './spotifyManager.js';

// ДОБАВЛЕНА ЭТА ЧАСТЬ: создаем переменную и функцию для инициализации
let botInstance;
export function initializeDownloadManager(bot) {
    botInstance = bot;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

const YTDL_TIMEOUT = 180;
const MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024;
const UNLIMITED_PLAYLIST_LIMIT = 100;
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

function sanitizeFilename(name) {
    return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim();
}

async function safeSendMessage(userId, text, extra = {}) {
    try {
        if (!botInstance) throw new Error("Bot is not initialized in downloadManager");
        // ИСПОЛЬЗУЕМ botInstance ВМЕСТО bot
        return await botInstance.telegram.sendMessage(userId, text, extra);
    } catch (e) {
        if (e.response?.error_code === 403) await updateUserField(userId, 'active', false);
        else console.error(`[SafeSend] Ошибка отправки сообщения для ${userId}:`, e.message);
        return null;
    }
}

export async function trackDownloadProcessor(task) {
    const { userId, source, url, originalUrl, metadata } = task;
    const { title, uploader, id: trackId, duration, thumbnail } = metadata;
    const roundedDuration = duration ? Math.round(duration) : undefined;
    
    let tempFilePath = null;
    let statusMessage = null;
    
    try {
        statusMessage = await safeSendMessage(userId, `⏳ Начинаю скачивание трека: "${title}"`);
        console.log(`[Worker] Получена задача для "${title}" (источник: ${source}). URL: ${url}`);
        
        const tempFileName = `${trackId || 'track'}-${crypto.randomUUID()}.mp3`;
        tempFilePath = path.join(cacheDir, tempFileName);

        await ytdl(url, {
            output: tempFilePath, extractAudio: true, audioFormat: 'mp3',
            embedThumbnail: true, retries: 3, "socket-timeout": YTDL_TIMEOUT,
            'user-agent': FAKE_USER_AGENT, proxy: PROXY_URL || undefined,
        });
        
        if (!fs.existsSync(tempFilePath)) throw new Error(`Файл не был создан.`);
        const stats = await fs.promises.stat(tempFilePath);
        if (stats.size > MAX_FILE_SIZE_BYTES) throw new Error(`FILE_TOO_LARGE`);
        
        if (statusMessage) await botInstance.telegram.editMessageText(userId, statusMessage.message_id, undefined, `✅ Скачал. Отправляю...`).catch(() => {});
        
        const sentToUserMessage = await botInstance.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
            title, performer: uploader || 'Unknown Artist', duration: roundedDuration
        });
        
        if (statusMessage) await botInstance.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
        
        const cacheKey = originalUrl || url;
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
        console.error(`❌ Ошибка воркера при обработке "${title}":`, errorDetails);
        if (statusMessage) await botInstance.telegram.editMessageText(userId, statusMessage.message_id, undefined, userErrorMessage).catch(() => {});
        else await safeSendMessage(userId, userErrorMessage);
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.promises.unlink(tempFilePath).catch(e => console.error("Ошибка удаления временного файла:", e));
        }
    }
}

export async function enqueue(ctx, userId, url) {
    if (url.includes('spotify.com')) {
        return spotifyEnqueue(ctx, userId, url);
    }

    let statusMessage = null;
    try {
        await resetDailyLimitIfNeeded(userId);
        let user = await getUser(userId);

        if (user.downloads_today >= user.premium_limit) {
            let message = T('limitReached');
            let bonusMessageText = '';
            if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
                const cleanUsername = CHANNEL_USERNAME.replace('@', '');
                const channelLink = `[${CHANNEL_USERNAME}](https://t.me/${cleanUsername})`;
                bonusMessageText = `\n\n🎁 У тебя есть доступный бонус! Подпишись на ${channelLink} и получи *7 дней тарифа Plus*.`;
            }
            message = message.replace('{bonus_message}', bonusMessageText);
            const extra = { parse_mode: 'Markdown' };
            if (!user.subscribed_bonus_used) {
                extra.reply_markup = { inline_keyboard: [[ Markup.button.callback('✅ Я подписался, забрать бонус', 'check_subscription') ]] };
            }
            return await botInstance.telegram.sendMessage(userId, message, extra);
        }

        statusMessage = await botInstance.telegram.sendMessage(userId, '🔍 Получаю информацию о треке...');
        
        const info = await ytdl(url, {
            dumpSingleJson: true, retries: 2, "socket-timeout": YTDL_TIMEOUT,
            'user-agent': FAKE_USER_AGENT, proxy: PROXY_URL || undefined,
        });
        
        if (!info) throw new Error('Не удалось получить метаданные');
        
        const isPlaylist = Array.isArray(info.entries); 
        const entries = isPlaylist ? info.entries : [info];

        let tracksToProcess = entries.filter(e => e && (e.webpage_url || e.url)).map(e => ({
            url: e.webpage_url || e.url, 
            originalUrl: e.webpage_url || e.url, 
            source: 'soundcloud',
            metadata: {
                id: e.id, title: sanitizeFilename(e.title || 'Unknown Title'),
                uploader: e.uploader || 'Unknown Artist', duration: e.duration, thumbnail: e.thumbnail,
            }
        }));
        
        if (tracksToProcess.length === 0) return await botInstance.telegram.sendMessage(userId, 'Не удалось найти треки для загрузки.');

        if (isPlaylist) {
            let playlistLimit = Infinity;
            if (user.premium_limit <= 10) playlistLimit = 5;
            else if (user.premium_limit >= 10000) playlistLimit = UNLIMITED_PLAYLIST_LIMIT;
            const remainingDailyLimit = user.premium_limit - user.downloads_today;
            const limitToProcess = Math.min(tracksToProcess.length, playlistLimit, remainingDailyLimit);
            if (limitToProcess < tracksToProcess.length) {
                 await botInstance.telegram.sendMessage(userId, `ℹ️ В плейлисте ${tracksToProcess.length} треков. С учетом вашего тарифа и дневного лимита будет загружено: ${limitToProcess}.`);
            }
            tracksToProcess.length = limitToProcess;
        }
        
        if (statusMessage) await botInstance.telegram.editMessageText(userId, statusMessage.message_id, undefined, '🔄 Проверяю кэш...').catch(() => {});

        const tasksToDownload = [];
        let sentFromCacheCount = 0;

        for (const track of tracksToProcess) {
            const cached = await findCachedTrack(track.url);
            if (cached) {
                user = await getUser(userId);
                if (user.downloads_today >= user.premium_limit) break;
                try {
                    await botInstance.telegram.sendAudio(userId, cached.fileId, { title: track.metadata.title, performer: track.metadata.uploader });
                    await incrementDownloadsAndSaveTrack(userId, track.metadata.title, cached.fileId, track.url);
                    sentFromCacheCount++;
                } catch (err) {
                    if (err.description?.includes('FILE_REFERENCE_EXPIRED')) tasksToDownload.push(track);
                    else console.error(`⚠️ Ошибка отправки из кэша для ${userId}:`, err.message);
                }
            } else { tasksToDownload.push(track); }
        }
        
       let finalMessage = '';
        if (sentFromCacheCount > 0) finalMessage += `✅ ${sentFromCacheCount} трек(ов) отправлено из кэша.\n`;
        
        if (tasksToDownload.length > 0) {
            user = await getUser(userId);
            const remainingLimit = user.premium_limit - user.downloads_today;
            if (remainingLimit > 0) {
                const tasksToReallyDownload = tasksToDownload.slice(0, remainingLimit);
                finalMessage += `⏳ ${tasksToReallyDownload.length} трек(ов) добавлено в очередь.`;
                for (const task of tasksToReallyDownload) {
                    downloadQueue.add(() => trackDownloadProcessor({ userId, ctx, ...task }), { priority: user.premium_limit });
                }
            } else if (sentFromCacheCount === 0) { finalMessage += `🚫 Ваш дневной лимит исчерпан.`; }
        }
        
        if (statusMessage) await botInstance.telegram.editMessageText(userId, statusMessage.message_id, undefined, finalMessage || "Все треки отправлены.").catch(() => {});
        else if (finalMessage) await botInstance.telegram.sendMessage(userId, finalMessage);

    } catch (err) {
        const errorMessage = err.stderr || err.message || '';
        let userMessage = `❌ Произошла ошибка при обработке ссылки.`;
        if (errorMessage.includes('timed out')) userMessage = '❌ Ошибка сети при получении информации о треке.';
        else if (errorMessage.includes('404')) userMessage = '❌ Трек по этой ссылке не найден.';
        else console.error(`❌ Глобальная ошибка в enqueue для ${userId}:`, err);
        if (statusMessage) await botInstance.telegram.editMessageText(userId, statusMessage.message_id, undefined, userMessage).catch(() => {});
        else await botInstance.telegram.sendMessage(userId, userMessage);
    }
}

export const downloadQueue = new PQueue({ concurrency: 1 });