// services/searchManager.js (НОВАЯ ГИБРИДНАЯ ВЕРСИЯ)

import { exec } from 'child_process';
import { promisify } from 'util';
import { PROXY_URL } from '../config.js';
import { searchTracksInCache } from '../db.js'; // Импортируем нашу новую функцию

const execAsync = promisify(exec);
const SEARCH_TIMEOUT_MS = 8000; // Вернем таймаут обратно, т.к. это запасной вариант

function escapeQuery(query) {
    return query.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

async function searchLiveOnSoundCloud(query) {
    console.log(`[Search Live] INFO: Выполняю живой поиск для: "${query}"`);
    try {
        const command = `yt-dlp --proxy "${PROXY_URL}" --dump-single-json "scsearch7:${escapeQuery(query)}"`;
        
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Search timeout')), SEARCH_TIMEOUT_MS)
        );
        
        const { stdout } = await Promise.race([
            execAsync(command, { maxBuffer: 1024 * 1024 * 5 }),
            timeoutPromise
        ]);
        
        const searchData = JSON.parse(stdout);
        if (!searchData || !searchData.entries) return [];

        // ВАЖНО: Результаты живого поиска - это статьи, отправляющие ссылку
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

export async function performInlineSearch(query) {
    // 1. СНАЧАЛА ИЩЕМ В НАШЕЙ БАЗЕ (КЭШЕ)
    console.log(`[Search Hybrid] INFO: Поиск в кэше по запросу: "${query}"`);
    const cachedTracks = await searchTracksInCache(query);

    if (cachedTracks && cachedTracks.length > 0) {
        console.log(`[Search Hybrid] OK: Найдено ${cachedTracks.length} треков в кэше.`);
        // ВАЖНО: Результаты из кэша - это аудиофайлы, отправляемые по file_id
        return cachedTracks.map(track => ({
            type: 'audio',
            id: `cache_${track.file_id}`,
            audio_file_id: track.file_id,
            title: track.title || 'Без названия',
            performer: track.artist || 'Unknown',
            // audio_duration: track.duration, // Можно добавить, если есть в базе
        }));
    }

    // 2. ЕСЛИ В КЭШЕ НИЧЕГО НЕТ, ИЩЕМ В SOUNDCLOUD
    console.log(`[Search Hybrid] WARN: В кэше ничего нет, переключаюсь на живой поиск.`);
    return await searchLiveOnSoundCloud(query);
}