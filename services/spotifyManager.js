// services/spotifyManager.js (ФИНАЛЬНАЯ РАБОЧАЯ ВЕРСИЯ)

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET } from '../config.js';
import { downloadQueue } from './downloadManager.js';
import { logEvent } from '../db.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));

async function ensureDirectoryExists(dirPath) {
    try {
        await fs.access(dirPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`[Spotify Manager] Директория ${dirPath} не найдена, создаю...`);
            await fs.mkdir(dirPath, { recursive: true });
        } else {
            throw error;
        }
    }
}

export async function spotifyEnqueue(ctx, userId, url) {
    let statusMessage = null;
    let tempFilePath = null;
    try {
        statusMessage = await ctx.reply('🔍 Анализирую ссылку Spotify...');

        const uploadDir = path.join(__dirname, '..', 'uploads');
        await ensureDirectoryExists(uploadDir);

        const tempFileName = `spotify_${userId}_${Date.now()}.spotdl`;
        tempFilePath = path.join(uploadDir, tempFileName);

        const command = `spotdl save "${url}" --save-file "${tempFilePath}"`;
        console.log(`[Spotify Manager] Выполняю команду для ${userId}: ${command}`);

        await execAsync(command, {
            env: { ...process.env, SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET }
        });

        const fileContent = await fs.readFile(tempFilePath, 'utf-8');
        const tracksMeta = JSON.parse(fileContent);

        if (!tracksMeta || tracksMeta.length === 0) {
            return await ctx.reply('❌ Не удалось найти треки по этой ссылке Spotify.');
        }

        await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, `✅ Найдено треков: ${tracksMeta.length}. Добавляю в очередь...`);

        if (tracksMeta.length > 1) {
            await logEvent(userId, 'spotify_playlist_album');
        } else {
            await logEvent(userId, 'spotify_track');
        }

        for (const track of tracksMeta) {
            // ФОРМИРУЕМ ПОИСКОВЫЙ ЗАПРОС ДЛЯ YT-DLP
            const searchQuery = `${track.artists.join(' ')} - ${track.name}`;
            const task = {
                userId,
                source: 'spotify',
                // ВАЖНО: передаем не ссылку Spotify, а поисковый запрос!
                // ytsearch1: говорит yt-dlp искать на YouTube и брать первое видео.
                url: `ytsearch1:"${searchQuery}"`, 
                // Сохраняем оригинальную ссылку для кэширования
                originalUrl: track.url,
                metadata: {
                    title: track.name,
                    uploader: track.artists.join(', '),
                    duration: Math.round(track.duration / 1000),
                    thumbnail: track.cover_url,
                    id: track.song_id // Spotify ID
                }
            };
            downloadQueue.add(task);
        }

    } catch (error) {
        console.error(`[Spotify Manager] Ошибка для ${userId} с URL ${url}:`, error.stderr || error);
        if (statusMessage) {
            await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, '❌ Произошла ошибка при обработке ссылки Spotify. Попробуйте еще раз.');
        } else {
             await ctx.reply('❌ Произошла ошибка при обработке ссылки Spotify. Попробуйте еще раз.');
        }
    } finally {
        if (tempFilePath) {
            await fs.unlink(tempFilePath).catch(e => console.error(`Не удалось удалить временный файл ${tempFilePath}`, e));
        }
    }
}