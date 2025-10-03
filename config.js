// config.js (безопасная финальная версия)
import dotenv from 'dotenv';
dotenv.config();

const isDev = process.env.NODE_ENV !== 'production';

// ========================= HELPER FUNCTIONS =========================

/**
 * Получает обязательную переменную окружения
 * @param {string} key - Название переменной
 * @returns {string}
 * @throws {Error} Если переменная не задана
 */
function getRequired(key) {
  const val = process.env[key];
  if (!val) {
    throw new Error(`❌ Переменная ${key} обязательна!`);
  }
  return val;
}

/**
 * Получает обязательное целое число из переменной окружения
 * @param {string} key - Название переменной
 * @returns {number}
 * @throws {Error} Если переменная не задана или не является числом
 */
function getRequiredInt(key) {
  const raw = process.env[key];
  const val = parseInt(raw, 10);
  
  if (!raw || isNaN(val)) {
    throw new Error(`❌ Переменная ${key} должна быть числом, получено: "${raw}"`);
  }
  
  return val;
}

/**
 * Получает опциональное целое число из переменной окружения
 * @param {string} key - Название переменной
 * @param {number} defaultValue - Значение по умолчанию
 * @returns {number}
 */
function getOptionalInt(key, defaultValue) {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  
  const val = parseInt(raw, 10);
  return isNaN(val) ? defaultValue : val;
}

/**
 * Безопасно парсит username канала из различных форматов
 * @param {string|undefined} input - URL канала или username
 * @returns {string} Username с @, или пустая строка
 */
function parseChannelUsername(input) {
  if (!input || typeof input !== 'string') return '';
  
  // Убираем URL префикс если есть
  let username = input.trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//, '');
  
  // Убираем всё кроме букв, цифр и подчёркивания (защита от инъекций)
  username = username.replace(/[^a-zA-Z0-9_]/g, '');
  
  if (!username) return '';
  
  // Telegram usernames должны быть 5-32 символа
  if (username.length < 5 || username.length > 32) {
    console.warn(`⚠️  CHANNEL_URL имеет некорректную длину: ${username.length} символов`);
    return '';
  }
  
  return username.startsWith('@') ? username : '@' + username;
}

/**
 * Валидация DATABASE_URL (проверка формата PostgreSQL)
 * @param {string} url - URL базы данных
 * @returns {boolean}
 */
function isValidDatabaseUrl(url) {
  if (!url) return false;
  // Минимальная проверка: должна начинаться с postgres:// или postgresql://
  return /^postgres(ql)?:\/\/.+/.test(url);
}

// ========================= VALIDATION =========================

/**
 * Проверяет наличие всех обязательных переменных окружения
 * @throws {Error} Если не хватает критичных переменных
 */
function validateEnv() {
  const errors = [];
  
  // --- Обязательные всегда ---
  if (!process.env.BOT_TOKEN) {
    errors.push('BOT_TOKEN - токен Telegram бота');
  }
  
  if (!process.env.ADMIN_ID || isNaN(Number(process.env.ADMIN_ID))) {
    errors.push('ADMIN_ID - Telegram ID администратора (должен быть числом)');
  }
  
  if (!process.env.DATABASE_URL) {
    errors.push('DATABASE_URL - строка подключения к PostgreSQL');
  } else if (!isValidDatabaseUrl(process.env.DATABASE_URL)) {
    errors.push('DATABASE_URL - некорректный формат (должен начинаться с postgres:// или postgresql://)');
  }
  
  // --- Обязательные только в production ---
  if (!isDev) {
    if (!process.env.WEBHOOK_URL) {
      errors.push('WEBHOOK_URL - обязателен в production (например: https://yourdomain.com)');
    }
    
    if (!process.env.SESSION_SECRET) {
      errors.push('SESSION_SECRET - обязателен в production для безопасности сессий');
    } else if (process.env.SESSION_SECRET.length < 32) {
      errors.push('SESSION_SECRET - должен быть минимум 32 символа для безопасности');
    }
    
    if (!process.env.ADMIN_LOGIN) {
      errors.push('ADMIN_LOGIN - обязателен в production');
    }
    
    if (!process.env.ADMIN_PASSWORD) {
      errors.push('ADMIN_PASSWORD - обязателен в production');
    } else if (process.env.ADMIN_PASSWORD.length < 8) {
      errors.push('ADMIN_PASSWORD - должен быть минимум 8 символов');
    }
  }
  
  // --- Если есть ошибки, прерываем запуск ---
  if (errors.length > 0) {
    console.error('\n❌❌❌ КРИТИЧЕСКИЕ ОШИБКИ КОНФИГУРАЦИИ ❌❌❌\n');
    console.error('Не хватает обязательных переменных окружения:\n');
    errors.forEach((err, i) => console.error(`   ${i + 1}. ${err}`));
    console.error('\nСоздайте файл .env на основе .env.example и заполните все обязательные поля.\n');
    process.exit(1);
  }
}

/**
 * Выводит предупреждения о неполной конфигурации (некритичные, но важные)
 */
function warnOptionalVars() {
  const warnings = [];
  
  if (!process.env.REDIS_URL) {
    warnings.push('REDIS_URL не задан — кеширование будет работать через память (не подходит для production)');
  }
  
  if (!process.env.CHANNEL_URL) {
    warnings.push('CHANNEL_URL не задан — бонусы за подписку на канал будут недоступны');
  }
  
  if (!process.env.STORAGE_CHANNEL_ID) {
    warnings.push('STORAGE_CHANNEL_ID не задан — файлы рассылок не будут сохраняться');
  }
  
  if (!process.env.BROADCAST_STORAGE_ID) {
    warnings.push('BROADCAST_STORAGE_ID не задан — рассылки с медиафайлами могут не работать');
  }
  
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    warnings.push('SUPABASE_URL или SUPABASE_KEY не заданы — некоторые функции БД могут не работать');
  }
  
  if (warnings.length > 0) {
    console.warn('\n⚠️  ПРЕДУПРЕЖДЕНИЯ О КОНФИГУРАЦИИ:\n');
    warnings.forEach((warn, i) => console.warn(`   ${i + 1}. ${warn}`));
    console.warn('');
  }
}

// Запускаем валидацию при импорте модуля
validateEnv();
warnOptionalVars();

// ========================= CONFIG OBJECT =========================

/**
 * Основной объект конфигурации приложения.
 * Заморожен для предотвращения случайных изменений в рантайме.
 * @readonly
 */
export const CONFIG = Object.freeze({
  // --- Основные ---
  BOT_TOKEN: getRequired('BOT_TOKEN'),
  ADMIN_ID: getRequiredInt('ADMIN_ID'),
  DATABASE_URL: getRequired('DATABASE_URL'),
  
  // --- Сервер ---
  WEBHOOK_URL: isDev ? '' : getRequired('WEBHOOK_URL'),
  WEBHOOK_PATH: process.env.WEBHOOK_PATH || '/telegram',
  PORT: getOptionalInt('PORT', 3000),
  
  // --- Безопасность ---
  SESSION_SECRET: isDev ? 'dev-secret-key-do-not-use-in-production' : getRequired('SESSION_SECRET'),
  ADMIN_LOGIN: isDev ? 'admin' : getRequired('ADMIN_LOGIN'),
  ADMIN_PASSWORD: isDev ? 'admin' : getRequired('ADMIN_PASSWORD'),
  
  // --- Внешние сервисы ---
  REDIS_URL: process.env.REDIS_URL || null,
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_KEY: process.env.SUPABASE_KEY || '',
  PROXY_URL: process.env.PROXY_URL || null,
  
  // --- Telegram каналы ---
  CHANNEL_USERNAME: parseChannelUsername(process.env.CHANNEL_URL),
  STORAGE_CHANNEL_ID: process.env.STORAGE_CHANNEL_ID || '',
  BROADCAST_STORAGE_ID: process.env.BROADCAST_STORAGE_ID || '',
  
  // --- Spotify (опционально) ---
  SPOTIPY_CLIENT_ID: process.env.SPOTIPY_CLIENT_ID || '',
  SPOTIPY_CLIENT_SECRET: process.env.SPOTIPY_CLIENT_SECRET || '',
  
  // --- Meta ---
  isDev,
  isProduction: !isDev,
  nodeEnv: process.env.NODE_ENV || 'development'
});

// ========================= NAMED EXPORTS (для обратной совместимости) =========================

export const BOT_TOKEN = CONFIG.BOT_TOKEN;
export const ADMIN_ID = CONFIG.ADMIN_ID;
export const DATABASE_URL = CONFIG.DATABASE_URL;
export const WEBHOOK_URL = CONFIG.WEBHOOK_URL;
export const WEBHOOK_PATH = CONFIG.WEBHOOK_PATH;
export const PORT = CONFIG.PORT;
export const SESSION_SECRET = CONFIG.SESSION_SECRET;
export const ADMIN_LOGIN = CONFIG.ADMIN_LOGIN;
export const ADMIN_PASSWORD = CONFIG.ADMIN_PASSWORD;
export const REDIS_URL = CONFIG.REDIS_URL;
export const SUPABASE_URL = CONFIG.SUPABASE_URL;
export const SUPABASE_KEY = CONFIG.SUPABASE_KEY;
export const PROXY_URL = CONFIG.PROXY_URL;
export const CHANNEL_USERNAME = CONFIG.CHANNEL_USERNAME;
export const STORAGE_CHANNEL_ID = CONFIG.STORAGE_CHANNEL_ID;
export const BROADCAST_STORAGE_ID = CONFIG.BROADCAST_STORAGE_ID;
export const SPOTIPY_CLIENT_ID = CONFIG.SPOTIPY_CLIENT_ID;
export const SPOTIPY_CLIENT_SECRET = CONFIG.SPOTIPY_CLIENT_SECRET;

// ========================= UTILITY FUNCTIONS =========================

/**
 * Возвращает безопасную копию конфига для логирования (без секретов)
 * @returns {Object} Конфиг с замаскированными секретами
 */
export function getSafeConfig() {
  return {
    ADMIN_ID: CONFIG.ADMIN_ID,
    PORT: CONFIG.PORT,
    WEBHOOK_URL: CONFIG.WEBHOOK_URL,
    WEBHOOK_PATH: CONFIG.WEBHOOK_PATH,
    CHANNEL_USERNAME: CONFIG.CHANNEL_USERNAME,
    NODE_ENV: CONFIG.nodeEnv,
    isDev: CONFIG.isDev,
    
    // Маскируем секреты
    BOT_TOKEN: CONFIG.BOT_TOKEN ? '***' + CONFIG.BOT_TOKEN.slice(-4) : null,
    DATABASE_URL: CONFIG.DATABASE_URL ? CONFIG.DATABASE_URL.split('@')[1] : null, // только хост
    SESSION_SECRET: CONFIG.SESSION_SECRET ? `***${CONFIG.SESSION_SECRET.length} chars***` : null,
    ADMIN_PASSWORD: CONFIG.ADMIN_PASSWORD ? '***' : null,
    REDIS_URL: CONFIG.REDIS_URL ? 'configured' : 'not set',
    SUPABASE_KEY: CONFIG.SUPABASE_KEY ? '***' + CONFIG.SUPABASE_KEY.slice(-4) : 'not set',
    PROXY_URL: CONFIG.PROXY_URL ? 'configured' : 'not set',
    SPOTIPY_CLIENT_SECRET: CONFIG.SPOTIPY_CLIENT_SECRET ? '***' : 'not set'
  };
}

/**
 * Проверяет, настроен ли Redis
 * @returns {boolean}
 */
export function hasRedis() {
  return Boolean(CONFIG.REDIS_URL);
}

/**
 * Проверяет, настроен ли Supabase
 * @returns {boolean}
 */
export function hasSupabase() {
  return Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_KEY);
}

/**
 * Проверяет, настроен ли бонус за подписку
 * @returns {boolean}
 */
export function hasChannelBonus() {
  return Boolean(CONFIG.CHANNEL_USERNAME);
}

/**
 * Проверяет, настроено ли хранилище для медиафайлов
 * @returns {boolean}
 */
export function hasMediaStorage() {
  return Boolean(CONFIG.STORAGE_CHANNEL_ID);
}

// ========================= STARTUP LOG =========================

if (isDev) {
  console.log('\n🔧 Запуск в режиме разработки (development)');
  console.log('📋 Конфигурация:', getSafeConfig());
  console.log('');
} else {
  console.log('\n🚀 Запуск в режиме production');
  console.log(`📡 Webhook: ${CONFIG.WEBHOOK_URL}${CONFIG.WEBHOOK_PATH}`);
  console.log(`🔐 Redis: ${hasRedis() ? '✅ настроен' : '⚠️  не настроен'}`);
  console.log(`📦 Supabase: ${hasSupabase() ? '✅ настроен' : '⚠️  не настроен'}`);
  console.log(`🎁 Бонусы за подписку: ${hasChannelBonus() ? '✅ доступны' : '⚠️  недоступны'}`);
  console.log('');
}

// ========================= EXPORTS SUMMARY =========================
// Основной экспорт: CONFIG (замороженный объект)
// Именованные экспорты: все переменные по отдельности (для обратной совместимости)
// Утилиты: getSafeConfig(), hasRedis(), hasSupabase(), hasChannelBonus(), hasMediaStorage()