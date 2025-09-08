// services/workerManager.js
import cron from 'node-cron';
import { ADMIN_ID } from '../config.js';
import { bot } from '../bot.js';
import {
    pool, getAllUsers, getActiveFreeUsers, getActivePremiumUsers,
    getAndStartPendingBroadcastTask, completeBroadcastTask, failBroadcastTask,
    findAndInterruptActiveBroadcast
} from '../db.js';
import redisService from './redisClient.js';
import { downloadQueue } from './downloadManager.js';
import { isShuttingDown, setShuttingDown, isBroadcasting, setBroadcasting } from './appState.js';
import { runSingleBroadcast } from './broadcastManager.js';

function setupGracefulShutdown(server) {
    const SHUTDOWN_TIMEOUT = 25000;
    const gracefulShutdown = async (signal) => {
        if (isShuttingDown) return;
        setShuttingDown();
        console.log(`[Shutdown] Получен сигнал ${signal}. Начинаю изящное завершение...`);
        server.close(() => console.log('[Shutdown] HTTP сервер закрыт.'));
        if (isBroadcasting) {
            await findAndInterruptActiveBroadcast();
        }
        if (downloadQueue.pending > 0) {
            console.log(`[Shutdown] Ожидаю завершения скачивания (макс. ${SHUTDOWN_TIMEOUT / 1000}с)...`);
            const timeoutPromise = new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT));
            await Promise.race([downloadQueue.onIdle(), timeoutPromise]);
        }
        console.log('[Shutdown] Закрываю соединения...');
        await Promise.allSettled([pool.end(), redisService.disconnect()]);
        console.log('[Shutdown] Завершение работы.');
        process.exit(0);
    };
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
}

function startBroadcastWorker() {
    console.log('[Broadcast Worker] Планировщик запущен.');
    cron.schedule('* * * * *', async () => {
        // Не начинаем новую рассылку, если предыдущая еще не завершилась
        if (isBroadcasting) {
            console.log('[Broadcast Worker] Предыдущая итерация рассылки еще активна. Пропуск.');
            return;
        }
        const task = await getAndStartPendingBroadcastTask();
        if (task) {
            console.log(`[Broadcast] Начинаю рассылку #${task.id}. Приостанавливаю очередь скачивания.`);
            downloadQueue.pause();
            setBroadcasting(true);
            try {
                let users = [];
                if (task.target_audience === 'all') users = await getAllUsers(true);
                else if (task.target_audience === 'free_users') users = await getActiveFreeUsers();
                else if (task.target_audience === 'premium_users') users = await getActivePremiumUsers();
                else if (task.target_audience === 'preview') users = [{ id: ADMIN_ID, first_name: 'Admin' }];
                const report = await runSingleBroadcast(bot, task, users, task.id);
                await completeBroadcastTask(task.id, report);
            } catch (error) {
                console.error(`[Broadcast Worker] Критическая ошибка при выполнении задачи #${task.id}:`, error);
                await failBroadcastTask(task.id, error.message);
            } finally {
                setBroadcasting(false);
                downloadQueue.start();
                console.log(`[Broadcast] Рассылка #${task.id} завершена. Возобновляю очередь скачивания.`);
            }
        }
    });
}

export function initializeWorkers(server) {
    startBroadcastWorker();
    setupGracefulShutdown(server);
}