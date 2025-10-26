// bot.js (оптимизированная версия с сохранением функционала)

import { Telegraf, Markup } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { 
  ADMIN_ID, BOT_TOKEN, WEBHOOK_URL, CHANNEL_USERNAME, 
  STORAGE_CHANNEL_ID, PROXY_URL 
} from './config.js';
import * as db from './db.js';
import { T, allTextsSync } from './config/texts.js';
import { enqueue, downloadQueue } from './services/downloadManager.js';
import { performInlineSearch } from './services/searchManager.js';
import { handleReferralCommand, processNewUserReferral } from './services/referralManager.js';
import { isMaintenanceMode, setMaintenanceMode } from './services/appState.js';
import execYoutubeDl from 'youtube-dl-exec';

// ========================= ИНИЦИАЛИЗАЦИЯ =========================

const telegrafOptions = { handlerTimeout: 300_000 };
if (PROXY_URL) {
  telegrafOptions.telegram = { agent: new HttpsProxyAgent(PROXY_URL) };
  console.log('[Bot] Использую прокси');
}

export const bot = new Telegraf(BOT_TOKEN, telegrafOptions);

// ========================= ХРАНИЛИЩЕ СЕССИЙ =========================
const playlistSessions = new Map();
const TRACKS_PER_PAGE = 5;

// ========================= УТИЛИТЫ =========================

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;');
}

function getTariffName(limit) {
  if (limit >= 10000) return 'Unlimited 💎';
  if (limit >= 100) return 'Pro 💪';
  if (limit >= 30) return 'Plus 🎯';
  return 'Free 🆓';
}

function getDaysLeft(premiumUntil) {
  if (!premiumUntil) return 0;
  const diff = new Date(premiumUntil) - new Date();
  return Math.max(Math.ceil(diff / 86400000), 0);
}

async function isSubscribed(userId) {
  if (!CHANNEL_USERNAME) return false;
  try {
    const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, userId);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch {
    return false;
  }
}

function getYoutubeDl() {
  const options = PROXY_URL ? { proxy: PROXY_URL } : {};
  return (url, flags) => execYoutubeDl(url, flags, options);
}

// ========================= MIDDLEWARE =========================

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  
  // Получаем пользователя с поддержкой реферальной системы
  const payload = ctx.startPayload || 
    (ctx.message?.text?.startsWith('/start ') ? ctx.message.text.split(' ')[1] : null);
  
  const user = await db.getUser(ctx.from.id, ctx.from.first_name, ctx.from.username, payload);
  ctx.state.user = user;
  
  if (user?.active === false) return;
  
  await db.resetDailyLimitIfNeeded(ctx.from.id);
  await db.resetExpiredPremiumIfNeeded(ctx.from.id);
  
  return next();
});

// ========================= КОМАНДЫ =========================

bot.start(async (ctx) => {
  const user = ctx.state.user;
  const isNew = (Date.now() - new Date(user.created_at).getTime()) < 5000;
  
  // Обработка нового пользователя и реферальной системы
  if (isNew) {
    await db.logUserAction(ctx.from.id, 'registration');
    await processNewUserReferral(user, ctx);
  }
  
  await ctx.reply(
    isNew ? T('start_new_user') : T('start'),
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...Markup.keyboard([
        [T('menu'), T('upgrade')],
        [T('mytracks'), T('help')]
      ]).resize()
    }
  );
});

bot.hears(T('menu'), async (ctx) => {
  const user = ctx.state.user;
  const tariff = getTariffName(user.premium_limit);
  const daysLeft = getDaysLeft(user.premium_until);
  const referralLink = `https://t.me/${ctx.botInfo.username}?start=ref_${user.id}`;
  
  let message = `
👤 <b>${escapeHtml(user.first_name)}</b>

💼 Тариф: <b>${tariff}</b>
⏳ Осталось дней: <b>${daysLeft}</b>
📊 Скачано сегодня: <b>${user.downloads_today || 0}/${user.premium_limit}</b>

👥 Приглашено друзей: <b>${user.referral_count || 0}</b>
🔗 Ваша реф. ссылка:
<code>${referralLink}</code>
  `.trim();
  
  const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
  
  if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
    extra.reply_markup = {
      inline_keyboard: [[
        Markup.button.callback('🎁 Получить бонус за подписку', 'check_subscription')
      ]]
    };
  }
  
  await ctx.reply(message, extra);
});

bot.hears(T('mytracks'), async (ctx) => {
  try {
    const user = ctx.state.user;
    if (!user.tracks_today || user.tracks_today.length === 0) {
      return await ctx.reply(T('noTracks'));
    }
    
    // Отправляем треки группами по 10
    for (let i = 0; i < user.tracks_today.length; i += 10) {
      const chunk = user.tracks_today
        .slice(i, i + 10)
        .filter(t => t && t.fileId)
        .map(t => ({ type: 'audio', media: t.fileId }));
      
      if (chunk.length > 0) {
        await ctx.replyWithMediaGroup(chunk);
      }
    }
  } catch (err) {
    console.error('MyTracks error:', err);
    await ctx.reply('❌ Ошибка получения треков');
  }
});

bot.hears(T('upgrade'), async (ctx) => {
  await ctx.reply(T('upgradeInfo'), { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.hears(T('help'), async (ctx) => {
  await ctx.reply(T('helpInfo'), { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.command('referral', handleReferralCommand);

// ========================= INLINE SEARCH =========================

bot.on('inline_query', async (ctx) => {
  const query = ctx.inlineQuery.query;
  
  if (!query || query.trim().length < 2) {
    return await ctx.answerInlineQuery([], {
      switch_pm_text: 'Введите название трека...',
      switch_pm_parameter: 'start'
    });
  }
  
  try {
    const results = await performInlineSearch(query, ctx.from.id);
    await ctx.answerInlineQuery(results, { cache_time: 60 });
  } catch (err) {
    console.error('Inline search error:', err);
    await ctx.answerInlineQuery([]);
  }
});

// ========================= АДМИН КОМАНДЫ =========================

bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  
  try {
    const [users, cachedCount, newToday, newWeek] = await Promise.all([
      db.getAllUsers(true),
      db.getCachedTracksCount(),
      db.getNewUsersCount(1),
      db.getNewUsersCount(7)
    ]);
    
    const totalUsers = users.length;
    const activeToday = users.filter(u => {
      return u.last_active && 
        new Date(u.last_active).toDateString() === new Date().toDateString();
    }).length;
    const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
    
    const message = `
📊 <b>Статистика бота</b>

👥 Всего пользователей: ${totalUsers}
📈 Активных сегодня: ${activeToday}
🆕 Новых за 24ч: ${newToday}
🆕 Новых за неделю: ${newWeek}

💾 Треков в кэше: ${cachedCount}
📥 Всего загрузок: ${totalDownloads}
⏳ В очереди: ${downloadQueue.size}

🔧 Обслуживание: ${isMaintenanceMode() ? 'ВКЛ' : 'ВЫКЛ'}
🔗 <a href="${WEBHOOK_URL}/dashboard">Дашборд</a>
    `.trim();
    
    await ctx.reply(message, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    console.error('Admin error:', err);
    await ctx.reply('❌ Ошибка');
  }
});

bot.command('maintenance', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  
  const arg = ctx.message.text.split(' ')[1];
  
  if (arg === 'on') {
    setMaintenanceMode(true);
    await ctx.reply('✅ Режим обслуживания включен');
  } else if (arg === 'off') {
    setMaintenanceMode(false);
    await ctx.reply('✅ Режим обслуживания выключен');
  } else {
    await ctx.reply(`Статус: ${isMaintenanceMode() ? 'ВКЛ' : 'ВЫКЛ'}\n/maintenance on или off`);
  }
});

// ========================= ПЛЕЙЛИСТЫ =========================

// Генерация меню для плейлистов
function generatePlaylistMenu(session) {
  const { tracks, selected, currentPage, playlistId, title } = session;
  const totalPages = Math.ceil(tracks.length / TRACKS_PER_PAGE);
  const start = currentPage * TRACKS_PER_PAGE;
  const tracksOnPage = tracks.slice(start, start + TRACKS_PER_PAGE);
  
  // Кнопки треков
  const trackButtons = tracksOnPage.map((track, i) => {
    const index = start + i;
    const icon = selected.has(index) ? '✅' : '⬜️';
    const name = (track.title || 'Track').slice(0, 40);
    return [Markup.button.callback(`${icon} ${name}`, `pl_toggle:${playlistId}:${index}`)];
  });
  
  // Навигация
  const navRow = [];
  if (currentPage > 0) {
    navRow.push(Markup.button.callback('⬅️', `pl_page:${playlistId}:${currentPage - 1}`));
  }
  navRow.push(Markup.button.callback(`${currentPage + 1}/${totalPages}`, 'pl_noop'));
  if (currentPage < totalPages - 1) {
    navRow.push(Markup.button.callback('➡️', `pl_page:${playlistId}:${currentPage + 1}`));
  }
  
  // Действия
  const actionRow = [
    Markup.button.callback(`✅ Скачать (${selected.size})`, `pl_done:${playlistId}`),
    Markup.button.callback('❌ Отмена', `pl_cancel:${playlistId}`)
  ];
  
  return {
    text: `🎶 <b>${escapeHtml(title)}</b>\nВыберите треки:`,
    keyboard: [...trackButtons, navRow, actionRow]
  };
}

// Обработчики кнопок плейлистов
bot.action('pl_noop', ctx => ctx.answerCbQuery());

bot.action(/pl_toggle:(.+):(\d+)/, async (ctx) => {
  const [playlistId, indexStr] = ctx.match.slice(1);
  const session = playlistSessions.get(ctx.from.id);
  
  if (!session || session.playlistId !== playlistId) {
    return await ctx.answerCbQuery('Сессия истекла', { show_alert: true });
  }
  
  const index = parseInt(indexStr);
  if (session.selected.has(index)) {
    session.selected.delete(index);
  } else {
    session.selected.add(index);
  }
  
  const menu = generatePlaylistMenu(session);
  await ctx.editMessageText(menu.text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(menu.keyboard)
  });
  await ctx.answerCbQuery();
});

bot.action(/pl_page:(.+):(\d+)/, async (ctx) => {
  const [playlistId, pageStr] = ctx.match.slice(1);
  const session = playlistSessions.get(ctx.from.id);
  
  if (!session || session.playlistId !== playlistId) {
    return await ctx.answerCbQuery('Сессия истекла', { show_alert: true });
  }
  
  session.currentPage = parseInt(pageStr);
  const menu = generatePlaylistMenu(session);
  await ctx.editMessageText(menu.text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(menu.keyboard)
  });
  await ctx.answerCbQuery();
});

bot.action(/pl_done:(.+)/, async (ctx) => {
  const playlistId = ctx.match[1];
  const session = playlistSessions.get(ctx.from.id);
  
  if (!session || session.playlistId !== playlistId) {
    return await ctx.answerCbQuery('Сессия истекла', { show_alert: true });
  }
  
  if (session.selected.size === 0) {
    return await ctx.answerCbQuery('Выберите хотя бы один трек', { show_alert: true });
  }
  
  const user = ctx.state.user;
  const remaining = user.premium_limit - user.downloads_today;
  
  if (remaining <= 0) {
    await ctx.editMessageText(T('limitReached'), { parse_mode: 'HTML' });
    playlistSessions.delete(ctx.from.id);
    return;
  }
  
  const selectedTracks = Array.from(session.selected)
    .slice(0, remaining)
    .map(i => session.tracks[i]);
  
  await ctx.editMessageText(`✅ Добавляю ${selectedTracks.length} треков в очередь...`);
  
  // Добавляем треки в очередь
  for (const track of selectedTracks) {
    enqueue(ctx, ctx.from.id, track.webpage_url || track.url);
  }
  
  playlistSessions.delete(ctx.from.id);
});

bot.action(/pl_cancel:(.+)/, async (ctx) => {
  playlistSessions.delete(ctx.from.id);
  await ctx.deleteMessage().catch(() => {});
  await ctx.answerCbQuery('Отменено');
});

// ========================= CALLBACK ACTIONS =========================

bot.action('check_subscription', async (ctx) => {
  try {
    const user = ctx.state.user;
    
    if (user.subscribed_bonus_used) {
      return await ctx.answerCbQuery('Вы уже использовали бонус', { show_alert: true });
    }
    
    const subscribed = await isSubscribed(ctx.from.id);
    
    if (subscribed) {
      await db.setPremium(ctx.from.id, 30, 7);
      await db.updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
      await db.logUserAction(ctx.from.id, 'bonus_received');
      
      await ctx.answerCbQuery('✅ Бонус активирован!');
      await ctx.editMessageText('🎉 Вам начислено 7 дней тарифа Plus!');
    } else {
      await ctx.answerCbQuery('Сначала подпишитесь на канал!', { show_alert: true });
    }
  } catch (err) {
    console.error('Bonus error:', err);
    await ctx.answerCbQuery('Ошибка', { show_alert: true });
  }
});

// ========================= ОБРАБОТКА ССЫЛОК =========================

async function handleSoundCloudUrl(ctx, url) {
  try {
    const youtubeDl = getYoutubeDl();
    const data = await youtubeDl(url, { dumpSingleJson: true, flatPlaylist: true });
    
    if (!data) throw new Error('Не удалось получить метаданные');
    
    // Проверяем, это плейлист или трек
    if (data.entries && data.entries.length > 1) {
      // Плейлист - создаем сессию для выбора
      const playlistId = `pl_${Date.now()}`;
      playlistSessions.set(ctx.from.id, {
        playlistId,
        title: data.title || 'Плейлист',
        tracks: data.entries,
        originalUrl: url,
        selected: new Set(),
        currentPage: 0
      });
      
      await ctx.reply(
        `🎶 Найден плейлист: <b>${escapeHtml(data.title)}</b>\n` +
        `Треков: <b>${data.entries.length}</b>\n\nЧто делаем?`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`📥 Скачать все`, `pl_done:${playlistId}`)],
            [Markup.button.callback('✏️ Выбрать треки', `pl_select:${playlistId}`)],
            [Markup.button.callback('❌ Отмена', `pl_cancel:${playlistId}`)]
          ])
        }
      );
    } else {
      // Одиночный трек - сразу в очередь
      enqueue(ctx, ctx.from.id, url);
    }
  } catch (err) {
    console.error('SoundCloud URL error:', err);
    await ctx.reply('❌ Не удалось обработать ссылку');
  }
}

bot.action(/pl_select:(.+)/, async (ctx) => {
  const playlistId = ctx.match[1];
  const session = playlistSessions.get(ctx.from.id);
  
  if (!session || session.playlistId !== playlistId) {
    return await ctx.answerCbQuery('Сессия истекла', { show_alert: true });
  }
  
  const menu = generatePlaylistMenu(session);
  await ctx.editMessageText(menu.text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(menu.keyboard)
  });
  await ctx.answerCbQuery();
});

bot.on('text', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
  if (Object.values(allTextsSync()).includes(text)) return;
  
  if (isMaintenanceMode() && ctx.from.id !== ADMIN_ID) {
    return await ctx.reply('⏳ Бот на обслуживании. Попробуйте через 5 минут.');
  }
  
  const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
  if (!urlMatch) {
    return await ctx.reply('Отправьте ссылку на трек SoundCloud');
  }
  
  const url = urlMatch[0];
  
  if (!url.includes('soundcloud.com')) {
    return await ctx.reply('Я работаю только с SoundCloud');
  }
  
  const user = ctx.state.user;
  if (user.downloads_today >= user.premium_limit) {
    let message = T('limitReached');
    const extra = { parse_mode: 'HTML' };
    
    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
      message += '\n\n🎁 Или получите 7 дней Plus за подписку!';
      extra.reply_markup = {
        inline_keyboard: [[
          Markup.button.callback('🎁 Получить бонус', 'check_subscription')
        ]]
      };
    }
    
    return await ctx.reply(message, extra);
  }
  
  handleSoundCloudUrl(ctx, url);
});

// ========================= ОБРАБОТКА ОШИБОК =========================

bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
  
  if (ADMIN_ID) {
    bot.telegram.sendMessage(
      ADMIN_ID, 
      `⚠️ Ошибка:\n${err.message || err}\nUpdate: ${ctx.updateType}`
    ).catch(() => {});
  }
});