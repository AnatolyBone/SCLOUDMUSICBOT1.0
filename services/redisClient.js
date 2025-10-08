// services/redisClient.js (IOREDIS VERSION)

import Redis from 'ioredis';

class RedisService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    console.log('[Redis] Сервис создан.');
  }

  /**
   * Устанавливает соединение с Redis
   */
  async connect() {
    // Если уже подключены, возвращаем клиента
    if (this.client && this.isConnected) {
      return this.client;
    }

    const redisUrl = process.env.REDIS_URL;
    
    if (!redisUrl) {
      console.warn('[Redis] Переменная REDIS_URL не найдена. Redis не будет использоваться.');
      return null;
    }

    console.log('[Redis] Подключаюсь...');
    
    this.client = new Redis(redisUrl, {
      retryStrategy: (times) => {
        this.reconnectAttempts = times;
        
        if (times > 10) {
          console.error('[Redis] Превышен лимит попыток переподключения (10).');
          return null; // Прекращаем автореконнект
        }
        
        const delay = Math.min(times * 100, 3000);
        console.log(`[Redis] Попытка переподключения ${times}/10 через ${delay}мс...`);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false
    });

    // События
    this.client.on('error', (err) => {
      console.error('🔴 [Redis] Ошибка:', err.message);
      this.isConnected = false;
    });

    this.client.on('reconnecting', () => {
      console.log('[Redis] Переподключение...');
      this.isConnected = false;
    });

    this.client.on('connect', () => {
      console.log('✅ [Redis] Соединение восстановлено.');
      this.isConnected = true;
      this.reconnectAttempts = 0;
    });

    this.client.on('ready', () => {
      console.log('✅ [Redis] Клиент успешно подключен.');
      this.isConnected = true;
    });

    this.client.on('close', () => {
      console.log('[Redis] Соединение закрыто.');
      this.isConnected = false;
    });

    try {
      await this.client.ping();
      return this.client;
    } catch (err) {
      console.error('🔴 [Redis] Критическая ошибка при подключении:', err.message);
      throw err;
    }
  }

  /**
   * Проверяет и возвращает активное соединение
   */
  async ensureConnection() {
    if (this.client && this.isConnected) return this.client;
    return await this.connect();
  }

  /**
   * Получает значение по ключу
   */
  async get(key) {
    if (!key || typeof key !== 'string') {
      console.error('[Redis GET] Некорректный ключ:', key);
      return null;
    }

    try {
      const client = await this.ensureConnection();
      if (!client) return null;
      return await client.get(key);
    } catch (e) {
      console.error(`[Redis GET] Ошибка при получении ключа ${key}:`, e.message);
      return null;
    }
  }

  /**
   * Устанавливает значение с TTL
   */
  async set(key, value, ttlSeconds) {
    if (!key || typeof key !== 'string') {
      console.error('[Redis SET] Некорректный ключ:', key);
      return;
    }

    if (value === undefined || value === null) {
      console.error('[Redis SET] Некорректное значение для ключа', key);
      return;
    }

    // Автоматическая сериализация объектов
    const valueToStore = typeof value === 'object' ? JSON.stringify(value) : String(value);

    try {
      const client = await this.ensureConnection();
      if (!client) return;
      
      if (ttlSeconds) {
        await client.setex(key, ttlSeconds, valueToStore);
      } else {
        await client.set(key, valueToStore);
      }
    } catch (e) {
      console.error(`[Redis SET] Ошибка при установке ключа ${key}:`, e.message);
    }
  }

  /**
   * Устанавливает значение с TTL (совместимость с notifier.js)
   */
  async setEx(key, ttlSeconds, value) {
    return await this.set(key, value, ttlSeconds);
  }

  /**
   * setex с правильным порядком аргументов (для ioredis)
   */
  async setex(key, ttlSeconds, value) {
    if (!key || typeof key !== 'string') {
      console.error('[Redis SETEX] Некорректный ключ:', key);
      return;
    }

    const valueToStore = typeof value === 'object' ? JSON.stringify(value) : String(value);

    try {
      const client = await this.ensureConnection();
      if (!client) return;
      await client.setex(key, ttlSeconds, valueToStore);
    } catch (e) {
      console.error(`[Redis SETEX] Ошибка:`, e.message);
    }
  }

  /**
   * Удаляет ключ
   */
  async del(key) {
    if (!key || typeof key !== 'string') {
      console.error('[Redis DEL] Некорректный ключ:', key);
      return 0;
    }

    try {
      const client = await this.ensureConnection();
      if (!client) return 0;
      return await client.del(key);
    } catch (e) {
      console.error(`[Redis DEL] Ошибка при удалении ключа ${key}:`, e.message);
      return 0;
    }
  }

  /**
   * Получает JSON объект
   */
  async getJson(key) {
    const value = await this.get(key);
    if (!value) return null;
    
    try {
      return JSON.parse(value);
    } catch (e) {
      console.error(`[Redis] Ошибка парсинга JSON для ключа ${key}:`, e.message);
      return null;
    }
  }

  /**
   * Сохраняет JSON объект
   */
  async setJson(key, obj, ttlSeconds) {
    if (typeof obj !== 'object' || obj === null) {
      console.error('[Redis] setJson ожидает объект, получено:', typeof obj);
      return;
    }

    const value = JSON.stringify(obj);
    await this.set(key, value, ttlSeconds);
  }

  /**
   * Проверяет доступность Redis (для healthcheck)
   */
  async isAvailable() {
    try {
      const client = await this.ensureConnection();
      if (!client) return false;
      await client.ping();
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Инкрементирует значение (для счётчиков)
   */
  async incr(key) {
    try {
      const client = await this.ensureConnection();
      if (!client) return null;
      return await client.incr(key);
    } catch (e) {
      console.error(`[Redis INCR] Ошибка инкремента ${key}:`, e.message);
      return null;
    }
  }

  /**
   * Устанавливает TTL для существующего ключа
   */
  async expire(key, ttlSeconds) {
    try {
      const client = await this.ensureConnection();
      if (!client) return false;
      return await client.expire(key, ttlSeconds);
    } catch (e) {
      console.error(`[Redis EXPIRE] Ошибка установки TTL для ${key}:`, e.message);
      return false;
    }
  }

  /**
   * Закрывает соединение
   */
  async disconnect() {
    if (this.client) {
      console.log('[Redis] Закрываю соединение...');
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
    }
  }
}

// Создаём singleton инстанс
const redisService = new RedisService();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await redisService.disconnect();
});

process.on('SIGINT', async () => {
  await redisService.disconnect();
});

export default redisService;