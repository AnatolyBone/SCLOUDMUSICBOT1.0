// src/services/shazamService.js

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Путь к скрипту: поднимаемся из services (..) и заходим в scripts
const PYTHON_SCRIPT = path.join(__dirname, '../scripts/recognize.py');
// Используем системную временную папку
const TEMP_DIR = path.join(os.tmpdir(), 'shazam_tmp');

// Создаем папку для временных файлов, если её нет
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Функция скачивания файла
async function downloadFile(url, destPath) {
    const writer = fs.createWriteStream(destPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// Основная функция распознавания
export async function identifyTrack(fileLink) {
    // Создаем уникальное имя для временного файла
    const tempFile = path.join(TEMP_DIR, `rec_${Date.now()}.mp3`); 
    
    try {
        // 1. ПРОВЕРКА: Существует ли Python скрипт вообще?
        if (!fs.existsSync(PYTHON_SCRIPT)) {
            console.error(`[Shazam] CRITICAL ERROR: Python script not found at: ${PYTHON_SCRIPT}`);
            return null;
        }

        // 2. Скачиваем аудиофайл по ссылке из Telegram
        await downloadFile(fileLink, tempFile);
        
        // 3. Запускаем Python
        return await new Promise((resolve, reject) => {
            // Используем 'python3', так как на Render Linux
            const pythonProcess = spawn('python3', [PYTHON_SCRIPT, tempFile]);
            
            let resultData = '';
            let errorData = ''; // Сюда будем записывать ошибки
            
            // Читаем успешный вывод (JSON)
            pythonProcess.stdout.on('data', (data) => {
                resultData += data.toString();
            });

            // Читаем ошибки (Traceback) - САМОЕ ВАЖНОЕ ДЛЯ ОТЛАДКИ
            pythonProcess.stderr.on('data', (data) => {
                errorData += data.toString();
            });

            pythonProcess.on('close', (code) => {
                // Удаляем временный аудиофайл
                fs.unlink(tempFile, () => {});

                // Если код не 0, значит скрипт упал
                if (code !== 0) {
                    console.error(`[Shazam] Process exited with code ${code}`);
                    // Выводим в логи текст ошибки Python
                    if (errorData) {
                        console.error('⬇⬇⬇ [Shazam] PYTHON ERROR TRACEBACK ⬇⬇⬇');
                        console.error(errorData);
                        console.error('⬆⬆⬆ --------------------------------- ⬆⬆⬆');
                    }
                    return resolve(null);
                }

                try {
                    // Пытаемся разобрать ответ от Python
                    const json = JSON.parse(resultData);
                    
                    if (json.error) {
                        console.error('[Shazam] Script returned error:', json.error);
                        return resolve(null);
                    }

                    if (!json.track) {
                        // Трек не найден
                        return resolve(null);
                    }

                    // Успех!
                    resolve({
                        title: json.track.title,
                        artist: json.track.subtitle,
                        image: json.track.images?.coverart,
                        link: json.track.url
                    });
                } catch (e) {
                    console.error('[Shazam] JSON Parse Error:', e);
                    console.error('[Shazam] Raw Output was:', resultData);
                    if (errorData) console.error('[Shazam] Stderr was:', errorData);
                    resolve(null);
                }
            });
        });

    } catch (e) {
        console.error('[Shazam] General Service Error:', e);
        // Чистим мусор при ошибке
        if (fs.existsSync(tempFile)) fs.unlink(tempFile, () => {});
        return null;
    }
}
