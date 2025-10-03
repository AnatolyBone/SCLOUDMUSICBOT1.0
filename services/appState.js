// services/appState.js (исправленная версия)

// ========================= STATE FLAGS =========================

/**
 * Флаг принудительного завершения работы приложения
 * @private
 */
let shutdownFlag = false;

/**
 * Флаг режима обслуживания (техническая пауза)
 * @private
 */
let maintenanceFlag = false;

/**
 * Флаг активной массовой рассылки
 * @private
 */
let broadcastingFlag = false;

// ========================= SHUTDOWN MANAGEMENT =========================

/**
 * Проверяет, идёт ли процесс завершения работы
 * @returns {boolean}
 */
export function isShuttingDown() {
  return shutdownFlag;
}

/**
 * Устанавливает флаг завершения работы
 * @param {boolean} [state=true] - Новое состояние
 */
export function setShuttingDown(state = true) {
  if (state && !shutdownFlag) {
    console.log('[Shutdown] Установлен флаг завершения работы. Новые задачи не принимаются.');
  }
  shutdownFlag = Boolean(state);
}

// ========================= MAINTENANCE MODE =========================

/**
 * Проверяет, включен ли режим обслуживания
 * @returns {boolean}
 */
export function isMaintenanceMode() {
  return maintenanceFlag;
}

/**
 * Устанавливает режим обслуживания
 * @param {boolean} state - Новое состояние
 */
export function setMaintenanceMode(state) {
  maintenanceFlag = Boolean(state);
  console.log(`[Maintenance] Режим обслуживания ${state ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН'}.`);
}

// ========================= BROADCASTING STATE =========================

/**
 * Проверяет, идёт ли сейчас массовая рассылка
 * @returns {boolean}
 */
export function isBroadcasting() {
  return broadcastingFlag;
}

/**
 * Устанавливает флаг активной рассылки
 * @param {boolean} state - Новое состояние
 */
export function setBroadcasting(state) {
  broadcastingFlag = Boolean(state);
  
  if (state) {
    console.log('[Broadcast] Начата массовая рассылка');
  } else {
    console.log('[Broadcast] Рассылка завершена');
  }
}

// ========================= UTILITY FUNCTIONS =========================

/**
 * Возвращает текущее состояние всех флагов (для диагностики)
 * @returns {Object} Объект со всеми флагами
 */
export function getAppState() {
  return {
    isShuttingDown: shutdownFlag,
    isMaintenanceMode: maintenanceFlag,
    isBroadcasting: broadcastingFlag,
    timestamp: new Date().toISOString()
  };
}

/**
 * Сбрасывает все флаги (для тестирования, НЕ использовать в production)
 * @private
 */
export function resetAppState() {
  shutdownFlag = false;
  maintenanceFlag = false;
  broadcastingFlag = false;
  console.warn('[AppState] ⚠️ Все флаги сброшены (используется только для тестов!)');
}

// ========================= EXPORTS SUMMARY =========================
// Геттеры (функции):
// - isShuttingDown(): boolean
// - isMaintenanceMode(): boolean
// - isBroadcasting(): boolean
//
// Сеттеры (функции):
// - setShuttingDown(state?: boolean): void
// - setMaintenanceMode(state: boolean): void
// - setBroadcasting(state: boolean): void
//
// Утилиты:
// - getAppState(): Object
// - resetAppState(): void (только для тестов)