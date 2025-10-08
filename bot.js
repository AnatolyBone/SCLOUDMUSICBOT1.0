// ======================= ОПТИМИЗИРОВАННАЯ ВЕРСИЯ BOT.JS =======================

// ======================= ОПТИМИЗИРОВАННАЯ ВЕРСИЯ BOT.JS =======================

import { Telegraf, Markup, TelegramError } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import scdl from 'soundcloud-downloader'; // 🔥 ДОБАВЛЕНО
import { ADMIN_ID, BOT_TOKEN, WEBHOOK_URL, CHANNEL_USERNAME, STORAGE_CHANNEL_ID, PROXY_URL } from './config.js';
import { 
    updateUserField, getUser, createUser, setPremium, getAllUsers, 
    resetDailyLimitIfNeeded, getCachedTracksCount, logUserAction, 
    getTopFailedSearches, getTopRecentSearches, getNewUsersCount,
    findCachedTrack, incrementDownloadsAndSaveTrack, getReferrerInfo, 
    getReferredUsers, resetExpiredPremiumIfNeeded, getReferralStats
} from './db.js';
import { T, allTextsSync } from './config/texts.js';
import { performInlineSearch } from './services/searchManager.js';
import { spotifyEnqueue } from './services/spotifyManager.js';
import { downloadQueue, enqueue as soundcloudEnqueue } from './services/downloadManager.js';
import { handleReferralCommand, processNewUserReferral } from './services/referralManager.js';
import { isShuttingDown, isMaintenanceMode, setMaintenanceMode } from './services/appState.js';

function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;');
}

async function isSubscribed(userId) {
    if (!CHANNEL_USERNAME) return false;
    try {
        const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, userId);
        return ['creator', 'administrator', 'member'].includes(member.status);
    } catch (e) {
        console.error(`Ошибка проверки подписки для ${userId}:`, e.message);
        return false;
    }
}

function getTariffName(limit) {
    if (limit >= 10000) return 'Unlimited — 💎';
    if (limit >= 100) return 'Pro — 100 💪';
    if (limit >= 30) return 'Plus — 30 🎯';
    return '🆓 Free — 5 🟢';
}

function getDaysLeft(premiumUntil) {
    if (!premiumUntil) return 0;
    const diff = new Date(premiumUntil) - new Date();
    return Math.max(Math.ceil(diff / 86400000), 0);
}

function formatMenuMessage(user, botUsername) {
    const tariffLabel = getTariffName(user.premium_limit);
    const downloadsToday = user.downloads_today || 0;
    const daysLeft = getDaysLeft(user.premium_until);
    const referralCount = user.referral_count || 0;
    const referralLink = `https://t.me/${botUsername}?start=ref_${user.id}`;
    
    const statsBlock = [
        `💼 <b>Тариф:</b> <i>${tariffLabel}</i>`,
        `⏳ <b>Осталось дней подписки:</b> <i>${daysLeft}</i>`,
        `🎧 <b>Сегодня скачано:</b> <i>${downloadsToday}</i> из <i>${user.premium_limit}</i>`
    ].join('\n');
    
    const header = T('menu_header').replace('{first_name}', escapeHtml(user.first_name) || 'пользователь');
    
    const referralBlock = T('menu_referral_block')
        .replace('{referral_count}', referralCount)
        .replace('{referral_link}', referralLink);
    
    let bonusBlock = '';
    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
        const cleanUsername = CHANNEL_USERNAME.replace('@', '');
        const channelLink = `<a href="https://t.me/${cleanUsername}">наш канал</a>`;
        bonusBlock = T('menu_bonus_block').replace('{channel_link}', channelLink);
    }
    
    const footer = T('menu_footer');
    
    const messageParts = [header, statsBlock, '\n- - - - - - - - - - - - - - -', referralBlock, bonusBlock, footer];
    return messageParts.filter(Boolean).join('\n\n');
}

// ========================= PLAYLIST SESSIONS =========================

const playlistSessions = new Map();
const TRACKS_PER_PAGE = 5;

function generateInitialPlaylistMenu(playlistId, trackCount) {
    return Markup.inlineKeyboard([
        [Markup.button.callback(`📥 Скачать все (${trackCount})`, `pl_download_all:${playlistId}`)],
        [Markup.button.callback('📥 Скачать первые 10', `pl_download_10:${playlistId}`)],
        [Markup.button.callback('📝 Выбрать треки вручную', `pl_select_manual:${playlistId}`)],
        [Markup.button.callback('❌ Отмена', `pl_cancel:${playlistId}`)]
    ]);
}

function generateSelectionMenu(userId) {
    const session = playlistSessions.get(userId);
    if (!session) return null;
    
    const { tracks, selected, currentPage, playlistId, title } = session;
    const totalPages = Math.ceil(tracks.length / TRACKS_PER_PAGE);
    const startIndex = currentPage * TRACKS_PER_PAGE;
    const tracksOnPage = tracks.slice(startIndex, startIndex + TRACKS_PER_PAGE);
    
    const trackRows = tracksOnPage.map((track, index) => {
        const absoluteIndex = startIndex + index;
        const isSelected = selected.has(absoluteIndex);
        const icon = isSelected ? '✅' : '⬜️';
        const trackTitleText = track.title || 'Трек без названия';
        const trackTitle = trackTitleText.length > 50 ? trackTitleText.slice(0, 47) + '...' : trackTitleText;
        return [Markup.button.callback(`${icon} ${trackTitle}`, `pl_toggle:${playlistId}:${absoluteIndex}`)];
    });
    
    const navRow = [];
    if (currentPage > 0) navRow.push(Markup.button.callback('⬅️ Назад', `pl_page:${playlistId}:${currentPage - 1}`));
    navRow.push(Markup.button.callback(`${currentPage + 1}/${totalPages}`, 'pl_nop'));
    if (currentPage < totalPages - 1) navRow.push(Markup.button.callback('Вперед ➡️', `pl_page:${playlistId}:${currentPage + 1}`));
    
    const actionRow = [
        Markup.button.callback(`✅ Готово (${selected.size})`, `pl_finish:${playlistId}`),
        Markup.button.callback(`❌ Отмена`, `pl_cancel:${playlistId}`)
    ];
    
    const messageText = `🎶 <b>${title}</b>\n\nВыберите треки (Стр. ${currentPage + 1}/${totalPages}):`;
    
    return {
        text: messageText,
        options: { parse_mode: 'HTML', ...Markup.inlineKeyboard([...trackRows, navRow, actionRow]) }
    };
}

// ========================= TELEGRAF INIT =========================

const telegrafOptions = { handlerTimeout: 300_000 };
if (PROXY_URL) {
    const agent = new HttpsProxyAgent(PROXY_URL);
    telegrafOptions.telegram = { agent };
    console.log('[App] Использую прокси для Telegram API.');
}

export const bot = new Telegraf(BOT_TOKEN, telegrafOptions);

// ========================= MIDDLEWARE =========================

bot.catch(async (err, ctx) => {
    console.error(`🔴 [Telegraf Catch] Глобальная ошибка для update ${ctx.update.update_id}:`, err);
    
    const updateInfo = ctx.update ? JSON.stringify(ctx.update, null, 2) : 'N/A';
    const errorMessage = `
🔴 <b>Критическая ошибка в боте!</b>

<b>Тип ошибки:</b>
<code>${err.name || 'UnknownError'}</code>

<b>Сообщение:</b>
<code>${err.message || 'No message'}</code>

<b>Где произошла:</b>
<code>${err.stack ? err.stack.split('\n')[1].trim() : 'Stack trace unavailable'}</code>

<b>Update:</b>
<pre><code class="language-json">${updateInfo.slice(0, 3500)}</code></pre>
    `;
    
    try {
        await bot.telegram.sendMessage(ADMIN_ID, errorMessage, { parse_mode: 'HTML' });
    } catch (sendError) {
        console.error('🔥 КРИТИЧЕСКАЯ ОШИБКА: Не удалось отправить уведомление админу!', sendError);
    }
    
    if (err instanceof TelegramError && err.response?.error_code === 403) {
        if (ctx.from?.id) {
            await updateUserField(ctx.from.id, 'active', false);
        }
    }
});

bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    
    const payload =
        (typeof ctx.startPayload === 'string' && ctx.startPayload) ||
        (ctx.message?.text?.startsWith('/start ') ? ctx.message.text.split(' ')[1] : null) ||
        null;
    
    const user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username, payload);
    ctx.state.user = user;
    
    if (user && user.active === false) return;
    
    if (user && user.can_receive_broadcasts === false) {
        try { 
            await updateUserField(user.id, { can_receive_broadcasts: true }); 
        } catch (e) {
            console.error('[Broadcast flag] update error:', e.message);
        }
    }
    
    await resetDailyLimitIfNeeded(ctx.from.id);
    await resetExpiredPremiumIfNeeded(ctx.from.id);
    return next();
});

// ========================= COMMANDS =========================

bot.start(async (ctx) => {
    console.log('[START] got start for', ctx.from.id, 'payload=', ctx.startPayload);
    
    const user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.startPayload || null);
    const isNewRegistration = (Date.now() - new Date(user.created_at).getTime()) < 5000;
    
    if (isNewRegistration) {
        await logUserAction(ctx.from.id, 'registration');
        await processNewUserReferral(user, ctx);
    }
    
    const startMessage = isNewRegistration ? T('start_new_user') : T('start');
    
    await ctx.reply(startMessage, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.keyboard([
            [T('menu'), T('upgrade')],
            [T('mytracks'), T('help')]
        ]).resize()
    });
});

bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    try {
        await ctx.reply('⏳ Собираю статистику...');
        
        const [users, cachedTracksCount, topFailed, topRecent, newUsersToday, newUsersWeek] = await Promise.all([
            getAllUsers(true),
            getCachedTracksCount(),
            getTopFailedSearches(5),
            getTopRecentSearches(5),
            getNewUsersCount(1),
            getNewUsersCount(7)
        ]);
        
        const totalUsers = users.length;
        const activeUsers = users.filter(u => u.active).length;
        const activeToday = users.filter(u => u.last_active && new Date(u.last_active).toDateString() === new Date().toDateString()).length;
        const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
        let storageStatusText = STORAGE_CHANNEL_ID ? '✅ Доступен' : '⚠️ Не настроен';
        
        let statsMessage = `<b>📊 Статистика Бота</b>\n\n` +
            `<b>👤 Пользователи:</b>\n` +
            `   - Всего: <i>${totalUsers}</i>\n` +
            `   - Активных: <i>${activeUsers}</i>\n` +
            `   - <b>Новых за 24ч: <i>${newUsersToday}</i></b>\n` +
            `   - <b>Новых за 7 дней: <i>${newUsersWeek}</i></b>\n` +
            `   - Активных сегодня: <i>${activeToday}</i>\n\n` +
            `<b>📥 Загрузки:</b>\n   - Всего за все время: <i>${totalDownloads}</i>\n\n`;
        
                if (topFailed.length > 0) {
            statsMessage += `---\n\n<b>🔥 Топ-5 неудачных запросов (всего):</b>\n`;
            topFailed.forEach((item, index) => {
                statsMessage += `${index + 1}. <code>${item.query.slice(0, 30)}</code> (искали <i>${item.search_count}</i> раз)\n`;
            });
            statsMessage += `\n`;
        }
        
        if (topRecent.length > 0) {
            statsMessage += `<b>📈 Топ-5 запросов (за 24 часа):</b>\n`;
            topRecent.forEach((item, index) => {
                statsMessage += `${index + 1}. <code>${item.query.slice(0, 30)}</code> (искали <i>${item.total}</i> раз)\n`;
            });
            statsMessage += `\n`;
        }
        
        statsMessage += `---\n\n<b>⚙️ Система:</b>\n` +
            `   - Очередь: <i>${downloadQueue.size}</i> в ож. / <i>${downloadQueue.pending}</i> в раб.\n` +
            `   - Канал-хранилище: <i>${storageStatusText}</i>\n   - Треков в кэше: <i>${cachedTracksCount}</i>\n\n` +
            `<b>🔗 Админ-панель:</b>\n<a href="${WEBHOOK_URL.replace(/\/$/, '')}/dashboard">Открыть дашборд</a>`;
        
        await ctx.reply(statsMessage, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
        console.error('❌ Ошибка в команде /admin:', e);
        await ctx.reply('❌ Не удалось собрать статистику.');
    }
});

bot.command('referral', handleReferralCommand);

bot.command('maintenance', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    const command = ctx.message.text.split(' ')[1]?.toLowerCase();
    
    if (command === 'on') {
        setMaintenanceMode(true);
        ctx.reply('✅ Режим обслуживания ВКЛЮЧЕН.');
    } else if (command === 'off') {
        setMaintenanceMode(false);
        ctx.reply('☑️ Режим обслуживания ВЫКЛЮЧЕН.');
    } else {
        ctx.reply('ℹ️ Статус: ' + (isMaintenanceMode() ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН') + '\n\nИспользуйте: `/maintenance on` или `/maintenance off`');
    }
});

bot.command('premium', (ctx) => ctx.reply(T('upgradeInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));

// ========================= ACTIONS =========================

bot.action('check_subscription', async (ctx) => {
    try {
        console.log(`[Bonus] User ${ctx.from.id} пытается получить бонус.`);

        const user = await getUser(ctx.from.id);
        if (user.subscribed_bonus_used) {
            console.log(`[Bonus] User ${ctx.from.id} уже использовал бонус.`);
            return await ctx.answerCbQuery('Вы уже использовали этот бонус.', { show_alert: true });
        }

        console.log(`[Bonus] Проверяю подписку для ${ctx.from.id} на канал ${CHANNEL_USERNAME}`);
        const subscribed = await isSubscribed(ctx.from.id);

        if (subscribed) {
            console.log(`[Bonus] User ${ctx.from.id} подписан. Начисляю бонус.`);
            await setPremium(ctx.from.id, 30, 7);
            await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
            await logUserAction(ctx.from.id, 'bonus_received');
            
            await ctx.answerCbQuery('Бонус начислен!');
            await ctx.editMessageText('🎉 Поздравляем! Вам начислено 7 дней тарифа Plus. Спасибо за подписку!');

        } else {
            console.log(`[Bonus] User ${ctx.from.id} НЕ подписан.`);
            return await ctx.answerCbQuery(`Вы еще не подписаны на канал ${CHANNEL_USERNAME}. Пожалуйста, подпишитесь и нажмите кнопку снова.`, { show_alert: true });
        }
    } catch (e) {
        console.error(`🔴 КРИТИЧЕСКАЯ ОШИБКА в check_subscription для user ${ctx.from.id}:`, e);
        await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте позже.', { show_alert: true });
    }
});

// ========================= KEYBOARD HANDLERS =========================

bot.hears(T('menu'), async (ctx) => {
    const user = await getUser(ctx.from.id);
    const message = formatMenuMessage(user, ctx.botInfo.username);

    const extraOptions = { 
        parse_mode: 'HTML',
        disable_web_page_preview: true
    };
    
    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
        extraOptions.reply_markup = { 
            inline_keyboard: [[ Markup.button.callback('✅ Я подписался и хочу бонус!', 'check_subscription') ]] 
        };
    }
    
    await ctx.reply(message, extraOptions);
});

bot.hears(T('mytracks'), async (ctx) => {
    try {
        const user = await getUser(ctx.from.id);
        if (!user.tracks_today || user.tracks_today.length === 0) {
            return await ctx.reply(T('noTracks'));
        }
        
        for (let i = 0; i < user.tracks_today.length; i += 10) {
            const chunk = user.tracks_today.slice(i, i + 10).filter(t => t && t.fileId);
            if (chunk.length > 0) {
                await ctx.replyWithMediaGroup(chunk.map(t => ({ type: 'audio', media: t.fileId })));
            }
        }
    } catch (e) {
        console.error(`🔴 Ошибка в mytracks для ${ctx.from.id}:`, e.message);
    }
});

bot.hears(T('help'), (ctx) => ctx.reply(T('helpInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));
bot.hears(T('upgrade'), (ctx) => ctx.reply(T('upgradeInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));

// ========================= INLINE QUERY =========================

bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query;
    if (!query || query.trim().length < 2) {
        return await ctx.answerInlineQuery([], { 
            switch_pm_text: 'Введите название трека для поиска...', 
            switch_pm_parameter: 'start' 
        });
    }
    
    try {
        const results = await performInlineSearch(query, ctx.from.id);
        await ctx.answerInlineQuery(results, { cache_time: 60 });
    } catch (error) {
        console.error('[Inline Query] Глобальная ошибка:', error);
        await ctx.answerInlineQuery([]);
    }
});

// ========================= PLAYLIST ACTIONS =========================

bot.action('pl_nop', (ctx) => ctx.answerCbQuery());

bot.action(/pl_download_all:|pl_download_10:/, async (ctx) => {
    const isAll = ctx.callbackQuery.data.includes('pl_download_all');
    const playlistId = ctx.callbackQuery.data.split(':')[1];
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    
    if (!session) {
        return await ctx.answerCbQuery('❗️ Сессия выбора истекла.', { show_alert: true });
    }
    
    // Дозагрузка полных данных если нужно
    if (!session.fullTracks) {
        await ctx.answerCbQuery('⏳ Получаю полные данные плейлиста...');
        await ctx.editMessageText('⏳ Получаю полные данные плейлиста... Это может занять несколько секунд.');
        
        try {
            const fullData = await ytdl(session.originalUrl, { 
                'dump-single-json': true,
                ...YTDL_COMMON 
            });
            session.tracks = fullData.entries.filter(track => track && track.url);
            session.fullTracks = true;
        } catch (e) {
            console.error('[Playlist] Ошибка при дозагрузке названий:', e);
            await ctx.editMessageText('❌ Не удалось получить детали плейлиста.');
            return await ctx.answerCbQuery('Ошибка!', { show_alert: true });
        }
    }
    
    const user = await getUser(userId);
    const remainingLimit = user.premium_limit - (user.downloads_today || 0);
    
    if (remainingLimit <= 0) {
        const bonusAvailable = Boolean(CHANNEL_USERNAME && !user.subscribed_bonus_used);
        const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
        const bonusText = bonusAvailable
            ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.`
            : '';
        
        const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
        if (bonusAvailable) {
            extra.reply_markup = {
                inline_keyboard: [[ { text: '✅ Я подписался, забрать бонус', callback_data: 'check_subscription' } ]]
            };
        }
        
        await ctx.editMessageText(`${T('limitReached')}${bonusText}`, extra);
        playlistSessions.delete(userId);
        return;
    }
    
    await ctx.editMessageText(`✅ Отлично! Добавляю треки в очередь...`);
    
    const tracksToTake = isAll ? session.tracks.length : 10;
    const numberOfTracksToQueue = Math.min(tracksToTake, remainingLimit);
    const tracksToProcess = session.tracks.slice(0, numberOfTracksToQueue);
    
    // 🔥 ИСПОЛЬЗУЕМ НОВУЮ СИСТЕМУ (просто передаем URL в enqueue)
    for (const track of tracksToProcess) {
        const trackUrl = track.webpage_url || track.url;
        soundcloudEnqueue(ctx, userId, trackUrl);
    }
    
    let reportMessage = `⏳ ${tracksToProcess.length} трек(ов) добавлено в очередь.`;
    
    if (numberOfTracksToQueue < tracksToTake) {
        reportMessage += `\n\nℹ️ Ваш дневной лимит будет исчерпан. Остальные треки из плейлиста не были добавлены.`;
    }
    
    await ctx.reply(reportMessage);
    playlistSessions.delete(userId);
});

bot.action(/pl_select_manual:(.+)/, async (ctx) => {
    const userId = ctx.from.id;
    const playlistId = ctx.match[1];
    const session = playlistSessions.get(userId);
    
    if (!session || session.playlistId !== playlistId) {
        return await ctx.answerCbQuery('❗️ Сессия выбора истекла.', { show_alert: true });
    }
    
    if (!session.fullTracks) {
        await ctx.answerCbQuery('⏳ Загружаю названия треков...');
        await ctx.editMessageText('⏳ Получаю полные данные плейлиста... Это может занять несколько секунд.');
        
        try {
            const fullData = await ytdl(session.originalUrl, { 
                'dump-single-json': true,
                ...YTDL_COMMON 
            });
            
            session.tracks = fullData.entries.filter(track => track && track.url);
            session.fullTracks = true;
            
        } catch (e) {
            console.error('[Playlist] Ошибка при дозагрузке названий:', e);
            await ctx.editMessageText('❌ Не удалось получить детали плейлиста. Попробуйте снова или выберите другой вариант.');
            return await ctx.answerCbQuery('Ошибка!', { show_alert: true });
        }
    }
    
    session.currentPage = 0;
    session.selected = new Set();
    const menu = generateSelectionMenu(userId);
    if (menu) {
        try {
            await ctx.editMessageText(menu.text, menu.options);
        } catch (e) { /* Игнорируем */ }
    }
});

bot.action(/pl_page:(.+):(\d+)/, async (ctx) => {
    const [playlistId, pageStr] = ctx.match.slice(1);
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    
    if (!session || session.playlistId !== playlistId) {
        return await ctx.answerCbQuery('Сессия истекла.');
    }
    
    session.currentPage = parseInt(pageStr, 10);
    const menu = generateSelectionMenu(userId);
    if (menu) {
        try { 
            await ctx.editMessageText(menu.text, menu.options); 
        } catch (e) {}
    }
    await ctx.answerCbQuery();
});

bot.action(/pl_toggle:(.+):(\d+)/, async (ctx) => {
    const [playlistId, indexStr] = ctx.match.slice(1);
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    
    if (!session || session.playlistId !== playlistId) {
        return await ctx.answerCbQuery('Сессия истекла.');
    }
    
    const trackIndex = parseInt(indexStr, 10);
    if (session.selected.has(trackIndex)) {
        session.selected.delete(trackIndex);
    } else {
        session.selected.add(trackIndex);
    }
    
    const menu = generateSelectionMenu(userId);
    if (menu) {
        try { 
            await ctx.editMessageText(menu.text, menu.options); 
        } catch (e) {}
    }
    await ctx.answerCbQuery();
});

bot.action(/pl_finish:(.+)/, async (ctx) => {
    const playlistId = ctx.match[1];
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    
    if (!session) {
        return await ctx.answerCbQuery('❗️ Сессия выбора истекла.', { show_alert: true });
    }
    if (session.selected.size === 0) {
        return await ctx.answerCbQuery('Вы не выбрали ни одного трека.', { show_alert: true });
    }
    if (!session.fullTracks) {
        return await ctx.answerCbQuery('❌ Произошла ошибка: данные плейлиста не были загружены. Попробуйте заново.', { show_alert: true });
    }
    
    const user = await getUser(userId);
    const remainingLimit = user.premium_limit - (user.downloads_today || 0);
    
    if (remainingLimit <= 0) {
        const bonusAvailable = Boolean(CHANNEL_USERNAME && !user.subscribed_bonus_used);
        const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
        const bonusText = bonusAvailable
            ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.`
            : '';
        
        const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
        if (bonusAvailable) {
            extra.reply_markup = {
                inline_keyboard: [[ { text: '✅ Я подписался, забрать бонус', callback_data: 'check_subscription' } ]]
            };
        }
        
        await ctx.editMessageText(`${T('limitReached')}${bonusText}`, extra);
        playlistSessions.delete(userId);
        return;
    }
    
    await ctx.editMessageText(`✅ Готово! Добавляю ${session.selected.size} выбранных треков в очередь...`);
    
    const selectedIndexes = Array.from(session.selected);
    const numberOfTracksToQueue = Math.min(selectedIndexes.length, remainingLimit);
    const tracksToProcess = selectedIndexes.slice(0, numberOfTracksToQueue).map(index => session.tracks[index]);
    
    // 🔥 ИСПОЛЬЗУЕМ НОВУЮ СИСТЕМУ
    for (const track of tracksToProcess) {
        const trackUrl = track.webpage_url || track.url;
        soundcloudEnqueue(ctx, userId, trackUrl);
    }
    
    let reportMessage = `⏳ ${tracksToProcess.length} трек(ов) добавлено в очередь.`;
    if (numberOfTracksToQueue < selectedIndexes.length) {
        reportMessage += `\n\nℹ️ Ваш дневной лимит будет исчерпан. Остальные выбранные треки не были добавлены.`;
    }
    
    await ctx.reply(reportMessage);
    playlistSessions.delete(userId);
});

bot.action(/pl_cancel:(.+)/, async (ctx) => {
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    
    if (!session) {
        await ctx.deleteMessage().catch(() => {});
        return await ctx.answerCbQuery();
    }
    
    const message = `🎶 В плейлисте <b>"${session.title}"</b> найдено <b>${session.tracks.length}</b> треков.\n\nЧто делаем?`;
    const initialMenu = generateInitialPlaylistMenu(session.playlistId, session.tracks.length);
    
    try {
        await ctx.editMessageText(message, {
            parse_mode: 'HTML',
            ...initialMenu
        });
        await ctx.answerCbQuery('Возвращаю...');
    } catch (e) {
        await ctx.answerCbQuery();
    }
});

// bot.js

// ========================= URL HANDLER (МОДЕРНИЗИРОВАННАЯ ВЕРСИЯ) =========================
// bot.js (processUrlInBackground)

async function processUrlInBackground(ctx, url) {
    let loadingMessage;
    try {
        loadingMessage = await ctx.reply('🔍 Анализирую ссылку...');
        
        let data;
        try {
            // 🔥 ПРАВИЛЬНЫЙ API
            if (url.includes('/sets/')) {
                // Это плейлист
                const playlistInfo = await scdl.getSetInfo(url);
                
                data = {
                    title: playlistInfo.title,
                    entries: playlistInfo.tracks.map(track => ({
                        title: track.title,
                        url: track.permalink_url,
                        webpage_url: track.permalink_url,
                        id: track.id
                    }))
                };
            } else {
                // Это одиночный трек
                const trackInfo = await scdl.getInfo(url);
                
                data = {
                    title: trackInfo.title,
                    webpage_url: trackInfo.permalink_url,
                    entries: null
                };
            }
        } catch (scdlError) {
            console.error(`[scdl] Ошибка для ${url}:`, scdlError.message);
            throw new Error('Не удалось получить метаданные. Проверьте ссылку.');
        }
        
        // ===== ЕСЛИ ЭТО ПЛЕЙЛИСТ =====
        if (data.entries && data.entries.length > 1) {
            await ctx.deleteMessage(loadingMessage.message_id).catch(() => {});
            
            const playlistId = `pl_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            playlistSessions.set(ctx.from.id, {
                playlistId,
                title: data.title,
                tracks: data.entries,
                originalUrl: url,
                selected: new Set(),
                currentPage: 0,
                fullTracks: true // 🔥 Уже есть полная информация!
            });
            
            const message = `🎶 В плейлисте <b>"${escapeHtml(data.title)}"</b> найдено <b>${data.entries.length}</b> треков.\n\nЧто делаем?`;
            await ctx.reply(message, {
                parse_mode: 'HTML',
                ...generateInitialPlaylistMenu(playlistId, data.entries.length)
            });
            
            // ===== ЕСЛИ ЭТО ОДИНОЧНЫЙ ТРЕК =====
        } else {
            // Удаляем сообщение "Анализирую..."
            await ctx.deleteMessage(loadingMessage.message_id).catch(() => {});
            
            // 🔥 ПЕРЕДАЁМ УПРАВЛЕНИЕ downloadManager
            // Он сам всё сделает: проверит кеш, скачает, отправит
            soundcloudEnqueue(ctx, ctx.from.id, url);
        }
    } catch (error) {
        console.error('[processUrlInBackground] Ошибка:', error.message);
        
        const userMessage = '❌ Не удалось обработать ссылку. Убедитесь, что она корректна и доступна.';
        
        if (loadingMessage) {
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                loadingMessage.message_id,
                undefined,
                userMessage
            ).catch(() => {});
        } else {
            await ctx.reply(userMessage);
        }
    }
}

async function handleSoundCloudUrl(ctx, url) {
    // Просто запускаем фоновую обработку
    processUrlInBackground(ctx, url);
}
// ========================= URL HANDLER (УПРОЩЁННАЯ ВЕРСИЯ) =========================

bot.on('text', async (ctx) => {
    if (isShuttingDown()) {
        console.log('[Shutdown] Отклонен новый запрос.');
        return;
    }
    
    if (isMaintenanceMode() && ctx.from.id !== ADMIN_ID) {
        return await ctx.reply('⏳ Бот на обслуживании. Попробуйте через 5-10 минут.');
    }
    
    if (ctx.chat.type !== 'private') {
        console.log(`[Ignore] Сообщение из не-приватного чата.`);
        return;
    }
    
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    if (Object.values(allTextsSync()).includes(text)) return;
    
    const urlMatch = text.match(/(https?:\/\/[^\s]+)/g);
    if (!urlMatch) {
        return await ctx.reply('Пожалуйста, отправьте мне ссылку.');
    }
    
    const url = urlMatch[0];
    
    if (url.includes('soundcloud.com')) {
        // 🔥 ПРОСТО ПЕРЕДАЁМ В downloadManager (он всё сделает сам!)
        soundcloudEnqueue(ctx, ctx.from.id, url);
    } else if (url.includes('open.spotify.com')) {
        await ctx.reply('🛠 Скачивание из Spotify временно недоступно.');
    } else {
        await ctx.reply('Я умею скачивать треки из SoundCloud.');
    }
});

// ========================= EXPORTS =========================

export default bot;