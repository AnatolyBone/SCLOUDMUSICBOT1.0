// worker.js - Запускается на мощном сервере/ПК
// node worker.js

import 'dotenv/config';
import fs from 'fs';
import { taskBroker } from './services/taskBroker.js';
import { downloadSpotifyTrack, downloadSpotifyStream } from './services/spotifyDownloader.js';
import { bot } from './bot.js';  // Нужен для отправки в Telegram
import { Readable } from 'stream';

const REDIS_URL = process.env.REDIS_URL;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;

async function processTask(task) {
  console.log(`[Worker] 🎵 Обработка: ${task.metadata?.title}`);
  
  const { source, quality, metadata, userId, cacheKey } = task;
  
  try {
    if (source === 'spotify') {
      const trackInfo = {
        title: metadata.title,
        artist: metadata.uploader,
        duration: metadata.duration
      };
      
      let fileId = null;
      let tempFilePath = null;
      
      // Пробуем pipe-стриминг (быстрый метод)
      try {
        const streamResult = await downloadSpotifyStream(
          `${trackInfo.artist} ${trackInfo.title}`,
          { quality }
        );
        
        const fileSizeMB = streamResult.size / 1024 / 1024;
        
        if (fileSizeMB <= 48) {
          // Отправляем buffer напрямую
          const stream = Readable.from(streamResult.buffer);
          
          const sentMsg = await bot.telegram.sendAudio(
            STORAGE_CHANNEL_ID,
            { source: stream, filename: `${trackInfo.title}.mp3` },
            { 
              title: trackInfo.title, 
              performer: trackInfo.artist,
              duration: metadata.duration ? Math.round(metadata.duration) : undefined,
              disable_notification: true 
            }
          );
          
          fileId = sentMsg?.audio?.file_id;
          console.log(`[Worker] ✅ Stream отправлен, file_id: ${fileId?.slice(0, 20)}...`);
        } else {
          throw new Error('BUFFER_TOO_LARGE');
        }
      } catch (streamErr) {
        console.warn(`[Worker] Stream не сработал: ${streamErr.message}, используем файловый метод`);
        
        // Fallback на файловый метод
        const result = await downloadSpotifyTrack(trackInfo, { quality });
        tempFilePath = result.filePath;
        
        const sentMsg = await bot.telegram.sendAudio(
          STORAGE_CHANNEL_ID,
          { source: fs.createReadStream(tempFilePath), filename: `${trackInfo.title}.mp3` },
          { 
            title: trackInfo.title, 
            performer: trackInfo.artist,
            duration: metadata.duration ? Math.round(metadata.duration) : undefined,
            disable_notification: true 
          }
        );
        
        fileId = sentMsg?.audio?.file_id;
        
        // Удаляем временный файл
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
        
        console.log(`[Worker] ✅ Файл отправлен, file_id: ${fileId?.slice(0, 20)}...`);
      }
      
      if (!fileId) {
        throw new Error('Не удалось получить file_id');
      }
      
      return {
        success: true,
        fileId,
        title: trackInfo.title,
        artist: trackInfo.artist,
        quality,
        cacheKey
      };
    }
    
    throw new Error(`Unknown source: ${source}`);
    
  } catch (err) {
    console.error(`[Worker] ❌ Ошибка:`, err.message);
    return {
      success: false,
      error: err.message,
      cacheKey
    };
  }
}

async function main() {
  console.log('[Worker] 🚀 Запуск воркера...');
  
  const connected = await taskBroker.connect(REDIS_URL);
  if (!connected) {
    console.error('[Worker] ❌ Не удалось подключиться к Redis');
    console.error('[Worker] Проверьте REDIS_URL в .env');
    process.exit(1);
  }

  // Heartbeat каждые 30 сек
  setInterval(() => taskBroker.sendHeartbeat(), 30000);
  await taskBroker.sendHeartbeat();

  console.log('[Worker] ✅ Готов к работе. Ожидаю задачи...');

  // Основной цикл
  while (true) {
    try {
      const task = await taskBroker.getTask(30);
      
      if (!task) {
        continue; // Таймаут, пробуем снова
      }

      console.log(`[Worker] 📥 Получена задача: ${task.taskId}`);
      
      const result = await processTask(task);
      
      await taskBroker.sendResult(task.taskId, {
        ...result,
        userId: task.userId
      });
      
    } catch (err) {
      console.error('[Worker] Ошибка в цикле:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Worker] Получен SIGINT, завершаю работу...');
  await taskBroker.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Worker] Получен SIGTERM, завершаю работу...');
  await taskBroker.disconnect();
  process.exit(0);
});

main().catch(console.error);

