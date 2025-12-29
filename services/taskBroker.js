// services/taskBroker.js
// Брокер задач: Render ↔ HuggingFace Worker через Upstash Redis

import Redis from 'ioredis';
import { EventEmitter } from 'events';

const QUEUE_KEY = 'music:download:queue';
const RESULTS_KEY = 'music:download:results';
const HEARTBEAT_KEY = 'music:worker:heartbeat';

class TaskBroker extends EventEmitter {
  constructor() {
    super();
    this.redis = null;
    this.subscriber = null;
    this.isConnected = false;
  }

  async connect() {
    // Используем ОТДЕЛЬНУЮ переменную для внешнего Redis (Upstash)
    const redisUrl = process.env.TASK_BROKER_REDIS_URL;
    
    if (!redisUrl) {
      console.log('[TaskBroker] ⚠️ TASK_BROKER_REDIS_URL не задан — гибридная архитектура отключена');
      return false;
    }

    console.log('[TaskBroker] 🔗 Подключение к Upstash Redis...');

    try {
      const options = {
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 1000,
        connectTimeout: 10000,
        lazyConnect: true
      };

      this.redis = new Redis(redisUrl, options);
      this.subscriber = new Redis(redisUrl, options);

      // Обработчики ошибок
      this.redis.on('error', (err) => {
        console.error('[TaskBroker] Redis error:', err.message);
      });

      await this.redis.connect();
      await this.subscriber.connect();

      // Проверка подключения
      const pong = await this.redis.ping();
      console.log(`[TaskBroker] 📡 Redis PING: ${pong}`);

      // Подписываемся на результаты от воркера
      await this.subscriber.subscribe(RESULTS_KEY);
      
      this.subscriber.on('message', (channel, message) => {
        if (channel === RESULTS_KEY) {
          try {
            const result = JSON.parse(message);
            console.log(`[TaskBroker] 📥 Результат от воркера: ${result.taskId}`);
            this.emit('result', result);
          } catch (e) {
            console.error('[TaskBroker] Parse error:', e.message);
          }
        }
      });

      this.isConnected = true;
      console.log('[TaskBroker] ✅ Подключён к Upstash Redis!');
      return true;
      
    } catch (err) {
      console.error('[TaskBroker] ❌ Ошибка подключения:', err.message);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Добавляет задачу в очередь
   */
  async addTask(task) {
    if (!this.isConnected) {
      console.log('[TaskBroker] Не подключён, задача не добавлена');
      return null;
    }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const taskData = { 
      ...task, 
      taskId, 
      createdAt: Date.now() 
    };
    
    await this.redis.lpush(QUEUE_KEY, JSON.stringify(taskData));
    console.log(`[TaskBroker] 📤 Задача добавлена: ${taskId}`);
    
    return taskId;
  }

  /**
   * Проверяет, есть ли активный воркер
   */
  async hasActiveWorker() {
    if (!this.isConnected) return false;

    try {
      const lastHeartbeat = await this.redis.get(HEARTBEAT_KEY);
      if (!lastHeartbeat) {
        console.log('[TaskBroker] ⚠️ Воркер не найден (нет heartbeat)');
        return false;
      }

      const age = Date.now() - parseInt(lastHeartbeat);
      const isActive = age < 120000; // 2 минуты
      
      if (isActive) {
        console.log(`[TaskBroker] ✅ Воркер активен (heartbeat ${Math.round(age/1000)}с назад)`);
      } else {
        console.log(`[TaskBroker] ⚠️ Воркер неактивен (${Math.round(age/1000)}с)`);
      }
      
      return isActive;
    } catch (e) {
      console.error('[TaskBroker] Ошибка проверки воркера:', e.message);
      return false;
    }
  }

  /**
   * Статистика очереди
   */
  async getQueueStats() {
    if (!this.isConnected) return { pending: 0, hasWorker: false };

    try {
      const pending = await this.redis.llen(QUEUE_KEY);
      const hasWorker = await this.hasActiveWorker();
      return { pending, hasWorker };
    } catch (e) {
      return { pending: 0, hasWorker: false };
    }
  }
}

export const taskBroker = new TaskBroker();
