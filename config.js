import dotenv from 'dotenv';
dotenv.config();

export const BOT_TOKEN = process.env.BOT_TOKEN;
export const ADMIN_ID = Number(process.env.ADMIN_ID);
export const WEBHOOK_URL = process.env.WEBHOOK_URL;
export const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/telegram';
export const PORT = process.env.PORT ?? 3000;
export const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-secret-key-for-session';
export const ADMIN_LOGIN = process.env.ADMIN_LOGIN;
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
export const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
export const DATABASE_URL = process.env.DATABASE_URL;
export const REDIS_URL = process.env.REDIS_URL;
export const SUPABASE_URL = process.env.SUPABASE_URL;
//export const PROXY_URL = process.env.PROXY_URL;
export const SUPABASE_KEY = process.env.SUPABASE_KEY;
export const SPOTIPY_CLIENT_ID = process.env.SPOTIPY_CLIENT_ID;
export const SPOTIPY_CLIENT_SECRET = process.env.SPOTIPY_CLIENT_SECRET;
export const BROADCAST_STORAGE_ID = process.env.BROADCAST_STORAGE_ID;
let rawChannelIdentifier = process.env.CHANNEL_URL || '';
// Если в переменной полная ссылка, извлекаем username
if (rawChannelIdentifier.includes('t.me/')) {
  rawChannelIdentifier = '@' + rawChannelIdentifier.split('/').pop();
}
// Убеждаемся, что на выходе всегда есть @, если это не пустая строка
if (rawChannelIdentifier && !rawChannelIdentifier.startsWith('@')) {
    rawChannelIdentifier = '@' + rawChannelIdentifier;
}
export const CHANNEL_USERNAME = rawChannelIdentifier;

if (!BOT_TOKEN || !ADMIN_ID || !WEBHOOK_URL || !DATABASE_URL || !REDIS_URL) {
    console.error('❌ Отсутствуют критически важные переменные окружения!');
    if (process.env.NODE_ENV === 'production') process.exit(1);
}