// services/workerManager.js (ИСПРАВЛЕННАЯ ВЕРСИЯ)

import cron from 'node-cron';
import { pool, getAndStartPendingBroadcastTask, updateBroadcastStatus, getUsersForBroadcastBatch, findAndInterruptActiveBroadcast } from '../db.js';
import { checkAndSendExpirationNotifications } from './notifier.js';
import redisService from './redisClient.js';
import { downloadQueue } from './downloadManager.js';
import { isShuttingDown, setShuttingDown, isBroadcasting, setBroadcasting } from './appState.js';
import { runBroadcastBatch, sendAdminReport } from './broadcastManager.js';

let botInstance;

function setupGracefulShutdown(server) {
    const SHUTDOWN_TIMEOUT = 25000;
    
    const gracefulShutdown = async (signal) => {
        // =====> ИСПРАВЛЕНИЕ №1 <=====
        if (isShuttingDown) return;
        setShuttingDown(true);
        
        console.log(`[Shutdown] Получен сигнал ${signal}. Начинаю изящное завершение...`);
        server.close(() => console.log('[Shutdown] HTTP сервер закрыт.'));
        
        // =====> ИСПРАВЛЕНИЕ №2 <=====
        if (isBroadcasting) {
            console.log('[Shutdown] Обнаружена активная рассылка. Помечаю ее как прерванную...');
            await findAndInterruptActiveBroadcast();
        }
        
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
function startNotifierWorker() {
  console.log('[Notifier] Планировщик запущен (tick=60s).');
  let running = false;

  cron.schedule('* * * * *', async () => {
    if (running || isShuttingDown) return;
    running = true;
    try {
      await checkAndSendExpirationNotifications(botInstance);
    } catch (e) {
      console.error('[Notifier] tick error:', e.message);
    } finally {
      running = false;
    }
  });
}
// ЗАМЕНИ СТАРУЮ ФУНКЦИЮ startBroadcastWorker НА ЭТУ В workerManager.js

function startBroadcastWorker() {
    console.log('[Broadcast Worker] Планировщик запущен.');
    const BATCH_SIZE = 100;
    const BATCH_DELAY = 1000;
    
    cron.schedule('* * * * *', async () => {
        if (isBroadcasting || isShuttingDown) return;
        
        let task; // Объявляем переменную task здесь
        
        try {
            task = await getAndStartPendingBroadcastTask();
            if (!task) return;
            
            console.log(`[Broadcast] Начинаю рассылку #${task.id}. Приостанавливаю очередь скачивания.`);
            setBroadcasting(true);
            downloadQueue.pause();
            
            let isDone = false;
            while (!isDone && !isShuttingDown) {
                const users = await getUsersForBroadcastBatch(task.id, task.target_audience, BATCH_SIZE);
                if (users.length === 0) {
                    isDone = true;
                    continue;
                }
                
                await runBroadcastBatch(botInstance, task, users);
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
            }
            
            if (!isShuttingDown) {
                await updateBroadcastStatus(task.id, 'completed');
                await sendAdminReport(botInstance, task.id, task);
            }
        } catch (error) {
            console.error(`[Broadcast Worker] Критическая ошибка при выполнении задачи #${task ? task.id : 'UNKNOWN'}:`, error);
            if (task) {
                await updateBroadcastStatus(task.id, 'failed', error.message);
            }
        } finally {
            // Этот блок теперь выполнится, даже если бот упадет в try
            if (isBroadcasting) {
                setBroadcasting(false);
                downloadQueue.start();
                console.log(`[Broadcast] Очередь скачивания возобновлена после завершения/ошибки.`);
            }
        }
    });
}

export function initializeWorkers(server, bot) {
    botInstance = bot;
    startBroadcastWorker();
    startNotifierWorker(); // ← ДОБАВЬ ЭТО
    setupGracefulShutdown(server);
}