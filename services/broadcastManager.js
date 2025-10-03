// services/broadcastManager.js (улучшенная версия)

import pMap from 'p-map';
import pTimeout from 'p-timeout';
import { ADMIN_ID } from '../config.js';
import { logBroadcastSent, updateUserField, getBroadcastProgress } from '../db.js';

// --- Helper Functions ---

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MEDIA_TYPES = {
  'image/': 'sendPhoto',
  'video/': 'sendVideo',
  'audio/': 'sendAudio'
};

function getTelegramMethod(mimeType) {
  const prefix = Object.keys(MEDIA_TYPES).find(k => mimeType?.startsWith(k));
  return MEDIA_TYPES[prefix] || 'sendDocument';
}

// --- Core Functions ---

/**
 * Отправляет сообщение одному пользователю с retry на 429
 */
async function sendToUser(bot, task, user, retryCount = 0) {
  const MAX_RETRIES = 3;
  
  try {
    // Персонализация сообщения с защитой от XSS
    const personalMessage = (task.message || '')
      .replace(/{first_name}/g, escapeHtml(user.first_name || 'дорогой друг'));
    
    const options = {
      parse_mode: 'HTML',
      disable_web_page_preview: task.disable_web_page_preview,
      disable_notification: task.disable_notification
    };
    
    if (task.keyboard?.length > 0) {
      options.reply_markup = { inline_keyboard: task.keyboard };
    }
    
    // Таймаут 15 секунд на отправку
    await pTimeout(
      (async () => {
        if (task.file_id) {
          if (personalMessage) options.caption = personalMessage;
          const method = getTelegramMethod(task.file_mime_type);
          await bot.telegram[method](user.id, task.file_id, options);
        } else if (personalMessage) {
          await bot.telegram.sendMessage(user.id, personalMessage, options);
        }
      })(),
      {
        milliseconds: 15000,
        message: `Превышен таймаут отправки для пользователя ${user.id}`
      }
    );
    
    // Логируем только после успеха
    try {
      if (task.id) await logBroadcastSent(task.id, user.id);
    } catch (logErr) {
      console.error(`[Broadcast] Не удалось записать лог для ${user.id}:`, logErr.message);
    }
    
    return { status: 'ok', userId: user.id };
    
  } catch (e) {
    // Обработка rate limit (429)
    if (e.response?.error_code === 429 && retryCount < MAX_RETRIES) {
      const retryAfter = e.response.parameters?.retry_after || 5;
      console.warn(`[Broadcast] Rate limit для ${user.id}, ожидание ${retryAfter}с (попытка ${retryCount + 1}/${MAX_RETRIES})`);
      
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return sendToUser(bot, task, user, retryCount + 1);
    }
    
    // Пользователь заблокировал бота или удалил чат
    if (e.response?.error_code === 403 || e.response?.description?.includes('chat not found')) {
      try {
        await updateUserField(user.id, { can_receive_broadcasts: false });
      } catch (updateErr) {
        console.error(`[Broadcast] Не удалось обновить флаг для ${user.id}:`, updateErr.message);
      }
    }
    
    // Всегда логируем, чтобы не попасть в бесконечный цикл
    try {
      if (task.id) await logBroadcastSent(task.id, user.id);
    } catch (logErr) {
      console.error(`[Broadcast] Ошибка логирования для ${user.id}:`, logErr.message);
    }
    
    return { 
      status: 'error', 
      userId: user.id, 
      reason: e.message,
      code: e.response?.error_code 
    };
  }
}

/**
 * Обрабатывает одну пачку пользователей с контролем параллелизма
 */
export async function runBroadcastBatch(bot, task, users) {
  let sentCount = 0;
  const totalUsers = users.length;
  
  const results = await pMap(
    users,
    async (user) => {
      const result = await sendToUser(bot, task, user);
      sentCount++;
      
      // Промежуточный отчёт каждые 100 пользователей
      if (task.id && sentCount % 100 === 0) {
        const progress = ((sentCount / totalUsers) * 100).toFixed(1);
        try {
          await bot.telegram.sendMessage(
            ADMIN_ID,
            `⏳ Рассылка #${task.id}: ${sentCount}/${totalUsers} (${progress}%)`,
            { disable_notification: true }
          );
        } catch (reportErr) {
          console.error('[Broadcast] Не удалось отправить промежуточный отчёт:', reportErr.message);
        }
      }
      
      return result;
    },
    { 
      concurrency: 30 // Telegram API limit ~30 req/sec
    }
  );
  
  // Статистика по результатам
  const stats = {
    total: results.length,
    success: results.filter(r => r.status === 'ok').length,
    errors: results.filter(r => r.status === 'error').length
  };
  
  console.log(`[Broadcast] Пачка завершена:`, stats);
  return results;
}

/**
 * Отправляет финальный отчёт администратору
 */
export async function sendAdminReport(bot, taskId, task) {
  try {
    const { total, sent } = await getBroadcastProgress(taskId, task.target_audience);
    const audienceName = (task.target_audience || 'unknown').replace(/_/g, ' ');
    
    const reportMessage = 
      `📢 <b>Рассылка #${taskId} завершена!</b>\n\n` +
      `✅ Отправлено: <b>${sent}</b> из <b>${total}</b>\n` +
      `👥 Аудитория: <b>${audienceName}</b>\n` +
      `📊 Успешность: <b>${((sent / total) * 100).toFixed(1)}%</b>`;
    
    await bot.telegram.sendMessage(ADMIN_ID, reportMessage, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('[Broadcast] Не удалось отправить финальный отчёт админу:', e.message);
  }
}