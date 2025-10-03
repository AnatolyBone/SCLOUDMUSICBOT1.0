// services/workerManager.js (улучшенная версия)

import cron from 'node-cron';
import { Mutex } from 'async-mutex';
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
import { 
  isShuttingDown, 
  setShuttingDown, 
  isBroadcasting, 
  setBroadcasting 
} from './appState.js';
import { runBroadcastBatch, sendAdminReport } from './broadcastManager.js';

// ========================= CONFIGURATION =========================

const SHUTDOWN_TIMEOUT = 25000; // 25 секунд
const BROADCAST_BATCH_SIZE = 100;
const BROADCAST_BATCH_DELAY = 1000; // 1 секунда между батчами
const BROADCAST_MAX_DURATION = 30 * 60 * 1000; // 30 минут

let botInstance;
const shutdownMutex = new Mutex();

// ========================= HELPER FUNCTIONS =========================

/**
 * Создаёт cron задачу с защитой от одновременного запуска
 */
function createCronTask(schedule, taskName, taskFn, options = {}) {
  let isRunning = false;
  
  // Watchdog для застрявших задач (по умолчанию 5 минут)
  const watchdogInterval = options.watchdogMs || 5 * 60 * 1000;
  
  setInterval(() => {
    if (isRunning) {
      console.warn(`[${taskName}] Задача застряла более ${watchdogInterval / 1000}с, принудительно сбрасываю флаг`);
      isRunning = false;
    }
  }, watchdogInterval);
  
  cron.schedule(schedule, async () => {
    // Проверка: уже запущена или идёт shutdown
    if (isRunning || isShuttingDown()) return;
    
    isRunning = true;
    console.log(`[${taskName}] Запуск задачи...`);
    
    try {
      await taskFn();
    } catch (e) {
      console.error(`[${taskName}] Ошибка выполнения:`, e.message);
    } finally {
      isRunning = false;
    }
  }, options.cronOptions);
  
  console.log(`[${taskName}] Планировщик запущен (${schedule})`);
}

// ========================= WORKERS =========================

/**
 * Нотификатор истечения подписок
 */
function startNotifierWorker() {
  // Дневной: каждую минуту (внутри функции свой гейт на 10:00 UTC)
  createCronTask(
    '* * * * *',
    'Notifier/Daily',
    async () => {
      await checkAndSendExpirationNotifications(botInstance);
    }
  );
  
  // Почасовой: в начале каждого часа
  createCronTask(
    '0 * * * *',
    'Notifier/Hourly',
    async () => {
      await notifyExpiringTodayHourly(botInstance);
    }
  );
}

/**
 * Автоматический сброс истёкших подписок до Free
 */
function startPremiumAutoResetWorker() {
  createCronTask(
    '10 0 * * *',
    'Premium/BulkReset',
    async () => {
      const count = await resetExpiredPremiumsBulk();
      if (count > 0) {
        console.log(`[Premium/BulkReset] Сброшено ${count} пользователей на тариф Free`);
      }
    },
    { cronOptions: { timezone: 'UTC' } }
  );
}

/**
 * Воркер массовых рассылок
 */
function startBroadcastWorker() {
  createCronTask(
    '* * * * *',
    'Broadcast',
    async () => {
      // Если уже идёт рассылка — пропускаем
      if (isBroadcasting()) return;
      
      // Получаем задачу из очереди
      const task = await getAndStartPendingBroadcastTask();
      if (!task) return;
      
      console.log(`[Broadcast] Начинаю рассылку #${task.id}. Приостанавливаю очередь скачивания.`);
      setBroadcasting(true);
      downloadQueue.pause();
      
      const startTime = Date.now();
      let isDone = false;
      
      try {
        while (!isDone && !isShuttingDown()) {
          // Проверка таймаута
          if (Date.now() - startTime > BROADCAST_MAX_DURATION) {
            console.warn(`[Broadcast] Превышено максимальное время выполнения (${BROADCAST_MAX_DURATION / 60000} мин)`);
            await updateBroadcastStatus(task.id, 'pending'); // Возвращаем в очередь
            break;
          }
          
          // Получаем батч пользователей
          const users = await getUsersForBroadcastBatch(
            task.id,
            task.target_audience,
            BROADCAST_BATCH_SIZE
          );
          
          if (users.length === 0) {
            isDone = true;
            continue;
          }
          
          // Отправляем батч
          await runBroadcastBatch(botInstance, task, users);
          
          // Пауза между батчами
          await new Promise(resolve => setTimeout(resolve, BROADCAST_BATCH_DELAY));
        }
        
        // Если завершилось штатно — помечаем как completed
        if (!isShuttingDown() && isDone) {
          await updateBroadcastStatus(task.id, 'completed');
          await sendAdminReport(botInstance, task.id, task);
          console.log(`[Broadcast] Рассылка #${task.id} успешно завершена`);
        }
      } catch (error) {
        console.error(`[Broadcast] Критическая ошибка при выполнении задачи #${task.id}:`, error);
        await updateBroadcastStatus(task.id, 'failed', error.message);
      } finally {
        // Всегда возобновляем очередь скачивания
        if (isBroadcasting()) {
          setBroadcasting(false);
          downloadQueue.start();
          console.log('[Broadcast] Очередь скачивания возобновлена');
        }
      }
    },
    { watchdogMs: 35 * 60 * 1000 } // Watchdog на 35 минут (больше чем BROADCAST_MAX_DURATION)
  );
}

// ========================= GRACEFUL SHUTDOWN =========================

/**
 * Настройка изящного завершения работы
 */
function setupGracefulShutdown(server) {
  const gracefulShutdown = async (signal) => {
    // Защита от повторных вызовов через mutex
    const release = await shutdownMutex.acquire();
    
    try {
      if (isShuttingDown()) {
        console.log(`[Shutdown] Уже выполняется, игнорирую повторный сигнал ${signal}`);
        return;
      }
      
      setShuttingDown(true);
      console.log(`[Shutdown] Получен сигнал ${signal}. Начинаю изящное завершение...`);
      
      // Закрываем HTTP сервер
      server.close(() => console.log('[Shutdown] HTTP сервер закрыт'));
      
      // Если идёт рассылка — помечаем как прерванную
      if (isBroadcasting()) {
        // services/workerManager.js (улучшенная версия) - ЧАСТЬ 2 (ФИНАЛ)

        console.log('[Shutdown] Обнаружена активная рассылка, помечаю как прерванную...');
        await findAndInterruptActiveBroadcast();
      }
      
      // Останавливаем новые задачи в очереди
      downloadQueue.pause();
      console.log('[Shutdown] Очередь скачивания приостановлена');
      
      // Ждём завершения активных задач (с таймаутом)
      if (downloadQueue.pending > 0 || downloadQueue.size > 0) {
        console.log(
          `[Shutdown] Ожидаю завершения задач в очереди ` +
          `(активных: ${downloadQueue.pending}, в ожидании: ${downloadQueue.size}). ` +
          `Макс. ${SHUTDOWN_TIMEOUT / 1000}с...`
        );
        
        await Promise.race([
          downloadQueue.onIdle(),
          new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT))
        ]);
        
        // Если задачи не успели завершиться — очищаем очередь
        if (downloadQueue.size > 0) {
          console.warn(`[Shutdown] Не все задачи завершились, очищаю очередь (${downloadQueue.size} задач)`);
          downloadQueue.clear();
        }
      }
      
      // Закрываем соединения с БД и Redis
      console.log('[Shutdown] Закрываю соединения с БД и Redis...');
      await Promise.allSettled([
        pool.end(),
        redisService.disconnect()
      ]);
      
      console.log('[Shutdown] ✅ Завершение работы успешно завершено');
      process.exit(0);
    } catch (e) {
      console.error('[Shutdown] Ошибка при завершении:', e);
      process.exit(1);
    } finally {
      release();
    }
  };
  
  // Регистрируем обработчики сигналов
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  
  // Обработка необработанных ошибок (для диагностики)
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[UnhandledRejection]', reason);
    console.error('Promise:', promise);
  });
  
  process.on('uncaughtException', (error) => {
    console.error('[UncaughtException]', error);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
  });
}

// ========================= INITIALIZATION =========================

/**
 * Инициализация всех воркеров
 */
export function initializeWorkers(server, bot) {
  botInstance = bot;
  
  console.log('[Workers] Инициализация воркеров...');
  
  // Запускаем воркеры
  startBroadcastWorker();
  startNotifierWorker();
  startPremiumAutoResetWorker();
  
  // Настраиваем graceful shutdown
  setupGracefulShutdown(server);
  
  console.log('[Workers] ✅ Все воркеры успешно запущены');
}

// ========================= EXPORTS SUMMARY =========================
// Основной экспорт: initializeWorkers(server, bot)
// Запускает все фоновые задачи:
// - Broadcast Worker: обработка массовых рассылок
// - Notifier Worker: уведомления об истечении подписок (daily + hourly)
// - Premium Auto-Reset Worker: ночной сброс истёкших подписок
// - Graceful Shutdown: корректное завершение работы при SIGTERM/SIGINT

// ========================= CONFIGURATION TIPS =========================
// 
// Константы для настройки (можно вынести в ENV):
// - SHUTDOWN_TIMEOUT=25000 (таймаут graceful shutdown)
// - BROADCAST_BATCH_SIZE=100 (размер батча рассылки)
// - BROADCAST_BATCH_DELAY=1000 (задержка между батчами, мс)
// - BROADCAST_MAX_DURATION=1800000 (макс. длительность рассылки, 30 мин)
// 
// ========================= END OF FILE =========================