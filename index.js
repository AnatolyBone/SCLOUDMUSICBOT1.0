// index.js

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

// === Импорты модулей НАШЕГО приложения ===
import { pool, getUserById, resetDailyStats, getAllUsers, getReferralSourcesStats } from './db.js';
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

// Главный "дроссель" для защиты от перегрузки: обрабатываем не более 1 сообщения за раз
const limit = pLimit(1); 

async function startApp() {
    console.log('[App] Запуск приложения...');
    try {
        await loadTexts(true);
        await redisService.connect();
        
        setupExpress();
        
        // Мидлвэр pLimit должен быть ПЕРЕД настройкой вебхука/запуском
        bot.on('message', async (ctx, next) => limit(() => next()));

        if (process.env.NODE_ENV === 'production') {
            console.log(`[App] Настройка вебхука для Telegram на ${WEBHOOK_URL}...`);
            
            // Получаем информацию о текущем вебхуке
            const webhookInfo = await bot.telegram.getWebhookInfo();
            // Устанавливаем вебхук с опцией пропуска старых сообщений, если URL не совпадает
            if (webhookInfo.url !== WEBHOOK_URL) {
                await bot.telegram.setWebhook(WEBHOOK_URL, {
                    drop_pending_updates: true 
                });
                console.log('[App] Вебхук установлен, старые сообщения пропущены.');
            } else {
                 console.log('[App] Вебхук уже установлен. Пропускаем настройку.');
            }

            // Используем webhookCallback для интеграции с Express
            app.use(bot.webhookCallback(WEBHOOK_PATH));
            app.listen(PORT, () => console.log(`✅ [App] Сервер запущен на порту ${PORT}.`));

        } else {
            console.log('[App] Запуск бота в режиме long-polling для разработки...');
            // Для long-polling удаляем вебхук и запускаемся с опцией пропуска старых сообщений
            await bot.telegram.deleteWebhook({ drop_pending_updates: true });
            console.log('[App] Старые сообщения пропущены.');
            await bot.launch();
            console.log('✅ [App] Бот запущен.');
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
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
    }));
    
    app.use(async (req, res, next) => {
        res.locals.user = null;
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
        res.render('login', { title: 'Вход' });
    });

    app.post('/admin', (req, res) => {
        if (req.body.username === ADMIN_LOGIN && req.body.password === ADMIN_PASSWORD) {
            req.session.authenticated = true;
            req.session.userId = ADMIN_ID;
            res.redirect('/dashboard');
        } else {
            res.render('login', { title: 'Вход', error: 'Неверные данные' });
        }
    });

    app.get('/logout', (req, res) => {
        req.session.destroy(() => res.redirect('/admin'));
    });

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
                stats: stats,
                users: users.slice(0, 50),
                referralStats: referralStats,
                period: req.query.period || '30'
            });
        } catch (error) {
            console.error("Ошибка при загрузке дашборда:", error);
            res.status(500).send("Ошибка сервера при загрузке дашборда");
        }
    });
}

async function stopBot(signal) {
    console.log(`[App] Получен сигнал ${signal}. Начинаю корректное завершение...`);
    try {
        if (bot.polling?.isRunning()) bot.stop(signal);
        
        const promises = [];
        if (redisService.client?.isOpen) {
            promises.push(redisService.client.quit().then(() => console.log('✅ [Redis] Клиент отключен')));
        }
        promises.push(pool.end().then(() => console.log('✅ [DB] Пул PostgreSQL закрыт')));
        
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