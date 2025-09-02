// services/spotifyManager.js (ФИНАЛЬНАЯ ВЕРСЯ БЕЗ SPOTDL)

import ytdl from 'youtube-dl-exec';
import { PROXY_URL } from '../config.js';
import { downloadQueue } from './downloadManager.js';
import { logEvent } from '../db.js';

// Вспомогательная функция для очистки имени файла
function sanitizeFilename(name) {
    return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim();
}

export async function spotifyEnqueue(ctx, userId, url) {
    let statusMessage = null;
    try {
        statusMessage = await ctx.reply('🔍 Анализирую ссылку Spotify...');

        // Получаем метаданные с помощью ytdl (он умеет работать со ссылками Spotify)
        const info = await ytdl(url, {
            dumpSingleJson: true,
            retries: 2,
            "socket-timeout": 120,
            proxy: PROXY_URL || undefined
        });
        
        if (!info) throw new Error('Не удалось получить метаданные из Spotify.');

        const isPlaylist = Array.isArray(info.entries);
        const entries = isPlaylist ? info.entries : [info];

        const tracks = entries
            .filter(e => e && (e.webpage_url || e.url))
            .map(track => ({
                userId,
                source: 'spotify',
                url: track.webpage_url || track.url, // Оригинальная ссылка на Spotify
                metadata: {
                    title: sanitizeFilename(track.title || 'Unknown Title'),
                    uploader: track.artist || track.uploader || 'Unknown Artist',
                    duration: Math.round(track.duration),
                    thumbnail: track.thumbnail,
                    id: track.id
                }
            }));

        if (!tracks || tracks.length === 0) {
            return await ctx.reply('❌ Не удалось найти треки по этой ссылке Spotify.');
        }

        await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, `✅ Найдено треков: ${tracks.length}. Добавляю в очередь...`);

        if (tracks.length > 1) {
            await logEvent(userId, 'spotify_playlist_album');
        } else {
            await logEvent(userId, 'spotify_track');
        }

        // Добавляем каждый трек в нашу единую очередь
        for (const task of tracks) {
            downloadQueue.add(task);
        }

    } catch (error) {
        console.error(`[Spotify Manager] Произошла ошибка для пользователя ${userId} с URL ${url}.`);
        if (error.stderr) {
            console.error('STDERR:', error.stderr);
        } else {
            console.error('Полный объект ошибки:', error);
        }
        if (statusMessage) {
            await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, '❌ Произошла ошибка при обработке ссылки Spotify. Попробуйте еще раз.');
        } else {
            await ctx.reply('❌ Произошла ошибка при обработке ссылки Spotify. Попробуйте еще раз.');
        }
    }
}