// services/broadcastManager.js

import { ADMIN_ID } from '../config.js';
import { getAlreadySentUserIds, logBroadcastSent, updateUserField } from '../db.js';
import { isDownloadQueueActive } from './downloadManager.js';
import { isShuttingDown } from './appState.js';

/**
 * Выполняет один "спринт" рассылки, работая порциями и с лимитом по времени.
 * @returns {Promise<{completed: boolean, report: object}>} - Отчет о выполнении и флаг, завершена ли рассылка полностью.
 */
export async function runSingleBroadcast(bot, task, users, taskId = null) {
    const TIME_LIMIT_MS = 50000; // Работать не дольше 50 секунд за один запуск
    const isPreview = !taskId;
    const startTime = Date.now();

    const alreadySentIds = isPreview ? new Set() : await getAlreadySentUserIds(taskId);
    const usersToSend = users.filter(user => !alreadySentIds.has(user.id));

    if (usersToSend.length === 0 && users.length > 0 && !isPreview) {
        return { completed: true, report: { successCount: users.length, errorCount: 0, totalUsers: users.length } };
    }
    
    console.log(`[Broadcast Worker] Спринт для #${taskId}. К отправке: ${usersToSend.length} из ${users.length}.`);

    let successCount = 0;
    let errorCount = 0;

    for (const user of usersToSend) {
        // Проверка №1: Сигнал на общее завершение работы
        if (isShuttingDown) {
            console.log(`[Broadcast Worker] Получен сигнал shutdown. Прерываю рассылку #${taskId}.`);
            break;
        }
        // Проверка №2: Уступаем дорогу пользовательским задачам
        if (!isPreview && isDownloadQueueActive()) {
            console.log(`[Broadcast Worker] Очередь скачивания стала активной. Рассылка #${taskId} приостановлена.`);
            break;
        }
        // Проверка №3: Защита от слишком долгой работы
        if (Date.now() - startTime > TIME_LIMIT_MS) {
            console.log(`[Broadcast Worker] Достигнут лимит времени. Рассылка #${taskId} будет продолжена позже.`);
            break;
        }

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
            
            if (!isPreview) await logBroadcastSent(taskId, user.id);
            successCount++;
        } catch (e) {
            errorCount++;
            if (e.response?.error_code === 403) await updateUserField(user.id, 'active', false);
        }
        
        await new Promise(resolve => setTimeout(resolve, 40)); // Базовая задержка ~25 msg/sec
    }
    
    const totalSuccess = successCount + alreadySentIds.size;
    const report = { successCount: totalSuccess, errorCount, totalUsers: users.length };
    const completed = totalSuccess >= users.length; // Считаем завершенной, если все получили

    if (isPreview) {
        console.log(`[Broadcast Worker] Предпросмотр завершен.`, { successCount, errorCount });
    } else {
        console.log(`[Broadcast Worker] Спринт #${taskId} завершен. Отправлено в этой сессии: ${successCount}. Общий прогресс: ${totalSuccess}/${users.length}`);
    }
    
    if (completed && !isPreview) {
        if (users.length > 1 || (users.length === 1 && users[0].id !== ADMIN_ID)) {
           try {
                const audienceName = (task.target_audience || 'unknown').replace('_', ' ');
                const reportMessage = `📢 <b>Отчет по рассылке #${taskId}</b> (ЗАВЕРШЕНА)\n\n✅ Успешно: <b>${totalSuccess}</b>\n❌ Ошибки: <b>${errorCount}</b>\n👥 Аудитория: <b>${audienceName}</b> (${users.length} чел.)`;
                await bot.telegram.sendMessage(ADMIN_ID, reportMessage, { parse_mode: 'HTML' });
            } catch (e) { console.error('Не удалось отправить отчет админу:', e.message); }
        }
    }

    return { completed, report };
}