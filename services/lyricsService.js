// src/services/lyricsService.js
import { Client } from "genius-lyrics";

// Берем токен из переменных окружения
const GENIUS_TOKEN = process.env.GENIUS_ACCESS_TOKEN;

const client = new Client(GENIUS_TOKEN);

export async function getLyrics(artist, title) {
    try {
        // Очищаем запрос от лишних слов
        const query = `${artist} ${title}`
            .replace(/\(Instrumental\)/gi, '')
            .replace(/\(Minus\)/gi, '')
            .replace(/\(Karaoke\)/gi, '')
            .trim();
        
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
