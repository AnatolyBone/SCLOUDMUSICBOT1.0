// services/redisClient.js

import { createClient } from 'redis';

class RedisService {
  constructor() {
    this.client = null;
    this.connectionPromise = null; // Для защиты от "гонки состояний"
    console.log('[Redis] Сервис создан.');
  }

  /**
   * Устанавливает соединение с Redis, если его еще нет.
   * Гарантирует только одну попытку подключения за раз.
   */
  connect() {
    // Если уже подключены, мгновенно возвращаем клиента
    if (this.client && this.client.isOpen) {
      return Promise.resolve(this.client);
    }
    // Если уже идет процесс подключения, возвращаем его "обещание"
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    // Начинаем новый процесс подключения
    this.connectionPromise = new Promise(async (resolve, reject) => {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        console.warn('[Redis] Переменная REDIS_URL не найдена. Redis не будет использоваться.');
        this.connectionPromise = null;
        return resolve(null);
      }

      console.log(`[Redis] Подключаюсь...`);
      const client = createClient({ 
        url: redisUrl,
        // Добавляем стратегию автоматического переподключения
        socket: {
          reconnectStrategy: (retries) => {
            // Пытаемся переподключиться, увеличивая задержку, но не более 3 секунд
            if (retries > 10) {
              console.error('[Redis] Не удалось переподключиться после 10 попыток.');
              return new Error('Too many retries.');
            }
            return Math.min(retries * 100, 3000);
          }
        }
      });

      client.on('error', (err) => console.error('🔴 Ошибка Redis:', err.message));
      
      try {
        await client.connect();
        console.log('✅ [Redis] Клиент успешно подключен.');
        this.client = client;
        this.connectionPromise = null; // Сбрасываем "обещание" после успеха
        resolve(this.client);
      } catch (err) {
        console.error('🔴 [Redis] Критическая ошибка при подключении:', err.message);
        this.connectionPromise = null; // Сбрасываем, чтобы можно было попробовать снова
        reject(err);
      }
    });
    return this.connectionPromise;
  }

  /**
   * Безопасно получает значение по ключу.
   * @param {string} key
   * @returns {Promise<string|null>}
   */
  async get(key) {
    try {
      const client = await this.connect();
      if (!client) return null;
      return await client.get(key);
    } catch (e) {
      console.error(`[Redis GET] Ошибка при получении ключа ${key}:`, e.message);
      return null;
    }
  }

  /**
   * Безопасно устанавливает значение с временем жизни (TTL).
   * @param {string} key
   * @param {string} value
   * @param {number} ttlSeconds - Время жизни в секундах
   */
  async set(key, value, ttlSeconds) {
    try {
      const client = await this.connect();
      if (!client) return;
      await client.set(key, value, { EX: ttlSeconds });
    } catch (e) {
      console.error(`[Redis SET] Ошибка при установке ключа ${key}:`, e.message);
    }
  }

  async disconnect() {
    if (this.client && this.client.isOpen) {
      console.log('[Redis] Закрываю соединение...');
      await this.client.quit();
      this.client = null;
    }
  }
}

const redisService = new RedisService();
export default redisService;