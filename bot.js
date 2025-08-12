// bot.js (ФИНАЛЬНАЯ ВЕРСИЯ)

import { Telegraf, Markup } from 'telegraf';
import { updateUserField, getUser, createUser, setPremium, getAllUsers, saveTrackForUser } from './db.js';
import { T, allTextsSync } from './config/texts.js';
import { enqueue, downloadQueue } from './services/downloadManager.js';
import { WEBHOOK_URL } from './config.js'; // Убедитесь, что ADMIN_ID импортируется отсюда или напрямую

const ADMIN_ID = Number(process.env.ADMIN_ID);

const bot = new Telegraf(process.env.BOT_TOKEN, {
    handlerTimeout: 90_000 // 90 секунд
});

// Глобальный "спасательный круг"
bot.catch(async (err, ctx) => {
    console.error(`🔴 [Telegraf Catch] Глобальная ошибка для update ${ctx.update.update_id}:`, err);
    if (err instanceof Telegraf.TelegramError && err.response?.error_code === 403) {
        const userId = ctx.from?.id;
        if (userId) {
            console.warn(`[Telegraf Catch] Пользователь ${userId} заблокировал бота. Отключаем.`);
            await updateUserField(userId, 'active', false).catch(dbError => {
                console.error(`[Telegraf Catch] Ошибка при отключении пользователя ${userId}:`, dbError);
            });
        }
    }
});

// Мидлвэр для получения пользователя
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    try {
        ctx.state.user = await getUser(userId, ctx.from.first_name, ctx.from.username);
    } catch (error) { console.error(`Ошибка в мидлваре для ${userId}:`, error); }
    return next();
});

// --- Обработчики команд ---

bot.start(async (ctx) => {
    console.log(`[Bot] /start от ${ctx.from.id}`);
    try {
        await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.startPayload || null);
        await ctx.reply(T('start'), Markup.keyboard([[T('menu'), T('upgrade')], [T('mytracks'), T('help')]]).resize());
    } catch (e) { console.error(e); }
});

bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    console.log(`[Bot] /admin от админа`);
    try {
        const users = await getAllUsers(true);
        const totalUsers = users.length;
        const activeUsers = users.filter(u => u.active).length;
        const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
        
        const statsMessage = `
📊 *Статистика Бота*
👤 Всего пользователей: *${totalUsers}*
✅ Активных: *${activeUsers}*
📥 Всего загрузок: *${totalDownloads}*
⚙️ Очередь: *${downloadQueue.activeTasks}* в работе, *${downloadQueue.size}* в ожидании.
[Открыть админ-панель](${WEBHOOK_URL.replace(/\/$/, '')}/dashboard)
        `.trim();
        
        await ctx.replyWithMarkdown(statsMessage);
    } catch (e) {
        console.error('Ошибка в команде /admin:', e);
        await ctx.reply('Ошибка получения статистики.').catch(() => {});
    }
});

// --- Обработчики кнопок (hears) ---

bot.hears(T('menu'), async (ctx) => {
    console.log(`[Bot] "Меню" от ${ctx.from.id}`);
    try {
        const user = await getUser(ctx.from.id);
        // Здесь должна быть ваша функция форматирования сообщения меню
        await ctx.reply(`Информация по вашему профилю...`, Markup.keyboard([[T('menu'), T('upgrade')], [T('mytracks'), T('help')]]).resize());
    } catch (e) { console.error(e); }
});

bot.hears(T('mytracks'), async (ctx) => {
    console.log(`[Bot] "Мои треки" от ${ctx.from.id}`);
    try {
        const user = await getUser(ctx.from.id);
        let tracks = [];
        try { if (user.tracks_today) tracks = JSON.parse(user.tracks_today); } catch {}
        if (!tracks.length) return await ctx.reply(T('noTracks'));
        
        for (let i = 0; i < tracks.length; i += 10) {
            const chunk = tracks.slice(i, i + 10).filter(t => t.fileId);
            if (chunk.length > 0) {
                await ctx.replyWithMediaGroup(chunk.map(t => ({ type: 'audio', media: t.fileId })));
            }
        }
    } catch (e) { console.error(e); }
});

bot.hears(T('help'), async (ctx) => {
    console.log(`[Bot] "Помощь" от ${ctx.from.id}`);
    await ctx.reply(T('helpInfo'));
});

bot.hears(T('upgrade'), async (ctx) => {
    console.log(`[Bot] "Расширить лимит" от ${ctx.from.id}`);
    await ctx.reply(T('upgradeInfo'));
});

// --- Обработчики инлайн-кнопок (actions) ---

bot.action('check_subscription', async (ctx) => {
    console.log(`[Bot] action 'check_subscription' от ${ctx.from.id}`);
    try {
        // Здесь должна быть ваша логика проверки подписки
        // Например, isSubscribed(ctx.from.id)
        const subscribed = true; // Заглушка
        if (subscribed) {
            await setPremium(ctx.from.id, 50, 7);
            await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
            await ctx.editMessageText('Поздравляю! Тебе начислен бонус: 7 дней Plus.');
        } else {
            await ctx.answerCbQuery('Пожалуйста, подпишись на канал и нажми кнопку ещё раз.', { show_alert: true });
        }
    } catch (e) { console.error(e); }
});

// --- Общий обработчик текста ---

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const userText = ctx.message.text;

    if (Object.values(allTextsSync()).includes(userText)) {
        return;
    }

    console.log(`[Bot] Получено НЕкомандное сообщение от ${userId}, ищем ссылку...`);
    try {
        const url = userText.match(/(https?:\/\/[^\s]+)/g)?.find(u => u.includes('soundcloud.com'));
        
        if (url) {
            await enqueue(ctx, userId, url);
        } else {
            await ctx.reply('Я не понял. Пожалуйста, пришлите ссылку или используйте кнопки меню.');
        }
    } catch (e) {
        console.error(`[Bot] Ошибка в общем обработчике текста для ${userId}:`, e);
    }
});

export { bot };