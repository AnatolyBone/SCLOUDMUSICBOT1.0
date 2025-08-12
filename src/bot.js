// src/bot.js

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

// <<< ИСПРАВЛЕНО: Глобальный обработчик ошибок - "спасательный круг" >>>
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

// <<< ВАЖНО: Эти обработчики должны быть определены ЗДЕСЬ, а не импортированы, если они используют внешние зависимости, которые мы рефакторим >>>
// Если ваши файлы commands.js, hears.js и т.д. не имеют сложных импортов, их можно оставить.
// Если они импортируют что-то из index.js, их логику нужно перенести сюда.
// Для безопасности, я перенесу логику text сюда.

bot.start(commands.start);
bot.command('admin', commands.admin);

bot.hears('📋 Меню', hears.menu);
bot.hears('ℹ️ Помощь', hears.help);
bot.hears('🔓 Расширить лимит', hears.upgrade);
bot.hears('🎵 Мои треки', hears.myTracks);

bot.action('check_subscription', actions.checkSubscription);

// <<< ИСПРАВЛЕНО: Логика обработки текста перенесена сюда для ясности и избежания циклов >>>
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const userText = ctx.message.text;

    // Проверяем, не является ли текст командой с клавиатуры
    if (Object.values(allTextsSync()).includes(userText)) {
        return; // `bot.hears` уже обработал
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