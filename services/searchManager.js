// services/searchManager.js (ФИНАЛЬНАЯ РАБОЧАЯ ВЕРСИЯ 2.0)

import { exec } from 'child_process';
import { promisify } from 'util';
import { PROXY_URL } from '../config.js';
import { searchTracksInCache } from '../db.js';

const execAsync = promisify(exec);
const SEARCH_TIMEOUT_MS = 8000;

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
    console.log(`[Search Hybrid] INFO: Поиск в кэше по запросу: "${query}"`);
    const cachedTracks = await searchTracksInCache(query);

    if (cachedTracks && cachedTracks.length > 0) {
        console.log(`[Search Hybrid] OK: Найдено ${cachedTracks.length} треков в кэше.`);
        
        // ======================= ГЛАВНОЕ ИСПРАВЛЕНИЕ ЗДЕСЬ =======================
        // Формируем правильный объект типа InlineQueryResultCachedAudio
        // У него НЕТ полей title и performer, но есть caption.
        return cachedTracks.map(track => ({
            type: 'audio',
            id: `cache_${track.file_id.slice(-20)}_${Math.random()}`, // Уникальный ID
            audio_file_id: track.file_id,
            caption: `${track.title || 'Трек без названия'} - ${track.artist || 'Неизвестный исполнитель'}`
        }));
        // =========================================================================
    }

    console.log(`[Search Hybrid] WARN: В кэше ничего нет, переключаюсь на живой поиск.`);
    return await searchLiveOnSoundCloud(query);
}