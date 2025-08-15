// bot.js (ПОЛНАЯ ОБНОВЛЕННАЯ ВЕРСЯ)

import { Telegraf, Markup, TelegramError } from 'telegraf';
import { ADMIN_ID, BOT_TOKEN, WEBHOOK_URL, CHANNEL_USERNAME } from './config.js'; // <-- Добавлен CHANNEL_USERNAME
import { updateUserField, getUser, createUser, setPremium, getAllUsers, resetDailyLimitIfNeeded } from './db.js';
import { T, allTextsSync } from './config/texts.js';
import { enqueue, downloadQueue } from './services/downloadManager.js';

// НОВАЯ ФУНКЦИЯ для проверки подписки на канал
async function isSubscribed(userId) {
    if (!CHANNEL_USERNAME) {
        console.warn('CHANNEL_USERNAME не указан в конфиге. Проверка подписки невозможна.');
        return false;
    }
    try {
        const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, userId);
        return ['creator', 'administrator', 'member'].includes(member.status);
    } catch (e) {
        console.error(`Ошибка проверки подписки для ${userId} на ${CHANNEL_USERNAME}:`, e.message);
        // Если бот не админ в канале или канал приватный, будет ошибка.
        return false;
    }
}

// ВСТАВЬТЕ ЭТОТ НОВЫЙ КОД:
function getTariffName(limit) {
    if (limit >= 10000) return 'Unlimited — 💎'; // Для консистентности с админкой
    if (limit >= 100) return 'Pro — 100 💪';
    if (limit >= 30) return 'Plus — 30 🎯';
    return '🆓 Free — 5 🟢';
}

function getDaysLeft(premiumUntil) {
    if (!premiumUntil) return 0;
    const diff = new Date(premiumUntil) - new Date();
    return Math.max(Math.ceil(diff / 86400000), 0);
}

// ОБНОВЛЕНА функция для отображения меню
function formatMenuMessage(user, ctx) {
    const tariffLabel = getTariffName(user.premium_limit);
    const downloadsToday = user.downloads_today || 0;
    const invited = user.referred_count || 0;
    const refLink = `https://t.me/${ctx.botInfo.username}?start=${user.id}`;
    const daysLeft = getDaysLeft(user.premium_until);

    let message = `
👋 Привет, ${user.first_name || 'пользователь'}!
Твой профиль:
💼 Тариф: *${tariffLabel}*
⏳ Осталось дней подписки: *${daysLeft}*
🎧 Сегодня скачано: *${downloadsToday}* из *${user.premium_limit}*
👫 Приглашено друзей: *${invited}*
🔗 Твоя реферальная ссылка для друзей:
\`${refLink}\`
    `.trim();

    // Добавляем блок про бонус, если он еще не использован
    if (!user.subscribed_bonus_used) {
        message += `\n\n🎁 *Бонус!* Подпишись на наш канал ${CHANNEL_USERNAME} и получи *7 дней тарифа Plus* бесплатно!`;
    }

    message += '\n\nПросто отправь мне ссылку, и я скачаю трек!';
    return message;
}

async function handleSendMessageError(e, userId, ctx = null) {
    // ... (эта функция без изменений)
    console.error(`🔴 Ошибка при работе с пользователем ${userId}:`, e.message);
    if (e instanceof TelegramError && e.response?.error_code === 403) {
        await updateUserField(userId, 'active', false);
        console.log(`- Пользователь ${userId} заблокировал бота. Помечен как неактивный.`);
    } else if (ctx) {
        try {
            await ctx.reply('Произошла ошибка при выполнении вашего запроса. Попробуйте позже.');
        } catch (sendError) {
            console.error(`- Не удалось отправить сообщение об ошибке пользователю ${userId}.`);
        }
    }
}

export const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 300_000 });

bot.catch(async (err, ctx) => {
    // ... (этот блок без изменений)
    console.error(`🔴 [Telegraf Catch] Глобальная ошибка для update ${ctx.update.update_id}:`, err);
    if (err instanceof TelegramError && err.response?.error_code === 403) {
        if (ctx.from?.id) await updateUserField(ctx.from.id, 'active', false);
    }
});

bot.use(async (ctx, next) => {
    // ... (этот блок без изменений)
    if (ctx.from) {
        await resetDailyLimitIfNeeded(ctx.from.id);
        ctx.state.user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    }
    return next();
});

bot.start(async (ctx) => {
    // ... (этот блок без изменений)
    await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.startPayload || null);
    await ctx.reply(T('start'), Markup.keyboard([[T('menu'), T('upgrade')], [T('mytracks'), T('help')]]).resize());
});

bot.command('admin', async (ctx) => {
    // ... (этот блок без изменений)
    if (ctx.from.id !== ADMIN_ID) return;
    try {
        const users = await getAllUsers(true);
        const totalUsers = users.length;
        const activeUsers = users.filter(u => u.active).length;
        const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
        const now = new Date();
        const activeToday = users.filter(u => u.last_active && new Date(u.last_active).toDateString() === now.toDateString()).length;
        const statsMessage = `📊 **Статистика Бота**\n\n👤 **Пользователи:**\n   - Всего: *${totalUsers}*\n   - Активных (в целом): *${activeUsers}*\n   - Активных сегодня: *${activeToday}*\n\n📥 **Загрузки:**\n   - Всего за все время: *${totalDownloads}*\n\n⚙️ **Очередь сейчас:**\n   - В работе: *${downloadQueue.active}*\n   - В ожидании: *${downloadQueue.size}*\n\n🔗 **Админ-панель:**\n[Открыть дашборд](${WEBHOOK_URL.replace(/\/$/, '')}/dashboard)`;
        await ctx.reply(statsMessage, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('❌ Ошибка в команде /admin:', e);
        try { await ctx.reply('⚠️ Произошла ошибка при получении статистики.'); } catch (adminBlockError) { console.log('Админ заблокировал бота.'); }
    }
});

// ОБНОВЛЕННЫЙ обработчик для кнопки "Я подписался"
bot.action('check_subscription', async (ctx) => {
    // Получаем свежие данные о пользователе
    const user = await getUser(ctx.from.id);

    if (user.subscribed_bonus_used) {
        return await ctx.answerCbQuery('Вы уже использовали этот бонус.', { show_alert: true });
    }

    const subscribed = await isSubscribed(ctx.from.id);

    if (subscribed) {
        // Начисляем бонус: 30 лимит (Plus) на 7 дней
        await setPremium(ctx.from.id, 30, 7); 
        await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
        
        // Отвечаем пользователю и убираем кнопку
        await ctx.editMessageText('🎉 Поздравляем! Вам начислено 7 дней тарифа Plus. Спасибо за подписку!\n\nМожете проверить свой новый статус в меню.', { reply_markup: undefined });
        await ctx.answerCbQuery('Бонус успешно активирован!');
    } else {
        await ctx.answerCbQuery(`Вы еще не подписаны на канал ${CHANNEL_USERNAME}. Пожалуйста, подпишитесь и нажмите кнопку снова.`, { show_alert: true });
    }
});

// ОБНОВЛЕННЫЙ обработчик для команды "Меню"
bot.hears(T('menu'), async (ctx) => {
    const user = await getUser(ctx.from.id);
    const message = formatMenuMessage(user, ctx);
    
    // Создаем клавиатуру с кнопкой, если бонус еще не использован
    const extra = {};
    if (!user.subscribed_bonus_used) {
        extra.reply_markup = {
            inline_keyboard: [[ Markup.button.callback('✅ Я подписался и хочу бонус!', 'check_subscription') ]]
        };
    }
    
    // Отправляем сообщение с обычной клавиатурой и (если нужно) с инлайн-кнопкой
    await ctx.replyWithMarkdown(message, { 
        ...extra, 
        ...Markup.keyboard([[T('menu'), T('upgrade')], [T('mytracks'), T('help')]]).resize()
    });
});

bot.hears(T('mytracks'), async (ctx) => {
    // ... (этот блок без изменений)
    try {
        const user = await getUser(ctx.from.id);
        const tracks = user.tracks_today;
        if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
            return await ctx.reply(T('noTracks'));
        }
        for (let i = 0; i < tracks.length; i += 10) {
            const chunk = tracks.slice(i, i + 10).filter(t => t && t.fileId);
            if (chunk.length > 0) {
                await ctx.replyWithMediaGroup(chunk.map(t => ({ type: 'audio', media: t.fileId })));
            }
        }
    } catch (e) {
        await handleSendMessageError(e, ctx.from.id, ctx);
    }
});

bot.hears(T('help'), async (ctx) => await ctx.reply(T('helpInfo')));
bot.hears(T('upgrade'), async (ctx) => await ctx.reply(T('upgradeInfo')));

bot.on('text', async (ctx) => {
    // ... (этот блок без изменений)
    const userText = ctx.message.text;
    if (Object.values(allTextsSync()).includes(userText)) return;
    const url = userText.match(/(https?:\/\/[^\s]+)/g)?.find(u => u.includes('soundcloud.com'));
    if (url) {
        await enqueue(ctx, ctx.from.id, url);
    } else {
        await ctx.reply('Я не понял. Пришлите ссылку или используйте меню.');
    }
});