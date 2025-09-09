// services/workerManager.js (ФИНАЛЬНАЯ ВЕРСИЯ НА ОСНОВЕ ВАШЕГО РЕЗЕРВНОГО КОДА)

import cron from 'node-cron';
// import { bot } from '../bot.js'; // <-- ГЛАВНОЕ: УДАЛЕН ИМПОРТ, РАЗРЫВАЕМ ЦИКЛ
import { pool, getAndStartPendingBroadcastTask, updateBroadcastStatus, getUsersForBroadcastBatch, findAndInterruptActiveBroadcast } from '../db.js';
import redisService from './redisClient.js';
import { downloadQueue } from './downloadManager.js';
import { isShuttingDown, setShuttingDown, isBroadcasting, setBroadcasting } from './appState.js';
// Используем новую, быструю систему рассылок
import { runBroadcastBatch, sendAdminReport } from './broadcastManager.js'; 

let botInstance; // Локальная переменная для хранения bot

function setupGracefulShutdown(server) {
    const SHUTDOWN_TIMEOUT = 25000;

    const gracefulShutdown = async (signal) => {
        // ПРАВИЛЬНЫЙ ВЫЗОВ С ()
        if (isShuttingDown()) return; 
        setShuttingDown(true);

        console.log(`[Shutdown] Получен сигнал ${signal}. Начинаю изящное завершение...`);
        server.close(() => console.log('[Shutdown] HTTP сервер закрыт.'));

        // ПРАВИЛЬНЫЙ ВЫЗОВ С ()
        if (isBroadcasting()) { 
            console.log('[Shutdown] Обнаружена активная рассылка. Помечаю ее как прерванную...');
            await findAndInterruptActiveBroadcast();
        }
        
        // Используем .pending для p-queue
        if (downloadQueue.pending > 0 || downloadQueue.size > 0) {
            console.log(`[Shutdown] Ожидаю завершения задач в очереди (макс. ${SHUTDOWN_TIMEOUT / 1000}с)...`);
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
        // ПРАВИЛЬНЫЙ ВЫЗОВ С ()
        if (isBroadcasting() || isShuttingDown()) return;

        const task = await getAndStartPendingBroadcastTask();
        if (!task) return;
        
        console.log(`[Broadcast] Начинаю рассылку #${task.id}. Приостанавливаю очередь скачивания.`);
        setBroadcasting(true);
        downloadQueue.pause();

        try {
            let isDone = false;
            // ПРАВИЛЬНЫЙ ВЫЗОВ С ()
            while (!isDone && !isShuttingDown()) {
                const users = await getUsersForBroadcastBatch(task.id, task.target_audience, BATCH_SIZE);
                if (users.length === 0) {
                    isDone = true;
                    continue;
                }
                
                await runBroadcastBatch(botInstance, task, users); // Используем botInstance
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
            }

            if (!isShuttingDown()) {
                await updateBroadcastStatus(task.id, 'completed');
                await sendAdminReport(botInstance, task.id, task); // Используем botInstance
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

export function initializeWorkers(server, bot) {
    botInstance = bot; // Сохраняем переданный bot
    startBroadcastWorker();
    setupGracefulShutdown(server);
}