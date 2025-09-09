// services/workerManager.js

import cron from 'node-cron';
import { ADMIN_ID } from '../config.js';
import { bot } from '../bot.js';
import {
    pool,
    supabase,
    getAllUsers,
    getActiveFreeUsers,
    getActivePremiumUsers,
    getAndStartPendingBroadcastTask,
    completeBroadcastTask,
    failBroadcastTask,
    findAndInterruptActiveBroadcast
} from '../db.js';
import redisService from './redisClient.js';
import { downloadQueue, isDownloadQueueActive } from './downloadManager.js';
import { isShuttingDown, setShuttingDown, isBroadcasting, setBroadcasting } from './appState.js';
import { runSingleBroadcast } from './broadcastManager.js';
import { checkAndSendExpirationNotifications } from './notifier.js';

/**
 * Настраивает механизм изящного завершения работы приложения.
 */
function setupGracefulShutdown(server) {
    const SHUTDOWN_TIMEOUT = 25000;

    const gracefulShutdown = async (signal) => {
        if (isShuttingDown) {
            console.log('[Shutdown] Процесс завершения уже запущен, повторный вызов проигнорирован.');
            return;
        }
        setShuttingDown();
        console.log(`[Shutdown] Получен сигнал ${signal}. Начинаю изящное завершение...`);

        server.close(() => console.log('[Shutdown] HTTP сервер закрыт.'));
        
        if (isBroadcasting) {
            console.log('[Shutdown] Обнаружена активная рассылка. Помечаю ее как прерванную...');
            await findAndInterruptActiveBroadcast();
        }
        
        if (downloadQueue.pending > 0) {
            console.log(`[Shutdown] Ожидаю завершения скачиваний (макс. ${SHUTDOWN_TIMEOUT / 1000}с)...`);
            const timeoutPromise = new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT));
            await Promise.race([downloadQueue.onIdle(), timeoutPromise]);
        }
        
        console.log('[Shutdown] Закрываю соединения с БД и Redis...');
        await Promise.allSettled([pool.end(), redisService.disconnect()]);
        
        console.log('[Shutdown] Завершение работы.');
        process.exit(0);
    };

    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
}

/**
 * Запускает cron-задачу для обработки очереди рассылок.
 */
function startBroadcastWorker() {
    console.log('[Broadcast Worker] Планировщик запущен.');
    
    cron.schedule('* * * * *', async () => {
        if (isBroadcasting) {
            return; // Предыдущая итерация еще не завершилась
        }
        if (isDownloadQueueActive()) {
            // Уступаем дорогу пользовательским задачам
            return;
        }

        const task = await getAndStartPendingBroadcastTask();
        if (task) {
            setBroadcasting(true);
            try {
                let users = [];
                if (task.target_audience === 'all') users = await getAllUsers(true);
                else if (task.target_audience === 'free_users') users = await getActiveFreeUsers();
                else if (task.target_audience === 'premium_users') users = await getActivePremiumUsers();
                else if (task.target_audience === 'preview') users = [{ id: ADMIN_ID, first_name: 'Admin' }];
                
                const { completed, report } = await runSingleBroadcast(bot, task, users, task.id);
                
                if (completed) {
                    await completeBroadcastTask(task.id, report);
                } else {
                    const { error } = await supabase.from('broadcast_tasks').update({ status: 'pending', started_at: null }).eq('id', task.id);
                    if (error) console.error(`[Broadcast Worker] Не удалось вернуть задачу #${task.id} в очередь:`, error);
                    else console.log(`[Broadcast Worker] Спринт #${task.id} прерван, задача вернется в очередь.`);
                }
            } catch (error) {
                console.error(`[Broadcast Worker] Критическая ошибка при выполнении задачи #${task.id}:`, error);
                await failBroadcastTask(task.id, error.message);
            } finally {
                setBroadcasting(false);
            }
        }
    });
}

/**
 * Запускает cron-задачу для отправки уведомлений об истечении подписки.
 */
function startNotifierWorker() {
    console.log('[Notifier] Планировщик уведомлений об истечении подписки запущен.');
    // Запускаем каждый час, в начале часа (например, в 10:00, 11:00 и т.д.)
    cron.schedule('0 * * * *', () => {
        console.log('[Notifier] Cron: Проверка на необходимость отправки уведомлений...');
        checkAndSendExpirationNotifications(bot);
    });
}

/**
 * Главная функция для инициализации ВСЕХ фоновых воркеров и обработчиков.
 */
export function initializeWorkers(server) {
    startBroadcastWorker();
    startNotifierWorker();
    setupGracefulShutdown(server);
}