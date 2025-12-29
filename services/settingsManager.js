// НОВЫЙ ФАЙЛ: services/settingsManager.js

import { getAppSettings } from '../db.js';

let settingsCache = {};

// Дефолтные значения на случай, если в БД пусто
const DEFAULTS = {
  playlist_limit_free: '10',
  playlist_limit_plus: '30',
  playlist_limit_pro: '100',
  playlist_limit_unlim: '200',
  use_hybrid_worker: 'false', // Гибридная архитектура (воркер для Spotify/YouTube)
  use_spotify: 'true',        // Включен ли сервис Spotify
  use_youtube: 'true',        // Включен ли сервис YouTube
  use_soundcloud: 'true',     // Включен ли сервис SoundCloud
};

/**
 * Загружает настройки из БД в кеш
 */
export async function loadSettings() {
  console.log('[Settings] Загружаю настройки из БД...');
  try {
    const dbSettings = await getAppSettings();
    settingsCache = { ...DEFAULTS, ...dbSettings };
    console.log('[Settings] Настройки успешно загружены:', settingsCache);
  } catch (e) {
    console.error('[Settings] Не удалось загрузить настройки, использую дефолтные:', e.message);
    settingsCache = DEFAULTS;
  }
}

/**
 * Получает значение настройки из кеша
 * @param {string} key - Ключ настройки
 * @returns {string} Значение
 */
export function getSetting(key) {
  return settingsCache[key] || DEFAULTS[key];
}

/**
 * Возвращает все настройки
 */
export function getAllSettings() {
  return settingsCache;
}