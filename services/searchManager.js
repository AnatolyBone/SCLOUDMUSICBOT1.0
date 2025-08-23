// services/searchManager.js

import { exec } from 'child_process';
import { promisify } from 'util';
import redis from './redisClient.js';
import { PROXY_URL } from '../config.js';

const execAsync = promisify(exec);
const CACHE_DURATION_SECONDS = 15 * 60; // Кэшируем результаты поиска на 15 минут

// Функция для безопасной очистки запроса для командной строки
function escapeQuery(query) {
    return query.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

export async function searchSoundCloud(query) {
    if (!query || query.trim().length < 2) {
        return [];
    }

    const cacheKey = `inline-search:${query.trim().toLowerCase()}`;
    try {
        const cachedResults = await redis.get(cacheKey);
        if (cachedResults) {
            console.log(`[Search] Найден кэш для запроса: "${query}"`);
            return JSON.parse(cachedResults);
        }
    } catch (e) {
        console.error('[Search] Ошибка Redis при получении кэша:', e.message);
    }

    console.log(`[Search] Выполняю поиск для: "${query}"`);
    try {
        // Ищем топ-7 результатов на SoundCloud, получаем метаданные в формате JSON
        // Используем --dump-single-json вместо --dump-json для получения одного JSON-массива
        const command = `yt-dlp --proxy "${PROXY_URL}" --dump-single-json "scsearch7:${escapeQuery(query)}"`;
        
        const { stdout } = await execAsync(command, { maxBuffer: 1024 * 1024 * 5 }); // 5MB buffer
        
        const searchData = JSON.parse(stdout);
        if (!searchData || !searchData.entries) {
            return [];
        }

        const results = searchData.entries.map(track => ({
            type: 'article',
            id: track.id,
            title: track.title || 'Без названия',
            description: `by ${track.uploader || 'Unknown'} (${track.duration_string || 'N/A'})`,
            thumb_url: track.thumbnail,
            input_message_content: {
                message_text: track.webpage_url,
            },
        }));

        try {
            await redis.setex(cacheKey, CACHE_DURATION_SECONDS, JSON.stringify(results));
        } catch (e) {
            console.error('[Search] Ошибка Redis при сохранении кэша:', e.message);
        }

        return results;

    } catch (error) {
        console.error(`[Search] Ошибка при поиске через yt-dlp для запроса "${query}":`, error.message);
        return [];
    }
}