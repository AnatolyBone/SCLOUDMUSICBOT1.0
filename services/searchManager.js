// services/searchManager.js (ОТЛАДОЧНАЯ ВЕРСИЯ С ЛОГАМИ И ТАЙМАУТОМ)

import { exec } from 'child_process';
import { promisify } from 'util';
import redis from './redisClient.js';
import { PROXY_URL } from '../config.js';

const execAsync = promisify(exec);
const CACHE_DURATION_SECONDS = 15 * 60;
const SEARCH_TIMEOUT_MS = 8000; // Таймаут 8 секунд (Telegram ждет ~10)

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
            console.log(`[Search] OK: Найден кэш для запроса: "${query}"`);
            return JSON.parse(cachedResults);
        }
    } catch (e) {
        console.error('[Search] ERROR: Ошибка Redis при получении кэша:', e.message);
    }

    console.log(`[Search] INFO: Выполняю поиск для: "${query}"`);
    try {
        const command = `yt-dlp --proxy "${PROXY_URL}" --dump-single-json "scsearch7:${escapeQuery(query)}"`;
        console.log(`[Search] INFO: Запускаю команду: ${command}`);

        // ИЗМЕНЕНИЕ: Добавляем Promise.race для реализации таймаута
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
            console.log('[Search] WARN: yt-dlp вернул пустой или некорректный результат.');
            return [];
        }

        const results = searchData.entries.map(track => ({
            type: 'article',
            id: track.id,
            title: track.title || 'Без названия',
            description: `by ${track.uploader || 'Unknown'} (${track.duration_string || 'N/A'})`,
            thumb_url: track.thumbnail || 'https://i.imgur.com/8l4n5pG.png', // Добавил заглушку
            input_message_content: {
                message_text: track.webpage_url,
            },
        }));

        try {
            await redis.setex(cacheKey, CACHE_DURATION_SECONDS, JSON.stringify(results));
        } catch (e) {
            console.error('[Search] ERROR: Ошибка Redis при сохранении кэша:', e.message);
        }

        return results;

    } catch (error) {
        // ИЗМЕНЕНИЕ: Более подробное логирование ошибок
        if (error.message === 'Search timeout') {
            console.error(`[Search] ERROR: Поиск по запросу "${query}" превысил таймаут в ${SEARCH_TIMEOUT_MS} мс.`);
        } else {
            console.error(`[Search] FATAL: Критическая ошибка при поиске через yt-dlp для запроса "${query}":`);
            console.error(' - Message:', error.message);
            if (error.stderr) {
                console.error(' - Stderr:', error.stderr);
            }
        }
        return [];
    }
}