// services/broadcastManager.js
import { ADMIN_ID } from '../config.js';
import { getAlreadySentUserIds, logBroadcastSent, updateUserField } from '../db.js';

export async function runSingleBroadcast(bot, task, users, taskId = null) {
    const isPreview = !taskId;
    const alreadySentIds = isPreview ? new Set() : await getAlreadySentUserIds(taskId);
    const usersToSend = users.filter(user => !alreadySentIds.has(user.id));

    if (usersToSend.length === 0 && users.length > 0 && !isPreview) {
        console.log(`[Broadcast] Нет новых пользователей для отправки в задаче #${taskId}.`);
        return { successCount: users.length, errorCount: 0, totalUsers: users.length };
    }
    console.log(`[Broadcast] Запуск для ${usersToSend.length} новых пользователей (всего в аудитории ${users.length}).`);
    let successCount = 0, errorCount = 0;
    for (const user of usersToSend) {
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
            } else if (personalMessage) await bot.telegram.sendMessage(user.id, personalMessage, options);

            if (!isPreview) await logBroadcastSent(taskId, user.id);
            successCount++;
        } catch (e) {
            errorCount++;
            if (e.response?.error_code === 403) await updateUserField(user.id, 'active', false);
        }
        await new Promise(resolve => setTimeout(resolve, 40)); // ~25 msg/sec
    }
    
    const totalSuccess = successCount + alreadySentIds.size;
    const report = { successCount: totalSuccess, errorCount, totalUsers: users.length };
    
    if (isPreview) {
        console.log(`[Broadcast] Предпросмотр завершен.`, { successCount, errorCount });
    } else {
        console.log(`[Broadcast] Рассылка #${taskId} завершена.`, report);
        if (users.length > 1 || (users.length === 1 && users[0].id !== ADMIN_ID)) {
           try {
                const audienceName = (task.target_audience || 'unknown').replace('_', ' ');
                const reportMessage = `📢 <b>Отчет по рассылке #${taskId}</b>\n\n✅ Успешно: <b>${totalSuccess}</b>\n❌ Ошибки: <b>${errorCount}</b>\n👥 Аудитория: <b>${audienceName}</b> (${users.length} чел.)`;
                await bot.telegram.sendMessage(ADMIN_ID, reportMessage, { parse_mode: 'HTML' });
            } catch (e) { console.error('Не удалось отправить отчет админу:', e.message); }
        }
    }
    return report;
}