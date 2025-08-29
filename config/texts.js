// config/texts.js (ПОЛНАЯ ВЕРСИЯ С HTML И НОВЫМ ПРИВЕТСТВИЕМ)

import { supabase } from '../db.js';

const defaults = {
  // --- Ключи для клавиатуры и команд ---
  menu: '📋 Меню',
  upgrade: '🔓 Расширить лимит',
  mytracks: '🎵 Мои треки',
  help: 'ℹ️ Помощь',

  // --- Основные сообщения для пользователей ---
  
  // Обновленный текст для "старых" пользователей
  start: '👋 Снова здравствуйте! Пришлите ссылку на трек.', 
  
  start_new_user: 
    `<b>Добро пожаловать в SCloudMusicBot!</b>\n\n` +
    `Я помогу вам скачать любимые треки и <b>плейлисты</b> с SoundCloud в MP3.\n\n` +
    `<b>Мои главные возможности:</b>\n\n` +
    `📥 <b>1. Скачивание по ссылке</b>\n` +
    `Просто отправьте мне ссылку на трек или целый плейлист, и я начну загрузку.\n\n` +
    `🔎 <b>2. Поиск музыки прямо в чате</b>\n` +
    `В любом другом чате (или здесь) начните вводить <code>@SCloudMusicBot</code> и через пробел название трека. Вы сможете найти и отправить музыку, не выходя из переписки в любом чате!`,
  
  // Текст с информацией о тарифах в формате HTML
  upgradeInfo:
    `<b>🚀 Хочешь больше треков?</b>\n\n` +
    `<b>🆓 Free</b> — 5 🟢\n` +
    `<b>🎯 Plus</b> — 30 (119₽)\n` +
    `<b>💪 Pro</b> — 100 (199₽)\n` +
    `<b>💎 Unlimited</b> — безлимит (299₽)\n\n` +
    `👉 Донат: <a href="https://boosty.to/anatoly_bone/donate">boosty.to/anatoly_bone/donate</a>\n` +
    `✉️ После оплаты напиши: @anatolybone\n\n` +
    `📣 Новости и фишки: @SCMBLOG`,

  // Текст для раздела "Помощь"
  helpInfo:
    'ℹ️ Пришли ссылку — получишь mp3.\n' +
    '🔓 «Расширить» — информация о тарифах.\n' +
    '🎵 «Мои треки» — список за сегодня.\n' +
    '📣 Канал: @SCM_BLOG',

  // --- Системные и служебные сообщения ---
  error: '❌ Произошла непредвиденная ошибка.',
  noTracks: 'Вы еще не скачивали треков сегодня.',
  limitReached: '🚫 Дневной лимит загрузок исчерпан.\n\n{bonus_message}💡 Чтобы скачивать больше, воспользуйтесь кнопкой «Расширить лимит».',
  blockedMessage: '❌ Ваш аккаунт заблокирован администратором.',
};

// --- ЛОГИКА КЭШИРОВАНИЯ И ЗАГРУЗКИ (остается без изменений) ---

let cache = { ...defaults };
let lastLoad = 0;
const TTL_MS = 60 * 1000; // обновляем кэш не чаще раза в минуту

export async function loadTexts(force = false) {
  const now = Date.now();
  if (!force && now - lastLoad < TTL_MS) return cache;

  try {
    const { data, error } = await supabase.from('bot_texts').select('key,value');
    if (error) {
      console.error('[texts] Ошибка загрузки из Supabase:', error.message);
      // В случае ошибки используем кэш/дефолты
      return cache;
    }

    const map = { ...defaults };
    for (const row of data || []) {
      if (row?.key && typeof row.value === 'string') map[row.key] = row.value;
    }

    cache = map;
    lastLoad = now;

  } catch (e) {
    console.error('[texts] Критическая ошибка при загрузке текстов:', e.message);
  }

  return cache;
}

export function T(key) {
  return cache[key] ?? defaults[key] ?? '';
}

export function allTextsSync() {
  return { ...cache };
}

export async function setText(key, value) {
  if (!key) throw new Error('key is required');
  const { error } = await supabase
    .from('bot_texts')
    .upsert({ key, value }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  cache[key] = value;
  lastLoad = 0; // Сбрасываем таймер кэша, чтобы при следующем запросе тексты загрузились заново
  return true;
}