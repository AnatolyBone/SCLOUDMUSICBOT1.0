// ======================= ФИНАЛЬНАЯ ВЕРСИЯ BOT.JS =======================

import { Telegraf, Markup, TelegramError } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ADMIN_ID, BOT_TOKEN, WEBHOOK_URL, CHANNEL_USERNAME, STORAGE_CHANNEL_ID, PROXY_URL } from './config.js';
import { updateUserField, getUser, createUser, setPremium, getAllUsers, resetDailyLimitIfNeeded, getCachedTracksCount, logUserAction, getTopFailedSearches, getTopRecentSearches, getNewUsersCount,findCachedTrack,           // <--- ДОБАВИТЬ
    incrementDownloadsAndSaveTrack, getReferrerInfo, getReferredUsers, getReferralStats} from './db.js';
import { T, allTextsSync } from './config/texts.js';
import { performInlineSearch } from './services/searchManager.js';
import { spotifyEnqueue } from './services/spotifyManager.js';
import { downloadQueue } from './services/downloadManager.js';
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
function addTaskToQueue(task) {
    setTimeout(() => {
        downloadQueue.add(task);
    }, 0);
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

function formatMenuMessage(user, botUsername) { // Добавили botUsername
    const tariffLabel = getTariffName(user.premium_limit);
    const downloadsToday = user.downloads_today || 0;
    const daysLeft = getDaysLeft(user.premium_until);
    const referralCount = user.referral_count || 0; // Получаем кол-во рефералов
    
    // Генерируем ссылку прямо здесь
    const referralLink = `https://t.me/${botUsername}?start=ref_${user.id}`;
    
    // Собираем основное сообщение
    let message = `
👋 Привет, ${user.first_name || 'пользователь'}!
<b>Твой профиль:</b>
💼 <b>Тариф:</b> <i>${tariffLabel}</i>
⏳ <b>Осталось дней подписки:</b> <i>${daysLeft}</i>
🎧 <b>Сегодня скачано:</b> <i>${downloadsToday}</i> из <i>${user.premium_limit}</i>
    `.trim();
    
    // Добавляем новый блок с реферальной информацией
    message += `

<hr>

🙋‍♂️ <b>Приглашено друзей:</b> <i>${referralCount}</i>
🔗 <b>Твоя ссылка для бонусов:</b>
<code>${referralLink}</code>`;
    
    // Добавляем блок с бонусом за подписку (если нужно)
    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
        const cleanUsername = CHANNEL_USERNAME.replace('@', '');
        const channelLink = `<a href="https://t.me/${cleanUsername}">наш канал</a>`;
        message += `\n\n🎁 <b>Бонус!</b> Подпишись на ${channelLink} и получи <b>+7 дней тарифа Plus</b> бесплатно!`;
    }
    
    message += '\n\nПросто отправь мне ссылку, и я скачаю трек!';
    return message;
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
            `   - Очередь: <i>${downloadQueue.size}</i> в ож. / <i>${downloadQueue.active}</i> в раб.\n` +
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
        ctx.reply('ℹ️ Статус: ' + (isMaintenanceMode ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН') + '\n\nИспользуйте: `/maintenance on` или `/maintenance off`');
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

bot.action(/pl_download_all:|pl_download_10:/, async (ctx) => {
    const isAll = ctx.callbackQuery.data.includes('pl_download_all');
    const playlistId = ctx.callbackQuery.data.split(':')[1];
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    if (!session) return await ctx.answerCbQuery('❗️ Сессия выбора истекла.', { show_alert: true });

    const user = await getUser(userId);
    let remainingLimit = user.premium_limit - (user.downloads_today || 0);
    if (remainingLimit <= 0) {
        await ctx.editMessageText(T('limitReached'));
        return playlistSessions.delete(userId);
    }
    
    await ctx.editMessageText(`✅ Отлично! Проверяю кэш и формирую очередь...`);

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
                await bot.telegram.sendAudio(userId, cached.fileId);
                await incrementDownloadsAndSaveTrack(userId, track.title, cached.fileId, url);
                sentFromCacheCount++;
                remainingLimit--;
            } catch (e) {
                if (e.description?.includes('FILE_REFERENCE_EXPIRED')) {
                    tasksToDownload.push(track); // Если кэш битый, ставим на скачивание
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
            metadata: { id: track.id, title: track.title, uploader: track.uploader, duration: track.duration, thumbnail: track.thumbnail }
        });
    }

    let reportMessage = '';
    if (sentFromCacheCount > 0) reportMessage += `✅ ${sentFromCacheCount} трек(ов) отправлено.\n`;
    if (tasksToReallyDownload.length > 0) reportMessage += `⏳ ${tasksToReallyDownload.length} трек(ов) добавлено в очередь на скачивание.`;
    
    // Если ничего не было сделано (например, все в кэше, но лимит 0), даем фидбэк
    if (!reportMessage) reportMessage = 'Все треки уже в кэше, но ваш дневной лимит исчерпан.';
    
    await ctx.reply(reportMessage);
    playlistSessions.delete(userId);
});

bot.action(/pl_select_manual:(.+)/, async (ctx) => {
    const playlistId = ctx.match[1];
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    if (!session || session.playlistId !== playlistId) return await ctx.answerCbQuery('❗️ Сессия выбора истекла.', { show_alert: true });
    session.currentPage = 0;
    session.selected = new Set();
    const menu = generateSelectionMenu(userId);
    if (menu) await ctx.editMessageText(menu.text, menu.options);
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

bot.action(/pl_finish:(.+)/, async (ctx) => {
    const playlistId = ctx.match[1];
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    if (!session) return await ctx.answerCbQuery('❗️ Сессия выбора истекла.', { show_alert: true });
    if (session.selected.size === 0) return await ctx.answerCbQuery('Вы не выбрали ни одного трека.', { show_alert: true });

    const user = await getUser(userId);
    let remainingLimit = user.premium_limit - (user.downloads_today || 0);
    if (remainingLimit <= 0) {
        await ctx.editMessageText(T('limitReached'));
        return playlistSessions.delete(userId);
    }
    
    await ctx.editMessageText(`✅ Готово! Проверяю кэш и формирую очередь...`);
    
    const selectedTracks = Array.from(session.selected).map(index => session.tracks[index]);

    let sentFromCacheCount = 0;
    const tasksToDownload = [];

    for (const track of selectedTracks) {
        if (remainingLimit <= 0) break;

        const url = track.webpage_url || track.url;
        const cached = await findCachedTrack(url);

        if (cached) {
            try {
                await bot.telegram.sendAudio(userId, cached.fileId);
                await incrementDownloadsAndSaveTrack(userId, track.title, cached.fileId, url);
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
            metadata: { id: track.id, title: track.title, uploader: track.uploader, duration: track.duration, thumbnail: track.thumbnail }
        });
    }
    
    let reportMessage = '';
    if (sentFromCacheCount > 0) reportMessage += `✅ ${sentFromCacheCount} трек(ов) отправлено.\n`;
    if (tasksToReallyDownload.length > 0) reportMessage += `⏳ ${tasksToReallyDownload.length} трек(ов) добавлено в очередь.`;
    if (!reportMessage) reportMessage = 'Все выбранные треки уже в кэше, но ваш дневной лимит исчерпан.';
    
    await ctx.reply(reportMessage);
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

// --- Главный обработчик ссылок ---
async function handleSoundCloudUrl(ctx, url) {
    let loadingMessage;
    try {
        loadingMessage = await ctx.reply('🔍 Анализирую ссылку... Это может занять некоторое время.');
        const youtubeDl = getYoutubeDl();
        const data = await youtubeDl(url, { dumpSingleJson: true });
        if (data.entries && data.entries.length > 0) {
            const validTracks = data.entries.filter(track => track && track.url);
            if (validTracks.length === 0) {
                return await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, '❌ В этом плейлисте не найдено доступных для скачивания треков.').catch(() => {});
            }
            await ctx.deleteMessage(loadingMessage.message_id).catch(() => {});
            const playlistId = data.id || `pl_${Date.now()}`;
            playlistSessions.set(ctx.from.id, {
                playlistId, title: data.title, tracks: validTracks,
                selected: new Set(), currentPage: 0
            });
            const message = `🎶 В плейлисте <b>"${data.title}"</b> найдено <b>${validTracks.length}</b> треков.\n\nЧто делаем?`;
            await ctx.reply(message, { parse_mode: 'HTML', ...generateInitialPlaylistMenu(playlistId, validTracks.length) });
        } else {
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, '✅ Распознал трек, ставлю в очередь...');
            addTaskToQueue({
                userId: ctx.from.id, source: 'soundcloud', url: data.webpage_url || url, originalUrl: data.webpage_url || url,
                metadata: { id: data.id, title: data.title, uploader: data.uploader, duration: data.duration, thumbnail: data.thumbnail }
            });
        }
    } catch (error) {
        console.error('Ошибка при обработке SoundCloud URL:', error.stderr || error.message);
        const userMessage = '❌ Не удалось обработать ссылку. Убедитесь, что она корректна и контент доступен.';
        if (loadingMessage) await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, userMessage).catch(() => {});
        else await ctx.reply(userMessage);
    }
}

bot.on('text', (ctx) => {
            if (isShuttingDown) {
                console.log('[Shutdown] Отклонен новый запрос, так как идет завершение работы.');
                return;
            }
            
            if (isMaintenanceMode && ctx.from.id !== ADMIN_ID) {
                return ctx.reply('⏳ Бот на плановом обслуживании. Новые запросы временно не принимаются. Пожалуйста, попробуйте через 5-10 минут.');
            }
            
            const text = ctx.message.text;
    if (text.startsWith('/')) return;
    if (Object.values(allTextsSync()).includes(text)) return;
    const urlMatch = text.match(/(https?:\/\/[^\s]+)/g);
    if (!urlMatch) return ctx.reply('Пожалуйста, отправьте мне ссылку.');
    const url = urlMatch[0];
    if (url.includes('soundcloud.com')) {
        handleSoundCloudUrl(ctx, url);
    } else if (url.includes('open.spotify.com')) {
        spotifyEnqueue(ctx, ctx.from.id, url);
    } else {
        ctx.reply('Я умею скачивать только с SoundCloud и Spotify.');
    }
});