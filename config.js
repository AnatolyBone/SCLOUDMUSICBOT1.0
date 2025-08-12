// config.js

// Загружаем переменные из .env файла, если он есть (для локальной разработки)
import dotenv from 'dotenv';
dotenv.config();

export const BOT_TOKEN = process.env.BOT_TOKEN;
export const ADMIN_ID = Number(process.env.ADMIN_ID);
export const WEBHOOK_URL = process.env.WEBHOOK_URL;
export const PORT = process.env.PORT ?? 3000;
export const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-secret-key-for-session';
export const ADMIN_LOGIN = process.env.ADMIN_LOGIN;
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
export const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;

// Проверка на наличие обязательных переменных
if (!BOT_TOKEN || !ADMIN_ID || !WEBHOOK_URL || !ADMIN_LOGIN || !ADMIN_PASSWORD) {
    console.error('❌ Отсутствуют необходимые переменные окружения!');
    // В продакшене лучше сразу остановить приложение, если нет конфигурации
    if (process.env.NODE_ENV === 'production') {
        process.exit(1);
    }
}