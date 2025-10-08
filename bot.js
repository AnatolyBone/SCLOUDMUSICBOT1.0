// bot.js (финальная, чистая версия, совместимая с downloadManager v3.0)

import { Telegraf, Markup, TelegramError } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ADMIN_ID, BOT_TOKEN, WEBHOOK_URL, CHANNEL_USERNAME, PROXY_URL } from './config.js';
import { 
    updateUserField, getUser, setPremium, getAllUsers, 
    resetDailyLimitIfNeeded, getCachedTracksCount, logUserAction, 
    getTopFailedSearches, getTopRecentSearches, getNewUsersCount,
    resetExpiredPremiumIfNeeded
} from './db.js';
import { T, allTextsSync } from './config/texts.js';
import { performInlineSearch } from './services/searchManager.js';
import { enqueue as soundcloudEnqueue, downloadQueue } from './services/downloadManager.js';
import { handleReferralCommand, processNewUserReferral } from './services/referralManager.js';
import { isShuttingDown, isMaintenanceMode, setMaintenanceMode } from './services/appState.js';

// ========================= HELPER FUNCTIONS =========================

function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;');
}

async function isSubscribed(userId) {
    if (!CHANNEL_USERNAME) return false;
    try {
        const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, userId);
        return ['creator', 'administrator', 'member'].includes(member.status);
    } catch (e) {
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

function formatMenuMessage(user, botUsername) {
    const tariffLabel = getTariffName(user.premium_limit);
    const downloadsToday = user.downloads_today || 0;
    const daysLeft = getDaysLeft(user.premium_until);
    const referralCount = user.referral_count || 0;
    const referralLink = `https://t.me/${botUsername}?start=ref_${user.id}`;
    
    const statsBlock = `💼 <b>Тариф:</b> <i>${tariffLabel}</i>\n` +
                       `⏳ <b>Осталось дней подписки:</b> <i>${daysLeft}</i>\n` +
                       `🎧 <b>Сегодня скачано:</b> <i>${downloadsToday}</i> из <i>${user.premium_limit}</i>`;
    
    const header = T('menu_header').replace('{first_name}', escapeHtml(user.first_name) || 'пользователь');
    const referralBlock = T('menu_referral_block').replace('{referral_count}', referralCount).replace('{referral_link}', referralLink);
    
    let bonusBlock = '';
    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
        const channelLink = `<a href="https://t.me/${CHANNEL_USERNAME.replace('@', '')}">наш канал</a>`;
        bonusBlock = T('menu_bonus_block').replace('{channel_link}', channelLink);
    }
    
    const footer = T('menu_footer');
    return [header, statsBlock, '---', referralBlock, bonusBlock, footer].filter(Boolean).join('\n\n');
}

// ========================= TELEGRAF INIT & MIDDLEWARE =========================

const telegrafOptions = { handlerTimeout: 300_000 };
if (PROXY_URL) {
    telegrafOptions.telegram = { agent: new HttpsProxyAgent(PROXY_URL) };
    console.log('[App] Использую прокси для Telegram API.');
}

export const bot = new Telegraf(BOT_TOKEN, telegrafOptions);

bot.catch(async (err, ctx) => {
    console.error(`🔴 [Telegraf Catch] Глобальная ошибка для update ${ctx.update.update_id}:`, err);
    try {
        await bot.telegram.sendMessage(ADMIN_ID, `🔴 <b>Критическая ошибка в боте!</b>\n<code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
    } catch (sendError) {}
    
    if (err instanceof TelegramError && err.response?.error_code === 403 && ctx.from?.id) {
        await updateUserField(ctx.from.id, 'active', false);
    }
});

bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    
    const payload = ctx.startPayload || (ctx.message?.text?.startsWith('/start ') ? ctx.message.text.split(' ')[1] : null);
    const user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username, payload);
    ctx.state.user = user;
    
    if (!user?.active) return;
    if (user.can_receive_broadcasts === false) {
        try { await updateUserField(user.id, { can_receive_broadcasts: true }); } catch {}
    }
    
    await resetDailyLimitIfNeeded(ctx.from.id);
    await resetExpiredPremiumIfNeeded(ctx.from.id);
    return next();
});

// ========================= COMMANDS & HEARS =========================

bot.start(async (ctx) => {
    const user = ctx.state.user;
    const isNewRegistration = (Date.now() - new Date(user.created_at).getTime()) < 5000;
    
    if (isNewRegistration) {
        await logUserAction(ctx.from.id, 'registration');
        await processNewUserReferral(user, ctx);
    }
    
    const startMessage = isNewRegistration ? T('start_new_user') : T('start');
    await ctx.reply(startMessage, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.keyboard([[T('menu'), T('upgrade')], [T('mytracks'), T('help')]]).resize()
    });
});

bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
        await ctx.reply('⏳ Собираю статистику...');
        const [users, cached, failed, recent, newToday, newWeek] = await Promise.all([
            getAllUsers(true), getCachedTracksCount(), getTopFailedSearches(5),
            getTopRecentSearches(5), getNewUsersCount(1), getNewUsersCount(7)
        ]);
        const active = users.filter(u => u.active).length;
        const activeToday = users.filter(u => u.last_active && new Date(u.last_active).toDateString() === new Date().toDateString()).length;
        const totalDl = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
        
        let statsMsg = `<b>📊 Статистика</b>\n\n` +
                       `<b>👤 Пользователи:</b> ${users.length} всего / ${active} активных\n` +
                       `   - Новых за 24ч/7д: ${newToday} / ${newWeek}\n` +
                       `   - Активных сегодня: ${activeToday}\n\n` +
                       `<b>📥 Загрузки:</b> ${totalDl} всего\n\n` +
                       `<b>⚙️ Система:</b>\n` +
                       `   - Очередь: ${downloadQueue.size} / ${downloadQueue.pending}\n` +
                       `   - Кэш: ${cached} треков\n\n` +
                       `<a href="${WEBHOOK_URL.replace(/\/$/, '')}/dashboard">Открыть дашборд</a>`;
        await ctx.replyWithHTML(statsMsg, { disable_web_page_preview: true });
    } catch (e) {
        await ctx.reply('❌ Ошибка сбора статистики.');
    }
});

bot.command('referral', handleReferralCommand);
bot.command('premium', (ctx) => ctx.reply(T('upgradeInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));

bot.hears(T('menu'), async (ctx) => {
    const message = formatMenuMessage(ctx.state.user, ctx.botInfo.username);
    const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
    if (!ctx.state.user.subscribed_bonus_used && CHANNEL_USERNAME) {
        extra.reply_markup = { inline_keyboard: [[ Markup.button.callback('✅ Я подписался и хочу бонус!', 'check_subscription') ]] };
    }
    await ctx.reply(message, extra);
});

bot.hears(T('mytracks'), async (ctx) => {
    try {
        const user = ctx.state.user;
        if (!user.tracks_today?.length) return await ctx.reply(T('noTracks'));
        for (let i = 0; i < user.tracks_today.length; i += 10) {
            const chunk = user.tracks_today.slice(i, i + 10).filter(t => t?.fileId);
            if (chunk.length > 0) await ctx.replyWithMediaGroup(chunk.map(t => ({ type: 'audio', media: t.fileId })));
        }
    } catch (e) {
        console.error(`🔴 Ошибка в mytracks для ${ctx.from.id}:`, e.message);
    }
});

bot.hears(T('help'), (ctx) => ctx.reply(T('helpInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));
bot.hears(T('upgrade'), (ctx) => ctx.reply(T('upgradeInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));

// ========================= URL & TEXT HANDLER =========================

bot.on('text', async (ctx) => {
    if (isShuttingDown()) return;
    if (isMaintenanceMode() && ctx.from.id !== ADMIN_ID) {
        return await ctx.reply('⏳ Бот на обслуживании. Попробуйте через 5-10 минут.');
    }
    if (ctx.chat.type !== 'private') return;

    const text = ctx.message.text;
    if (text.startsWith('/') || Object.values(allTextsSync()).includes(text)) return;

    const urlMatch = text.match(/(https?:\/\/[^\s]+)/g);
    if (!urlMatch) {
        return await ctx.reply('Пожалуйста, отправьте мне ссылку на трек или плейлист SoundCloud.');
    }
    const url = urlMatch[0];

    if (url.includes('soundcloud.com')) {
        // 🔥 ПРОСТО ПЕРЕДАЁМ ЗАДАЧУ В ОПТИМИЗИРОВАННЫЙ downloadManager
        soundcloudEnqueue(ctx, ctx.from.id, url);
    } else if (url.includes('open.spotify.com')) {
        await ctx.reply('🛠 Скачивание из Spotify временно недоступно.');
    } else {
        await ctx.reply('Я умею скачивать треки только из SoundCloud.');
    }
});

// ========================= INLINE QUERY & ACTIONS =========================

bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query;
    if (!query || query.trim().length < 2) {
        return await ctx.answerInlineQuery([], { switch_pm_text: 'Введите название трека...', switch_pm_parameter: 'start' });
    }
    try {
        const results = await performInlineSearch(query, ctx.from.id);
        await ctx.answerInlineQuery(results, { cache_time: 60 });
    } catch (error) {
        console.error('[Inline Query] Глобальная ошибка:', error);
        await ctx.answerInlineQuery([]);
    }
});

bot.action('check_subscription', async (ctx) => {
    try {
        if (ctx.state.user.subscribed_bonus_used) {
            return await ctx.answerCbQuery('Вы уже использовали этот бонус.', { show_alert: true });
        }
        const subscribed = await isSubscribed(ctx.from.id);
        if (subscribed) {
            await setPremium(ctx.from.id, 30, 7);
            await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
            await logUserAction(ctx.from.id, 'bonus_received');
            await ctx.answerCbQuery('Бонус начислен!');
            await ctx.editMessageText('🎉 Поздравляем! Вам начислено 7 дней тарифа Plus.');
        } else {
            return await ctx.answerCbQuery(`Вы еще не подписаны на канал ${CHANNEL_USERNAME}.`, { show_alert: true });
        }
    } catch (e) {
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.', { show_alert: true });
    }
});