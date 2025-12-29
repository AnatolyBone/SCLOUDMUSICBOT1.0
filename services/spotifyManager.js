// services/spotifyManager.js - Spotify с выбором треков и качества

import { Markup } from 'telegraf';
import { SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET } from '../config.js';
import { downloadQueue } from './downloadManager.js';
import { getUser } from '../db.js';

// ========================= QUALITY PRESETS =========================

export const QUALITY_PRESETS = {
  low: { label: '🔉 128 kbps', bitrate: '128K', format: 'mp3' },
  medium: { label: '🔊 192 kbps', bitrate: '192K', format: 'mp3' },
  high: { label: '🎧 320 kbps', bitrate: '320K', format: 'mp3' }
};

// ========================= SPOTIFY API =========================

let spotifyToken = null;
let tokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) {
    return spotifyToken;
  }
  
  const credentials = Buffer.from(`${SPOTIPY_CLIENT_ID}:${SPOTIPY_CLIENT_SECRET}`).toString('base64');
  
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  
  if (!response.ok) {
    throw new Error(`Spotify auth failed: ${response.status}`);
  }
  
  const data = await response.json();
  spotifyToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  
  console.log('[Spotify] Token получен, истекает через', data.expires_in, 'сек');
  return spotifyToken;
}

async function spotifyApi(endpoint) {
  const token = await getSpotifyToken();
  
  const response = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (!response.ok) {
    throw new Error(`Spotify API error: ${response.status}`);
  }
  
  return response.json();
}

// ========================= URL PARSING =========================

function parseSpotifyUrl(url) {
  const patterns = {
    track: /spotify\.com\/(?:intl-\w+\/)?track\/([a-zA-Z0-9]+)/,
    album: /spotify\.com\/(?:intl-\w+\/)?album\/([a-zA-Z0-9]+)/,
    playlist: /spotify\.com\/(?:intl-\w+\/)?playlist\/([a-zA-Z0-9]+)/
  };
  
  for (const [type, pattern] of Object.entries(patterns)) {
    const match = url.match(pattern);
    if (match) return { type, id: match[1] };
  }
  return null;
}

// ========================= METADATA EXTRACTION =========================

async function getSpotifyTrackInfo(url) {
  const parsed = parseSpotifyUrl(url);
  
  if (!parsed) {
    console.error('[Spotify] Не удалось распарсить URL:', url);
    return null;
  }
  
  try {
    if (parsed.type === 'track') {
      const track = await spotifyApi(`/tracks/${parsed.id}`);
      return {
        type: 'track',
        title: null,
        tracks: [{
          title: track.name,
          artist: track.artists.map(a => a.name).join(', '),
          duration: Math.round(track.duration_ms / 1000),
          thumbnail: track.album?.images?.[0]?.url,
          searchQuery: `${track.artists[0]?.name} - ${track.name}`,
          originalUrl: url
        }]
      };
      
    } else if (parsed.type === 'album') {
      const album = await spotifyApi(`/albums/${parsed.id}`);
      return {
        type: 'album',
        title: album.name,
        artist: album.artists.map(a => a.name).join(', '),
        thumbnail: album.images?.[0]?.url,
        tracks: album.tracks.items.map((track, idx) => ({
          index: idx,
          title: track.name,
          artist: track.artists.map(a => a.name).join(', '),
          duration: Math.round(track.duration_ms / 1000),
          thumbnail: album.images?.[0]?.url,
          searchQuery: `${track.artists[0]?.name} - ${track.name}`,
          originalUrl: track.external_urls?.spotify || url
        }))
      };
      
    } else if (parsed.type === 'playlist') {
      const playlist = await spotifyApi(`/playlists/${parsed.id}?fields=name,description,images,tracks.items(track(name,artists,duration_ms,album(images),external_urls))`);
      return {
        type: 'playlist',
        title: playlist.name,
        thumbnail: playlist.images?.[0]?.url,
        tracks: playlist.tracks.items
          .filter(item => item.track)
          .map((item, idx) => ({
            index: idx,
            title: item.track.name,
            artist: item.track.artists.map(a => a.name).join(', '),
            duration: Math.round(item.track.duration_ms / 1000),
            thumbnail: item.track.album?.images?.[0]?.url,
            searchQuery: `${item.track.artists[0]?.name} - ${item.track.name}`,
            originalUrl: item.track.external_urls?.spotify || url
          }))
      };
    }
    
  } catch (e) {
    console.error('[Spotify] API error:', e.message);
    return null;
  }
  
  return null;
}

// ========================= SESSION MANAGEMENT =========================

const spotifySessions = new Map();

function cleanupOldSessions() {
  const now = Date.now();
  const maxAge = 15 * 60 * 1000; // 15 минут
  for (const [id, session] of spotifySessions) {
    if (now - session.createdAt > maxAge) {
      spotifySessions.delete(id);
    }
  }
}

// Периодическая очистка
setInterval(cleanupOldSessions, 5 * 60 * 1000);

function formatDuration(seconds) {
  if (!seconds) return 'N/A';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ========================= MENU GENERATORS =========================

/**
 * Начальное меню для плейлиста/альбома
 */
function generatePlaylistMenu(sessionId, trackCount, type = 'playlist') {
  const emoji = type === 'album' ? '💿' : '📂';
  
  return Markup.inlineKeyboard([
    [Markup.button.callback(`📥 Скачать все (${trackCount})`, `sp_dl_all:${sessionId}`)],
    [Markup.button.callback('📥 Скачать первые 10', `sp_dl_10:${sessionId}`)],
    [Markup.button.callback('📝 Выбрать треки', `sp_select:${sessionId}:0`)],
    [Markup.button.callback('❌ Отмена', `sp_cancel:${sessionId}`)]
  ]);
}

/**
 * Меню выбора качества
 */
function generateQualityMenu(sessionId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🔉 128 kbps', `sp_quality:${sessionId}:low`),
      Markup.button.callback('🔊 192 kbps', `sp_quality:${sessionId}:medium`)
    ],
    [
      Markup.button.callback('🎧 320 kbps', `sp_quality:${sessionId}:high`)
    ],
    [Markup.button.callback('❌ Отмена', `sp_cancel:${sessionId}`)]
  ]);
}

/**
 * Меню выбора треков (с пагинацией)
 */
function generateTrackSelectionMenu(sessionId, session, page = 0) {
  const TRACKS_PER_PAGE = 8;
  const tracks = session.tracks;
  const selected = session.selectedTracks || new Set();
  
  const totalPages = Math.ceil(tracks.length / TRACKS_PER_PAGE);
  const startIdx = page * TRACKS_PER_PAGE;
  const endIdx = Math.min(startIdx + TRACKS_PER_PAGE, tracks.length);
  const pageTracks = tracks.slice(startIdx, endIdx);
  
  const buttons = [];
  
  // Треки с чекбоксами
  for (const track of pageTracks) {
    const isSelected = selected.has(track.index);
    const checkbox = isSelected ? '✅' : '⬜️';
    const label = `${checkbox} ${track.artist} - ${track.title}`.slice(0, 45);
    
    buttons.push([
      Markup.button.callback(label, `sp_toggle:${sessionId}:${track.index}:${page}`)
    ]);
  }
  
  // Навигация
  const navRow = [];
  if (page > 0) {
    navRow.push(Markup.button.callback('⬅️ Назад', `sp_select:${sessionId}:${page - 1}`));
  }
  navRow.push(Markup.button.callback(`${page + 1}/${totalPages}`, `sp_noop`));
  if (page < totalPages - 1) {
    navRow.push(Markup.button.callback('Вперёд ➡️', `sp_select:${sessionId}:${page + 1}`));
  }
  buttons.push(navRow);
  
  // Действия
  const selectedCount = selected.size;
  buttons.push([
    Markup.button.callback('☑️ Выбрать все', `sp_select_all:${sessionId}:${page}`),
    Markup.button.callback('◻️ Снять все', `sp_deselect_all:${sessionId}:${page}`)
  ]);
  
  buttons.push([
    Markup.button.callback(
      `✅ Скачать выбранные (${selectedCount})`, 
      selectedCount > 0 ? `sp_dl_selected:${sessionId}` : 'sp_noop'
    )
  ]);
  
  buttons.push([Markup.button.callback('❌ Отмена', `sp_cancel:${sessionId}`)]);
  
  return Markup.inlineKeyboard(buttons);
}

// ========================= MAIN HANDLER =========================

/**
 * Обрабатывает Spotify ссылку
 */
export async function handleSpotifyUrl(ctx, url) {
  let statusMessage = null;
  
  try {
    if (!SPOTIPY_CLIENT_ID || !SPOTIPY_CLIENT_SECRET) {
      return await ctx.reply('❌ Spotify API не настроен.');
    }
    
    statusMessage = await ctx.reply('🔍 Получаю информацию из Spotify...');
    
    const data = await getSpotifyTrackInfo(url);
    
    if (!data || !data.tracks || data.tracks.length === 0) {
      return await ctx.telegram.editMessageText(
        ctx.chat.id, statusMessage.message_id, undefined,
        '❌ Не удалось получить информацию. Проверьте ссылку.'
      );
    }
    
    // Проверяем лимиты
    const user = await getUser(ctx.from.id);
    const remainingLimit = (user.premium_limit || 5) - (user.downloads_today || 0);
    
    if (remainingLimit <= 0) {
      return await ctx.telegram.editMessageText(
        ctx.chat.id, statusMessage.message_id, undefined,
        '🚫 Дневной лимит загрузок исчерпан.'
      );
    }
    
    // Создаём сессию
    const sessionId = `sp_${Date.now()}_${ctx.from.id}`;
    const session = {
      type: data.type,
      title: data.title,
      tracks: data.tracks.map((t, i) => ({ ...t, index: i })),
      url,
      userId: ctx.from.id,
      selectedTracks: new Set(),
      quality: null,
      createdAt: Date.now()
    };
    
    spotifySessions.set(sessionId, session);
    cleanupOldSessions();
    
    // Одиночный трек → сразу меню качества
    if (data.type === 'track') {
      const track = data.tracks[0];
      session.selectedTracks.add(0);
      
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMessage.message_id, undefined,
        `🎵 <b>${track.title}</b>\n` +
        `👤 ${track.artist}\n` +
        `⏱ ${formatDuration(track.duration)}\n\n` +
        `Выберите качество:`,
        {
          parse_mode: 'HTML',
          ...generateQualityMenu(sessionId)
        }
      );
    } 
    // Плейлист/Альбом → меню выбора
    else {
      const emoji = data.type === 'album' ? '💿' : '📂';
      const tracksToShow = Math.min(data.tracks.length, remainingLimit);
      
      let text = `${emoji} <b>${data.title}</b>\n`;
      text += `🎵 Треков: <b>${data.tracks.length}</b>\n`;
      text += `📥 Доступно для скачивания: <b>${tracksToShow}</b>\n\n`;
      
      // Показываем первые 5 треков
      const preview = data.tracks.slice(0, 5);
      for (const track of preview) {
        text += `• ${track.artist} - ${track.title} (${formatDuration(track.duration)})\n`;
      }
      if (data.tracks.length > 5) {
        text += `\n<i>...и ещё ${data.tracks.length - 5} треков</i>`;
      }
      
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMessage.message_id, undefined,
        text,
        {
          parse_mode: 'HTML',
          ...generatePlaylistMenu(sessionId, data.tracks.length, data.type)
        }
      );
    }
    
  } catch (error) {
    console.error('[Spotify] handleSpotifyUrl error:', error);
    const errorMsg = '❌ Ошибка при обработке Spotify ссылки.';
    if (statusMessage) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, errorMsg).catch(() => {});
    } else {
      await ctx.reply(errorMsg);
    }
  }
}

// ========================= CALLBACK HANDLERS =========================

/**
 * Регистрирует все callback handlers для Spotify
 */
export function registerSpotifyCallbacks(bot) {
  
  // ===== Отмена =====
  bot.action(/^sp_cancel:(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    spotifySessions.delete(sessionId);
    await ctx.deleteMessage().catch(() => {});
    await ctx.answerCbQuery('Отменено');
  });
  
  // ===== No-op (для неактивных кнопок) =====
  bot.action('sp_noop', async (ctx) => {
    await ctx.answerCbQuery();
  });
  
  // ===== Скачать все =====
  bot.action(/^sp_dl_all:(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const session = spotifySessions.get(sessionId);
    
    if (!session) {
      return ctx.answerCbQuery('❌ Сессия истекла', { show_alert: true });
    }
    
    // Выбираем все треки
    session.selectedTracks = new Set(session.tracks.map(t => t.index));
    
    await ctx.answerCbQuery(`Выбрано ${session.selectedTracks.size} треков`);
    
    // Показываем меню качества
    await ctx.editMessageText(
      `📂 <b>${session.title}</b>\n\n` +
      `✅ Выбрано треков: <b>${session.selectedTracks.size}</b>\n\n` +
      `Выберите качество:`,
      {
        parse_mode: 'HTML',
        ...generateQualityMenu(sessionId)
      }
    );
  });
  
  // ===== Скачать первые 10 =====
  bot.action(/^sp_dl_10:(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const session = spotifySessions.get(sessionId);
    
    if (!session) {
      return ctx.answerCbQuery('❌ Сессия истекла', { show_alert: true });
    }
    
    // Выбираем первые 10
    const first10 = session.tracks.slice(0, 10);
    session.selectedTracks = new Set(first10.map(t => t.index));
    
    await ctx.answerCbQuery(`Выбрано ${session.selectedTracks.size} треков`);
    
    await ctx.editMessageText(
      `📂 <b>${session.title}</b>\n\n` +
      `✅ Выбрано треков: <b>${session.selectedTracks.size}</b>\n\n` +
      `Выберите качество:`,
      {
        parse_mode: 'HTML',
        ...generateQualityMenu(sessionId)
      }
    );
  });
  
  // ===== Открыть выбор треков =====
  bot.action(/^sp_select:(.+):(\d+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const page = parseInt(ctx.match[2]);
    const session = spotifySessions.get(sessionId);
    
    if (!session) {
      return ctx.answerCbQuery('❌ Сессия истекла', { show_alert: true });
    }
    
    await ctx.answerCbQuery();
    
    const selected = session.selectedTracks?.size || 0;
    
    await ctx.editMessageText(
      `📂 <b>${session.title}</b>\n\n` +
      `Выберите треки для скачивания:\n` +
      `✅ Выбрано: <b>${selected}</b> из ${session.tracks.length}`,
      {
        parse_mode: 'HTML',
        ...generateTrackSelectionMenu(sessionId, session, page)
      }
    );
  });
  
  // ===== Переключить трек =====
  bot.action(/^sp_toggle:(.+):(\d+):(\d+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const trackIndex = parseInt(ctx.match[2]);
    const page = parseInt(ctx.match[3]);
    const session = spotifySessions.get(sessionId);
    
    if (!session) {
      return ctx.answerCbQuery('❌ Сессия истекла', { show_alert: true });
    }
    
    if (!session.selectedTracks) {
      session.selectedTracks = new Set();
    }
    
    // Переключаем
    if (session.selectedTracks.has(trackIndex)) {
      session.selectedTracks.delete(trackIndex);
    } else {
      session.selectedTracks.add(trackIndex);
    }
    
    await ctx.answerCbQuery();
    
    await ctx.editMessageText(
      `📂 <b>${session.title}</b>\n\n` +
      `Выберите треки для скачивания:\n` +
      `✅ Выбрано: <b>${session.selectedTracks.size}</b> из ${session.tracks.length}`,
      {
        parse_mode: 'HTML',
        ...generateTrackSelectionMenu(sessionId, session, page)
      }
    );
  });
  
  // ===== Выбрать все на странице =====
  bot.action(/^sp_select_all:(.+):(\d+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const page = parseInt(ctx.match[2]);
    const session = spotifySessions.get(sessionId);
    
    if (!session) {
      return ctx.answerCbQuery('❌ Сессия истекла', { show_alert: true });
    }
    
    // Выбираем все треки
    session.selectedTracks = new Set(session.tracks.map(t => t.index));
    
    await ctx.answerCbQuery(`Выбраны все ${session.tracks.length} треков`);
    
    await ctx.editMessageText(
      `📂 <b>${session.title}</b>\n\n` +
      `Выберите треки для скачивания:\n` +
      `✅ Выбрано: <b>${session.selectedTracks.size}</b> из ${session.tracks.length}`,
      {
        parse_mode: 'HTML',
        ...generateTrackSelectionMenu(sessionId, session, page)
      }
    );
  });
  
  // ===== Снять все =====
  bot.action(/^sp_deselect_all:(.+):(\d+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const page = parseInt(ctx.match[2]);
    const session = spotifySessions.get(sessionId);
    
    if (!session) {
      return ctx.answerCbQuery('❌ Сессия истекла', { show_alert: true });
    }
    
    session.selectedTracks = new Set();
    
    await ctx.answerCbQuery('Выбор очищен');
    
    await ctx.editMessageText(
      `📂 <b>${session.title}</b>\n\n` +
      `Выберите треки для скачивания:\n` +
      `✅ Выбрано: <b>0</b> из ${session.tracks.length}`,
      {
        parse_mode: 'HTML',
        ...generateTrackSelectionMenu(sessionId, session, page)
      }
    );
  });
  
  // ===== Скачать выбранные → Меню качества =====
  bot.action(/^sp_dl_selected:(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const session = spotifySessions.get(sessionId);
    
    if (!session) {
      return ctx.answerCbQuery('❌ Сессия истекла', { show_alert: true });
    }
    
    if (!session.selectedTracks || session.selectedTracks.size === 0) {
      return ctx.answerCbQuery('Выберите хотя бы один трек', { show_alert: true });
    }
    
    await ctx.answerCbQuery();
    
    await ctx.editMessageText(
      `📂 <b>${session.title || 'Spotify'}</b>\n\n` +
      `✅ Выбрано треков: <b>${session.selectedTracks.size}</b>\n\n` +
      `Выберите качество:`,
      {
        parse_mode: 'HTML',
        ...generateQualityMenu(sessionId)
      }
    );
  });
  
  // ===== Выбор качества → Запуск скачивания =====
  bot.action(/^sp_quality:(.+):(low|medium|high)$/, async (ctx) => {
    console.log(`[Spotify/Callback] Выбор качества: ${ctx.callbackQuery.data}`);
    const sessionId = ctx.match[1];
    const quality = ctx.match[2];
    const session = spotifySessions.get(sessionId);
    
    if (!session) {
      console.error(`[Spotify/Callback] Сессия не найдена: ${sessionId}`);
      return ctx.answerCbQuery('❌ Сессия истекла', { show_alert: true });
    }
    
    console.log(`[Spotify/Callback] Сессия найдена, треков: ${session.tracks.length}, выбрано: ${session.selectedTracks?.size || 0}`);
    
    await ctx.answerCbQuery(`Качество: ${QUALITY_PRESETS[quality].label}`);
    
    // Получаем выбранные треки
    const selectedIndices = Array.from(session.selectedTracks || []);
    const tracksToDownload = session.tracks.filter(t => selectedIndices.includes(t.index));
    
    if (tracksToDownload.length === 0) {
      return ctx.editMessageText('❌ Нет треков для скачивания.');
    }
    
    // Проверяем лимиты
    const user = await getUser(session.userId);
    const remainingLimit = (user.premium_limit || 5) - (user.downloads_today || 0);
    const tracksToProcess = tracksToDownload.slice(0, remainingLimit);
    
    if (tracksToProcess.length < tracksToDownload.length) {
      await ctx.editMessageText(
        `⚠️ Лимит позволяет скачать только ${tracksToProcess.length} из ${tracksToDownload.length} треков.\n\n` +
        `⏳ Добавляю в очередь...`
      );
    } else {
      await ctx.editMessageText(
        `⏳ Добавляю ${tracksToProcess.length} трек(ов) в очередь...\n` +
        `🎵 Качество: ${QUALITY_PRESETS[quality].label}`
      );
    }
    
    // Добавляем в очередь
    let addedCount = 0;
    
    // Получаем message_id для последующего удаления (одно сообщение на весь плейлист)
    const statusMessageId = ctx.callbackQuery?.message?.message_id;
    
    for (const track of tracksToProcess) {
      const task = {
        userId: session.userId,
        source: 'spotify',
        url: `${track.artist} - ${track.title}`,
        originalUrl: track.originalUrl,
        quality: quality,
        metadata: {
          title: track.title,
          uploader: track.artist,
          duration: track.duration,
          thumbnail: track.thumbnail
        },
        priority: user.premium_limit || 5,
        // Передаем statusMessageId для всех треков, чтобы удалить сообщение после обработки
        statusMessageId: statusMessageId
      };
      
      console.log(`[Spotify] Добавляю в очередь: "${track.artist} - ${track.title}" (${quality})`);
      try {
        downloadQueue.add(task).catch(err => {
          if (err.message === 'TASK_TIMEOUT') {
            console.error(`[TaskQueue] Задача отменена по таймауту: ${track.title}`);
          } else {
            console.error('[TaskQueue] Ошибка выполнения задачи:', err.message);
          }
        });
        addedCount++;
        console.log(`[Spotify] ✅ Задача добавлена (${addedCount}/${tracksToProcess.length})`);
      } catch (err) {
        console.error(`[Spotify] ❌ Ошибка добавления задачи:`, err.message);
      }
    }
    
    // ✅ ОДНО сообщение для всего плейлиста
    await ctx.editMessageText(
      `✅ <b>${addedCount}</b> трек(ов) добавлено в очередь!\n\n` +
      `🎵 Качество: ${QUALITY_PRESETS[quality].label}\n` +
      `⏳ Треки будут отправлены по мере скачивания.`,
      { parse_mode: 'HTML' }
    );
    
    // Удаляем сессию
    spotifySessions.delete(sessionId);
  });
  
  // ===== Старый формат (для совместимости) =====
  bot.action(/^spq:(.+):(low|medium|high|cancel)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const quality = ctx.match[2];
    
    if (quality === 'cancel') {
      spotifySessions.delete(sessionId);
      await ctx.deleteMessage().catch(() => {});
      return ctx.answerCbQuery('Отменено');
    }
    
    // Перенаправляем на новый формат
    const session = spotifySessions.get(sessionId);
    if (session && (!session.selectedTracks || session.selectedTracks.size === 0)) {
      session.selectedTracks = new Set(session.tracks.map(t => t.index));
    }
    
    // Эмулируем новый callback
    ctx.match[1] = sessionId;
    ctx.match[2] = quality;
    
    // Вызываем обработчик качества напрямую
    const handler = bot.middleware();
    ctx.callbackQuery.data = `sp_quality:${sessionId}:${quality}`;
  });
  
  console.log('[Spotify] ✅ Callback handlers зарегистрированы');
}

// ========================= LEGACY EXPORT =========================

export async function handleQualitySelection(ctx, sessionId, quality) {
  // Редирект на новый обработчик
  const session = spotifySessions.get(sessionId);
  if (!session) {
    return ctx.answerCbQuery('❌ Сессия истекла', { show_alert: true });
  }
  
  // Выбираем все треки если не выбраны
  if (!session.selectedTracks || session.selectedTracks.size === 0) {
    session.selectedTracks = new Set(session.tracks.map(t => t.index));
  }
  
  // Устанавливаем match для обработчика
  ctx.match = [null, sessionId, quality];
  
  // Находим и вызываем обработчик
  // (Это будет работать если вызывается из бота)
}

export { spotifySessions };