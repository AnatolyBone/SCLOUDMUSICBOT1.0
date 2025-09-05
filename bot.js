import { Telegraf, Markup, TelegramError } from 'telegraf';
import { ADMIN_ID, BOT_TOKEN, WEBHOOK_URL, CHANNEL_USERNAME, STORAGE_CHANNEL_ID, PROXY_URL } from './config.js'; // Убедитесь, что PROXY_URL импортирован
import { updateUserField, getUser, createUser, setPremium, getAllUsers, resetDailyLimitIfNeeded, getCachedTracksCount, logUserAction, getTopFailedSearches, getTopRecentSearches, getNewUsersCount } from './db.js';
import { T, allTextsSync } from './config/texts.js';
import { performInlineSearch } from './services/searchManager.js';
import { spotifyEnqueue } from './services/spotifyManager.js';
import { enqueue, downloadQueue } from './services/downloadManager.js';
// ======================= НОВЫЙ ИМПОРТ =======================
import execYoutubeDl from 'youtube-dl-exec';

// ======================= НОВЫЕ ПЕРЕМЕННЫЕ И ФУНКЦИИ =======================

// Простое in-memory хранилище для сессий выбора плейлистов
// Ключ - userId, Значение - объект сессии
const playlistSessions = new Map();

// Регулярное выражение для плейлистов SoundCloud
const SOUNDCLOUD_PLAYLIST_REGEX = /soundcloud\.com\/([\w-]+)\/sets\/([\w-]+)/i;

// Хелпер для получения инстанса youtube-dl-exec с прокси
function getYoutubeDl() {
    const options = {};
    if (PROXY_URL) {
        options.proxy = PROXY_URL;
    }
    return (url, flags) => execYoutubeDl(url, flags, options);
}

// ======================= КОНЕЦ НОВЫХ ПЕРЕМЕННЫХ =======================


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

function formatMenuMessage(user, ctx) {
    const tariffLabel = getTariffName(user.premium_limit);
    const downloadsToday = user.downloads_today || 0;
    const daysLeft = getDaysLeft(user.premium_until);

    let message = `
👋 Привет, ${user.first_name || 'пользователь'}!
<b>Твой профиль:</b>
💼 <b>Тариф:</b> <i>${tariffLabel}</i>
⏳ <b>Осталось дней подписки:</b> <i>${daysLeft}</i>
🎧 <b>Сегодня скачано:</b> <i>${downloadsToday}</i> из <i>${user.premium_limit}</i>
    `.trim();

    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
        const cleanUsername = CHANNEL_USERNAME.replace('@', '');
        const channelLink = `<a href="https://t.me/${cleanUsername}">наш канал</a>`;
        message += `\n\n🎁 <b>Бонус!</b> Подпишись на ${channelLink} и получи <b>7 дней тарифа Plus</b> бесплатно!`;
    }

    message += '\n\nПросто отправь мне ссылку, и я скачаю трек!';
    return message;
}

async function handleSendMessageError(e, userId, ctx = null) {
    console.error(`🔴 Ошибка при работе с пользователем ${userId}:`, e.message);
    if (e instanceof TelegramError && e.response?.error_code === 403) {
        await updateUserField(userId, 'active', false);
        console.log(`- Пользователь ${userId} заблокировал бота.`);
    } else if (ctx) {
        try { await ctx.reply('Произошла ошибка при выполнении вашего запроса.'); } catch (sendError) {}
    }
}

export const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 300_000 });

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
    if (user && user.active === false) {
        console.log(`[Access Denied] Заблокированный пользователь ${ctx.from.id} попытался использовать бота.`);
        ctx.reply(T('blockedMessage'), { parse_mode: 'HTML' }).catch(() => {});
        return; 
    }
    await resetDailyLimitIfNeeded(ctx.from.id);
    return next();
});

bot.start(async (ctx) => {
    await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.startPayload || null);
    const user = ctx.state.user;
    const isNewRegistration = (Date.now() - new Date(user.created_at).getTime()) < 5000;

    if (isNewRegistration) {
        await logUserAction(ctx.from.id, 'registration');
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
        
        const [
            users,
            cachedTracksCount,
            topFailed,
            topRecent,
            newUsersToday, 
            newUsersWeek
        ] = await Promise.all([
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
            `   - Очередь: <i>${downloadQueue.size}</i> в ож. / <i>${downloadQueue.active}</i> в раб.\n` +
            `   - Канал-хранилище: <i>${storageStatusText}</i>\n   - Треков в кэше: <i>${cachedTracksCount}</i>\n\n` +
            `<b>🔗 Админ-панель:</b>\n<a href="${WEBHOOK_URL.replace(/\/$/, '')}/dashboard">Открыть дашборд</a>`;
        
        await ctx.reply(statsMessage, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
        console.error('❌ Ошибка в команде /admin:', e);
        await ctx.reply('❌ Не удалось собрать статистику.');
    }
});

bot.command('premium', async (ctx) => {
    await ctx.reply(T('upgradeInfo'), { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.action('check_subscription', async (ctx) => {
    const user = await getUser(ctx.from.id);
    if (user.subscribed_bonus_used) {
        return await ctx.answerCbQuery('Вы уже использовали этот бонус.', { show_alert: true });
    }
    const subscribed = await isSubscribed(ctx.from.id);
    if (subscribed) {
        await setPremium(ctx.from.id, 30, 7); 
        await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
        await logUserAction(ctx.from.id, 'bonus_received');
        await ctx.editMessageText('🎉 Поздравляем! Вам начислено 7 дней тарифа Plus. Спасибо за подписку!');
    } else {
        await ctx.answerCbQuery(`Вы еще не подписаны. Пожалуйста, подпишитесь и нажмите кнопку снова.`, { show_alert: true });
    }
});

bot.hears(T('menu'), async (ctx) => {
    const user = await getUser(ctx.from.id);
    const message = formatMenuMessage(user, ctx);
    const extraOptions = { 
        parse_mode: 'HTML',
        disable_web_page_preview: true
    };
    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
        extraOptions.reply_markup = { inline_keyboard: [[ Markup.button.callback('✅ Я подписался и хочу бонус!', 'check_subscription') ]] };
    }
    await ctx.reply(message, extraOptions);
});

bot.hears(T('mytracks'), async (ctx) => {
    try {
        const user = await getUser(ctx.from.id);
        const tracks = user.tracks_today;
        if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
            return await ctx.reply(T('noTracks'));
        }
        for (let i = 0; i < tracks.length; i += 10) {
            const chunk = tracks.slice(i, i + 10).filter(t => t && t.fileId);
            if (chunk.length > 0) {
                await ctx.replyWithMediaGroup(chunk.map(t => ({ type: 'audio', media: t.fileId })));
            }
        }
    } catch (e) {
        await handleSendMessageError(e, ctx.from.id, ctx);
    }
});

bot.hears(T('help'), async (ctx) => await ctx.reply(T('helpInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));
bot.hears(T('upgrade'), async (ctx) => await ctx.reply(T('upgradeInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));

bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query;
    if (!query || query.trim().length < 2) {
        return await ctx.answerInlineQuery([], {
            switch_pm_text: 'Введите название трека для поиска...',
            switch_pm_parameter: 'start',
        });
    }
    try {
        const results = await performInlineSearch(query, ctx.from.id);
        await ctx.answerInlineQuery(results, { cache_time: 60 });
    } catch (error) {
        console.error('[Inline Query] Глобальная ошибка обработчика:', error);
        await ctx.answerInlineQuery([]);
    }
});

// ======================= НОВЫЕ ОБРАБОТЧИКИ ДЛЯ ПЛЕЙЛИСТОВ =======================

// Обработчик кнопки "Скачать первые 10"
// Обработчик кнопки "Скачать первые 10"
bot.action(/pl_download_10:(.+)/, async (ctx) => {
    const playlistId = ctx.match[1];
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    
    if (!session || session.playlistId !== playlistId) {
        return await ctx.answerCbQuery('❗️ Сессия выбора истекла. Пожалуйста, отправьте ссылку на плейлист заново.', { show_alert: true });
    }
    
    // Перед добавлением в очередь, проверим лимиты пользователя
    await resetDailyLimitIfNeeded(userId);
    const user = await getUser(userId);
    const remainingLimit = user.premium_limit - user.downloads_today;
    
    if (remainingLimit <= 0) {
        await ctx.editMessageText(T('limitReached'), { parse_mode: 'HTML' });
        playlistSessions.delete(userId); // Очищаем сессию
        return;
    }
    
    const tracksFromPlaylist = session.tracks.slice(0, 10);
    // Берем не больше, чем позволяет оставшийся лимит
    const tracksToProcess = tracksFromPlaylist.slice(0, remainingLimit);
    
    if (tracksToProcess.length === 0) {
        await ctx.editMessageText('Все треки из этой сессии уже не помещаются в ваш дневной лимит.');
        playlistSessions.delete(userId);
        return;
    }
    
    let message = `✅ Отлично! Ставлю ${tracksToProcess.length} трек(ов) в очередь на скачивание...`;
    if (tracksToProcess.length < tracksFromPlaylist.length) {
        message += `\n(Остальные не поместились в ваш дневной лимит)`
    }
    await ctx.editMessageText(message);
    
    // НАПРЯМУЮ добавляем задачи в очередь, минуя enqueue
    for (const track of tracksToProcess) {
        // Формируем задачу в том же формате, который ожидает trackDownloadProcessor
        const task = {
            userId: userId,
            source: 'soundcloud',
            url: track.url, // URL для скачивания
            originalUrl: track.url, // URL для ключа кэша
            metadata: {
                id: track.id,
                title: track.title || 'Unknown Title',
                uploader: track.uploader || 'Unknown Artist',
                duration: track.duration,
                thumbnail: track.thumbnail,
            }
        };
        downloadQueue.add(task); // Используем метод .add() из вашего TaskQueue
    }
    
    // Очищаем сессию после использования
    playlistSessions.delete(userId);
});
// Обработчик кнопки "Выбрать треки вручную" (пока что заглушка)
// ======================= КОД ДЛЯ РУЧНОГО ВЫБОРА ТРЕКОВ (ВСТАВИТЬ В BOT.JS) =======================

const ITEMS_PER_PAGE = 5; // Количество треков на одной странице выбора

/**
 * Генерирует интерактивное меню для выбора треков с пагинацией.
 * @param {number} userId ID пользователя, для которого генерируется меню.
 * @returns {object} Готовый объект с текстом и клавиатурой для отправки/редактирования.
 */
function generateSelectionMenu(userId) {
    const session = playlistSessions.get(userId);
    if (!session) return null;
    
    const { tracks, selected, currentPage, playlistId, title } = session;
    const totalPages = Math.ceil(tracks.length / ITEMS_PER_PAGE);
    
    // Определяем, какие треки показывать на текущей странице
    const startIndex = currentPage * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const tracksOnPage = tracks.slice(startIndex, endIndex);
    
    // Формируем ряды кнопок с треками
    const trackRows = tracksOnPage.map((track, index) => {
        const absoluteIndex = startIndex + index;
        const isSelected = selected.has(absoluteIndex);
        const icon = isSelected ? '✅' : '⬜️';
        // Ограничиваем длину названия трека, чтобы он поместился в кнопку
        const trackTitle = track.title.length > 50 ? track.title.slice(0, 47) + '...' : track.title;
        
        return [Markup.button.callback(`${icon} ${trackTitle}`, `pl_toggle:${playlistId}:${absoluteIndex}`)];
    });
    
    // Формируем ряд кнопок навигации
    const navRow = [];
    if (currentPage > 0) {
        navRow.push(Markup.button.callback('⬅️ Назад', `pl_page:${playlistId}:${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`Страница ${currentPage + 1}/${totalPages}`, 'pl_ignore')); // Кнопка-счетчик
    if (currentPage < totalPages - 1) {
        navRow.push(Markup.button.callback('Вперед ➡️', `pl_page:${playlistId}:${currentPage + 1}`));
    }
    
    // Формируем ряд с кнопкой "Готово"
    const actionRow = [
        Markup.button.callback(`✅ Готово (${selected.size} выбрано)`, `pl_done:${playlistId}`)
    ];
    
    const messageText = `🎶 <b>${title}</b>\n\nВыберите треки для скачивания:`;
    
    return {
        text: messageText,
        extra: {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                ...trackRows,
                navRow,
                actionRow
            ])
        }
    };
}

// Пустышка, чтобы Telegram не показывал "часики" на кнопке со счетчиком страниц
bot.action('pl_ignore', (ctx) => ctx.answerCbQuery());

// Обработчик, который ЗАПУСКАЕТ ручной выбор
bot.action(/pl_select_manual:(.+)/, async (ctx) => {
    const playlistId = ctx.match[1];
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    
    if (!session || session.playlistId !== playlistId) {
        return await ctx.answerCbQuery('❗️ Сессия выбора истекла. Пожалуйста, отправьте ссылку заново.', { show_alert: true });
    }
    
    const menu = generateSelectionMenu(userId);
    if (menu) {
        await ctx.editMessageText(menu.text, menu.extra);
    }
});

// Обработчик ПЕРЕКЛЮЧЕНИЯ СТРАНИЦ
bot.action(/pl_page:(.+):(\d+)/, async (ctx) => {
    const [playlistId, pageStr] = ctx.match.slice(1);
    const newPage = parseInt(pageStr, 10);
    const userId = ctx.from.id;
    
    const session = playlistSessions.get(userId);
    if (!session || session.playlistId !== playlistId) return await ctx.answerCbQuery('Сессия истекла.');
    
    session.currentPage = newPage;
    const menu = generateSelectionMenu(userId);
    if (menu) {
        // Используем try-catch, т.к. пользователь может спамить кнопки, и сообщение не изменится
        try {
            await ctx.editMessageText(menu.text, menu.extra);
        } catch (e) { /* ignore */ }
    }
    await ctx.answerCbQuery();
});

// Обработчик ВЫБОРА/СНЯТИЯ ВЫБОРА трека
bot.action(/pl_toggle:(.+):(\d+)/, async (ctx) => {
    const [playlistId, indexStr] = ctx.match.slice(1);
    const trackIndex = parseInt(indexStr, 10);
    const userId = ctx.from.id;
    
    const session = playlistSessions.get(userId);
    if (!session || session.playlistId !== playlistId) return await ctx.answerCbQuery('Сессия истекла.');
    
    // Логика "переключателя"
    if (session.selected.has(trackIndex)) {
        session.selected.delete(trackIndex);
    } else {
        session.selected.add(trackIndex);
    }
    
    const menu = generateSelectionMenu(userId);
    if (menu) {
        try {
            await ctx.editMessageText(menu.text, menu.extra);
        } catch (e) { /* ignore */ }
    }
    await ctx.answerCbQuery();
});

// Обработчик кнопки "Готово"
bot.action(/pl_done:(.+)/, async (ctx) => {
    const playlistId = ctx.match[1];
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    
    if (!session || session.playlistId !== playlistId) {
        return await ctx.answerCbQuery('❗️ Сессия выбора истекла.', { show_alert: true });
    }
    
    if (session.selected.size === 0) {
        return await ctx.answerCbQuery('Вы не выбрали ни одного трека.', { show_alert: true });
    }
    
    // Проверяем лимиты пользователя
    await resetDailyLimitIfNeeded(userId);
    const user = await getUser(userId);
    const remainingLimit = user.premium_limit - user.downloads_today;
    
    if (remainingLimit <= 0) {
        await ctx.editMessageText(T('limitReached'), { parse_mode: 'HTML' });
        playlistSessions.delete(userId);
        return;
    }
    
    // Получаем реальные объекты треков по выбранным индексам
    const selectedTracks = Array.from(session.selected).map(index => session.tracks[index]);
    const tracksToProcess = selectedTracks.slice(0, remainingLimit);
    
    let message = `✅ Готово! Добавляю ${tracksToProcess.length} выбранных треков в очередь...`;
    if (tracksToProcess.length < selectedTracks.length) {
        message += `\n(Остальные не поместились в ваш дневной лимит)`;
    }
    await ctx.editMessageText(message);
    
    // Напрямую добавляем задачи в очередь
    for (const track of tracksToProcess) {
        const task = {
            userId: userId,
            source: 'soundcloud',
            url: track.url,
            originalUrl: track.url,
            metadata: {
                id: track.id,
                title: track.title || 'Unknown Title',
                uploader: track.uploader || 'Unknown Artist',
                duration: track.duration,
                thumbnail: track.thumbnail,
            }
        };
        downloadQueue.add(task);
    }
    
    playlistSessions.delete(userId); // Очищаем сессию
});

// Обработчик кнопки "Отмена"
bot.action(/pl_cancel:(.+)/, async (ctx) => {
    const userId = ctx.from.id;
    playlistSessions.delete(userId);
    await ctx.deleteMessage().catch(() => {}); // Удаляем сообщение с кнопками
    await ctx.answerCbQuery('Действие отменено.');
});


// ======================= МОДИФИЦИРОВАННЫЙ ОБРАБОТЧИК ТЕКСТА =======================
// ВАЖНО: Универсальный обработчик текста должен идти ПОСЛЕ всех команд и hears
bot.on('text', async (ctx) => {
    const userText = ctx.message.text;

    if (userText.startsWith('/')) {
        return; 
    }
    
    if (Object.values(allTextsSync()).includes(userText)) {
        return; 
    }
    
    const urlMatch = userText.match(/(https?:\/\/[^\s]+)/g);
    if (!urlMatch || urlMatch.length === 0) {
        await ctx.reply('Я не понял. Пожалуйста, отправьте мне ссылку на трек, альбом или плейлист.');
        return;
    }
    
    const url = urlMatch[0];
    
    // Новая логика: сначала проверяем, является ли ссылка плейлистом
    if (SOUNDCLOUD_PLAYLIST_REGEX.test(url)) {
        await handlePlaylistLink(ctx, url);
    } else if (url.includes('soundcloud.com')) {
        // Старая логика для одиночных треков
        enqueue(ctx, ctx.from.id, url).catch(err => {
            console.error(`[SC Enqueue Error] Ошибка для user ${ctx.from.id}:`, err.message);
        });
    } else if (url.includes('open.spotify.com')) {
        spotifyEnqueue(ctx, ctx.from.id, url).catch(err => {
            console.error(`[Spotify Enqueue Error] Ошибка для user ${ctx.from.id}:`, err.message);
        });
    } else {
        await ctx.reply('Я пока умею скачивать только с SoundCloud и Spotify. Поддержка других платформ в разработке!');
    }
});

// ======================= НОВЫЕ ФУНКЦИИ ДЛЯ ОБРАБОТКИ ПЛЕЙЛИСТОВ =======================
async function handlePlaylistLink(ctx, url) {
    let loadingMessage;
    try {
        loadingMessage = await ctx.reply('🔍 Анализирую плейлист... Это может занять несколько секунд.');

        const youtubeDl = getYoutubeDl();
        const output = await youtubeDl(url, {
            dumpSingleJson: true,
            flatPlaylist: true,
        });

        const playlistData = JSON.parse(output);
        const tracks = playlistData.entries;

        if (!tracks || tracks.length === 0) {
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, 'Не удалось найти треки в этом плейлисте или плейлист пуст.');
            return;
        }

        // Удаляем сообщение "Анализирую..." перед отправкой нового
        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMessage.message_id).catch(()=>{});
        
        // Передаем управление для создания сессии и отправки меню
        await startPlaylistSelection(ctx, playlistData);

    } catch (error) {
        console.error('Ошибка при обработке плейлиста:', error);
        if (loadingMessage) {
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, '❌ Не удалось обработать ссылку на плейлист. Убедитесь, что она корректна и плейлист доступен.');
        } else {
            await ctx.reply('❌ Не удалось обработать ссылку на плейлист. Убедитесь, что она корректна и плейлист доступен.');
        }
    }
}

async function startPlaylistSelection(ctx, playlistData) {
    const userId = ctx.from.id;
    const tracks = playlistData.entries;
    const playlistId = playlistData.id || `pl_${Date.now()}`; // ID для callback'ов, с фолбэком

    // Сохраняем данные плейлиста для этого пользователя
    playlistSessions.set(userId, {
        playlistId: playlistId,
        title: playlistData.title,
        tracks: tracks,
        selected: new Set(), // Для будущего ручного выбора
        currentPage: 0     // Для будущей пагинации
    });

    const message = `🎶 В плейлисте <b>"${playlistData.title}"</b> найдено <b>${tracks.length}</b> треков.\n\nЧто делаем?`;
    await ctx.reply(message, {
        parse_mode: 'HTML',
        ...generateInitialPlaylistMenu(playlistId)
    });
}

function generateInitialPlaylistMenu(playlistId) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📥 Скачать первые 10', `pl_download_10:${playlistId}`)],
        [Markup.button.callback('📝 Выбрать треки вручную', `pl_select_manual:${playlistId}`)],
        [Markup.button.callback('❌ Отмена', `pl_cancel:${playlistId}`)]
    ]);
}