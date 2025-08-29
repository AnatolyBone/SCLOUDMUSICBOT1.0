// services/spotifyManager.js (ФИНАЛЬНАЯ ВЕРСИЯ БЕЗ ЛИШНИХ ФЛАГОВ)

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET } from '../config.js';
import { downloadQueue } from './downloadManager.js';
import { logEvent } from '../db.js';

const execAsync = promisify(exec);

export async function spotifyEnqueue(ctx, userId, url) {
    try {
        await ctx.reply('🔍 Анализирую ссылку Spotify...');

        const tempFileName = `spotify_${userId}_${Date.now()}.spotdl`;
        const tempFilePath = path.join('uploads', tempFileName);
        
        // ======================= ГЛАВНОЕ ИСПРАВЛЕНИЕ ЗДЕСЬ =======================
        // Убираем флаг --no-lyrics, так как в v4 он не нужен
        const command = `spotdl save "${url}" --save-file "${tempFilePath}" --no-lyrics`;
        // =========================================================================

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
        console.error(`[Spotify Enqueue] Ошибка для ${userId} и url ${url}:`, error.stderr || error);
        await ctx.reply('❌ Произошла ошибка при обработке ссылки Spotify. Попробуйте еще раз.');
    }
}