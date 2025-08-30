// services/downloadManager.js (ФИНАЛЬНАЯ ВЕРСИЯ С РАСШИРЕННЫМ ЛОГГИРОВАНИЕМ)

import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME, PROXY_URL, ADMIN_ID } from '../config.js';
import { Markup } from 'telegraf';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import {
    getUser, resetDailyLimitIfNeeded, logEvent, updateUserField,
    findCachedTrack, cacheTrack, incrementDownloadsAndSaveTrack
} from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

const YTDL_TIMEOUT = 180;
const TRACK_TITLE_LIMIT = 100;
const UNLIMITED_PLAYLIST_LIMIT = 100;
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

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

function spawnAsync(command, args) {
    return new Promise((resolve, reject) => {
        const process = spawn(command, args, { timeout: YTDL_TIMEOUT * 1000 });
        let stdout = '';
        let stderr = '';

        process.stdout.on('data', (data) => stdout += data.toString());
        process.stderr.on('data', (data) => stderr += data.toString());

        process.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                const error = new Error(`Command failed with exit code ${code}`);
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
            }
        });

        process.on('error', (err) => {
            if (err.code === 'ETIMEDOUT') {
                const timeoutError = new Error('Process timed out');
                timeoutError.name = 'TimeoutError';
                reject(timeoutError);
            } else {
                reject(err);
            }
        });
    });
}

async function trackDownloadProcessor(task) {
    const { userId, source, metadata } = task;
    const { title, uploader, id: trackId, duration, thumbnail } = metadata;
    const roundedDuration = duration ? Math.round(duration) : undefined;
    
    let tempFilePath = null;
    let statusMessage = null;
    
    try {
        statusMessage = await safeSendMessage(userId, `⏳ Начинаю скачивание трека: "${title}"`);
        console.log(`[Worker] Начинаю скачивание "${title}" (источник: ${source})`);
        
        const tempFileName = `${trackId}-${crypto.randomUUID()}.mp3`;
        tempFilePath = path.join(cacheDir, tempFileName);
        
        const command = 'yt-dlp';
        const args = [];
        
        if (source === 'spotify') {
            const searchQuery = `${title} ${uploader}`;
            console.log(`[Worker] Spotify трек. Ищу на YouTube Music по запросу: "${searchQuery}"`);
            args.push('--default-search', 'ytmsearch1', searchQuery);
        } else {
            args.push(task.url);
        }

        args.push(
            '--verbose', // <== ВОТ ЭТО ИЗМЕНЕНИЕ ДЛЯ ДЕТАЛЬНОЙ ДИАГНОСТИКИ
            '--max-downloads', '1',
            '-o', tempFilePath,
            '-x',
            '--audio-format', 'mp3',
            '--embed-thumbnail',
            '--retries', '3',
            '--socket-timeout', '30',
            '--user-agent', FAKE_USER_AGENT
        );

        if (PROXY_URL) {
            console.log(`[Worker] Использую прокси: ${PROXY_URL}`);
            args.push('--proxy', PROXY_URL);
        } else {
            console.log(`[Worker] Работаю без прокси.`);
        }
        
        console.log(`[Worker] Выполняю команду: ${command} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);
        
        await spawnAsync(command, args);
        
        if (!fs.existsSync(tempFilePath)) throw new Error(`Файл не был создан после выполнения yt-dlp`);
        
        if (statusMessage) await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, `✅ Скачал. Отправляю...`).catch(() => {});
        
        const sentToUserMessage = await bot.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
            title: title,
            performer: uploader || 'Unknown Artist',
            duration: roundedDuration
        });
        
        if (statusMessage) await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
        
        const cacheUrl = task.spotifyUrl || task.url;
        
        if (sentToUserMessage?.audio?.file_id) {
            await incrementDownloadsAndSaveTrack(userId, title, sentToUserMessage.audio.file_id, cacheUrl);
        }
        
        (async () => {
            if (STORAGE_CHANNEL_ID && sentToUserMessage?.audio?.file_id) {
                try {
                    console.log(`[Cache] Отправляю "${title}" в канал-хранилище...`);
                    const sentToStorageMessage = await bot.telegram.sendAudio(
                        STORAGE_CHANNEL_ID,
                        sentToUserMessage.audio.file_id
                    );
                    
                    if (sentToStorageMessage?.audio?.file_id) {
                        await cacheTrack({
                            url: cacheUrl,
                            fileId: sentToStorageMessage.audio.file_id,
                            title: title,
                            artist: uploader,
                            duration: roundedDuration,
                            thumbnail: thumbnail
                        });
                        console.log(`✅ [Cache] Трек "${title}" успешно закэширован.`);
                    }
                } catch (e) {
                    console.error(`❌ [Cache] Ошибка при кэшировании трека "${title}":`, e.message);
                }
            }
        })().finally(() => {
            if (fs.existsSync(tempFilePath)) {
                fs.promises.unlink(tempFilePath).catch(err => console.error("Ошибка удаления временного файла:", err));
            }
        });
        
    } catch (err) {
        let userErrorMessage = `❌ Не удалось обработать трек: "${title}"`;
        const errorDetails = err.stderr || err.message || ''; // stderr будет содержать детальный лог
        if (err.name === 'TimeoutError' || errorDetails.includes('timed out')) {
            userErrorMessage += '. Причина: таймаут.';
        } else if (errorDetails.includes('exit code 101')) {
            userErrorMessage += '. Причина: сетевая ошибка при скачивании.';
        }
        // Выводим в консоль полный детальный лог ошибки
        console.error(`❌ Ошибка воркера при обработке "${title}":\n---STDERR---\n${errorDetails}\n------------`);
        if (statusMessage) {
            await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, userErrorMessage).catch(() => {});
        } else {
            await safeSendMessage(userId, userErrorMessage);
        }
        
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath).catch(() => {});
        }
    }
}

export const downloadQueue = new TaskQueue({
    maxConcurrent: 1,
    taskProcessor: trackDownloadProcessor
});

export async function enqueue(ctx, userId, url) {
    let statusMessage = null;
    try {
        await resetDailyLimitIfNeeded(userId);
        let user = await getUser(userId);

        if (user.downloads_today >= user.premium_limit) {
            let message = T('limitReached');
            let bonusMessageText = '';
            if (!user.subscribed_bonus_used) {
                const cleanUsername = CHANNEL_USERNAME.replace('@', '');
                const channelLink = `[${CHANNEL_USERNAME}](https://t.me/${cleanUsername})`;
                bonusMessageText = `\n\n🎁 У тебя есть доступный бонус! Подпишись на ${channelLink} и получи *7 дней тарифа Plus*.`;
            }
            message = message.replace('{bonus_message}', bonusMessageText);
            const extra = { parse_mode: 'Markdown' };
            if (!user.subscribed_bonus_used) {
                extra.reply_markup = { inline_keyboard: [[ Markup.button.callback('✅ Я подписался, забрать бонус', 'check_subscription') ]] };
            }
            return await safeSendMessage(userId, message, extra);
        }

        statusMessage = await safeSendMessage(userId, '🔍 Получаю информацию о треке...');
        
        const infoArgs = [
            url,
            '--dump-single-json',
            '--retries', '2',
            '--socket-timeout', '20',
            '--user-agent', FAKE_USER_AGENT,
        ];
        
        if (PROXY_URL) {
            infoArgs.push('--proxy', PROXY_URL);
        }
        
        const { stdout } = await spawnAsync('yt-dlp', infoArgs);
        const info = JSON.parse(stdout);
        if (!info) throw new Error('Не удалось получить метаданные');
        
        const source = url.includes('spotify.com') ? 'spotify' : 'soundcloud';
        const isPlaylist = Array.isArray(info.entries);
        const entries = isPlaylist ? info.entries : [info];

        let tracksToProcess = entries
            .filter(e => e && (e.webpage_url || e.url))
            .map(e => ({
                url: e.webpage_url || e.url, 
                source: source,
                spotifyUrl: source === 'spotify' ? (e.webpage_url || e.url) : null,
                metadata: {
                    id: e.id,
                    title: sanitizeFilename(e.title || 'Unknown Title').slice(0, TRACK_TITLE_LIMIT),
                    uploader: e.uploader || e.artist || 'Unknown Artist',
                    duration: e.duration,
                    thumbnail: e.thumbnail,
                }
            }));
        
        if (tracksToProcess.length === 0) {
            return await safeSendMessage(userId, 'Не удалось найти треки для загрузки.');
        }

        if (isPlaylist) {
            let playlistLimit = Infinity;
            let originalCount = tracksToProcess.length;
            if (user.premium_limit <= 10) playlistLimit = 5;
            else if (user.premium_limit >= 10000) playlistLimit = UNLIMITED_PLAYLIST_LIMIT;
            
            const remainingDailyLimit = user.premium_limit - user.downloads_today;
            const limitToProcess = Math.min(originalCount, playlistLimit, remainingDailyLimit);

            if (limitToProcess < originalCount) {
                 await safeSendMessage(userId, `ℹ️ В плейлисте ${originalCount} треков. С учетом вашего тарифа и дневного лимита будет загружено: ${limitToProcess}.`);
            }
            tracksToProcess.length = limitToProcess;
        }
        
        if (statusMessage) {
            await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, '🔄 Проверяю кэш...').catch(() => {});
        }

        const tasksToDownload = [];
        let sentFromCacheCount = 0;

        for (const track of tracksToProcess) {
            const cacheKey = track.spotifyUrl || track.url;
            const cached = await findCachedTrack(cacheKey);

            if (cached) {
                user = await getUser(userId);
                if (user.downloads_today >= user.premium_limit) break;
                try {
                    await bot.telegram.sendAudio(userId, cached.fileId, { title: track.metadata.title, performer: track.metadata.uploader });
                    await incrementDownloadsAndSaveTrack(userId, track.metadata.title, cached.fileId, cacheKey);
                    sentFromCacheCount++;
                } catch (err) {
                    if (err.response?.error_code === 403) { await updateUserField(userId, 'active', false); return; }
                    else if (err.description?.includes('FILE_REFERENCE_EXPIRED')) tasksToDownload.push(track);
                    else console.error(`⚠️ Ошибка отправки из кэша для ${userId}: ${err.message}`);
                }
            } else {
                tasksToDownload.push(track);
            }
        }
        
       let finalMessage = '';
        if (sentFromCacheCount > 0) {
            finalMessage += `✅ ${sentFromCacheCount} трек(ов) отправлено из кэша.\n`;
        }
        
        if (tasksToDownload.length > 0) {
            user = await getUser(userId);
            const remainingLimit = user.premium_limit - user.downloads_today;
            
            if (remainingLimit > 0) {
                const tasksToReallyDownload = tasksToDownload.slice(0, remainingLimit);
                finalMessage += `⏳ ${tasksToReallyDownload.length} трек(ов) добавлено в очередь. Вы получите их по мере готовности.`;
                
                if (isPlaylist) await logEvent(userId, 'download_playlist');
                
                for (const track of tasksToReallyDownload) {
                    downloadQueue.add({ userId, ...track, priority: user.premium_limit });
                    if (!isPlaylist) await logEvent(userId, 'download');
                }
            } else if (sentFromCacheCount === 0) {
                finalMessage += `🚫 Ваш дневной лимит исчерпан.`;
            }
        }
        
        if (statusMessage) {
            await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, finalMessage || "Все треки отправлены.").catch(() => {});
        } else if (finalMessage) {
            await safeSendMessage(userId, finalMessage);
        }

    } catch (err) {
        const errorMessage = err.stderr || err.message || '';
        let userMessage = `❌ Произошла ошибка при обработке ссылки.`;
        if (err.name === 'TimeoutError' || errorMessage.includes('timed out')) {
            console.error(`❌ Таймаут в enqueue для ${userId}:`, errorMessage);
            userMessage = '❌ Ошибка: Сервис (SoundCloud/Spotify) отвечает слишком долго. Попробуйте позже.';
        } else if (errorMessage.includes('404: Not Found') || errorMessage.includes('403: Forbidden')) {
            console.warn(`[User Error] Трек не найден (404/403) для ${userId}.`);
            userMessage = '❌ Трек по этой ссылке не найден или доступ к нему ограничен.';
        } else {
            console.error(`❌ Глобальная ошибка в enqueue для ${userId}:`, err);
            try {
                const adminErrorMessage = `🔴 **Критическая ошибка загрузки!**\n\n` +
                                          `**Пользователь:** \`${userId}\`\n**URL:** \`${url}\`\n\n` +
                                          `**Текст ошибки:**\n\`\`\`\n${errorMessage.slice(0, 1000)}\n\`\`\``;
                await bot.telegram.sendMessage(ADMIN_ID, adminErrorMessage, { parse_mode: 'Markdown' });
            } catch (adminNotifyError) {
                console.error("!! Не удалось отправить уведомление об ошибке админу:", adminNotifyError.message);
            }
        }
        if (statusMessage) {
            await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, userMessage).catch(() => {});
        } else {
            await safeSendMessage(userId, userMessage);
        }
    }
}