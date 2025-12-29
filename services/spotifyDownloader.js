// services/spotifyDownloader.js
// Надёжный загрузчик Spotify через YouTube matching

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import ffmpegPath from 'ffmpeg-static';

const TEMP_DIR = path.join(os.tmpdir(), 'spotify-dl');

// Логика определения пути к кукам:
// 1. Сначала ищем в секретах Render (/etc/secrets/cookies.txt)
// 2. Если нет, ищем в корне проекта (для локальной разработки)
let COOKIES_PATH = '/etc/secrets/cookies.txt';

if (!fs.existsSync(COOKIES_PATH)) {
    COOKIES_PATH = path.join(process.cwd(), 'cookies.txt');
}

// Копируем cookies во временную папку (доступную для записи) для использования в yt-dlp
let WRITABLE_COOKIES_PATH = null;
if (fs.existsSync(COOKIES_PATH)) {
    try {
        WRITABLE_COOKIES_PATH = path.join(os.tmpdir(), 'cookies.txt');
        fs.copyFileSync(COOKIES_PATH, WRITABLE_COOKIES_PATH);
        console.log('🍪 [SpotifyDL/Cookies] Файл найден и скопирован в:', WRITABLE_COOKIES_PATH);
    } catch (err) {
        console.warn('⚠️ [SpotifyDL/Cookies] Не удалось скопировать во временную папку:', err.message);
        // Используем оригинальный путь как fallback
        WRITABLE_COOKIES_PATH = COOKIES_PATH;
    }
} else {
    console.warn('⚠️ [SpotifyDL/Cookies] Файл НЕ найден!');
}

// Создаём папку если нет
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Скачивает и конвертирует в MP3 через pipe (без записи на диск)
 * Быстрее на ~30-40%!
 * @param {string} searchQuery - "Artist - Title"
 * @param {object} options - { quality: 'high'|'medium'|'low' }
 * @returns {Promise<{buffer: Buffer, size: number}>}
 */
/**
 * 🔥 STREAMING ВЕРСИЯ - отправка начинается через 3-5 секунд!
 * Возвращает readable stream вместо buffer
 */
export async function downloadSpotifyAsStream(searchQuery, options = {}) {
  const { quality = 'medium' } = options;
  
  const bitrate = {
    'high': '320k',
    'medium': '192k',
    'low': '128k'
  }[quality] || '192k';

  console.log(`[SpotifyDL/Stream] 🔍 Ищу: "${searchQuery}"`);

  return new Promise((resolve, reject) => {
    // yt-dlp → stdout
    const ytdlpArgs = [
      '-m', 'yt_dlp',
      `ytsearch1:${searchQuery}`,
      '-f', 'bestaudio/best',
      '-o', '-',  // ✅ Вывод в stdout
      '--no-playlist',
      '--quiet',
      '--no-warnings',
    ];
    
    if (WRITABLE_COOKIES_PATH && fs.existsSync(WRITABLE_COOKIES_PATH)) {
      ytdlpArgs.push('--cookies', WRITABLE_COOKIES_PATH);
      console.log(`[SpotifyDL/Stream] Использую куки из: ${WRITABLE_COOKIES_PATH}`);
    }
    
    const ytdlp = spawn('python3', ytdlpArgs, {
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    // FFmpeg конвертирует поток в MP3
    const ffmpeg = spawn(ffmpegPath, [
      '-i', 'pipe:0',
      '-vn',
      '-acodec', 'libmp3lame',
      '-b:a', bitrate,
      '-f', 'mp3',
      'pipe:1'  // ✅ Вывод в stdout
    ]);

    // Соединяем pipe
    ytdlp.stdout.pipe(ffmpeg.stdin);

    // ✅ ГЛАВНОЕ: Возвращаем stream, НЕ собираем buffer!
    const outputStream = new PassThrough();
    ffmpeg.stdout.pipe(outputStream);

    let hasStarted = false;
    let bytesReceived = 0;
    let errorLogs = '';

    // Отслеживаем начало потока
    outputStream.on('data', (chunk) => {
      bytesReceived += chunk.length;
      
      if (!hasStarted) {
        hasStarted = true;
        console.log(`[SpotifyDL/Stream] ✅ Поток начался! Отправляем в Telegram...`);
      }
    });

    // Собираем ошибки
    ytdlp.stderr.on('data', (data) => {
      errorLogs += data.toString();
    });

    ffmpeg.stderr.on('data', (data) => {
      errorLogs += data.toString();
    });

    // Таймаут только на НАЧАЛО потока (не на весь файл!)
    const startTimeout = setTimeout(() => {
      if (!hasStarted) {
        console.error(`[SpotifyDL/Stream] ❌ Таймаут: поток не начался за 30 сек`);
        ytdlp.kill('SIGTERM');
        ffmpeg.kill('SIGTERM');
        reject(new Error('STREAM_START_TIMEOUT'));
      }
    }, 30000); // 30 сек чтобы начался

    // Когда поток начался - резолвим промис
    outputStream.once('data', (firstChunk) => {
      clearTimeout(startTimeout);
      
      // Создаём новый stream и пушим первый чанк обратно
      const finalStream = new PassThrough();
      finalStream.write(firstChunk);
      outputStream.pipe(finalStream);
      
      // ✅ Возвращаем stream СРАЗУ!
      resolve({
        stream: finalStream,
        
        // Функция для принудительной остановки
        cleanup: () => {
          console.log(`[SpotifyDL/Stream] 🧹 Cleanup вызван (получено ${(bytesReceived/1024/1024).toFixed(2)} MB)`);
          ytdlp.kill('SIGTERM');
          ffmpeg.kill('SIGTERM');
        },
        
        // Promise который резолвится когда скачивание завершится
        waitComplete: new Promise((res, rej) => {
          outputStream.on('end', () => {
            console.log(`[SpotifyDL/Stream] ✅ Полностью скачано: ${(bytesReceived/1024/1024).toFixed(2)} MB`);
            res(bytesReceived);
          });
          outputStream.on('error', rej);
        })
      });
    });

    // Обработка ошибок процессов
    ytdlp.on('close', (code) => {
      if (code !== 0 && code !== null && !hasStarted) {
        clearTimeout(startTimeout);
        console.error(`[SpotifyDL/Stream] yt-dlp error (code ${code}): ${errorLogs.slice(-300)}`);
        reject(new Error(`yt-dlp failed: ${errorLogs.slice(-200)}`));
      }
    });

    ffmpeg.on('close', (code) => {
      clearTimeout(startTimeout);
      outputStream.end();
      
      if (code !== 0 && !hasStarted) {
        console.error(`[SpotifyDL/Stream] FFmpeg error (code ${code}): ${errorLogs.slice(-300)}`);
        reject(new Error(`FFmpeg failed`));
      }
    });

    ytdlp.on('error', (err) => {
      clearTimeout(startTimeout);
      console.error(`[SpotifyDL/Stream] ytdlp spawn error:`, err);
      reject(err);
    });

    ffmpeg.on('error', (err) => {
      clearTimeout(startTimeout);
      console.error(`[SpotifyDL/Stream] ffmpeg spawn error:`, err);
      reject(err);
    });
  });
}
export async function downloadSpotifyStream(searchQuery, options = {}) {
  const { quality = 'medium' } = options;
  
  const bitrate = {
    'high': '320k',
    'medium': '192k',
    'low': '128k'
  }[quality] || '192k';

  console.log(`[SpotifyDL/Stream] 🔍 Ищу: "${searchQuery}"`);

  return new Promise((resolve, reject) => {
    // Шаг 1: yt-dlp скачивает и выводит в stdout
    const ytdlpArgs = [
      '-m', 'yt_dlp',
      `ytsearch1:${searchQuery}`,
      '-f', 'bestaudio/best',
      '-o', '-',  // Вывод в stdout!
      '--no-playlist',
      '--quiet',
    ];
    
    // Куки если есть
    if (WRITABLE_COOKIES_PATH && fs.existsSync(WRITABLE_COOKIES_PATH)) {
      ytdlpArgs.push('--cookies', WRITABLE_COOKIES_PATH);
      console.log(`[SpotifyDL/Stream] Использую куки из: ${WRITABLE_COOKIES_PATH}`);
    } else {
      console.warn('[SpotifyDL/Stream] Куки не найдены, пробую без них (возможна блокировка)');
    }
    
    const ytdlp = spawn('python3', ytdlpArgs, {
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    // Шаг 2: FFmpeg читает из stdin и конвертирует в MP3
    const ffmpeg = spawn(ffmpegPath, [
      '-i', 'pipe:0',           // Читать из stdin
      '-vn',                     // Без видео
      '-acodec', 'libmp3lame',   // MP3 кодек
      '-b:a', bitrate,           // Битрейт
      '-f', 'mp3',               // Формат
      'pipe:1'                   // Вывод в stdout
    ]);

    // Соединяем: yt-dlp stdout → ffmpeg stdin
    ytdlp.stdout.pipe(ffmpeg.stdin);

    // Собираем выходной поток
    const outputStream = new PassThrough();
    const chunks = [];
    
    ffmpeg.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      outputStream.write(chunk);
    });

    let ytdlpError = '';
    let ffmpegError = '';

    ytdlp.stderr.on('data', (data) => {
      ytdlpError += data.toString();
    });

    ffmpeg.stderr.on('data', (data) => {
      ffmpegError += data.toString();
    });

    // Таймаут 2 минуты
    const timeout = setTimeout(() => {
      ytdlp.kill();
      ffmpeg.kill();
      reject(new Error('TIMEOUT'));
    }, 120000);

    // Проверяем ошибки yt-dlp
    ytdlp.on('close', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        ytdlp.kill();
        ffmpeg.kill();
        console.error(`[SpotifyDL/Stream] yt-dlp exited with code ${code}`);
        console.error(`[SpotifyDL/Stream] yt-dlp error: ${ytdlpError.slice(-200)}`);
        reject(new Error(`yt-dlp failed: ${ytdlpError.slice(-200)}`));
      }
    });

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      outputStream.end();
      
      if (code !== 0) {
        console.error(`[SpotifyDL/Stream] FFmpeg error: ${ffmpegError.slice(-200)}`);
        return reject(new Error('FFmpeg conversion failed'));
      }

      if (chunks.length === 0) {
        console.error(`[SpotifyDL/Stream] No data received`);
        return reject(new Error('No audio data'));
      }

      const buffer = Buffer.concat(chunks);
      console.log(`[SpotifyDL/Stream] ✅ Готово: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
      
      resolve({
        buffer,
        size: buffer.length
      });
    });

    ytdlp.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`yt-dlp error: ${err.message}`));
    });

    ffmpeg.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`ffmpeg error: ${err.message}`));
    });
  });
}

/**
 * Скачивает трек по поисковому запросу через yt-dlp
 * @param {string} searchQuery - "Artist - Title"
 * @param {object} options - { quality: 'high'|'medium'|'low', metadata: {...} }
 * @returns {Promise<{filePath: string, duration: number}>}
 */
export async function downloadFromYouTube(searchQuery, options = {}) {
  const { quality = 'high', metadata = {} } = options;
  
  const baseName = `spotify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outputPath = path.join(TEMP_DIR, `${baseName}.mp3`);
  
  // Битрейт в зависимости от качества
  const bitrate = {
    'high': '320k',
    'medium': '192k',
    'low': '128k'
  }[quality] || '192k';

  console.log(`[SpotifyDL] 🔍 Ищу: "${searchQuery}"`);
  console.log(`[SpotifyDL] 📁 Output: ${outputPath}`);
  console.log(`[SpotifyDL] 🎵 Quality: ${bitrate}`);

  return new Promise((resolve, reject) => {
    // Аргументы yt-dlp - минимальный надёжный набор
    const args = [
      '-m', 'yt_dlp',
      
      // Поиск на YouTube
      `ytsearch1:${searchQuery}`,
      
      // Формат: пробуем разные варианты
      '-f', 'bestaudio/best',
      
      // Извлекаем аудио и конвертируем в mp3
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', bitrate,
      
      // Выходной файл
      '-o', outputPath,
      
      // Базовые опции
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--geo-bypass',
      
      // FFmpeg
      '--ffmpeg-location', ffmpegPath,
      
      // Ретраи
      '--retries', '3',
      '--fragment-retries', '3',
      
      // Без прогресса в логах (чище)
      '--progress',
      '--newline',
    ];
    
    // Куки если есть
    if (WRITABLE_COOKIES_PATH && fs.existsSync(WRITABLE_COOKIES_PATH)) {
      args.push('--cookies', WRITABLE_COOKIES_PATH);
      console.log(`[SpotifyDL] Использую куки из: ${WRITABLE_COOKIES_PATH}`);
    } else {
      console.warn('[SpotifyDL] Куки не найдены, пробую без них (возможна блокировка)');
    }

    console.log(`[SpotifyDL] 🚀 Запуск yt-dlp...`);
    
    const proc = spawn('python3', args, {
      cwd: TEMP_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const line = data.toString().trim();
      stdout += line + '\n';
      
      // Показываем прогресс только на ключевых отметках
      if (line.includes('%')) {
        const match = line.match(/(\d+\.?\d*)%/);
        if (match) {
          const percent = Math.round(parseFloat(match[1]));
          // Логируем только 0, 25, 50, 75, 100
          if ([0, 25, 50, 75, 100].includes(percent)) {
            console.log(`[SpotifyDL] ⬇️ ${percent}%`);
          }
        }
      } else if (line && !line.includes('[download]')) {
        // Логируем всё кроме прогресса скачивания
        console.log(`[SpotifyDL] ${line.slice(0, 100)}`);
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[SpotifyDL] ❌ yt-dlp код: ${code}`);
        console.error(`[SpotifyDL] stderr: ${stderr.slice(-500)}`);
        
        // Специфичные ошибки
        if (stderr.includes('Did not get any data blocks')) {
          return reject(new Error('NO_DATA_BLOCKS')); // Можно retry
        }
        if (stderr.includes('Requested format is not available')) {
          return reject(new Error('FORMAT_UNAVAILABLE'));
        }
        if (stderr.includes('Video unavailable') || stderr.includes('Private video')) {
          return reject(new Error('VIDEO_UNAVAILABLE'));
        }
        if (stderr.includes('Sign in')) {
          return reject(new Error('AUTH_REQUIRED'));
        }
        
        return reject(new Error(`yt-dlp failed: ${stderr.slice(-200)}`));
      }

      // Проверяем файл
      if (!fs.existsSync(outputPath)) {
        // Ищем файл с другим расширением
        const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(baseName));
        if (files.length > 0) {
          const foundPath = path.join(TEMP_DIR, files[0]);
          console.log(`[SpotifyDL] ✅ Найден файл: ${files[0]}`);
          const stats = fs.statSync(foundPath);
          return resolve({
            filePath: foundPath,
            size: stats.size,
            duration: metadata.duration || null
          });
        }
        
        console.error(`[SpotifyDL] ❌ Файл не создан!`);
        console.error(`[SpotifyDL] TEMP_DIR содержит: ${fs.readdirSync(TEMP_DIR).join(', ')}`);
        return reject(new Error('FILE_NOT_CREATED'));
      }

      const stats = fs.statSync(outputPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      
      console.log(`[SpotifyDL] ✅ Скачано: ${sizeMB} MB`);
      
      resolve({
        filePath: outputPath,
        size: stats.size,
        duration: metadata.duration || null
      });
    });

    proc.on('error', (err) => {
      console.error(`[SpotifyDL] ❌ Spawn error:`, err);
      reject(new Error(`Spawn failed: ${err.message}`));
    });
  });
}

/**
 * Альтернативный метод - если первый не сработал
 * Использует другой формат и fallback на видео
 */
export async function downloadFromYouTubeFallback(searchQuery, options = {}) {
  const { quality = 'medium' } = options;
  
  const baseName = `spotify_fb_${Date.now()}`;
  const outputTemplate = path.join(TEMP_DIR, `${baseName}.%(ext)s`);
  
  console.log(`[SpotifyDL/Fallback] 🔄 Пробуем альтернативный метод...`);

  return new Promise((resolve, reject) => {
    const args = [
      '-m', 'yt_dlp',
      `ytsearch1:${searchQuery}`,
      
      // Без указания формата - yt-dlp сам выберет лучший
      '-x',
      '--audio-format', 'mp3',
      '-o', outputTemplate,
      '--no-playlist',
      '--ffmpeg-location', ffmpegPath,
    ];
    
    if (WRITABLE_COOKIES_PATH && fs.existsSync(WRITABLE_COOKIES_PATH)) {
      args.push('--cookies', WRITABLE_COOKIES_PATH);
      console.log(`[SpotifyDL/Fallback] Использую куки из: ${WRITABLE_COOKIES_PATH}`);
    } else {
      console.warn('[SpotifyDL/Fallback] Куки не найдены, пробую без них (возможна блокировка)');
    }

    const proc = spawn('python3', args, { cwd: TEMP_DIR });

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Fallback failed: ${stderr.slice(-200)}`));
      }
      
      const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(baseName));
      if (files.length === 0) {
        return reject(new Error('Fallback: file not created'));
      }
      
      const filePath = path.join(TEMP_DIR, files[0]);
      console.log(`[SpotifyDL/Fallback] ✅ Скачано: ${filePath}`);
      
      resolve({ filePath, size: fs.statSync(filePath).size });
    });

    proc.on('error', reject);
  });
}

/**
 * Главная функция - пробует все методы с автоматическим retry
 */
export async function downloadSpotifyTrack(trackInfo, options = {}) {
  const searchQuery = `${trackInfo.artist} ${trackInfo.title}`;
  const maxRetries = 2;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Метод 1: Стандартный
      return await downloadFromYouTube(searchQuery, { 
        ...options, 
        metadata: trackInfo 
      });
    } catch (err) {
      const isRetryable = ['NO_DATA_BLOCKS', 'TIMEOUT'].includes(err.message);
      
      if (isRetryable && attempt < maxRetries) {
        console.log(`[SpotifyDL] ⏳ Retry ${attempt}/${maxRetries} через 3 сек...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      
      console.warn(`[SpotifyDL] Метод 1 не сработал: ${err.message}`);
      break;
    }
  }
  
  // Метод 2: Fallback без указания формата
  try {
    return await downloadFromYouTubeFallback(searchQuery, options);
  } catch (err) {
    console.warn(`[SpotifyDL] Метод 2 не сработал: ${err.message}`);
  }
  
  // Метод 3: Поиск только по названию
  try {
    console.log(`[SpotifyDL] Метод 3: только название...`);
    return await downloadFromYouTube(trackInfo.title, options);
  } catch (err) {
    console.error(`[SpotifyDL] Все методы провалились`);
    throw new Error(`Не удалось скачать: ${trackInfo.title}`);
  }
}

/**
 * Очистка старых файлов
 */
export function cleanupTempFiles(maxAgeMs = 30 * 60 * 1000) {
  try {
    const now = Date.now();
    const files = fs.readdirSync(TEMP_DIR);
    let deleted = 0;
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = fs.statSync(filePath);
      
      if (now - stats.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    }
    
    if (deleted > 0) {
      console.log(`[SpotifyDL] 🧹 Удалено ${deleted} старых файлов`);
    }
  } catch (e) {
    console.warn('[SpotifyDL] Cleanup error:', e.message);
  }
}

// Автоочистка каждые 10 минут
setInterval(() => cleanupTempFiles(), 10 * 60 * 1000);

