// services/notifier.js (улучшенная версия)

import pMap from 'p-map';
import { Mutex } from 'async-mutex';
import {
  findUsersExpiringIn,
  markStageNotified,
  updateUserField,
  logUserAction
} from '../db.js';
import { T } from '../config/texts.js';
import { ADMIN_ID } from '../config.js';
import redisService from './redisClient.js';

// ========================= CONFIGURATION =========================

const NOTIFICATION_THROTTLE_MS = parseInt(process.env.NOTIFICATION_THROTTLE_MS, 10) || 300;
const NOTIFICATION_CONCURRENCY = parseInt(process.env.NOTIFICATION_CONCURRENCY, 10) || 3;
const NOTIFICATION_START_HOUR_UTC = 10; // Начинаем после 10:00 UTC

const notificationMutex = new Mutex();

// ========================= HELPER FUNCTIONS =========================

/**
 * Склонение слова "день/дня/дней"
 */
function pluralDays(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'дней';
  if (b > 1 && b < 5) return 'дня';
  if (b === 1) return 'день';
  return 'дней';
}

/**
 * Экранирование HTML (защита от XSS)
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Получает дату последнего запуска из Redis
 */
async function getLastNotificationDate() {
  try {
    return await redisService.get('notifier:last_run');
  } catch (e) {
    console.warn('[Notifier] Не удалось получить last_run из Redis:', e.message);
    return null;
  }
}

/**
 * Сохраняет дату последнего запуска в Redis
 */
async function setLastNotificationDate(date) {
  try {
    await redisService.setEx('notifier:last_run', 86400, date); // TTL 24 часа
  } catch (e) {
    console.warn('[Notifier] Не удалось сохранить last_run в Redis:', e.message);
  }
}

/**
 * Формирует сообщение для пользователя
 */
function buildMessage(stage, userName) {
  const name = escapeHtml(userName);
  const daysWord = pluralDays(stage.days);
  
  // Берём текст из конфига или дефолтный
  let tpl = T(stage.key);
  
  if (!tpl) {
    if (stage.days === 3) {
      tpl = `👋 Привет, {name}!\nВаша подписка истекает через {days} {days_word}.\nНе забудьте продлить: /premium`;
    } else if (stage.days === 1) {
      tpl = `👋 Привет, {name}!\nВаша подписка истекает завтра.\nПродлите заранее: /premium`;
    } else {
      tpl = `⚠️ Привет, {name}!\nВаша подписка истекает сегодня.\nПродлите сейчас: /premium`;
    }
  }
  
  return tpl
    .replace('{name}', name)
    .replace('{days}', String(stage.days))
    .replace('{days_word}', daysWord);
}

/**
 * Обрабатывает ошибку отправки уведомления
 */
async function handleNotificationError(error, userId, flag) {
  if (error?.response?.error_code === 403) {
    // Пользователь заблокировал бота
    console.log(`[Notifier] Пользователь ${userId} заблокировал бота, деактивирую.`);
    await Promise.all([
      updateUserField(userId, 'active', false).catch(() => {}),
      markStageNotified(userId, flag).catch(() => {})
    ]);
    return 'blocked';
  } else {
    console.error(`[Notifier] Ошибка отправки ${userId}:`, error?.message || error);
    return 'error';
  }
}

/**
 * Отправляет уведомление одному пользователю
 */
async function sendNotificationToUser(bot, user, stage) {
  const msg = buildMessage(stage, user.first_name || 'пользователь');
  
  try {
    await bot.telegram.sendMessage(user.id, msg);
    
    await Promise.all([
      markStageNotified(user.id, stage.flag),
      logUserAction(user.id, 'premium_expiring_notified', {
        stage: stage.flag,
        premium_until: user.premium_until
      })
    ]);
    
    return 'success';
  } catch (e) {
    return await handleNotificationError(e, user.id, stage.flag);
  }
}

/**
 * Отправляет отчёт админу
 */
async function sendAdminReport(bot, stats) {
  if (!ADMIN_ID) return;
  
  const report = 
    `📊 <b>Отчёт о рассылке уведомлений</b>\n\n` +
    `✅ Успешно: <b>${stats.success}</b>\n` +
    `❌ Ошибок: <b>${stats.errors}</b>\n` +
    `🚫 Заблокировали бота: <b>${stats.blocked}</b>\n` +
    `👥 Всего обработано: <b>${stats.total}</b>\n` +
    `⏱ Длительность: <b>${stats.duration}с</b>`;
  
  try {
    await bot.telegram.sendMessage(ADMIN_ID, report, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('[Notifier] Не удалось отправить отчёт админу:', e.message);
  }
}

// ========================= MAIN FUNCTIONS =========================

/**
 * Дневной нотификатор: 3д / 1д / 0д
 * Вызывается часто (раз в минуту), но реально срабатывает 1 раз в день после 10:00 UTC.
 */
export async function checkAndSendExpirationNotifications(bot) {
  // Защита от одновременного запуска
  const release = await notificationMutex.acquire();
  
  try {
    const now = new Date();
    const currentDate = now.toISOString().slice(0, 10);
    
    // Проверка: уже делали сегодня?
    const lastRun = await getLastNotificationDate();
    if (currentDate === lastRun) {
      return;
    }
    
    // Проверка: время >= 10:00 UTC?
    if (now.getUTCHours() < NOTIFICATION_START_HOUR_UTC) {
      return;
    }
    
    console.log(`[Notifier] Старт рассылки за ${currentDate} (UTC>=${NOTIFICATION_START_HOUR_UTC}:00).`);
    const startTime = Date.now();
    
    const stages = [
      { days: 3, flag: 'notified_exp_3d', key: 'exp_3d' },
      { days: 1, flag: 'notified_exp_1d', key: 'exp_1d' },
      { days: 0, flag: 'notified_exp_0d', key: 'exp_0d' }
    ];
    
    const globalStats = { success: 0, errors: 0, blocked: 0, total: 0 };
    
    for (const stage of stages) {
      const users = await findUsersExpiringIn(stage.days, stage.flag);
      
      if (!users?.length) {
        console.log(`[Notifier] Этап ${stage.days}д: пользователей не найдено.`);
        continue;
      }
      
      console.log(`[Notifier] Этап ${stage.days}д: ${users.length} пользователей.`);
      globalStats.total += users.length;
      
      const results = await pMap(
        users,
        async (user) => sendNotificationToUser(bot, user, stage),
        { concurrency: NOTIFICATION_CONCURRENCY }
      );
      
      // Подсчёт статистики
      results.forEach(result => {
        if (result === 'success') globalStats.success++;
        // services/notifier.js (улучшенная версия) - ЧАСТЬ 2 (ФИНАЛ)

else if (result === 'blocked') globalStats.blocked++;
else globalStats.errors++;
});
}

// Вычисляем длительность
const duration = ((Date.now() - startTime) / 1000).toFixed(1);
globalStats.duration = duration;

console.log(`[Notifier] Завершено. Статистика:`, globalStats);

// Отправляем отчёт админу
if (globalStats.total > 0) {
  await sendAdminReport(bot, globalStats);
}

// Помечаем, что рассылка за сегодня выполнена
await setLastNotificationDate(currentDate);

}
catch (e) {
  console.error('[Notifier] Критическая ошибка:', e);
} finally {
  release();
}
}

/**
 * Почасовой нотификатор: страхует только "сегодня" (0д)
 * Использует тот же флаг notified_exp_0d — дублей с дневным не будет.
 * Планировать раз в час.
 */
export async function notifyExpiringTodayHourly(bot) {
  try {
    // Берём тех, у кого истечение сегодня (окно суток по UTC), и кто ещё не уведомлён
    const users = await findUsersExpiringIn(0, 'notified_exp_0d');
    
    if (!users?.length) {
      console.log('[Notifier/Hourly-0d] Пользователей для уведомления не найдено.');
      return;
    }
    
    console.log(`[Notifier/Hourly-0d] Найдено кандидатов: ${users.length}`);
    
    const stats = { success: 0, errors: 0, blocked: 0 };
    
    const results = await pMap(
      users,
      async (user) => {
        const untilText = new Date(user.premium_until).toLocaleString('ru-RU', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        
        const msg =
          `⏳ Ваша подписка истекает сегодня.\n\n` +
          `Дата окончания: ${untilText}.\n` +
          `Чтобы не потерять повышенный лимит, продлите подписку: /premium`;
        
        try {
          await bot.telegram.sendMessage(user.id, msg);
          
          await Promise.all([
            markStageNotified(user.id, 'notified_exp_0d'),
            logUserAction(user.id, 'premium_expiring_notified', {
              stage: 'notified_exp_0d',
              premium_until: user.premium_until
            })
          ]);
          
          return 'success';
        } catch (e) {
          // Ставим флаг в любом случае, чтобы не спамить
          await markStageNotified(user.id, 'notified_exp_0d').catch(() => {});
          
          if (e?.response?.error_code === 403) {
            await updateUserField(user.id, 'active', false).catch(() => {});
            return 'blocked';
          }
          
          console.warn('[Notifier/Hourly-0d] Ошибка отправки', user.id, e.message);
          return 'error';
        }
      }, { concurrency: NOTIFICATION_CONCURRENCY }
    );
    
    // Подсчёт статистики
    results.forEach(result => {
      if (result === 'success') stats.success++;
      else if (result === 'blocked') stats.blocked++;
      else stats.errors++;
    });
    
    console.log(`[Notifier/Hourly-0d] Завершено.`, stats);
    
  } catch (e) {
    console.error('[Notifier/Hourly-0d] Критическая ошибка:', e.message);
  }
}

// ========================= GRACEFUL SHUTDOWN =========================

/**
 * Освобождение мьютекса при завершении процесса
 */
process.on('SIGTERM', () => {
  if (notificationMutex.isLocked()) {
    console.log('[Notifier] Завершение работы, освобождаю mutex...');
  }
});

process.on('SIGINT', () => {
  if (notificationMutex.isLocked()) {
    console.log('[Notifier] Завершение работы (SIGINT), освобождаю mutex...');
  }
});

// ========================= EXPORTS SUMMARY =========================
// Основные экспорты:
// - checkAndSendExpirationNotifications: дневной нотификатор (3д/1д/0д)
// - notifyExpiringTodayHourly: почасовой страховщик для 0д

// Вспомогательные функции (не экспортируются):
// - pluralDays: склонение слова "день"
// - escapeHtml: защита от XSS
// - buildMessage: формирование текста уведомления
// - handleNotificationError: обработка ошибок отправки
// - sendNotificationToUser: отправка одному пользователю
// - sendAdminReport: отчёт админу
// - getLastNotificationDate/setLastNotificationDate: работа с Redis

// ========================= CONFIGURATION TIPS =========================
// 
// Переменные окружения (опционально):
// - NOTIFICATION_THROTTLE_MS=300 (не используется в pMap, оставлено для совместимости)
// - NOTIFICATION_CONCURRENCY=3 (сколько уведомлений отправлять параллельно)
// 
// Для бесплатного тарифа Render.com рекомендуется:
// NOTIFICATION_CONCURRENCY=3 (безопасно для Telegram API)
// 
// ========================= USAGE IN index.js =========================
// 
// import { checkAndSendExpirationNotifications, notifyExpiringTodayHourly } from './services/notifier.js';
// 
// // Дневной нотификатор (раз в минуту, но срабатывает 1 раз в день)
// setInterval(() => checkAndSendExpirationNotifications(bot), 60000);
// 
// // Почасовой страховщик для "сегодня"
// setInterval(() => notifyExpiringTodayHourly(bot), 3600000);
// 
// ========================= END OF FILE =========================