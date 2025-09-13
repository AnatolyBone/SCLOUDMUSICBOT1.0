// services/notifier.js

import { findUsersExpiringIn, markStageNotified, updateUserField } from '../db.js';
import { T } from '../config/texts.js';

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
 * Ежедневная рассылка уведомлений об истечении подписки.
 * Вызывается планировщиком раз в минуту (workerManager).
 */
export async function checkAndSendExpirationNotifications(bot) {
  const now = new Date();
  const currentDate = now.toISOString().slice(0, 10);

  // Уже делали сегодня — выходим
  if (currentDate === lastNotificationDate) return;

  // Шлём ОДИН РАЗ после 10:00 UTC (чтобы не промахнуться при рестартах)
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

        // Шаблон из текстов или дефолт
        let tpl = T(s.key) || (
          s.days === 3
            ? `👋 Привет, {name}!\nВаша подписка истекает через {days} {days_word}.\nНе забудьте продлить её, чтобы сохранить доступ ко всем возможностям!\n\nНажмите /premium, чтобы посмотреть тарифы.`
            : s.days === 1
              ? `👋 Привет, {name}!\nВаша подписка истекает завтра.\nПродлите заранее, чтобы не потерять доступ. Нажмите /premium.`
              : `⚠️ Привет, {name}!\nВаша подписка истекает сегодня.\nПродлите сейчас: /premium`
        );

        const msg = tpl
          .replace('{name}', name)
          .replace('{days}', String(s.days))
          .replace('{days_word}', daysWord);

        try {
          await bot.telegram.sendMessage(u.id, msg);
          await markStageNotified(u.id, s.flag);
        } catch (e) {
          if (e?.response?.error_code === 403) {
            // Пользователь заблокировал бота
            await updateUserField(u.id, 'active', false).catch(() => {});
            await markStageNotified(u.id, s.flag).catch(() => {});
          } else {
            console.error(`[Notifier] Ошибка отправки ${u.id}:`, e?.message || e);
          }
        }

        // ~3.3 сообщения/сек (чтобы не упереться в лимиты Telegram)
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