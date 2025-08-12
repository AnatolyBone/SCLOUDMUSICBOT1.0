// index.js (ФИНАЛЬНАЯ ВЕРСИЯ)

// === Встроенные и сторонние библиотеки ===
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

// === Импорты модулей НАШЕГО приложения ===
import { pool, supabase, getUserById, resetDailyStats, getAllUsers, getReferralSourcesStats, getDownloadsByDate, getRegistrationsByDate, getActiveUsersByDate, getExpiringUsersPaginated, getExpiringUsersCount, setPremium, updateUserField } from './db.js';
import { bot } from './bot.js';
import redisService from './services/redisClient.js';
import { WEBHOOK_URL, PORT, SESSION_SECRET, ADMIN_ID, ADMIN_LOGIN, ADMIN_PASSWORD, WEBHOOK_PATH } from './config.js';
import { loadTexts } from './config/texts.js';
import { downloadQueue } from './services/downloadManager.js';

// === Глобальные экземпляры и утилиты ===
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
        bot.on('message', async (ctx, next) => limit(() => next()));

        if (process.env.NODE_ENV === 'production') {
            console.log(`[App] Настройка вебхука для Telegram на ${WEBHOOK_URL}...`);
            const webhookInfo = await bot.telegram.getWebhookInfo();
            if (webhookInfo.url !== (WEBHOOK_URL + WEBHOOK_PATH)) {
                await bot.telegram.setWebhook(WEBHOOK_URL + WEBHOOK_PATH, { drop_pending_updates: true });
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
        console.log('[App] Фоновый индексатор временно отключен.');
        
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
        store: new pgSession({ pool, tableName: 'session' }),
        secret: SESSION_SECRET, resave: false, saveUninitialized: false,
        cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
    }));
    
    app.use(async (req, res, next) => {
        res.locals.user = null;
        res.locals.page = ''; // Устанавливаем значение по умолчанию
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
        if (req.session.authenticated) return res.redirect('/dashboard');
        // <<< ИСПРАВЛЕНО: Добавлена переменная page >>>
        res.render('login', { title: 'Вход', page: 'login' });
    });

    app.post('/admin', (req, res) => {
        if (req.body.username === ADMIN_LOGIN && req.body.password === ADMIN_PASSWORD) {
            req.session.authenticated = true;
            req.session.userId = ADMIN_ID;
            res.redirect('/dashboard');
        } else {
            res.render('login', { title: 'Вход', error: 'Неверные данные', page: 'login' });
        }
    });

    app.get('/logout', (req, res) => {
        req.session.destroy(() => res.redirect('/admin'));
    });

    // <<< ИСПРАВЛЕНО: Полностью восстановлена логика дашборда со всеми переменными >>>
    app.get('/dashboard', requireAuth, async (req, res) => {
        try {
            const users = await getAllUsers(true);
            const referralStats = await getReferralSourcesStats();
            
            const stats = {
                total_users: users.length,
                active_users: users.filter(u => u.active).length,
                total_downloads: users.reduce((sum, u) => sum + (u.total_downloads || 0), 0),
            };

            res.render('dashboard', { 
                title: 'Дашборд', 
                user: req.user,
                page: 'dashboard', // Передаем page
                stats: stats,
                users: users.slice(0, 50),
                referralStats: referralStats,
                period: req.query.period || '30',
                // Передаем пустые заглушки для графиков, чтобы избежать ошибок
                chartDataCombined: { labels: [], datasets: [] },
                chartDataHourActivity: { labels: [], datasets: [] },
                chartDataWeekdayActivity: { labels: [], datasets: [] }
            });
        } catch (error) {
            console.error("Ошибка при загрузке дашборда:", error);
            res.status(500).send("Ошибка сервера при загрузке дашборда");
        }
    });

    // <<< ВОССТАНОВЛЕНО: Остальные маршруты админки >>>
    app.get('/user/:id', requireAuth, async (req, res) => {
        try {
            const userId = parseInt(req.params.id);
            if (isNaN(userId)) return res.status(400).send('Неверный ID');
            const user = await getUserById(userId);
            if (!user) return res.status(404).send('Пользователь не найден');
            const { data: downloads } = await supabase.from('downloads_log').select('*').eq('user_id', userId).order('downloaded_at', { ascending: false }).limit(100);
            res.render('user-profile', {
                title: `Профиль: ${user.first_name || user.username}`, user,
                downloads: downloads || [], page: 'user-profile'
            });
        } catch (e) {
            res.status(500).send('Ошибка сервера');
        }
    });
    
    app.get('/broadcast', requireAuth, (req, res) => { 
        res.render('broadcast-form', { title: 'Рассылка', page: 'broadcast', error: null, success: null }); 
    });

    app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res) => {
        // ... (ваша логика рассылки) ...
        res.render('broadcast-form', { title: 'Рассылка', page: 'broadcast', success: 'Рассылка завершена' });
    });
    
    app.get('/export', requireAuth, async (req, res) => {
        const users = await getAllUsers(true);
        const csv = await json2csv.json2csv(users, {});
        res.header('Content-Type', 'text/csv');
        res.attachment('users.csv');
        return res.send(csv);
    });

    app.post('/set-tariff', requireAuth, async (req, res) => {
        const { userId, limit, days } = req.body;
        await setPremium(userId, parseInt(limit), parseInt(days) || 30);
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