// config.js (упрощённый и безопасный)
import dotenv from 'dotenv';
dotenv.config();

export const BOT_TOKEN = process.env.BOT_TOKEN;
export const ADMIN_ID = Number(process.env.ADMIN_ID);
export const WEBHOOK_URL = process.env.WEBHOOK_URL || '';        // в проде обязателен
export const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/telegram';
export const PORT = Number(process.env.PORT) || 3000;
export const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-secret-key-for-session';
export const ADMIN_LOGIN = process.env.ADMIN_LOGIN || '';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

export const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID || '';
export const BROADCAST_STORAGE_ID = process.env.BROADCAST_STORAGE_ID || '';

export const DATABASE_URL = process.env.DATABASE_URL;
export const REDIS_URL = process.env.REDIS_URL || '';            // делаем опциональным
export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
export const PROXY_URL = process.env.PROXY_URL || null;

// CHANNEL_URL может быть @username или полная t.me/ссылка
let rawChannelIdentifier = process.env.CHANNEL_URL || '';
if (rawChannelIdentifier.includes('t.me/')) {
  rawChannelIdentifier = '@' + rawChannelIdentifier.split('/').pop();
}
if (rawChannelIdentifier && !rawChannelIdentifier.startsWith('@')) {
  rawChannelIdentifier = '@' + rawChannelIdentifier;
}
export const CHANNEL_USERNAME = rawChannelIdentifier;

// Минимально необходимые переменные всегда:
const requiredAlways = [BOT_TOKEN, ADMIN_ID, DATABASE_URL];
if (requiredAlways.some(v => !v)) {
  console.error('❌ Не хватает обязательных переменных: BOT_TOKEN, ADMIN_ID, DATABASE_URL');
  if (process.env.NODE_ENV === 'production') process.exit(1);
}

// В продакшене нужен вебхук (если ты не используешь long-polling на проде)
if (process.env.NODE_ENV === 'production' && !WEBHOOK_URL) {
  console.error('❌ В production нужен WEBHOOK_URL для вебхука.');
  process.exit(1);
}