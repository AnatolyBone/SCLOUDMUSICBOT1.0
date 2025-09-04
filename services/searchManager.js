// services/searchManager.js (ФИНАЛЬНАЯ ВЕРСИЯ С ИСПРАВЛЕННЫМ ПОИСКОМ)

// Вместо 'exec' импортируем нашу рабочую обертку
import ytdl from 'youtube-dl-exec';
import { PROXY_URL } from '../config.js';
import { searchTracksInCache, logSearchQuery, logFailedSearch } from '../db.js';

const SEARCH_TIMEOUT_MS = 8000; // 8 секунд

async function searchLiveOnSoundCloud(query) {
    console.log(`[Search Live] INFO: Выполняю живой поиск для: "${query}"`);
    try {
        // Создаем Promise с таймаутом
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Search timeout')), SEARCH_TIMEOUT_MS)
        );

        // Используем ytdl для поиска. Он сам найдет yt-dlp и правильно его вызовет.
        const ytdlPromise = ytdl(`scsearch7:${query}`, {
            dumpSingleJson: true,
            proxy: PROXY_URL || undefined
        });

        // Запускаем "гонку" между поиском и таймаутом
        const searchData = await Promise.race([
            ytdlPromise,
            timeoutPromise
        ]);

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
        // Если ошибка - это наш кастомный таймаут, выводим соответствующее сообщение
        if (error.message === 'Search timeout') {
            console.warn(`[Search Live] WARN: Таймаут поиска для "${query}"`);
        } else {
            console.error(`[Search Live] ERROR: Ошибка живого поиска для "${query}":`, error.stderr || error.message);
        }
        return [];
    }
}

// Эта функция остается почти без изменений
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
    
    // Логирование запросов (остается без изменений)
    await logSearchQuery({
        query,
        userId,
        resultsCount: results.length,
        foundInCache: foundInCache
    });
    
    if (results.length === 0) {
        console.log(`[Search] Полный провал поиска для запроса: "${query}"`);
        await logFailedSearch({
            query: query,
            searchType: 'inline'
        });
    }

    // Форматирование результата (остается без изменений)
    if (foundInCache) {
        return results.map(track => ({
            type: 'audio',
            id: `cache_${track.file_id.slice(-20)}_${Math.random()}`,
            audio_file_id: track.file_id,
            caption: `via @SCloudMusicBot` // <-- ЗАМЕНИТЕ НА ЮЗЕРНЕЙМ ВАШЕГО БОТА
        }));
    } else {
        return results;
    }
}