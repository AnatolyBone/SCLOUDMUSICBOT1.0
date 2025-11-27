// src/services/lyricsService.js
import { Client } from "genius-lyrics";

// Если есть ключ - вставь, если нет - оставь пустым (библиотека попробует работать так)
const client = new Client(); 

export async function getLyrics(artist, title) {
    try {
        const query = `${artist} ${title}`.replace(/\(Instrumental\)/gi, '').trim();
        
        // Ищем песни
        const searches = await client.songs.search(query);
        
        if (!searches || searches.length === 0) {
            return null;
        }

        // Берем первый результат
        const firstSong = searches[0];
        
        // Получаем текст
        const lyrics = await firstSong.lyrics();
        
        if (!lyrics) return null;

        return {
            text: lyrics,
            title: firstSong.title,
            artist: firstSong.artist.name,
            image: firstSong.thumbnail,
            url: firstSong.url
        };
    } catch (e) {
        console.error('[Lyrics] Error:', e.message);
        return null;
    }
}
