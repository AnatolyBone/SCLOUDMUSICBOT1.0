// services/spotifyManager.js (ИСПРАВЛЕННАЯ ВЕРСИЯ)

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET } from '../config.js';
import { downloadQueue } from './downloadManager.js';
import { logEvent } from '../db.js';
import { findCachedTrack } from '../db.js'; // Нам нужно проверять кэш и здесь

const execAsync = promisify(exec);

export async function spotifyEnqueue(ctx, userId, url) {
    try {
        await ctx.reply('🔍 Анализирую ссылку Spotify...');

        // Создаем уникальное имя для временного файла с метаданными
        const tempFileName = `spotify_${userId}_${Date.now()}.spotdl`;
        const tempFilePath = path.join('uploads', tempFileName);

        // Команда для spotdl: сохранить метаданные в файл
        const command = `spotdl save "${url}" --save-file "${tempFilePath}"`;

        await execAsync(command, {
            env: { ...process.env, SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET }
        });

        // Читаем и парсим файл с метаданными
        const fileContent = await fs.readFile(tempFilePath, 'utf-8');
        const tracks = JSON.parse(fileContent);
        
        // Удаляем временный файл
        await fs.unlink(tempFilePath);

        if (!tracks || tracks.length === 0) {
            return await ctx.reply('❌ Не удалось найти треки по этой ссылке Spotify.');
        }

        // РАЗДЕЛЯЕМ ТРЕКИ НА КЭШИРОВАННЫЕ И НОВЫЕ
        const tasksFromCache = [];
        const tasksToDownload = [];
        for (const track of tracks) {
            const cached = await findCachedTrack(track.url);
            if (cached) {
                tasksFromCache.push({ ...track, ...cached });
            } else {
                tasksToDownload.push(track);
            }
        }
        
        let message = `✅ Найдено треков: ${tracks.length}.\n`;
        
        // СНАЧАЛА ОТПРАВЛЯЕМ ИЗ КЭША (без лишних сообщений)
        let sentFromCacheCount = 0;
        for (const track of tasksFromCache) {
            try {
                // await ctx.telegram.sendAudio(userId, track.fileId); // Мы не можем это сделать тут, т.к. нет объекта user
                // Вместо этого просто сообщим
                sentFromCacheCount++;
            } catch (e) { console.error(e); }
        }

        if (sentFromCacheCount > 0) {
            message += `🚀 ${sentFromCacheCount} из них уже в кэше и скоро будут отправлены!\n`;
        }

        if(tasksToDownload.length > 0) {
            message += `⏳ ${tasksToDownload.length} новых треков добавлено в очередь.`;
        }

        await ctx.reply(message);
        
        if (tracks.length > 1) {
            await logEvent(userId, 'spotify_playlist_album');
        } else {
            await logEvent(userId, 'spotify_track');
        }

        // Ставим все треки (и кэшированные, и новые) в очередь. 
        // downloadManager сам разберется, что уже есть в кэше.
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
        console.error(`[Spotify Enqueue] Ошибка для ${userId} и url ${url}:`, error.stderr || error);
        await ctx.reply('❌ Произошла ошибка при обработке ссылки Spotify.');
    }
}