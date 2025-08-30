// services/spotifyManager.js

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
// Убираем импорт 'fileURLToPath', он больше не нужен
import { SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET } from '../config.js';
import { downloadQueue } from './downloadManager.js';
import { logEvent } from '../db.js';

const execAsync = promisify(exec);

// Вспомогательная функция для создания директории, если она не существует
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
    // Убрали вычисление абсолютного пути, оно больше не требуется

    try {
        await ctx.reply('🔍 Анализирую ссылку Spotify...');

        const uploadDir = 'uploads';
        await ensureDirectoryExists(uploadDir);

        const tempFileName = `spotify_${userId}_${Date.now()}.spotdl`;
        const tempFilePath = path.join(uploadDir, tempFileName);

        // ==> ГЛАВНОЕ ИЗМЕНЕНИЕ: Убираем флаг --config.
        // spotdl сам найдет config.toml в корневой папке.
        const command = `spotdl save "${url}" --save-file "${tempFilePath}"`;
        
        console.log(`[Spotify Manager] Выполняю команду для ${userId}: ${command}`);

        await execAsync(command, {
            env: { ...process.env, SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET }
        });

        const fileContent = await fs.readFile(tempFilePath, 'utf-8');
        await fs.unlink(tempFilePath);

        const tracks = JSON.parse(fileContent);

        if (!tracks || tracks.length === 0) {
            return await ctx.reply('❌ Не удалось найти треки по этой ссылке Spotify.');
        }

        await ctx.reply(`✅ Найдено треков: ${tracks.length}. Добавляю в очередь...`);

        if (tracks.length > 1) {
            await logEvent(userId, 'spotify_playlist_album');
        } else {
            await logEvent(userId, 'spotify_track');
        }

        for (const track of tracks) {
            const task = {
                userId,
                source: 'spotify',
                spotifyUrl: track.url,
                metadata: {
                    title: track.name,
                    uploader: track.artists.join(', '),
                    duration: Math.round(track.duration / 1000),
                    thumbnail: track.cover_url,
                    id: track.song_id
                }
            };
            downloadQueue.add(task);
        }

    } catch (error) {
        console.error(`[Spotify Manager] Произошла ошибка для пользователя ${userId} с URL ${url}.`);
        if (error.stdout) {
            console.error('STDOUT:', error.stdout);
        }
        if (error.stderr) {
            console.error('STDERR:', error.stderr);
        }
        if (!error.stdout && !error.stderr) {
            console.error('Полный объект ошибки:', error);
        }
        await ctx.reply('❌ Произошла ошибка при обработке ссылки Spotify. Попробуйте еще раз.');
    }
}