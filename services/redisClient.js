// services/redisClient.js

import { createClient } from 'redis';

class RedisService {
  constructor() {
    this.client = null;
    console.log('[Redis] Сервис создан.');
  }

  async connect() {
    if (this.client && this.client.isOpen) {
      return this.client;
    }

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      // В production это должно быть критической ошибкой
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Переменная окружения REDIS_URL не найдена!');
      }
      console.warn('[Redis] Переменная REDIS_URL не найдена. Redis не будет использоваться.');
      return null;
    }

    console.log(`[Redis] Подключаюсь...`);

    this.client = createClient({ url: redisUrl });
    this.client.on('error', (err) => console.error('🔴 Ошибка Redis:', err));
    await this.client.connect();
    console.log('✅ [Redis] Клиент успешно подключен.');
    return this.client;
  }

  getClient() {
    if (!this.client || !this.client.isOpen) {
      console.warn('[Redis] Попытка получить доступ к Redis, но клиент не подключен.');
      return null; // Возвращаем null вместо ошибки, чтобы приложение не падало
    }
    return this.client;
  }

  async disconnect() {
    if (this.client && this.client.isOpen) {
      console.log('[Redis] Закрываю соединение...');
      await this.client.quit();
      this.client = null;
      console.log('✅ [Redis] Соединение успешно закрыто.');
    }
  }
}

const redisService = new RedisService();

export default redisService;