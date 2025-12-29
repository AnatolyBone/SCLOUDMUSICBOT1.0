
// index.js (продакшен-вебхук с диагностикой, быстрый дашборд, /tmp для загрузок, Referer)

import express from 'express';
import session from 'express-session';
import compression from 'compression';
import path from 'path';
import multer from 'multer';
import expressLayouts from 'express-ejs-layouts';
import { fileURLToPath } from 'url';
import pgSessionFactory from 'connect-pg-simple';
import fs from 'fs';
import os from 'os';
import mime from 'mime-types';
import { checkAndSendExpirationNotifications, notifyExpiringTodayHourly } from './services/notifier.js';
import { loadSettings,getAllSettings} from './services/settingsManager.js';
import {
  pool,
  getUserById,
  resetDailyStats,
  getUserUniqueDownloadedUrls,
  fixBadCacheForUser,
  getPaginatedUsers,
  getExpiringUsers,
  setPremium,
  updateUserField,
  getDownloadsByUserId,
  getReferralsByUserId,
  getCachedTracksCount,
  getUsersCountByTariff,
  getTopReferralSources,
  getDailyStats,
  getActivityByWeekday,
  getTopTracks,
  getTopUsers,
  getHourlyActivity,
  getUsersAsCsv,
  getUserActions,
  logUserAction,
  createBroadcastTask,
  getAllBroadcastTasks,
  deleteBroadcastTask,
  getBroadcastTaskById,
  updateBroadcastTask,
  getReferrerInfo,
  getReferredUsers,
  getReferralStats,
  resetOtherTariffsToFree,
  resetExpiredPremiumsBulk,
  getUsersTotalsSnapshot,
  setTariffAdmin,
  logBrokenTrack, 
  getBrokenTracks, 
  resolveBrokenTrack,
  deleteCachedTrack,
  getBrokenTracksWithPagination,
  deleteBrokenTrack,
  deleteBrokenTracksBulk,
  incrementBrokenTrackRetry,
  setAppSetting,
  getNewUsersCount
} from './db.js';
import { initializeWorkers } from './services/workerManager.js';
import { runBroadcastBatch } from './services/broadcastManager.js';
import { isShuttingDown, setShuttingDown, setMaintenanceMode, isMaintenanceMode } from './services/appState.js';
import { bot } from './bot.js';
import redisService from './services/redisClient.js';
import {
  WEBHOOK_URL, PORT, SESSION_SECRET, ADMIN_ID, ADMIN_LOGIN, ADMIN_PASSWORD,
  WEBHOOK_PATH, STORAGE_CHANNEL_ID, BROADCAST_STORAGE_ID
} from './config.js';
import { loadTexts, setText, getEditableTexts } from './config/texts.js';
import { downloadQueue, initializeDownloadManager } from './services/downloadManager.js';

const app = express();

// Храним временные файлы в /tmp (на Render быстрее)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dest = path.join(os.tmpdir(), 'uploads');
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 49 * 1024 * 1024 } });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// index.js -> startApp()

async function startApp() {
  setMaintenanceMode(false);
  console.log('[App] Запуск приложения...');
  const forcePolling = process.env.FORCE_POLLING === '1';
  
  setMaintenanceMode(false);
  console.log('[App] Запуск приложения...');
  try {
    // Запускаем сервер и настраиваем Express СРАЗУ, чтобы Render.com определил порт
    const server = app.listen(PORT, () => console.log(`✅ [App] Сервер запущен на порту ${PORT}.`));
    setupExpress();
    
    // Остальная инициализация
    await loadTexts(true);
    await redisService.connect();
await loadSettings();
    
    await initializeDownloadManager();
    
    let lastUpdateTs = Date.now();
    bot.use((ctx, next) => { lastUpdateTs = Date.now(); return next(); });
    
    downloadQueue.start();
    console.log('[App] Очередь скачивания принудительно запущена.');
    
    let EXPECTED_WEBHOOK = null;
    
    if (process.env.NODE_ENV === 'production' && !forcePolling) {
      const fullBase = WEBHOOK_URL.endsWith('/') ? WEBHOOK_URL.slice(0, -1) : WEBHOOK_URL;
      const fullWebhookUrl = fullBase + WEBHOOK_PATH;
      const allowedUpdates = ['message', 'callback_query', 'inline_query'];
      
      // Retry-логика для вебхука
      for (let i = 0; i < 3; i++) {
        try {
          console.log(`[App] Попытка ${i + 1}/3: устанавливаю вебхук...`);
          await bot.telegram.setWebhook(fullWebhookUrl, {
            drop_pending_updates: true,
            allowed_updates: allowedUpdates
          });
          console.log('[App] ✅ Вебхук успешно настроен.');
          break; // Успех, выходим из цикла
        } catch (e) {
          console.error(`[App] ❌ Ошибка установки вебхука (попытка ${i + 1}):`, e.message);
          if (i < 2) {
            await new Promise(r => setTimeout(r, 5000)); // Ждём 5 секунд
          } else {
            throw new Error('Не удалось установить вебхук после 3 попыток.'); // Все попытки провалились
          }
        }
      }
      
      EXPECTED_WEBHOOK = fullWebhookUrl;
      
      // Логируем состояние вебхука
      try {
        const info = await bot.telegram.getWebhookInfo();
        console.log('[WebhookInfo]', JSON.stringify(info, null, 2));
      } catch (e) {
        console.warn('[WebhookInfo] Ошибка получения информации:', e.message);
      }
      
      // Маршрут вебхука
      app.post(
        WEBHOOK_PATH,
        express.json({ limit: '1mb' }),
        (req, res, next) => {
          try {
            const u = req.body || {};
            const type =
              u.message ? 'message' :
              u.callback_query ? 'callback_query' :
              u.inline_query ? 'inline_query' :
              Object.keys(u).filter(k => k !== 'update_id')[0] || 'unknown';
            console.log(`[Webhook] Update ${u.update_id || '-'} type=${type}`);
          } catch {}
          next();
        },
        bot.webhookCallback(WEBHOOK_PATH)
      );
      
    } else {
      // Режим long-polling (для разработки)
      console.log('[App] Запуск бота в режиме long-polling...');
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      bot.launch({
        allowedUpdates: ['message', 'callback_query', 'inline_query']
      });
    }
    
    // Диагностический роут для просмотра состояния вебхука
    app.get('/debug/webhook', async (req, res) => {
      try {
        const info = await bot.telegram.getWebhookInfo();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(info, null, 2));
      } catch (e) {
        res.status(500).send(e.message);
      }
    });
    
    // Инициализируем воркеры и фоновые задачи
    initializeWorkers(server, bot);
    
    console.log('[App] Настройка фоновых задач...');
    setInterval(() => {
      checkAndSendExpirationNotifications(bot).catch(e => {
        console.error('[Cron] Ошибка дневного нотификатора:', e.message);
      });
    }, 60000);
    
    setInterval(() => {
      notifyExpiringTodayHourly(bot).catch(e => {
        console.error('[Cron] Ошибка почасового нотификатора:', e.message);
      });
    }, 3600000);
    
    console.log('[App] Нотификаторы истечения подписок запущены.');
    
    setInterval(async () => {
      try { await resetDailyStats(); } catch (e) { console.error('[Cron] resetDailyStats error:', e.message); }
    }, 24 * 3600 * 1000);
    
    setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.pending} в работе.`), 60000);
    
    // Watchdog вебхука
    if (EXPECTED_WEBHOOK) {
      setInterval(async () => {
        try {
          const info = await bot.telegram.getWebhookInfo();
          const hasError = Boolean(info.last_error_date);
          const urlMismatch = info.url !== EXPECTED_WEBHOOK;
          if (hasError || urlMismatch) {
            console.warn('[WebhookWatch] Проблема с вебхуком:', {
              currentUrl: info.url,
              last_error_message: info.last_error_message,
              last_error_date: info.last_error_date
            });
            await bot.telegram.setWebhook(EXPECTED_WEBHOOK);
            console.log('[WebhookWatch] Вебхук переустановлен.');
          }
        } catch (e) {
          console.error('[WebhookWatch] Ошибка проверки вебхука:', e.message);
        }
      }, 10 * 60 * 1000);
      
      setInterval(async () => {
        if (Date.now() - lastUpdateTs > 15 * 60 * 1000) {
          console.warn('[WebhookWatch] Давно не было апдейтов, переустанавливаю вебхук...');
          try { await bot.telegram.setWebhook(EXPECTED_WEBHOOK); } catch (e) {}
          lastUpdateTs = Date.now();
        }
      }, 5 * 60 * 1000);
    }
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
  app.set('trust proxy', 1);
  app.use(compression({ threshold: 1024 }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/static', express.static(path.join(__dirname, 'public'), {
    maxAge: '1h',
    etag: true,
    immutable: true
  }));

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
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production'
    }
  }));

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

app.get('/health', async (req, res) => {
  try {
    const redisAvailable = await redisService.isAvailable();
    // Добавляем проверку, чтобы не крашилось, если pool не определен
    const dbAvailable = pool ? await pool.query('SELECT 1').then(() => true).catch(() => false) : false;
    
    const health = {
      status: 'ok', // Всегда пишем ok для Render
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      services: {
        redis: redisAvailable ? '✅' : '⚠️ (Disabled)', // Помечаем как отключенный, а не ошибку
        database: dbAvailable ? '✅' : '❌',
        downloadQueue: (downloadQueue && downloadQueue.size > 0) ? `⏳ ${downloadQueue.size} в очереди` : '✅'
      }
    };
    
    // ИЗМЕНЕНИЕ ЗДЕСЬ:
    // Render требует статус 200 для прохождения проверки.
    // Мы отправляем 200, даже если Redis выключен, так как бот работает и без него.
    res.status(200).json(health);

  } catch (e) {
    // А вот если произошел реальный сбой (ошибка в коде), тогда 500
    console.error('Health check failed:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});
  app.get('/', requireAuth, (req, res) => res.redirect('/dashboard'));

// === УПРАВЛЕНИЕ ПРОБЛЕМНЫМИ ТРЕКАМИ ===

// Страница списка с пагинацией
app.get('/broken-tracks', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 25;
    
    const result = await getBrokenTracksWithPagination({ page, limit });
    console.log('[BrokenTracks] Загружено:', result.totalTracks, 'треков');
    
    res.render('broken-tracks', { 
      title: 'Проблемные треки', 
      page: 'broken-tracks',
      tracks: result.tracks || [],
      totalTracks: result.totalTracks || 0,
      totalPages: result.totalPages || 0,
      currentPage: result.currentPage || 1
    });
  } catch (e) {
    console.error('[BrokenTracks] Ошибка загрузки:', e);
    res.status(500).send('Ошибка сервера');
  }
});

// Действие: Исправить (форма)
app.post('/broken-tracks/fix', requireAuth, async (req, res) => {
  const { id, url } = req.body;
  try {
    if (url) await deleteCachedTrack(url);
    await resolveBrokenTrack(id);
    res.redirect('/broken-tracks');
  } catch (e) {
    console.error('[BrokenTracks] Ошибка fix:', e);
    res.status(500).send('Ошибка при исправлении');
  }
});

// API: Пометить исправленным
app.post('/api/broken-tracks/fix', requireAuth, async (req, res) => {
  try {
    const { id, url } = req.body;
    if (url) await deleteCachedTrack(url);
    await resolveBrokenTrack(id);
    res.json({ success: true });
  } catch (e) {
    console.error('[API BrokenTracks] fix error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Повторить загрузку (сбросить кэш)
app.post('/api/broken-tracks/retry', requireAuth, async (req, res) => {
  try {
    const { id, url } = req.body;
    
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL не указан' });
    }
    
    // Увеличиваем счетчик попыток
    await incrementBrokenTrackRetry(id);
    
    // Удаляем старый кэш
    await deleteCachedTrack(url);
    
    // Помечаем как исправленное
    await resolveBrokenTrack(id);
    
    res.json({ 
      success: true, 
      message: 'Кэш сброшен. Трек будет скачан заново при следующем запросе.' 
    });
  } catch (e) {
    console.error('[API BrokenTracks] retry error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Удалить одну запись
app.delete('/api/broken-tracks/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await deleteBrokenTrack(parseInt(id));
    res.json({ success: true });
  } catch (e) {
    console.error('[API BrokenTracks] delete error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Массовое удаление
app.post('/api/broken-tracks/bulk-delete', requireAuth, async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Не выбраны записи' });
    }
    
    const count = await deleteBrokenTracksBulk(ids.map(id => parseInt(id)));
    res.json({ success: true, deleted: count });
  } catch (e) {
    console.error('[API BrokenTracks] bulk-delete error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Исправить и отправить пользователю
app.post('/api/broken-tracks/fix-and-send', requireAuth, async (req, res) => {
  try {
    const { id, url, userId } = req.body;
    
    if (!url || !userId) {
      return res.status(400).json({ success: false, error: 'URL или userId не указаны' });
    }
    
    // Импортируем функцию скачивания
    const { downloadTrackForUser } = await import('./services/downloadManager.js');
    
    // Скачиваем и отправляем
    await downloadTrackForUser(url, parseInt(userId));
    
    // Помечаем как исправленное
    await resolveBrokenTrack(id);
    
    res.json({ 
      success: true, 
      message: 'Трек скачан и отправлен пользователю!' 
    });
  } catch (e) {
    console.error('[API BrokenTracks] fix-and-send error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});
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
app.post('/admin/queue/clear', requireAuth, (req, res) => {
  const count = downloadQueue.clear();
  console.log(`[Admin] Очередь полностью очищена, удалено ${count} задач.`);
  // Можно добавить flash-сообщение об успехе
  res.redirect('back');
});

// Очистка очереди для конкретного пользователя
app.post('/admin/queue/clear-user', requireAuth, (req, res) => {
  const { userId } = req.body;
  if (userId) {
    const count = downloadQueue.clearUser(userId);
    console.log(`[Admin] Очищена очередь для пользователя ${userId}, удалено ${count} задач.`);
  }
  res.redirect('back');
});

// API: Получение статистики очередей по источникам
app.get('/admin/api/queue/stats', requireAuth, (req, res) => {
  try {
    const stats = downloadQueue.getStatsBySource();
    res.json({
      success: true,
      stats: {
        spotify: stats.spotify,
        youtube: stats.youtube,
        soundcloud: stats.soundcloud,
        other: stats.other,
        total: {
          waiting: stats.spotify.waiting + stats.youtube.waiting + stats.soundcloud.waiting + stats.other.waiting,
          active: stats.spotify.active + stats.youtube.active + stats.soundcloud.active + stats.other.active
        }
      }
    });
  } catch (error) {
    console.error('[Admin API] Ошибка получения статистики очередей:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Очистка очереди по источнику
app.post('/admin/queue/clear/:source', requireAuth, (req, res) => {
  const { source } = req.params;
  const validSources = ['spotify', 'youtube', 'soundcloud', 'other'];
  
  if (!validSources.includes(source)) {
    return res.status(400).json({ success: false, error: 'Неверный источник' });
  }
  
  try {
    const count = downloadQueue.clearBySource(source);
    console.log(`[Admin] Очищена очередь для источника ${source}, удалено ${count} задач.`);
    res.redirect('back');
  } catch (error) {
    console.error(`[Admin] Ошибка очистки очереди для ${source}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.get('/settings', requireAuth, (req, res) => {
  res.render('settings', {
    title: 'Настройки',
    page: 'settings',
    settings: getAllSettings(),
    success: req.query.success,
    maintenanceMode: isMaintenanceMode(),
    queueWaiting: downloadQueue?.waiting || 0,
    queueActive: downloadQueue?.active || 0
  });
});

app.post('/settings/maintenance', requireAuth, (req, res) => {
  const enabled = req.body.enabled === 'on';
  setMaintenanceMode(enabled);
  console.log(`[Settings] Режим обслуживания: ${enabled ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН'}`);
  res.redirect('/settings?success=1');
});

app.post('/settings/update', requireAuth, async (req, res) => {
  try {
    console.log('[Settings/Update] Получены данные:', JSON.stringify(req.body, null, 2));
    
    // 1. Сохраняем настройки
    for (const [key, value] of Object.entries(req.body)) {
      console.log(`[Settings/Update] Сохраняю: ${key} = ${value}`);
      await setAppSetting(key, value);
    }
    
    await loadSettings(); // Обновляем кеш
    console.log('[Settings/Update] ✅ Настройки сохранены и кеш обновлён');

    // 2. Запускаем фоновое обновление (без await, чтобы не ждать)
    applyLimitsToUsers(req.body).catch(err => {
        console.error('❌ Ошибка в фоновом обновлении лимитов:', err);
    });

    res.redirect('/settings?success=true');
  } catch (e) {
    console.error('Ошибка сохранения настроек:', e);
    res.status(500).send('Ошибка сохранения настроек');
  }
});

// === ОТДЕЛЬНАЯ ФУНКЦИЯ ДЛЯ МАССОВОГО ОБНОВЛЕНИЯ ===
async function applyLimitsToUsers(body) {
    const { playlist_limit_free, playlist_limit_plus, playlist_limit_pro } = body;

    console.log('🔄 Начинаю фоновое обновление лимитов...');
    const start = Date.now();

    // ВАЖНО: Используем pool.query, а не db.query

    // 1. Free
    if (playlist_limit_free) {
        const newLimit = parseInt(playlist_limit_free, 10);
        await pool.query(`ALTER TABLE users ALTER COLUMN premium_limit SET DEFAULT ${newLimit}`);
        await pool.query(`
            UPDATE users 
            SET premium_limit = $1 
            WHERE (premium_limit <= 10 OR premium_limit IS NULL) 
              AND (premium_until IS NULL OR premium_until < NOW())
        `, [newLimit]);
    }

    // 2. Plus
    if (playlist_limit_plus) {
        await pool.query(`
            UPDATE users SET premium_limit = $1 
            WHERE premium_limit = 30 AND premium_until > NOW()
        `, [parseInt(playlist_limit_plus, 10)]);
    }

    // 3. Pro
    if (playlist_limit_pro) {
        await pool.query(`
            UPDATE users SET premium_limit = $1 
            WHERE premium_limit = 100 AND premium_until > NOW()
        `, [parseInt(playlist_limit_pro, 10)]);
    }

    const duration = (Date.now() - start) / 1000;
    console.log(`✅ Лимиты обновлены. Заняло: ${duration} сек.`);
}

// ==================================================================
// ДАШБОРД
// ==================================================================
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

    // Получаем даты из запроса (или undefined)
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    const [
      totals,
      cachedTracksCount,
      topSources,
      dailyStats,
      weekdayActivity,
      topTracks,
      topUsers,
      hourlyActivity,
      referralStats,
      tariffsActiveResult,
      othersResult,
      expiredCountResult
    ] = await Promise.all([
      getUsersTotalsSnapshot(),
      getCachedTracksCount(),
      getTopReferralSources(),
      getDailyStats({ startDate, endDate }),
      
      // 👇 ИСПРАВЛЕНО: Передаем даты в графики
      getActivityByWeekday(startDate, endDate),
      
      getTopTracks(),
      getTopUsers(),
      
      // 👇 ИСПРАВЛЕНО: Передаем даты в графики
      getHourlyActivity(startDate, endDate),
      
      getReferralStats(),
      
      // Активные тарифы
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE premium_limit = 5) AS free,
          COUNT(*) FILTER (WHERE premium_limit BETWEEN 6 AND 30 AND (premium_until IS NULL OR premium_until >= NOW())) AS plus,
          COUNT(*) FILTER (WHERE premium_limit BETWEEN 31 AND 100 AND (premium_until IS NULL OR premium_until >= NOW())) AS pro,
          COUNT(*) FILTER (WHERE premium_limit > 100 AND (premium_until IS NULL OR premium_until >= NOW())) AS unlimited
        FROM users
      `),
      // Другие
      pool.query(`
        SELECT COUNT(*)::int AS other
        FROM users
        WHERE premium_limit IS NULL
           OR (
             premium_limit <> 5
             AND NOT (premium_limit BETWEEN 6 AND 30)
             AND NOT (premium_limit BETWEEN 31 AND 100)
             AND NOT (premium_limit > 100)
           )
      `),
      // Истёкшие
      pool.query(`
        SELECT COUNT(*)::int AS expired_count
        FROM users
        WHERE premium_until IS NOT NULL
          AND premium_until < NOW()
          AND premium_limit <> 5
      `)
    ]);

    const expiredCount = Number(expiredCountResult?.rows?.[0]?.expired_count ?? 0);
    const t = tariffsActiveResult?.rows?.[0] || {};
    const othersCount = Number(othersResult?.rows?.[0]?.other ?? 0);

    const usersByTariff = {
      Free: Number(t.free || 0),
      Plus: Number(t.plus || 0),
      Pro: Number(t.pro || 0),
      Unlimited: Number(t.unlimited || 0),
      Other: othersCount
    };

    // Получаем статистику очередей по источникам
    const queueStatsBySource = downloadQueue.getStatsBySource();

    const stats = {
      total_users: totals.total_users,
      active_users: totals.active_users,
      total_downloads: Number(totals.total_downloads) || 0,
      active_today: totals.active_today,
      queueWaiting: downloadQueue.size,
      queueActive: downloadQueue.pending,
      queueStatsBySource, // Добавляем детализированную статистику по источникам
      cachedTracksCount: cachedTracksCount,
      usersByTariff,
      topSources: topSources || [],
      totalReferred: referralStats.totalReferred,
      topReferrers: referralStats.topReferrers
    };

    // Формируем данные для графика с разделением по сервисам
    const sourceColors = {
      spotify: '#1DB954',    // Зелёный Spotify
      youtube: '#FF0000',    // Красный YouTube
      soundcloud: '#FF5500', // Оранжевый SoundCloud
      other: '#6c757d'       // Серый для других
    };
    
    const sourceLabels = {
      spotify: '🎵 Spotify',
      youtube: '▶️ YouTube',
      soundcloud: '☁️ SoundCloud',
      other: '📦 Другие'
    };
    
    // Собираем данные по сервисам
    const sourceData = {};
    const allSources = ['spotify', 'youtube', 'soundcloud', 'other'];
    
    // Инициализируем массивы для всех источников
    allSources.forEach(source => {
      sourceData[source] = [];
    });
    
    (dailyStats || []).forEach(d => {
      let downloadsBySource = {};
      try {
        if (d.downloads_by_source) {
          downloadsBySource = typeof d.downloads_by_source === 'string' 
            ? JSON.parse(d.downloads_by_source || '{}') 
            : (d.downloads_by_source || {});
        }
      } catch (e) {
        console.error('[Chart] Ошибка парсинга downloads_by_source:', e.message);
        downloadsBySource = {};
      }
      
      // Заполняем данные для каждого источника (0 если нет данных)
      allSources.forEach(source => {
        sourceData[source].push(parseInt(downloadsBySource[source] || 0, 10));
      });
    });
    
    // Создаём датасеты для каждого сервиса
    const sourceDatasets = Object.keys(sourceData).map(source => ({
      label: sourceLabels[source] || source,
      data: sourceData[source],
      borderColor: sourceColors[source] || sourceColors.other,
      backgroundColor: sourceColors[source] || sourceColors.other,
      tension: 0.1,
      fill: false
    }));
    
    const chartDataCombined = {
      labels: (dailyStats || []).map(d => new Date(d.day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })),
      datasets: [
        { label: '👥 Регистрации', data: (dailyStats || []).map(d => d.registrations), borderColor: '#198754', tension: 0.1, fill: false, borderDash: [5, 5] },
        { label: '👤 Активные юзеры', data: (dailyStats || []).map(d => d.active_users), borderColor: '#0d6efd', tension: 0.1, fill: false, borderDash: [5, 5] },
        ...sourceDatasets // Добавляем линии для каждого сервиса
      ]
    };

    const chartDataTariffs = {
      labels: ['Free', 'Plus', 'Pro', 'Unlimited', 'Other'],
      datasets: [{
        data: [usersByTariff.Free, usersByTariff.Plus, usersByTariff.Pro, usersByTariff.Unlimited, usersByTariff.Other],
        backgroundColor: ['#6c757d', '#17a2b8', '#ffc107', '#007bff', '#dc3545']
      }]
    };

    const chartDataWeekday = {
      labels: (weekdayActivity || []).map(d => (d.weekday || '').toString().trim()),
      datasets: [{
        label: 'Активные пользователи',
        data: (weekdayActivity || []).map(d => d.count),
        backgroundColor: 'rgba(13, 110, 253, 0.5)'
      }]
    };
    
    const chartDataHourly = {
      labels: Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, '0')}:00`),
      datasets: [{
        label: 'Активность',
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
      resetOthers: req.query.resetOthers || null,
      resetExpired: req.query.resetExpired || null,
      chartDataCombined,
      chartDataTariffs,
      chartDataWeekday,
      chartDataHourly,
      topTracks,
      topUsers,
      expiredCount
    });

  } catch (error) {
    console.error('Ошибка дашборда:', error);
    res.status(500).send('Ошибка сервера');
  }
});

  app.get('/users', requireAuth, async (req, res) => {
    try {
      const { q = '', status = '', page = 1, limit = 25, sort = 'created_at', order = 'desc' } = req.query;
      const { users, totalPages, totalUsers } = await getPaginatedUsers({
        searchQuery: q, statusFilter: status, page: parseInt(page), limit: parseInt(limit), sortBy: sort, sortOrder: order
      });
      const queryParams = { q, status, page, limit, sort, order };
      
      // Статистика для карточек
      let activeUsers = 0, premiumUsers = 0, newUsersToday = 0;
      try {
        const [activeUsersRes, premiumUsersRes, newUsersTodayRes] = await Promise.all([
          pool.query('SELECT COUNT(*) FROM users WHERE active = true'),
          pool.query('SELECT COUNT(*) FROM users WHERE premium_until > NOW()'),
          getNewUsersCount(1)
        ]);
        activeUsers = parseInt(activeUsersRes.rows[0]?.count || 0);
        premiumUsers = parseInt(premiumUsersRes.rows[0]?.count || 0);
        newUsersToday = newUsersTodayRes || 0;
      } catch (statsErr) {
        console.error('[Users] Ошибка получения статистики:', statsErr.message);
      }
      
      res.render('users', { 
        title: 'Пользователи', 
        page: 'users', 
        users, 
        totalUsers, 
        totalPages, 
        currentPage: parseInt(page), 
        limit: parseInt(limit), 
        searchQuery: q, 
        statusFilter: status, 
        queryParams,
        activeUsers,
        premiumUsers,
        newUsersToday
      });
    } catch (error) {
      console.error('Ошибка на странице пользователей:', error);
      res.status(500).send('Ошибка сервера');
    }
  });

  app.get('/users/export.csv', requireAuth, async (req, res) => {
  try {
    const {
      q = '',
        status = '',
        tariff = '',
        premium = '',
        created_from = '',
        created_to = '',
        active_within_days = '',
        has_referrer = '',
        ref_source = '',
        downloads_min = ''
    } = req.query;
    
    const csvData = await getUsersAsCsv({
      searchQuery: q,
      statusFilter: status,
      tariff,
      premium,
      created_from,
      created_to,
      active_within_days,
      has_referrer,
      ref_source,
      downloads_min
    });
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="users_${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.send(csvData);
  } catch (error) {
    console.error('Ошибка при экспорте пользователей:', error);
    res.status(500).send('Не удалось сгенерировать CSV-файл');
  }
});
    app.get('/users-table', requireAuth, async (req, res) => {
    try {
      const { q = '', status = '', page = 1, limit = 25, sort = 'created_at', order = 'desc' } = req.query;
      
      // ✅ ДОБАВЛЕНО totalUsers сюда
      const { users, totalPages, totalUsers } = await getPaginatedUsers({
        searchQuery: q, statusFilter: status, page: parseInt(page), limit: parseInt(limit), sortBy: sort, sortOrder: order
      });
      
      const queryParams = { q, status, page, limit, sort, order };
      res.render('partials/users-table', { users, totalPages, totalUsers, currentPage: parseInt(page), queryParams, layout: false });
    } catch (error) {
      console.error('Ошибка при обновлении таблицы:', error);
      res.status(500).send('Ошибка сервера');
    }
  });

app.get('/user/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.params.id;
        
        // Теперь мы запрашиваем 5 порций данных параллельно, включая реферера
        const [
            userProfile,
            downloads,
            actions,
            referrer, // <-- КТО пригласил ЭТОГО пользователя
            referredUsers // <-- КОГО пригласил ЭТОТ пользователь
        ] = await Promise.all([
            getUserById(userId),
            getDownloadsByUserId(userId),
            getUserActions(userId),
            getReferrerInfo(userId), // <-- Используем нашу новую функцию
            getReferredUsers(userId) // <-- Эта функция у тебя уже должна быть
        ]);
        
        if (!userProfile) {
            return res.status(404).send("Пользователь не найден");
        }
        
        // Передаем все данные в шаблон для отрисовки
        res.render('user-profile', {
            title: `Профиль: ${userProfile.first_name || userId}`,
            page: 'users',
            userProfile,
            downloads,
            actions,
            referrer, // <-- Передаем реферера в шаблон
            referredUsers
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
// Диагностический эндпоинт для просмотра состояния приложения
app.get('/debug/state', requireAuth, async (req, res) => {
  const state = getAppState(); // Импортируй из appState.js
  res.json({
    ...state,
    queueSize: downloadQueue.size,
    queuePending: downloadQueue.pending,
    uptime: process.uptime()
  });
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
    res.render('broadcast-form', { title: 'Редактировать рассылку', page: 'broadcasts', task: { ...task, buttons_text }, error: null, success: null });
  });

  app.post('/broadcast/delete', requireAuth, async (req, res) => {
    const { taskId } = req.body;
    await deleteBroadcastTask(taskId);
    res.redirect('/broadcasts');
  });
  app.post('/tariffs/reset-expired', requireAuth, async (req, res) => {
try {
const n = await resetExpiredPremiumsBulk();
res.redirect('/dashboard?resetExpired=' + n);
} catch (e) {
console.error('[Tariffs] reset-expired error:', e.message);
res.redirect('/dashboard?resetExpired=err');
}
});

  app.post(['/broadcast/new', '/broadcast/edit/:id'], requireAuth, upload.single('file'), async (req, res) => {
    const isEditing = !!req.params.id;
    const taskId = req.params.id;
    const file = req.file;

    try {
      const { message, buttons, targetAudience, scheduledAt, disable_notification, enable_web_page_preview, action } = req.body;

      const taskForRender = { ...req.body, buttons_text: buttons };
      if (isEditing) taskForRender.id = taskId;

      const renderOptions = {
        title: isEditing ? 'Редактировать рассылку' : 'Новая рассылка',
        page: 'broadcasts',
        success: null,
        error: null,
        task: taskForRender
      };

      const existingTask = isEditing ? await getBroadcastTaskById(taskId) : {};

      if (!message && !file && !(existingTask && existingTask.file_id)) {
        if (file) await fs.promises.unlink(file.path).catch(() => {});
        renderOptions.error = 'Сообщение не может быть пустым, если не прикреплен файл.';
        return res.render('broadcast-form', renderOptions);
      }

      let fileId = existingTask.file_id || null;
      let fileMimeType = existingTask.file_mime_type || null;

      if (file) {
        if (!BROADCAST_STORAGE_ID) {
          await fs.promises.unlink(file.path).catch(() => {});
          renderOptions.error = 'Технический канал-хранилище (BROADCAST_STORAGE_ID) не настроен!';
          return res.render('broadcast-form', renderOptions);
        }
        console.log('[Broadcast] Загружен новый файл, отправляю в хранилище...');
        const mimeType = file.mimetype || mime.lookup(file.originalname) || '';
        let sentMessage;
        const source = { source: file.path };

        if (mimeType.startsWith('image/')) sentMessage = await bot.telegram.sendPhoto(BROADCAST_STORAGE_ID, source);
        else if (mimeType.startsWith('video/')) sentMessage = await bot.telegram.sendVideo(BROADCAST_STORAGE_ID, source);
        else if (mimeType.startsWith('audio/')) sentMessage = await bot.telegram.sendAudio(BROADCAST_STORAGE_ID, source);
        else sentMessage = await bot.telegram.sendDocument(BROADCAST_STORAGE_ID, source);

        fileId = sentMessage.photo?.pop()?.file_id || sentMessage.video?.file_id || sentMessage.audio?.file_id || sentMessage.document?.file_id;
        fileMimeType = mimeType;

        await fs.promises.unlink(file.path).catch(() => {});
      }

      const taskData = {
        message,
        keyboard: parseButtons(buttons),
        file_id: fileId,
        file_mime_type: fileMimeType,
        targetAudience,
        disableNotification: !!disable_notification,
        disable_web_page_preview: !enable_web_page_preview
      };

      if (action === 'preview') {
        await runBroadcastBatch(bot, taskData, [{ id: ADMIN_ID, first_name: 'Admin' }]);
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
        try { await fs.promises.unlink(file.path); console.log('[Error Cleanup] Временный файл успешно удален.'); }
        catch (cleanupError) { console.error('[Error Cleanup] Не удалось удалить временный файл:', cleanupError); }
      }

      const taskForRenderOnError = { ...req.body, buttons_text: req.body.buttons };
      if (isEditing) taskForRenderOnError.id = taskId;

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
      const texts = getEditableTexts();
      res.render('texts', {
        title: 'Редактор текстов',
        page: 'texts',
        texts,
        success: req.query.success
      });
    } catch (error) {
      console.error('Ошибка на странице текстов:', error);
      res.status(500).send('Ошибка сервера');
    }
  });

  app.post('/texts/update', requireAuth, async (req, res) => {
  try {
    const { key, value } = req.body;
    
    // Простая валидация: ключ и значение не должны быть пустыми
    if (!key || !value.trim()) {
      throw new Error('Ключ или значение не могут быть пустыми.');
    }
    
    await setText(key, value);
    
    // Перенаправляем с хешем, чтобы аккордеон остался открытым
    res.redirect(`/texts?success=true#collapse-${encodeURIComponent(key)}`);
    
  } catch (error) {
    console.error('Ошибка при обновлении текста:', error);
    
    // Перенаправляем на ту же страницу, но с сообщением об ошибке
    res.redirect(`/texts?error=${encodeURIComponent(error.message)}`);
  }
});
  app.get('/expiring-users', requireAuth, async (req, res) => {
    try {
      const users = await getExpiringUsers();
      
      // Считаем статистику (непересекающиеся группы)
      const now = new Date();
      let expiringToday = 0, expiring2to3Days = 0, expiring4to7Days = 0;
      
      users.forEach(u => {
        if (!u.premium_until) return;
        const days = Math.ceil((new Date(u.premium_until) - now) / (1000 * 60 * 60 * 24));
        if (days <= 1) expiringToday++;
        else if (days <= 3) expiring2to3Days++;
        else if (days <= 7) expiring4to7Days++;
      });
      
      const totalExpiring = expiringToday + expiring2to3Days + expiring4to7Days;
      
      res.render('expiring-users', { 
        title: 'Истекающие подписки', 
        page: 'expiring-users', 
        users,
        expiringToday,
        expiring2to3Days,
        expiring4to7Days,
        totalExpiring
      });
    } catch (e) {
      console.error('[Expiring Users] Error:', e);
      res.status(500).send('Ошибка сервера');
    }
  });

app.post('/set-tariff', requireAuth, async (req, res) => {
  const { userId, limit, days, applyMode } = req.body;
  try {
    const newLimit = parseInt(limit, 10);
    const nDays = parseInt(days, 10) || 30;
    const mode = applyMode === 'extend' ? 'extend' : 'set';

    const updated = await setTariffAdmin(userId, newLimit, nDays, { mode });

    await logUserAction(userId, 'tariff_changed_by_admin', {
      new_limit: newLimit,
      days: nDays,
      mode
    });

    let tariffName = '';
    if (newLimit <= 5) tariffName = 'Free';
    else if (newLimit <= 30) tariffName = 'Plus';
    else if (newLimit <= 100) tariffName = 'Pro';
    else tariffName = 'Unlimited';

    const untilText = newLimit <= 5
      ? 'бессрочно (Free)'
      : new Date(updated.premium_until).toLocaleString('ru-RU', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit'
        });

    const message =
      `🎉 Ваш тариф был обновлен администратором!\n\n` +
      `Новый тариф: *${tariffName}* (${newLimit} загрузок/день).\n` +
      `Срок действия: *${untilText}* ` +
      (mode === 'extend' ? '(продлён).' : '(установлен заново).');

    await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(`[Admin] Ошибка при смене тарифа для ${userId}:`, error.message);
  }
  
  // Если пришли из профиля — возвращаемся в профиль
  const referer = req.get('Referer') || '';
  if (referer.includes('/user/')) {
    res.redirect(`/user/${userId}?tariffUpdated=1`);
  } else {
    res.redirect('/users');
  }
});
  app.post('/reset-bonus', requireAuth, async (req, res) => {
    const { userId } = req.body;
    if (userId) { await updateUserField(userId, 'subscribed_bonus_used', false); }
    const back = req.get('Referer') || '/users';
    res.redirect(back);
  });

  app.post('/reset-daily-limit', requireAuth, async (req, res) => {
    const { userId } = req.body;
    if (userId) {
      await updateUserField(userId, 'downloads_today', 0);
      await updateUserField(userId, 'tracks_today', []);
    }
    const back = req.get('Referer') || '/users';
    res.redirect(back);
  });
app.post('/tariffs/reset-others', requireAuth, async (req, res) => {
  try {
    const n = await resetOtherTariffsToFree();
    res.redirect('/dashboard?resetOthers=' + n);
  } catch (e) {
    console.error('[Tariffs] reset-others error:', e);
    res.redirect('/dashboard?resetOthers=err');
  }
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
    const back = req.get('Referer') || '/users';
    res.redirect(back);
  });
// 1. Скачать список ссылок
  app.get('/admin/user/:id/links', requireAuth, async (req, res) => {
    try {
      const userId = req.params.id;
      const urls = await getUserUniqueDownloadedUrls(userId);
      
      if (!urls || urls.length === 0) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8'); // Важно для корректного отображения текста
        return res.send('История скачиваний пуста.');
      }

      const content = urls.join('\n');
      res.setHeader('Content-Disposition', `attachment; filename="links_${userId}.txt"`);
      res.setHeader('Content-Type', 'text/plain');
      res.send(content);
    } catch (e) {
      console.error(e);
      res.status(500).send('Ошибка при генерации списка ссылок');
    }
  });

   // 2. Починить кэш
  app.post('/admin/user/:id/fix-cache', requireAuth, async (req, res) => {
    try {
      const userId = req.params.id;
      const { fixDate } = req.body;

      const count = await fixBadCacheForUser(userId, fixDate);
      
      res.redirect(`/user/${userId}?fixedCount=${count}&fixedDate=${fixDate}`);
    } catch (e) {
      console.error(e);
      res.status(500).send('Ошибка при исправлении кэша: ' + e.message);
    }
  });

} 

// Запускаем приложение
startApp();
