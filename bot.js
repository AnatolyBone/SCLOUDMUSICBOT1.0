// ======================= ФИНАЛЬНАЯ ВЕРСИЯ BOT.JS =======================

import { Telegraf, Markup, TelegramError } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ADMIN_ID, BOT_TOKEN, WEBHOOK_URL, CHANNEL_USERNAME, STORAGE_CHANNEL_ID, PROXY_URL } from './config.js';
import { updateUserField, getUser, createUser, setPremium, getAllUsers, resetDailyLimitIfNeeded, getCachedTracksCount, logUserAction, getTopFailedSearches, getTopRecentSearches, getNewUsersCount,findCachedTrack,           // <--- ДОБАВИТЬ
    incrementDownloadsAndSaveTrack, getReferrerInfo, getReferredUsers, getReferralStats} from './db.js';
import { T, allTextsSync } from './config/texts.js';
import { performInlineSearch } from './services/searchManager.js';
import { spotifyEnqueue } from './services/spotifyManager.js';
import { downloadQueue, trackDownloadProcessor } from './services/downloadManager.js';
import execYoutubeDl from 'youtube-dl-exec';
import { handleReferralCommand, processNewUserReferral } from './services/referralManager.js';
import { isShuttingDown, isMaintenanceMode, setMaintenanceMode } from './services/appState.js';

// --- Глобальные переменные и хелперы ---
const playlistSessions = new Map();
const TRACKS_PER_PAGE = 5;

function getYoutubeDl() {
    const options = {};
    if (PROXY_URL) options.proxy = PROXY_URL;
    return (url, flags) => execYoutubeDl(url, flags, options);
}

/**
 * Асинхронно добавляет задачу в очередь, не блокируя основной поток.
 * Это позволяет боту мгновенно отвечать пользователю, а скачивание начинается в фоне.
 * @param {object} task - Объект задачи для downloadManager.
 */
// bot.js

// bot.js

async function addTaskToQueue(task) {
    try {
        // Получаем пользователя, чтобы узнать его лимит
        const user = await getUser(task.userId);
        // Задачи с большим priority выполняются раньше (Unlimited = 10000, Free = 5)
        const priority = user ? user.premium_limit : 5;
        
        console.log(`[Queue] Добавляю задачу для ${task.userId} с приоритетом ${priority}`);
        
        // Правильный вызов для p-queue:
        // Мы передаем ФУНКЦИЮ, которая будет вызвана, когда придет ее очередь
        downloadQueue.add(() => trackDownloadProcessor(task), { priority });
        
    } catch (e) {
        console.error(`[Queue] Ошибка при добавлении задачи в очередь для ${task.userId}:`, e);
    }
}
// --- Вспомогательные функции ---
async function isSubscribed(userId) {
    if (!CHANNEL_USERNAME) return false;
    try {
        const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, userId);
        return ['creator', 'administrator', 'member'].includes(member.status);
    } catch (e) {
        console.error(`Ошибка проверки подписки для ${userId} на ${CHANNEL_USERNAME}:`, e.message);
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

// bot.js

// bot.js

function formatMenuMessage(user, botUsername) {
    // 1. Сначала получаем все динамические данные (как и раньше)
    const tariffLabel = getTariffName(user.premium_limit);
    const downloadsToday = user.downloads_today || 0;
    const daysLeft = getDaysLeft(user.premium_until);
    const referralCount = user.referral_count || 0;
    const referralLink = `https://t.me/${botUsername}?start=ref_${user.id}`;
    
    // 2. Собираем основной блок статистики (он нередактируемый, т.к. это данные)
    const statsBlock = [
        `💼 <b>Тариф:</b> <i>${tariffLabel}</i>`,
        `⏳ <b>Осталось дней подписки:</b> <i>${daysLeft}</i>`,
        `🎧 <b>Сегодня скачано:</b> <i>${downloadsToday}</i> из <i>${user.premium_limit}</i>`
    ].join('\n');
    
    // 3. Берем шаблоны из T() и заменяем плейсхолдеры
    const header = T('menu_header').replace('{first_name}', user.first_name || 'пользователь');
    
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
    
    // 4. Собираем все части вместе, отфильтровывая пустые блоки
    const messageParts = [
        header,
        statsBlock,
        '\n- - - - - - - - - - - - - - -',
        referralBlock,
        bonusBlock, // Этот блок добавится, только если он не пустой
        footer
    ];
    
    return messageParts.filter(Boolean).join('\n\n');
}

// --- Инициализация Telegraf ---
const telegrafOptions = { handlerTimeout: 300_000 };
if (PROXY_URL) {
    const agent = new HttpsProxyAgent(PROXY_URL);
    telegrafOptions.telegram = { agent };
    console.log('[App] Использую прокси для подключения к Telegram API.');
}
export const bot = new Telegraf(BOT_TOKEN, telegrafOptions);

// --- Middleware ---
bot.catch(async (err, ctx) => {
    console.error(`🔴 [Telegraf Catch] Глобальная ошибка для update ${ctx.update.update_id}:`, err);
    if (err instanceof TelegramError && err.response?.error_code === 403) {
        if (ctx.from?.id) await updateUserField(ctx.from.id, 'active', false);
    }
});
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    ctx.state.user = user;
    if (user && user.active === false) return;
    await resetDailyLimitIfNeeded(ctx.from.id);
    return next();
});

// --- Обработчики команд и кнопок ---
// bot.js

bot.start(async (ctx) => {
    console.log(`[DEBUG] Checkpoint 1 (bot.start): startPayload = ${ctx.startPayload}`);
    // 1. Мы вызываем ТОЛЬКО getUser, передавая в него всю информацию, включая startPayload.
    // getUser сам разберется: если пользователя нет - создаст его с referrer_id, если есть - просто вернет.
    const user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.startPayload || null);
    
    // 2. Проверяем, действительно ли это новая регистрация.
    const isNewRegistration = (Date.now() - new Date(user.created_at).getTime()) < 5000;
    
    // 3. Если пользователь новый, запускаем всю логику для новичков.
    if (isNewRegistration) {
        // Логируем сам факт регистрации
        await logUserAction(ctx.from.id, 'registration');
        
        // Запускаем нашу новую реферальную логику.
        // Она сама проверит, есть ли у пользователя referrer_id, и начислит бонусы.
        await processNewUserReferral(user, ctx);
    }
    
    // 4. Отправляем приветственное сообщение.
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
        
        // Запускаем все запросы к базе параллельно для скорости
        const [
            users,
            cachedTracksCount,
            topFailed,
            topRecent,
            newUsersToday, // <-- Новый запрос
            newUsersWeek // <-- Новый запрос
        ] = await Promise.all([
            getAllUsers(true),
            getCachedTracksCount(),
            getTopFailedSearches(5),
            getTopRecentSearches(5),
            getNewUsersCount(1), // Получаем новых за 1 день
            getNewUsersCount(7) // Получаем новых за 7 дней
        ]);
        
        // --- Формируем статистику пользователей ---
        const totalUsers = users.length;
        const activeUsers = users.filter(u => u.active).length;
        const activeToday = users.filter(u => u.last_active && new Date(u.last_active).toDateString() === new Date().toDateString()).length;
        const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
        let storageStatusText = STORAGE_CHANNEL_ID ? '✅ Доступен' : '⚠️ Не настроен';
        
        // --- Собираем сообщение ---
        let statsMessage = `<b>📊 Статистика Бота</b>\n\n` +
            `<b>👤 Пользователи:</b>\n` +
            `   - Всего: <i>${totalUsers}</i>\n` +
            `   - Активных: <i>${activeUsers}</i>\n` +
            `   - <b>Новых за 24ч: <i>${newUsersToday}</i></b>\n` + // <-- Новая строка
            `   - <b>Новых за 7 дней: <i>${newUsersWeek}</i></b>\n` + // <-- Новая строка
            `   - Активных сегодня: <i>${activeToday}</i>\n\n` +
            `<b>📥 Загрузки:</b>\n   - Всего за все время: <i>${totalDownloads}</i>\n\n`;
        
        // Блок неудачных запросов
        if (topFailed.length > 0) {
            statsMessage += `---\n\n<b>🔥 Топ-5 неудачных запросов (всего):</b>\n`;
            topFailed.forEach((item, index) => {
                statsMessage += `${index + 1}. <code>${item.query.slice(0, 30)}</code> (искали <i>${item.search_count}</i> раз)\n`;
            });
            statsMessage += `\n`;
        }
        
        // Блок популярных запросов
        if (topRecent.length > 0) {
            statsMessage += `<b>📈 Топ-5 запросов (за 24 часа):</b>\n`;
            topRecent.forEach((item, index) => {
                statsMessage += `${index + 1}. <code>${item.query.slice(0, 30)}</code> (искали <i>${item.total}</i> раз)\n`;
            });
            statsMessage += `\n`;
        }
        
        // Системный блок
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
// bot.js

// ЗАМЕНИТЕ ВАШУ ВЕРСИЮ НА ЭТУ
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
        // =====> ВОТ ИСПРАВЛЕНИЕ <=====
        ctx.reply('ℹ️ Статус: ' + (isMaintenanceMode ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН') + '\n\nИспользуйте: `/maintenance on` или `/maintenance off`'); // ПРАВИЛЬНО
}
});
bot.command('premium', (ctx) => ctx.reply(T('upgradeInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));
// bot.js

bot.hears(T('menu'), async (ctx) => {
    // 1. Получаем пользователя. Наша новая функция getUser теперь вернет и user.referral_count
    const user = await getUser(ctx.from.id);

    // 2. Вызываем обновленную formatMenuMessage, передавая ей объект user и имя бота
    const message = formatMenuMessage(user, ctx.botInfo.username);

    // 3. Остальная логика остается без изменений
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
        if (!user.tracks_today || user.tracks_today.length === 0) return await ctx.reply(T('noTracks'));
        for (let i = 0; i < user.tracks_today.length; i += 10) {
            const chunk = user.tracks_today.slice(i, i + 10).filter(t => t && t.fileId);
            if (chunk.length > 0) await ctx.replyWithMediaGroup(chunk.map(t => ({ type: 'audio', media: t.fileId })));
        }
    } catch (e) { console.error(`🔴 Ошибка в mytracks для ${ctx.from.id}:`, e.message); }
});
bot.hears(T('help'), (ctx) => ctx.reply(T('helpInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));
bot.hears(T('upgrade'), (ctx) => ctx.reply(T('upgradeInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));
bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query;
    if (!query || query.trim().length < 2) return await ctx.answerInlineQuery([], { switch_pm_text: 'Введите название трека для поиска...', switch_pm_parameter: 'start' });
    try {
        const results = await performInlineSearch(query, ctx.from.id);
        await ctx.answerInlineQuery(results, { cache_time: 60 });
    } catch (error) {
        console.error('[Inline Query] Глобальная ошибка:', error);
        await ctx.answerInlineQuery([]);
    }
});

// --- Логика обработки плейлистов ---
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

// --- Обработчики кнопок плейлистов (actions) ---
bot.action('pl_nop', (ctx) => ctx.answerCbQuery());

// bot.js

bot.action(/pl_download_all:|pl_download_10:/, async (ctx) => {
    const isAll = ctx.callbackQuery.data.includes('pl_download_all');
    const playlistId = ctx.callbackQuery.data.split(':')[1];
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    if (!session) return await ctx.answerCbQuery('❗️ Сессия выбора истекла.', { show_alert: true });

    // =====> ГЛАВНОЕ ИСПРАВЛЕНИЕ: БЛОК "ДОЗАГРУЗКИ" ДАННЫХ <=====
    // Проверяем, есть ли у нас полные данные. Если нет - дозагружаем.
    if (!session.fullTracks) {
        // Уведомляем пользователя, что процесс может занять время
        await ctx.answerCbQuery('⏳ Получаю полные данные плейлиста...');
        await ctx.editMessageText('⏳ Получаю полные данные плейлиста... Это может занять несколько секунд.');
        
        try {
            const youtubeDl = getYoutubeDl();
            // Запускаем медленный анализ, чтобы получить полные данные с названиями
            const fullData = await youtubeDl(session.originalUrl, { dumpSingleJson: true });
            
            // Обновляем треки в сессии на полные
            session.tracks = fullData.entries.filter(track => track && track.url);
            session.fullTracks = true; // Ставим флаг, что данные теперь полные
        } catch (e) {
            console.error('[Playlist] Ошибка при дозагрузке названий:', e);
            await ctx.editMessageText('❌ Не удалось получить детали плейлиста.');
            await ctx.answerCbQuery('Ошибка!', { show_alert: true });
            return;
        }
    }
    // =================================================================

    const user = await getUser(userId);
    let remainingLimit = user.premium_limit - (user.downloads_today || 0);
    if (remainingLimit <= 0) {
        await ctx.editMessageText(T('limitReached'));
        return playlistSessions.delete(userId);
    }
    
    await ctx.editMessageText(`✅ Отлично! Проверяю и формирую очередь...`);

    const tracksToTake = isAll ? session.tracks.length : 10;
    const tracksToProcess = session.tracks.slice(0, tracksToTake);

    let sentFromCacheCount = 0;
    const tasksToDownload = [];

    for (const track of tracksToProcess) {
        if (remainingLimit <= 0) break;

        const url = track.webpage_url || track.url;
        const cached = await findCachedTrack(url);

        if (cached) {
            try {
                // ВАЖНО: берем название из кэша, т.к. оно там точно есть
                await ctx.telegram.sendAudio(userId, cached.fileId, { title: cached.title, performer: cached.artist });
                await incrementDownloadsAndSaveTrack(userId, cached.title, cached.fileId, url);
                sentFromCacheCount++;
                remainingLimit--;
            } catch (e) {
                if (e.description?.includes('FILE_REFERENCE_EXPIRED')) {
                    tasksToDownload.push(track);
                } else {
                    console.error(`Ошибка отправки из кэша для ${userId}:`, e.message);
                }
            }
        } else {
            tasksToDownload.push(track);
        }
    }
    
    const tasksToReallyDownload = tasksToDownload.slice(0, remainingLimit);
    for (const track of tasksToReallyDownload) {
        addTaskToQueue({
            userId, source: 'soundcloud', url: track.webpage_url || track.url, originalUrl: track.webpage_url || track.url,
            metadata: { id: track.id, title: track.title, uploader: track.uploader, duration: track.duration, thumbnail: track.thumbnail }, 
            ctx: ctx
        });
    }

    let reportMessage = '';
    if (sentFromCacheCount > 0) reportMessage += `✅ ${sentFromCacheCount} трек(ов) отправлено.\n`;
    if (tasksToReallyDownload.length > 0) reportMessage += `⏳ ${tasksToReallyDownload.length} трек(ов) добавлено в очередь на скачивание.`;
    
    if (!reportMessage) {
        reportMessage = tracksToProcess.length > 0
            ? 'Все треки уже были отправлены, либо ваш дневной лимит исчерпан.'
            : 'В плейлисте нет треков для обработки.';
    }
    
    // Отправляем финальный отчет отдельным сообщением, чтобы не затирать меню
    await ctx.reply(reportMessage);
    playlistSessions.delete(userId);
});
// bot.js

bot.action(/pl_select_manual:(.+)/, async (ctx) => {
    const userId = ctx.from.id;
    const playlistId = ctx.match[1];
    const session = playlistSessions.get(userId);
    
    if (!session || session.playlistId !== playlistId) {
        return await ctx.answerCbQuery('❗️ Сессия выбора истекла.', { show_alert: true });
    }
    
    // Проверяем, есть ли у нас уже полные данные с названиями
    if (!session.fullTracks) {
        await ctx.answerCbQuery('⏳ Загружаю названия треков...');
        try {
            const youtubeDl = getYoutubeDl();
            // Запускаем медленный анализ, чтобы получить полные данные
            const fullData = await youtubeDl(session.originalUrl, { dumpSingleJson: true });
            
            // Обновляем треки в сессии на полные
            session.tracks = fullData.entries.filter(track => track && track.url);
            session.fullTracks = true; // Ставим флаг, что данные загружены
        } catch (e) {
            console.error('[Playlist] Ошибка при дозагрузке названий:', e);
            await ctx.answerCbQuery('❌ Не удалось получить детали плейлиста.', { show_alert: true });
            return;
        }
    }
    
    // Сбрасываем состояние выбора и показываем меню
    session.currentPage = 0;
    session.selected = new Set();
    const menu = generateSelectionMenu(userId);
    if (menu) {
        try {
            await ctx.editMessageText(menu.text, menu.options);
        } catch (e) { /* Игнорируем ошибку, если сообщение не изменилось */ }
    }
});

bot.action(/pl_page:(.+):(\d+)/, async (ctx) => {
    const [playlistId, pageStr] = ctx.match.slice(1);
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    if (!session || session.playlistId !== playlistId) return await ctx.answerCbQuery('Сессия истекла.');
    session.currentPage = parseInt(pageStr, 10);
    const menu = generateSelectionMenu(userId);
    if (menu) try { await ctx.editMessageText(menu.text, menu.options); } catch (e) {}
    await ctx.answerCbQuery();
});

bot.action(/pl_toggle:(.+):(\d+)/, async (ctx) => {
    const [playlistId, indexStr] = ctx.match.slice(1);
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    if (!session || session.playlistId !== playlistId) return await ctx.answerCbQuery('Сессия истекла.');
    const trackIndex = parseInt(indexStr, 10);
    if (session.selected.has(trackIndex)) session.selected.delete(trackIndex);
    else session.selected.add(trackIndex);
    const menu = generateSelectionMenu(userId);
    if (menu) try { await ctx.editMessageText(menu.text, menu.options); } catch (e) {}
    await ctx.answerCbQuery();
});

// bot.js

bot.action(/pl_finish:(.+)/, async (ctx) => {
    const playlistId = ctx.match[1];
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    if (!session) return await ctx.answerCbQuery('❗️ Сессия выбора истекла.', { show_alert: true });
    
    // Проверяем, были ли выбраны треки
    if (session.selected.size === 0) {
        return await ctx.answerCbQuery('Вы не выбрали ни одного трека.', { show_alert: true });
    }

    // Проверяем, что у нас есть полные данные (защита от ошибок)
    if (!session.fullTracks) {
        return await ctx.answerCbQuery('❌ Произошла ошибка: данные плейлиста не были загружены. Попробуйте заново.', { show_alert: true });
    }
    
    // Сразу меняем сообщение, чтобы пользователь видел, что процесс пошел
    await ctx.editMessageText(`✅ Готово! Обрабатываю ${session.selected.size} выбранных треков...`);
    
    const user = await getUser(userId);
    let remainingLimit = user.premium_limit - (user.downloads_today || 0);
    if (remainingLimit <= 0) {
        // Отправляем отдельное сообщение, так как editMessageText уже был использован
        await ctx.reply(T('limitReached'));
        return playlistSessions.delete(userId);
    }
    
    const selectedTracks = Array.from(session.selected).map(index => session.tracks[index]);

    const tasksToDownload = [];
    let sentCount = 0; // Общий счетчик отправленных треков

    for (const track of selectedTracks) {
        if (remainingLimit <= 0) break;

        const url = track.webpage_url || track.url;
        const cached = await findCachedTrack(url);

        if (cached) {
            try {
                await ctx.telegram.sendAudio(userId, cached.fileId, { title: cached.title, performer: cached.artist });
                await incrementDownloadsAndSaveTrack(userId, cached.title, cached.fileId, url);
                sentCount++;
                remainingLimit--;
            } catch (e) {
                if (e.description?.includes('FILE_REFERENCE_EXPIRED')) {
                    tasksToDownload.push(track);
                } else {
                    console.error(`Ошибка отправки из кэша для ${userId}:`, e.message);
                }
            }
        } else {
            tasksToDownload.push(track);
        }
    }
    
    const tasksToReallyDownload = tasksToDownload.slice(0, remainingLimit);
    for (const track of tasksToReallyDownload) {
        addTaskToQueue({
            userId, source: 'soundcloud', url: track.webpage_url || track.url, originalUrl: track.webpage_url || track.url,
            metadata: { id: track.id, title: track.title, uploader: track.uploader, duration: track.duration, thumbnail: track.thumbnail }, 
            ctx: ctx
        });
    }
    
    const totalTasks = sentCount + tasksToReallyDownload.length;
    
    // Отправляем единое, простое сообщение в конце
    if (totalTasks > 0) {
        await ctx.reply(`Отлично! ${totalTasks} трек(ов) уже отправлено или поставлено в очередь на скачивание.`);
    } else {
        await ctx.reply('Не удалось обработать выбранные треки. Возможно, ваш дневной лимит исчерпан.');
    }
    
    playlistSessions.delete(userId);
});
bot.action(/pl_cancel:(.+)/, async (ctx) => {
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    
    // Если по какой-то причине сессии уже нет, просто удаляем сообщение
    if (!session) {
        await ctx.deleteMessage().catch(() => {});
        return await ctx.answerCbQuery();
    }
    
    // Восстанавливаем текст и кнопки первоначального меню
    const message = `🎶 В плейлисте <b>"${session.title}"</b> найдено <b>${session.tracks.length}</b> треков.\n\nЧто делаем?`;
    const initialMenu = generateInitialPlaylistMenu(session.playlistId, session.tracks.length);
    
    // Редактируем текущее сообщение, возвращая его к исходному виду
    try {
        await ctx.editMessageText(message, {
            parse_mode: 'HTML',
            ...initialMenu
        });
        await ctx.answerCbQuery('Возвращаю...');
    } catch (e) {
        // Если сообщение не изменилось, просто игнорируем ошибку
        await ctx.answerCbQuery();
    }
});

// ===================================================================
// ВСТАВЬ ЭТОТ КОД ВМЕСТО СТАРОЙ ФУНКЦИИ handleSoundCloudUrl
// ===================================================================

// ЭТО НОВАЯ ФУНКЦИЯ-"ПОМОЩНИК", КОТОРАЯ БУДЕТ РАБОТАТЬ В ФОНЕ
async function processUrlInBackground(ctx, url) {
    let loadingMessage;
    try {
        // Отправляем сообщение о начале анализа
        loadingMessage = await ctx.reply('🔍 Анализирую ссылку...');
        const youtubeDl = getYoutubeDl();
        
        // Та самая долгая операция. Теперь она выполняется здесь, в фоне.
        const data = await youtubeDl(url, { dumpSingleJson: true, flatPlaylist: true });
        
        // --- ЭТО ПЛЕЙЛИСТ ---
        if (data.entries && data.entries.length > 0) {
            // Удаляем сообщение "Анализирую..."
            await ctx.deleteMessage(loadingMessage.message_id).catch(() => {});
            
            const playlistId = data.id || `pl_${Date.now()}`;
            playlistSessions.set(ctx.from.id, {
                playlistId,
                title: data.title,
                tracks: data.entries,
                originalUrl: url,
                selected: new Set(),
                currentPage: 0,
                fullTracks: false
            });
            const message = `🎶 В плейлисте <b>"${data.title}"</b> найдено <b>${data.entries.length}</b> треков.\n\nЧто делаем?`;
            await ctx.reply(message, { parse_mode: 'HTML', ...generateInitialPlaylistMenu(playlistId, data.entries.length) });
            
            // --- ЭТО ОДИНОЧНЫЙ ТРЕК ---
        } else {
            const user = await getUser(ctx.from.id);
            if (user.downloads_today >= user.premium_limit) {
                await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, T('limitReached'));
                return;
            }
            
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, '✅ Распознал трек, ставлю в очередь...');
            
            // Удаляем сообщение "ставлю в очередь..." через 3 секунды для чистоты чата
            setTimeout(() => ctx.deleteMessage(loadingMessage.message_id).catch(() => {}), 3000);
            
            addTaskToQueue({
                userId: ctx.from.id,
                source: 'soundcloud',
                url: data.webpage_url || url,
                originalUrl: data.webpage_url || url,
                metadata: { id: data.id, title: data.title, uploader: data.uploader, duration: data.duration, thumbnail: data.thumbnail },
                ctx: null // ctx больше не передаем в очередь
            });
        }
    } catch (error) {
        console.error('Ошибка при фоновой обработке URL:', error.stderr || error.message);
        const userMessage = '❌ Не удалось обработать ссылку. Убедитесь, что она корректна и контент доступен.';
        if (loadingMessage) {
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, userMessage).catch(() => {});
        } else {
            await ctx.reply(userMessage);
        }
    }
}

// ЭТО ОСНОВНАЯ ФУНКЦИЯ - ТЕПЕРЬ ОНА ОЧЕНЬ БЫСТРАЯ
async function handleSoundCloudUrl(ctx, url) {
    // 1. Сначала быстро проверяем кэш. Это мгновенная операция.
    const cached = await findCachedTrack(url);
    if (cached) {
        console.log(`[Cache] Отправляю трек ${cached.title || ''} из кэша для ${ctx.from.id}`);
        try {
            await ctx.telegram.sendAudio(ctx.from.id, cached.fileId);
            return; // Если нашли в кэше - выходим.
        } catch (e) {
            console.warn(`[Cache] Ошибка отправки из кэша: ${e.message}. Продолжаем скачивание...`);
        }
    }
    
    // 2. Если в кэше нет - запускаем тяжелую обработку В ФОНЕ.
    // Мы НЕ используем `await` здесь. Это "выстрелил и забыл".
    // Функция `handleSoundCloudUrl` не будет ждать завершения `processUrlInBackground`.
    processUrlInBackground(ctx, url);
    
    // 3. Основная функция `handleSoundCloudUrl` на этом завершается.
    // Telegraf получает ответ мгновенно, и таймаута не происходит.
}
bot.on('text', async (ctx) => {
                // =====> ПРАВИЛЬНЫЙ ВАРИАНТ <=====
                if (isShuttingDown) { // ПРАВИЛЬНО: скобок нет
                    console.log('[Shutdown] Отклонен новый запрос, так как идет завершение работы.');
                    return;
                }
                
                // =====> ПРАВИЛЬНЫЙ ВАРИАНТ <=====
                if (isMaintenanceMode && ctx.from.id !== ADMIN_ID) { // ПРАВИЛЬНО: и здесь тоже нет
                    return await ctx.reply('⏳ Бот на плановом обслуживании. Новые запросы временно не принимаются. Пожалуйста, попробуйте через 5-10 минут.');
                }
    if (ctx.chat.type !== 'private') {
        console.log(`[Ignore] Сообщение из не-приватного чата (${ctx.chat.type}) было проигнорировано.`);
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
        handleSoundCloudUrl(ctx, url);
    } else if (url.includes('open.spotify.com')) {
        spotifyEnqueue(ctx, ctx.from.id, url);
    } else {
        await ctx.reply('Я умею скачивать только с SoundCloud и Spotify.');
    }
});