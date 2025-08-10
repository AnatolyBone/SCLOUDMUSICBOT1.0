// index.js

// ===== Core =====
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ===== Server =====
import express from 'express';
import rateLimit from 'express-rate-limit';

// ===== Telegram =====
import { Telegraf, Markup } from 'telegraf';

// ===== Redis =====
import { createClient } from 'redis';

// ===== yt-dlp exec wrapper =====
import ytdl from 'youtube-dl-exec';

// ===== Админка =====
import setupAdmin from './routes/admin.js';

// ===== Тексты (из БД) =====
import { loadTexts, T } from './config/texts.js';

// ===== БД/Логика =====
import {
  supabase,          // нужен для индексатора
  getUser,
  updateUserField,
  setPremium,
  getAllUsers,
  resetDailyStats,
  cacheTrack,
  findCachedTrack,
} from './db.js';

// ВАЖНО: импорт ниже оставляем, он использует bot/getRedisClient во время работы, а не при загрузке модуля
import { enqueue, downloadQueue } from './services/downloadManager.js';
import { initNotifier, startNotifier } from './services/notifier.js';

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const WEBHOOK_URL = process.env.WEBHOOK_URL;       // например: https://yourapp.onrender.com
const WEBHOOK_PATH = '/telegram';                   // путь вебхука (должен совпадать с Render)
const PORT = process.env.PORT ?? 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-secret-key-for-session';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;

if (!BOT_TOKEN || !ADMIN_ID || !ADMIN_LOGIN || !ADMIN_PASSWORD || !WEBHOOK_URL || !STORAGE_CHANNEL_ID) {
  console.error('❌ Отсутствуют необходимые переменные окружения!');
  process.exit(1);
}

// ===== App/Bot =====
const bot = new Telegraf(BOT_TOKEN);
initNotifier(bot);

// parse_mode=HTML по умолчанию
bot.use(async (ctx, next) => {
  if (ctx.reply) {
    const origReply = ctx.reply.bind(ctx);
    ctx.reply = (text, extra = {}) => origReply(text, { parse_mode: 'HTML', ...extra });
  }
  if (ctx.editMessageText) {
    const origEdit = ctx.editMessageText.bind(ctx);
    ctx.editMessageText = (text, extra = {}) => origEdit(text, { parse_mode: 'HTML', ...extra });
  }
  return next();
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json()); // JSON POST для админки/рассылки

// health-check для Render
app.get('/health', (_req, res) => res.type('text').send('OK'));
app.get('/', (_req, res) => res.type('text').send('OK'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// статика для админки
app.use('/static', express.static(path.join(__dirname, 'public', 'static')));

const cacheDir = path.join(__dirname, 'cache');
let redisClient = null;

// Доступно из других модулей
function getRedisClient() {
  if (!redisClient) throw new Error('Redis клиент ещё не инициализирован');
  return redisClient;
}

// ===== Утилиты =====
async function cleanupCache(directory, maxAgeMinutes = 60) {
  try {
    const now = Date.now();
    const files = await fs.promises.readdir(directory);
    let cleaned = 0;
    for (const file of files) {
      try {
        const filePath = path.join(directory, file);
        const stat = await fs.promises.stat(filePath);
        if ((now - stat.mtimeMs) / 60000 > maxAgeMinutes) {
          await fs.promises.unlink(filePath);
          cleaned++;
        }
      } catch {}
    }
    if (cleaned > 0) console.log(`[Cache Cleanup] Удалено ${cleaned} старых файлов.`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Cache Cleanup] Ошибка:', e);
  }
}

function getTariffName(limit) {
  if (limit >= 1000) return 'Unlimited (∞/день)';
  if (limit === 100) return 'Pro (100/день)';
  if (limit === 30) return 'Plus (30/день)';
  return 'Free (5/день)';
}

function getDaysLeft(premiumUntil) {
  if (!premiumUntil) return 0;
  const diff = new Date(premiumUntil) - new Date();
  return Math.max(Math.ceil(diff / 86400000), 0);
}

const extractUrl = (text = '') => {
  const regex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(regex);
  return matches ? matches.find(url => url.includes('soundcloud.com')) : null;
};

const isSubscribed = async (userId, channelUsername) => {
  try {
    const chatMember = await bot.telegram.getChatMember(channelUsername, userId);
    return ['creator', 'administrator', 'member'].includes(chatMember.status);
  } catch (e) {
    console.error(`Ошибка проверки подписки для ${userId} на ${channelUsername}:`, e.message);
    return false;
  }
};

function formatMenuMessage(user, ctx) {
  const tariffLabel = getTariffName(user.premium_limit);
  const downloadsToday = user.downloads_today || 0;
  const refLink = `https://t.me/${ctx.botInfo.username}?start=${user.id}`;
  const daysLeft = getDaysLeft(user.premium_until);

  let message = `
👋 Привет, ${user.first_name || user.username || 'друг'}!

📥 Бот качает треки и плейлисты с SoundCloud в MP3 — просто пришли ссылку.

📣 Новости, фишки и бонусы: @SCM_BLOG

💼 Тариф: ${tariffLabel}
⏳ Осталось дней: ${daysLeft > 999 ? '∞' : daysLeft}
🎧 Сегодня скачано: ${downloadsToday} из ${user.premium_limit}

🔗 Твоя реферальная ссылка:
${refLink}
`.trim();

  if (!user.subscribed_bonus_used) {
    message += `

🎁 Бонус! Подпишись на @SCM_BLOG и получи 7 дней тарифа Plus бесплатно.`;
  }

  return message;
}

// ==========================
// Индексатор (кооперативный)
// ==========================
async function getUrlsToIndex() {
  try {
    const { data, error } = await supabase
      .from('track_cache')
      .select('url, file_id')
      .is('file_id', null)
      .not('url', 'is', null)
      .limit(20);

    if (error) {
      console.error('[Indexer] Ошибка выборки track_cache:', error.message);
      return [];
    }

    const urls = (data || [])
      .map(r => r.url)
      .filter(u => typeof u === 'string' && u.includes('soundcloud.com'));

    return Array.from(new Set(urls));
  } catch (e) {
    console.error('[Indexer] Критическая ошибка в getUrlsToIndex:', e);
    return [];
  }
}

let shuttingDown = false;
process.once('SIGINT', () => { shuttingDown = true; });
process.once('SIGTERM', () => { shuttingDown = true; });

async function processUrlForIndexing(url) {
  let tempFilePath = null;
  try {
    const isCached = await findCachedTrack(url);
    if (isCached && isCached.file_id) {
      console.log(`[Indexer] Пропуск: ${url} уже в кэше.`);
      return;
    }

    console.log(`[Indexer] Индексирую: ${url}`);
    let info = await ytdl(url, { dumpSingleJson: true, 'no-playlist': true });
    if (!info) {
      console.log(`[Indexer] Пропуск: ${url} — нет информации.`);
      return;
    }

    if (info._type === 'playlist' || Array.isArray(info.entries)) {
      if (Array.isArray(info.entries) && info.entries.length >= 1) {
        info = info.entries[0];
      } else {
        console.log(`[Indexer] Пропуск: ${url} является плейлистом без элементов.`);
        return;
      }
    }

    const trackName = (info.title || 'track').slice(0, 100);
    const uploader = info.uploader || 'SoundCloud';
    const fileName = `indexer_${info.id || Date.now()}.mp3`;
    tempFilePath = path.join(cacheDir, fileName);

    await ytdl(url, {
      output: tempFilePath,
      extractAudio: true,
      audioFormat: 'mp3',
      addMetadata: true,
      embedMetadata: true,
      'no-playlist': true,
    });

    const fileExists = await fs.promises.access(tempFilePath).then(() => true).catch(() => false);
    if (!fileExists) throw new Error('Файл не создан');

    const message = await bot.telegram.sendAudio(
      STORAGE_CHANNEL_ID,
      { source: fs.createReadStream(tempFilePath) },
      { title: trackName, performer: uploader }
    );

    if (message?.audio?.file_id) {
      await cacheTrack(url, message.audio.file_id, trackName);
      console.log(`✅ [Indexer] Успешно закэширован: ${trackName}`);
    }
  } catch (err) {
    console.error(`❌ [Indexer] Ошибка при обработке ${url}:`, err.response?.description || err.stderr || err.message || err);
  } finally {
    if (tempFilePath) {
      await fs.promises.unlink(tempFilePath).catch(() => {
        console.warn(`[Indexer] Не удалось удалить временный файл: ${tempFilePath}`);
      });
    }
  }
}

async function startIndexer() {
  console.log('🚀 Запуск фонового индексатора (кооперативный режим)...');

  async function tick() {
    if (shuttingDown) return;

    try {
      if (downloadQueue?.active > 0) {
        console.log('[Indexer] В работе есть задания пользователей. Пауза 2 мин.');
        return setTimeout(tick, 2 * 60 * 1000);
      }

      const urls = await getUrlsToIndex();
      if (urls.length === 0) {
        console.log('[Indexer] Ничего не найдено. Пауза 10 минут.');
        return setTimeout(tick, 10 * 60 * 1000);
      }

      const batch = urls.slice(0, 2);
      for (const url of batch) {
        if (shuttingDown) break;
        await processUrlForIndexing(url);
        await new Promise(r => setTimeout(r, 5000));
      }

      setTimeout(tick, 60 * 1000);
    } catch (err) {
      console.error('🔴 Критическая ошибка в индексаторе, рестарт через 5 минут:', err);
      setTimeout(tick, 5 * 60 * 1000);
    }
  }

  setTimeout(tick, 60 * 1000); // небольшая задержка старта
}

// ==================
// Телеграм-бот
// ==================
function kb() {
  return Markup.keyboard([[T('menu'), T('upgrade')], [T('mytracks'), T('help')]]).resize();
}

function setupTelegramBot() {
  const handleSendMessageError = async (error, userId) => {
    if (error.response?.error_code === 403) {
      console.log(`Пользователь ${userId} заблокировал бота. Отключаем его.`);
      await updateUserField(userId, 'active', false);
    } else {
      console.error(`Ошибка при отправке для ${userId}:`, error.response?.description || error.message);
    }
  };

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    try {
      ctx.state.user = await getUser(userId, ctx.from.first_name, ctx.from.username);
    } catch (error) {
      console.error(`Ошибка в мидлваре для userId ${userId}:`, error);
    }
    return next();
  });

  const getBonusKeyboard = (user) => {
    const keyboard = [];
    if (!user.subscribed_bonus_used) {
      keyboard.push([{ text: '✅ Я подписался, получить бонус!', callback_data: 'check_subscription' }]);
    }
    return { inline_keyboard: keyboard };
  };

  bot.action('check_subscription', async (ctx) => {
    try {
      const user = ctx.state.user || await getUser(ctx.from.id);
      if (user.subscribed_bonus_used) {
        return await ctx.answerCbQuery('Вы уже получали этот бонус. Спасибо!', { show_alert: true });
      }
      const channel = '@SCM_BLOG';
      if (await isSubscribed(ctx.from.id, channel)) {
        await setPremium(ctx.from.id, 30, 7);
        await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
        await ctx.editMessageText(
          '🎉 Поздравляем!\n\nПодписка на канал подтверждена. Начислен бонус: 7 дней тарифа Plus.\n\nНажмите /menu, чтобы увидеть статус.'
        );
      } else {
        await ctx.answerCbQuery('Кажется, вы ещё не подписаны на канал.', { show_alert: true });
        await ctx.reply(`Пожалуйста, подпишитесь на канал ${channel}, затем нажмите кнопку ещё раз.`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '➡️ Перейти в канал', url: 'https://t.me/SCM_BLOG' }],
              [{ text: '✅ Я подписался!', callback_data: 'check_subscription' }]
            ]
          }
        });
      }
    } catch (e) {
      console.error('Ошибка в check_subscription:', e);
      await ctx.answerCbQuery('Произошла ошибка, попробуйте позже.', { show_alert: true });
    }
  });

  bot.start(async (ctx) => {
    try {
      const user = ctx.state.user || await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
      const text = formatMenuMessage(user, ctx);
      await ctx.reply(text, { reply_markup: getBonusKeyboard(user) });
      await ctx.reply('Выберите действие:', kb());
    } catch (e) { await handleSendMessageError(e, ctx.from.id); }
  });

  bot.hears(T('menu'), async (ctx) => {
    try {
      const user = ctx.state.user || await getUser(ctx.from.id);
      const text = formatMenuMessage(user, ctx);
      await ctx.reply(text, { reply_markup: getBonusKeyboard(user) });
    } catch (e) { await handleSendMessageError(e, ctx.from.id); }
  });

  bot.hears(T('mytracks'), async (ctx) => {
    try {
      const user = ctx.state.user || await getUser(ctx.from.id);
      let tracks = [];
      if (Array.isArray(user.tracks_today)) tracks = user.tracks_today;
      else if (typeof user.tracks_today === 'string') {
        try { tracks = JSON.parse(user.tracks_today); } catch { tracks = []; }
      }

      const validTracks = (tracks || []).filter(t => t && t.fileId);
      if (!validTracks.length) {
        return await ctx.reply(T('noTracks') || 'У вас пока нет треков за сегодня.');
      }

      for (let i = 0; i < validTracks.length; i += 5) {
        const chunk = validTracks.slice(i, i + 5);
        await ctx.replyWithMediaGroup(
          chunk.map(track => ({ type: 'audio', media: track.fileId }))
        );
      }
    } catch (err) {
      console.error('Ошибка в /mytracks:', err);
      await ctx.reply('Произошла ошибка при получении треков.');
    }
  });

  bot.hears(T('help'), async (ctx) => {
    try { await ctx.reply(T('helpInfo'), kb()); }
    catch (e) { await handleSendMessageError(e, ctx.from.id); }
  });

  bot.hears(T('upgrade'), async (ctx) => {
    try { await ctx.reply(T('upgradeInfo').replace(/\*/g, '')); }
    catch (e) { await handleSendMessageError(e, ctx.from.id); }
  });

  bot.on('text', async (ctx) => {
    try {
      const url = extractUrl(ctx.message.text);
      if (url) {
        await enqueue(ctx, ctx.from.id, url);
      } else if (![T('menu'), T('upgrade'), T('mytracks'), T('help')].includes(ctx.message.text)) {
        await ctx.reply('Пожалуйста, пришлите ссылку на трек или плейлист SoundCloud.');
      }
    } catch (e) {
      await handleSendMessageError(e, ctx.from.id);
    }
  });
}

// =========== Запуск приложения ===========
async function startApp() {
  try {
    // Подгружаем тексты из БД до регистрации хендлеров
    await loadTexts();

    // Redis
    const client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 10000 } });
    client.on('error', (err) => console.error('🔴 Ошибка Redis:', err));
    await client.connect();
    redisClient = client;
    console.log('✅ Redis подключён');

    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

    // Админка (всё внутри routes/admin.js)
    setupAdmin({
      app,
      bot,
      __dirname,
      ADMIN_ID,
      ADMIN_LOGIN,
      ADMIN_PASSWORD,
      SESSION_SECRET,
      STORAGE_CHANNEL_ID,
      redis: client, // сессии через RedisStore
    });

    // Телеграм-бот
    setupTelegramBot();

    // Плановые задачи
    setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
    setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`), 60 * 1000);
    setInterval(() => cleanupCache(cacheDir, 60), 30 * 60 * 1000);
    cleanupCache(cacheDir, 60);

    if (process.env.NODE_ENV === 'production') {
      // Rate limit только на вебхук
      const webhookLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 120,
        standardHeaders: true,
        legacyHeaders: false,
        trustProxy: true,
      });
      app.use(WEBHOOK_PATH, webhookLimiter);

      app.use(await bot.createWebhook({
        domain: WEBHOOK_URL,
        path: WEBHOOK_PATH,
      }));

      app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}.`));
    } else {
      await bot.launch();
      console.log('✅ Бот запущен в режиме long-polling.');
    }

    // Фоновые сервисы
    startIndexer().catch(err => console.error("🔴 Критическая ошибка в индексаторе, не удалось запустить:", err));
    startNotifier().catch(err => console.error("🔴 Критическая ошибка в планировщике:", err));

  } catch (err) {
    console.error('🔴 Критическая ошибка при запуске приложения:', err);
    process.exit(1);
  }
}

// Корректное завершение
const stopBot = (signal) => {
  console.log(`Получен сигнал ${signal}. Завершение работы...`);
  try {
    if (bot.polling?.isRunning()) {
      bot.stop(signal);
    }
  } catch {}
  setTimeout(() => process.exit(0), 500);
};

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));

startApp();

// Экспорт для других модулей
export { app, bot, getRedisClient };
