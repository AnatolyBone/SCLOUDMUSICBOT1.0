// services/redisClient.js


import { createClient } from 'redis';

class RedisService {
  constructor() {
    this.client = null;
  }

  async connect() {
    if (this.client) {
      return this.client;
    }

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('Переменная окружения REDIS_URL не найдена!');
    }

    console.log(`[Redis] Подключаюсь к: ${redisUrl.split('@')[1] || 'неизвестному хосту'}`);

    this.client = createClient({ url: redisUrl });
    this.client.on('error', (err) => console.error('🔴 Ошибка Redis:', err));
    await this.client.connect();

    return this.client;
  }

  getClient() {
    if (!this.client) {
      throw new Error('Redis клиент не инициализирован. Вызовите connect() сначала.');
    }
    return this.client;
  }
}

const redisService = new RedisService();

// Экспортируем функцию для прямого доступа к клиенту
export const getRedisClient = () => redisService.getClient();

export default redisService;
