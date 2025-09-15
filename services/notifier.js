// services/notifier.js

import {
  findUsersExpiringIn,
  markStageNotified,
  updateUserField,
  logUserAction
} from '../db.js';
import { T } from '../config/texts.js';

// Чтобы отправлять раз в сутки (после 10:00 UTC)
let lastNotificationDate = null;

function pluralDays(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'дней';
  if (b > 1 && b < 5) return 'дня';
  if (b === 1) return 'день';
  return 'дней';
}

/**
 * Дневной нотайфер: 3д / 1д / 0д
 * Вызывается часто (раз в минуту), но реально срабатывает 1 раз в день после 10:00 UTC.
 * Использует окна (сутки по UTC) и флаги:
 *  - notified_exp_3d
 *  - notified_exp_1d
 *  - notified_exp_0d
 */
export async function checkAndSendExpirationNotifications(bot) {
  const now = new Date();
  const currentDate = now.toISOString().slice(0, 10);

  // Уже делали сегодня — выходим
  if (currentDate === lastNotificationDate) return;

  // Шлем ОДИН РАЗ после 10:00 UTC (устойчиво к рестартам)
  if (now.getUTCHours() < 10) return;

  console.log(`[Notifier] Старт рассылки за ${currentDate} (UTC>=10:00).`);

  const stages = [
    { days: 3, flag: 'notified_exp_3d', key: 'exp_3d' },
    { days: 1, flag: 'notified_exp_1d', key: 'exp_1d' },
    { days: 0, flag: 'notified_exp_0d', key: 'exp_0d' }
  ];

  try {
    for (const s of stages) {
      const users = await findUsersExpiringIn(s.days, s.flag);
      if (!users?.length) continue;

      console.log(`[Notifier] Этап ${s.days}д: ${users.length} пользователей.`);

      for (const u of users) {
        const name = u.first_name || 'пользователь';
        const daysWord = pluralDays(s.days);

        // Текст из конфигов, либо дефолт
        let tpl = T(s.key) || (
          s.days === 3
            ? `👋 Привет, {name}!\nВаша подписка истекает через {days} {days_word}.\nНе забудьте продлить: /premium`
            : s.days === 1
              ? `👋 Привет, {name}!\nВаша подписка истекает завтра.\nПродлите заранее: /premium`
              : `⚠️ Привет, {name}!\nВаша подписка истекает сегодня.\nПродлите сейчас: /premium`
        );

        const msg = tpl
          .replace('{name}', name)
          .replace('{days}', String(s.days))
          .replace('{days_word}', daysWord);

        try {
          await bot.telegram.sendMessage(u.id, msg);
          await markStageNotified(u.id, s.flag);
          await logUserAction(u.id, 'premium_expiring_notified', {
            stage: s.flag,
            premium_until: u.premium_until
          });
        } catch (e) {
          if (e?.response?.error_code === 403) {
            // Пользователь заблокировал бота — деактивируем и помечаем флаг, чтобы не спамить
            await updateUserField(u.id, 'active', false).catch(() => {});
            await markStageNotified(u.id, s.flag).catch(() => {});
          } else {
            console.error(`[Notifier] Ошибка отправки ${u.id}:`, e?.message || e);
          }
        }

        // Лёгкий троттлинг ~3.3 сообщения/сек
        await new Promise(r => setTimeout(r, 300));
      }
    }
  } catch (e) {
    console.error('[Notifier] Fatal:', e);
  } finally {
    // Помечаем, что рассылка за текущую дату выполнена (даже если 0 получателей)
    lastNotificationDate = currentDate;
    console.log('[Notifier] Завершено.');
  }
}

/**
 * Почасовой нотайфер: страхует только "сегодня" (0д).
 * Использует тот же флаг notified_exp_0d — дублей с дневным не будет.
 * Планировать раз в час.
 */
export async function notifyExpiringTodayHourly(bot) {
  try {
    // Берём тех, у кого истечение сегодня (окно суток по UTC), и кто ещё не уведомлён по 0d
    const users = await findUsersExpiringIn(0, 'notified_exp_0d');
    if (!users?.length) return;

    console.log(`[Notifier/Hourly-0d] кандидатов: ${users.length}`);

    for (const u of users) {
      const untilText = new Date(u.premium_until).toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });

      const text =
        `⏳ Ваша подписка истекает сегодня.\n\n` +
        `Дата окончания: ${untilText}.\n` +
        `Чтобы не потерять повышенный лимит, продлите подписку: /premium`;

      try {
        await bot.telegram.sendMessage(u.id, text);
      } catch (e) {
        console.warn('[Notifier/Hourly-0d] send fail', u.id, e.message);
      } finally {
        // Флаг ставим в любом случае, чтобы не дудосить при повторных проверках
        await markStageNotified(u.id, 'notified_exp_0d').catch(() => {});
        await logUserAction(u.id, 'premium_expiring_notified', {
          stage: 'notified_exp_0d',
          premium_until: u.premium_until
        }).catch(() => {});
      }

      await new Promise(r => setTimeout(r, 250));
    }
  } catch (e) {
    console.error('[Notifier/Hourly-0d] error:', e.message);
  }
}