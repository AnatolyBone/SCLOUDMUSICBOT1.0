import express from 'express';
import session from 'express-session';
import compression from 'compression';
import path from 'path';
import multer from 'multer';
import expressLayouts from 'express-ejs-layouts';
import { fileURLToPath } from 'url';
import pgSessionFactory from 'connect-pg-simple';
import pLimit from 'p-limit';
import fs from 'fs';
import { pool, getUserById, resetDailyStats, getAllUsers, getReferralSourcesStats, getDownloadsByDate, getRegistrationsByDate, getActiveUsersByDate, setPremium, updateUserField, getLatestReviews } from './db.js';
import { bot } from './bot.js';
import redisService from './services/redisClient.js';
import { WEBHOOK_URL, PORT, SESSION_SECRET, ADMIN_ID, ADMIN_LOGIN, ADMIN_PASSWORD, WEBHOOK_PATH } from './config.js';
import { loadTexts } from './config/texts.js';
import { downloadQueue } from './services/downloadManager.js';

const app = express();
const upload = multer({ dest: 'uploads/' });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const limit = pLimit(1);

async function startApp() {
    console.log('[App] Запуск приложения...');
    try {
        await loadTexts(true);
        await redisService.connect();
        setupExpress();
        bot.on('message', (ctx, next) => limit(() => next()));

        if (process.env.NODE_ENV === 'production') {
            const fullWebhookUrl = (WEBHOOK_URL.endsWith('/') ? WEBHOOK_URL.slice(0, -1) : WEBHOOK_URL) + WEBHOOK_PATH;
            const webhookInfo = await bot.telegram.getWebhookInfo();
            if (webhookInfo.url !== fullWebhookUrl) {
                await bot.telegram.setWebhook(fullWebhookUrl, { drop_pending_updates: true });
                console.log('[App] Вебхук установлен, старые сообщения пропущены.');
            } else {
                console.log('[App] Вебхук уже установлен.');
            }
            app.use(bot.webhookCallback(WEBHOOK_PATH));
            app.listen(PORT, () => console.log(`✅ [App] Сервер запущен на порту ${PORT}.`));
        } else {
            await bot.telegram.deleteWebhook({ drop_pending_updates: true });
            await bot.launch();
        }

        setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
        setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.activeTasks} в работе.`), 60000);
    } catch (err) {
        console.error('🔴 Критическая ошибка при запуске приложения:', err);
        process.exit(1);
    }
}

function setupExpress() {
    app.use(compression());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(expressLayouts);
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    app.set('layout', 'layout');
    app.use('/static', express.static(path.join(__dirname, 'public')));
    
    const pgSession = pgSessionFactory(session);
    app.use(session({ store: new pgSession({ pool, tableName: 'session' }), secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } }));
    
    app.use(async (req, res, next) => {
        res.locals.user = null;
        res.locals.page = '';
        if (req.session.authenticated && req.session.userId === ADMIN_ID) {
            res.locals.user = await getUserById(req.session.userId);
        }
        next();
    });

    const requireAuth = (req, res, next) => {
        if (req.session.authenticated && req.session.userId === ADMIN_ID) return next();
        res.redirect('/admin');
    };
    
    app.get('/health', (req, res) => res.status(200).send('OK'));
    app.get('/admin', (req, res) => {
        if (req.session.authenticated) return res.redirect('/dashboard');
        res.render('login', { title: 'Вход', layout: false, error: null });
    });

    app.post('/admin', (req, res) => {
        if (req.body.username === ADMIN_LOGIN && req.body.password === ADMIN_PASSWORD) {
            req.session.authenticated = true;
            req.session.userId = ADMIN_ID;
            res.redirect('/dashboard');
        } else {
            res.render('login', { title: 'Вход', error: 'Неверные данные', layout: false });
        }
    });

    app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/admin')));

    // Возвращаем ваш оригинальный дашборд (admin.ejs)
    app.get('/dashboard', requireAuth, async (req, res) => {
        try {
            const users = await getAllUsers(true);
            const reviews = await getLatestReviews();
            res.render('admin', { // <-- Рендерим admin.ejs
                title: 'Админ-панель',
                page: 'dashboard',
                users: users || [],
                reviews: reviews || []
            });
        } catch (error) {
            console.error("Ошибка при загрузке дашборда:", error);
            res.status(500).send("Ошибка сервера");
        }
    });

    // Маршрут для POST-запросов из admin.ejs
    app.post('/admin/set-plan', requireAuth, async (req, res) => {
        const { id, plan, days } = req.body;
        await setPremium(id, parseInt(plan), parseInt(days) || null);
        res.redirect('/dashboard');
    });
}

async function stopBot(signal) { /* ... */ }
process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));

startApp();