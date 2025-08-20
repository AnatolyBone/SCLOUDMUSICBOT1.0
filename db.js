// db.js (ФИНАЛЬНАЯ ВЕРСЯ СО ВСЕМИ ФУНКЦИЯМИ)

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

export async function getUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function createUser(id, first_name = '', username = '', referral_source = null, referrer_id = null) {
  await query(
    `INSERT INTO users (id, username, first_name, downloads_today, premium_limit, total_downloads, tracks_today, created_at, last_active, referral_source, referrer_id, active)
     VALUES ($1, $2, $3, 0, 5, 0, '[]'::jsonb, NOW(), NOW(), $4, $5, TRUE)
     ON CONFLICT (id) DO NOTHING`,
    [id, username || '', first_name || '', referral_source, referrer_id]
  );
}

export async function getUser(id, first_name = '', username = '') {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  if (rows.length > 0) {
    if (rows[0].active) {
        await query('UPDATE users SET last_active = NOW() WHERE id = $1', [id]);
    }
    return rows[0];
  }
  await createUser(id, first_name, username);
  const newUserResult = await query('SELECT * FROM users WHERE id = $1', [id]);
  return newUserResult.rows[0];
}

const allowedFields = new Set([
  'premium_limit', 'downloads_today', 'total_downloads', 'first_name', 'username',
  'premium_until', 'subscribed_bonus_used', 'tracks_today', 'last_reset_date',
  'active', 'referred_count', 'promo_1plus1_used', 'has_reviewed'
]);

export async function updateUserField(id, field, value) {
  if (!allowedFields.has(field)) {
    throw new Error(`Недопустимое поле для обновления: ${field}`);
  }
  await query(`UPDATE users SET ${field} = $1 WHERE id = $2`, [value, id]);
}

export async function findCachedTrack(trackUrl) {
  try {
    const { data, error } = await supabase.from('track_cache').select('file_id, track_name').eq('url', trackUrl).single();
    if (error && error.code !== 'PGRST116') console.error('Ошибка поиска в кэше Supabase:', error);
    return data ? { fileId: data.file_id, trackName: data.track_name } : null;
  } catch (e) {
    console.error('Критическая ошибка в findCachedTrack:', e);
    return null;
  }
}

export async function cacheTrack(trackUrl, fileId, title) {
  await pool.query(
    'INSERT INTO track_cache (url, file_id, track_name) VALUES ($1, $2, $3) ON CONFLICT (url) DO UPDATE SET file_id = $2, track_name = $3',
    [trackUrl, fileId, title]
  );
}

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

export async function setPremium(id, limit, days = 30) {
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  await updateUserField(id, 'premium_limit', limit);
  await updateUserField(id, 'premium_until', until);
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
  await query(`UPDATE users SET downloads_today = 0, tracks_today = '[]'::jsonb, last_reset_date = CURRENT_DATE`);
}

export async function getAllUsers(includeInactive = true) {
  const sql = includeInactive ? 'SELECT * FROM users ORDER BY created_at DESC' : 'SELECT * FROM users WHERE active = TRUE ORDER BY created_at DESC';
  const { rows } = await query(sql);
  return rows;
}

export async function logDownload(userId, trackTitle, url) { 
  try {
    await supabase.from('downloads_log').insert([{ user_id: userId, track_title: trackTitle, url: url }]);
  } catch (e) {
    console.error(`❌ Критическая ошибка вызова Supabase для logDownload:`, e.message);
  }
}

// ВОССТАНОВЛЕНА ФУНКЦИЯ
export async function logEvent(userId, event) {
  try {
    await supabase.from('events').insert([{ user_id: userId, event_type: event }]);
  } catch (e) {
    console.error(`❌ Критическая ошибка вызова Supabase для logEvent:`, e.message);
  }
}

// ВОССТАНОВЛЕНА ФУНКЦИЯ
export async function getActiveUsersByDate() {
  const { rows } = await query(`SELECT TO_CHAR(last_active, 'YYYY-MM-DD') as date, COUNT(DISTINCT id) as count FROM users WHERE last_active IS NOT NULL GROUP BY date ORDER BY date`);
  return rows.reduce((acc, row) => ({ ...acc, [row.date]: parseInt(row.count, 10) }), {});
}

// ВОССТАНОВЛЕНА ФУНКЦИЯ
export async function getExpiringUsers(days = 3) {
    const { rows } = await query( `SELECT * FROM users WHERE premium_until IS NOT NULL AND premium_until BETWEEN NOW() AND NOW() + INTERVAL '${days} days' ORDER BY premium_until ASC`);
    return rows;
}

export async function getPaginatedUsers(options) {
    const { searchQuery = '', statusFilter = '', page = 1, limit = 25, sortBy = 'created_at', sortOrder = 'desc' } = options;
    const allowedSortFields = ['id', 'total_downloads', 'created_at', 'last_active', 'premium_limit'];
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

export async function getCachedTracksCount() {
  try {
    const { rows } = await query('SELECT COUNT(*) FROM track_cache');
    return parseInt(rows[0].count, 10);
  } catch (e) {
    console.error("Ошибка при подсчете кэшированных треков:", e.message);
    return 0;
  }
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

export async function getActiveFreeUsers() {
  const { rows } = await query(`SELECT id FROM users WHERE active = TRUE AND premium_limit <= 5`);
  return rows;
}

export async function getActivePremiumUsers() {
  const { rows } = await query(`SELECT id FROM users WHERE active = TRUE AND premium_limit > 5`);
  return rows;
}

export async function createBroadcastTask(task) {
  const { message, audioPath, targetAudience, disableNotification, scheduledAt } = task;
  await query(
    `INSERT INTO broadcast_tasks (message, audio_path, target_audience, disable_notification, scheduled_at, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [message, audioPath, targetAudience, disableNotification, scheduledAt]
  );
}

export async function getPendingBroadcastTask() {
  const { rows } = await query(`
    UPDATE broadcast_tasks
    SET status = 'processing'
    WHERE id = (
      SELECT id FROM broadcast_tasks
      WHERE status = 'pending' AND scheduled_at <= NOW()
      ORDER BY scheduled_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `);
  return rows[0] || null;
}

export async function completeBroadcastTask(taskId, report) {
  await query(
    `UPDATE broadcast_tasks SET status = 'completed', report = $1, completed_at = NOW() WHERE id = $2`,
    [report, taskId]
  );
}

export async function failBroadcastTask(taskId, error) {
    await query(`UPDATE broadcast_tasks SET status = 'failed', report = $1 WHERE id = $2`, [{ error }, taskId]);
}

export async function getAllBroadcastTasks() {
  const { rows } = await query(`SELECT * FROM broadcast_tasks ORDER BY scheduled_at DESC`);
  return rows;
}

export async function deleteBroadcastTask(taskId) {
  await query(`DELETE FROM broadcast_tasks WHERE id = $1 AND status = 'pending'`, [taskId]);
}

export async function getBroadcastTaskById(taskId) {
  const { rows } = await query(`SELECT * FROM broadcast_tasks WHERE id = $1`, [taskId]);
  return rows[0] || null;
}

export async function updateBroadcastTask(taskId, task) {
  const { message, audioPath, targetAudience, disableNotification, scheduledAt } = task;
  await query(
    `UPDATE broadcast_tasks 
     SET message = $1, audio_path = $2, target_audience = $3, disable_notification = $4, scheduled_at = $5, status = 'pending'
     WHERE id = $6`,
    [message, audioPath, targetAudience, disableNotification, scheduledAt, taskId]
  );
}

// Эти функции были в вашем старом коде, восстанавливаю их
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

export async function getLatestReviews(limit = 10) {
  const { data } = await supabase.from('reviews').select('*').order('time', { ascending: false }).limit(limit);
  return data || [];
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