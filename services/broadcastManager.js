// services/broadcastManager.js

import { ADMIN_ID } from '../config.js';
import { 
    getAlreadySentUserIds, 
    logBroadcastSent, 
    updateUserField 
} from '../db.js';
import { isDownloadQueueActive } from './downloadManager.js';

/**
 * Выполняет отправку одной задачи рассылки с динамической скоростью.
 * @param {Telegraf} bot - Экземпляр Telegraf для отправки сообщений.
 * @param {object} task - Объект задачи из БД.
 * @param {Array<object>} users - Массив пользователей для рассылки.
 * @param {number|null} taskId - ID задачи.
 * @returns {Promise<object>} - Отчет о выполнении.
 */
export async function runSingleBroadcast(bot, task, users, taskId = null) {
    const isPreview = !taskId;

    if (isPreview) {
        console.log(`[Broadcast Worker] Запуск предпросмотра рассылки.`);
    } else {
        console.log(`[Broadcast Worker] Запуск рассылки #${taskId} для ${users.length} пользователей.`);
    }

    const alreadySentIds = isPreview ? new Set() : await getAlreadySentUserIds(taskId);
    if (alreadySentIds.size > 0) {
        console.log(`[Broadcast Worker] Найдено ${alreadySentIds.size} пользователей, которые уже получили это сообщение. Они будут пропущены.`);
    }

    const usersToSend = users.filter(user => !alreadySentIds.has(user.id));
    
    if (usersToSend.length === 0 && users.length > 0 && !isPreview) {
        console.log(`[Broadcast Worker] Нет новых пользователей для отправки в задаче #${taskId}. Рассылка считается завершенной.`);
        return { successCount: users.length, errorCount: 0, totalUsers: users.length };
    }
    
    if (!isPreview) {
        console.log(`[Broadcast Worker] К отправке запланировано ${usersToSend.length} новых сообщений.`);
    }

    let successCount = 0;
    let errorCount = 0;
    let counter = 0;
    const reportInterval = 50;

    for (const user of usersToSend) {
        // Определяем задержку ПЕРЕД отправкой
        const isBusy = isDownloadQueueActive();
        const delayMs = isBusy ? 500 : 35; // 500мс если занят, 35мс если свободен
        await new Promise(resolve => setTimeout(resolve, delayMs));

        try {
            const personalMessage = (task.message || '').replace(/{first_name}/g, user.first_name || 'дорогой друг');
            const options = {
                parse_mode: 'HTML',
                disable_web_page_preview: task.disable_web_page_preview,
                disable_notification: task.disable_notification
            };
            if (task.keyboard && task.keyboard.length > 0) {
                options.reply_markup = { inline_keyboard: task.keyboard };
            }
            
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
            
            if (!isPreview) {
                await logBroadcastSent(taskId, user.id);
            }
            successCount++;
        } catch (e) {
            errorCount++;
            if (e.response?.error_code === 403) await updateUserField(user.id, 'active', false);
        }
        
        counter++;
        if (!isPreview && counter % reportInterval === 0) {
            console.log(`[Broadcast Worker] Прогресс рассылки #${taskId}: отправлено ${counter} из ${usersToSend.length}...`);
        }
    }
    
    const totalSuccess = successCount + alreadySentIds.size;
    const report = { successCount: totalSuccess, errorCount, totalUsers: users.length };
    
    if (isPreview) {
        console.log(`[Broadcast Worker] Предпросмотр завершен.`, { successCount, errorCount });
    } else {
        console.log(`[Broadcast Worker] Рассылка #${taskId} завершена.`, report);
        if (users.length > 1 || (users.length === 1 && users[0].id !== ADMIN_ID)) {
            try {
                const audienceName = (task.target_audience || 'unknown').replace('_', ' ');
                const reportMessage = `📢 <b>Отчет по рассылке #${taskId}</b>\n\n` +
                                    `✅ Успешно: <b>${totalSuccess}</b>\n` +
                                    `❌ Ошибки: <b>${errorCount}</b>\n` +
                                    `👥 Аудитория: <b>${audienceName}</b> (${users.length} чел.)`;
                
                await bot.telegram.sendMessage(ADMIN_ID, reportMessage, { parse_mode: 'HTML' });
            } catch (e) { console.error('Не удалось отправить отчет админу:', e.message); }
        }
    }

    return report;
}