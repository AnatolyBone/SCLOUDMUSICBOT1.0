// services/referralManager.js (ИСПРАВЛЕННАЯ ВЕРСИЯ)

import { setPremium } from '../db.js';

const REFERRER_BONUS_DAYS = 3;
const NEW_USER_BONUS_DAYS = 3;

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

export async function processNewUserReferral(newUser, ctx) {
    if (!newUser.referrer_id) return;

    console.log(`[Referral] Новый пользователь ${newUser.id} пришел от ${newUser.referrer_id}`);
    const referrerId = newUser.referrer_id;

    try {
        await setPremium(referrerId, 30, REFERRER_BONUS_DAYS, true);
        const friendName = ctx.from.first_name || 'Новый пользователь';
        
        // ИСПОЛЬЗУЕМ ctx.telegram ВМЕСТО bot.telegram
        await ctx.telegram.sendMessage(
            referrerId,
            `🎉 Ваш друг **${friendName}** присоединился по вашей ссылке!\n\nВам начислено **+${REFERRER_BONUS_DAYS} дня тарифа Plus**. Спасибо!`,
            { parse_mode: 'Markdown' }
        ).catch(e => console.error(`[Referral] Не удалось уведомить ${referrerId}:`, e.message));

    } catch (e) {
        console.error(`[Referral] Не удалось начислить бонус ${referrerId}:`, e.message);
    }

    try {
        await setPremium(newUser.id, 30, NEW_USER_BONUS_DAYS);
        await ctx.reply(`🎁 За регистрацию по приглашению мы дарим вам **${NEW_USER_BONUS_DAYS} дня тарифа Plus**!`, { parse_mode: 'Markdown' });
    } catch (e) {
         console.error(`[Referral] Не удалось начислить приветственный бонус ${newUser.id}:`, e.message);
    }
}