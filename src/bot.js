// src/bot.js (ФИНАЛЬНАЯ ВЕРСИЯ С ПРАВИЛЬНЫМ ПОРЯДКОМ ОБРАБОТЧИКОВ)

import { Telegraf, Markup } from 'telegraf';
import * as commands from './bot/commands.js';
import * as hears from './bot/hears.js';
import * as actions from './bot/actions.js';
import { updateUserField } from './db.js';
import { allTextsSync } from './config/texts.js';
import { enqueue } from './services/downloadManager.js';

const bot = new Telegraf(process.env.BOT_TOKEN, {
    handlerTimeout: 90_000 // 90 секунд
});

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

// ======================= СНАЧАЛА ИДУТ КОНКРЕТНЫЕ ОБРАБОТЧИКИ =======================

// Команды
bot.start(commands.start);
bot.command('admin', commands.admin);
bot.command('premium', hears.upgrade); // Этот обработчик теперь будет срабатывать ПЕРЕД .on('text')

// Текстовые кнопки
bot.hears('📋 Меню', hears.menu);
bot.hears('ℹ️ Помощь', hears.help);
bot.hears('🔓 Расширить лимит', hears.upgrade);
bot.hears('🎵 Мои треки', hears.myTracks);

// Inline-кнопки
bot.action('check_subscription', actions.checkSubscription);


// ======================= И ТОЛЬКО В КОНЦЕ - УНИВЕРСАЛЬНЫЙ ОБРАБОТЧИК ТЕКСТА =======================
// Он сработает только если ни один из обработчиков выше не подошел.
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const userText = ctx.message.text;

    // Эти проверки теперь не так важны, так как команды и кнопки уже обработаны,
    // но оставим их для надежности.
    if (userText.startsWith('/')) {
        return; 
    }
    if (Object.values(allTextsSync()).includes(userText)) {
        return;
    }

    console.log(`[Bot] Получено НЕкомандное сообщение от ${userId}, ищем ссылку...`);
    try {
        // Ищем ссылку на SoundCloud или Spotify
        const url = userText.match(/(https?:\/\/[^\s]+)/g)?.find(u => u.includes('soundcloud.com') || u.includes('spotify.com'));

        if (url) {
            await enqueue(ctx, userId, url);
        } else {
            // Теперь это сообщение будет отправляться только на действительно "непонятный" текст
            await ctx.reply('Я не понял. Пожалуйста, пришлите ссылку или используйте кнопки меню.');
        }
    } catch (e) {
        console.error(`[Bot] Ошибка в общем обработчике текста для ${userId}:`, e);
    }
});

export { bot };