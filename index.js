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
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID; // ID приватного канала для кэширования

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
            WHERE url IS NOT NULL AND url LIKE '%soundcloud.com%' AND url NOT IN (SELECT soundcloud_url FROM track_cache)
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
        
        try {
            const message = await bot.telegram.sendAudio(
    STORAGE_CHANNEL_ID,
    { source: fs.createReadStream(tempFilePath) },
    { 
        caption: trackName,
        title: trackName // title важен для корректного имени файла при скачивании
    }
);

            if (message?.audio?.file_id) {
                await cacheTrack(url, message.audio.file_id, trackName);
                console.log(`✅ [Indexer] Успешно закэширован: ${trackName}`);
            }
        } catch(channelError) {
             console.error(`❌ [Indexer] Ошибка отправки аудио в канал ${STORAGE_CHANNEL_ID}:`, channelError.message);
        }

    } catch (err) {
        console.error(`❌ [Indexer] Ошибка при обработке ${url}:`, err.stderr || err.message);
    } finally {
        if (tempFilePath) await fs.promises.unlink(tempFilePath).catch(() => {});
    }
}

async function startIndexer() {
    console.log('🚀 Запуск фонового индексатора...');
    while (true) {
        const urls = await getUrlsToIndex();
        if (urls.length > 0) {
            console.log(`[Indexer] Найдено ${urls.length} треков для упреждающего кэширования.`);
            for (const url of urls) {
                await processUrlForIndexing(url);
                await new Promise(resolve => setTimeout(resolve, 30 * 1000));
            }
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
        const client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 10000 } });
        client.on('error', (err) => console.error('🔴 Ошибка Redis:', err));
        await client.connect();
        redisClient = client;
        console.log('✅ Redis подключён');

        const cacheDir = path.join(__dirname, 'cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

        setupExpress();
        setupTelegramBot();
        
        setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
        setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`), 60000);
        setInterval(() => cleanupCache(cacheDir, 60), 30 * 60 * 1000);
        cleanupCache(cacheDir, 60);

        if (process.env.NODE_ENV === 'production') {
            app.use(await bot.createWebhook({ domain: WEBHOOK_URL, path: WEBHOOK_PATH }));
            app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}.`));
        } else {
            await bot.launch();
            console.log('✅ Бот запущен в режиме long-polling.');
        }
        
        startIndexer().catch(err => console.error("🔴 Критическая ошибка в индексаторе:", err));

    } catch (err) {
        console.error('🔴 Критическая ошибка при запуске приложения:', err);
        process.exit(1);
    }
}

function setupExpress() {
    function convertObjToArray(dataObj) {
        if (!dataObj) return [];
        return Object.entries(dataObj).map(([date, count]) => ({ date, count }));
    }

    function filterStatsByPeriod(data, period) {
        if (!Array.isArray(data)) return [];
        const now = new Date();
        if (!isNaN(period)) {
            const days = parseInt(period);
            const cutoff = new Date(now.getTime() - days * 86400000);
            return data.filter(item => new Date(item.date) >= cutoff);
        }
        if (/^\d{4}-\d{2}$/.test(period)) {
            return data.filter(item => item.date && item.date.startsWith(period));
        }
        return data;
    }

    function prepareChartData(registrations, downloads, active) {
        const dateSet = new Set([...registrations.map(r => r.date), ...downloads.map(d => d.date), ...active.map(a => a.date)]);
        const dates = Array.from(dateSet).sort();
        const regMap = new Map(registrations.map(r => [r.date, r.count]));
        const dlMap = new Map(downloads.map(d => [d.date, d.count]));
        const actMap = new Map(active.map(a => [a.date, a.count]));
        return {
            labels: dates,
            datasets: [
                { label: 'Регистрации', data: dates.map(d => regMap.get(d) || 0), borderColor: 'rgba(75, 192, 192, 1)', fill: false },
                { label: 'Загрузки', data: dates.map(d => dlMap.get(d) || 0), borderColor: 'rgba(255, 99, 132, 1)', fill: false },
                { label: 'Активные пользователи', data: dates.map(d => actMap.get(d) || 0), borderColor: 'rgba(54, 162, 235, 1)', fill: false }
            ]
        };
    }

    function getLastMonths(count = 6) {
        const months = [];
        const now = new Date();
        for (let i = 0; i < count; i++) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push({ value: d.toISOString().slice(0, 7), label: d.toLocaleString('ru-RU', { month: 'long', year: 'numeric' }) });
        }
        return months;
    }

    function getFromToByPeriod(period) {
        const now = new Date();
        if (!period || period === 'all') return { from: new Date('2000-01-01'), to: now };
        if (/^\d+$/.test(period)) return { from: new Date(now.getTime() - parseInt(period) * 86400000), to: now };
        if (/^\d{4}-\d{2}$/.test(period)) {
            const [year, month] = period.split('-').map(Number);
            return { from: new Date(year, month - 1, 1), to: new Date(year, month, 0) };
        }
        throw new Error('Некорректный формат периода');
    }

    function computeActivityByHour(activityByDayHour) {
        const hours = Array(24).fill(0);
        for (const day in activityByDayHour) {
            const hoursData = activityByDayHour[day];
            if(hoursData) {
                for (let h = 0; h < 24; h++) {
                    hours[h] += hoursData[h] || 0;
                }
            }
        }
        return hours;
    }

    function computeActivityByWeekday(activityByDayHour) {
        const weekdays = Array(7).fill(0); // 0=Воскресенье
        for (const dayStr in activityByDayHour) {
            const dayTotal = Object.values(activityByDayHour[dayStr] || {}).reduce((a, b) => a + b, 0);
            weekdays[new Date(dayStr).getDay()] += dayTotal;
        }
        return weekdays;
    }
    
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
    
    app.get('/health', (req, res) => res.send('OK'));
    
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
    
    app.get('/api/queue-status', requireAuth, (req, res) => {
        res.json({ active: downloadQueue.active, size: downloadQueue.size });
    });

    app.get('/api/dashboard-data', requireAuth, async (req, res) => {
        try {
            const { period = '30' } = req.query;
            const users = await getAllUsers(true);
            const [
                downloadsByDateRaw, registrationsByDateRaw, activeByDateRaw, 
                activityByDayHour
            ] = await Promise.all([
                getDownloadsByDate(), getRegistrationsByDate(), getActiveUsersByDate(),
                getUserActivityByDayHour()
            ]);
            const filteredRegistrations = filterStatsByPeriod(convertObjToArray(registrationsByDateRaw), period);
            const filteredDownloads = filterStatsByPeriod(convertObjToArray(downloadsByDateRaw), period);
            const filteredActive = filterStatsByPeriod(convertObjToArray(activeByDateRaw), period);
    
            res.json({
                stats: {
                    totalUsers: users.length,
                    totalDownloads: users.reduce((sum, u) => sum + (u.total_downloads || 0), 0),
                    free: users.filter(u => u.premium_limit <= 10).length,
                    plus: users.filter(u => u.premium_limit > 10 && u.premium_limit <= 50).length,
                    pro: users.filter(u => u.premium_limit > 50 && u.premium_limit < 1000).length,
                    unlimited: users.filter(u => u.premium_limit >= 1000).length,
                },
                chartDataCombined: prepareChartData(filteredRegistrations, filteredDownloads, filteredActive),
                chartDataHourActivity: {
                    labels: [...Array(24).keys()].map(h => `${h}:00`),
                    datasets: [{ label: 'Активность по часам', data: computeActivityByHour(activityByDayHour), backgroundColor: 'rgba(54, 162, 235, 0.7)' }]
                },
                chartDataWeekdayActivity: {
                    labels: ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'],
                    datasets: [{ label: 'Активность по дням недели', data: computeActivityByWeekday(activityByDayHour), backgroundColor: 'rgba(255, 206, 86, 0.7)' }]
                },
            });
        } catch (e) {
            res.status(500).json({ error: 'Ошибка получения данных' });
        }
    });

    app.get('/api/users', requireAuth, async (req, res) => {
        try {
            const { showInactive = 'false', registrationDate } = req.query;
            let queryText = 'SELECT id, username, first_name, total_downloads, premium_limit, created_at, last_active, active, referral_source, promo_1plus1_used FROM users';
            const queryParams = [];
            const whereClauses = [];
            if (showInactive !== 'true') {
                whereClauses.push('active = TRUE');
            }
            if (registrationDate) {
                queryParams.push(registrationDate);
                whereClauses.push(`DATE(created_at) = $${queryParams.length}`);
            }
            if (whereClauses.length > 0) {
                queryText += ' WHERE ' + whereClauses.join(' AND ');
            }
            queryText += ' ORDER BY created_at DESC';
            const { rows } = await pool.query(queryText, queryParams);
            res.json(rows);
        } catch (e) {
            res.status(500).json({ error: 'Ошибка получения пользователей' });
        }
    });

    app.get('/dashboard', requireAuth, async (req, res) => {
        try {
            const { showInactive = 'false', period = '30', expiringLimit = '10', expiringOffset = '0' } = req.query;
            const [
                expiringSoon, expiringCount, referralStats, retentionResult, statsResult
            ] = await Promise.all([
                getExpiringUsersPaginated(parseInt(expiringLimit), parseInt(expiringOffset)),
                getExpiringUsersCount(),
                getReferralSourcesStats(),
                pool.query(`
                    WITH cohorts AS (SELECT id AS user_id, DATE(created_at) AS cohort_date FROM users WHERE created_at IS NOT NULL),
                    activities AS (SELECT DISTINCT user_id, DATE(downloaded_at) AS activity_day FROM downloads_log),
                    cohort_activity AS (SELECT c.cohort_date, a.activity_day, COUNT(DISTINCT c.user_id) AS active_users FROM cohorts c JOIN activities a ON c.user_id = a.user_id WHERE a.activity_day >= c.cohort_date GROUP BY c.cohort_date, a.activity_day),
                    cohort_sizes AS (SELECT cohort_date, COUNT(*) AS cohort_size FROM cohorts GROUP BY cohort_date)
                    SELECT ca.cohort_date, (ca.activity_day - ca.cohort_date) AS days_since_signup, ROUND((ca.active_users::decimal / cs.cohort_size) * 100, 2) AS retention_percent
                    FROM cohort_activity ca JOIN cohort_sizes cs ON ca.cohort_date = cs.cohort_date WHERE (ca.activity_day - ca.cohort_date) IN (0, 1, 3, 7, 14)
                    ORDER BY ca.cohort_date, days_since_signup;
                `),
                pool.query(`SELECT COUNT(*) as total FROM users`)
            ]);
            
            const funnelCounts = await getFunnelData(new Date('2000-01-01').toISOString(), new Date().toISOString());

            const cohortsMap = {};
            retentionResult.rows.forEach(row => {
                const date = new Date(row.cohort_date).toISOString().split('T')[0];
                if (!cohortsMap[date]) {
                    cohortsMap[date] = { label: date, data: { 0: null, 1: null, 3: null, 7: null, 14: null } };
                }
                cohortsMap[date].data[row.days_since_signup] = row.retention_percent;
            });
            const chartDataRetention = {
                labels: ['Day 0', 'Day 1', 'Day 3', 'Day 7', 'Day 14'],
                datasets: Object.values(cohortsMap).map(cohort => ({
                    label: cohort.label,
                    data: [cohort.data[0], cohort.data[1], cohort.data[3], cohort.data[7], cohort.data[14]],
                    fill: false,
                    borderColor: `hsl(${Math.random() * 360}, 70%, 60%)`,
                    tension: 0.1
                }))
            };

            res.render('dashboard', {
                title: 'Панель управления',
                page: 'dashboard',
                user: req.user,
                stats: { totalUsers: statsResult.rows[0].total, totalDownloads: '...', free: '...', plus: '...', pro: '...', unlimited: '...', activityByDayHour: {} },
                users: [],
                referralStats, expiringSoon, expiringCount, expiringOffset: parseInt(expiringOffset),
                expiringLimit: parseInt(expiringLimit), showInactive: showInactive === 'true',
                period, lastMonths: getLastMonths(6), funnelData: funnelCounts,
                chartDataCombined: { labels: [], datasets: [] },
                chartDataHourActivity: { labels: [], datasets: [] },
                chartDataWeekdayActivity: { labels: [], datasets: [] },
                chartDataFunnel: { labels: [], datasets: [] },
                chartDataRetention,
                chartDataHeatmap: {},
                chartDataUserFunnel: {},
                taskLogs: [],
            });
        } catch (e) {
            console.error('❌ Ошибка при загрузке dashboard:', e);
            res.status(500).send('Внутренняя ошибка сервера: ' + e.message);
        }
    });
    
    app.get('/user/:id', requireAuth, async (req, res) => {
        try {
            const userId = parseInt(req.params.id);
            if (isNaN(userId)) return res.status(400).send('Неверный ID');
            const user = await getUserById(userId);
            if (!user) return res.status(404).send('Пользователь не найден');
            const { data: downloads } = await supabase.from('downloads_log').select('*').eq('user_id', userId).order('downloaded_at', { ascending: false }).limit(100);
            const referralsResult = await pool.query('SELECT id, first_name, username, created_at FROM users WHERE referrer_id = $1', [userId]);
            res.render('user-profile', {
                title: `Профиль: ${user.first_name || user.username}`, user,
                downloads: downloads || [], referrals: referralsResult.rows, page: 'user-profile'
            });
        } catch (e) {
            res.status(500).send('Ошибка сервера');
        }
    });

    app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/admin')); });

    app.get('/broadcast', requireAuth, (req, res) => { res.render('broadcast-form', { title: 'Рассылка', error: null, success: null }); });

    app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res) => {
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
        if (audio) fs.unlinkSync(audio.path);
        try {
            await bot.telegram.sendMessage(ADMIN_ID, `📣 Рассылка: ✅ ${success} ❌ ${error}`);
        } catch (adminError) {
            console.error('Не удалось отправить отчет админу о рассылке:', adminError.message);
        }
        res.render('broadcast-form', { title: 'Рассылка', success, error });
    });
    
    app.get('/export', requireAuth, async (req, res) => {
        const users = await getAllUsers(true);
        const csv = await json2csv.json2csv(users, {});
        res.header('Content-Type', 'text/csv');
        res.attachment('users.csv');
        return res.send(csv);
    });

    app.get('/expiring-users', requireAuth, async (req, res) => {
        const page = parseInt(req.query.page) || 1;
        const perPage = 10;
        const total = await getExpiringUsersCount();
        const users = await getExpiringUsersPaginated(perPage, (page - 1) * perPage);
        res.render('expiring-users', { users, page, totalPages: Math.ceil(total / perPage), title: 'Истекающие подписки' });
    });
    
    app.post('/set-tariff', requireAuth, async (req, res) => {
        const { userId, limit, days } = req.body;
        await setPremium(userId, parseInt(limit), parseInt(days) || 30);
        res.redirect(req.get('referer') || '/dashboard');
    });
    
    app.post('/admin/reset-promo/:id', requireAuth, async (req, res) => {
        await updateUserField(req.params.id, 'promo_1plus1_used', false);
        res.redirect(req.get('referer') || '/dashboard');
    });
}

function setupTelegramBot() {
    // Вспомогательная функция для безопасной отправки сообщений
    const handleSendMessageError = async (error, userId) => {
        if (error.response?.error_code === 403) {
            console.log(`Пользователь ${userId} заблокировал бота. Отключаем его.`);
            await updateUserField(userId, 'active', false);
        } else {
            console.error(`Ошибка при отправке сообщения для ${userId}:`, error);
        }
    };

    const isSubscribed = async (userId) => {
        try {
            const res = await bot.telegram.getChatMember('@SCM_BLOG', userId);
            return ['member', 'creator', 'administrator'].includes(res.status);
        } catch { return false; }
    };

    const extractUrl = (text = '') => {
        const regex = /(https?:\/\/[^\s]+)/g;
        const matches = text.match(regex);
        return matches ? matches.find(url => url.includes('soundcloud.com')) : null;
    };

    function getTariffName(limit) {
        if (limit >= 1000) return 'Unlim (∞/день)';
        if (limit >= 100) return 'Pro (100/день)';
        if (limit >= 50) return 'Plus (50/день)';
        return 'Free (10/день)';
    }

    function getDaysLeft(premiumUntil) {
        if (!premiumUntil) return 0;
        const diff = new Date(premiumUntil) - new Date();
        return Math.max(Math.ceil(diff / 86400000), 0);
    }

    function formatMenuMessage(user, ctx) {
        const tariffLabel = getTariffName(user.premium_limit);
        const downloadsToday = user.downloads_today || 0;
        const invited = user.invited_count || 0;
        const bonusDays = user.bonus_days || 0;
        const refLink = `https://t.me/${ctx.botInfo.username}?start=${user.id}`;
        const daysLeft = getDaysLeft(user.premium_until);
        return `
👋 Привет, ${user.first_name}!

📥 Бот качает треки и плейлисты с SoundCloud в MP3.  
Просто пришли ссылку — и всё 🧙‍♂️

📣 Хочешь быть в курсе новостей, фишек и бонусов?  
Подпишись на наш канал 👉 @SCM_BLOG

🔄 При отправке ссылки ты увидишь свою позицию в очереди.  
🎯 Платные тарифы идут с приоритетом — их треки загружаются первыми.  
📥 Бесплатные пользователи тоже получают треки — просто чуть позже.

💼 Тариф: ${tariffLabel}  
⏳ Осталось дней: ${daysLeft}

🎧 Сегодня скачано: ${downloadsToday} из ${user.premium_limit}

👫 Приглашено: ${invited}  
🎁 Получено дней Plus по рефералам: ${bonusDays}

🔗 Твоя реферальная ссылка:  
${refLink}
  `.trim();
    }

    bot.use(async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId) return next();
        try {
            let user = await getUser(userId, ctx.from.first_name, ctx.from.username);
            ctx.state.user = user;
        } catch (error) { console.error(`Ошибка в мидлваре для userId ${userId}:`, error); }
        return next();
    });

    bot.start(async (ctx) => {
        try {
            await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.startPayload || null);
            const fullUser = await getUser(ctx.from.id);
            await ctx.reply(formatMenuMessage(fullUser, ctx), kb());
        } catch (e) {
            await handleSendMessageError(e, ctx.from.id);
        }
    });

    bot.hears(texts.menu, async (ctx) => {
        try {
            const user = await getUser(ctx.from.id);
            await ctx.reply(formatMenuMessage(user, ctx), kb());
        } catch (e) {
            await handleSendMessageError(e, ctx.from.id);
        }
    });

    bot.hears(texts.mytracks, async (ctx) => {
        try {
            const user = await getUser(ctx.from.id);
            let tracks = [];
            try { if (user.tracks_today) tracks = JSON.parse(user.tracks_today); } catch {}
            if (!tracks.length) {
                await ctx.reply(texts.noTracks);
                return;
            }
            for (let i = 0; i < tracks.length; i += 10) {
                const chunk = tracks.slice(i, i + 10).filter(t => t.fileId);
                if (chunk.length > 0) {
                    await ctx.replyWithMediaGroup(chunk.map(t => ({ type: 'audio', media: t.fileId })));
                }
            }
        } catch (e) {
            await handleSendMessageError(e, ctx.from.id);
        }
    });

    bot.hears(texts.help, async (ctx) => {
        try {
            await ctx.reply(texts.helpInfo, kb());
        } catch (e) {
            await handleSendMessageError(e, ctx.from.id);
        }
    });

    bot.hears(texts.upgrade, async (ctx) => {
        try {
            await ctx.reply(texts.upgradeInfo, kb());
        } catch (e) {
            await handleSendMessageError(e, ctx.from.id);
        }
    });

    bot.command('admin', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) {
            return;
        }
        try {
            const users = await getAllUsers(true);
            const totalUsers = users.length;
            const activeUsers = users.filter(u => u.active).length;
            const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
            const now = new Date();
            const activeToday = users.filter(u => u.last_active && new Date(u.last_active).toDateString() === now.toDateString()).length;
            
            const statsMessage = `
📊 **Статистика Бота**

👤 **Пользователи:**
   - Всего: *${totalUsers}*
   - Активных (в целом): *${activeUsers}*
   - Активных сегодня: *${activeToday}*

📥 **Загрузки:**
   - Всего за все время: *${totalDownloads}*

⚙️ **Очередь сейчас:**
   - В работе: *${downloadQueue.active}*
   - В ожидании: *${downloadQueue.size}*

🔗 **Админ-панель:**
[Открыть дашборд](${WEBHOOK_URL.replace(/\/$/, '')}/dashboard)
            `.trim();
            
            await ctx.reply(statsMessage, { parse_mode: 'Markdown' });
        } catch (e) {
            console.error('❌ Ошибка в команде /admin:', e);
            try { await ctx.reply('⚠️ Произошла ошибка при получении статистики.'); } catch (adminBlockError) { console.log('Админ заблокировал бота.'); }
        }
    });

    bot.action('check_subscription', async (ctx) => {
        try {
            if (await isSubscribed(ctx.from.id)) {
                await setPremium(ctx.from.id, 50, 7);
                await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
                await ctx.reply('Поздравляю! Тебе начислен бонус: 7 дней Plus.');
            } else {
                await ctx.reply('Пожалуйста, подпишись на канал @SCM_BLOG и нажми кнопку ещё раз.');
            }
        } catch (e) {
            await handleSendMessageError(e, ctx.from.id);
        }
        try { await ctx.answerCbQuery(); } catch (cbError) { console.error('Не удалось ответить на callback-запрос:', cbError.message); }
    });

    bot.on('text', async (ctx) => {
        try {
            const url = extractUrl(ctx.message.text);
            if (url) {
                await enqueue(ctx, ctx.from.id, url);
            } else {
                if (!Object.values(texts).includes(ctx.message.text)) {
                    await ctx.reply('Пожалуйста, пришлите ссылку на трек или плейлист.');
                }
            }
        } catch (e) {
            await handleSendMessageError(e, ctx.from.id);
        }
    });
}

// === ЗАПУСК ПРИЛОЖЕНИЯ ===

const stopBot = (signal) => {
    console.log(`Получен сигнал ${signal}. Завершение работы...`);
    if (bot.polling?.isRunning()) {
        bot.stop(signal);
    }
    setTimeout(() => process.exit(0), 500);
};

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));

startApp();

export { app, bot, startApp };
