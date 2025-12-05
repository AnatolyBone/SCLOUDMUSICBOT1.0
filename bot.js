// ======================= ФИНАЛЬНАЯ ПОЛНАЯ ВЕРСИЯ BOT.JS =======================

import { Telegraf, Markup, TelegramError } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { getLyrics } from './services/lyricsService.js';
import { ADMIN_ID, BOT_TOKEN, WEBHOOK_URL, CHANNEL_USERNAME, STORAGE_CHANNEL_ID, PROXY_URL } from './config.js';
import { 
    pool, 
    updateUserField, getUser, createUser, setPremium, getAllUsers, resetDailyLimitIfNeeded, 
    getCachedTracksCount, logUserAction, getTopFailedSearches, getTopRecentSearches, 
    getNewUsersCount, findCachedTrack, incrementDownloadsAndSaveTrack, getReferrerInfo, 
    getReferredUsers, resetExpiredPremiumIfNeeded, getReferralStats, getUserUniqueDownloadedUrls, 
    findCachedTrackByFileId, getKaraokeCache, saveKaraokeCache, findKaraokeByMetadata, 
    searchKaraoke, findKaraokeFuzzy, updateFileId 
} from './db.js';

import { T, allTextsSync } from './config/texts.js';
import { performInlineSearch } from './services/searchManager.js';
import { spotifyEnqueue } from './services/spotifyManager.js';
import { downloadQueue, enqueue } from './services/downloadManager.js';
import execYoutubeDl from 'youtube-dl-exec';
import { processKaraoke } from './services/karaokeService.js';
import { identifyTrack } from './services/shazamService.js';
import { handleReferralCommand, processNewUserReferral } from './services/referralManager.js';
import { isShuttingDown, isMaintenanceMode, setMaintenanceMode } from './services/appState.js';

// ==================================================
// --- ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ (ОБЪЯВЛЕНЫ 1 РАЗ) ---
// ==================================================

const playlistSessions = new Map();
const TRACKS_PER_PAGE = 5;
const lyricsSessions = new Map(); 
// Переменные для Караоке и Загрузки
const processingSet = new Set();   
let isAdminUploadMode = false;     
const uploadQueue = [];            
let isUploading = false;           

// Функция для экранирования HTML (используется везде)
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (m) => ({ 
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' 
    })[m]);
}
const escapeHTML = escapeHtml; // Алиас на случай, если где-то осталось старое имя

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'track';
  return name.replace(/[<>:"/\\|?*]+/g, '').trim() || 'track';
}

function getYoutubeDl() {
    const options = {};
    if (PROXY_URL) options.proxy = PROXY_URL;
    
    const defaultFlags = {
        'extractor-args': 'soundcloud:player_client_id=CLIENT_ID',
        'no-warnings': true
    };
    return (url, flags) => execYoutubeDl(url, { ...defaultFlags, ...flags }, options);
}

async function addTaskToQueue(task) {
    try {
        const url = task.url || task.originalUrl;
        if (!url && !task.metadata) return;
        
        const user = await getUser(task.userId);
        const priority = user ? (user.premium_limit || 5) : 5;
        
        console.log('[Queue] Добавляю задачу', { userId: task.userId, prio: priority, url });
        downloadQueue.add({ ...task, priority });
    } catch (e) {
        console.error(`[Queue] Ошибка добавления:`, e);
    }
}

async function isSubscribed(userId) {
    if (!CHANNEL_USERNAME) return false;
    try {
        const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, userId);
        return ['creator', 'administrator', 'member'].includes(member.status);
    } catch (e) { return false; }
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
    const daysLeft = getDaysLeft(user.premium_until);
    const referralLink = `https://t.me/${botUsername}?start=ref_${user.id}`;
    
    const statsBlock = [
        `💼 <b>Тариф:</b> <i>${tariffLabel}</i>`,
        `⏳ <b>Осталось дней:</b> <i>${daysLeft}</i>`,
        `🎧 <b>Сегодня скачано:</b> <i>${user.downloads_today || 0}</i> из <i>${user.premium_limit}</i>`
    ].join('\n');
    
    const header = T('menu_header').replace('{first_name}', escapeHTML(user.first_name) || 'пользователь');
    const referralBlock = T('menu_referral_block').replace('{referral_count}', user.referral_count || 0).replace('{referral_link}', referralLink);
    
    let bonusBlock = '';
    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) {
        const clean = CHANNEL_USERNAME.replace('@', '');
        bonusBlock = T('menu_bonus_block').replace('{channel_link}', `<a href="https://t.me/${clean}">наш канал</a>`);
    }
    
    return [header, statsBlock, '\n----------------', referralBlock, bonusBlock, T('menu_footer')].filter(Boolean).join('\n\n');
}

// --- Инициализация ---
const telegrafOptions = { handlerTimeout: 300_000 };
if (PROXY_URL) telegrafOptions.telegram = { agent: new HttpsProxyAgent(PROXY_URL) };
export const bot = new Telegraf(BOT_TOKEN, telegrafOptions);

// --- Middleware ---
bot.catch(async (err, ctx) => {
    console.error(`🔴 [Error] Update ${ctx.update.update_id}:`, err);
    try {
        if (ADMIN_ID) await bot.telegram.sendMessage(ADMIN_ID, `🔴 <b>Error:</b>\n${err.message}`, { parse_mode: 'HTML' });
    } catch (e) {}
});

bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const payload = ctx.startPayload || (ctx.message?.text?.startsWith('/start ') ? ctx.message.text.split(' ')[1] : null);
    const user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username, payload);
    ctx.state.user = user;
    
    if (user && user.active === false) return;
    
    await resetDailyLimitIfNeeded(ctx.from.id);
    await resetExpiredPremiumIfNeeded(ctx.from.id);
    return next();
});

bot.start(async (ctx) => {
    const user = await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.startPayload);
    const isNew = (Date.now() - new Date(user.created_at).getTime()) < 5000;
    
    if (isNew) {
        await logUserAction(ctx.from.id, 'registration');
        await processNewUserReferral(user, ctx);
    }
    
    await ctx.reply(isNew ? T('start_new_user') : T('start'), {
        parse_mode: 'HTML', disable_web_page_preview: true,
        ...Markup.keyboard([[T('menu'), '🆔 Распознать', T('upgrade')], [T('mytracks'), T('help')]]).resize()
    });
});

// ==================================================
// --- ФУНКЦИОНАЛ ЗАГРУЗКИ И КЭША (ADMIN) ---
// ==================================================

async function processUploadQueue(ctx) {
    if (isUploading || uploadQueue.length === 0) return;
    isUploading = true;

    while (uploadQueue.length > 0) {
        const task = uploadQueue.shift();
        const { audio, performer, title } = task;

        try {
            const msg = await ctx.telegram.sendAudio(STORAGE_CHANNEL_ID, audio.file_id, {
                caption: `#manual_upload\n${performer} - ${title}`,
                title: `${title} (Instrumental)`, performer
            });

            await saveKaraokeCache(audio.file_unique_id, msg.audio.file_id, null, performer, title);
            console.log(`[Upload] Saved: ${title}`);
        } catch (e) {
            console.error(`[Upload Error] ${title}:`, e.message);
            if (e.description?.includes('Too Many Requests')) {
                const waitTime = (e.parameters?.retry_after || 10) * 1000;
                uploadQueue.unshift(task);
                await new Promise(r => setTimeout(r, waitTime + 1000));
            }
        }
        await new Promise(r => setTimeout(r, 3000));
    }
    isUploading = false;
    await ctx.telegram.sendMessage(ADMIN_ID, '✅ <b>Очередь загрузки завершена!</b>', { parse_mode: 'HTML' });
}

bot.command('upload_on', async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    isAdminUploadMode = true;
    ctx.reply('📂 Режим загрузки ВКЛЮЧЕН.');
});

bot.command('upload_off', async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    isAdminUploadMode = false;
    ctx.reply('✅ Режим загрузки ВЫКЛЮЧЕН.');
});

bot.command('dbcheck', async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    try {
        const res = await pool.query(`SELECT performer, title, created_at FROM karaoke_cache ORDER BY created_at DESC LIMIT 10`);
        if (res.rows.length === 0) return ctx.reply('📭 База пуста.');
        
        let msg = '📂 <b>Последние записи:</b>\n\n';
        res.rows.forEach((row, i) => msg += `${i+1}. "${row.performer}" — "${row.title}"\n`);
        await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (e) { ctx.reply('Ошибка: ' + e.message); }
});

// ==================================================
// --- ОБРАБОТКА МЕДИА (ЕДИНЫЙ ХЭНДЛЕР) ---
// ==================================================

bot.on(['voice', 'video_note', 'audio', 'video'], async (ctx, next) => {
    // 1. Режим загрузки Админа
    if (isAdminUploadMode && String(ctx.from.id) === String(ADMIN_ID)) {
        const audio = ctx.message.audio || ctx.message.voice;
        if (!audio) return;

        let performer = audio.performer || 'Unknown Artist';
        let title = audio.title || (audio.file_name ? path.parse(audio.file_name).name : 'Unknown Track');

        title = title.replace(/\(Instrumental\)/gi, '').replace(/\(Minus\)/gi, '').replace(/\(Karaoke\)/gi, '')
                     .replace(/Instrumental/gi, '').replace(/Minus/gi, '').replace(/_/g, ' ').trim().replace(/^-+|-+$/g, '').trim();

        uploadQueue.push({ audio, performer, title });
        if (!isUploading) processUploadQueue(ctx);
        console.log(`[Queue] Added: ${title}`);
        return; 
    }
    // 2. Обычный режим (Shazam)
    return handleMediaForShazam(ctx, next);
});

const handleMediaForShazam = async (ctx) => {
    const msg = ctx.message;
    if (msg.via_bot && msg.via_bot.id === ctx.botInfo.id) return;

    const fileId = msg.voice?.file_id || msg.video_note?.file_id || msg.audio?.file_id || msg.video?.file_id;
    if (!fileId) return;

    let statusMsg;
    try {
        statusMsg = await ctx.reply('👂 Слушаю...');
        const link = await ctx.telegram.getFileLink(fileId);
        const result = await identifyTrack(link.href);
        await ctx.deleteMessage(statusMsg.message_id).catch(()=>{});

        if (result) {
            const query = `${result.artist} - ${result.title}`;
            const cached = await performInlineSearch(query, ctx.from.id);
            const count = cached.filter(r => r.audio_file_id).length;
            
            let text = `🎵 <b>Shazam:</b>\n\n🎤 <b>${result.artist}</b>\n🎼 <b>${result.title}</b>`;
            const buttons = count > 0 
                ? [[Markup.button.switchToCurrentChat(`📂 В кэше (${count})`, query)]]
                : [[Markup.button.switchToCurrentChat(`🔎 Искать в SoundCloud`, query)]];

            if (result.image) await ctx.replyWithPhoto(result.image, { caption: text, parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
            else await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        } else {
            await ctx.reply('🤷‍♂️ Не удалось распознать.');
        }
    } catch (e) {
        if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(()=>{});
        await ctx.reply('⚠️ Ошибка обработки.');
    }
};

// ==================================================
// --- КАРАОКЕ И ФУНКЦИИ (/minus, /fix) ---
// ==================================================

// --- KARAOKE HANDLER (С КНОПКОЙ И БЕЗОПАСНЫМ HTML) ---
bot.command('minus', async (ctx) => {
    const reply = ctx.message.reply_to_message;
    if (!reply || (!reply.audio && !reply.voice)) return ctx.reply('❌ Ответьте на аудиофайл.');

    const audioObj = reply.audio || reply.voice;
    const uniqueId = audioObj.file_unique_id;

    if (processingSet.has(uniqueId)) return ctx.reply('⏳ Трек уже обрабатывается.');
    processingSet.add(uniqueId);

    let metaPerformer = audioObj.performer || 'Unknown Artist';
    let metaTitle = audioObj.title || (audioObj.file_name ? path.parse(audioObj.file_name).name : 'Unknown Track');
    const fullSearchString = `${metaPerformer} ${metaTitle} ${audioObj.file_name || ''}`.toLowerCase();

    let statusMsg, cachedInstId;

    try {
        // 1. Поиск
        let cached = await getKaraokeCache(uniqueId);
        let matchType = 'ID';

        if (!cached) {
            cached = await findKaraokeByMetadata(metaPerformer, metaTitle);
            if (cached) matchType = 'Metadata';
        }
        if (!cached) {
            cached = await findKaraokeFuzzy(fullSearchString);
            if (cached) matchType = 'Fuzzy';
        }

        // === ЕСЛИ НАШЛИ В БАЗЕ ===
        if (cached && cached.instrumental_file_id) {
            const title = cached.title || metaTitle;
            const perf = cached.performer || metaPerformer;
            const safeBot = escapeHtml(ctx.botInfo.username);
            
            // Создаем кнопку
            const lyricsId = `ly_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 5)}`;
            lyricsSessions.set(lyricsId, { artist: perf, title: title });

            try {
                await ctx.replyWithAudio(cached.instrumental_file_id, {
                    caption: `🎼 <b>Инструментал (Минус)</b>\n⚡️ <i>Взято из базы</i>\n🤖 @${safeBot}`,
                    parse_mode: 'HTML', 
                    title: `${title} (Inst)`, 
                    performer: perf,
                    ...Markup.inlineKeyboard([
                        Markup.button.callback('📜 Текст песни', lyricsId)
                    ])
                });
            } catch (e) {
                // Если HTML сломался — шлем без разметки и кнопок
                await ctx.replyWithAudio(cached.instrumental_file_id, { caption: '🎼 Инструментал', title: `${title} (Inst)`, performer: perf });
            }

            if (matchType !== 'ID') await saveKaraokeCache(uniqueId, cached.instrumental_file_id, null, perf, title);
            return;
        }

        // === 2. ОБРАБОТКА НОВОГО ФАЙЛА ===
        statusMsg = await ctx.reply('⏳ <b>Не найдено в базе.</b>\nЗагружаю на сервер...', { parse_mode: 'HTML' });
        const link = await ctx.telegram.getFileLink(audioObj.file_id);
        
        const updateStatus = async (i) => {
            const text = i.status === 'processing' ? `🔪 <b>Разделение...</b> (2-5 мин)` : `⏳ <b>Очередь:</b> ${i.position}`;
            try { await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, text, { parse_mode: 'HTML' }); } catch (e) {}
        };

        const res = await processKaraoke(link.href, updateStatus);
        if (!res.Instrumental) throw new Error('No instrumental');

        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '✅ <b>Готово!</b> Скачиваю...', { parse_mode: 'HTML' });

        // 3. Скачивание и сохранение
        const tempPath = path.join(os.tmpdir(), `proc_${Date.now()}.mp3`);
        try {
            const writer = fs.createWriteStream(tempPath);
            const response = await axios({ url: res.Instrumental, method: 'GET', responseType: 'stream' });
            response.data.pipe(writer);
            await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });

            if (STORAGE_CHANNEL_ID) {
                const msg = await ctx.telegram.sendAudio(STORAGE_CHANNEL_ID, { source: tempPath, filename: `${metaPerformer} - ${metaTitle} (Instrumental).mp3` }, {
                    title: `${metaTitle} (Inst)`, performer: metaPerformer, caption: `#karaoke_new`
                });
                cachedInstId = msg.audio.file_id;
            }
        } catch (e) { console.error(e); }
        finally { if (fs.existsSync(tempPath)) fs.unlink(tempPath, () => {}); }

        if (cachedInstId) await saveKaraokeCache(uniqueId, cachedInstId, null, metaPerformer, metaTitle);

        // === ОТПРАВКА РЕЗУЛЬТАТА ===
        const finalSend = cachedInstId || { url: res.Instrumental };
        
        // Создаем кнопку
        const lyricsId = `ly_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 5)}`;
        lyricsSessions.set(lyricsId, { artist: metaPerformer, title: metaTitle });

        try {
            await ctx.replyWithAudio(finalSend, {
                caption: `🎼 <b>Инструментал (Минус)</b>\n🤖 Сделано ботом @${escapeHtml(ctx.botInfo.username)}`,
                parse_mode: 'HTML', 
                title: `${metaTitle} (Inst)`, 
                performer: metaPerformer,
                ...Markup.inlineKeyboard([
                    Markup.button.callback('📜 Текст песни', lyricsId)
                ])
            });
        } catch (e) {
             await ctx.replyWithAudio(finalSend, {
                caption: `🎼 Инструментал (Минус)\n🤖 Сделано ботом @${ctx.botInfo?.username}`,
                title: `${metaTitle} (Inst)`, performer: metaPerformer
            });
        }

        await ctx.deleteMessage(statusMsg.message_id).catch(()=>{});

    } catch (e) {
        console.error(e);
        if (e.message === 'QUEUE_FULL') {
             if (statusMsg) await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '⚠️ Нагрузка. Повторите.').catch(()=>{});
        } else {
             if (statusMsg) await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ Ошибка.').catch(()=>{});
             else ctx.reply('❌ Ошибка.');
        }
    } finally {
        processingSet.delete(uniqueId);
    }
});
// --- ПОИСК МИНУСОВОК (С КНОПКАМИ) ---
bot.command('findminus', async (ctx) => {
    const query = ctx.payload; // Текст после команды
    
    if (!query) {
        return ctx.reply('🔍 Введите название или исполнителя.\nПример: <code>/findminus Linkin Park</code>', { parse_mode: 'HTML' });
    }

    const results = await searchKaraoke(query);

    if (results.length === 0) {
        return ctx.reply('❌ Минусовки не найдены.');
    }

    // Если 1 результат — сразу кидаем файл
    if (results.length === 1) {
        const t = results[0];
        return ctx.replyWithAudio(t.instrumental_file_id, {
            caption: `🔎 Найдено: <b>${t.performer} - ${t.title}</b>`,
            parse_mode: 'HTML',
            title: `${t.title} (Inst)`,
            performer: t.performer
        });
    }

    // Если результатов много — показываем кнопки
    const buttons = results.map(t => {
        // Формируем текст кнопки: "Artist - Title"
        let label = `${t.performer} - ${t.title}`;
        if (label.length > 30) label = label.substring(0, 28) + '..';
        
        // Используем уникальный ID файла для коллбека
        return [Markup.button.callback(`🎵 ${label}`, `km_${t.file_unique_id}`)];
    });

    // Добавляем кнопку отмены
    buttons.push([Markup.button.callback('❌ Закрыть', 'delete_msg')]);

    await ctx.reply(`🔎 <b>Найдено ${results.length} вариантов:</b>\nВыберите нужный:`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(buttons)
    });
});

// --- ОБРАБОТЧИК ВЫБОРА ИЗ ПОИСКА ---
// --- ОБРАБОТЧИК ВЫБОРА ИЗ ПОИСКА (/findminus) ---
bot.action(/^km_(.+)/, async (ctx) => {
    const uniqueId = ctx.match[1]; 

    try {
        await ctx.answerCbQuery('Загружаю...');
        
        // Ищем трек в базе
        const cached = await getKaraokeCache(uniqueId);
        
        if (!cached || !cached.instrumental_file_id) {
            return ctx.editMessageText('❌ Файл больше недоступен.');
        }

        // --- СОЗДАЕМ КНОПКУ ТЕКСТА ---
        const lyricsId = `ly_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 5)}`;
        lyricsSessions.set(lyricsId, { artist: cached.performer, title: cached.title });

        // Отправляем файл С КНОПКОЙ
        await ctx.replyWithAudio(cached.instrumental_file_id, {
            caption: `🎼 <b>Инструментал (Минус)</b>\n🤖 @${escapeHTML(ctx.botInfo.username)}`,
            parse_mode: 'HTML',
            title: `${cached.title} (Inst)`,
            performer: cached.performer,
            ...Markup.inlineKeyboard([
                Markup.button.callback('📜 Текст песни', lyricsId) // <--- ВОТ ОНА
            ])
        });

    } catch (e) {
        console.error(e);
        ctx.answerCbQuery('Ошибка', { show_alert: true });
    }
});

// Обработчик кнопки удаления (если его еще нет)
bot.action('delete_msg', (ctx) => ctx.deleteMessage().catch(() => {}));
// --- АДМИНСКИЕ УТИЛИТЫ (FIX USER / FIX FILE) ---

bot.command('fixuser', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const targetUserId = parseInt(ctx.message.text.split(' ')[1], 10);
  if (!targetUserId) return ctx.reply('ID?');

  ctx.reply(`✅ Фикс юзера ${targetUserId} запущен.`);
  
  (async () => {
    const urls = await getUserUniqueDownloadedUrls(targetUserId);
    let fixed = 0;
    for (const url of urls) {
        try {
            const track = await findCachedTrack(url);
            if (!track?.fileId) continue;
            const fInfo = await bot.telegram.getFile(track.fileId);
            if (fInfo.file_path.endsWith('.mp3')) continue; // Уже ок

            const link = await bot.telegram.getFileLink(track.fileId);
            const msg = await bot.telegram.sendAudio(STORAGE_CHANNEL_ID, { url: link.href, filename: `${sanitizeFilename(track.title)}.mp3` }, { title: track.title });
            if (msg.audio) await updateFileId(track.fileId, msg.audio.file_id);
            fixed++;
        } catch(e) {}
        await new Promise(r => setTimeout(r, 3000));
    }
    bot.telegram.sendMessage(ADMIN_ID, `✅ Юзер ${targetUserId}: исправлено ${fixed}`);
  })();
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

// --- АДМИН И СТАТИСТИКА ---

bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const [users, tracks, failed, recent, new1, new7] = await Promise.all([
        getAllUsers(true), getCachedTracksCount(), getTopFailedSearches(5), getTopRecentSearches(5), getNewUsersCount(1), getNewUsersCount(7)
    ]);
    
    let txt = `<b>📊 Статистика</b>\nUsers: ${users.length}\nActive: ${users.filter(u=>u.active).length}\nNew 24h: ${new1}\nNew 7d: ${new7}\nTracks: ${tracks}\nQueue: ${downloadQueue.size}`;
    ctx.reply(txt, { parse_mode: 'HTML' });
});

bot.command('referral', handleReferralCommand);
bot.command('premium', (ctx) => ctx.reply(T('upgradeInfo'), { parse_mode: 'HTML', disable_web_page_preview: true }));

bot.command('maintenance', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const cmd = ctx.message.text.split(' ')[1]?.toLowerCase();
    if (cmd === 'on') { setMaintenanceMode(true); ctx.reply('On'); }
    else if (cmd === 'off') { setMaintenanceMode(false); ctx.reply('Off'); }
    else ctx.reply(`Status: ${isMaintenanceMode}`);
});

// --- ACTIONS & MENUS ---

bot.action('check_subscription', async (ctx) => {
    const user = await getUser(ctx.from.id);
    if (user.subscribed_bonus_used) return ctx.answerCbQuery('Уже использовано.', {show_alert:true});
    if (await isSubscribed(ctx.from.id)) {
        await setPremium(ctx.from.id, 30, 7);
        await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
        ctx.answerCbQuery('Бонус начислен!');
        ctx.editMessageText('🎉 Бонус получен!');
    } else ctx.answerCbQuery('Вы не подписаны.', {show_alert:true});
});

bot.hears(T('menu'), async (ctx) => {
    const user = await getUser(ctx.from.id);
    const msg = formatMenuMessage(user, ctx.botInfo.username);
    const opts = { parse_mode: 'HTML', disable_web_page_preview: true };
    if (!user.subscribed_bonus_used && CHANNEL_USERNAME) opts.reply_markup = { inline_keyboard: [[Markup.button.callback('✅ Получить бонус', 'check_subscription')]] };
    ctx.reply(msg, opts);
});

bot.hears(T('mytracks'), async (ctx) => {
    const user = await getUser(ctx.from.id);
    if (!user.tracks_today?.length) return ctx.reply(T('noTracks'));
    for (let i=0; i<user.tracks_today.length; i+=10) {
        const chunk = user.tracks_today.slice(i, i+10).filter(t => t.fileId);
        if (chunk.length) await ctx.replyWithMediaGroup(chunk.map(t => ({ type: 'audio', media: t.fileId })));
    }
});
// --- ОБРАБОТЧИК КНОПКИ ТЕКСТА ---
bot.action(/^ly_/, async (ctx) => {
    const id = ctx.match.input; // Получаем ID кнопки
    const session = lyricsSessions.get(id);

    if (!session) {
        return ctx.answerCbQuery('⚠️ Срок действия кнопки истек.');
    }

    await ctx.answerCbQuery('🔍 Ищу текст...');
    
    try {
        const result = await getLyrics(session.artist, session.title);

        if (!result) {
            return ctx.reply('😔 Текст для этой песни не найден.', { reply_to_message_id: ctx.callbackQuery.message.message_id });
        }

        // Если текст слишком длинный (лимит телеграма 4096), режем
        const header = `🎤 <b>${result.artist} - ${result.title}</b>\n\n`;
        let lyricsText = result.text;
        
        if (lyricsText.length > 3800) {
            lyricsText = lyricsText.substring(0, 3800) + '...\n(Текст обрезан)';
        }

        // Отправляем текст
        await ctx.reply(header + lyricsText, { 
            parse_mode: 'HTML',
            disable_web_page_preview: true 
        });

    } catch (e) {
        console.error(e);
        ctx.reply('Ошибка при получении текста.');
    }
});
bot.hears('🆔 Распознать', (ctx) => ctx.reply('Отправьте аудио или голосовое...'));
bot.hears(T('help'), (ctx) => ctx.reply(T('helpInfo'), { parse_mode: 'HTML' }));
bot.hears(T('upgrade'), (ctx) => ctx.reply(T('upgradeInfo'), { parse_mode: 'HTML' }));

bot.on('inline_query', async (ctx) => {
    if (!ctx.inlineQuery.query || ctx.inlineQuery.query.length < 2) return;
    try {
        const res = await performInlineSearch(ctx.inlineQuery.query, ctx.from.id);
        await ctx.answerInlineQuery(res, { cache_time: 60 });
    } catch (e) { console.error(e); }
});

// --- ПЛЕЙЛИСТЫ ---

function generateInitialPlaylistMenu(pid, count) {
    return Markup.inlineKeyboard([
        [Markup.button.callback(`📥 Все (${count})`, `pl_download_all:${pid}`)],
        [Markup.button.callback('📥 Первые 10', `pl_download_10:${pid}`)],
        [Markup.button.callback('📝 Выбрать', `pl_select_manual:${pid}`)],
        [Markup.button.callback('❌ Отмена', `pl_cancel:${pid}`)]
    ]);
}

function generateSelectionMenu(userId) {
    const session = playlistSessions.get(userId);
    if (!session) return null;
    const { tracks, selected, currentPage, playlistId, title } = session;
    const totalPages = Math.ceil(tracks.length / TRACKS_PER_PAGE);
    const start = currentPage * TRACKS_PER_PAGE;
    const pageTracks = tracks.slice(start, start + TRACKS_PER_PAGE);
    
    const rows = pageTracks.map((t, i) => {
        const absIdx = start + i;
        const icon = selected.has(absIdx) ? '✅' : '⬜️';
        return [Markup.button.callback(`${icon} ${t.title.slice(0,40)}`, `pl_toggle:${playlistId}:${absIdx}`)];
    });
    
    const nav = [];
    if (currentPage > 0) nav.push(Markup.button.callback('⬅️', `pl_page:${playlistId}:${currentPage-1}`));
    nav.push(Markup.button.callback(`${currentPage+1}/${totalPages}`, 'noop'));
    if (currentPage < totalPages-1) nav.push(Markup.button.callback('➡️', `pl_page:${playlistId}:${currentPage+1}`));
    
    return {
        text: `🎶 <b>${title}</b>\nВыбрано: ${selected.size}`,
        options: { parse_mode: 'HTML', ...Markup.inlineKeyboard([...rows, nav, [
            Markup.button.callback('✅ Готово', `pl_finish:${playlistId}`),
            Markup.button.callback('❌ Отмена', `pl_cancel:${playlistId}`)
        ]])}
    };
}

bot.action(/pl_download_all:|pl_download_10:/, async (ctx) => {
    const isAll = ctx.match[0].includes('all');
    const session = playlistSessions.get(ctx.from.id);
    if (!session) return ctx.answerCbQuery('Истекло.');
    
    if (!session.fullTracks) {
        await ctx.answerCbQuery('Загружаю...');
        try {
            const dl = getYoutubeDl();
            const data = await dl(session.originalUrl, { dumpSingleJson: true });
            session.tracks = data.entries;
            session.fullTracks = true;
        } catch(e) { return ctx.answerCbQuery('Ошибка.'); }
    }
    
    const user = await getUser(ctx.from.id);
    const limit = user.premium_limit - (user.downloads_today || 0);
    if (limit <= 0) return ctx.editMessageText(T('limitReached'));
    
    const count = Math.min(isAll ? session.tracks.length : 10, limit);
    const toAdd = session.tracks.slice(0, count);
    
    toAdd.forEach(t => addTaskToQueue({ userId: ctx.from.id, source: 'sc', url: t.webpage_url, metadata: t }));
    ctx.reply(`⏳ Добавлено ${count} треков.`);
    playlistSessions.delete(ctx.from.id);
});

bot.action(/pl_select_manual:(.+)/, async (ctx) => {
    const session = playlistSessions.get(ctx.from.id);
    if (!session) return ctx.answerCbQuery('Истекло.');
    
    if (!session.fullTracks) {
        await ctx.answerCbQuery('Загружаю...');
        try {
            const dl = getYoutubeDl();
            const data = await dl(session.originalUrl, { dumpSingleJson: true });
            session.tracks = data.entries;
            session.fullTracks = true;
        } catch(e) { return ctx.answerCbQuery('Ошибка.'); }
    }
    
    const menu = generateSelectionMenu(ctx.from.id);
    if (menu) await ctx.editMessageText(menu.text, menu.options);
});

bot.action(/pl_toggle:(.+):(\d+)/, async (ctx) => {
    const idx = parseInt(ctx.match[2]);
    const session = playlistSessions.get(ctx.from.id);
    if (session) {
        if (session.selected.has(idx)) session.selected.delete(idx);
        else session.selected.add(idx);
        const menu = generateSelectionMenu(ctx.from.id);
        if (menu) await ctx.editMessageText(menu.text, menu.options);
    }
    ctx.answerCbQuery();
});

bot.action(/pl_page:(.+):(\d+)/, async (ctx) => {
    const page = parseInt(ctx.match[2]);
    const session = playlistSessions.get(ctx.from.id);
    if (session) {
        session.currentPage = page;
        const menu = generateSelectionMenu(ctx.from.id);
        if (menu) await ctx.editMessageText(menu.text, menu.options);
    }
    ctx.answerCbQuery();
});

bot.action(/pl_finish:(.+)/, async (ctx) => {
    const session = playlistSessions.get(ctx.from.id);
    if (!session) return ctx.answerCbQuery('Истекло.');
    
    const user = await getUser(ctx.from.id);
    const limit = user.premium_limit - (user.downloads_today || 0);
    const selected = Array.from(session.selected);
    const count = Math.min(selected.length, limit);
    
    selected.slice(0, count).forEach(i => addTaskToQueue({ userId: ctx.from.id, source: 'sc', url: session.tracks[i].webpage_url, metadata: session.tracks[i] }));
    ctx.reply(`⏳ Добавлено ${count} треков.`);
    playlistSessions.delete(ctx.from.id);
});

bot.action(/pl_cancel:(.+)/, async (ctx) => {
    playlistSessions.delete(ctx.from.id);
    await ctx.deleteMessage().catch(()=>{});
    ctx.answerCbQuery('Отменено');
});

async function handleSoundCloudUrl(ctx, url) {
    let loading = await ctx.reply('🔍 Анализ...');
    try {
        const dl = getYoutubeDl();
        const data = await dl(url, { dumpSingleJson: true, flatPlaylist: true });
        await ctx.deleteMessage(loading.message_id).catch(()=>{});

        if (data.entries?.length > 1) {
            const pid = `pl_${Date.now()}`;
            playlistSessions.set(ctx.from.id, { playlistId: pid, title: data.title, tracks: data.entries, originalUrl: url, selected: new Set(), currentPage: 0, fullTracks: false });
            await ctx.reply(`🎶 Плейлист <b>${escapeHtml(data.title)}</b> (${data.entries.length}).`, { parse_mode: 'HTML', ...generateInitialPlaylistMenu(pid, data.entries.length) });
        } else {
            addTaskToQueue({ userId: ctx.from.id, source: 'soundcloud', url: data.webpage_url || url, metadata: data });
        }
    } catch (e) {
        console.error(e);
        ctx.reply('❌ Ошибка обработки ссылки.');
    }
}

// --- TEXT HANDLER (FINAL) ---
bot.on('text', async (ctx) => {
    if (isShuttingDown()) return;
    if (isMaintenanceMode() && ctx.from.id !== ADMIN_ID) return ctx.reply('⏳ Обслуживание.');
    if (ctx.chat.type !== 'private') return;
    
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    
    const url = text.match(/(https?:\/\/[^\s]+)/g)?.[0];
    if (!url) return ctx.reply('Отправьте ссылку.');

    if (url.includes('soundcloud.com')) {
        const user = await getUser(ctx.from.id);
        if ((user.downloads_today || 0) >= (user.premium_limit || 0)) return ctx.reply(T('limitReached'));
        handleSoundCloudUrl(ctx, url);
    } else {
        ctx.reply('Поддерживаю только SoundCloud.');
    }
});
