// db.js
import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, DATABASE_URL } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
export const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    console.error('❌ Ошибка запроса к БД:', e.message);
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

const allowedFields = new Set(['premium_limit', 'downloads_today', 'total_downloads', 'first_name', 'username', 'premium_until', 'tracks_today', 'active']);
export async function updateUserField(id, field, value) {
  if (!allowedFields.has(field)) throw new Error(`Недопустимое поле: ${field}`);
  await query(`UPDATE users SET ${field} = $1 WHERE id = $2`, [value, id]);
}

export async function findCachedTrack(trackUrl) {
  try {
    const { data, error } = await supabase.from('track_cache').select('file_id, track_name').eq('url', trackUrl).single();
    if (error && error.code !== 'PGRST116') console.error('Ошибка поиска в кэше:', error);
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
  const newTrack = JSON.stringify({ title: trackName, fileId });
  const res = await query(
    `UPDATE users SET downloads_today = downloads_today + 1, total_downloads = total_downloads + 1, tracks_today = COALESCE(tracks_today, '[]'::jsonb) || $1::jsonb WHERE id = $2 AND downloads_today < premium_limit RETURNING *`,
    [newTrack, userId]
  );
  if (res.rowCount > 0) await logDownload(userId, trackName, url);
  return res.rowCount > 0 ? res.rows[0] : null;
}

export async function setPremium(id, limit, days = 30) {
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  await updateUserField(id, 'premium_limit', limit);
  await updateUserField(id, 'premium_until', until);
}

export async function resetDailyStats() {
  await query(`UPDATE users SET downloads_today = 0, tracks_today = '[]'::jsonb, last_reset_date = CURRENT_DATE`);
}

export async function getAllUsers(includeInactive = true) {
  const sql = includeInactive ? 'SELECT * FROM users ORDER BY created_at DESC' : 'SELECT * FROM users WHERE active = TRUE ORDER BY created_at DESC';
  const { rows } = await query(sql);
  return rows;
}

export async function getReferralSourcesStats() {
  const { rows } = await query(`SELECT referral_source, COUNT(*) as count FROM users WHERE referral_source IS NOT NULL GROUP BY referral_source ORDER BY count DESC`);
  return rows.map(row => ({ source: row.referral_source, count: parseInt(row.count, 10) }));
}

export async function logDownload(userId, trackTitle, url) { 
  await supabase.from('downloads_log').insert([{ user_id: userId, track_title: trackTitle, url: url }]);
}

export async function logEvent(userId, event) {
  try {
    await supabase.from('events').insert([{ user_id: userId, event_type: event }]);
  } catch (e) { console.error(`❌ Ошибка logEvent:`, e.message); }
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

export async function getLatestReviews(limit = 10) {
  const { data } = await supabase.from('reviews').select('*').order('time', { ascending: false }).limit(limit);
  return data || [];
}

export async function getExpiringUsers(limit = 10, offset = 0) {
  const { rows } = await query( `SELECT * FROM users WHERE premium_until IS NOT NULL AND premium_until BETWEEN NOW() AND NOW() + INTERVAL '3 days' ORDER BY premium_until ASC LIMIT $1 OFFSET $2`, [limit, offset]);
  return rows;
}