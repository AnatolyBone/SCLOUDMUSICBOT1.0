// services/workerManager.js (ФИНАЛЬНАЯ ВЕРСИЯ БЕЗ ЦИКЛИЧЕСКИХ ЗАВИСИМОСТЕЙ)

import cron from 'node-cron';
// import { bot } from '../bot.js'; // <-- УДАЛЕНО
import { pool, getAndStartPendingBroadcastTask, updateBroadcastStatus, getUsersForBroadcastBatch, findAndInterruptActiveBroadcast } from '../db.js';
import redisService from './redisClient.js';
import { downloadQueue } from './downloadManager.js';
import { isShuttingDown, setShuttingDown, isBroadcasting, setBroadcasting } from './appState.js';
import { runBroadcastBatch, sendAdminReport } from './broadcastManager.js';

let botInstance; // <-- Создаем локальную переменную

function setupGracefulShutdown(server) {
    // ... ваш код setupGracefulShutdown остается без изменений ...
    const SHUTDOWN_TIMEOUT = 25000;
    const gracefulShutdown = async (signal) => {
        if (isShuttingDown()) return;
        setShuttingDown(true);
        console.log(`[Shutdown] Получен сигнал ${signal}. Начинаю изящное завершение...`);
        server.close(() => console.log('[Shutdown] HTTP сервер закрыт.'));
        if (isBroadcasting()) {
            await findAndInterruptActiveBroadcast();
        }
        if (downloadQueue.size > 0 || downloadQueue.pending > 0) {
            console.log(`[Shutdown] Ожидаю завершения скачиваний (макс. ${SHUTDOWN_TIMEOUT / 1000}с)...`);
            await Promise.race([
                downloadQueue.onIdle(),
                new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT))
            ]);
        }
        console.log('[Shutdown] Закрываю соединения с БД и Redis...');
        await Promise.allSettled([pool.end(), redisService.disconnect()]);
        console.log('[Shutdown] Завершение работы.');
        process.exit(0);
    };
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

function startBroadcastWorker() {
    console.log('[Broadcast Worker] Планировщик запущен.');
    const BATCH_SIZE = 100;
    const BATCH_DELAY = 1000;

    cron.schedule('* * * * *', async () => {
        if (isBroadcasting() || isShuttingDown()) return;
        const task = await getAndStartPendingBroadcastTask();
        if (!task) return;
        
        console.log(`[Broadcast] Начинаю рассылку #${task.id}. Приостанавливаю очередь скачивания.`);
        setBroadcasting(true);
        downloadQueue.pause();

        try {
            let isDone = false;
            while (!isDone && !isShuttingDown()) {
                const users = await getUsersForBroadcastBatch(task.id, task.target_audience, BATCH_SIZE);
                if (users.length === 0) {
                    isDone = true;
                    console.log(`[Broadcast] Все пользователи для рассылки #${task.id} обработаны.`);
                    continue;
                }
                
                console.log(`[Broadcast] Отправляю пачку из ${users.length} пользователей для задачи #${task.id}`);
                // ИСПОЛЬЗУЕМ botInstance ВМЕСТО bot
                await runBroadcastBatch(botInstance, task, users);

                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
            }

            if (isShuttingDown()) {
                console.log(`[Broadcast] Рассылка #${task.id} прервана из-за завершения работы.`);
            } else {
                console.log(`[Broadcast] Рассылка #${task.id} успешно завершена.`);
                await updateBroadcastStatus(task.id, 'completed');
                // ИСПОЛЬЗУЕМ botInstance ВМЕСТО bot
                await sendAdminReport(botInstance, task.id, task);
            }
        } catch (error) {
            console.error(`[Broadcast Worker] Критическая ошибка при выполнении задачи #${task.id}:`, error);
            await updateBroadcastStatus(task.id, 'failed', error.message);
        } finally {
            setBroadcasting(false);
            downloadQueue.start();
            console.log(`[Broadcast] Очередь скачивания возобновлена.`);
        }
    });
}

// ИЗМЕНЯЕМ initializeWorkers, ЧТОБЫ ОНА ПРИНИМАЛА bot
export function initializeWorkers(server, bot) {
    botInstance = bot; // <-- Сохраняем bot в локальную переменную
    startBroadcastWorker();
    setupGracefulShutdown(server);
}