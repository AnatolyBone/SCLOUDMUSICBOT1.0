// ======================= ФИНАЛЬНАЯ ВЕРСИЯ BOT.JS =======================

import { Telegraf, Markup, TelegramError } from 'telegraf';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ADMIN_ID, BOT_TOKEN, WEBHOOK_URL, CHANNEL_USERNAME, STORAGE_CHANNEL_ID, PROXY_URL } from './config.js';
import { updateUserField, getUser, createUser, setPremium, getAllUsers, resetDailyLimitIfNeeded, getCachedTracksCount, logUserAction, getTopFailedSearches, getTopRecentSearches, getNewUsersCount,findCachedTrack,           // <--- ДОБАВИТЬ
    incrementDownloadsAndSaveTrack, getReferrerInfo, getReferredUsers, resetExpiredPremiumIfNeeded, getReferralStats, getUserUniqueDownloadedUrls, findCachedTrackByFileId, cleanUpDatabase, updateFileId} from './db.js';
import { T, allTextsSync } from './config/texts.js';
import { performInlineSearch } from './services/searchManager.js';
import { handleSpotifyUrl, handleQualitySelection as handleSpotifyQuality, registerSpotifyCallbacks } from './services/spotifyManager.js';
import { handleYouTubeUrl, handleYouTubeQualitySelection } from './services/youtubeManager.js';
import { downloadQueue, enqueue } from './services/downloadManager.js';
import execYoutubeDl from 'youtube-dl-exec';
import { identifyTrack } from './services/shazamService.js';
import { handleReferralCommand, processNewUserReferral } from './services/referralManager.js';
import { isShuttingDown, isMaintenanceMode, setMaintenanceMode } from './services/appState.js';



// --- Глобальные переменные и хелперы ---
const playlistSessions = new Map();
const TRACKS_PER_PAGE = 5;

function getYoutubeDl() {
    const options = {};
    if (PROXY_URL) {
        options.proxy = PROXY_URL;
    }
    
    // ОБНОВЛЕНИЕ: Добавлены Sec-Fetch заголовки. 
    // Это заставляет SoundCloud думать, что запрос делает реальный человек через Chrome.
    const defaultFlags = {
        'no-warnings': true,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'referer': 'https://soundcloud.com/',
        'add-header': [
            'Accept-Language:en-US,en;q=0.9,ru;q=0.8',
            'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Sec-Fetch-Dest:document',
            'Sec-Fetch-Mode:navigate',
            'Sec-Fetch-Site:same-origin',
            'Sec-Fetch-User:?1',
            'Upgrade-Insecure-Requests:1'
        ]
    };
    
    return (url, flags) => execYoutubeDl(url, { ...defaultFlags, ...flags }, options);
}
/**
 * Асинхронно добавляет задачу в очередь, не блокируя основной поток.
 * Это позволяет боту мгновенно отвечать пользователю, а скачивание начинается в фоне.
 * @param {object} task - Объект задачи для downloadManager.
 */
// ЗАМЕНИ ЦЕЛИКОМ ФУНКЦИЮ addTaskToQueue В bot.js

async function addTaskToQueue(task) {
    try {
        // Валидируем payload (проверяем, что задача не "пустая")
        const url = task.url || task.originalUrl;
        if (!url && !task.metadata) {
            console.error('[Queue] Задача без url/originalUrl/metadata — не добавляю:', task);
            return;
        }
        
        // Получаем приоритет из тарифа пользователя
        const user = await getUser(task.userId);
        const priority = user ? (user.premium_limit || 5) : 5;
        
        // Новый, правильный лог
        console.log('[Queue] Добавляю задачу', {
            userId: task.userId,
            prio: priority,
            url,
            hasMeta: !!task.metadata
        });
        
        // ВАЖНО: передаем в очередь ОБЪЕКТ ЗАДАЧИ, а не функцию
        downloadQueue.add({ ...task, priority }).catch(err => {
          if (err.message === 'TASK_TIMEOUT') {
            console.error(`[TaskQueue] Задача отменена по таймауту: ${task.url || task.originalUrl}`);
          } else {
            console.error('[TaskQueue] Ошибка выполнения задачи:', err.message);
          }
        });
    } catch (e) {
        console.error(`[Queue] Ошибка при добавлении задачи в очередь для ${task.userId}:`, e);
    }
}
// --- Вспомогательные функции ---
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
// if (PROXY_URL) {
   //  const agent = new HttpsProxyAgent(PROXY_URL);
   //  telegrafOptions.telegram = { agent };
   //  console.log('[App] Использую прокси для подключения к Telegram API.');
// }
export const bot = new Telegraf(BOT_TOKEN, telegrafOptions);

// Регистрируем Spotify callbacks
registerSpotifyCallbacks(bot);

// --- Middleware ---
// ЗАМЕНИ СТАРЫЙ БЛОК bot.catch НА ЭТОТ В ФАЙЛЕ bot.js

bot.catch(async (err, ctx) => {
    // Шаг 1: Логируем ошибку в консоль, как и раньше.
    console.error(`🔴 [Telegraf Catch] Глобальная ошибка для update ${ctx.update.update_id}:`, err);
    
    // Шаг 2: Формируем подробное сообщение для админа.
    const updateInfo = ctx.update ? JSON.stringify(ctx.update, null, 2) : 'N/A';
    const errorMessage = `
🔴 <b>Критическая ошибка в боте!</b>

<b>Тип ошибки:</b>
<code>${err.name || 'UnknownError'}</code>

<b>Сообщение:</b>
<code>${err.message || 'No message'}</code>

<b>Где произошла:</b>
<code>${err.stack ? err.stack.split('\n')[1].trim() : 'Stack trace unavailable'}</code>

<b>Update, вызвавший ошибку:</b>
<pre><code class="language-json">${updateInfo.slice(0, 3500)}</code></pre>
    `;
    
    // Шаг 3: Пытаемся отправить сообщение админу.
    try {
        // Убедись, что ADMIN_ID импортирован из config.js
        await bot.telegram.sendMessage(ADMIN_ID, errorMessage, { parse_mode: 'HTML' });
    } catch (sendError) {
        console.error('🔥🔥🔥 КРИТИЧЕСКАЯ ОШИБКА: Не удалось даже отправить уведомление админу!', sendError);
    }
    
    // Шаг 4: Обрабатываем частный случай блокировки бота (как и раньше).
    if (err instanceof TelegramError && err.response?.error_code === 403) {
        if (ctx.from?.id) {
            await updateUserField(ctx.from.id, 'active', false);
        }
    }
});
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    
    // Пытаемся достать payload из deep link:
    // 1) ctx.startPayload — есть на /start
    // 2) запасной способ — из текста '/start ref_xxx'
    const payload =
        (typeof ctx.startPayload === 'string' && ctx.startPayload) ||
        (ctx.message?.text?.startsWith('/start ') ? ctx.message.text.split(' ')[1] : null) ||
        null;
    
    // ВАЖНО: передаём payload в getUser — он сам проставит referrer_id при создании
    const user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username, payload);
    ctx.state.user = user;
    
    if (user && user.active === false) return;
    
    // По желанию: восстанавливаем флаг рассылок
    if (user && user.can_receive_broadcasts === false) {
        try { await updateUserField(user.id, { can_receive_broadcasts: true }); } catch (e) {
            console.error('[Broadcast flag] update error:', e.message);
        }
    }
    
    await resetDailyLimitIfNeeded(ctx.from.id);
    await resetExpiredPremiumIfNeeded(ctx.from.id);
    return next();
});
bot.start(async (ctx) => {
                // ==========================================================
                //            ДОБАВЬ ЭТУ СТРОКУ ДЛЯ ОТЛАДКИ
                // ==========================================================
                console.log('[START] got start for', ctx.from.id, 'payload=', ctx.startPayload);
                // ==========================================================
                
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
    [T('menu'), '🆔 Распознать', T('upgrade')],
    [T('mytracks'), T('help')]
]).resize()
    });
});

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'track';
  return name.replace(/[<>:"/\\|?*]+/g, '').trim() || 'track';
}
// bot.js
// handlers/commands.js - добавьте команду для теста
bot.command('cleantrash', async (ctx) => {
    // Проверка на админа
    if (ctx.from.id !== ADMIN_ID) return;

    await ctx.reply('🧹 Начинаю очистку базы от битых треков...');
    
    // Вызываем функцию из db.js
    const success = await cleanUpDatabase();
    
    if (success) {
        await ctx.reply('✅ База очищена:\n1. Трек "Wrong Side of Heaven" удален.\n2. Все треки короче 20 сек удалены.\n\nПопробуйте скачать ссылку снова.');
    } else {
        await ctx.reply('❌ Произошла ошибка при очистке. Проверьте логи.');
    }
});

bot.command('testdl', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  
  const url = ctx.message.text.split(' ')[1];
  if (!url) {
    return ctx.reply('Использование: /testdl <soundcloud_url>');
  }
  
  try {
    await ctx.reply('🔍 Тестирую скачивание...');
    
    // Получаем метаданные
    const info = await ytdl(url, { 
      'dump-single-json': true, 
      'no-playlist': true,
      ...YTDL_COMMON 
    });
    
    const expectedDuration = Math.round(info.duration || 0);
    
    await ctx.reply(
      `📊 Метаданные:\n` +
      `• Название: ${info.title}\n` +
      `• Исполнитель: ${info.uploader}\n` +
      `• Ожидаемая длительность: ${expectedDuration}s\n` +
      `• ID: ${info.id}\n\n` +
      `Пробую скачать через SCDL...`
    );
    
    // Пробуем SCDL
    try {
      const stream = await scdl.default.download(url);
      const testMsg = await bot.telegram.sendAudio(
        STORAGE_CHANNEL_ID,
        { source: stream, filename: 'test.mp3' },
        { title: info.title, performer: info.uploader }
      );
      
      const realDuration = testMsg.audio?.duration || 0;
      
      await ctx.reply(
        `📦 SCDL результат:\n` +
        `• Реальная длительность: ${realDuration}s\n` +
        `• Ожидалось: ${expectedDuration}s\n` +
        `• Статус: ${realDuration < expectedDuration * 0.5 ? '❌ ПРЕВЬЮ' : '✅ ПОЛНЫЙ'}`
      );
      
      // Удаляем тестовый файл
      await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, testMsg.message_id).catch(() => {});
      
    } catch (scdlErr) {
      await ctx.reply(`❌ SCDL ошибка: ${scdlErr.message}\n\nПробую YT-DLP...`);
      
      // Пробуем YT-DLP
      const tempFile = `/tmp/test_${Date.now()}.mp3`;
      await ytdl(url, { output: tempFile, format: 'bestaudio', ...YTDL_COMMON });
      
      if (fs.existsSync(tempFile)) {
        const testMsg = await bot.telegram.sendAudio(
          STORAGE_CHANNEL_ID,
          { source: fs.createReadStream(tempFile) },
          { title: info.title }
        );
        
        const realDuration = testMsg.audio?.duration || 0;
        
        await ctx.reply(
          `📦 YT-DLP результат:\n` +
          `• Реальная длительность: ${realDuration}s\n` +
          `• Ожидалось: ${expectedDuration}s\n` +
          `• Статус: ${realDuration < expectedDuration * 0.5 ? '❌ ПРЕВЬЮ (трек защищён!)' : '✅ ПОЛНЫЙ'}`
        );
        
        await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, testMsg.message_id).catch(() => {});
        fs.unlinkSync(tempFile);
      }
    }
    
  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});
bot.command('fixuser', async (ctx) => {
  // 1. Проверяем, что это админ
  if (ctx.from.id !== ADMIN_ID) {
    return;
  }

  const args = ctx.message.text.split(' ');
  const targetUserId = parseInt(args[1], 10);

  if (!targetUserId) {
    return ctx.reply('Пожалуйста, укажите ID пользователя. Пример: /fixuser 123456789');
  }

  await ctx.reply(`✅ Запускаю фоновую задачу по исправлению кэша для пользователя ID: ${targetUserId}. Это может занять много времени. Отчет будет прислан вам по завершении.`);

  // 2. Запускаем всю тяжелую работу в фоновом режиме, чтобы бот не "зависал"
  (async () => {
    let fixedCount = 0;
    let checkedCount = 0;
    let failedCount = 0;
    const BATCH_DELAY = 3000; // 3 секунды между проверками

    try {
      // 3. Получаем все URL пользователя
      const urls = await getUserUniqueDownloadedUrls(targetUserId);
      if (urls.length === 0) {
        await bot.telegram.sendMessage(ADMIN_ID, `ℹ️ Для пользователя ${targetUserId} не найдено скачанных треков в логах.`);
        return;
      }
      
      await bot.telegram.sendMessage(ADMIN_ID, `[FixUser] Найдено ${urls.length} уникальных URL для пользователя ${targetUserId}. Начинаю проверку...`);

      // 4. Перебираем URL и лечим файлы
      for (const url of urls) {
        checkedCount++;
        try {
          const track = await findCachedTrack(url);
          if (!track || !track.fileId || !track.title) {
            continue; // Трека нет в кэше или запись неполная
          }

          const fileInfo = await bot.telegram.getFile(track.fileId);
          const cleanTitle = sanitizeFilename(track.title);
          const hasCorrectName = fileInfo.file_path && fileInfo.file_path.includes(encodeURIComponent(cleanTitle.split('.mp3')[0]));

          if (hasCorrectName) {
            continue; // Файл уже в порядке
          }

          // Файл "сломан", лечим
          const fileLink = await bot.telegram.getFileLink(track.fileId);
          const filename = cleanTitle.toLowerCase().endsWith('.mp3') ? cleanTitle : `${cleanTitle}.mp3`;
          
          const sentToStorage = await bot.telegram.sendAudio(
            STORAGE_CHANNEL_ID,
            { url: fileLink.href, filename },
            { title: track.title, performer: track.artist }
          );

          const newFileId = sentToStorage?.audio?.file_id;
          if (newFileId) {
            await updateFileId(track.fileId, newFileId);
            fixedCount++;
          }
        } catch (e) {
          failedCount++;
          console.error(`[FixUser] Ошибка при обработке URL ${url} для юзера ${targetUserId}:`, e.message);
        }
        // Пауза между запросами к API
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
      }

      // 5. Отправляем финальный отчет админу
      await bot.telegram.sendMessage(ADMIN_ID, `✅ [FixUser] Задача для пользователя ${targetUserId} завершена.\n\n- Проверено треков: ${checkedCount}\n- Исправлено файлов: ${fixedCount}\n- Ошибок при обработке: ${failedCount}`);

    } catch (e) {
      console.error(`[FixUser] Критическая ошибка в задаче для ${targetUserId}:`, e);
      await bot.telegram.sendMessage(ADMIN_ID, `❌ [FixUser] Произошла критическая ошибка в задаче для пользователя ${targetUserId}. Подробности в логах.`);
    }
  })(); // Немедленно вызываем асинхронную функцию
});
bot.command('fix', async (ctx) => {
  console.log(`[FIX_COMMAND] Команда /fix инициирована пользователем ${ctx.from.id}`);

  // --- ПРОВЕРКИ ---
  if (!ctx.message.reply_to_message) {
    console.log('[FIX_COMMAND] Сбой: Нет реплая.');
    return ctx.reply('ℹ️ Чтобы исправить файл, ответьте на сообщение с аудиозаписью этой командой.');
  }
  const repliedMessage = ctx.message.reply_to_message;

  if (!repliedMessage.audio) {
    console.log('[FIX_COMMAND] Сбой: Нет аудио.');
    return ctx.reply('❌ Это не аудиофайл. Пожалуйста, ответьте на сообщение с музыкой.');
  }
  
  if (!STORAGE_CHANNEL_ID) {
      console.log('[FIX_COMMAND] Сбой: Нет STORAGE_CHANNEL_ID.');
      return ctx.reply('🛠 Функция временно недоступна.');
  }

  const oldFileId = repliedMessage.audio.file_id;
  console.log(`[FIX_COMMAND] Старый file_id: ${oldFileId}`);
  
  let statusMessage;

  try {
    // Отправляем сообщение о начале (если упадет - не страшно)
    try {
        statusMessage = await ctx.reply('🔬 Начинаю процедуру "лечения" файла...');
    } catch (e) { console.warn('Не удалось отправить статусное сообщение:', e); }

    // 1. Находим трек в БД
    console.log('[FIX_COMMAND] Шаг 1: Поиск трека в БД...');
    const trackInfo = await findCachedTrackByFileId(oldFileId);
    
    if (!trackInfo) {
      console.log('[FIX_COMMAND] Шаг 1: Провал. Трек не найден.');
      if (statusMessage) {
          await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, '🤔 Не могу найти этот трек в базе. Возможно, он был скачан не мной.').catch(()=>{});
      }
      return;
    }
    console.log('[FIX_COMMAND] Шаг 1: Успех. Найден трек:', trackInfo);

    // 2. Получаем ссылку
    console.log('[FIX_COMMAND] Шаг 2: Получение ссылки...');
    const fileLink = await ctx.telegram.getFileLink(oldFileId);
    console.log('[FIX_COMMAND] Шаг 2: Успех.');

    // 3. Перезагружаем в хранилище
    const title = trackInfo.title || 'Track';
    const artist = trackInfo.artist || 'Artist';
    console.log(`[FIX_COMMAND] Шаг 3: Перезагрузка "${title}"...`);
    
    const cleanTitle = sanitizeFilename(title);
    const filename = cleanTitle.toLowerCase().endsWith('.mp3') ? cleanTitle : `${cleanTitle}.mp3`;

    const sentToStorage = await bot.telegram.sendAudio(STORAGE_CHANNEL_ID, { 
        url: fileLink.href, 
        filename: filename,
        title: title,        // Добавляем метаданные сразу
        performer: artist 
    });
    
    const newFileId = sentToStorage?.audio?.file_id;
    if (!newFileId) throw new Error('Не удалось получить новый file_id.');
    
    console.log(`[FIX_COMMAND] Шаг 3: Успех. Новый file_id: ${newFileId}`);

    // 4. Обновляем БД
    console.log('[FIX_COMMAND] Шаг 4: Обновление БД...');
    const updatedCount = await updateFileId(oldFileId, newFileId);
    console.log(`[FIX_COMMAND] Шаг 4: Успех. Обновлено строк: ${updatedCount}`);
    
    if (updatedCount > 0) {
        // --- УСПЕХ: Сначала шлем файл (самое важное) ---
        try {
            await ctx.replyWithAudio(newFileId, {
                caption: '✅ Файл восстановлен и обновлен в базе!',
                title: title,
                performer: artist,
                reply_to_message_id: repliedMessage.message_id // Отвечаем на оригинал
            });
        } catch (sendErr) {
            console.error('Ошибка отправки исправленного файла:', sendErr);
            await ctx.reply('✅ Файл исправлен в базе, но я не смог отправить его вам сюда.');
        }

        // --- Потом обновляем статус (менее важно) ---
        if (statusMessage) {
            try {
                await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id);
            } catch (delErr) {
                // Если не смогли удалить - пробуем отредактировать
                await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, '✅ Готово!').catch(()=>{});
            }
        }
    } else {
        if (statusMessage) {
             await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, '⚠️ Файл перезалит, но база данных не обновилась.').catch(()=>{});
        }
    }

  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА в команде /fix:', error);
    if (statusMessage) {
      // Пытаемся сообщить об ошибке, но не крашимся если не выйдет
      await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, `❌ Ошибка при лечении файла.`).catch(()=>{});
    }
  }
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
// ==========================================================
//    ДОБАВЬ ЭТОТ БЛОК ДЛЯ ОБРАБОТКИ КНОПКИ "ПОЛУЧИТЬ БОНУС"
// ==========================================================

bot.action('check_subscription', async (ctx) => {
    try {
        console.log(`[Bonus] User ${ctx.from.id} пытается получить бонус.`);

        // Убедимся, что у нас есть актуальные данные о пользователе
        const user = await getUser(ctx.from.id);
        if (user.subscribed_bonus_used) {
            console.log(`[Bonus] User ${ctx.from.id} уже использовал бонус.`);
            return await ctx.answerCbQuery('Вы уже использовали этот бонус.', { show_alert: true });
        }

        console.log(`[Bonus] Проверяю подписку для ${ctx.from.id} на канал ${CHANNEL_USERNAME}`);
        const subscribed = await isSubscribed(ctx.from.id);

        if (subscribed) {
            console.log(`[Bonus] User ${ctx.from.id} подписан. Начисляю бонус.`);
            await setPremium(ctx.from.id, 30, 7); // 30 скачиваний в день на 7 дней
            await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
            await logUserAction(ctx.from.id, 'bonus_received');
            
            // Завершаем "загрузку" кнопки
            await ctx.answerCbQuery('Бонус начислен!');
            // Меняем сообщение, чтобы кнопка исчезла
            await ctx.editMessageText('🎉 Поздравляем! Вам начислено 7 дней тарифа Plus. Спасибо за подписку!');

        } else {
            console.log(`[Bonus] User ${ctx.from.id} НЕ подписан.`);
            return await ctx.answerCbQuery(`Вы еще не подписаны на канал ${CHANNEL_USERNAME}. Пожалуйста, подпишитесь и нажмите кнопку снова.`, { show_alert: true });
        }
    } catch (e) {
        console.error(`🔴 КРИТИЧЕСКАЯ ОШИБКА в check_subscription для user ${ctx.from.id}:`, e);
        // В случае любой ошибки, мы должны завершить "загрузку" кнопки
        await ctx.answerCbQuery('Произошла ошибка. Пожалуйста, попробуйте позже.', { show_alert: true });
    }
});

// ========================= ОБРАБОТЧИКИ ВЫБОРА КАЧЕСТВА =========================

// Spotify качество
bot.action(/^spq:(.+):(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const quality = ctx.match[2];
    console.log(`[Spotify] Выбор качества: session=${sessionId}, quality=${quality}`);
    await handleSpotifyQuality(ctx, sessionId, quality);
});

// YouTube качество
bot.action(/^ytq:(.+):(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const quality = ctx.match[2];
    console.log(`[YouTube] Выбор качества: session=${sessionId}, quality=${quality}`);
    await handleYouTubeQualitySelection(ctx, sessionId, quality);
});
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
bot.hears('🆔 Распознать', (ctx) => ctx.reply('Просто отправьте или перешлите мне:\n🎤 Голосовое сообщение\n📹 Видео-кружок\n🎧 Аудиофайл\n\n...и я скажу, что это за трек!'));
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

// bot.js (ФИНАЛЬНАЯ ВЕРСИЯ ОБРАБОТЧИКА КНОПОК ПЛЕЙЛИСТА С КОРРЕКТНЫМИ ЛИМИТАМИ)

bot.action(/pl_download_all:|pl_download_10:/, async (ctx) => {
    const isAll = ctx.callbackQuery.data.includes('pl_download_all');
    const playlistId = ctx.callbackQuery.data.split(':')[1];
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    
    if (!session) {
        return await ctx.answerCbQuery('❗️ Сессия выбора истекла.', { show_alert: true });
    }
    
    // --- 1. Дозагрузка данных (остается без изменений) ---
    if (!session.fullTracks) {
        await ctx.answerCbQuery('⏳ Получаю полные данные плейлиста...');
        await ctx.editMessageText('⏳ Получаю полные данные плейлиста... Это может занять несколько секунд.');
        
        try {
            const youtubeDl = getYoutubeDl();
            const fullData = await youtubeDl(session.originalUrl, { dumpSingleJson: true });
            session.tracks = fullData.entries.filter(track => track && track.url);
            session.fullTracks = true;
        } catch (e) {
            console.error('[Playlist] Ошибка при дозагрузке названий:', e);
            await ctx.editMessageText('❌ Не удалось получить детали плейлиста.');
            return await ctx.answerCbQuery('Ошибка!', { show_alert: true });
        }
    }
    
    // --- 2. Получаем актуальные лимиты пользователя ---
    const user = await getUser(userId);
    const remainingLimit = user.premium_limit - (user.downloads_today || 0);
    
    if (remainingLimit <= 0) {
  const bonusAvailable = Boolean(CHANNEL_USERNAME && !user.subscribed_bonus_used);
  const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
  const bonusText = bonusAvailable
    ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.`
    : '';
  const extra = {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
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
    
    // --- 3. Определяем, сколько треков нужно обработать, С УЧЕТОМ ЛИМИТА ---
    const tracksToTake = isAll ? session.tracks.length : 10;
    
    // Берем минимальное из: (желаемое кол-во треков) и (оставшийся лимит)
    const numberOfTracksToQueue = Math.min(tracksToTake, remainingLimit);
    
    const tracksToProcess = session.tracks.slice(0, numberOfTracksToQueue);
    
    // --- 4. Просто ставим задачи в очередь (без проверки кэша) ---
    for (const track of tracksToProcess) {
        addTaskToQueue({
            userId,
            source: 'soundcloud',
            url: track.webpage_url || track.url,
            originalUrl: track.webpage_url || track.url,
            metadata: track, // <--- ИСПРАВЛЕНИЕ! Передаем ВЕСЬ объект track как metadata
        });
    }
    
    // --- 5. Отправляем корректный отчет пользователю ---
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
    
    // Проверяем, есть ли у нас уже полные данные с названиями
    if (!session.fullTracks) {
        // ==========================================================
        //         ЭТО ИДЕАЛЬНОЕ РЕШЕНИЕ ДЛЯ UX
        // ==========================================================
        
        // 1. Мгновенно отвечаем на нажатие
        await ctx.answerCbQuery('⏳ Загружаю названия треков...');
        
        // 2. Меняем сообщение, чтобы было понятно, что идет работа
        await ctx.editMessageText('⏳ Получаю полные данные плейлиста... Это может занять несколько секунд.');
        
        try {
            // 3. Запускаем долгую операцию
            const youtubeDl = getYoutubeDl();
            const fullData = await youtubeDl(session.originalUrl, { dumpSingleJson: true });
            
            session.tracks = fullData.entries.filter(track => track && track.url);
            session.fullTracks = true; // Ставим флаг, что данные загружены
            
        } catch (e) {
            console.error('[Playlist] Ошибка при дозагрузке названий:', e);
            await ctx.editMessageText('❌ Не удалось получить детали плейлиста. Попробуйте снова или выберите другой вариант.');
            return await ctx.answerCbQuery('Ошибка!', { show_alert: true });
        }
    }
    
    // 4. Когда все готово, показываем меню выбора с названиями
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

// bot.js (ФИНАЛЬНАЯ ВЕРСИЯ ОБРАБОТЧИКА КНОПКИ "ГОТОВО")

bot.action(/pl_finish:(.+)/, async (ctx) => {
    const playlistId = ctx.match[1];
    const userId = ctx.from.id;
    const session = playlistSessions.get(userId);
    
    // --- Стандартные проверки ---
    if (!session) {
        return await ctx.answerCbQuery('❗️ Сессия выбора истекла.', { show_alert: true });
    }
    if (session.selected.size === 0) {
        return await ctx.answerCbQuery('Вы не выбрали ни одного трека.', { show_alert: true });
    }
    // Так как названия важны, оставляем проверку, что они были загружены
    if (!session.fullTracks) {
        return await ctx.answerCbQuery('❌ Произошла ошибка: данные плейлиста не были загружены. Попробуйте заново.', { show_alert: true });
    }
    
    // --- 1. Проверка лимитов пользователя ---
    const user = await getUser(userId);
    const remainingLimit = user.premium_limit - (user.downloads_today || 0);
    
    if (remainingLimit <= 0) {
  const bonusAvailable = Boolean(CHANNEL_USERNAME && !user.subscribed_bonus_used);
  const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
  const bonusText = bonusAvailable
    ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.`
    : '';
  const extra = {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
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
    
    // --- 2. Формирование очереди С УЧЕТОМ ЛИМИТА ---
    const selectedIndexes = Array.from(session.selected);
    const numberOfTracksToQueue = Math.min(selectedIndexes.length, remainingLimit);
    
    const tracksToProcess = selectedIndexes.slice(0, numberOfTracksToQueue).map(index => session.tracks[index]);
    
    // --- 3. Простая постановка задач в очередь (БЕЗ ПРОВЕРКИ КЭША) ---
    for (const track of tracksToProcess) {
        addTaskToQueue({
            userId,
            source: 'soundcloud',
            url: track.webpage_url || track.url,
            originalUrl: track.webpage_url || track.url,
            metadata: track,
            
        });
    }
    
    // --- 4. Корректный отчет пользователю ---
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

// === ФУНКЦИЯ ДЛЯ РАСШИФРОВКИ КОРОТКИХ ССЫЛОК (on.soundcloud.com) ===
async function resolveSoundCloudLink(url) {
    // Если это не короткая ссылка, возвращаем как есть
    if (!url || !url.includes('on.soundcloud.com')) return url;

    try {
        console.log(`[LinkResolve] Расшифровываю короткую ссылку: ${url}`);
        // Делаем запрос, axios автоматически пройдет по редиректам
        const response = await axios.get(url, {
            maxRedirects: 5,
            // Притворяемся браузером, чтобы SoundCloud не кинул на страницу скачивания приложения
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' 
            }
        });
        
        // В Node.js axios возвращает итоговый URL в request.res.responseUrl
        const finalUrl = response.request.res.responseUrl || url;
        console.log(`[LinkResolve] Успех: ${finalUrl}`);
        return finalUrl;
    } catch (e) {
        console.error(`[LinkResolve] Не удалось расшифровать ссылку: ${e.message}`);
        return url; // Если ошибка, пробуем вернуть оригинал, вдруг сработает
    }
}

// ЭТО НОВАЯ ФУНКЦИЯ-"ПОМОЩНИК", КОТОРАЯ БУДЕТ РАБОТАТЬ В ФОНЕ
async function processUrlInBackground(ctx, url) {
    let loadingMessage;
    try {
        loadingMessage = await ctx.reply('🔍 Анализирую ссылку...');
        
        // 1. Сначала превращаем короткую ссылку в длинную
        const resolvedUrl = await resolveSoundCloudLink(url);
        
        const youtubeDl = getYoutubeDl();
        
        let data;
        try {
            // Используем уже РАСШИФРОВАННУЮ ссылку
            data = await youtubeDl(resolvedUrl, { dumpSingleJson: true, flatPlaylist: true });
        } catch (ytdlError) {
            console.error(`[youtube-dl] Критическая ошибка (processUrlInBackground) для ${resolvedUrl}:`, ytdlError.stderr || ytdlError.message);
            throw new Error('Не удалось получить метаданные. Ссылка может быть недействительной или трек недоступен.');
        }

        if (!data) {
            throw new Error('Не удалось получить метаданные.');
        }

        if (data.entries && data.entries.length > 0) {
            await ctx.deleteMessage(loadingMessage.message_id).catch(() => {});
            
            const playlistId = `pl_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            playlistSessions.set(ctx.from.id, {
                playlistId,
                title: data.title,
                tracks: data.entries,
                originalUrl: resolvedUrl, // Сохраняем полную ссылку
                selected: new Set(),
                currentPage: 0,
                fullTracks: false
            });
            const message = `🎶 В плейлисте <b>"${escapeHtml(data.title)}"</b> найдено <b>${data.entries.length}</b> треков.\n\nЧто делаем?`;
            await ctx.reply(message, { parse_mode: 'HTML', ...generateInitialPlaylistMenu(playlistId, data.entries.length) });
            
        } else {
            const user = await getUser(ctx.from.id);
            if ((user.downloads_today || 0) >= (user.premium_limit || 0)) {
                // ... (код проверки лимитов, без изменений) ...
                 const bonusAvailable = Boolean(CHANNEL_USERNAME && !user.subscribed_bonus_used);
                const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
                const bonusText = bonusAvailable ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.` : '';
                const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
                if (bonusAvailable) {
                    extra.reply_markup = { inline_keyboard: [[ { text: '✅ Я подписался, забрать бонус', callback_data: 'check_subscription' } ]] };
                }
                await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, `${T('limitReached')}${bonusText}`, extra);
                return;
            }
            
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, '✅ Распознал трек, ставлю в очередь...');
            
            setTimeout(() => ctx.deleteMessage(loadingMessage.message_id).catch(() => {}), 3000);
            
            addTaskToQueue({
                userId: ctx.from.id,
                source: 'soundcloud',
                url: data.webpage_url || resolvedUrl,
                originalUrl: data.webpage_url || resolvedUrl,
                metadata: { id: data.id, title: data.title, uploader: data.uploader, duration: data.duration, thumbnail: data.thumbnail },
                ctx: null
            });
        }
    } catch (error) {
        console.error('Ошибка при фоновой обработке URL:', error.message);
        const userMessage = '❌ Не удалось обработать ссылку. Убедитесь, что она корректна и контент доступен.';
        if (loadingMessage) {
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, userMessage).catch(() => {});
        } else {
            await ctx.reply(userMessage);
        }
    }
}
async function handleSoundCloudUrl(ctx, url) {
    let loadingMessage;
    try {
        loadingMessage = await ctx.reply('🔍 Анализирую ссылку...');
        
        // 1. Превращаем короткую ссылку в длинную
        const resolvedUrl = await resolveSoundCloudLink(url);
        
        const youtubeDl = getYoutubeDl();
        
        let data;
        try {
            // Используем расшифрованную ссылку
            data = await youtubeDl(resolvedUrl, { dumpSingleJson: true, flatPlaylist: true });
        } catch (ytdlError) {
            // ВАЖНОЕ ИЗМЕНЕНИЕ: Логируем ПОЛНЫЙ текст ошибки от youtube-dl
            console.error(`[youtube-dl] ДЕТАЛИ ОШИБКИ для ${resolvedUrl}:`);
            console.error(ytdlError.stderr || ytdlError.message || ytdlError);
            
            throw new Error('Ошибка при запросе к SoundCloud (см. логи)');
        }
        
        if (!data) throw new Error('Пустой ответ от yt-dlp.');
        
        if (data.entries && data.entries.length > 1) {
            // Плейлист
            await ctx.deleteMessage(loadingMessage.message_id).catch(() => {});
            
            const playlistId = `pl_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            playlistSessions.set(ctx.from.id, {
                playlistId,
                title: data.title,
                tracks: data.entries,
                originalUrl: resolvedUrl, 
                selected: new Set(),
                currentPage: 0,
                fullTracks: false
            });
            
            const message = `🎶 В плейлисте <b>"${escapeHtml(data.title)}"</b> найдено <b>${data.entries.length}</b> треков.\n\nЧто делаем?`;
            await ctx.reply(message, { parse_mode: 'HTML', ...generateInitialPlaylistMenu(playlistId, data.entries.length) });
            
        } else {
            // Одиночный трек
            await ctx.deleteMessage(loadingMessage.message_id).catch(() => {});
            // Важно передать resolvedUrl дальше
            enqueue(ctx, ctx.from.id, resolvedUrl, { isSingleTrack: true, metadata: data });
        }
        
    } catch (error) {
        console.error('Ошибка handleSoundCloudUrl:', error.message);
        const userMessage = '❌ Не удалось обработать ссылку. Возможно, SoundCloud заблокировал IP сервера.';
        if (loadingMessage) {
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, userMessage).catch(() => {});
        } else {
            await ctx.reply(userMessage);
        }
    }
}
const handleMediaForShazam = async (ctx) => {
    const message = ctx.message;

    // 🛑 ФИКС: Если сообщение отправлено через этого же бота (результат поиска), игнорируем его
    if (message.via_bot && message.via_bot.id === ctx.botInfo.id) {
        return;
    }

    let fileId = null;

    if (message.voice) fileId = message.voice.file_id;
    else if (message.video_note) fileId = message.video_note.file_id;
    else if (message.audio) fileId = message.audio.file_id;
    else if (message.video) fileId = message.video.file_id;
    
    if (!fileId) return;
    
    const isVoiceOrNote = !!(message.voice || message.video_note);
    // Можно раскомментировать, если хотите, чтобы аудио файлы распознавались только по команде
    // if (!isVoiceOrNote && !message.caption?.toLowerCase().includes('shazam')) return;

    let statusMsg;
    try {
        statusMsg = await ctx.reply('👂 Слушаю...');
        const fileLink = await ctx.telegram.getFileLink(fileId);
        
        const result = await identifyTrack(fileLink.href);
        
        await ctx.deleteMessage(statusMsg.message_id).catch(() => {});

        if (result) {
            const query = `${result.artist} - ${result.title}`;
            
            // Ищем в кэше
            const searchResults = await performInlineSearch(query, ctx.from.id);
            const cachedCount = searchResults.filter(r => r.audio_file_id).length;

            let text = `🎵 <b>Shazam:</b>\n\n🎤 <b>${result.artist}</b>\n🎼 <b>${result.title}</b>`;
            
            // Кнопки
            const buttons = [];

            if (cachedCount > 0) {
                text += `\n\n📂 Нашел вариантов: <b>${cachedCount}</b>.`;
                text += `\n👇 Нажми кнопку, чтобы выбрать нужную версию:`;
                
                // Кнопка открывает встроенный поиск с результатами из кэша
                buttons.push([Markup.button.switchToCurrentChat(`📂 Показать варианты (${cachedCount})`, query)]);
            } else {
                text += `\n\n🤷‍♂️ В кэше пока нет.`;
                text += `\n👇 Нажми, чтобы найти в SoundCloud:`;
                
                // Кнопка открывает встроенный поиск по глобальной базе (SoundCloud)
                buttons.push([Markup.button.switchToCurrentChat(`🔎 Искать в SoundCloud`, query)]);
            }

            // Отправляем красивый ответ
            if (result.image) {
                await ctx.replyWithPhoto(result.image, { 
                    caption: text, 
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard(buttons)
                });
            } else {
                await ctx.reply(text, { 
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard(buttons)
                });
            }

        } else {
            await ctx.reply('🤷‍♂️ Не удалось распознать.');
        }

    } catch (e) {
        console.error('[Shazam] Error:', e);
        if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
        await ctx.reply('⚠️ Произошла ошибка при обработке файла.');
    }
};

// Подключаем обработчик ко всем медиа-типам
bot.on(['voice', 'video_note', 'audio', 'video'], handleMediaForShazam);

bot.on('text', async (ctx) => {
    if (isShuttingDown()) return;
    if (isMaintenanceMode() && ctx.from.id !== ADMIN_ID) {
        return await ctx.reply('⏳ Бот на плановом обслуживании.');
    }
    
    if (ctx.chat.type !== 'private') return;
    
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    if (Object.values(allTextsSync()).includes(text)) return;
    
    const urlMatch = text.match(/(https?:\/\/[^\s]+)/g);
    if (!urlMatch) return await ctx.reply('Пожалуйста, отправьте мне ссылку.');
    
    // ПАКЕТНЫЙ РЕЖИМ ДЛЯ АДМИНА: обрабатываем все ссылки из сообщения
    const isAdmin = ctx.from.id === ADMIN_ID;
    const soundcloudUrls = urlMatch.filter(u => u.includes('soundcloud.com'));
    
    if (isAdmin && soundcloudUrls.length > 1) {
        // Админ прислал несколько ссылок — обрабатываем все
        await ctx.reply(`📦 Пакетный режим: найдено ${soundcloudUrls.length} ссылок. Добавляю в очередь...`);
        let added = 0;
        for (const scUrl of soundcloudUrls) {
            try {
                handleSoundCloudUrl(ctx, scUrl);
                added++;
            } catch (e) {
                console.error(`[Admin/Batch] Ошибка для ${scUrl}:`, e.message);
            }
        }
        console.log(`[Admin/Batch] Добавлено ${added}/${soundcloudUrls.length} ссылок в очередь`);
        return;
    }
    
    const url = urlMatch[0];

    // Проверка лимитов (для всех, кроме админа)
    if (!isAdmin) {
        const user = await getUser(ctx.from.id);
        if ((user.downloads_today || 0) >= (user.premium_limit || 0)) {
            const bonusAvailable = Boolean(CHANNEL_USERNAME && !user.subscribed_bonus_used);
            const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
            const bonusText = bonusAvailable
              ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.`
              : '';
            const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
            if (bonusAvailable) {
              extra.reply_markup = { inline_keyboard: [[ { text: '✅ Я подписался, забрать бонус', callback_data: 'check_subscription' } ]] };
            }
            await ctx.reply(`${T('limitReached')}${bonusText}`, extra);
            return;
        }
    }

    // Определяем источник и обрабатываем
    // Импортируем getSetting для проверки включенных сервисов
    const { getSetting } = await import('./services/settingsManager.js');
    
    if (url.includes('soundcloud.com')) {
        // SoundCloud
        if (getSetting('use_soundcloud') !== 'true') {
            await ctx.reply('⚠️ Сервис SoundCloud временно отключен администратором. Попробуйте позже или используйте другой сервис.');
            return;
        }
        handleSoundCloudUrl(ctx, url);
    } else if (url.includes('open.spotify.com') || url.includes('spotify.com')) {
        // Spotify - показываем меню выбора качества
        if (getSetting('use_spotify') !== 'true') {
            await ctx.reply('⚠️ Сервис Spotify временно отключен администратором. Попробуйте позже или используйте другой сервис.');
            return;
        }
        handleSpotifyUrl(ctx, url);
    } else if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com')) {
        // YouTube / YouTube Music - показываем меню выбора качества
        if (getSetting('use_youtube') !== 'true') {
            await ctx.reply('⚠️ Сервис YouTube временно отключен администратором. Попробуйте позже или используйте другой сервис.');
            return;
        }
        handleYouTubeUrl(ctx, url);
    } else {
        await ctx.reply(
            '🎵 Я умею скачивать музыку из:\n\n' +
            '• SoundCloud (soundcloud.com)\n' +
            '• Spotify (open.spotify.com)\n' +
            '• YouTube Music (music.youtube.com)\n' +
            '• YouTube (youtube.com)\n\n' +
            'Просто отправь ссылку!'
        );
    }
});
