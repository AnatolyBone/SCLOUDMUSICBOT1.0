// services/downloadManager.js (ФИНАЛЬНАЯ ГИБРИДНАЯ ВЕРСИЯ - ПОЛНЫЙ КОД)

import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME, SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET, PROXY_URL, ADMIN_ID } from '../config.js';
import { Markup } from 'telegraf';
import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import {
    getUser, resetDailyLimitIfNeeded, logEvent, updateUserField,
    findCachedTrack, cacheTrack, incrementDownloadsAndSaveTrack
} from '../db.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

const YTDL_TIMEOUT = 120; // Увеличим на всякий случай
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

// services/downloadManager.js -> ЗАМЕНИТЬ ФУНКЦИЮ trackDownloadProcessor

const MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024; // 49 МБ - безопасный лимит для Telegram

async function trackDownloadProcessor(task) {
    const { userId, source, metadata } = task;
    const { title, uploader, id: trackId, duration, thumbnail } = metadata;
    const roundedDuration = duration ? Math.round(duration) : undefined;
    
    let tempFilePath = null;
    let tempDownloadDir = null; // Для Spotify
    let statusMessage = null;
    
    try {
        statusMessage = await safeSendMessage(userId, `⏳ Начинаю скачивание трека: "${title}"`);
        console.log(`[Worker] Начинаю скачивание "${title}" (источник: ${source})`);
        
        if (source === 'spotify') {
            tempDownloadDir = path.join(cacheDir, crypto.randomUUID());
            await fs.promises.mkdir(tempDownloadDir, { recursive: true });
            
            // РЕШЕНИЕ №1: Добавляем поиск по YouTube, чтобы повысить шансы найти трек
            const command = `spotdl download "${task.spotifyUrl}" --audio youtube youtube-music`;
            
            const execOptions = {
                cwd: tempDownloadDir,
                env: { ...process.env, SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET }
            };
            
            if (PROXY_URL) {
                console.log('[Worker] Устанавливаю HTTP_PROXY и HTTPS_PROXY для spotdl.');
                execOptions.env['HTTP_PROXY'] = PROXY_URL;
                execOptions.env['HTTPS_PROXY'] = PROXY_URL;
            }
            
            console.log(`[Worker] Выполняю команду spotdl: ${command} в директории ${tempDownloadDir}`);
            await execAsync(command, execOptions);
            
            const files = await fs.promises.readdir(tempDownloadDir);
            const downloadedFile = files.find(f => f.endsWith('.mp3'));
            
            if (!downloadedFile) {
                throw new Error('spotdl не смог найти и скачать подходящий трек.');
            }
            tempFilePath = path.join(tempDownloadDir, downloadedFile);
            console.log(`[Worker] spotdl успешно скачал файл: ${tempFilePath}`);
            
        } else { // Для SoundCloud
            const tempFileName = `${trackId}-${crypto.randomUUID()}.mp3`;
            tempFilePath = path.join(cacheDir, tempFileName);
            
            console.log(`[Worker] Использую ytdl для SoundCloud`);
            await ytdl(task.url, {
                output: tempFilePath,
                extractAudio: true,
                audioFormat: 'mp3',
                embedThumbnail: true,
                retries: 3,
                "socket-timeout": YTDL_TIMEOUT,
                'user-agent': FAKE_USER_AGENT,
                proxy: PROXY_URL || undefined,
            });
        }
        
        if (!fs.existsSync(tempFilePath)) throw new Error(`Файл не был создан: ${tempFilePath}`);
        
        // РЕШЕНИЕ №2: Проверяем размер файла ПЕРЕД отправкой в Telegram
        const stats = await fs.promises.stat(tempFilePath);
        if (stats.size > MAX_FILE_SIZE_BYTES) {
            console.warn(`[Worker] Файл "${title}" слишком большой (${(stats.size / 1024 / 1024).toFixed(2)} MB), отмена отправки.`);
            // Создаем кастомную ошибку, чтобы обработать ее в catch
            throw new Error(`FILE_TOO_LARGE`);
        }
        
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
        })();
        
    } catch (err) {
        let userErrorMessage = `❌ Не удалось обработать трек: "${title}"`;
        const errorDetails = err.stderr || err.message || '';
        
        // Обрабатываем нашу кастомную ошибку о размере файла
        if (errorDetails.includes('FILE_TOO_LARGE')) {
            userErrorMessage += '. Он слишком большой (более 50 МБ) и не может быть отправлен через Telegram.';
        } else if (errorDetails.includes('timed out')) {
            userErrorMessage += '. Причина: таймаут.';
        }
        
        console.error(`❌ Ошибка воркера при обработке "${title}":`, errorDetails);
        if (statusMessage) {
            await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, userErrorMessage).catch(() => {});
        } else {
            await safeSendMessage(userId, userErrorMessage);
        }
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath) && !tempDownloadDir) {
            fs.promises.unlink(tempFilePath).catch(err => console.error("Ошибка удаления временного файла SoundCloud:", err));
        }
        if (tempDownloadDir && fs.existsSync(tempDownloadDir)) {
            console.log(`[Worker] Удаляю временную директорию: ${tempDownloadDir}`);
            fs.promises.rm(tempDownloadDir, { recursive: true, force: true }).catch(err => console.error("Ошибка удаления временной директории Spotify:", err));
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
        
        const info = await ytdl(url, {
            dumpSingleJson: true,
            retries: 2,
            "socket-timeout": YTDL_TIMEOUT,
            'user-agent': FAKE_USER_AGENT,
            proxy: PROXY_URL || undefined
        });
        
        if (!info) throw new Error('Не удалось получить метаданные');
        
        // ИСПРАВЛЯЕМ ЛОГИЧЕСКУЮ ОШИБКУ, ЧТОБЫ SPOTIFY-ЗАДАЧИ ПРАВИЛЬНО ФОРМИРОВАЛИСЬ
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
                    // Передаем в очередь ВСЮ подготовленную задачу, а не только ее часть
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
            userMessage = '❌ Ошибка: Сервис отвечает слишком долго. Попробуйте позже.';
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