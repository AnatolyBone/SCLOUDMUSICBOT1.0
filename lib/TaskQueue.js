// lib/TaskQueue.js
// Это простой, но эффективный менеджер очереди задач, который позволяет
// выполнять ограниченное количество задач одновременно.

export class TaskQueue {
    constructor(options = {}) {
        this.maxConcurrent = options.maxConcurrent || 1;
        this.taskProcessor = options.taskProcessor;

        if (typeof this.taskProcessor !== 'function') {
            throw new Error('Task processor function is required');
        }

        this.queue = [];
        this.active = 0;
    }

    /**
     * Добавляет новую задачу в очередь.
     * @param {object} task - Объект задачи для обработки.
     */
    add(task) {
        this.queue.push(task);
        this.processNext();
    }

    /**
     * Обрабатывает следующую задачу из очереди, если есть свободные слоты.
     */
    async processNext() { // <<< ИЗМЕНЕНО: Добавлено async
        if (this.active >= this.maxConcurrent || this.queue.length === 0) {
            return; // Все воркеры заняты или очередь пуста
        }

        const task = this.queue.shift(); // Берем следующую задачу
        this.active++;
        
        console.log(`[TaskQueue] Запускаю задачу. Активно: ${this.active}, В очереди: ${this.queue.length}`);

        try {
            // <<< ИЗМЕНЕНО: Весь вызов теперь внутри try...catch >>>
            await this.taskProcessor(task);
        } catch (err) {
            // Этот catch - наш главный "спасательный круг".
            // Он поймает любую ошибку, которую мог пропустить taskProcessor.
            console.error('🔴 [TaskQueue] Критическая необработанная ошибка в task processor:', err);
        } finally {
            // Этот блок выполнится всегда: и после успеха, и после ошибки.
            this.active--;
            console.log(`[TaskQueue] Задача завершена. Активно: ${this.active}, В очереди: ${this.queue.length}`);
            this.processNext(); // Пытаемся запустить следующую задачу
        }
    }

    /**
     * Возвращает количество задач в очереди.
     */
    get size() {
        return this.queue.length;
    }

    /**
     * Возвращает количество активных (выполняющихся) задач.
     */
    get activeTasks() {
        return this.active;
    }
}