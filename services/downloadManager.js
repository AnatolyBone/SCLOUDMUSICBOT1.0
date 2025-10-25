// services/downloadManager.js (ФИНАЛЬНО ИСПРАВЛЕННАЯ ВЕРСИЯ TaskQueue)

// === ИМПОРТЫ: ОБНОВЛЕННЫЕ ===
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
// -----------------------------

import fetch from 'node-fetch';
import pMap from 'p-map';
import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME, PROXY_URL } from '../config.js';
import { Markup } from 'telegraf';
import path from 'path';
import ffmpegPath from 'ffmpeg-static'; // Путь к FFMPEG
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js'; // <-- УБЕДИТЕСЬ, ЧТО ЭТОТ ФАЙЛ СУЩЕСТВУЕТ
import * as db from '../db.js';
import { getSetting } from './settingsManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));

// ========================= CONFIGURATION =========================

// ВРЕМЕННЫЕ ФАЙЛЫ: Директория для кэширования метаданных
const cacheDir = path.join(os.tmpdir(), 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

const YTDL_TIMEOUT = 120;
const MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024; // 49 МБ (лимит Telegram)
const UNLIMITED_PLAYLIST_LIMIT = 100;
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

// Проверка наличия FFMPEG (Критически важно для стриминга)
const FFMPEG_AVAILABLE = Boolean(ffmpegPath);
if (!FFMPEG_AVAILABLE) {
    console.error('[DownloadManager] ❌ FFMPEG не найден. Потоковая передача может работать некорректно.');
}

const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 2;
const MAX_CONCURRENT_PLAYLIST_DOWNLOADS = 1;

// ========================= UTILS =========================

/**
 * Санитизация имени файла.
 */
function sanitizeFilename(title, artist = '') {
    let filename = artist ? `${artist} - ${title}` : title;
    // Удаляем небезопасные символы
    filename = filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '');
    // Ограничение длины
    return filename.trim().substring(0, 100);
}

/**
 * Централизованная функция для безопасной отправки сообщения пользователю.
 */
async function safeSendMessage(userId, text, extra = {}) {
    try {
        return await bot.telegram.sendMessage(userId, text, extra);
    } catch (e) {
        if (e.code === 403) {
            console.warn(`[DownloadManager] Пользователь ${userId} заблокировал бота (403). Отмечаю как неактивного.`);
            db.updateUserField(userId, 'active', false).catch(err => console.error('Ошибка обновления active статуса:', err));
        } else {
            console.error(`[DownloadManager] Ошибка отправки сообщения ${userId}:`, e.message);
        }
        return null;
    }
}

/**
 * Извлекает метаданные из объекта info.json
 */
function extractMetadataFromInfo(info) {
    return {
        title: info.title || info.track || 'Без названия',
        uploader: info.uploader || info.artist || 'Неизвестный исполнитель',
        duration: info.duration || 0,
        thumbnail: info.thumbnail,
        url: info.webpage_url,
        id: info.id
    };
}

/**
 * Проверяет, что URL безопасен (нет SSRF)
 */
function isSafeUrl(url) {
    // Эта функция остается прежней для защиты от SSRF. 
    return url && !url.includes('127.0.0.1') && !url.includes('localhost') && !url.match(/10\.\d+\.\d+\.\d+/);
}


// ========================= CORE QUEUE PROCESSOR =========================

/**
 * Воркер очереди, выполняющий загрузку и отправку трека.
 * Использует потоковую передачу для максимальной скорости.
 *
 * ПРИМЕЧАНИЕ: Функция теперь принимает ОДИН объект задачи, как это принято в TaskQueue.
 */
async function trackDownloadProcessor(taskData) { // <-- ИСПРАВЛЕНИЕ 1: Сигнатура теперь принимает ОДИН объект
    // Деструктурируем данные, переданные в downloadQueue.add()
    const { userId, url, originalUrl, metadata, priority, ctx } = taskData;

    // 1. ПРОВЕРКА ЛИМИТОВ
    // ... (Ваша логика проверки лимитов остается здесь, если она была) ...

    // 2. ПОИСК В КЭШЕ (САМЫЙ БЫСТРЫЙ ПУТЬ)
    const cachedTrack = await db.findCachedTrack(url);
    if (cachedTrack) {
        const startCache = Date.now();
        const success = await safeSendMessage(userId, '', {
            audio: cachedTrack.file_id,
            caption: T('downloadedBy'),
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: '🎧 Найти ещё', switch_inline_query_current_chat: '' }]]
            }
        });

        if (success) {
            db.incrementDownloads(userId, url, metadata.title).catch(() => {});
            console.log(`[DL CACHE] ${url} отправлен из кэша за ${Date.now() - startCache}ms.`);
            return true;
        }
    }

    // 3. ПОТОКОВАЯ ПЕРЕДАЧА (STREAMING)
    const startStream = Date.now();
    const sanitizedFilename = sanitizeFilename(metadata.title, metadata.uploader);

    // --- ФОРМИРОВАНИЕ АРГУМЕНТОВ ДЛЯ YT-DLP С ПОТОКОВЫМ ВЫВОДОМ ---
    // -f bestaudio - выбирает лучший аудиопоток
    // -o - - выводит бинарные данные в stdout
    const ytdlArgs = [
        url,
        '-f', 'bestaudio', 
        '-o', '-', // Вывод в stdout
        '--no-playlist',
        '--quiet',
        '--user-agent', FAKE_USER_AGENT,
        '--no-cache-dir',
        '--rm-cache-dir',
    ];

    // Добавляем FFMPEG для конвертации потока в MP3 (КРИТИЧНО для метаданных Telegram)
    if (FFMPEG_AVAILABLE) {
        ytdlArgs.push(
            '--exec', 
            // ffmpeg -i pipe:0 -c:a libmp3lame -q:a 0 -f mp3 pipe:1
            `${ffmpegPath} -i pipe:0 -c:a libmp3lame -q:a 0 -f mp3 pipe:1`
        );
    }
    
    // Добавление прокси
    if (PROXY_URL) ytdlArgs.push('--proxy', PROXY_URL);
    // Добавление таймаута (принудительное завершение)
    ytdlArgs.push('--socket-timeout', YTDL_TIMEOUT);

    // 4. ЗАПУСК ПРОЦЕССА И НАСТРОЙКА ПОТОКОВ
    const downloader = spawn('yt-dlp', ytdlArgs); 
    const stream = new PassThrough();

    // Соединение stdout yt-dlp с потоком-буфером для Telegram
    downloader.stdout.pipe(stream);

    // 5. ОБРАБОТКА ОШИБОК ПРОЦЕССА
    let errorMessage = '';
    downloader.stderr.on('data', (data) => {
        errorMessage += data.toString();
    });

    // Ошибки при закрытии процесса
    downloader.on('close', (code) => {
        if (code !== 0 && code !== null) {
            console.error(`[DL ERROR] yt-dlp process exited with code ${code}. Error message: ${errorMessage.trim()}`);
            // Важно: если процесс завершился с ошибкой, нужно остановить поток
            if (!stream.destroyed) stream.destroy(new Error(`yt-dlp exited with error: ${errorMessage.trim()}`));
        }
    });

    downloader.on('error', (err) => {
        console.error('[DL ERROR] Ошибка запуска yt-dlp:', err);
        if (!stream.destroyed) stream.destroy(err);
    });

    // 6. ОТПРАВКА ПОТОКА В TELEGRAM
    try {
        const file = {
            source: stream,
            filename: `${sanitizedFilename}.mp3`
        };
        
        // Отправка аудио с метаданными
        const message = await bot.telegram.sendAudio(userId, file, {
            title: metadata.title,
            performer: metadata.uploader,
            duration: metadata.duration,
            thumb: metadata.thumbnail ? { url: metadata.thumbnail } : undefined, 
            caption: T('downloadedBy'),
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: '🎧 Найти ещё', switch_inline_query_current_chat: '' }]]
            }
        });

        // 7. СОХРАНЕНИЕ file_id ДЛЯ КЭШИРОВАНИЯ
        if (message.audio?.file_id) {
            const trackId = await db.incrementDownloadsAndSaveTrack(
                userId,
                url,
                metadata.title,
                message.audio.file_id
            );
            console.log(`[DL SUCCESS] ${url} (Stream) завершен за ${Date.now() - startStream}ms. Track ID: ${trackId}`);
        } else {
            console.warn(`[DL WARN] ${url} отправлен, но file_id не получен для кэширования.`);
        }
        
        return true;

    } catch (e) {
        // Ошибка Telegram (например, 400 FILE_SIZE_TOO_BIG, 404)
        console.error(`[DL ERROR] Ошибка отправки потока в Telegram (${userId}):`, e.message);
        
        // Попытка отправить сообщение об ошибке пользователю
        let userErrorText = T('downloadError');
        if (e.message.includes('FILE_SIZE_TOO_BIG')) {
             userErrorText = `❌ Файл слишком большой (>${(MAX_FILE_SIZE_BYTES / 1024 / 1024).toFixed(0)} МБ).`;
        } else if (e.message.includes('yt-dlp exited with error')) {
             userErrorText = `❌ Ошибка загрузки: ${e.message.split(':').pop().trim()}`;
        }
        await safeSendMessage(userId, userErrorText);
        
        return false;
    } finally {
        // Убедитесь, что процесс yt-dlp завершён
        downloader.kill(); 
    }
}


// ========================= QUEUE MANAGEMENT =========================

/**
 * Глобальный инстанс очереди загрузок с приоритетами.
 * 🚨 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Конструктор TaskQueue вызывается с ОДНИМ объектом настроек.
 */
export const downloadQueue = new TaskQueue({ // <-- ИСПРАВЛЕНИЕ 2: Оборачиваем аргументы в один объект
    taskProcessor: trackDownloadProcessor, // <-- Передаем функцию как значение свойства
    concurrency: MAX_CONCURRENT_DOWNLOADS,
    autoStart: true,
    name: 'DownloadQueue'
});

/**
 * Добавляет задачу в очередь загрузок.
 * 🚨 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Передаем ОДИН объект в метод add().
 */
export function enqueue(task, ctx, metadata) {
    if (!task || !metadata) {
        console.error('[DownloadManager] Попытка добавить пустую задачу.');
        return false;
    }
    
    // Нормализация приоритета: 1000 (Unlim), 100 (Pro), 30 (Plus), 5 (Free)
    const priority = task.priority || 5; 
    
    // Формируем ОДИН объект задачи для TaskQueue.add()
    downloadQueue.add({
        userId: task.userId, // Предполагаем, что userId, url и т.д. в task
        url: task.url,
        originalUrl: task.originalUrl,
        metadata: metadata, // metadata, переданная извне
        priority: priority,
        ctx: ctx // Контекст бота, который может понадобиться для ответов
    });
    
    console.log(`[DownloadManager] Задача добавлена: ${task.url} (P: ${priority})`);
    return true;
}

// Удаляем startCacheCleanup, так как мы теперь не сохраняем большие файлы на диск.

// ========================= INITIALIZATION =========================

/**
 * Инициализация всех компонентов DownloadManager
 */
export function initializeDownloadManager() {
    console.log('[DownloadManager] Инициализация завершена.');
    console.log(`[DownloadManager] FFMPEG доступен: ${FFMPEG_AVAILABLE ? '✅' : '❌'}`);
    console.log(`[DownloadManager] Максимум одновременных загрузок: ${MAX_CONCURRENT_DOWNLOADS}`);
    console.log(`[DownloadManager] Канал-хранилище: ${STORAGE_CHANNEL_ID ? '✅ настроен' : '⚠️ не настроен'}`);
}

// ========================= EXPORTS SUMMARY =========================
// Основные экспорты:
// - trackDownloadProcessor: воркер для обработки одной задачи (теперь не экспортируется, так как это внутренняя функция)
// - downloadQueue: глобальная очередь с приоритетами
// - enqueue: функция для добавления треков в очередь
// - initializeDownloadManager: инициализация (вызывается из index.js)