// services/referralManager.js

import { bot } from '../bot.js';
import { setPremium } from '../db.js';

const REFERRER_BONUS_DAYS = 3; // Бонус пригласившему (в днях)
const NEW_USER_BONUS_DAYS = 3; // Бонус новому пользователю (в днях)

/**
 * Генерирует и отправляет пользователю его реферальную ссылку.
 * @param {object} ctx - Контекст Telegraf.
 */
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

    await ctx.reply(message, { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true 
    });
}

/**
 * Обрабатывает нового пользователя, проверяет реферала и начисляет бонусы.
 * @param {object} newUser - Объект нового пользователя из нашей БД.
 * @param {object} ctx - Контекст Telegraf.
 */
export async function processNewUserReferral(newUser, ctx) {
    if (!newUser.referrer_id) return; // Это не реферал, выходим.

    console.log(`[Referral] Новый пользователь ${newUser.id} пришел от ${newUser.referrer_id}`);
    const referrerId = newUser.referrer_id;

    // 1. Начисляем бонус пригласившему
    try {
        await setPremium(referrerId, 30, REFERRER_BONUS_DAYS, true); // true = добавить дни

        const friendName = ctx.from.first_name || 'Новый пользователь';
        await bot.telegram.sendMessage(
            referrerId,
            `🎉 Ваш друг **${friendName}** присоединился по вашей ссылке!\n\nВам начислено **+${REFERRER_BONUS_DAYS} дня тарифа Plus**. Спасибо!`,
            { parse_mode: 'Markdown' }
        ).catch(e => console.error(`[Referral] Не удалось уведомить ${referrerId}:`, e.message));
    } catch (e) {
        console.error(`[Referral] Не удалось начислить бонус ${referrerId}:`, e.message);
    }

    // 2. Даем бонус новому пользователю
    try {
        await setPremium(newUser.id, 30, NEW_USER_BONUS_DAYS);
        await ctx.reply(`🎁 За регистрацию по приглашению мы дарим вам **${NEW_USER_BONUS_DAYS} дня тарифа Plus**!`, { parse_mode: 'Markdown' });
    } catch (e) {
         console.error(`[Referral] Не удалось начислить приветственный бонус ${newUser.id}:`, e.message);
    }
}