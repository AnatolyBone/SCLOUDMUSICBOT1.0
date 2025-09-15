// services/notifier.js
import { findUsersExpiringIn, markStageNotified, updateUserField, pool, logUserAction } from '../db.js';
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

// Дневной нотайфер: 3д/1д/0д (у тебя уже был)
export async function checkAndSendExpirationNotifications(bot) {
  const now = new Date();
  const currentDate = now.toISOString().slice(0, 10);
  if (currentDate === lastNotificationDate) return;
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
        let tpl = T(s.key) || (
          s.days === 3
            ? `👋 Привет, {name}!\nВаша подписка истекает через {days} {days_word}.\nНе забудьте продлить: /premium`
            : s.days === 1
              ? `👋 Привет, {name}!\nВаша подписка истекает завтра.\nПродлите заранее: /premium`
              : `⚠️ Привет, {name}!\nВаша подписка истекает сегодня.\nПродлите сейчас: /premium`
        );
        const msg = tpl.replace('{name}', name).replace('{days}', String(s.days)).replace('{days_word}', daysWord);

        try {
          await bot.telegram.sendMessage(u.id, msg);
          await markStageNotified(u.id, s.flag);
          await logUserAction(u.id, 'premium_expiring_notified', { stage: s.flag, premium_until: u.premium_until });
        } catch (e) {
          if (e?.response?.error_code === 403) {
            await updateUserField(u.id, 'active', false).catch(() => {});
            await markStageNotified(u.id, s.flag).catch(() => {});
          } else {
            console.error(`[Notifier] Ошибка отправки ${u.id}:`, e?.message || e);
          }
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }
  } catch (e) {
    console.error('[Notifier] Fatal:', e);
  } finally {
    lastNotificationDate = currentDate;
    console.log('[Notifier] Завершено.');
  }
}

// Почасовой нотайфер: страхует "сегодня" (0d), чтобы не промахнуться
export async function notifyExpiringTodayHourly(bot, lookaheadHours = 24) {
  try {
    const { rows: users } = await pool.query(
      `
      SELECT id, first_name, premium_until
      FROM users
      WHERE premium_limit <> 5
        AND premium_until IS NOT NULL
        AND premium_until > NOW()
        AND premium_until <= NOW() + ($1 || ' hours')::interval
        AND COALESCE(notified_exp_0d, false) = false
      LIMIT 300
      `,
      [lookaheadHours]
    );

    if (!users.length) return;

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
        // помечаем вне зависимости от результата, чтобы не дудосить
        await markStageNotified(u.id, 'notified_exp_0d').catch(() => {});
        await logUserAction(u.id, 'premium_expiring_notified', { stage: 'notified_exp_0d', premium_until: u.premium_until }).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 250));
    }
  } catch (e) {
    console.error('[Notifier/Hourly-0d] error:', e.message);
  }
}