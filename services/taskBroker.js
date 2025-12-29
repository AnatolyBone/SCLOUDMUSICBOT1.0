// services/taskBroker.js
// Брокер задач: Render ↔ Worker (Гибридный) через Upstash Redis

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
    // Пробуем взять URL из разных переменных для совместимости
    const redisUrl = process.env.TASK_BROKER_REDIS_URL || process.env.REDIS_URL;
    
    if (!redisUrl) {
      console.log('[TaskBroker] ⚠️ REDIS_URL не задан — работа невозможна');
      return false;
    }

    // console.log('[TaskBroker] 🔗 Подключение к Redis...');

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
        // console.error('[TaskBroker] Redis error:', err.message);
      });

      await this.redis.connect();
      await this.subscriber.connect();

      // Проверка подключения
      // const pong = await this.redis.ping();
      // console.log(`[TaskBroker] 📡 Redis PING: ${pong}`);

      // Подписываемся на результаты (нужно только Мастеру, но оставим для совместимости)
      await this.subscriber.subscribe(RESULTS_KEY);
      
      this.subscriber.on('message', (channel, message) => {
        if (channel === RESULTS_KEY) {
          try {
            const result = JSON.parse(message);
            this.emit('result', result);
          } catch (e) {
            console.error('[TaskBroker] Parse error:', e.message);
          }
        }
      });

      this.isConnected = true;
      console.log('[TaskBroker] ✅ Подключён к Redis!');
      return true;
      
    } catch (err) {
      console.error('[TaskBroker] ❌ Ошибка подключения:', err.message);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Добавляет задачу в очередь (Использует MASTER)
   */
  async addTask(task) {
    if (!this.isConnected) return null;

    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const taskData = { ...task, taskId, createdAt: Date.now() };
    
    // lpush - добавляем в начало, воркер забирает с конца (rpop)
    await this.redis.lpush(QUEUE_KEY, JSON.stringify(taskData));
    console.log(`[TaskBroker] 📤 Задача добавлена: ${taskId}`);
    
    return taskId;
  }

  /**
   * Получает задачу из очереди (Использует WORKER)
   */
  async getTask() {
    if (!this.isConnected) return null;

    try {
      // brpop ждет задачу 2 секунды, если нет - возвращает null
      // Это позволяет воркеру не долбить Redis бесконечно
      const result = await this.redis.brpop(QUEUE_KEY, 2);
      
      if (result && result[1]) {
        const task = JSON.parse(result[1]);
        console.log(`[TaskBroker] 📥 Получена задача: ${task.taskId}`);
        return task;
      }
    } catch (e) {
      // Игнорируем таймауты
      if (!e.message.includes('ETIMEDOUT')) {
        console.error('[TaskBroker] Ошибка получения задачи:', e.message);
      }
    }
    return null;
  }

  /**
   * Отправляет пульс, что воркер жив (Использует WORKER)
   */
  async sendHeartbeat() {
    if (!this.isConnected) return;
    // Пишем текущее время, ключ живет 2 минуты
    await this.redis.set(HEARTBEAT_KEY, Date.now(), 'EX', 120);
  }

  /**
   * Отправляет результат обработки (Использует WORKER)
   */
  async sendResult(result) {
    if (!this.isConnected) return;
    console.log(`[TaskBroker] 📤 Отправка результата: ${result.taskId}`);
    await this.redis.publish(RESULTS_KEY, JSON.stringify(result));
  }

  /**
   * Проверяет, есть ли активный воркер (Использует MASTER)
   */
  async hasActiveWorker() {
    if (!this.isConnected) return false;
    try {
      const lastHeartbeat = await this.redis.get(HEARTBEAT_KEY);
      if (!lastHeartbeat) return false;
      const age = Date.now() - parseInt(lastHeartbeat);
      return age < 120000; // 2 минуты
    } catch (e) {
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
