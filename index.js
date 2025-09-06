// index.js (ФИНАЛЬНАЯ ПОЛНАЯ ВЕРСИЯ С ПРОКАЧАННОЙ РАССЫЛКОЙ)

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
import mime from 'mime-types';
import cron from 'node-cron';

import { 
    pool, supabase, getUserById, resetDailyStats, getAllUsers, getPaginatedUsers, 
    getReferralSourcesStats, getDownloadsByDate, getRegistrationsByDate, 
    getActiveUsersByDate, getExpiringUsers, setPremium, updateUserField, 
    getLatestReviews, getUserActivityByDayHour, getDownloadsByUserId, getReferralsByUserId, 
    getCachedTracksCount, getActiveFreeUsers, getActivePremiumUsers,
    getUsersCountByTariff, getTopReferralSources, getDailyStats,
    getActivityByWeekday, getTopTracks, getTopUsers, getHourlyActivity, getUsersAsCsv, 
    getUserActions, logUserAction,
    createBroadcastTask, getAndStartPendingBroadcastTask, completeBroadcastTask, failBroadcastTask,
    getAllBroadcastTasks, deleteBroadcastTask, getBroadcastTaskById, updateBroadcastTask, findAndInterruptActiveBroadcast, getReferrerInfo, getReferredUsers, getReferralStats
} from './db.js';
import { isShuttingDown, setShuttingDown, setMaintenanceMode, isBroadcasting, setBroadcasting } from './services/appState.js';
import { bot } from './bot.js';
import redisService from './services/redisClient.js';
import { WEBHOOK_URL, PORT, SESSION_SECRET, ADMIN_ID, ADMIN_LOGIN, ADMIN_PASSWORD, WEBHOOK_PATH, STORAGE_CHANNEL_ID, BROADCAST_STORAGE_ID } from './config.js';
import { loadTexts, allTextsSync, setText, getEditableTexts } from './config/texts.js';
import { downloadQueue } from './services/downloadManager.js';

const app = express();

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dest = 'uploads/'; // Локальная папка для временного хранения
        fs.mkdirSync(dest, { recursive: true });
        cb(null, dest);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const limit = pLimit(1); 

async function startApp() {
    setMaintenanceMode(false);
    console.log('[App] Запуск приложения...');
    try {
        await loadTexts(true);
        await redisService.connect();
        
        setupExpress();
        startBroadcastWorker();

       // ЗАМЕНИТЕ НА ЭТОТ БЛОК В INDEX.JS

if (process.env.NODE_ENV === 'production') {
    const fullWebhookUrl = (WEBHOOK_URL.endsWith('/') ? WEBHOOK_URL.slice(0, -1) : WEBHOOK_URL) + WEBHOOK_PATH;
    const allowedUpdates = ['message', 'callback_query', 'inline_query'];
    
    console.log('[App] Принудительно устанавливаю вебхук и сбрасываю очередь...');
    await bot.telegram.setWebhook(fullWebhookUrl, {
        drop_pending_updates: true, // <-- Это теперь будет работать при каждом запуске
        allowed_updates: allowedUpdates
    });
    console.log('[App] Вебхук успешно настроен.');
    
    app.use(bot.webhookCallback(WEBHOOK_PATH));

        } else {
            console.log('[App] Запуск бота в режиме long-polling...');
            await bot.telegram.deleteWebhook({ drop_pending_updates: true });
            bot.launch({
                allowedUpdates: ['message', 'callback_query', 'inline_query']
            });
        }

        const server = app.listen(PORT, () => console.log(`✅ [App] Сервер запущен на порту ${PORT}.`));
setupGracefulShutdown(server);
        
        console.log('[App] Настройка фоновых задач...');
        setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
        setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`), 60000);

    } catch (err) {
        console.error('🔴 Критическая ошибка при запуске:', err);
        process.exit(1);
    }
}

function parseButtons(buttonsText) {
    if (!buttonsText || typeof buttonsText !== 'string' || buttonsText.trim() === '') {
        return null;
    }
    const rows = buttonsText.split('\n').map(line => line.trim()).filter(line => line);
    const keyboard = rows.map(row => {
        const parts = row.split('|').map(p => p.trim());
        const [text, type, data] = parts;
        if (!text || !type) return null;

        switch (type.toLowerCase()) {
            case 'url': return { text, url: data };
            case 'callback': return { text, callback_data: data };
            case 'inline_search': return { text, switch_inline_query: data || '' };
            default: return null;
        }
    }).filter(Boolean);
    
    return keyboard.length > 0 ? keyboard.map(button => [button]) : null;
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
    
    // index.js

app.get('/dashboard', requireAuth, async (req, res) => {
    try {
        let storageStatus = { available: false, error: '' };
        if (STORAGE_CHANNEL_ID) {
            try {
                await bot.telegram.getChat(STORAGE_CHANNEL_ID);
                storageStatus.available = true;
            } catch (e) {
                storageStatus.error = e.message;
            }
        }
        
        // 1. Правильный порядок вызовов
        const [
            users,
            registrationsRaw,
            cachedTracksCount,
            usersByTariff,
            topSources,
            dailyStats,
            weekdayActivity,
            topTracks,
            topUsers,
            hourlyActivity,
            referralStats // <-- Теперь на своем месте
        ] = await Promise.all([
            getAllUsers(true),
            getRegistrationsByDate(),
            getCachedTracksCount(),
            getUsersCountByTariff(),
            getTopReferralSources(),
            getDailyStats({ startDate: req.query.startDate, endDate: req.query.endDate }),
            getActivityByWeekday(),
            getTopTracks(),
            getTopUsers(),
            getHourlyActivity(),
            getReferralStats() // <-- И вызов на своем месте
        ]);
        
        // 2. Правильный синтаксис объекта stats
        const stats = {
            total_users: users.length,
            active_users: users.filter(u => u.active).length,
            total_downloads: users.reduce((sum, u) => sum + (u.total_downloads || 0), 0),
            active_today: users.filter(u => u.last_active && new Date(u.last_active).toDateString() === new Date().toDateString()).length,
            queueWaiting: downloadQueue.size,
            queueActive: downloadQueue.active,
            cachedTracksCount: cachedTracksCount,
            usersByTariff: usersByTariff || {},
            topSources: topSources || [],
            totalReferred: referralStats.totalReferred, // <-- Исправлено
            topReferrers: referralStats.topReferrers // <-- Исправлено
        };
        
        const chartDataCombined = {
            labels: (dailyStats || []).map(d => new Date(d.day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })),
            datasets: [
                { label: 'Регистрации', data: (dailyStats || []).map(d => d.registrations), borderColor: '#198754', tension: 0.1, fill: false },
                { label: 'Активные юзеры', data: (dailyStats || []).map(d => d.active_users), borderColor: '#0d6efd', tension: 0.1, fill: false },
                { label: 'Загрузки', data: (dailyStats || []).map(d => d.downloads), borderColor: '#fd7e14', tension: 0.1, fill: false }
            ]
        };
        
        const chartDataTariffs = {
            labels: Object.keys(usersByTariff || {}),
            datasets: [{ data: Object.values(usersByTariff || {}), backgroundColor: ['#6c757d', '#17a2b8', '#ffc107', '#007bff', '#dc3545'] }]
        };
        
        const chartDataWeekday = {
            labels: (weekdayActivity || []).map(d => d.weekday.trim()),
            datasets: [{ label: 'Загрузки', data: (weekdayActivity || []).map(d => d.count), backgroundColor: 'rgba(13, 110, 253, 0.5)' }]
        };
        
        const chartDataHourly = {
            labels: Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, '0')}:00`),
            datasets: [{
                label: 'Загрузки',
                data: hourlyActivity,
                backgroundColor: 'rgba(255, 99, 132, 0.5)',
                borderColor: 'rgba(255, 99, 132, 1)',
                borderWidth: 1
            }]
        };
        
        res.render('dashboard', {
            title: 'Дашборд',
            page: 'dashboard',
            stats,
            storageStatus,
            startDate: req.query.startDate,
            endDate: req.query.endDate,
            chartDataCombined,
            chartDataTariffs,
            chartDataWeekday,
            topTracks,
            topUsers,
            chartDataHourly
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
    
    app.get('/users/export.csv', requireAuth, async (req, res) => {
        try {
            const { q = '', status = '' } = req.query;
            const csvData = await getUsersAsCsv({ searchQuery: q, statusFilter: status });
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="users_${new Date().toISOString().slice(0, 10)}.csv"`);
            res.send(csvData);
        } catch (error) {
            console.error("Ошибка при экспорте пользователей:", error);
            res.status(500).send("Не удалось сгенерировать CSV-файл");
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
    
    // index.js

app.get('/user/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.params.id;
        
        // Теперь мы запрашиваем 5 порций данных параллельно
        const [
            userProfile,
            downloads,
            actions,
            referrer, // <-- Кто пригласил ЭТОГО пользователя
            referredUsers // <-- Кого пригласил ЭТОТ пользователь
        ] = await Promise.all([
            getUserById(userId),
            getDownloadsByUserId(userId),
            getUserActions(userId),
            getReferrerInfo(userId), // <-- Наша новая функция
            getReferredUsers(userId) // <-- Наша новая функция
        ]);
        
        if (!userProfile) {
            // Оставляем эту страницу как есть, на случай если пользователь не найден
            return res.status(404).render('user-profile', {
                title: 'Пользователь не найден',
                page: 'users',
                userProfile: null,
                downloads: [],
                actions: [],
                referrer: null,
                referredUsers: []
            });
        }
        
        // Передаем все 5 порций данных в шаблон для отрисовки
        res.render('user-profile', {
            title: `Профиль: ${userProfile.first_name || userId}`,
            page: 'users',
            userProfile,
            downloads,
            actions,
            referrer, // <-- Передаем в шаблон
            referredUsers // <-- Передаем в шаблон
        });
        
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
        console.log(`[Broadcast Debug] Использую BROADCAST_STORAGE_ID: '${BROADCAST_STORAGE_ID}' (тип: ${typeof BROADCAST_STORAGE_ID})`);
    });

    app.get('/broadcast/edit/:id', requireAuth, async (req, res) => {
        const task = await getBroadcastTaskById(req.params.id);
        if (!task || task.status !== 'pending') {
            return res.redirect('/broadcasts');
        }
        const buttons_text = task.keyboard ? task.keyboard.map(row => {
            const btn = row[0];
            if (btn.url) return `${btn.text} | url | ${btn.url}`;
            if (btn.callback_data) return `${btn.text} | callback | ${btn.callback_data}`;
            if (btn.switch_inline_query !== undefined) return `${btn.text} | inline_search | ${btn.switch_inline_query}`;
            return '';
        }).join('\n') : '';
        res.render('broadcast-form', { title: 'Редактировать рассылку', page: 'broadcasts', task: {...task, buttons_text}, error: null, success: null });
    });

    app.post('/broadcast/delete', requireAuth, async (req, res) => {
        const { taskId } = req.body;
        await deleteBroadcastTask(taskId);
        res.redirect('/broadcasts');
    });

    // index.js

// index.js

app.post(['/broadcast/new', '/broadcast/edit/:id'], requireAuth, upload.single('file'), async (req, res) => {
    const isEditing = !!req.params.id;
    const taskId = req.params.id;
    const file = req.file;

    try {
        const { message, buttons, targetAudience, scheduledAt, disable_notification, enable_web_page_preview, action } = req.body;

        // Определяем, какие данные использовать для рендера формы.
        // Это предотвратит потерю ID при ошибках.
        const taskForRender = { ...req.body, buttons_text: buttons };
        if (isEditing) {
            taskForRender.id = taskId;
        }

        const renderOptions = {
            title: isEditing ? 'Редактировать рассылку' : 'Новая рассылка',
            page: 'broadcasts',
            success: null,
            error: null,
            task: taskForRender // Используем подготовленные данные
        };

        const existingTask = isEditing ? await getBroadcastTaskById(taskId) : {};

        // Валидация
        if (!message && !file && !(existingTask && existingTask.file_id)) {
            if (file) fs.unlinkSync(file.path);
            renderOptions.error = 'Сообщение не может быть пустым, если не прикреплен файл.';
            return res.render('broadcast-form', renderOptions);
        }

        let fileId = existingTask.file_id || null;
        let fileMimeType = existingTask.file_mime_type || null;

        if (file) {
            if (!BROADCAST_STORAGE_ID) {
                if (file) fs.unlinkSync(file.path);
                renderOptions.error = 'Технический канал-хранилище (BROADCAST_STORAGE_ID) не настроен!';
                return res.render('broadcast-form', renderOptions);
            }
            console.log(`[Broadcast] Загружен новый файл, отправляю в хранилище...`);
            const mimeType = mime.lookup(file.path) || '';
            let sentMessage;
            const source = { source: file.path };
            
            if (mimeType.startsWith('image/')) sentMessage = await bot.telegram.sendPhoto(BROADCAST_STORAGE_ID, source);
            else if (mimeType.startsWith('video/')) sentMessage = await bot.telegram.sendVideo(BROADCAST_STORAGE_ID, source);
            else if (mimeType.startsWith('audio/')) sentMessage = await bot.telegram.sendAudio(BROADCAST_STORAGE_ID, source);
            else sentMessage = await bot.telegram.sendDocument(BROADCAST_STORAGE_ID, source);
            
            fileId = sentMessage.photo?.pop()?.file_id || sentMessage.video?.file_id || sentMessage.audio?.file_id || sentMessage.document?.file_id;
            fileMimeType = mimeType;
            
            fs.unlinkSync(file.path);
        }

        const taskData = {
            message,
            keyboard: parseButtons(buttons),
            file_id: fileId,
            file_mime_type: fileMimeType,
            targetAudience,
            disableNotification: !!disable_notification,
            disable_web_page_preview: !enable_web_page_preview,
        };

        if (action === 'preview') {
            await runSingleBroadcast({ ...taskData, targetAudience: 'preview' }, [{ id: ADMIN_ID, first_name: 'Admin' }]);
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
        console.error(`Ошибка создания/редактирования задачи (ID: ${taskId}):`, e);
        if (file) {
            try { fs.unlinkSync(file.path); console.log('[Error Cleanup] Временный файл успешно удален.'); } 
            catch (cleanupError) { console.error('[Error Cleanup] Не удалось удалить временный файл:', cleanupError); }
        }
        
        const taskForRenderOnError = { ...req.body, buttons_text: req.body.buttons };
        if (isEditing) {
            taskForRenderOnError.id = taskId;
        }

        res.render('broadcast-form', { 
            title: isEditing ? 'Редактировать рассылку' : 'Новая рассылка', 
            page: 'broadcasts', 
            error: 'Не удалось сохранить задачу. ' + e.message, 
            success: null, 
            task: taskForRenderOnError
        });
    }
});

   app.get('/texts', requireAuth, async (req, res) => {
    try {
        // Раньше было: const texts = allTextsSync();
        // Теперь мы берем только те тексты, которые можно редактировать
        const texts = getEditableTexts();
        
        res.render('texts', {
            title: 'Редактор текстов',
            page: 'texts',
            texts, // Передаем в шаблон уже отфильтрованный список
            success: req.query.success
        });
        
    } catch (error) {
        console.error("Ошибка на странице текстов:", error);
        res.status(500).send("Ошибка сервера");
    }
});

    app.post('/texts/update', requireAuth, async (req, res) => {
        try {
            const { key, value } = req.body;
            await setText(key, value);
            res.redirect('/texts?success=true');
        } catch (error) {
            console.error("Ошибка при обновлении текста:", error);
            res.status(500).send("Ошибка сервера");
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
            await logUserAction(userId, 'tariff_changed_by_admin', { 
                new_limit: parseInt(limit), 
                days: parseInt(days) || 30 
            });
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
    
    app.post('/user/set-status', requireAuth, async (req, res) => {
        const { userId, newStatus } = req.body;
        if (userId && (newStatus === 'true' || newStatus === 'false')) {
            try {
                const isActive = newStatus === 'true';
                await updateUserField(userId, 'active', isActive);
                const actionType = isActive ? 'unbanned_by_admin' : 'banned_by_admin';
                await logUserAction(userId, actionType);
                if (isActive) {
                    await bot.telegram.sendMessage(userId, '✅ Ваш аккаунт снова активен.').catch(() => {});
                }
            } catch (error) {
                console.error(`[Admin] Ошибка при смене статуса для ${userId}:`, error.message);
            }
        }
        res.redirect(req.get('Referrer') || '/users');
    });
}

// index.js

// >>>>> ЗАМЕНИТЕ СУЩЕСТВУЮЩУЮ ФУНКЦИЮ НА ЭТУ <<<<<
async function runSingleBroadcast(task, users, taskId = null) {
    console.log(`[Broadcast Worker] Запуск рассылки для ${users.length} пользователей.`);
    let successCount = 0, errorCount = 0;
    
    for (const user of users) {
        try {
            const personalMessage = (task.message || '').replace(/{first_name}/g, user.first_name || 'дорогой друг');
            
            const options = { 
                parse_mode: 'HTML', // <--- ГЛАВНОЕ ИЗМЕНЕНИЕ
                disable_web_page_preview: task.disable_web_page_preview, 
                disable_notification: task.disable_notification 
            };
            if (task.keyboard && task.keyboard.length > 0) {
                options.reply_markup = { inline_keyboard: task.keyboard };
            }

            const fileId = task.file_id;

            if (fileId) {
                if (personalMessage) options.caption = personalMessage;
                const mimeType = task.file_mime_type || '';

                if (mimeType.startsWith('image/')) {
                    await bot.telegram.sendPhoto(user.id, fileId, options);
                } else if (mimeType.startsWith('video/')) {
                    await bot.telegram.sendVideo(user.id, fileId, options);
                } else if (mimeType.startsWith('audio/')) {
                    await bot.telegram.sendAudio(user.id, fileId, options);
                } else {
                    await bot.telegram.sendDocument(user.id, fileId, options);
                }
            } else if (personalMessage) {
                await bot.telegram.sendMessage(user.id, personalMessage, options);
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

    // Этот блок отправляет отчет админу. Мы его тоже переведем на HTML.
    if ((users.length > 1 || (users.length === 1 && users[0].id !== ADMIN_ID)) && taskId) {
        try {
            const audienceName = (task.target_audience || 'unknown').replace('_', ' ');
            // <--- ИЗМЕНЕНИЕ: Текст отчета теперь тоже в HTML ---
            const reportMessage = `📢 <b>Отчет по рассылке #${taskId}</b>\n\n` +
                                `✅ Успешно: <b>${successCount}</b>\n` +
                                `❌ Ошибки: <b>${errorCount}</b>\n` +
                                `👥 Аудитория: <b>${audienceName}</b> (${users.length} чел.)`;

            // <--- ИЗМЕНЕНИЕ: parse_mode для отчета ---
            await bot.telegram.sendMessage(ADMIN_ID, reportMessage, { parse_mode: 'HTML' });
        } catch (e) { console.error('Не удалось отправить отчет админу:', e.message); }
    }
    return report;
}
// ======================= ФИНАЛЬНЫЙ БЛОК ДЛЯ КОНЦА INDEX.JS =======================

function setupGracefulShutdown(server) {
    const SHUTDOWN_TIMEOUT = 25000; // 25 секунд (Render дает 30)
    
    const gracefulShutdown = async (signal) => {
        // Защита от повторного вызова
        if (isShuttingDown) {
            console.log('[Shutdown] Процесс завершения уже запущен, повторный вызов проигнорирован.');
            return;
        }
        setShuttingDown();
        console.log(`[Shutdown] Получен сигнал ${signal}. Начинаю изящное завершение...`);
        
        // 1. Перестаем принимать новые HTTP запросы
        server.close(() => {
            console.log('[Shutdown] HTTP сервер закрыт.');
        });
        
        // 2. Прерываем активную рассылку, если она есть
        if (isBroadcasting) {
            console.log('[Shutdown] Обнаружена активная рассылка. Помечаю ее как прерванную...');
            await findAndInterruptActiveBroadcast();
        }
        
        // 3. Ждем завершения текущей задачи скачивания
        if (downloadQueue.active > 0) {
            console.log(`[Shutdown] Ожидаю завершения текущей задачи скачивания (макс. ${SHUTDOWN_TIMEOUT / 1000}с)...`);
            const waitForQueue = new Promise(resolve => {
                const interval = setInterval(() => {
                    if (downloadQueue.active === 0) {
                        clearInterval(interval);
                        resolve('queue_empty');
                    }
                }, 500);
            });
            const timeout = new Promise(resolve => setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT));
            await Promise.race([waitForQueue, timeout]);
        }
        
        // 4. Закрываем все соединения
        console.log('[Shutdown] Закрываю соединения с БД и Redis...');
        await Promise.allSettled([pool.end(), redisService.quit()]);
        
        // 5. Завершаем процесс
        console.log('[Shutdown] Завершение работы.');
        process.exit(0);
    };
    
    // Привязываем нашу единую функцию к системным сигналам
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
}

// index.js

function startBroadcastWorker() {
    console.log('[Broadcast Worker] Планировщик запущен.');
    
    // Возвращаем нормальный график: запускать каждую минуту
    cron.schedule('* * * * *', async () => {
        // Используем безопасную функцию для "захвата" задачи
        const task = await getAndStartPendingBroadcastTask();
        
        if (task) {
            setBroadcasting(true);
            try {
                console.log(`[Broadcast Worker] Найдена и заблокирована задача #${task.id}. Начинаю выполнение.`);
                let users = [];
                
                // Получаем список пользователей в зависимости от аудитории
                if (task.target_audience === 'all') {
                    users = await getAllUsers(true);
                } else if (task.target_audience === 'free_users') {
                    users = await getActiveFreeUsers();
                } else if (task.target_audience === 'premium_users') {
                    users = await getActivePremiumUsers();
                } else if (task.target_audience === 'preview') {
                    users = [{ id: ADMIN_ID, first_name: 'Admin' }];
                }
                
                const report = await runSingleBroadcast(task, users, task.id);
                await completeBroadcastTask(task.id, report);
                
            } catch (error) {
                console.error(`[Broadcast Worker] Критическая ошибка при выполнении задачи #${task.id}:`, error);
                await failBroadcastTask(task.id, error.message);
            } finally {
                // В любом случае (успех или ошибка) сбрасываем флаг
                setBroadcasting(false);
                console.log(`[Broadcast Worker] Выполнение задачи #${task.id} завершено.`);
            }
        }
    });
}

// Запускаем все приложение
startApp();