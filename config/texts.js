// config/texts.js
import { supabase } from '../db.js';

const defaults = {
  start: '👋 Пришли ссылку на трек или плейлист с SoundCloud.',
  menu: '📋 Меню',
  upgrade: '🔓 Расширить лимит',
  mytracks: '🎵 Мои треки',
  help: 'ℹ️ Помощь',
  error: '❌ Ошибка',
  noTracks: 'Сегодня нет треков.',
  limitReached:
    '🚫 Лимит достигнут ❌\n\n💡 Чтобы качать больше треков, переходи на тариф Plus или выше и качай без ограничений.',
  
  // >>>>>>>> ОБНОВЛЕННЫЙ ТЕКСТ ЗДЕСЬ <<<<<<<<<<
  upgradeInfo:
    `*Выберите подходящий тариф для улучшения:*\n\n` +
    `🎯 *Plus* — *30* загрузок в день\n` +
    `・ Цена: *119₽* в месяц\n\n` +
    `💪 *Pro* — *100* загрузок в день\n` +
    `・ Цена: *199₽* в месяц\n\n` +
    `💎 *Unlimited* — безлимитные загрузки\n` +
    `・ Цена: *299₽* в месяц\n\n` +
    `👉 *Для покупки* или продления подписки, пожалуйста, свяжитесь с администратором: @anatolybone\n` + 
    `📣 Новости: @SCM_BLOG`,
  
  helpInfo:
    'ℹ️ Пришли ссылку — получишь mp3.\n🔓 «Расширить» — оплата тарифа.\n🎵 «Мои треки» — список за сегодня.\n📣 Канал: @SCM_BLOG',
};

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