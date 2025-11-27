// src/services/lyricsService.js
import { Client } from "genius-lyrics";

const GENIUS_TOKEN = process.env.GENIUS_ACCESS_TOKEN;

// ВАЖНО: Отключаем оптимизацию, которая иногда вызывает сбои
const client = new Client(GENIUS_TOKEN); 

export async function getLyrics(artist, title) {
    try {
        const query = `${artist} ${title}`
            .replace(/\(Instrumental\)/gi, '')
            .replace(/\(Minus\)/gi, '')
            .replace(/\(Karaoke\)/gi, '')
            .trim();
        
        // Ищем песни (добавляем { optimizeQuery: true })
        const searches = await client.songs.search(query, { optimizeQuery: true });
        
        if (!searches || searches.length === 0) {
            return null;
        }

        const firstSong = searches[0];
        const lyrics = await firstSong.lyrics(); // Библиотека сама делает парсинг
        
        if (!lyrics) return null;

        return {
            text: lyrics,
            title: firstSong.title,
            artist: firstSong.artist.name,
            image: firstSong.thumbnail,
            url: firstSong.url
        };
    } catch (e) {
        // Если ошибка про throwOnError, значит библиотека сбоит, но мы просто вернем null
        console.error('[Lyrics] Error:', e.message);
        return null;
    }
}
