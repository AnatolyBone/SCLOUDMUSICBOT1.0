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

// ЗАМЕНИ СТАРУЮ ФУНКЦИЮ processNewUserReferral НА ЭТУ В referralManager.js

export async function processNewUserReferral(newUser, ctx) {
    // Проверяем, есть ли у нового пользователя вообще реферер
    if (!newUser.referrer_id) {
        return;
    }

    const referrerId = newUser.referrer_id;
    console.log(`[Referral] Новый пользователь ${newUser.id} пришел от ${referrerId}. Обрабатываю бонусы...`);

    try {
        // --- Бонус для нового пользователя (реферала) ---
        // Даем ему 3 дня тарифа Plus
        await setPremium(newUser.id, 30, 3);
        await ctx.reply('🎉 В качестве приветственного бонуса мы начислили вам <b>3 дня тарифа Plus!</b>', { parse_mode: 'HTML' });
        await logUserAction(newUser.id, 'referral_bonus_received', { type: 'new_user' });

        // --- Бонус для того, кто пригласил (реферера) ---
        const referrer = await getUser(referrerId);
        if (!referrer) return;

        // ====================================================================
        //              "УМНАЯ" ЛОГИКА НАЧИСЛЕНИЯ БОНУСА
        // ====================================================================
        
        // Если у реферера тариф ЛУЧШЕ, чем бонусный Plus (лимит > 30)
        if (referrer.premium_limit > 30) {
            // Мы НЕ меняем его тариф, а просто продлеваем текущий на 3 дня
            await setPremium(referrer.id, referrer.premium_limit, 3); 
            console.log(`[Referral] Реферер ${referrerId} имеет высокий тариф. Продлеваем подписку на 3 дня.`);
            
            // Отправляем уведомление о ПРОДЛЕНИИ
            await bot.telegram.sendMessage(
                referrerId,
                `🥳 По вашей ссылке присоединился новый пользователь!\n\nВ качестве благодарности мы <b>продлили вашу текущую подписку на 3 дня</b>. Спасибо, что вы с нами!`,
                { parse_mode: 'HTML' }
            );

        } else {
            // Если у него тариф Free или Plus, мы даем ему/обновляем до тарифа Plus на 3 дня
            await setPremium(referrer.id, 30, 3); 
            console.log(`[Referral] Реферер ${referrerId} получает/обновляет тариф Plus на 3 дня.`);

            // Отправляем уведомление о ПОЛУЧЕНИИ ТАРИФА
            await bot.telegram.sendMessage(
                referrerId,
                `🥳 По вашей ссылке присоединился новый пользователь!\n\nВ качестве благодарности мы начислили вам <b>3 дня тарифа Plus</b>. Спасибо, что вы с нами!`,
                { parse_mode: 'HTML' }
            );
        }
        // ====================================================================
        
        await logUserAction(referrerId, 'referral_bonus_received', { type: 'referrer', referred_user_id: newUser.id });

    } catch (e) {
        console.error(`[Referral] Ошибка при начислении реферального бонуса для ${newUser.id} и ${newUser.referrer_id}:`, e);
    }
}