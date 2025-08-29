// services/spotifyManager.js

import { exec } from 'child_process';
import { promisify } from 'util';
import { SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET } from '../config.js';
import { downloadQueue } from './downloadManager.js';
import { logEvent } from '../db.js';

const execAsync = promisify(exec);

// Функция для постановки задач из Spotify в общую очередь
export async function spotifyEnqueue(ctx, userId, url) {
    try {
        await ctx.reply('🔍 Анализирую ссылку Spotify...');

        // Команда для spotdl: получить метаданные в виде JSON, не скачивая файлы
        const command = `spotdl --print-json "${url}"`;

        const { stdout } = await execAsync(command, {
            env: {
                ...process.env,
                SPOTIPY_CLIENT_ID,
                SPOTIPY_CLIENT_SECRET
            }
        });

        // spotdl может вернуть несколько JSON-объектов, по одному на строку
        const tracks = stdout.trim().split('\n').map(line => JSON.parse(line));

        if (!tracks || tracks.length === 0) {
            return await ctx.reply('❌ Не удалось найти треки по этой ссылке Spotify.');
        }

        await ctx.reply(`✅ Найдено треков: ${tracks.length}. Добавляю в очередь...`);
        
        // Логируем событие
        if (tracks.length > 1) {
            await logEvent(userId, 'spotify_playlist_album');
        } else {
            await logEvent(userId, 'spotify_track');
        }

        // Ставим каждый трек в нашу СУЩЕСТВУЮЩУЮ очередь
        for (const track of tracks) {
            // Формируем "задачу" в понятном для downloadManager формате
            const task = {
                userId,
                source: 'spotify', // Новый флаг, чтобы воркер знал, откуда задача
                spotifyUrl: track.url, // Ссылка на конкретный трек
                metadata: {
                    title: track.name,
                    uploader: track.artists.join(', '),
                    duration: Math.round(track.duration / 1000), // Конвертируем мс в секунды
                    thumbnail: track.cover_url,
                    id: track.song_id // Используем ID Spotify
                }
            };
            downloadQueue.add(task);
        }
    } catch (error) {
        console.error(`[Spotify Enqueue] Ошибка для ${userId} и url ${url}:`, error);
        await ctx.reply('❌ Произошла ошибка при обработке ссылки Spotify. Возможно, ссылка неверна или трек недоступен.');
    }
}