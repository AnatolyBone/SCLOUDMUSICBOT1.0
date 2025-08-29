// services/spotifyManager.js

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET } from '../config.js';
import { downloadQueue } from './downloadManager.js';
import { logEvent } from '../db.js';

const execAsync = promisify(exec);

// Вспомогательная функция для создания директории, если она не существует
async function ensureDirectoryExists(dirPath) {
    try {
        // Пытаемся получить доступ к директории. Если ее нет, возникнет ошибка.
        await fs.access(dirPath);
    } catch (error) {
        // Если ошибка "ENOENT" (Error NO ENTry), значит, директории нет
        if (error.code === 'ENOENT') {
            console.log(`[Spotify Manager] Директория ${dirPath} не найдена, создаю...`);
            // Создаем директорию, включая все родительские папки, если нужно
            await fs.mkdir(dirPath, { recursive: true });
        } else {
            // Если другая ошибка, пробрасываем ее дальше
            throw error;
        }
    }
}

export async function spotifyEnqueue(ctx, userId, url) {
    try {
        await ctx.reply('🔍 Анализирую ссылку Spotify...');

        // Убедимся, что директория 'uploads' для временных файлов существует
        const uploadDir = 'uploads';
        await ensureDirectoryExists(uploadDir);

        const tempFileName = `spotify_${userId}_${Date.now()}.spotdl`;
        const tempFilePath = path.join(uploadDir, tempFileName);
        
        // ======================= ГЛАВНОЕ ИСПРАВЛЕНИЕ =======================
        // Команда 'save' сохраняет метаданные треков в JSON-файл.
        // Флаг --no-lyrics удален, так как он больше не поддерживается.
        const command = `spotdl save "${url}" --save-file "${tempFilePath}"`;
        // ===================================================================

        // Логируем команду для отладки
        console.log(`[Spotify Manager] Выполняю команду для ${userId}: ${command}`);

        // Выполняем команду с переменными окружения для аутентификации
        await execAsync(command, {
            env: { ...process.env, SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET }
        });

        // Читаем и удаляем временный файл с метаданными
        const fileContent = await fs.readFile(tempFilePath, 'utf-8');
        await fs.unlink(tempFilePath);

        const tracks = JSON.parse(fileContent);

        if (!tracks || tracks.length === 0) {
            return await ctx.reply('❌ Не удалось найти треки по этой ссылке Spotify.');
        }

        await ctx.reply(`✅ Найдено треков: ${tracks.length}. Добавляю в очередь...`);
        
        // Логирование события
        if (tracks.length > 1) {
            await logEvent(userId, 'spotify_playlist_album');
        } else {
            await logEvent(userId, 'spotify_track');
        }

        // Добавляем каждый трек в очередь на скачивание
        for (const track of tracks) {
            const task = {
                userId,
                source: 'spotify',
                spotifyUrl: track.url, // URL для скачивания в downloadManager
                metadata: {
                    title: track.name,
                    uploader: track.artists.join(', '),
                    duration: Math.round(track.duration / 1000),
                    thumbnail: track.cover_url,
                    id: track.song_id
                }
            };
            downloadQueue.add(task);
        }

    } catch (error) {
        // ================== РАСШИРЕННОЕ ЛОГИРОВАНИЕ ОШИБКИ ==================
        console.error(`[Spotify Manager] Произошла ошибка для пользователя ${userId} с URL ${url}.`);
        
        // Выводим стандартный вывод (stdout), иногда там тоже бывает полезная информация
        if (error.stdout) {
            console.error('STDOUT:', error.stdout);
        }
        
        // Выводим стандартный поток ошибок (stderr), это самое важное
        if (error.stderr) {
            console.error('STDERR:', error.stderr);
        }

        // Выводим весь объект ошибки, если stderr и stdout пусты
        if (!error.stdout && !error.stderr) {
            console.error('Полный объект ошибки:', error);
        }
        // ===============================================================================
        
        await ctx.reply('❌ Произошла ошибка при обработке ссылки Spotify. Попробуйте еще раз.');
    }
}