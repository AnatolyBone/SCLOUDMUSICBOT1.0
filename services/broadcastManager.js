// services/broadcastManager.js
import { ADMIN_ID } from '../config.js';
import { logBroadcastSent, updateUserField, getBroadcastProgress } from '../db.js';

// Новая функция для обработки ОДНОЙ пачки
// services/broadcastManager.js
export async function runBroadcastBatch(bot, task, users) {
    const sendPromises = users.map(async (user) => {
        try {
            const personalMessage = (task.message || '').replace(/{first_name}/g, user.first_name || 'дорогой друг');
            const options = { parse_mode: 'HTML', disable_web_page_preview: task.disable_web_page_preview, disable_notification: task.disable_notification };
            if (task.keyboard?.length > 0) options.reply_markup = { inline_keyboard: task.keyboard };
            
            const fileId = task.file_id;
            if (fileId) {
                if (personalMessage) options.caption = personalMessage;
                const mimeType = task.file_mime_type || '';
                if (mimeType.startsWith('image/')) await bot.telegram.sendPhoto(user.id, fileId, options);
                else if (mimeType.startsWith('video/')) await bot.telegram.sendVideo(user.id, fileId, options);
                else if (mimeType.startsWith('audio/')) await bot.telegram.sendAudio(user.id, fileId, options);
                else await bot.telegram.sendDocument(user.id, fileId, options);
            } else if (personalMessage) {
                await bot.telegram.sendMessage(user.id, personalMessage, options);
            }
            
            // =====> ВОТ ИСПРАВЛЕНИЕ <=====
            // Записываем в лог, ТОЛЬКО если это настоящая рассылка с номером (ID).
            if (task.id) {
                await logBroadcastSent(task.id, user.id);
            }
            // =============================
            
            return { status: 'ok', userId: user.id };
        } catch (e) {
            if (e.response?.error_code === 403) {
                await updateUserField(user.id, 'active', false);
            }
            return { status: 'error', userId: user.id, reason: e.message };
        }
    });
    
    await Promise.allSettled(sendPromises);
}

// Новая функция для отправки финального отчета
export async function sendAdminReport(bot, taskId, task) {
    try {
        const { total, sent } = await getBroadcastProgress(taskId, task.target_audience);
        const audienceName = (task.target_audience || 'unknown').replace(/_/g, ' ');
        const reportMessage = `📢 <b>Рассылка #${taskId} завершена!</b>\n\n✅ Отправлено: <b>${sent}</b> из <b>${total}</b>\n👥 Аудитория: <b>${audienceName}</b>`;
        await bot.telegram.sendMessage(ADMIN_ID, reportMessage, { parse_mode: 'HTML' });
    } catch (e) {
        console.error('Не удалось отправить финальный отчет админу:', e.message);
    }
}