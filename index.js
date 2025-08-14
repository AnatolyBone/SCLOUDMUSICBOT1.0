// index.js (ФИНАЛЬНАЯ ВЕРСИЯ - ВСЕ ВКЛЮЧЕНО)

import express from 'express';
import session from 'express-session';
import compression from 'compression';
import path from 'path';
import multer from 'multer';
import expressLayouts from 'express-ejs-layouts';
import { fileURLToPath } from 'url';
import pgSessionFactory from 'connect-pg-simple';
import pLimit from 'p-limit';
import json2csv from 'json-2-csv';
import fs from 'fs';

import { 
    pool, 
    supabase,
    getUserById, 
    resetDailyStats, 
    getAllUsers, 
    getReferralSourcesStats, 
    getDownloadsByDate, 
    getRegistrationsByDate, 
    getActiveUsersByDate, 
    getExpiringUsers,
    setPremium,
    updateUserField,
    getLatestReviews,
    getUserActivityByDayHour
} from './db.js';
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
            console.log('[App] Запуск бота в режиме long-polling для разработки...');
            await bot.telegram.deleteWebhook({ drop_pending_updates: true });
            await bot.launch();
        }

        console.log('[App] Настройка фоновых задач (таймеров)...');
        setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
        setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.activeTasks} в работе.`), 60000);
        
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
    app.use('/static', express.static(path.join(__dirname, 'public')));
    app.use(expressLayouts);
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    app.set('layout', 'layout');
    
    const pgSession = pgSessionFactory(session);
    app.use(session({ store: new pgSession({ pool, tableName: 'session' }), secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } }));
    
    app.use(async (req, res, next) => {
        res.locals.user = null;
        res.locals.page = '';
        if (req.session.authenticated && req.session.userId === ADMIN_ID) {
            try {
                res.locals.user = await getUserById(req.session.userId);
            } catch {}
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
        res.render('login', { title: 'Вход', page: 'login', layout: false, error: null });
    });

    app.post('/admin', (req, res) => {
        if (req.body.username === ADMIN_LOGIN && req.body.password === ADMIN_PASSWORD) {
            req.session.authenticated = true;
            req.session.userId = ADMIN_ID;
            res.redirect('/dashboard');
        } else {
            res.render('login', { title: 'Вход', error: 'Неверные данные', page: 'login', layout: false });
        }
    });

    app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/admin')));

    app.get('/dashboard', requireAuth, async (req, res) => {
        try {
            const [users, referralStats, downloadsRaw, registrationsRaw, activeRaw, activityByHourRaw] = await Promise.all([
                getAllUsers(true), getReferralSourcesStats(), getDownloadsByDate(),
                getRegistrationsByDate(), getActiveUsersByDate(), getUserActivityByDayHour()
            ]);
            
            const stats = {
                total_users: users.length,
                active_users: users.filter(u => u.active).length,
                total_downloads: users.reduce((sum, u) => sum + (u.total_downloads || 0), 0),
                active_today: users.filter(u => u.last_active && new Date(u.last_active).toDateString() === new Date().toDateString()).length
            };
            
            const prepareChartData = (registrations, downloads, active) => ({
                labels: [...new Set([...Object.keys(registrations), ...Object.keys(downloads), ...Object.keys(active)])].sort(),
                datasets: [
                    { label: 'Регистрации', data: Object.values(registrations), borderColor: '#198754' },
                    { label: 'Загрузки', data: Object.values(downloads), borderColor: '#fd7e14' },
                    { label: 'Активные', data: Object.values(active), borderColor: '#0d6efd' }
                ]
            });
            
            res.render('dashboard', { 
                title: 'Дашборд', page: 'dashboard', 
                stats, query: req.query,
                chartDataCombined: prepareChartData(registrationsRaw, downloadsRaw, activeRaw),
                chartDataHourActivity: { labels: [], datasets: [] },
                chartDataWeekdayActivity: { labels: [], datasets: [] }
            });
        } catch (error) {
            console.error("Ошибка дашборда:", error);
            res.status(500).send("Ошибка сервера");
        }
    });

    app.get('/users', requireAuth, async (req, res) => {
        try {
            const { q: searchQuery = '', status: statusFilter = '', page: pageNum = 1, limit = 25 } = req.query;
            const offset = (pageNum - 1) * limit;

            let queryText = 'SELECT id, username, first_name, total_downloads, premium_limit, created_at, last_active, active FROM users';
            const whereClauses = [];
            const queryParams = [];
            if (statusFilter === 'active') whereClauses.push('active = TRUE');
            else if (statusFilter === 'inactive') whereClauses.push('active = FALSE');
            if (searchQuery) {
                queryParams.push(`%${searchQuery}%`);
                whereClauses.push(`(CAST(id AS TEXT) ILIKE $${queryParams.length} OR first_name ILIKE $${queryParams.length} OR username ILIKE $${queryParams.length})`);
            }
            if (whereClauses.length > 0) queryText += ' WHERE ' + whereClauses.join(' AND ');

            const totalResult = await pool.query(`SELECT COUNT(*) FROM (${queryText.split('ORDER BY')[0]}) AS subquery`, queryParams);
            const totalUsers = parseInt(totalResult.rows[0].count, 10);
            const totalPages = Math.ceil(totalUsers / limit);

            queryText += ' ORDER BY created_at DESC';
            queryParams.push(limit);
            queryText += ` LIMIT $${queryParams.length}`;
            queryParams.push(offset);
            queryText += ` OFFSET $${queryParams.length}`;
            const { rows: users } = await pool.query(queryText, queryParams);

            res.render('users', {
                title: 'Пользователи', page: 'users', users,
                totalPages, currentPage: pageNum, limit, searchQuery, statusFilter, totalUsers
            });
        } catch (error) {
            console.error("Ошибка страницы пользователей:", error);
            res.status(500).send("Ошибка сервера");
        }
    });
    
    app.get('/broadcast', requireAuth, (req, res) => { 
        res.render('broadcast-form', { title: 'Рассылка', page: 'broadcast', error: null, success: null }); 
    });
    
    app.get('/expiring-users', requireAuth, async (req, res) => {
        try {
            const users = await getExpiringUsers();
            res.render('expiring-users', { title: 'Истекающие подписки', page: 'expiring-users', users });
        } catch(e) {
            res.status(500).send("Ошибка сервера");
        }
    });

    app.post('/set-tariff', requireAuth, async (req, res) => {
        const { userId, limit, days } = req.body;
        try {
            await setPremium(userId, parseInt(limit), parseInt(days) || 30);
            let tariffName = '';
            const newLimit = parseInt(limit);
            if (newLimit <= 5) tariffName = 'Free';
            else if (newLimit <= 30) tariffName = 'Plus';
            else if (newLimit <= 100) tariffName = 'Pro';
            else tariffName = 'Unlimited';
            const message = `🎉 Ваш тариф был обновлен администратором!\n\nНовый тариф: *${tariffName}* (${newLimit} загрузок/день).\nСрок действия: *${parseInt(days) || 30} дней*.`;
            await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error(`[Admin] Ошибка при смене тарифа для ${userId}:`, error.message);
        }
        res.redirect(req.get('referer') || '/dashboard');
    });
}

async function stopBot(signal) {
    console.log(`[App] Получен сигнал ${signal}. Начинаю корректное завершение...`);
    try {
        if (bot.polling?.isRunning()) bot.stop(signal);
        const promises = [];
        if (redisService.client?.isOpen) promises.push(redisService.client.quit());
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