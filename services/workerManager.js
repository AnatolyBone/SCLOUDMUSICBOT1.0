// services/workerManager.js

import cron from 'node-cron';
import {
  pool,
  getAndStartPendingBroadcastTask,
  updateBroadcastStatus,
  getUsersForBroadcastBatch,
  findAndInterruptActiveBroadcast,
  resetExpiredPremiumsBulk
} from '../db.js';
import {
  checkAndSendExpirationNotifications,
  notifyExpiringTodayHourly
} from './notifier.js';
import redisService from './redisClient.js';
import { downloadQueue } from './downloadManager.js';
import { isShuttingDown, setShuttingDown, isBroadcasting, setBroadcasting } from './appState.js';
import { runBroadcastBatch, sendAdminReport } from './broadcastManager.js';

let botInstance;

// Аккуратное завершение сервиса
function setupGracefulShutdown(server) {
  const SHUTDOWN_TIMEOUT = 25000;

  const gracefulShutdown = async (signal) => {
    // Защита от повторных входов
    if (isShuttingDown) return;
    setShuttingDown(true);

    console.log(`[Shutdown] Получен сигнал ${signal}. Начинаю изящное завершение...`);
    server.close(() => console.log('[Shutdown] HTTP сервер закрыт.'));

    // Если идёт рассылка — пометим прерванной
    if (isBroadcasting) {
      console.log('[Shutdown] Обнаружена активная рассылка. Помечаю ее как прерванную...');
      await findAndInterruptActiveBroadcast();
    }

    // Ждём задачи очереди (или таймаут)
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

// Нотифаер: дневной + почасовой
function startNotifierWorker() {
  console.log('[Notifier] Планировщик запущен (daily + hourly).');

  let runningDaily = false;
  let runningHourly = false;

  // Дневной: проверяем каждую минуту; реально шлёт 1 раз после 10:00 UTC (внутренний гейт)
  cron.schedule('* * * * *', async () => {
    if (runningDaily || isShuttingDown) return;
    runningDaily = true;
    try {
      await checkAndSendExpirationNotifications(botInstance);
    } catch (e) {
      console.error('[Notifier] daily tick error:', e.message);
    } finally {
      runningDaily = false;
    }
  });

  // Почасовой: в начале каждого часа страхуем "сегодня" (0д)
  cron.schedule('0 * * * *', async () => {
    if (runningHourly || isShuttingDown) return;
    runningHourly = true;
    try {
      await notifyExpiringTodayHourly(botInstance);
    } catch (e) {
      console.error('[Notifier] hourly tick error:', e.message);
    } finally {
      runningHourly = false;
    }
  });
}

// Ночной автосброс истёкших подписок до Free
function startPremiumAutoResetWorker() {
  console.log('[Premium/BulkReset] Планировщик запущен (ежедневно 00:10 UTC).');
  cron.schedule(
    '10 0 * * *',
    async () => {
      if (isShuttingDown) return;
      try {
        const n = await resetExpiredPremiumsBulk();
        if (n) console.log(`[Premium/BulkReset] Автосброс истёкших: ${n} пользователей.`);
      } catch (e) {
        console.error('[Premium/BulkReset] cron error:', e.message);
      }
    },
    { timezone: 'UTC' }
  );
}

// Планировщик рассылок
function startBroadcastWorker() {
  console.log('[Broadcast Worker] Планировщик запущен.');
  const BATCH_SIZE = 100;
  const BATCH_DELAY = 1000;

  cron.schedule('* * * * *', async () => {
    if (isBroadcasting || isShuttingDown) return;

    let task;

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
  startNotifierWorker();
  startPremiumAutoResetWorker();
  setupGracefulShutdown(server);
}