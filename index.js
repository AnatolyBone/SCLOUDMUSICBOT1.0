// index.js (ФИНАЛЬНАЯ ВЕРСИЯ СО ВСЕМИ ФУНКЦИЯМИ И ИМПОРТАМИ)

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
import cron from 'node-cron';

// Полный и правильный список импортов из db.js
import { 
    pool, supabase, getUserById, resetDailyStats, getAllUsers, getPaginatedUsers, 
    getReferralSourcesStats, getDownloadsByDate, getRegistrationsByDate, 
    getActiveUsersByDate, getExpiringUsers, setPremium, updateUserField, 
    getLatestReviews, getUserActivityByDayHour, getDownloadsByUserId, getReferralsByUserId, 
    getCachedTracksCount, getActiveFreeUsers, getActivePremiumUsers,
    createBroadcastTask, getPendingBroadcastTask, completeBroadcastTask, failBroadcastTask,
    getAllBroadcastTasks, deleteBroadcastTask, getBroadcastTaskById, updateBroadcastTask,
    getUsersCountByTariff, getTopReferralSources, getDailyStats, getActivityByWeekday, logEvent
} from './db.js';
import { bot } from './bot.js';
import redisService from './services/redisClient.js';
import { WEBHOOK_URL, PORT, SESSION_SECRET, ADMIN_ID, ADMIN_LOGIN, ADMIN_PASSWORD, WEBHOOK_PATH, STORAGE_CHANNEL_ID, CHANNEL_USERNAME } from './config.js';
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
        startBroadcastWorker();

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
        } else {
            console.log('[App] Запуск бота в режиме long-polling...');
            await bot.telegram.deleteWebhook({ drop_pending_updates: true });
            bot.launch();
        }
        
        app.listen(PORT, () => console.log(`✅ [App] Сервер запущен на порту ${PORT}.`));
        
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
    app.get('/', requireAuth, (req, res) => res.redirect('/dashboard'));
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
    
    // В ФАЙЛЕ index.js

// >>>>> ЗАМЕНИТЕ ВЕСЬ БЛОК app.get('/dashboard', ...) НА ЭТОТ <<<<<

app.get('/dashboard', requireAuth, async (req, res) => {
    try {
        const period = req.query.period || 30; // Берем период из URL, по умолчанию 30 дней
        
        let storageStatus = { available: false, error: '' };
        if (STORAGE_CHANNEL_ID) {
            try {
                await bot.telegram.getChat(STORAGE_CHANNEL_ID);
                storageStatus.available = true;
            } catch (e) {
                storageStatus.error = e.message;
                console.error("[Dashboard] Ошибка проверки канала-хранилища:", e.message);
            }
        }
        
        // Запускаем все запросы к базе данных параллельно для максимальной скорости
        const [
            users,
            cachedTracksCount,
            usersByTariff,
            topSources,
            dailyStats,
            weekdayActivity
        ] = await Promise.all([
            getAllUsers(true),
            getCachedTracksCount(),
            getUsersCountByTariff(),
            getTopReferralSources(),
            getDailyStats(period),
            getActivityByWeekday()
        ]);
        
        // Собираем все метрики в один удобный объект
        const stats = {
            total_users: users.length,
            active_users: users.filter(u => u.active).length,
            total_downloads: users.reduce((sum, u) => sum + (u.total_downloads || 0), 0),
            active_today: users.filter(u => u.last_active && new Date(u.last_active).toDateString() === new Date().toDateString()).length,
            queueWaiting: downloadQueue.size,
            queueActive: downloadQueue.active,
            cachedTracksCount: cachedTracksCount,
            usersByTariff: usersByTariff,
            topSources: topSources
        };
        
        // Готовим данные для Графика 1: Динамика метрик
        const chartDataCombined = {
            labels: dailyStats.map(d => new Date(d.day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })),
            datasets: [
                { label: 'Регистрации', data: dailyStats.map(d => d.registrations), borderColor: '#198754', tension: 0.1, fill: false },
                { label: 'Активные юзеры', data: dailyStats.map(d => d.active_users), borderColor: '#0d6efd', tension: 0.1, fill: false },
                { label: 'Загрузки', data: dailyStats.map(d => d.downloads), borderColor: '#fd7e14', tension: 0.1, fill: false }
            ]
        };
        
        // Готовим данные для Графика 2: Распределение по тарифам
        const chartDataTariffs = {
            labels: Object.keys(usersByTariff),
            datasets: [{
                data: Object.values(usersByTariff),
                backgroundColor: ['#6c757d', '#17a2b8', '#ffc107', '#007bff'] // Цвета для Free, Plus, Pro, Unlimited
            }]
        };
        
        // Готовим данные для Графика 3: Активность по дням недели
        const chartDataWeekday = {
            labels: weekdayActivity.map(d => d.weekday.trim()),
            datasets: [{
                label: 'Загрузки',
                data: weekdayActivity.map(d => d.count),
                backgroundColor: 'rgba(13, 110, 253, 0.5)',
                borderColor: 'rgba(13, 110, 253, 1)',
                borderWidth: 1
            }]
        };
        
        // Рендерим шаблон, передавая все подготовленные данные
        res.render('dashboard', {
            title: 'Дашборд',
            page: 'dashboard',
            stats,
            storageStatus,
            period,
            chartDataCombined,
            chartDataTariffs,
            chartDataWeekday
        });
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
    
    app.get('/broadcasts', requireAuth, async (req, res) => {
        const tasks = await getAllBroadcastTasks();
        res.render('broadcasts', { title: 'Управление рассылками', page: 'broadcasts', tasks });
    });
    
    app.get('/broadcast/new', requireAuth, (req, res) => { 
        res.render('broadcast-form', { title: 'Новая рассылка', page: 'broadcasts', error: null, success: null }); 
    });

    app.get('/broadcast/edit/:id', requireAuth, async (req, res) => {
        const task = await getBroadcastTaskById(req.params.id);
        if (!task || task.status !== 'pending') {
            return res.redirect('/broadcasts');
        }
        res.render('broadcast-form', { title: 'Редактировать рассылку', page: 'broadcasts', task, error: null, success: null });
    });

    app.post('/broadcast/delete', requireAuth, async (req, res) => {
        const { taskId } = req.body;
        await deleteBroadcastTask(taskId);
        res.redirect('/broadcasts');
    });

    app.post(['/broadcast/new', '/broadcast/edit/:id'], requireAuth, upload.single('audio'), async (req, res) => {
        const isEditing = !!req.params.id;
        const taskId = req.params.id;
        try {
            const { message, targetAudience, scheduledAt, disable_notification, action } = req.body;
            const audioFile = req.file;
            const renderOptions = { title: isEditing ? 'Редактировать рассылку' : 'Новая рассылка', page: 'broadcasts', success: null, error: null, task: isEditing ? await getBroadcastTaskById(taskId) : undefined };
            if (!message) {
                renderOptions.error = 'Текст сообщения не может быть пустым.';
                return res.render('broadcast-form', renderOptions);
            }
            const taskData = {
                message,
                audioPath: audioFile ? audioFile.path : (isEditing ? (await getBroadcastTaskById(taskId)).audio_path : null),
                targetAudience,
                disableNotification: !!disable_notification,
            };
            if (action === 'preview') {
                await runSingleBroadcast(taskData, [{ id: ADMIN_ID }]);
                if (audioFile) fs.unlinkSync(audioFile.path);
                renderOptions.success = 'Предпросмотр отправлен вам в Telegram.';
                return res.render('broadcast-form', renderOptions);
            }
            const scheduleTime = scheduledAt ? new Date(scheduledAt) : new Date();
            if (isEditing) {
                await updateBroadcastTask(taskId, { ...taskData, scheduledAt: scheduleTime });
            } else {
                await createBroadcastTask({ ...taskData, scheduledAt: scheduleTime });
            }
            res.redirect('/broadcasts');
        } catch (e) {
            console.error('Ошибка создания/редактирования задачи:', e);
            res.render('broadcast-form', { title: 'Ошибка', page: 'broadcasts', error: 'Не удалось сохранить задачу.', success: null, task: isEditing ? { ...req.body, id: taskId } : req.body });
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

async function runSingleBroadcast(task, users, taskId = null) {
    console.log(`[Broadcast Worker] Запуск рассылки для ${users.length} пользователей.`);
    let successCount = 0, errorCount = 0;
    let safeMessage = task.message.replace(/\*(.*?)\*/g, '<b>$1</b>').replace(/_(.*?)_/g, '<i>$1</i>').replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>');
    for (const user of users) {
        try {
            const options = { parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: task.disableNotification };
            if (task.audioPath || task.audio_path) {
                options.caption = safeMessage;
                await bot.telegram.sendAudio(user.id, { source: task.audioPath || task.audio_path }, options);
            } else {
                await bot.telegram.sendMessage(user.id, safeMessage, options);
            }
            successCount++;
        } catch (e) {
            errorCount++;
            if (e.response?.error_code === 403) await updateUserField(user.id, 'active', false);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    const report = { successCount, errorCount, totalUsers: users.length };
    console.log(`[Broadcast Worker] Рассылка завершена.`, report);
    if (users.length > 1 || (users.length === 1 && users[0].id !== ADMIN_ID)) {
        try {
            const audienceName = task.targetAudience.replace('_', ' ');
            const reportMessage = `📢 Отчет по рассылке ${taskId ? `(задача #${taskId})` : ''}\n\n✅ Успешно: *${successCount}*\n❌ Ошибки: *${errorCount}*\n👥 Аудитория: *${audienceName}* (${users.length} чел.)`;
            await bot.telegram.sendMessage(ADMIN_ID, reportMessage, { parse_mode: 'Markdown' });
        } catch (e) { console.error('Не удалось отправить отчет админу:', e.message); }
    }
    return report;
}

function startBroadcastWorker() {
    console.log('[Broadcast Worker] Планировщик запущен.');
    cron.schedule('* * * * *', async () => {
        const task = await getPendingBroadcastTask();
        if (task) {
            try {
                console.log(`[Broadcast Worker] Найдена задача #${task.id}. Начинаю выполнение.`);
                let users = [];
                if (task.target_audience === 'all') users = await getAllUsers(true);
                else if (task.target_audience === 'free_users') users = await getActiveFreeUsers();
                else if (task.target_audience === 'premium_users') users = await getActivePremiumUsers();
                const report = await runSingleBroadcast(task, users, task.id);
                await completeBroadcastTask(task.id, report);
                if (task.audio_path) {
                    fs.unlink(task.audio_path, (err) => {
                        if (err) console.error("Не удалось удалить временный файл рассылки:", err);
                    });
                }
            } catch (error) {
                console.error(`[Broadcast Worker] Критическая ошибка при выполнении задачи #${task.id}:`, error);
                await failBroadcastTask(task.id, error.message);
            }
        }
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