export class TaskQueue {
  constructor(options = {}) {
    this.maxConcurrent = Math.max(0, options.maxConcurrent || 1);
    this.taskProcessor = options.taskProcessor;
    if (typeof this.taskProcessor !== 'function') {
      throw new Error('Task processor is required');
    }
    this.queue = [];
    this.active = 0;
    this.paused = options.autostart === false; // по умолчанию стартует
    this._idleResolvers = [];
  }

  add(task) {
    const priority = (typeof task?.priority === 'number') ? task.priority : 0;
    // Вставка по приоритету (больше — раньше)
    const idx = this.queue.findIndex(t => ((t.priority || 0) < priority));
    if (idx === -1) this.queue.push(task);
    else this.queue.splice(idx, 0, task);

    this.processNext();
  }

  pause() { this.paused = true; }

  start() {
    if (!this.paused) return;
    this.paused = false;
    this.processNext();
  }

  setMaxConcurrent(n) {
    this.maxConcurrent = Math.max(0, n | 0);
    this.processNext();
  }

  clear() {
    this.queue.length = 0;
  }

  async processNext() {
    if (this.paused) return;
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();
      this.active++;
      Promise.resolve()
        .then(() => this.taskProcessor(task))
        .catch(err => console.error('🔴 [TaskQueue] Ошибка в task processor:', err))
        .finally(() => {
          this.active--;
          if (this.queue.length === 0 && this.active === 0) {
            this._resolveIdle();
          }
          // продолжаем гонку, пока есть слоты
          this.processNext();
        });
    }
  }

  onIdle() {
    if (this.queue.length === 0 && this.active === 0) return Promise.resolve();
    return new Promise(resolve => this._idleResolvers.push(resolve));
  }

  _resolveIdle() {
    const resolvers = this._idleResolvers.splice(0, this._idleResolvers.length);
    resolvers.forEach(r => {
      try { r(); } catch {}
    });
  }

  get size() { return this.queue.length; }
  get activeTasks() { return this.active; }
  get pending() { return this.active; } // совместимость с текущим кодом
}