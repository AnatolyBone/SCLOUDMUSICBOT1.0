// services/referralManager.js (ФИНАЛЬНАЯ ПОЛНАЯ ВЕРСИЯ С ИМПОРТАМИ)

// --- 1. ДОБАВЛЕНЫ НЕДОСТАЮЩИЕ ИМПОРТЫ ---
import { setPremium, getUser, logUserAction } from '../db.js';
import { bot } from '../bot.js';

// --- 2. ТВОИ КОНСТАНТЫ И ФУНКЦИИ (ОСТАЮТСЯ БЕЗ ИЗМЕНЕНИЙ) ---
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
    if (!newUser.referrer_id) {
        return;
    }

    const referrerId = newUser.referrer_id;
    console.log(`[Referral] Новый пользователь ${newUser.id} пришел от ${referrerId}. Обрабатываю бонусы...`);

    try {
        // Бонус для нового пользователя (реферала)
        await setPremium(newUser.id, 30, NEW_USER_BONUS_DAYS);
        await ctx.reply(`🎉 В качестве приветственного бонуса мы начислили вам <b>${NEW_USER_BONUS_DAYS} дня тарифа Plus!</b>`, { parse_mode: 'HTML' });
        await logUserAction(newUser.id, 'referral_bonus_received', { type: 'new_user' });

        // Бонус для того, кто пригласил (реферера)
        const referrer = await getUser(referrerId);
        if (!referrer) return;

        // "Умная" логика начисления бонуса
        if (referrer.premium_limit > 30) {
            await setPremium(referrer.id, referrer.premium_limit, REFERRER_BONUS_DAYS);
            console.log(`[Referral] Реферер ${referrerId} имеет высокий тариф. Продлеваем подписку на ${REFERRER_BONUS_DAYS} дня.`);
            await bot.telegram.sendMessage(
                referrerId,
                `🥳 По вашей ссылке присоединился новый пользователь!\n\nВ качестве благодарности мы <b>продлили вашу текущую подписку на ${REFERRER_BONUS_DAYS} дня</b>. Спасибо, что вы с нами!`,
                { parse_mode: 'HTML' }
            );
        } else {
            await setPremium(referrer.id, 30, REFERRER_BONUS_DAYS);
            console.log(`[Referral] Реферер ${referrerId} получает/обновляет тариф Plus на ${REFERRER_BONUS_DAYS} дня.`);
            await bot.telegram.sendMessage(
                referrerId,
                `🥳 По вашей ссылке присоединился новый пользователь!\n\nВ качестве благодарности мы начислили вам <b>${REFERRER_BONUS_DAYS} дня тарифа Plus</b>. Спасибо, что вы с нами!`,
                { parse_mode: 'HTML' }
            );
        }
        
        await logUserAction(referrerId, 'referral_bonus_received', { type: 'referrer', referred_user_id: newUser.id });

    } catch (e) {
        console.error(`[Referral] Ошибка при начислении реферального бонуса для ${newUser.id} и ${referrerId}:`, e);
    }
}