/**
 * Получает топ-N самых популярных поисковых запросов за последние 24 часа.
 * @param {number} limit - Количество запросов для получения.
 * @returns {Promise<Array<{query: string, total: number}>>}
 */
export async function getTopRecentSearches(limit = 5) {
    // RPC (Remote Procedure Call) - это вызов функции, которую мы создадим в базе данных
    const { data, error } = await supabase.rpc('get_top_recent_searches', { limit_count: limit });

    if (error) {
        console.error('[DB] Ошибка получения топа недавних запросов:', error.message);
        return [];
    }
    return data;
}
// ... (весь ваш существующий код в db.js) ...

/**
 * Считает количество новых пользователей за указанный период.
 * @param {number} days - Количество дней (например, 1 для суток, 7 для недели).
 * @returns {Promise<number>}
 */
export async function getNewUsersCount(days = 1) {
    const date = new Date();
    date.setDate(date.getDate() - days);

    const { count, error } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', date.toISOString());

    if (error) {
        console.error(`[DB] Ошибка получения количества новых пользователей за ${days} дней:`, error.message);
        return 0;
    }
    return count;
}
export async function getUserActivityByDayHour(days = 30) {
    const { rows } = await query(`
        SELECT TO_CHAR(last_active, 'YYYY-MM-DD') AS day, EXTRACT(HOUR FROM last_active) AS hour, COUNT(*) AS count
        FROM users WHERE last_active >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY day, hour ORDER BY day, hour
    `);
    const activity = {};
    rows.forEach(row => {
        if (!activity[row.day]) activity[row.day] = Array(24).fill(0);
        activity[row.day][parseInt(row.hour, 10)] = parseInt(row.count, 10);
    });
    return activity;
}
// ДОБАВЬТЕ ЭТИ ФУНКЦИИ В КОНЕЦ DB.JS

// Получает информацию о том, кто пригласил данного пользователя
export async function getReferrerInfo(userId) {
    const { data, error } = await supabase
        .from('users')
        .select('referrer_id, referrers:referrer_id (id, first_name)')
        .eq('id', userId)
        .single();
    return error ? null : data.referrers;
}

// Получает список пользователей, приглашенных данным пользователем
export async function getReferredUsers(referrerId) {
    const { data, error } = await supabase
        .from('users')
        .select('id, first_name, created_at')
        .eq('referrer_id', referrerId)
        .order('created_at', { ascending: false });
    return error ? [] : data;
}

// Статистика для дашборда
export async function getReferralStats() {
    // Топ-5 рефоводов
    const { data: topReferrers, error: topError } = await supabase.rpc('get_top_referrers', { limit_count: 5 });
    // Общее число рефералов
    const { count: totalReferred, error: countError } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .not('referrer_id', 'is', null);
        
    return {
        topReferrers: topError ? [] : topReferrers,
        totalReferred: countError ? 0 : totalReferred
    };
}
// db.js

// db.js

// ... (код ваших предыдущих функций, например, getReferralStats)

/**
 * Получает список ID пользователей, которые уже получили данную рассылку.
 * @param {number} taskId - ID задачи рассылки.
 * @returns {Promise<Set<number>>} - Set с ID пользователей.
 */
export async function getAlreadySentUserIds(taskId) {
  const { data, error } = await supabase
    .from('broadcast_log')
    .select('user_id')
    .eq('task_id', taskId);
  
  if (error) {
    console.error(`[DB] Ошибка получения списка отправленных для задачи #${taskId}:`, error);
    return new Set();
  }
  return new Set(data.map(item => item.user_id));
}

/**
 * Записывает в лог факт успешной отправки сообщения пользователю.
 * @param {number} taskId - ID задачи рассылки.
 * @param {number} userId - ID пользователя.
 */
export async function logBroadcastSent(taskId, userId) {
  const { error } = await supabase
    .from('broadcast_log')
    .insert({ task_id: taskId, user_id: userId });
  
  if (error) {
    // Игнорируем ошибку дубликата (unique_violation), остальные логируем
    if (error.code !== '23505') {
      console.error(`[DB] Ошибка записи в лог рассылки для user #${userId}:`, error);
    }
  }
}

/**
 * Находит активную рассылку (в процессе) и помечает ее как прерванную.
 * @returns {Promise<object|null>} Возвращает прерванную задачу или null.
 */
export async function findAndInterruptActiveBroadcast() {
  const { data, error } = await supabase
    .from('broadcast_tasks')
    // =====> ИСПРАВЛЕНИЕ ЗДЕСЬ <=====
    .update({ status: 'interrupted', completed_at: new Date() })
    .eq('status', 'processing')
    .select()
    .single();
  
  if (error && error.code !== 'PGRST116') { // PGRST116 - это "not found", не ошибка
    console.error('[DB] Ошибка при прерывании рассылки:', error);
    return null;
  }
  if (data) {
    console.log(`[DB] Рассылка #${data.id} помечена как прерванная.`);
  }
  return data;
}

/**
 * Сбрасывает статус "зависших" рассылок обратно в 'pending'.
 * Вызывается при старте приложения.
 */
export async function resetStaleBroadcasts() {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  
  const { data, error } = await supabase
    .from('broadcast_tasks')
    .update({ status: 'pending' })
    .eq('status', 'processing')
    .lt('started_at', fiveMinutesAgo);
  
  if (error) {
    console.error('[DB] Ошибка при сбросе зависших рассылок:', error);
  } else if (data && data.length > 0) {
    console.log(`[DB] Сброшено ${data.length} зависших рассылок для перезапуска.`);
  }
}