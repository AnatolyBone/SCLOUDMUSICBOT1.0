// bot.js
import { Telegraf, Markup, TelegramError } from 'telegraf';
import { ADMIN_ID, BOT_TOKEN, WEBHOOK_URL } from './config.js';
import { updateUserField, getUser, createUser, setPremium, getAllUsers } from './db.js';
import { T, allTextsSync } from './config/texts.js';
import { enqueue, downloadQueue } from './services/downloadManager.js';

function getTariffName(limit) {
    if (limit >= 1000) return 'Unlim (∞/день)';
    if (limit >= 50) return 'Pro (50/день)';
    if (limit >= 20) return 'Plus (30/день)';
    return 'Free (5/день)';
}

function getDaysLeft(premiumUntil) {
    if (!premiumUntil) return 0;
    const diff = new Date(premiumUntil) - new Date();
    return Math.max(Math.ceil(diff / 86400000), 0);
}

function formatMenuMessage(user, ctx) {
    const tariffLabel = getTariffName(user.premium_limit);
    const downloadsToday = user.downloads_today || 0;
    const invited = user.referred_count || 0;
    const refLink = `https://t.me/${ctx.botInfo.username}?start=${user.id}`;
    const daysLeft = getDaysLeft(user.premium_until);

    return `
👋 Привет, ${user.first_name || 'пользователь'}!
Твой профиль:
💼 Тариф: *${tariffLabel}*
⏳ Осталось дней подписки: *${daysLeft}*
🎧 Сегодня скачано: *${downloadsToday}* из *${user.premium_limit}*
👫 Приглашено друзей: *${invited}*
🔗 Твоя реферальная ссылка для друзей:
\`${refLink}\`
Просто отправь мне ссылку, и я скачаю трек!
`.trim();
}

export const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 300_000 });

bot.catch(async (err, ctx) => {
    console.error(`🔴 [Telegraf Catch] Глобальная ошибка для update ${ctx.update.update_id}:`, err);
    if (err instanceof TelegramError && err.response?.error_code === 403) {
        if (ctx.from?.id) await updateUserField(ctx.from.id, 'active', false);
    }
});

bot.use(async (ctx, next) => {
    if (ctx.from) ctx.state.user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    return next();
});

bot.start(async (ctx) => {
    await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.startPayload || null);
    await ctx.reply(T('start'), Markup.keyboard([[T('menu'), T('upgrade')], [T('mytracks'), T('help')]]).resize());
});

bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const users = await getAllUsers(true);
    const statsMessage = `*Статистика:*\nВсего: ${users.length}\nАктивных: ${users.filter(u => u.active).length}`;
    await ctx.replyWithMarkdown(statsMessage);
});

bot.hears(T('menu'), async (ctx) => {
    const user = await getUser(ctx.from.id);
    await ctx.replyWithMarkdown(formatMenuMessage(user, ctx), Markup.keyboard([[T('menu'), T('upgrade')], [T('mytracks'), T('help')]]).resize());
});

bot.hears(T('mytracks'), async (ctx) => {
    const user = await getUser(ctx.from.id);
    let tracks = [];
    try { if (user.tracks_today) tracks = JSON.parse(user.tracks_today); } catch {}
    if (!tracks || tracks.length === 0) return await ctx.reply(T('noTracks'));
    for (let i = 0; i < tracks.length; i += 10) {
        const chunk = tracks.slice(i, i + 10).filter(t => t.fileId);
        if (chunk.length > 0) await ctx.replyWithMediaGroup(chunk.map(t => ({ type: 'audio', media: t.fileId })));
    }
});

bot.hears(T('help'), async (ctx) => await ctx.reply(T('helpInfo')));
bot.hears(T('upgrade'), async (ctx) => await ctx.reply(T('upgradeInfo')));
bot.action('check_subscription', async (ctx) => { /* ... */ });

bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    if (Object.values(allTextsSync()).includes(userText)) return;
    const url = userText.match(/(https?:\/\/[^\s]+)/g)?.find(u => u.includes('soundcloud.com'));
    if (url) {
        await enqueue(ctx, ctx.from.id, url);
    } else {
        await ctx.reply('Я не понял. Пришлите ссылку или используйте меню.');
    }
});