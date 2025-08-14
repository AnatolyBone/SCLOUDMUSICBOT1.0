export class TaskQueue {
    constructor(options = {}) {
        this.maxConcurrent = options.maxConcurrent || 1;
        this.taskProcessor = options.taskProcessor;
        if (typeof this.taskProcessor !== 'function') throw new Error('Task processor is required');
        this.queue = [];
        this.active = 0;
    }
    add(task) {
        this.queue.push(task);
        this.processNext();
    }
    async processNext() {
        if (this.active >= this.maxConcurrent || this.queue.length === 0) return;
        const task = this.queue.shift();
        this.active++;
        try {
            await this.taskProcessor(task);
        } catch (err) {
            console.error('🔴 [TaskQueue] Критическая ошибка в task processor:', err);
        } finally {
            this.active--;
            this.processNext();
        }
    }
    get size() { return this.queue.length; }
    get activeTasks() { return this.active; }
}