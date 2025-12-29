// src/services/karaokeService.js

import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MVSEP_API_KEY } from '../config.js';

const API_BASE = 'https://mvsep.com/api/separation';
const TEMP_DIR = path.join(os.tmpdir(), 'karaoke_tmp');

// Создаем временную папку, если нет
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// 1. Скачивание файла во временную папку
async function downloadToTemp(url) {
    const destPath = path.join(TEMP_DIR, `upload_${Date.now()}.mp3`);
    const writer = fs.createWriteStream(destPath);
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(destPath));
        writer.on('error', reject);
    });
}

// 2. Создание задачи (Upload)
async function createTask(filePath) {
    const form = new FormData();
    form.append('audiofile', fs.createReadStream(filePath));
    form.append('api_token', MVSEP_API_KEY);
    form.append('sep_type', '40'); // 40 = BS Roformer (vocals, instrumental)
    form.append('output_format', '0'); // 0 = MP3 320kbps
    form.append('is_demo', '0');

    const requestConfig = {
        method: 'post',
        url: `${API_BASE}/create`,
        headers: { ...form.getHeaders() },
        data: form,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    };

    try {
        const res = await axios(requestConfig);
        
        if (res.data && res.data.success) {
            return res.data.data.hash; // Возвращаем хеш задачи
        } else {
            throw new Error(res.data.data?.message || 'Ошибка создания задачи');
        }
    } catch (error) {
        // Обработка специфичной ошибки 400, когда очередь забита
        if (error.response && error.response.data) {
            const errData = error.response.data;
            // Проверяем массив errors (как было в твоих логах) или message
            const errStr = JSON.stringify(errData).toLowerCase();
            
            if (errStr.includes('unprocessed file') || errStr.includes('queue')) {
                throw new Error('QUEUE_FULL');
            }
            
            console.error('[MVSEP Upload Error]', errData);
            throw new Error(`API Error: ${errStr}`);
        }
        throw error;
    }
}

// 3. Ожидание результата (Polling)
async function waitForResult(hash, onStatusUpdate) {
    const maxAttempts = 120; // ~20 минут максимум
    let attempts = 0;

    while (attempts < maxAttempts) {
        try {
            const res = await axios.get(`${API_BASE}/get`, { params: { hash } });
            const body = res.data;

            if (!body.success) throw new Error('API не вернуло статус задачи');

            const status = body.status; 
            // Данные из документации:
            // current_order - позиция пользователя в очереди
            // queue_count - всего людей в очереди
            const queuePos = body.data?.current_order || body.data?.queue_count || 0;

            // --- ОБРАБОТКА СТАТУСОВ ---
            
            // 1. Очередь
            if (status === 'waiting') {
                if (onStatusUpdate) onStatusUpdate({ status: 'queue', position: queuePos });
            } 
            // 2. Обработка (включая распределение и сборку файла)
            else if (status === 'processing' || status === 'distributing' || status === 'merging') {
                if (onStatusUpdate) onStatusUpdate({ status: 'processing' });
            }
            // 3. Готово
            else if (status === 'done') {
                const files = body.data.files; // Массив файлов
                const result = {};
                
                if (Array.isArray(files)) {
                    files.forEach(f => {
                        const link = f.url;
                        const name = link.toLowerCase();
                        
                        // Логика определения вокала и минуса
                        if (name.includes('vocals')) {
                            result.Vocals = link;
                        } else if (name.includes('instrumental') || name.includes('no_vocals')) {
                            result.Instrumental = link;
                        }
                    });
                }

                // Фолбэк: Если BS Roformer вернул 2 файла, но один не назван явно "instrumental"
                // (обычно он возвращает "file_vocals.mp3" и "file_instrumental.mp3", но на всякий случай)
                if (!result.Instrumental && files.length === 2) {
                    const other = files.find(f => !f.url.toLowerCase().includes('vocals'));
                    if (other) result.Instrumental = other.url;
                }

                return result;
            }
            // 4. Ошибка
            else if (status === 'failed') {
                throw new Error('Ошибка на сервере обработки: ' + (body.data?.message || 'Unknown'));
            }

        } catch (e) {
            console.warn('[MVSEP Polling Warning]', e.message);
            // Не выбрасываем ошибку сразу, пробуем еще раз (кроме критических)
        }

        await new Promise(r => setTimeout(r, 10000)); // Ждем 10 секунд перед следующим опросом
        attempts++;
    }
    throw new Error('Таймаут ожидания (сервер обрабатывал файл слишком долго)');
}

// Главная функция экспорта
export async function processKaraoke(fileUrl, onProgress) {
    let tempFile = null;
    try {
        // 1. Скачать
        tempFile = await downloadToTemp(fileUrl);
        
        // 2. Загрузить (сообщаем статус)
        if (onProgress) onProgress({ status: 'uploading' });
        const hash = await createTask(tempFile);
        
        // Удаляем локальный файл сразу после загрузки на MVSEP
        fs.unlink(tempFile, () => {});
        tempFile = null;

        // 3. Ждать
        const files = await waitForResult(hash, onProgress);
        return files;
    } catch (e) {
        if (tempFile && fs.existsSync(tempFile)) fs.unlink(tempFile, () => {});
        throw e;
    }
}
