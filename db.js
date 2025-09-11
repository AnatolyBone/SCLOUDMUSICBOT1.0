// db.js (ФИНАЛЬНАЯ ПОЛНАЯ ВЕРСИЯ БЕЗ ПРОПУСКОВ И ДУБЛИКАТОВ)

import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, DATABASE_URL } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    console.error('❌ Ошибка запроса к БД:', e.message, { query: text });
    throw e;
  }
}

// --- Пользователи ---
export async function getUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

// db.js

// ЗАМЕНИТЕ ВАШУ createUser НА ЭТУ ВЕРСИЮ
export async function createUser(id, firstName, username, referrerId = null) {
  const sql = `
        INSERT INTO users (id, first_name, username, referrer_id, last_active, last_reset_date)
        VALUES ($1, $2, $3, $4, NOW(), CURRENT_DATE)
        ON CONFLICT (id) DO NOTHING
    `;
  // Мы передаем referrerId (чистый ID или null) напрямую в 4-й параметр
  await query(sql, [id, firstName, username, referrerId]);
}

// db.js

// ЗАМЕНИТЕ ВАШУ getUser НА ЭТУ ВЕРСИЮ
export async function getUser(id, firstName = '', username = '', startPayload = null) {
  // 1. Ищем пользователя (запрос тот же, он правильный)
  const sqlSelect = `
        SELECT 
            *, 
            (SELECT COUNT(*) FROM users AS referrals WHERE referrals.referrer_id = u.id) as referral_count 
        FROM users u WHERE u.id = $1
    `;
  const { rows } = await query(sqlSelect, [id]);
  
  if (rows.length > 0) {
    // 2. Пользователь найден - просто обновляем last_active и возвращаем
    const user = rows[0];
    if (user.active) {
      await query('UPDATE users SET last_active = NOW() WHERE id = $1', [id]);
    }
    return user;
  } else {
    // 3. Пользователь не найден - создаем нового
    
    // ЕДИНОЖДЫ парсим startPayload, чтобы получить referrerId
    let referrerId = null;
    if (startPayload && startPayload.startsWith('ref_')) {
      const parsedId = parseInt(startPayload.split('_')[1], 10);
      // Проверяем, что ID корректный и пользователь не пригласил сам себя
      if (!isNaN(parsedId) && parsedId !== id) {
        referrerId = parsedId;
      }
    }
    
    // Вызываем нашу новую, простую createUser, передавая ей ЧИСТЫЙ referrerId
    await createUser(id, firstName, username, referrerId);
    
    // И возвращаем только что созданного пользователя
    const newUserResult = await query(sqlSelect, [id]);
    return newUserResult.rows[0];
  }
}
const allowedFields = new Set([
  'premium_limit', 'downloads_today', 'total_downloads', 'first_name', 'username',
  'premium_until', 'subscribed_bonus_used', 'tracks_today', 'last_reset_date',
  'active', 'referred_count', 'promo_1plus1_used', 'has_reviewed',
  'notified_about_expiration'
]);

export async function updateUserField(id, updates) {
  const fieldsToUpdate = (typeof updates === 'string')
    ? { [updates]: arguments[2] }
    : updates;

  for (const field in fieldsToUpdate) {
    if (!allowedFields.has(field)) {
      throw new Error(`Недопустимое поле для обновления: ${field}`);
    }
  }

  const { error } = await supabase
    .from('users')
    .update(fieldsToUpdate)
    .eq('id', id);

  if (error) {
    console.error(`[DB] Ошибка при обновлении пользователя ${id}:`, error);
    throw new Error('Не удалось обновить пользователя.');
  }
}

export async function getAllUsers(includeInactive = true) {
  const sql = includeInactive ? 'SELECT * FROM users ORDER BY created_at DESC' : 'SELECT * FROM users WHERE active = TRUE ORDER BY created_at DESC';
  const { rows } = await query(sql);
  return rows;
}

export async function getPaginatedUsers(options) {
    const { searchQuery = '', statusFilter = '', page = 1, limit = 25, sortBy = 'created_at', sortOrder = 'desc' } = options;
    const allowedSortFields = ['id', 'total_downloads', 'created_at', 'last_active', 'premium_limit', 'active'];
    const safeSortBy = allowedSortFields.includes(sortBy) ? `"${sortBy}"` : '"created_at"';
    const safeSortOrder = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const offset = (page - 1) * limit;
    let whereClauses = [];
    let queryParams = [];
    let paramIndex = 1;
    if (statusFilter === 'active') { whereClauses.push('active = TRUE'); } 
    else if (statusFilter === 'inactive') { whereClauses.push('active = FALSE'); }
    if (searchQuery) {
        queryParams.push(`%${searchQuery}%`);
        whereClauses.push(`(CAST(id AS TEXT) ILIKE $${paramIndex} OR first_name ILIKE $${paramIndex} OR username ILIKE $${paramIndex})`);
        paramIndex++;
    }
    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const totalQuery = `SELECT COUNT(*) FROM users ${whereString}`;
    const totalResult = await query(totalQuery, queryParams);
    const totalUsers = parseInt(totalResult.rows[0].count, 10);
    const totalPages = Math.ceil(totalUsers / limit);
    queryParams.push(limit);
    queryParams.push(offset);
    const usersQuery = `SELECT * FROM users ${whereString} ORDER BY ${safeSortBy} ${safeSortOrder} LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    const usersResult = await query(usersQuery, queryParams);
    return { users: usersResult.rows, totalPages, currentPage: page, totalUsers };
}

function escapeCsv(str) {
    if (str === null || str === undefined) return '';
    const s = String(str);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

export async function getUsersAsCsv(options) {
    const { searchQuery = '', statusFilter = '' } = options;
    let whereClauses = [];
    let queryParams = [];
    let paramIndex = 1;
    if (statusFilter === 'active') { whereClauses.push('active = TRUE'); } 
    else if (statusFilter === 'inactive') { whereClauses.push('active = FALSE'); }
    if (searchQuery) {
        queryParams.push(`%${searchQuery}%`);
        whereClauses.push(`(CAST(id AS TEXT) ILIKE $${paramIndex} OR first_name ILIKE $${paramIndex} OR username ILIKE $${paramIndex})`);
    }
    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const { rows } = await query(`SELECT * FROM users ${whereString} ORDER BY created_at DESC`, queryParams);

    const headers = 'ID,FirstName,Username,Status,TotalDownloads,PremiumLimit,PremiumUntil,CreatedAt,LastActive\n';
    const csvRows = rows.map(u => [
        u.id, escapeCsv(u.first_name), escapeCsv(u.username),
        u.active ? 'active' : 'inactive',
        u.total_downloads || 0, u.premium_limit || 0,
        u.premium_until ? new Date(u.premium_until).toISOString() : '',
        new Date(u.created_at).toISOString(),
        u.last_active ? new Date(u.last_active).toISOString() : ''
    ].join(','));

    return headers + csvRows.join('\n');
}

// --- Тарифы и лимиты ---
export async function setPremium(userId, limit, days, addDays = false) {
  const user = await getUser(userId);
  if (!user) return;
  
  let newPremiumUntil;
  const now = new Date();
  
  if (addDays && user.premium_until && new Date(user.premium_until) > now) {
    newPremiumUntil = new Date(user.premium_until);
    newPremiumUntil.setDate(newPremiumUntil.getDate() + days);
  } else {
    newPremiumUntil = new Date();
    newPremiumUntil.setDate(now.getDate() + days);
  }
  
  return updateUserField(userId, {
    premium_limit: limit,
    premium_until: newPremiumUntil.toISOString()
  });
}

export async function resetDailyLimitIfNeeded(userId) {
  const { rows } = await query('SELECT last_reset_date FROM users WHERE id = $1', [userId]);
  if (rows.length > 0) {
      const lastReset = new Date(rows[0].last_reset_date);
      const today = new Date();
      if(lastReset.toDateString() !== today.toDateString()){
          await query(`UPDATE users SET downloads_today = 0, tracks_today = '[]'::jsonb, last_reset_date = CURRENT_DATE WHERE id = $1`, [userId]);
      }
  }
}

export async function resetDailyStats() {
  await query(`UPDATE users SET downloads_today = 0, tracks_today = '[]'::jsonb, last_reset_date = CURRENT_DATE WHERE last_reset_date < CURRENT_DATE`);
}

export async function getExpiringUsers(days = 3) {
    const { rows } = await query( `SELECT * FROM users WHERE premium_until IS NOT NULL AND premium_until BETWEEN NOW() AND NOW() + INTERVAL '${days} days' ORDER BY premium_until ASC`);
    return rows;
}

// --- Кэш треков ---
export async function searchTracksInCache(query, limit = 7) {
  try {
    const { data, error } = await supabase.rpc('search_tracks', { search_query: query, result_limit: limit });
    if (error) {
      console.error('[DB Search] Ошибка при вызове RPC search_tracks:', error);
      return [];
    }
    return data;
  } catch (e) {
    console.error('[DB Search] Критическая ошибка при поиске в кэше:', e);
    return [];
  }
}

export async function cacheTrack(trackData) {
  const { url, fileId, title, artist, duration, thumbnail } = trackData;
  await pool.query(
    `INSERT INTO track_cache (url, file_id, title, artist, duration, thumbnail)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (url) DO UPDATE SET
       file_id = EXCLUDED.file_id, title = EXCLUDED.title, artist = EXCLUDED.artist,
       duration = EXCLUDED.duration, thumbnail = EXCLUDED.thumbnail;`,
    [url, fileId, title, artist, duration, thumbnail]
  );
}

export async function findCachedTrack(trackUrl) {
  try {
    const { data, error } = await supabase.from('track_cache').select('file_id, title').eq('url', trackUrl).single();
    if (error && error.code !== 'PGRST116') console.error('Ошибка поиска в кэше Supabase:', error);
    return data ? { fileId: data.file_id, trackName: data.title } : null;
  } catch (e) {
    console.error('Критическая ошибка в findCachedTrack:', e);
    return null;
  }
}

export async function getCachedTracksCount() {
  try {
    const { rows } = await query('SELECT COUNT(*) FROM track_cache');
    return parseInt(rows[0].count, 10);
  } catch (e) {
    console.error("Ошибка при подсчете кэшированных треков:", e.message);
    return 0;
  }
}

// --- Логирование ---
export async function incrementDownloadsAndSaveTrack(userId, trackName, fileId, url) {
  const newTrack = { title: trackName, fileId: fileId, url: url };
  const res = await query(
    `UPDATE users
     SET downloads_today = downloads_today + 1, total_downloads = total_downloads + 1, tracks_today = COALESCE(tracks_today, '[]'::jsonb) || $1::jsonb
     WHERE id = $2 AND downloads_today < premium_limit
     RETURNING *`,
    [newTrack, userId]
  );
  if (res.rowCount > 0) {
    await logDownload(userId, trackName, url);
  }
  return res.rowCount > 0 ? res.rows[0] : null;
}

export async function logDownload(userId, trackTitle, url) { 
  try {
    await supabase.from('downloads_log').insert([{ user_id: userId, track_title: trackTitle, url: url }]);
  } catch (e) {
    console.error(`❌ Критическая ошибка вызова Supabase для logDownload:`, e.message);
  }
}

export async function logEvent(userId, event) {
  try {
    await supabase.from('events').insert([{ user_id: userId, event_type: event }]);
  } catch (e) {
    console.error(`❌ Критическая ошибка вызова Supabase для logEvent:`, e.message);
  }
}

export async function logUserAction(userId, actionType, details = null) {
  try {
    await supabase.from('user_actions_log').insert([
      { user_id: userId, action_type: actionType, details: details }
    ]);
  } catch (e) {
    console.error(`❌ Ошибка логирования действия для пользователя ${userId}:`, e.message);
  }
}

export async function getUserActions(userId, limit = 20) {
  try {
    const { data, error } = await supabase
      .from('user_actions_log').select('*')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data;
  } catch (e) {
    console.error(`❌ Ошибка получения лога действий для ${userId}:`, e.message);
    return [];
  }
}

// --- Статистика для дашборда ---
export async function getReferralSourcesStats() {
  const { rows } = await query(`SELECT referral_source, COUNT(*) as count FROM users WHERE referral_source IS NOT NULL GROUP BY referral_source ORDER BY count DESC`);
  return rows.map(row => ({ source: row.referral_source, count: parseInt(row.count, 10) }));
}

export async function getRegistrationsByDate() {
  const { rows } = await query(`SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as date, COUNT(*) as count FROM users GROUP BY date ORDER BY date`);
  return rows.reduce((acc, row) => ({ ...acc, [row.date]: parseInt(row.count, 10) }), {});
}

export async function getDownloadsByDate() {
  const { rows } = await query(`SELECT TO_CHAR(downloaded_at, 'YYYY-MM-DD') as date, COUNT(*) as count FROM downloads_log GROUP BY date ORDER BY date`);
  return rows.reduce((acc, row) => ({ ...acc, [row.date]: parseInt(row.count, 10) }), {});
}

export async function getActiveUsersByDate() {
  const { rows } = await query(`SELECT TO_CHAR(last_active, 'YYYY-MM-DD') as date, COUNT(DISTINCT id) as count FROM users WHERE last_active IS NOT NULL GROUP BY date ORDER BY date`);
  return rows.reduce((acc, row) => ({ ...acc, [row.date]: parseInt(row.count, 10) }), {});
}

export async function getDownloadsByUserId(userId, limit = 50) {
  const { rows } = await query(
    `SELECT track_title, downloaded_at FROM downloads_log WHERE user_id = $1 ORDER BY downloaded_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

export async function getReferralsByUserId(userId) {
  const { rows } = await query(
    `SELECT id, first_name, username, created_at FROM users WHERE referrer_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

export async function getUsersCountByTariff() {
  const { rows } = await query(`
    SELECT CASE 
        WHEN premium_limit <= 5 THEN 'Free' WHEN premium_limit = 30 THEN 'Plus'
        WHEN premium_limit = 100 THEN 'Pro' WHEN premium_limit >= 10000 THEN 'Unlimited'
        ELSE 'Other'
      END as tariff, COUNT(id) as count
    FROM users WHERE active = TRUE GROUP BY tariff;
  `);
  const result = { Free: 0, Plus: 0, Pro: 0, Unlimited: 0, Other: 0 };
  rows.forEach(row => { result[row.tariff] = parseInt(row.count); });
  return result;
}

export async function getTopReferralSources(limit = 5) {
  const { rows } = await query(
    `SELECT referral_source, COUNT(id) as count 
     FROM users WHERE referral_source IS NOT NULL AND referral_source != ''
     GROUP BY referral_source ORDER BY count DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getDailyStats(options = {}) {
  const endDate = options.endDate ? new Date(options.endDate) : new Date();
  const startDate = options.startDate ? new Date(options.startDate) : new Date(new Date().setDate(endDate.getDate() - 29));
  const startDateSql = startDate.toISOString().slice(0, 10);
  const endDateSql = endDate.toISOString().slice(0, 10);
  const { rows } = await query(`
    WITH date_series AS ( SELECT generate_series($1::date, $2::date, '1 day')::date AS day ),
    daily_registrations AS ( SELECT created_at::date AS day, COUNT(id) AS registrations FROM users WHERE created_at::date BETWEEN $1 AND $2 GROUP BY created_at::date ),
    daily_activity AS ( SELECT downloaded_at::date AS day, COUNT(id) AS downloads, COUNT(DISTINCT user_id) AS active_users FROM downloads_log WHERE downloaded_at::date BETWEEN $1 AND $2 GROUP BY downloaded_at::date )
    SELECT to_char(ds.day, 'YYYY-MM-DD') as day, COALESCE(dr.registrations, 0)::int AS registrations,
        COALESCE(da.active_users, 0)::int AS active_users, COALESCE(da.downloads, 0)::int AS downloads
    FROM date_series ds LEFT JOIN daily_registrations dr ON ds.day = dr.day
    LEFT JOIN daily_activity da ON ds.day = da.day
    ORDER BY ds.day;
  `, [startDateSql, endDateSql]);
  return rows;
}

export async function getActivityByWeekday() {
  const { rows } = await query(`
    SELECT TO_CHAR(downloaded_at, 'ID') as weekday_num, COUNT(*) as count
    FROM downloads_log WHERE downloaded_at >= NOW() - INTERVAL '90 days'
    GROUP BY 1 ORDER BY 1;
  `);
  const weekdays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
  const result = Array(7).fill(0).map((_, i) => ({ weekday: weekdays[i], count: 0 }));
  rows.forEach(row => { result[parseInt(row.weekday_num) - 1].count = parseInt(row.count); });
  return result;
}

export async function getHourlyActivity(days = 7) {
  const { rows } = await query(
    `SELECT EXTRACT(HOUR FROM downloaded_at AT TIME ZONE 'UTC') as hour, COUNT(*) as count
     FROM downloads_log WHERE downloaded_at >= NOW() - INTERVAL '${days} days'
     GROUP BY hour ORDER BY hour;`
  );
  const hourlyCounts = Array(24).fill(0);
  rows.forEach(row => { hourlyCounts[parseInt(row.hour, 10)] = parseInt(row.count, 10); });
  return hourlyCounts;
}

export async function getTopTracks(limit = 10) {
  const { rows } = await query(
    `SELECT track_title, COUNT(*) as count FROM downloads_log GROUP BY track_title ORDER BY count DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getTopUsers(limit = 15) {
  const { rows } = await query(
    `SELECT id, first_name, username, total_downloads FROM users WHERE total_downloads > 0 ORDER BY total_downloads DESC LIMIT $1`,
    [limit]
  );
  return rows;
}
// Лёгкая агрегирующая статистика для дашборда
// Лёгкая агрегирующая статистика для дашборда
export async function getUsersTotalsSnapshot() {
  const { rows } = await query(`
    SELECT
      COUNT(*)::int AS total_users,
      COUNT(*) FILTER (WHERE active = TRUE)::int AS active_users,
      COALESCE(SUM(total_downloads), 0)::bigint AS total_downloads,
      COUNT(*) FILTER (WHERE last_active::date = CURRENT_DATE)::int AS active_today
    FROM users
  `);
  return rows[0];
}

// Для обратной совместимости: старое имя функции

// (Опционально для лёгкого дашборда — если решишь разгрузить /dashboard)
export async function getDashboardCounters() {
  const { rows } = await query(`
    SELECT
      COUNT(*)::int AS total_users,
      COUNT(*) FILTER (WHERE active)::int AS active_users,
      COALESCE(SUM(total_downloads), 0)::bigint AS total_downloads,
      COUNT(*) FILTER (WHERE last_active::date = CURRENT_DATE)::int AS active_today
    FROM users
  `);
  return rows[0];
}
export async function deleteBroadcastTask(taskId) {
  // Удалять можно только задачи, которые еще не были запущены
  await query(`DELETE FROM broadcast_tasks WHERE id = $1 AND status = 'pending'`, [taskId]);
}

export async function getBroadcastTaskById(taskId) {
  const { rows } = await query(`SELECT * FROM broadcast_tasks WHERE id = $1`, [taskId]);
  return rows[0] || null;
}

export async function createBroadcastTask(taskData) {
  const { message, file_id, file_mime_type, keyboard, disable_web_page_preview, targetAudience, scheduledAt, disableNotification } = taskData;
  const queryText = `
        INSERT INTO broadcast_tasks (
            message, file_id, file_mime_type, keyboard, disable_web_page_preview, 
            target_audience, status, scheduled_at, disable_notification
        ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8) RETURNING *;
    `;
  const values = [
    message, file_id, file_mime_type, keyboard ? JSON.stringify(keyboard) : null,
    disable_web_page_preview, targetAudience, scheduledAt || new Date(), !!disableNotification
  ];
  const result = await query(queryText, values);
  return result.rows[0];
}

export async function updateBroadcastTask(id, taskData) {
  const { message, file_id, file_mime_type, keyboard, disable_web_page_preview, targetAudience, scheduledAt, disableNotification } = taskData;
  const queryText = `
        UPDATE broadcast_tasks SET
            message = $1, file_id = $2, file_mime_type = $3, keyboard = $4, 
            disable_web_page_preview = $5, target_audience = $6, scheduled_at = $7, 
            disable_notification = $8, status = 'pending'
        WHERE id = $9 RETURNING *;
    `;
  const values = [
    message, file_id, file_mime_type, keyboard ? JSON.stringify(keyboard) : null,
    disable_web_page_preview, targetAudience, scheduledAt || new Date(), !!disableNotification, id
  ];
  const result = await query(queryText, values);
  return result.rows[0];
}

export async function getAndStartPendingBroadcastTask() {
  const sql = `
    UPDATE broadcast_tasks SET status = 'processing', started_at = NOW()
    WHERE id = (
      SELECT id FROM broadcast_tasks
      WHERE status = 'pending' AND scheduled_at <= NOW()
      ORDER BY scheduled_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    ) RETURNING *;
  `;
  const { rows } = await query(sql);
  return rows[0] || null;
}

export async function getUsersForBroadcastBatch(broadcastId, audience, limit) {
  let sql = `
  SELECT id, first_name FROM users
  WHERE active = true AND can_receive_broadcasts = TRUE AND id NOT IN (
    SELECT user_id FROM broadcast_log WHERE broadcast_id = $1
  )
`;
  if (audience === 'free_users') {
    sql += ` AND premium_status IS NULL`;
  } else if (audience === 'premium_users') {
    sql += ` AND premium_status IS NOT NULL`;
  }
  sql += ` LIMIT $2;`;
  const { rows } = await query(sql, [broadcastId, limit]);
  return rows;
}

export async function logBroadcastSent(broadcastId, userId) {
  const sql = `
    INSERT INTO broadcast_log (broadcast_id, user_id)
    VALUES ($1, $2)
    ON CONFLICT (broadcast_id, user_id) DO NOTHING;
  `;
  await query(sql, [broadcastId, userId]);
}

export async function getBroadcastProgress(broadcastId, audience) {
  const sentResult = await query(`SELECT COUNT(*) FROM broadcast_log WHERE broadcast_id = $1`, [broadcastId]);
  const sent = parseInt(sentResult.rows[0].count, 10);
  let audienceFilter = 'WHERE active = true';
  if (audience === 'free_users') {
    audienceFilter += ' AND premium_status IS NULL';
  } else if (audience === 'premium_users') {
    audienceFilter += ' AND premium_status IS NOT NULL';
  }
  const totalResult = await query(`SELECT COUNT(*) FROM users ${audienceFilter}`);
  const total = parseInt(totalResult.rows[0].count, 10);
  return { total, sent };
}

export async function updateBroadcastStatus(taskId, status, errorMessage = null) {
  const report = status === 'failed' ? JSON.stringify({ error: errorMessage }) : null;
  const completedAt = status === 'completed' ? 'NOW()' : 'NULL';
  const sql = `
    UPDATE broadcast_tasks SET status = $1, report = COALESCE($2, report), completed_at = ${completedAt}
    WHERE id = $3
  `;
  await query(sql, [status, report, taskId]);
}

export async function findAndInterruptActiveBroadcast() {
  const sql = `
    UPDATE broadcast_tasks SET status = 'pending' WHERE status = 'processing' RETURNING id;
  `;
  const { rows } = await query(sql);
  if (rows.length > 0) {
    console.log(`[Shutdown] Рассылка #${rows[0].id} возвращена в очередь.`);
  }
}

export async function resetStaleBroadcasts() {
  const { data, error } = await supabase
    .from('broadcast_tasks')
    .update({ status: 'pending' })
    .eq('status', 'processing');
  if (error) {
    console.error('[DB] Ошибка при сбросе зависших рассылок:', error);
  } else if (data && data.length > 0) {
    console.log(`[DB] Сброшено ${data.length} зависших рассылок для перезапуска.`);
  }
}

// --- Прочее ---

export async function resetOtherTariffsToFree() {
  console.log('[DB-Admin] Начинаю сброс нестандартных тарифов...');
  const { rowCount } = await query(`
    UPDATE users SET premium_limit = 5, premium_until = NULL WHERE premium_limit NOT IN (5, 30, 100, 10000);
  `);
  console.log(`[DB-Admin] Сброшено ${rowCount} пользователей на тариф Free.`);
  return rowCount;
}

export async function getActiveFreeUsers() {
  const { rows } = await query(`SELECT id FROM users WHERE active = TRUE AND premium_limit <= 5`);
  return rows;
}

export async function getActivePremiumUsers() {
  const { rows } = await query(`SELECT id FROM users WHERE active = TRUE AND premium_limit > 5`);
  return rows;
}

export async function getLatestReviews(limit = 10) {
  const { data } = await supabase.from('reviews').select('*').order('time', { ascending: false }).limit(limit);
  return data || [];
}

export async function logSearchQuery({ query: searchQuery, userId, resultsCount, foundInCache }) {
    if (!searchQuery || !userId) return;
    const { error } = await supabase.from('search_queries').insert({ query: searchQuery, user_id: userId, results_count: resultsCount, found_in_cache: foundInCache });
    if (error) console.error('[DB] Ошибка логирования поискового запроса:', error.message);
}

export async function logFailedSearch({ query: searchQuery, searchType }) {
    if (!searchQuery) return;
    const { error } = await supabase.rpc('increment_failed_search', { p_query: searchQuery, p_search_type: searchType });
    if (error) console.error('[DB] Ошибка логирования неудачного поиска:', error.message);
}

export async function getTopFailedSearches(limit = 5) {
    const { data, error } = await supabase.from('failed_searches').select('query, search_count').order('search_count', { ascending: false }).limit(limit);
    if (error) { console.error('[DB] Ошибка получения топа неудачных запросов:', error.message); return []; }
    return data;
}

export async function getTopRecentSearches(limit = 5) {
    const { data, error } = await supabase.rpc('get_top_recent_searches', { limit_count: limit });
    if (error) { console.error('[DB] Ошибка получения топа недавних запросов:', error.message); return []; }
    return data;
}

export async function getNewUsersCount(days = 1) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    const { count, error } = await supabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', date.toISOString());
    if (error) { console.error(`[DB] Ошибка получения количества новых пользователей за ${days} дней:`, error.message); return 0; }
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

export async function getReferrerInfo(userId) {
    const { data, error } = await supabase.from('users').select('referrer_id, referrers:referrer_id (id, first_name)').eq('id', userId).single();
    return error ? null : data.referrers;
}

export async function getReferredUsers(referrerId) {
    const { data, error } = await supabase.from('users').select('id, first_name, created_at').eq('referrer_id', referrerId).order('created_at', { ascending: false });
    return error ? [] : data;
}

export async function getReferralStats() {
    const { data: topReferrers, error: topError } = await supabase.rpc('get_top_referrers', { limit_count: 5 });
    const { count: totalReferred, error: countError } = await supabase.from('users').select('*', { count: 'exact', head: true }).not('referrer_id', 'is', null);
    return { topReferrers: topError ? [] : topReferrers, totalReferred: countError ? 0 : totalReferred };
}

export async function findUsersToNotify(days = 3) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + days);
    const { data, error } = await supabase.from('users').select('*')
        .lte('premium_until', targetDate.toISOString())
        .gt('premium_until', new Date().toISOString())
        .is('notified_about_expiration', false)
        .eq('active', true);
    if (error) { console.error('[DB] Ошибка поиска пользователей для уведомления:', error); return []; }
    return data || [];
}

export async function markAsNotified(userId) {
    return await updateUserField(userId, 'notified_about_expiration', true);
}
// Быстрая выборка лимитов/активности пользователя
export async function getUserUsage(userId) {
  const { rows } = await query(
    'SELECT id, active, premium_limit, downloads_today, subscribed_bonus_used FROM users WHERE id = $1',
    [userId]
  );
  return rows[0] || null;
}

// Батч-поиск кэша по ключам (url)
export async function findCachedTracks(urls) {
  if (!urls?.length) return new Map();
  const uniq = Array.from(new Set(urls));
  const { rows } = await query(
    'SELECT url, file_id, title FROM track_cache WHERE url = ANY($1)',
    [uniq]
  );
  const map = new Map();
  rows.forEach(r => map.set(r.url, { fileId: r.file_id, trackName: r.title }));
  return map;
}

// Транзакция: инкремент + лог одним запросом (быстрее и атомарно)
export async function incrementDownloadsAndLogPg(userId, trackTitle, fileId, url) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const newTrack = { title: trackTitle, fileId, url };

    const upd = await client.query(
      `UPDATE users
       SET downloads_today = downloads_today + 1,
           total_downloads  = total_downloads + 1,
           tracks_today     = COALESCE(tracks_today, '[]'::jsonb) || $1::jsonb
       WHERE id = $2 AND downloads_today < premium_limit
       RETURNING id`,
      [newTrack, userId]
    );

    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `INSERT INTO downloads_log (user_id, track_title, url) VALUES ($1, $2, $3)`,
      [userId, trackTitle, url]
    );

    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] incrementDownloadsAndLogPg error:', e.message);
    return null;
  } finally {
    client.release();
  }
}