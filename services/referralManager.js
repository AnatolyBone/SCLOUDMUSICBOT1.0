// services/referralManager.js

import { bot } from '../bot.js';
import { setPremium } from '../db.js';

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

Поделитесь своей персональной ссылкой с друзьями. За каждого друга, который запустит бота по вашей ссылке, вы получите **+3 дня тарифа Plus**! 🎁

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
    if (!newUser.referrer_id) {
        return; // Это не реферал, выходим
    }

    console.log(`[Referral] Новый пользователь ${newUser.id} пришел от ${newUser.referrer_id}`);
    const referrerId = newUser.referrer_id;

    // 1. Начисляем бонус пригласившему
    try {
        // Даем 3 дня тарифа Plus (30 скачиваний/день), добавляя их к текущей подписке
        await setPremium(referrerId, 30, 3, true); 

        const friendName = ctx.from.first_name || 'Новый пользователь';
        await bot.telegram.sendMessage(
            referrerId,
            `🎉 Ваш друг **${friendName}** присоединился к боту по вашей ссылке!\n\nВам начислено **+3 дня тарифа Plus**. Спасибо!`,
            { parse_mode: 'Markdown' }
        );
    } catch (e) {
        console.error(`[Referral] Не удалось начислить бонус или уведомить ${referrerId}:`, e.message);
    }

    // 2. (Опционально) Даем бонус новому пользователю
    try {
        await setPremium(newUser.id, 30, 1); // Даем 1 день тарифа Plus
        await ctx.reply('🎁 В качестве приветственного бонуса мы дарим вам **1 день тарифа Plus**!', { parse_mode: 'Markdown' });
    } catch (e) {
         console.error(`[Referral] Не удалось начислить приветственный бонус ${newUser.id}:`, e.message);
    }
}