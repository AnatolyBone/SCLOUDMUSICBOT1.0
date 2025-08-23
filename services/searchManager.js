// services/searchManager.js (ФИНАЛЬНАЯ РАБОЧАЯ ВЕРСИЯ)

import { exec } from 'child_process';
import { promisify } from 'util';
import redis from './redisClient.js'; // Мы предполагаем, что здесь экспортируется объект с client внутри
import { PROXY_URL } from '../config.js';

const execAsync = promisify(exec);
const CACHE_DURATION_SECONDS = 15 * 60; // Кэшируем результаты поиска на 15 минут
const SEARCH_TIMEOUT_MS = 9500; // УВЕЛИЧИЛИ ТАЙМАУТ до 9.5 секунд

function escapeQuery(query) {
    return query.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

export async function searchSoundCloud(query) {
    if (!query || query.trim().length < 2) {
        return [];
    }

    const cacheKey = `inline-search:${query.trim().toLowerCase()}`;
    try {
        // ИЗМЕНЕНИЕ 1: Исправляем вызов Redis
        const cachedResults = await redis.client.get(cacheKey);
        if (cachedResults) {
            console.log(`[Search] OK: Найден кэш для запроса: "${query}"`);
            return JSON.parse(cachedResults);
        }
    } catch (e) {
        console.error('[Search] ERROR: Ошибка Redis при получении кэша:', e.message);
    }

    console.log(`[Search] INFO: Выполняю поиск для: "${query}"`);
    try {
        const command = `yt-dlp --proxy "${PROXY_URL}" --dump-single-json "scsearch7:${escapeQuery(query)}"`;
        
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Search timeout')), SEARCH_TIMEOUT_MS)
        );
        
        const { stdout } = await Promise.race([
            execAsync(command, { maxBuffer: 1024 * 1024 * 5 }),
            timeoutPromise
        ]);
        
        console.log(`[Search] OK: Получен ответ от yt-dlp для запроса "${query}"`);

        const searchData = JSON.parse(stdout);
        if (!searchData || !searchData.entries) {
            return [];
        }

        const results = searchData.entries.map(track => ({
            type: 'article',
            id: track.id,
            title: track.title || 'Без названия',
            description: `by ${track.uploader || 'Unknown'} (${track.duration_string || 'N/A'})`,
            thumb_url: track.thumbnail || 'https://i.imgur.com/8l4n5pG.png',
            input_message_content: {
                message_text: track.webpage_url,
            },
        }));

        try {
            // ИЗМЕНЕНИЕ 1: Исправляем вызов Redis
            await redis.client.setex(cacheKey, CACHE_DURATION_SECONDS, JSON.stringify(results));
        } catch (e) {
            console.error('[Search] ERROR: Ошибка Redis при сохранении кэша:', e.message);
        }

        return results;

    } catch (error) {
        if (error.message === 'Search timeout') {
            console.error(`[Search] ERROR: Поиск по запросу "${query}" превысил таймаут в ${SEARCH_TIMEOUT_MS} мс.`);
        } else {
            console.error(`[Search] FATAL: Критическая ошибка при поиске через yt-dlp для запроса "${query}":`, error.message);
        }
        return [];
    }
}