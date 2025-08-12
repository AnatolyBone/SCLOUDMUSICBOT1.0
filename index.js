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
import json2csv from 'json-2-csv';
import ytdl from 'youtube-dl-exec';

// === Импорты модулей НАШЕГО приложения ===
import { pool, supabase, getFunnelData, createUser, getUser, updateUserField, setPremium, getAllUsers, resetDailyStats, addReview, saveTrackForUser, hasLeftReview, getLatestReviews, resetDailyLimitIfNeeded, getRegistrationsByDate, getDownloadsByDate, getActiveUsersByDate, getExpiringUsers, getReferralSourcesStats, markSubscribedBonusUsed, getUserActivityByDayHour, logUserActivity, getUserById, getExpiringUsersCount, getExpiringUsersPaginated, findCachedTrack, cacheTrack } from './db.js';
import { enqueue, downloadQueue } from './services/downloadManager.js';

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
const bot = new Telegraf(BOT_TOKEN);
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

async function cleanupCache(directory, maxAgeMinutes = 60) {
    // ... (код без изменений)
}

export const texts = {
    start: '👋 Пришли ссылку на трек или плейлист с SoundCloud.',
    menu: '📋 Меню',
    upgrade: '🔓 Расширить лимит',
    mytracks: '🎵 Мои треки',
    help: 'ℹ️ Помощь',
    // ... (остальные тексты без изменений)
};

const kb = () => Markup.keyboard([[texts.menu, texts.upgrade], [texts.mytracks, texts.help]]).resize();

// ... (код индексатора без изменений) ...

// =================================================================
// ===                    ОСНОВНАЯ ЛОГИКА                       ===
// =================================================================
async function startApp() {
    console.log('[App] Запуск приложения...');
    try {
        const client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 10000 } });
        client.on('error', (err) => console.error('🔴 Ошибка Redis:', err));
        await client.connect();
        redisClient = client;
        console.log('✅ [App] Redis подключён');

        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

        setupExpress();
        setupTelegramBot();
        
        console.log('[App] Настройка фоновых задач (таймеров)...');
        setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
        setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`), 60000);
        setInterval(() => cleanupCache(cacheDir, 60), 30 * 60 * 1000);
        
        if (process.env.NODE_ENV === 'production') {
            console.log(`[App] Настройка вебхука для Telegram на ${WEBHOOK_URL}...`);
            app.use(await bot.createWebhook({ domain: WEBHOOK_URL, path: WEBHOOK_PATH }));
            app.listen(PORT, () => console.log(`✅ [App] Сервер запущен на порту ${PORT}.`));
        } else {
            console.log('[App] Запуск бота в режиме long-polling для разработки...');
            await bot.launch();
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
    app.use(expressLayouts);
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    app.set('layout', 'layout');
    
    const pgSession = pgSessionFactory(session);
    app.use(session({ store: new pgSession({ pool }), secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }}));

    const requireAuth = (req, res, next) => {
        if (req.session.authenticated && req.session.userId === ADMIN_ID) return next();
        res.redirect('/admin');
    };
    
    app.get('/health', (req, res) => res.status(200).send('OK'));
    
    // ... (все маршруты админки без изменений) ...
    app.get('/admin', (req, res) => res.render('login', { title: 'Вход в админку', error: null }));
    app.post('/admin', (req, res) => { /* ... */ });
    app.get('/broadcast', requireAuth, (req, res) => res.render('broadcast-form', { title: 'Рассылка', error: null, success: null }));
    app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res) => { /* ... */ });
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
            await ctx.reply(texts.start, kb());
        } catch (e) { console.error(e); }
    });

    // <<< ВОССТАНОВЛЕНО: Обработчики команд с клавиатуры >>>
    bot.hears(texts.menu, async (ctx) => {
        console.log(`[Bot] "Меню" от ${ctx.from.id}`);
        try {
            const user = await getUser(ctx.from.id);
            // Тут должна быть ваша функция форматирования сообщения для меню
            await ctx.reply(`Информация по вашему профилю...`, kb());
        } catch (e) { console.error(e); }
    });
    
    bot.hears(texts.mytracks, async (ctx) => {
        console.log(`[Bot] "Мои треки" от ${ctx.from.id}`);
        try {
            const user = await getUser(ctx.from.id);
            let tracks = [];
            try { if (user.tracks_today) tracks = JSON.parse(user.tracks_today); } catch {}
            if (!tracks.length) return await ctx.reply(texts.noTracks);
            
            for (let i = 0; i < tracks.length; i += 10) {
                const chunk = tracks.slice(i, i + 10).filter(t => t.fileId);
                if (chunk.length > 0) {
                    await ctx.replyWithMediaGroup(chunk.map(t => ({ type: 'audio', media: t.fileId })));
                }
            }
        } catch (e) { console.error(e); }
    });

    bot.hears(texts.help, async (ctx) => {
        console.log(`[Bot] "Помощь" от ${ctx.from.id}`);
        await ctx.reply(texts.helpInfo, kb());
    });

    bot.hears(texts.upgrade, async (ctx) => {
        console.log(`[Bot] "Расширить лимит" от ${ctx.from.id}`);
        await ctx.reply(texts.upgradeInfo, kb());
    });
    
    // ... (другие ваши команды, например /admin)
    bot.command('admin', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        // ... ваша логика админ-команды
    });


    // <<< ИСПРАВЛЕНО: Усиленный общий обработчик текста, который идет ПОСЛЕ hears >>>
    bot.on('text', async (ctx) => {
        const userId = ctx.from.id;
        const userText = ctx.message.text;

        // Шаг 1: Проверяем, не является ли текст известной командой.
        // `bot.hears` уже должен был обработать эти команды, поэтому здесь мы их игнорируем.
        if (Object.values(texts).includes(userText)) {
            return;
        }

        console.log(`[Bot] Получено НЕкомандное сообщение от ${userId}, ищем ссылку...`);
        try {
            // Шаг 2: Ищем ссылку только если это не команда.
            const url = userText.match(/(https?:\/\/[^\s]+)/g)?.find(u => u.includes('soundcloud.com'));
            
            if (url) {
                console.log(`[Bot] Найдена SoundCloud ссылка от ${userId}: ${url}`);
                await enqueue(ctx, userId, url);
            } else {
                // Шаг 3: Если это не команда и не ссылка, даем понятный ответ.
                await ctx.reply('Я не понял. Пожалуйста, пришлите ссылку или используйте кнопки меню.');
            }
        } catch (e) {
            console.error(`[Bot] Ошибка в общем обработчике текста для ${userId}:`, e);
            await ctx.reply(texts.error).catch(() => {});
        }
    });
}

// === ЗАПУСК И ОСТАНОВКА ПРИЛОЖЕНИЯ ===
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