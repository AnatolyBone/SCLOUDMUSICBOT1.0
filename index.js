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
    console.error('❌ Отсутствуют необходимые переменные окружения! (BOT_TOKEN, ADMIN_ID, ADMIN_LOGIN, ADMIN_PASSWORD, WEBHOOK_URL, STORAGE_CHANNEL_ID)');
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
    try {
        const now = Date.now();
        const files = await fs.promises.readdir(directory);
        let cleanedCount = 0;
        for (const file of files) {
            try {
                const filePath = path.join(directory, file);
                const stat = await fs.promises.stat(filePath);
                if ((now - stat.mtimeMs) / 60000 > maxAgeMinutes) {
                    await fs.promises.unlink(filePath);
                    cleanedCount++;
                }
            } catch (fileError) {}
        }
        if (cleanedCount > 0) console.log(`[Cache Cleanup] Удалено ${cleanedCount} старых файлов.`);
    } catch (dirError) {
        console.error('[Cache Cleanup] Ошибка:', dirError);
    }
}

export const texts = {
    start: '👋 Пришли ссылку на трек или плейлист с SoundCloud.',
    menu: '📋 Меню',
    upgrade: '🔓 Расширить лимит',
    mytracks: '🎵 Мои треки',
    help: 'ℹ️ Помощь',
    downloading: '🎧 Загружаю...',
    error: '❌ Ошибка',
    noTracks: 'Сегодня нет треков.',
    limitReached: `🚫 Лимит достигнут ❌\n\n💡 Чтобы качать больше треков, переходи на тариф Plus или выше и качай без ограничений.\n\n🎁 Бонус\n📣 Подпишись на наш новостной канал @SCM_BLOG и получи 7 дней тарифа Plus бесплатно!`,
    upgradeInfo: `🚀 Хочешь больше треков?\n\n🆓 Free — 5 🟢  \nPlus — 20 🎯 (59₽)  \nPro — 50 💪 (119₽)  \nUnlimited — 💎 (199₽)\n\n👉 Донат: https://boosty.to/anatoly_bone/donate  \n✉️ После оплаты напиши: @anatolybone\n\n📣 Новости и фишки: @SCM_BLOG`,
    helpInfo: `ℹ️ Просто пришли ссылку и получишь mp3.  \n🔓 Расширить — оплати и подтверди.  \n🎵 Мои треки — список за сегодня.  \n📋 Меню — тариф, лимиты, рефералы.  \n📣 Канал: @SCM_BLOG`,
    adminCommands: '\n\n📋 Команды админа:\n/admin — статистика'
};

const kb = () => Markup.keyboard([[texts.menu, texts.upgrade], [texts.mytracks, texts.help]]).resize();

// =================================================================
// ===           ЛОГИКА БОТА-ИНДЕКСАТОРА ("ПАУКА")              ===
// =================================================================
async function getUrlsToIndex() {
    try {
        const { rows } = await pool.query(`
            SELECT url, COUNT(url) as download_count
            FROM downloads_log
            WHERE url IS NOT NULL AND url LIKE '%soundcloud.com%' AND url NOT IN (SELECT url FROM track_cache)
            GROUP BY url
            ORDER BY download_count DESC
            LIMIT 10;
        `);
        return rows.map(row => row.url);
    } catch (e) {
        console.error('[Indexer] Ошибка получения URL для индексации:', e);
        return [];
    }
}

async function processUrlForIndexing(url) {
    let tempFilePath = null;
    try {
        const isCached = await findCachedTrack(url);
        if (isCached) return;

        console.log(`[Indexer] Индексирую: ${url}`);
        const info = await ytdl(url, { dumpSingleJson: true });
        if (!info || Array.isArray(info.entries)) return;

        const trackName = (info.title || 'track').slice(0, 100);
        tempFilePath = path.join(cacheDir, `indexer_${info.id || Date.now()}.mp3`);
        
        await ytdl(url, { output: tempFilePath, extractAudio: true, audioFormat: 'mp3' });

        if (!fs.existsSync(tempFilePath)) throw new Error('Файл не создан');
        
        const message = await bot.telegram.sendAudio(
            STORAGE_CHANNEL_ID,
            { source: fs.createReadStream(tempFilePath) },
            { caption: trackName, title: trackName }
        );

        if (message?.audio?.file_id) {
            await cacheTrack(url, message.audio.file_id, trackName);
            console.log(`✅ [Indexer] Успешно закэширован: ${trackName}`);
        }
    } catch (err) {
        console.error(`❌ [Indexer] Ошибка при обработке ${url}:`, err.stderr || err.message);
    } finally {
        if (tempFilePath) await fs.promises.unlink(tempFilePath).catch(() => {});
    }
}

async function startIndexer() {
    console.log('🚀 [Indexer] Запуск фонового индексатора...');
    while (true) {
        try {
            const urls = await getUrlsToIndex();
            if (urls.length > 0) {
                console.log(`[Indexer] Найдено ${urls.length} треков для упреждающего кэширования.`);
                for (const url of urls) {
                    await processUrlForIndexing(url);
                    await new Promise(resolve => setTimeout(resolve, 30 * 1000));
                }
            }
        } catch (e) {
            console.error('[Indexer] Ошибка в главном цикле индексатора:', e);
        }
        console.log('[Indexer] Пауза на 1 час.');
        await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
    }
}

// =================================================================
// ===                    ОСНОВНАЯ ЛОГИКА                       ===
// =================================================================
async function startApp() {
    try {
        console.log('[App] Запуск приложения...');
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
        await cleanupCache(cacheDir, 60);

        if (process.env.NODE_ENV === 'production') {
            console.log(`[App] Настройка вебхука для Telegram на ${WEBHOOK_URL}...`);
            app.use(await bot.createWebhook({ domain: WEBHOOK_URL, path: WEBHOOK_PATH }));
            app.listen(PORT, () => console.log(`✅ [App] Сервер запущен на порту ${PORT}.`));
        } else {
            console.log('[App] Запуск бота в режиме long-polling для разработки...');
            await bot.launch();
            console.log('✅ [App] Бот запущен.');
        }
        
        // <<< ИЗМЕНЕНО: Фоновый индексатор отключен для снижения нагрузки >>>
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
    app.use(session({
        store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
    }));

    app.use(async (req, res, next) => {
        res.locals.user = null;
        res.locals.page = '';
        if (req.session.authenticated && req.session.userId === ADMIN_ID) {
            try {
                req.user = await getUserById(req.session.userId);
                res.locals.user = req.user;
            } catch(e) { console.error(e); }
        }
        next();
    });

    const requireAuth = (req, res, next) => {
        if (req.session.authenticated && req.session.userId === ADMIN_ID) return next();
        res.redirect('/admin');
    };
    
    app.get('/health', (req, res) => res.status(200).send('OK'));
    
    app.get('/admin', (req, res) => {
        if (req.session.authenticated && req.session.userId === ADMIN_ID) return res.redirect('/dashboard');
        res.render('login', { title: 'Вход в админку', error: null });
    });

    app.post('/admin', (req, res) => {
        const { username, password } = req.body;
        if (username === ADMIN_LOGIN && password === ADMIN_PASSWORD) {
            req.session.authenticated = true;
            req.session.userId = ADMIN_ID;
            res.redirect('/dashboard');
        } else {
            res.render('login', { title: 'Вход в админку', error: 'Неверный логин или пароль' });
        }
    });

    app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/admin')); });
    
    app.get('/broadcast', requireAuth, (req, res) => {
        res.render('broadcast-form', { title: 'Рассылка', error: null, success: null });
    });

    app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res) => {
        console.log('[Admin] Запущена рассылка...');
        const { message } = req.body;
        const audio = req.file;
        if (!message && !audio) return res.status(400).render('broadcast-form', { error: 'Текст или файл обязательны' });
        
        const users = await getAllUsers();
        let success = 0, error = 0;
        
        for (const u of users) {
            if (!u.active) continue;
            try {
                if (audio) await bot.telegram.sendAudio(u.id, { source: fs.createReadStream(audio.path) }, { caption: message });
                else await bot.telegram.sendMessage(u.id, message);
                success++;
            } catch (e) {
                error++;
                if (e.response?.error_code === 403) await updateUserField(u.id, 'active', false);
            }
            await new Promise(r => setTimeout(r, 150));
        }
        
        if (audio) await fs.promises.unlink(audio.path);
        console.log(`[Admin] Рассылка завершена. Успешно: ${success}, Ошибок: ${error}`);
        
        try {
            await bot.telegram.sendMessage(ADMIN_ID, `📣 Рассылка: ✅ ${success} ❌ ${error}`);
        } catch (adminError) {
            console.error('Не удалось отправить отчет админу о рассылке:', adminError.message);
        }
        
        res.render('broadcast-form', { title: 'Рассылка', success: `Успешно отправлено: ${success}`, error: `Ошибок: ${error}` });
    });
}

function setupTelegramBot() {
    console.log('[Telegraf] Настройка обработчиков бота...');

    bot.catch((err, ctx) => {
        console.error(`🔴 [Telegraf] Глобальная необработанная ошибка для update ${ctx.update.update_id}:`, err);
        try {
            ctx.reply('Ой, что-то пошло не так на сервере. Попробуйте, пожалуйста, еще раз.').catch(() => {});
        } catch {}
    });

    bot.use(async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId) return next();
        try {
            ctx.state.user = await getUser(userId, ctx.from.first_name, ctx.from.username);
        } catch (error) { console.error(`Ошибка в мидлваре получения пользователя ${userId}:`, error); }
        return next();
    });

    bot.start(async (ctx) => {
        console.log(`[Bot] /start от пользователя ${ctx.from.id}`);
        try {
            await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.startPayload || null);
            await ctx.reply(texts.start, kb());
        } catch (e) { console.error(`Ошибка в /start для ${ctx.from.id}:`, e); }
    });

    bot.hears(texts.menu, async (ctx) => {
        console.log(`[Bot] "Меню" от пользователя ${ctx.from.id}`);
        try {
            // ... ваша логика меню
        } catch (e) { console.error(`Ошибка в "Меню" для ${ctx.from.id}:`, e); }
    });

    // ... Другие обработчики ...

    bot.on('text', async (ctx) => {
        const userId = ctx.from.id;
        console.log(`[Bot] Получено текстовое сообщение от ${userId}`);
        try {
            const url = ctx.message.text.match(/(https?:\/\/[^\s]+)/g)?.find(u => u.includes('soundcloud.com'));
            if (url) {
                console.log(`[Bot] Найдена SoundCloud ссылка от ${userId}: ${url}`);
                await enqueue(ctx, userId, url);
            } else {
                if (!Object.values(texts).includes(ctx.message.text)) {
                    await ctx.reply('Пожалуйста, пришлите корректную ссылку на трек или плейлист.');
                }
            }
        } catch (e) {
            console.error(`[Bot] Ошибка в обработчике текста для ${userId}:`, e);
            await ctx.reply(texts.error).catch(() => {});
        }
    });
}

// === ЗАПУСК И ОСТАНОВКА ПРИЛОЖЕНИЯ ===
async function stopBot(signal) {
    console.log(`[App] Получен сигнал ${signal}. Начинаю корректное завершение...`);
    try {
        if (bot.polling?.isRunning()) {
            bot.stop(signal);
            console.log('[App] Telegraf бот остановлен.');
        }
        
        const promises = [];
        if (redisClient?.isOpen) {
            promises.push(redisClient.quit().then(() => console.log('[App] Redis отключён.')));
        }
        promises.push(pool.end().then(() => console.log('[App] Пул PostgreSQL закрыт.')));
        
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