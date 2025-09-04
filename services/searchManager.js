// services/searchManager.js (ФИНАЛЬНАЯ ВЕРСИЯ С ЛОГИРОВАНИЕМ)

import { exec } from 'child_process';
import { promisify } from 'util';
import { PROXY_URL } from '../config.js';
// Импортируем наши новые функции
import { searchTracksInCache, logSearchQuery, logFailedSearch } from '../db.js';

const execAsync = promisify(exec);
const SEARCH_TIMEOUT_MS = 8000;

function escapeQuery(query) {
    return query.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

async function searchLiveOnSoundCloud(query) {
    console.log(`[Search Live] INFO: Выполняю живой поиск для: "${query}"`);
    try {
        // Убрал --proxy отсюда, т.к. ytdl-exec/spotdl лучше управляют им через переменные окружения
        const command = `yt-dlp --dump-single-json "scsearch7:${escapeQuery(query)}"`;

        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Search timeout')), SEARCH_TIMEOUT_MS)
        );

        const { stdout } = await Promise.race([
            execAsync(command, { maxBuffer: 1024 * 1024 * 5, env: { ...process.env, HTTP_PROXY: PROXY_URL, HTTPS_PROXY: PROXY_URL } }),
            timeoutPromise
        ]);

        const searchData = JSON.parse(stdout);
        if (!searchData || !searchData.entries) return [];

        return searchData.entries.map(track => ({
            type: 'article',
            id: `url_${track.id}`,
            title: track.title || 'Без названия',
            description: `by ${track.uploader || 'Unknown'} (${track.duration_string || 'N/A'})`,
            thumb_url: track.thumbnail || 'https://i.imgur.com/8l4n5pG.png',
            input_message_content: {
                message_text: track.webpage_url,
            },
        }));
    } catch (error) {
        console.error(`[Search Live] ERROR: Ошибка живого поиска для "${query}":`, error.message);
        return [];
    }
}

// Теперь функция принимает userId для логирования
export async function performInlineSearch(query, userId) {
    console.log(`[Search Hybrid] INFO: Поиск в кэше по запросу: "${query}"`);
    let results = [];
    let foundInCache = false;
    
    const cachedTracks = await searchTracksInCache(query);

    if (cachedTracks && cachedTracks.length > 0) {
        console.log(`[Search Hybrid] OK: Найдено ${cachedTracks.length} треков в кэше.`);
        results = cachedTracks;
        foundInCache = true;
    } else {
        console.log(`[Search Hybrid] WARN: В кэше ничего нет, переключаюсь на живой поиск.`);
        results = await searchLiveOnSoundCloud(query);
        foundInCache = false;
    }
    
    // === ЛОГИРОВАНИЕ ВСЕХ ЗАПРОСОВ ===
    await logSearchQuery({
        query,
        userId,
        resultsCount: results.length,
        foundInCache: foundInCache
    });
    
    // === ЛОГИРОВАНИЕ НЕУДАЧНЫХ ЗАПРОСОВ ===
    if (results.length === 0) {
        console.log(`[Search] Полный провал поиска для запроса: "${query}"`);
        await logFailedSearch({
            query: query,
            searchType: 'inline'
        });
    }

    // Форматируем результат для Telegram
    if (foundInCache) {
        return results.map(track => ({
            type: 'audio',
            id: `cache_${track.file_id.slice(-20)}_${Math.random()}`,
            audio_file_id: track.file_id,
            caption: `via @SCloudMusicBot` // <-- ЗАМЕНИ SCloudMusicBot на реальный юзернейм твоего бота
        }));
    } else {
        return results; // searchLiveOnSoundCloud уже возвращает в правильном формате
    }
}