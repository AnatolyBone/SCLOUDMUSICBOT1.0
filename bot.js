// bot.js (ФИНАЛЬНАЯ РАБОЧАЯ ВЕРСИЯ С ИСПРАВЛЕННЫМИ КОМАНДАМИ)

import { Telegraf, Markup, TelegramError } from 'telegraf';
import { ADMIN_ID, BOT_TOKEN, WEBHOOK_URL, CHANNEL_USERNAME, STORAGE_CHANNEL_ID } from './config.js';
import { updateUserField, getUser, createUser, setPremium, getAllUsers, resetDailyLimitIfNeeded, getCachedTracksCount, logUserAction } from './db.js';
import { T, allTextsSync } from './config/texts.js';
import { performInlineSearch } from './services/searchManager.js';
import { spotifyEnqueue } from './services/spotifyManager.js';
import { enqueue, downloadQueue } from './services/downloadManager.js';

async function isSubscribed(userId) {
    if (!CHANNEL_USERNAME) return false;
    try {
        const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, userId);
        return ['creator', 'administrator', 'member'].includes(member.status);
    } catch (e) {
        console.error(`Ошибка проверки подписки для ${userId} на ${CHANNEL_USERNAME}:`, e.message);
        return false;
    }
}

function getTariffName(limit) {
    if (limit >= 10000) return 'Unlimited — 💎';
    if (limit >= 100) return 'Pro — 100 💪';
    if (limit >= 30) return 'Plus — 30 🎯';
    return '🆓 Free — 5 🟢';
}

function getDaysLeft(premiumUntil) {
    if (!premiumUntil) return 0;
    const diff = new Date(premiumUntil) - new Date();
    return Math.max(Math.ceil(diff / 86400000), 0);
}

function formatMenuMessage(user, ctx) {
    const tariffLabel = getTariffName(user.premium_limit);
    const downloadsToday = user.downloads_today || 0;
    const daysLeft = getDaysLeft(user.premium_until);

    let message = `
👋 Привет, ${user.first_name || 'пользователь'}!
<b>Твой профиль:</b>
💼 <b>Тариф:</b> <i>${tariffLabel}</i>
⏳ <b>Осталось дней подписки:</b> <i>${daysLeft}</i>
🎧 <b>Сегодня скачано:</b> <i>${downloadsToday}</i> из <i>${user.premium_limit}</i>
    `.trim();

    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
        const cleanUsername = CHANNEL_USERNAME.replace('@', '');
        const channelLink = `<a href="https://t.me/${cleanUsername}">наш канал</a>`;
        message += `\n\n🎁 <b>Бонус!</b> Подпишись на ${channelLink} и получи <b>7 дней тарифа Plus</b> бесплатно!`;
    }

    message += '\n\nПросто отправь мне ссылку, и я скачаю трек!';
    return message;
}

async function handleSendMessageError(e, userId, ctx = null) {
    console.error(`🔴 Ошибка при работе с пользователем ${userId}:`, e.message);
    if (e instanceof TelegramError && e.response?.error_code === 403) {
        await updateUserField(userId, 'active', false);
        console.log(`- Пользователь ${userId} заблокировал бота.`);
    } else if (ctx) {
        try { await ctx.reply('Произошла ошибка при выполнении вашего запроса.'); } catch (sendError) {}
    }
}

export const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 300_000 });

bot.catch(async (err, ctx) => {
    console.error(`🔴 [Telegraf Catch] Глобальная ошибка для update ${ctx.update.update_id}:`, err);
    if (err instanceof TelegramError && err.response?.error_code === 403) {
        if (ctx.from?.id) await updateUserField(ctx.from.id, 'active', false);
    }
});

bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    ctx.state.user = user;
    if (user && user.active === false) {
        console.log(`[Access Denied] Заблокированный пользователь ${ctx.from.id} попытался использовать бота.`);
        ctx.reply(T('blockedMessage')).catch(() => {});
        return;
    }
    await resetDailyLimitIfNeeded(ctx.from.id);
    return next();
});

bot.start(async (ctx) => {
    await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.startPayload || null);
    const user = ctx.state.user;
    const isNewRegistration = (Date.now() - new Date(user.created_at).getTime()) < 5000;

    if (isNewRegistration) {
        await logUserAction(ctx.from.id, 'registration');
    }

    const startMessage = isNewRegistration ? T('start_new_user') : T('start');
    
    await ctx.reply(startMessage, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.keyboard([
            [T('menu'), T('upgrade')],
            [T('mytracks'), T('help')]
        ]).resize()
    });
});

bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
        let storageStatusText = STORAGE_CHANNEL_ID ? '✅ Доступен' : '⚠️ Не настроен';
        const [users, cachedTracksCount] = await Promise.all([ getAllUsers(true), getCachedTracksCount() ]);
        const totalUsers = users.length;
        const activeUsers = users.filter(u => u.active).length;
        const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
        const activeToday = users.filter(u => u.last_active && new Date(u.last_active).toDateString() === new Date().toDateString()).length;

        const statsMessage = `<b>📊 Статистика Бота</b>\n\n` +
            `<b>👤 Пользователи:</b>\n   - Всего: <i>${totalUsers}</i>\n   - Активных: <i>${activeUsers}</i>\n   - Активных сегодня: <i>${activeToday}</i>\n\n` +
            `<b>📥 Загрузки:</b>\n   - Всего за все время: <i>${totalDownloads}</i>\n\n` +
            `<b>⚙️ Система:</b>\n   - Очередь: <i>${downloadQueue.size}</i> в ож. / <i>${downloadQueue.active}</i> в раб.\n` +
            `   - Канал-хранилище: <i>${storageStatusText}</i>\n   - Треков в кэше: <i>${cachedTracksCount}</i>\n\n` +
            `<b>🔗 Админ-панель:</b>\n<a href="${WEBHOOK_URL.replace(/\/$/, '')}/dashboard">Открыть дашборд</a>`;

        await ctx.reply(statsMessage, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
        console.error('❌ Ошибка в команде /admin:', e);
    }
});

// ======================= ИЗМЕНЕНИЕ №1: ДОБАВЛЯЕМ КОМАНДУ /premium =======================
bot.command('premium', async (ctx) => {
    // Эта команда будет делать то же самое, что и кнопка "Расширить лимит"
    await ctx.reply(T('upgradeInfo'), { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.action('check_subscription', async (ctx) => {
    const user = await getUser(ctx.from.id);
    if (user.subscribed_bonus_used) {
        return await ctx.answerCbQuery('Вы уже использовали этот бонус.', { show_alert: true });
    }
    const subscribed = await isSubscribed(ctx.from.id);
    if (subscribed) {
        await setPremium(ctx.from.id, 30, 7); 
        await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
        await logUserAction(ctx.from.id, 'bonus_received');
        await ctx.editMessageText('🎉 Поздравляем! Вам начислено 7 дней тарифа Plus. Спасибо за подписку!');
    } else {
        await ctx.answerCbQuery(`Вы еще не подписаны. Пожалуйста, подпишитесь и нажмите кнопку снова.`, { show_alert: true });
    }
});

bot.hears(T('menu'), async (ctx) => {
    const user = await getUser(ctx.from.id);
    const message = formatMenuMessage(user, ctx);
    const extraOptions = { 
        parse_mode: 'HTML',
        disable_web_page_preview: true
    };
    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
        extraOptions.reply_markup = { inline_keyboard: [[ Markup.button.callback('✅ Я подписался и хочу бонус!', 'check_subscription') ]] };
    }
    await ctx.reply(message, extraOptions);
});

bot.hears(T('mytracks'), async (ctx) => {
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

bot.hears(T('help'), async (ctx) => await ctx.reply(T('helpInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));
bot.hears(T('upgrade'), async (ctx) => await ctx.reply(T('upgradeInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));

bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query;
    if (!query || query.trim().length < 2) {
        return await ctx.answerInlineQuery([], {
            switch_pm_text: 'Введите название трека для поиска...',
            switch_pm_parameter: 'start',
        });
    }
    try {
        const results = await performInlineSearch(query);
        await ctx.answerInlineQuery(results, { cache_time: 60 });
    } catch (error) {
        console.error('[Inline Query] Глобальная ошибка обработчика:', error);
        await ctx.answerInlineQuery([]);
    }
});

// ВАЖНО: Универсальный обработчик текста должен идти ПОСЛЕ всех команд и hears
bot.on('text', async (ctx) => {
    const userText = ctx.message.text;

    // ======================= ИЗМЕНЕНИЕ №2: ПРОПУСКАЕМ КОМАНДЫ =======================
    // Эта проверка теперь необязательна, т.к. обработчик в конце, но оставим для надежности
    if (userText.startsWith('/')) {
        return; // Команды уже обработаны выше
    }
    
    // Проверяем, не является ли текст командой из меню
    if (Object.values(allTextsSync()).includes(userText)) {
        return; // `hears` уже обработал
    }
    
    const urlMatch = userText.match(/(https?:\/\/[^\s]+)/g);
    if (!urlMatch || urlMatch.length === 0) {
        await ctx.reply('Я не понял. Пожалуйста, отправьте мне ссылку на трек, альбом или плейлист.');
        return;
    }
    
    const url = urlMatch[0];
    
    if (url.includes('soundcloud.com')) {
        enqueue(ctx, ctx.from.id, url).catch(err => {
            console.error(`[SC Enqueue Error] Ошибка для user ${ctx.from.id}:`, err.message);
        });
    } else if (url.includes('open.spotify.com')) {
        spotifyEnqueue(ctx, ctx.from.id, url).catch(err => {
            console.error(`[Spotify Enqueue Error] Ошибка для user ${ctx.from.id}:`, err.message);
        });
    } else {
        await ctx.reply('Я пока умею скачивать только с SoundCloud и Spotify. Поддержка других платформ в разработке!');
    }
});