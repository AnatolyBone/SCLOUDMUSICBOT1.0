// lib/TaskQueue.js (улучшенная версия)

/**
 * Простая очередь задач с приоритетами и контролем параллелизма
 */
export class TaskQueue {
  constructor(options = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent || 1);
    this.taskProcessor = options.taskProcessor;
    this.taskTimeout = options.taskTimeout || 10 * 60 * 1000; // 10 минут по умолчанию
    
    if (typeof this.taskProcessor !== 'function') {
      throw new Error('TaskQueue: taskProcessor must be a function');
    }
    
    this.queue = [];
    this.active = 0;
    this.paused = options.autostart === false;
    this._idleResolvers = [];
    
    // Метрики
    this.stats = {
      processed: 0,
      errors: 0,
      timeouts: 0,
      rejected: 0 // Невалидные задачи
    };
  }

  /**
   * Добавляет задачу в очередь с приоритетом
   * @param {Object} task - Объект задачи
   * @returns {Promise} Промис, который резолвится после выполнения задачи
   */
  add(task) {
    // Валидация задачи
    if (!task || typeof task !== 'object') {
      console.error('[TaskQueue] Invalid task payload (not an object):', typeof task);
      this.stats.rejected++;
      return Promise.reject(new Error('Invalid task payload'));
    }
    
    // Обязательные поля для загрузчика музыки
    if (!task.metadata && !task.url && !task.originalUrl) {
      console.error('[TaskQueue] Dropping task without url/originalUrl/metadata:', task);
      this.stats.rejected++;
      return Promise.reject(new Error('Task missing required fields'));
    }
    
    // Создаём промис для отслеживания выполнения
    const promise = new Promise((resolve, reject) => {
      task._resolve = resolve;
      task._reject = reject;
      task._addedAt = Date.now();
    });
    
    // Вставляем задачу по приоритету
    const priority = (typeof task?.priority === 'number') ? task.priority : 0;
    const idx = this.queue.findIndex(t => ((t.priority || 0) < priority));
    
    if (idx === -1) {
      this.queue.push(task);
    } else {
      this.queue.splice(idx, 0, task);
    }
    
    // Запускаем обработку
    this.processNext();
    
    return promise;
  }

  /**
   * Приостанавливает обработку новых задач
   */
  pause() {
    if (!this.paused) {
      console.log('[TaskQueue] Очередь приостановлена');
      this.paused = true;
    }
  }

  /**
   * Возобновляет обработку задач
   */
  start() {
    if (this.paused) {
      console.log('[TaskQueue] Очередь возобновлена');
      this.paused = false;
      this.processNext();
    }
  }

  /**
   * Устанавливает максимальное количество параллельных задач
   */
  setMaxConcurrent(n) {
    this.maxConcurrent = Math.max(1, n | 0);
    console.log(`[TaskQueue] maxConcurrent установлен в ${this.maxConcurrent}`);
    this.processNext();
  }

  /**
   * Очищает очередь (не отменяет активные задачи)
   */
  clear() {
    const cleared = this.queue.length;
    this.queue.forEach(task => {
      task._reject?.(new Error('Queue cleared'));
    });
    this.queue.length = 0;
    console.log(`[TaskQueue] Очередь очищена (${cleared} задач отменено)`);
  }

  /**
   * Обрабатывает следующие задачи из очереди
   */
  async processNext() {
    if (this.paused) return;
    
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();
      this.active++;
      
      const startTime = Date.now();
      const waitTime = startTime - (task._addedAt || startTime);
      
      if (waitTime > 60000) { // Если задача ждала больше минуты
        console.warn(`[TaskQueue] Задача ждала ${(waitTime / 1000).toFixed(1)}с в очереди`);
      }
      
      // Запускаем с таймаутом
      Promise.race([
        this.taskProcessor(task),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('TASK_TIMEOUT')), this.taskTimeout)
        )
      ])
        .then(() => {
          this.stats.processed++;
          task._resolve?.();
          
          const duration = Date.now() - startTime;
          if (duration > 30000) { // Если задача выполнялась больше 30 секунд
            console.log(`[TaskQueue] Задача выполнена за ${(duration / 1000).toFixed(1)}с`);
          }
        })
        .catch(err => {
          if (err.message === 'TASK_TIMEOUT') {
            this.stats.timeouts++;
            console.error(`🔴 [TaskQueue] Задача превысила таймаут ${this.taskTimeout / 1000}с:`, {
              userId: task.userId,
              url: task.url || task.originalUrl
            });
          } else {
            this.stats.errors++;
            console.error('🔴 [TaskQueue] Ошибка обработки задачи:', {
              userId: task.userId,
              url: task.url || task.originalUrl,
              error: err.message
            });
          }
          
          task._reject?.(err);
        })
        .finally(() => {
          this.active--;
          
          // Проверяем idle состояние
          if (this.queue.length === 0 && this.active === 0) {
            this._resolveIdle();
          }
          
          // Обрабатываем следующую задачу
          this.processNext();
        });
    }
  }

  /**
   * Возвращает промис, который резолвится когда очередь пуста
   */
  onIdle() {
    if (this.queue.length === 0 && this.active === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => this._idleResolvers.push(resolve));
  }

  /**
   * Резолвит все ожидающие idle промисы
   */
  _resolveIdle() {
    const resolvers = this._idleResolvers.splice(0, this._idleResolvers.length);
    resolvers.forEach(r => {
      try { r(); } catch {}
    });
  }

  /**
   * Возвращает статистику очереди
   */
  getStats() {
    return {
      ...this.stats,
      queueSize: this.queue.length,
      activeTasks: this.active,
      paused: this.paused
    };
  }

  // Геттеры для обратной совместимости
  get size() { return this.queue.length; }
  get activeTasks() { return this.active; }
  get pending() { return this.active; }
}

// ========================= EXPORTS SUMMARY =========================
// Основной класс: TaskQueue
// 
// Методы:
// - add(task): Promise - добавить задачу
// - pause() - приостановить обработку
// - start() - возобновить обработку
// - clear() - очистить очередь
// - onIdle(): Promise - дождаться завершения всех задач
// - getStats() - получить статистику
//
// Свойства:
// - size - количество задач в очереди
// - pending - количество активных задач
// - stats - объект с метриками