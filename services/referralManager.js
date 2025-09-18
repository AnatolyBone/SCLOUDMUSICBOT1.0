// services/referralManager.js (АКТУАЛЬНАЯ ВЕРСИЯ)

import { setTariffAdmin, getUser, logUserAction } from '../db.js';
import { bot } from '../bot.js';

const REFERRER_BONUS_DAYS = 3;   // бонус за приглашение рефереру
const NEW_USER_BONUS_DAYS = 3;   // приветственный бонус новому пользователю (рефералу)

// Команда для получения реферальной ссылки
export async function handleReferralCommand(ctx) {
  const userId = ctx.from.id;
  const botUsername = ctx.botInfo.username;
  const referralLink = `https://t.me/${botUsername}?start=ref_${userId}`;
  const message = `
🙋‍♂️ **Приглашайте друзей и получайте бонусы!**

Поделитесь своей персональной ссылкой с друзьями. За каждого друга, который запустит бота по вашей ссылке, вы получите **+${REFERRER_BONUS_DAYS} дня тарифа Plus**! 🎁

Ваш друг также получит приветственный бонус.

🔗 **Ваша ссылка для приглашений:**
\`${referralLink}\`

*(Нажмите на ссылку, чтобы скопировать её)*
  `;
  await ctx.reply(message, { parse_mode: 'Markdown', disable_web_page_preview: true });
}

// Обработка бонусов при приходе нового пользователя по реферальной ссылке
export async function processNewUserReferral(newUser, ctx) {
  // Если пользователь пришёл без реферера — ничего не делаем
  if (!newUser?.referrer_id) return;

  const referrerId = newUser.referrer_id;
  console.log(`[Referral] Новый пользователь ${newUser.id} пришел от ${referrerId}. Обрабатываю бонусы...`);

  try {
    // 1) Бонус новому пользователю — выдаём/продлеваем Plus на N дней (extend)
    await setTariffAdmin(newUser.id, 30, NEW_USER_BONUS_DAYS, { mode: 'extend' });
    await ctx.reply(
      `🎉 В качестве приветственного бонуса мы начислили вам <b>${NEW_USER_BONUS_DAYS} дня тарифа Plus!</b>`,
      { parse_mode: 'HTML' }
    );
    await logUserAction(newUser.id, 'referral_bonus_received', { type: 'new_user', days: NEW_USER_BONUS_DAYS, limit: 30 });

    // 2) Бонус рефереру
    const referrer = await getUser(referrerId);
    if (!referrer) return;

    if (referrer.premium_limit > 30) {
      // У реферера тариф выше чем Plus — продлеваем текущий лимит на N дней (extend)
      await setTariffAdmin(referrer.id, referrer.premium_limit, REFERRER_BONUS_DAYS, { mode: 'extend' });
      console.log(`[Referral] Реферер ${referrerId} имеет высокий тариф. Продлеваем на ${REFERRER_BONUS_DAYS} дня.`);
      await bot.telegram.sendMessage(
        referrerId,
        `🥳 По вашей ссылке присоединился новый пользователь!\n\n` +
        `Мы <b>продлили вашу текущую подписку на ${REFERRER_BONUS_DAYS} дня</b>. Спасибо, что вы с нами!`,
        { parse_mode: 'HTML' }
      );
    } else {
      // Иначе — выдаём/продлеваем Plus на N дней (extend)
      await setTariffAdmin(referrer.id, 30, REFERRER_BONUS_DAYS, { mode: 'extend' });
      console.log(`[Referral] Реферер ${referrerId} получает/обновляет тариф Plus на ${REFERRER_BONUS_DAYS} дня.`);
      await bot.telegram.sendMessage(
        referrerId,
        `🥳 По вашей ссылке присоединился новый пользователь!\n\n` +
        `Мы начислили вам <b>${REFERRER_BONUS_DAYS} дня тарифа Plus</b>. Спасибо, что вы с нами!`,
        { parse_mode: 'HTML' }
      );
    }

    await logUserAction(referrerId, 'referral_bonus_received', {
      type: 'referrer',
      days: REFERRER_BONUS_DAYS,
      limit: referrer.premium_limit > 30 ? referrer.premium_limit : 30,
      referred_user_id: newUser.id
    });
  } catch (e) {
    console.error(`[Referral] Ошибка при начислении реферального бонуса для ${newUser.id} и ${referrerId}:`, e);
  }
}