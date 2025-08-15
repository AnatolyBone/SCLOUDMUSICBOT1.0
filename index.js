// index.js (ФИНАЛЬНАЯ ВЕРСИЯ - ВСЕ ИСПРАВЛЕНО)

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
    pool, supabase, getUserById, resetDailyStats, getAllUsers, getPaginatedUsers, 
    getReferralSourcesStats, getDownloadsByDate, getRegistrationsByDate, 
    getActiveUsersByDate, getExpiringUsers, setPremium, updateUserField, 
    getLatestReviews, getUserActivityByDayHour, getDownloadsByUserId, getReferralsByUserId
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
                console.log('[App] Вебхук установлен.');
            } else {
                console.log('[App] Вебхук уже установлен.');
            }
            app.use(bot.webhookCallback(WEBHOOK_PATH));
            app.listen(PORT, () => console.log(`✅ [App] Сервер запущен на порту ${PORT}.`));
        } else {
            console.log('[App] Запуск бота в режиме long-polling...');
            await bot.telegram.deleteWebhook({ drop_pending_updates: true });
            await bot.launch();
        }
        console.log('[App] Настройка фоновых задач...');
        setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
        setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`), 60000);
    } catch (err) {
        console.error('🔴 Критическая ошибка при запуске:', err);
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
            try { res.locals.user = await getUserById(req.session.userId); } catch {}
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
            const [users, referralStats, downloadsRaw, registrationsRaw, activeRaw] = await Promise.all([
                getAllUsers(true), getReferralSourcesStats(), getDownloadsByDate(),
                getRegistrationsByDate(), getActiveUsersByDate()
            ]);
            const stats = {
                total_users: users.length,
                active_users: users.filter(u => u.active).length,
                total_downloads: users.reduce((sum, u) => sum + (u.total_downloads || 0), 0),
                active_today: users.filter(u => u.last_active && new Date(u.last_active).toDateString() === new Date().toDateString()).length
            };
            const prepareChartData = (registrations, downloads, active) => ({
                labels: [...new Set([...Object.keys(registrations), ...Object.keys(downloads), ...Object.keys(active)])].sort(),
                datasets: [ { label: 'Регистрации', data: Object.values(registrations), borderColor: '#198754' }, { label: 'Загрузки', data: Object.values(downloads), borderColor: '#fd7e14' }, { label: 'Активные', data: Object.values(active), borderColor: '#0d6efd' } ]
            });
            res.render('dashboard', { title: 'Дашборд', page: 'dashboard', stats, query: req.query, chartDataCombined: prepareChartData(registrationsRaw, downloadsRaw, activeRaw) });
        } catch (error) {
            console.error("Ошибка дашборда:", error);
            res.status(500).send("Ошибка сервера");
        }
    });

    app.get('/users', requireAuth, async (req, res) => {
        try {
            const { q = '', status = '', page = 1, limit = 25, sort = 'created_at', order = 'desc' } = req.query;
            const { users, totalPages, totalUsers } = await getPaginatedUsers({
                searchQuery: q, statusFilter: status, page: parseInt(page), limit: parseInt(limit), sortBy: sort, sortOrder: order
            });
            const queryParams = { q, status, page, limit, sort, order };
            res.render('users', { title: 'Пользователи', page: 'users', users, totalUsers, totalPages, currentPage: parseInt(page), limit: parseInt(limit), searchQuery: q, statusFilter: status, queryParams });
        } catch (error) {
            console.error("Ошибка на странице пользователей:", error);
            res.status(500).send("Ошибка сервера");
        }
    });

    app.get('/users-table', requireAuth, async (req, res) => {
        try {
            const { q = '', status = '', page = 1, limit = 25, sort = 'created_at', order = 'desc' } = req.query;
            const { users, totalPages } = await getPaginatedUsers({
                searchQuery: q, statusFilter: status, page: parseInt(page), limit: parseInt(limit), sortBy: sort, sortOrder: order
            });
            const queryParams = { q, status, page, limit, sort, order };
            res.render('partials/users-table', { users, totalPages, currentPage: parseInt(page), queryParams, layout: false });
        } catch (error) {
            console.error("Ошибка при обновлении таблицы:", error);
            res.status(500).send("Ошибка сервера");
        }
    });
    
    app.get('/user/:id', requireAuth, async (req, res) => {
        try {
            const userId = req.params.id;
            const [userProfile, downloads, referrals] = await Promise.all([ getUserById(userId), getDownloadsByUserId(userId), getReferralsByUserId(userId) ]);
            if (!userProfile) {
                return res.status(404).render('user-profile', { title: 'Пользователь не найден', page: 'users', userProfile: null, downloads: [], referrals: [] });
            }
            res.render('user-profile', { title: `Профиль: ${userProfile.first_name || userId}`, page: 'users', userProfile, downloads, referrals });
        } catch (error) {
            console.error(`Ошибка при получении профиля пользователя ${req.params.id}:`, error);
            res.status(500).send("Ошибка сервера");
        }
    });
    
    app.get('/broadcast', requireAuth, (req, res) => { 
        res.render('broadcast-form', { title: 'Рассылка', page: 'broadcast', error: null, success: null }); 
    });

    // В ФАЙЛЕ index.js

// >>>>> ЗАМЕНИТЕ ВЕСЬ БЛОК app.post('/broadcast', ...) НА ЭТОТ <<<<<

app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res) => {
    const { message } = req.body;
    const audioFile = req.file;
    
    if (!message) {
        return res.render('broadcast-form', { title: 'Рассылка', page: 'broadcast', error: 'Текст сообщения не может быть пустым.', success: null });
    }
    
    try {
        const users = await getAllUsers(true);
        res.render('broadcast-form', {
            title: 'Рассылка',
            page: 'broadcast',
            error: null,
            success: `Рассылка запущена для ${users.length} активных пользователей...`
        });
        
        (async () => {
            console.log(`[Broadcast] Начинаю рассылку для ${users.length} пользователей.`);
            let successCount = 0;
            let errorCount = 0;
            
            // ИСПРАВЛЕНИЕ: Преобразуем базовый Markdown в безопасный HTML
            let safeMessage = message
                .replace(/\*(.*?)\*/g, '<b>$1</b>') // *жирный* -> <b>жирный</b>
                .replace(/_(.*?)_/g, '<i>$1</i>') // _курсив_ -> <i>курсив</i>
                .replace(/`(.*?)`/g, '<code>$1</code>'); // `код` -> <code>код</code>
            
            for (const user of users) {
                try {
                    const options = { parse_mode: 'HTML' }; // <<< ИСПОЛЬЗУЕМ HTML
                    
                    if (audioFile) {
                        options.caption = safeMessage;
                        await bot.telegram.sendAudio(user.id, { source: audioFile.path }, options);
                    } else {
                        await bot.telegram.sendMessage(user.id, safeMessage, options);
                    }
                    successCount++;
                } catch (e) {
                    errorCount++;
                    if (e.response?.error_code === 403) {
                        await updateUserField(user.id, 'active', false);
                    } else {
                        // Логируем ошибку, чтобы понять, в чем дело в следующий раз
                        console.error(`[Broadcast] Ошибка отправки для user ${user.id}:`, e.message);
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            console.log(`[Broadcast] Рассылка завершена. Успешно: ${successCount}, Ошибки: ${errorCount}`);
            if (audioFile) {
                fs.unlink(audioFile.path, (err) => {
                    if (err) console.error("Не удалось удалить временный файл рассылки:", err);
                });
            }
        })();
    } catch (e) {
        console.error('Ошибка при запуске рассылки:', e);
        res.render('broadcast-form', { title: 'Рассылка', page: 'broadcast', error: 'Критическая ошибка при запуске рассылки.', success: null });
    }
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
        res.redirect(req.get('Referrer') || '/users');
    });

    app.post('/reset-bonus', requireAuth, async (req, res) => {
        const { userId } = req.body;
        if (userId) { await updateUserField(userId, 'subscribed_bonus_used', false); }
        res.redirect(req.get('Referrer') || '/users');
    });

    app.post('/reset-daily-limit', requireAuth, async (req, res) => {
        const { userId } = req.body;
        if (userId) {
            await updateUserField(userId, 'downloads_today', 0);
            await updateUserField(userId, 'tracks_today', '[]');
        }
        res.redirect(req.get('Referrer') || '/users');
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