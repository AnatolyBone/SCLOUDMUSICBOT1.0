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
      throw new Error('Переменная окружения REDIS_URL не найдена!');
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
      throw new Error('Redis клиент не инициализирован или отключен. Вызовите connect() сначала.');
    }
    return this.client;
  }
}

const redisService = new RedisService();

export default redisService;