// services/appState.js

// Флаг, который показывает, что приложение в процессе принудительного завершения работы.
export let isShuttingDown = false;

// Флаг, который показывает, что включен ручной режим обслуживания.
export let isMaintenanceMode = false;

// Функция для установки флага принудительного завершения.
export function setShuttingDown() {
  if (!isShuttingDown) {
    console.log('[Shutdown] Установлен флаг завершения работы. Новые задачи не принимаются.');
    isShuttingDown = true;
  }
}
export let isBroadcasting = false; // <-- НОВЫЙ ФЛАГ
export const setBroadcasting = (state) => { isBroadcasting = state; };

// Функция для ручного управления режимом обслуживания.
export function setMaintenanceMode(state) {
    isMaintenanceMode = state;
    console.log(`[Maintenance] Режим обслуживания ${state ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН'}.`);
}