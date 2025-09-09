// services/workerManager.js

import cron from 'node-cron';
import { bot } from '../bot.js';
import { pool, getAndStartPendingBroadcastTask, updateBroadcastStatus, getUsersForBroadcastBatch, findAndInterruptActiveBroadcast } from '../db.js';
import redisService from './redisClient.js';
import { downloadQueue } from './downloadManager.js';
import { isShuttingDown, setShuttingDown, isBroadcasting, setBroadcasting } from './appState.js';
import { runBroadcastBatch, sendAdminReport } from './broadcastManager.js';

/**
 * Настраивает "изящное завершение" приложения.
 * Перехватывает сигналы SIGINT/SIGTERM, прерывает активную рассылку,
 * ожидает завершения текущих скачиваний и закрывает соединения с БД и Redis.
 * @param {import('http').Server} server - HTTP сервер Express.
 */
function setupGracefulShutdown(server) {
    const SHUTDOWN_TIMEOUT = 25000; // 25 секунд на завершение скачиваний

    const gracefulShutdown = async (signal) => {
        if (isShuttingDown()) return;
        setShuttingDown(true);

        console.log(`[Shutdown] Получен сигнал ${signal}. Начинаю изящное завершение...`);

        // 1. Закрыть HTTP сервер, чтобы не принимать новые запросы
        server.close(() => console.log('[Shutdown] HTTP сервер закрыт.'));

        // 2. Если шла рассылка, прервать ее и вернуть в очередь
        if (isBroadcasting()) {
            console.log('[Shutdown] Прерываю активную рассылку...');
            await findAndInterruptActiveBroadcast();
        }

        // 3. Дождаться завершения активных задач в очереди скачивания
        if (downloadQueue.size > 0 || downloadQueue.pending > 0) {
            console.log(`[Shutdown] Ожидаю завершения скачиваний (макс. ${SHUTDOWN_TIMEOUT / 1000}с)...`);
            await Promise.race([
                downloadQueue.onIdle(),
                new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT))
            ]);
        }

        // 4. Закрыть все внешние соединения
        console.log('[Shutdown] Закрываю соединения с БД и Redis...');
        await Promise.allSettled([pool.end(), redisService.disconnect()]);

        console.log('[Shutdown] Завершение работы.');
        process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

/**
 * Запускает cron-задачу, которая раз в минуту проверяет наличие рассылок
 * и обрабатывает их в отказоустойчивом пакетном режиме.
 */
function startBroadcastWorker() {
    console.log('[Broadcast Worker] Планировщик запущен.');

    const BATCH_SIZE = 100;   // Количество пользователей, обрабатываемых за один раз
    const BATCH_DELAY = 1000; // Пауза в миллисекундах между пачками для снижения нагрузки

    cron.schedule('* * * * *', async () => {
        // Защита от запуска нескольких копий воркера или во время выключения
        if (isBroadcasting() || isShuttingDown()) {
            return;
        }

        const task = await getAndStartPendingBroadcastTask();
        if (!task) {
            return; // Нет активных задач для рассылки
        }
        
        console.log(`[Broadcast] Начинаю рассылку #${task.id}. Приостанавливаю очередь скачивания.`);
        setBroadcasting(true);
        downloadQueue.pause();

        try {
            let isDone = false;
            // Основной цикл: работает, пока не будут обработаны все пользователи или пока не придет сигнал о завершении
            while (!isDone && !isShuttingDown()) {
                // 1. Получаем следующую пачку пользователей, которым еще не отправляли
                const users = await getUsersForBroadcastBatch(task.id, task.target_audience, BATCH_SIZE);

                // Если база данных вернула пустой массив, значит, все отправлено
                if (users.length === 0) {
                    isDone = true;
                    console.log(`[Broadcast] Все пользователи для рассылки #${task.id} обработаны.`);
                    continue; // Завершаем цикл
                }

                // 2. Обрабатываем полученную пачку
                console.log(`[Broadcast] Отправляю пачку из ${users.length} пользователей для задачи #${task.id}`);
                await runBroadcastBatch(bot, task, users);

                // 3. Делаем небольшую паузу, чтобы не превысить лимиты Telegram API
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
            }

            // Проверяем, почему завершился цикл
            if (isShuttingDown()) {
                console.log(`[Broadcast] Рассылка #${task.id} прервана из-за завершения работы. Она будет возобновлена после перезапуска.`);
                // Статус задачи вернется в 'pending' благодаря findAndInterruptActiveBroadcast в gracefulShutdown
            } else {
                console.log(`[Broadcast] Рассылка #${task.id} успешно завершена.`);
                await updateBroadcastStatus(task.id, 'completed');
                await sendAdminReport(bot, task.id, task);
            }

        } catch (error) {
            console.error(`[Broadcast Worker] Критическая ошибка при выполнении задачи #${task.id}:`, error);
            await updateBroadcastStatus(task.id, 'failed', error.message);
        } finally {
            // Этот блок выполнится всегда: и при успехе, и при ошибке, и при прерывании
            setBroadcasting(false);
            downloadQueue.start();
            console.log(`[Broadcast] Очередь скачивания возобновлена.`);
        }
    });
}

/**
 * Инициализирует все фоновые процессы: воркер рассылок и обработчик изящного завершения.
 * @param {import('http').Server} server - HTTP сервер Express.
 */
export function initializeWorkers(server) {
    startBroadcastWorker();
    setupGracefulShutdown(server);
}