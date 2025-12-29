import './config.js'; // Загрузка переменных окружения
import { bot } from './bot.js';
import { taskBroker } from './services/taskBroker.js';
import { downloadTrackForUser } from './services/downloadManager.js';
import { downloadQueue } from './services/downloadManager.js';

console.log('[Worker] 🚀 Запуск воркера...');

async function main() {
  // 1. Подключаемся к Redis (Upstash)
  const connected = await taskBroker.connect();
  if (!connected) {
    console.error('[Worker] ❌ Не удалось подключиться к Redis. Воркер остановлен.');
    process.exit(1);
  }

  console.log('[Worker] ✅ Готов к работе. Ожидаю задачи...');

  // 2. Бесконечный цикл обработки задач
  while (true) {
    try {
      // Отправляем пульс, чтобы Мастер знал, что мы живы
      await taskBroker.sendHeartbeat();

      // Ждем задачу (блокируется на 2 сек)
      const task = await taskBroker.getTask();

      if (task) {
        console.log(`[Worker] 📥 Получена задача: ${task.taskId}`);
        console.log(`[Worker] 🎵 Обработка: ${task.metadata?.title || task.url}`);

        try {
          // ==========================================================
          // ⚙️ ОБРАБОТКА ЗАДАЧИ
          // ==========================================================
          
          let result;
          
          // Если это Spotify или YouTube - используем downloadTrackForUser
          // Эта функция сама скачает, отправит в ТГ и вернет file_id
          if (task.source === 'spotify' || task.source === 'youtube') {
             // Формируем URL или поисковый запрос
             let targetUrl = task.url;
             
             // Для Spotify иногда нужно собрать поисковый запрос
             if (task.source === 'spotify' && task.metadata) {
                 const artist = task.metadata.uploader || '';
                 const title = task.metadata.title || '';
                 targetUrl = `ytmsearch1:${artist} - ${title}`;
             }

             // Запускаем скачивание
             const downloadResult = await downloadTrackForUser(targetUrl, task.userId, task.metadata);
             
             result = {
                 success: true,
                 fileId: downloadResult.fileId,
                 title: downloadResult.title,
                 artist: task.metadata?.uploader || 'Unknown',
                 duration: task.metadata?.duration || 0,
                 source: task.source,
                 quality: task.quality
             };
          } else {
              // Для других типов задач (SoundCloud) - пока просто заглушка, 
              // т.к. SoundCloud обрабатывается на мастере, но на будущее:
              result = { success: false, error: 'Worker logic for this source not implemented' };
          }

          // ==========================================================
          // 📤 ОТПРАВКА РЕЗУЛЬТАТА
          // ==========================================================
          
          if (result.success) {
            console.log(`[Worker] ✅ Успех! Отправляю результат...`);
            await taskBroker.sendResult({
              taskId: task.taskId, // ВАЖНО: Возвращаем ID задачи
              userId: task.userId,
              ...result
            });
          } else {
            throw new Error(result.error || 'Unknown error');
          }

        } catch (processError) {
          console.error(`[Worker] ❌ Ошибка обработки:`, processError.message);
          
          // Отправляем ошибку Мастеру
          await taskBroker.sendResult({
            taskId: task.taskId,
            userId: task.userId,
            success: false,
            error: processError.message,
            task: task // Возвращаем задачу для возможного fallback (локальной обработки)
          });
        }
      }

    } catch (err) {
      console.error('[Worker] Ошибка в цикле:', err.message);
      // Пауза перед рестартом цикла при критической ошибке
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Обработка остановки (Ctrl+C)
process.on('SIGINT', async () => {
  console.log('\n[Worker] Получен SIGINT, завершаю работу...');
  await taskBroker.disconnect();
  process.exit(0);
});

// Запуск
main();
