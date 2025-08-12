// index.js

// === Встроенные и сторонние библиотеки ===
import express from 'express';
import session from 'express-session';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import expressLayouts from 'express-ejs-layouts';
import { fileURLToPath } from 'url';
import { Telegraf, Markup } from 'telegraf';
import { createClient } from 'redis';
import pgSessionFactory from 'connect-pg-simple';
import ytdl from 'youtube-dl-exec';

// === Импорты модулей НАШЕГО приложения ===
import { pool, supabase, createUser, getUser, updateUserField, setPremium, getAllUsers, resetDailyStats, saveTrackForUser, getLatestReviews, resetDailyLimitIfNeeded, findCachedTrack, cacheTrack } from './db.js';
import { enqueue, downloadQueue } from './services/downloadManager.js';
import { T, loadTexts, allTextsSync } from './config/texts.js';

// === Константы и конфигурация ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_PATH = '/telegram';
const PORT = process.env.PORT ?? 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-secret-key-for-session';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;

if (!BOT_TOKEN || !ADMIN_ID || !ADMIN_LOGIN || !ADMIN_PASSWORD || !WEBHOOK_URL || !STORAGE_CHANNEL_ID) {
    console.error('❌ Отсутствуют необходимые переменные окружения!');
    process.exit(1);
}

// === Глобальные экземпляры и утилиты ===
// <<< ИСПРАВЛЕНО: Добавлен таймаут для Telegraf, чтобы он ждал дольше >>>
const bot = new Telegraf(BOT_TOKEN, {
    handlerTimeout: 90_000 // 90 секунд
});
const app = express();
const upload = multer({ dest: 'uploads/' });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, 'cache');
let redisClient = null;

export function getRedisClient() {
    if (!redisClient) throw new Error('Redis клиент ещё не инициализирован');
    return redisClient;
}

// <<< ВОССТАНОВЛЕНО: Функции для динамического меню >>>
function getTariffName(limit) {
    if (limit >= 1000) return 'Unlim (∞/день)';
    if (limit >= 50) return 'Pro (50/день)';
    if (limit >= 20) return 'Plus (30/день)'; // Исправлено на 30, как в текстах
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
👋 Привет, ${user.first_name}!

Твой профиль:
💼 Тариф: ${tariffLabel}
⏳ Осталось дней подписки: ${daysLeft}
🎧 Сегодня скачано: ${downloadsToday} из ${user.premium_limit}

👫 Приглашено друзей: ${invited}

🔗 Твоя реферальная ссылка для друзей:
\`${refLink}\`

Просто отправь мне ссылку на трек или плейлист с SoundCloud, и я его скачаю!
`.trim();
}

async function startApp() {
    console.log('[App] Запуск приложения...');
    try {
        await loadTexts(true); // Принудительно загружаем тексты при старте
        
        const client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 10000 } });
        client.on('error', (err) => console.error('🔴 Ошибка Redis:', err));
        await client.connect();
        redisClient = client;
        console.log('✅ [App] Redis подключён');

        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

        setupExpress();
        setupTelegramBot();
        
        setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
        setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.activeTasks} в работе.`), 60000);
        
        if (process.env.NODE_ENV === 'production') {
            app.use(await bot.createWebhook({ domain: WEBHOOK_URL, path: WEBHOOK_PATH }));
            app.listen(PORT, () => console.log(`✅ [App] Сервер запущен на порту ${PORT}.`));
        } else {
            await bot.launch();
            console.log('✅ [App] Бот запущен в режиме long-polling.');
        }
        
        console.log('[App] Фоновый индексатор временно отключен.');
        // startIndexer().catch(err => console.error("🔴 Критическая ошибка в индексаторе:", err));
    } catch (err) {
        console.error('🔴 Критическая ошибка при запуске приложения:', err);
        process.exit(1);
    }
}

function setupExpress() {
    console.log('[Express] Настройка Express сервера...');
    app.use(compression());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.set('view engine', 'ejs');
    
    // ... остальной код setupExpress без изменений ...
    
    app.get('/health', (req, res) => res.status(200).send('OK'));
    app.get('/broadcast', (req, res) => res.render('broadcast-form', { title: 'Рассылка', error: null, success: null }));
    // ...
}

function setupTelegramBot() {
    console.log('[Telegraf] Настройка обработчиков бота...');

    bot.catch((err, ctx) => {
        console.error(`🔴 [Telegraf] Глобальная ошибка для update ${ctx.update.update_id}:`, err);
    });

    bot.use(async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId) return next();
        try {
            ctx.state.user = await getUser(userId, ctx.from.first_name, ctx.from.username);
        } catch (error) { console.error(`Ошибка в мидлваре для ${userId}:`, error); }
        return next();
    });

    bot.start(async (ctx) => {
        console.log(`[Bot] /start от ${ctx.from.id}`);
        try {
            await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.startPayload || null);
            await ctx.reply(T('start'), kb());
        } catch (e) { console.error(e); }
    });

    bot.hears(T('menu'), async (ctx) => {
        console.log(`[Bot] "Меню" от ${ctx.from.id}`);
        try {
            const user = await getUser(ctx.from.id);
            await ctx.replyWithMarkdown(formatMenuMessage(user, ctx), kb()); 
        } catch (e) { console.error(e); }
    });
    
    bot.hears(T('mytracks'), async (ctx) => {
        console.log(`[Bot] "Мои треки" от ${ctx.from.id}`);
        try {
            const user = await getUser(ctx.from.id);
            let tracks = [];
            try { if (user.tracks_today) tracks = JSON.parse(user.tracks_today); } catch {}
            if (!tracks.length) return await ctx.reply(T('noTracks'), kb());
            
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
        await ctx.reply(T('helpInfo'), kb());
    });

    bot.hears(T('upgrade'), async (ctx) => {
        console.log(`[Bot] "Расширить лимит" от ${ctx.from.id}`);
        await ctx.reply(T('upgradeInfo'), kb());
    });
    
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
            await ctx.reply(T('error')).catch(() => {});
        }
    });
}

async function stopBot(signal) {
    console.log(`[App] Получен сигнал ${signal}. Начинаю корректное завершение...`);
    try {
        if (bot.polling?.isRunning()) bot.stop(signal);
        const promises = [];
        if (redisClient?.isOpen) promises.push(redisClient.quit());
        promises.push(pool.end());
        await Promise.allSettled(promises);
        console.log('[App] Все соединения закрыты. Выход.');
        process.exit(0);
    } catch (e) {
        console.error('🔴 Ошибка при завершении работы:', e);
        process.exit(1);
    }
}

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));

startApp();

export { app, bot, startApp };