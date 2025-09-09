// services/notifier.js

import { findUsersToNotify, markAsNotified, updateUserField } from '../db.js';

let lastNotificationDate = null; 

/**
 * Главная функция, которая проверяет, пора ли отправлять уведомления, и делает это.
 * Вызывается из cron-задачи в workerManager.
 * @param {Telegraf} bot - Экземпляр Telegraf для отправки сообщений.
 */
export async function checkAndSendExpirationNotifications(bot) {
    const now = new Date();
    // Запускаем рассылку в 10 утра по UTC
    if (now.getUTCHours() !== 10) {
        return;
    }

    const currentDate = now.toISOString().slice(0, 10);
    // Проверяем, не отправляли ли мы уже сегодня
    if (currentDate === lastNotificationDate) {
        return;
    }

    console.log(`[Notifier] Настало время для ежедневной рассылки уведомлений (${currentDate}).`);
    lastNotificationDate = currentDate;

    try {
        const users = await findUsersToNotify(3); // Ищем тех, у кого тариф истекает через 3 дня
        if (users.length === 0) {
            console.log('[Notifier] Пользователей для уведомления нет.');
            return;
        }

        console.log(`[Notifier] Найдено ${users.length} пользователей. Начинаю рассылку...`);
        for (const user of users) {
            const daysLeft = Math.ceil((new Date(user.premium_until) - new Date()) / (1000 * 60 * 60 * 24));
            if (daysLeft <= 0) continue; // На всякий случай

            const daysWord = daysLeft === 1 ? 'день' : 'дня'; // Упрощено для 1 и 3 дней

            const message = `👋 Привет, ${user.first_name}!\n\n` +
                            `Напоминаем, что ваша подписка истекает через ${daysLeft} ${daysWord}. ` +
                            `Не забудьте продлить ее, чтобы сохранить доступ ко всем возможностям!\n\n` +
                            `Нажмите /premium, чтобы посмотреть доступные тарифы.`;

            try {
                await bot.telegram.sendMessage(user.id, message);
                await markAsNotified(user.id);
            } catch (e) {
                if (e.response?.error_code === 403) {
                    await updateUserField(user.id, 'active', false);
                } else {
                    console.error(`❌ Ошибка отправки уведомления пользователю ${user.id}:`, e.message);
                }
            }
            await new Promise(resolve => setTimeout(resolve, 300)); // Задержка, чтобы не спамить
        }
        console.log('[Notifier] Ежедневная рассылка уведомлений завершена.');
    } catch (e) {
        console.error('🔴 Критическая ошибка в процессе рассылки уведомлений:', e);
    }
}