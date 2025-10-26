// db.js (актуальная версия)

import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, DATABASE_URL } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    console.error('❌ Ошибка запроса к БД:', e.message, { query: text });
    throw e;
  }
}
// Сброс дневного лимита для конкретного пользователя, если наступил новый день
export async function resetDailyLimitIfNeeded(userId) {
  // проверяем дату последнего сброса
  const { rows } = await query(
    'SELECT last_reset_date FROM users WHERE id = $1',
    [userId]
  );
  if (!rows.length) return false;

  const lastReset = rows[0].last_reset_date; // может быть null
  // если ещё никогда не сбрасывали или дата < текущей даты — сбрасываем
  if (!lastReset || new Date(lastReset).toDateString() !== new Date().toDateString()) {
    await query(
      `UPDATE users
       SET downloads_today = 0,
           tracks_today = '[]'::jsonb,
           last_reset_date = CURRENT_DATE
       WHERE id = $1`,
      [userId]
    );
    return true;
  }
  return false;
}
/* ========================= Пользователи / Премиум ========================= */
// === Тарифы и лимиты ===

// Админская функция выдачи/продления тарифа
// mode: 'set' — установить заново от NOW(); 'extend' — прибавить дни к текущей дате (если активна) или от NOW()
export async function setTariffAdmin(userId, limit, days, { mode = 'set' } = {}) {
  const sql = `
    UPDATE users
    SET
      premium_limit = $2,
      premium_until = CASE
        WHEN $2 <= 5 THEN NULL
        WHEN $4 = 'extend' THEN
          (CASE
             WHEN premium_until IS NOT NULL AND premium_until > NOW()
               THEN premium_until
             ELSE NOW()
           END) + make_interval(days => $3::int)
        ELSE
          NOW() + make_interval(days => $3::int)
      END,
      -- сбрасываем флаги уведомлений, чтобы в новом периоде снова шли напоминания
      notified_about_expiration = FALSE,
      notified_exp_3d = FALSE,
      notified_exp_1d = FALSE,
      notified_exp_0d = FALSE
    WHERE id = $1
    RETURNING id, premium_limit, premium_until
  `;
  const { rows } = await query(sql, [userId, Number(limit), Number(days), mode]);
  return rows[0];
}

// Обратная совместимость: setPremium (используется бонусами, рефералами и т.д.)
// Всегда продлевает (extend) на days с указанным лимитом.
export async function setPremium(userId, limit, days = 30) {
  return setTariffAdmin(userId, Number(limit), Number(days), { mode: 'extend' });
}
export async function resetExpiredPremiumIfNeeded(userId) {
  const sql = `
    UPDATE users
    SET
      premium_limit = 5,
      premium_until = NULL,
      notified_about_expiration = FALSE,
      notified_exp_3d = FALSE,
      notified_exp_1d = FALSE,
      notified_exp_0d = FALSE
    WHERE id = $1
      AND premium_until IS NOT NULL
      AND premium_until < NOW()
      AND premium_limit <> 5
    RETURNING id
  `;
  try {
    const { rows } = await query(sql, [userId]);
    if (rows?.length) {
      console.log(`[Premium/AutoReset] Пользователь ${userId} понижен до Free (истёк тариф).`);
    }
  } catch (e) {
    console.error('[DB] resetExpiredPremiumIfNeeded error:', e.message);
  }
}

export async function resetExpiredPremiumsBulk() {
  const sql = `
    UPDATE users
    SET
      premium_limit = 5,
      premium_until = NULL,
      notified_about_expiration = FALSE,
      notified_exp_3d = FALSE,
      notified_exp_1d = FALSE,
      notified_exp_0d = FALSE
    WHERE premium_until IS NOT NULL
      AND premium_until < NOW()
      AND premium_limit <> 5
  `;
  try {
    const { rowCount } = await query(sql);
    if (rowCount) console.log(`[Premium/BulkReset] Понижено до Free: ${rowCount}`);
    return rowCount || 0;
  } catch (e) {
    console.error('[DB] resetExpiredPremiumsBulk error:', e.message);
    return 0;
  }
}
// db.js -- ДОБАВЬ ЭТУ ФУНКЦИЮ

/**
 * @description Сбрасывает дневную статистику (загрузки, треки) для всех пользователей.
 *              Вызывается раз в сутки фоновой задачей.
 */
export async function resetDailyStats() {
  console.log('[Cron] Запускаю ежедневный сброс статистики...');
  try {
    const { rowCount } = await pool.query(
      `UPDATE users
       SET downloads_today = 0,
           tracks_today = '[]'::jsonb,
           last_reset_date = CURRENT_DATE
       WHERE last_reset_date < CURRENT_DATE OR last_reset_date IS NULL`
    );
    console.log(`[Cron] Дневная статистика сброшена для ${rowCount} пользователей.`);
  } catch (error) {
    console.error('[Cron] Ошибка при ежедневном сбросе статистики:', error);
  }
}
export async function getReferrerInfo(userId) {
  const { rows } = await query(
    `SELECT r.id, r.first_name, r.username 
     FROM users u 
     JOIN users r ON u.referrer_id = r.id 
     WHERE u.id = $1`,
    [userId]
  );
  return rows[0] || null;
}

export async function getUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function createUser(id, firstName, username, referrerId = null) {
  const sql = `
    INSERT INTO users (id, first_name, username, referrer_id, last_active, last_reset_date)
    VALUES ($1, $2, $3, $4, NOW(), CURRENT_DATE)
    ON CONFLICT (id) DO NOTHING
  `;
  await query(sql, [id, firstName, username, referrerId]);
}

export async function getUser(id, firstName = '', username = '', startPayload = null) {
  const sqlSelect = `
    SELECT 
      *, 
      (SELECT COUNT(*) FROM users AS referrals WHERE referrals.referrer_id = u.id) AS referral_count 
    FROM users u WHERE u.id = $1
  `;
  const { rows } = await query(sqlSelect, [id]);

  if (rows.length > 0) {
    const user = rows[0];

    if (startPayload && startPayload.startsWith('ref_') && !user.referrer_id) {
      const parsedId = parseInt(startPayload.split('_')[1], 10);
      if (!isNaN(parsedId) && parsedId !== id) {
        try {
          await query('UPDATE users SET referrer_id = $1 WHERE id = $2 AND referrer_id IS NULL', [parsedId, id]);
          user.referrer_id = parsedId;
          console.log(`[Referral] Установлен referrer_id=${parsedId} для пользователя ${id}`);
        } catch (e) {
          console.error('[Referral] Ошибка обновления referrer_id:', e.message);
        }
      }
    }

    if (user.active) {
      await query('UPDATE users SET last_active = NOW() WHERE id = $1', [id]);
    }
    return user;
  } else {
    let referrerId = null;
    if (startPayload && startPayload.startsWith('ref_')) {
      const parsedId = parseInt(startPayload.split('_')[1], 10);
      if (!isNaN(parsedId) && parsedId !== id) {
        referrerId = parsedId;
      }
    }
    await createUser(id, firstName, username, referrerId);
    const newUserResult = await query(sqlSelect, [id]);
    return newUserResult.rows[0];
  }
}

/* Поля разрешённые для updateUserField (Supabase update) */
const allowedFields = new Set([
  'premium_limit', 'downloads_today', 'total_downloads', 'first_name', 'username',
  'premium_until', 'subscribed_bonus_used', 'tracks_today', 'last_reset_date',
  'active', 'referred_count', 'promo_1plus1_used', 'has_reviewed',
  'notified_about_expiration',
  'notified_exp_3d', 'notified_exp_1d', 'notified_exp_0d',
  'can_receive_broadcasts'
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
  const sql = includeInactive
    ? 'SELECT * FROM users ORDER BY created_at DESC'
    : 'SELECT * FROM users WHERE active = TRUE ORDER BY created_at DESC';
  const { rows } = await query(sql);
  return rows;
}

export async function getPaginatedUsers(options) {
  let {
    searchQuery = '',
    statusFilter = '',
    page = 1,
    limit = 25,
    sortBy = 'created_at',
    sortOrder = 'desc',

    // расширенные фильтры
    tariff = '',
    premium = '',
    created_from = '',
    created_to = '',
    active_within_days = '',
    has_referrer = '',
    ref_source = '',
    downloads_min = ''
  } = options;

  // сортировку жёстко белимитим
  const allowedSortFields = [
    'id', 'total_downloads', 'created_at', 'last_active',
    'premium_limit', 'premium_until', 'active'
  ];
  const safeSortBy = allowedSortFields.includes(sortBy) ? `"${sortBy}"` : '"created_at"';
  const safeSortOrder = String(sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  page = Math.max(1, parseInt(page, 10) || 1);
  limit = Math.min(500, Math.max(1, parseInt(limit, 10) || 25));
  const offset = (page - 1) * limit;

  const whereClauses = [];
  const params = [];
  let i = 1;

  // статус
  if (statusFilter === 'active') whereClauses.push('active = TRUE');
  else if (statusFilter === 'inactive') whereClauses.push('active = FALSE');

  // поиск
  if (searchQuery) {
    params.push(`%${searchQuery}%`);
    whereClauses.push(`(CAST(id AS TEXT) ILIKE $${i} OR first_name ILIKE $${i} OR username ILIKE $${i})`);
    i++;
  }

  // тариф
  if (tariff) {
    if (tariff === 'Free') whereClauses.push('premium_limit <= 5');
    else if (tariff === 'Plus') whereClauses.push('premium_limit = 30');
    else if (tariff === 'Pro') whereClauses.push('premium_limit = 100');
    else if (tariff === 'Unlimited') whereClauses.push('premium_limit >= 10000');
    else if (tariff === 'Other') {
      whereClauses.push('(premium_limit IS NULL OR (premium_limit NOT IN (5,30,100) AND premium_limit < 10000))');
    }
  }

  // состояние премиума
  if (premium) {
    if (premium === 'active') {
      whereClauses.push('premium_limit > 5 AND (premium_until IS NULL OR premium_until >= NOW())');
    } else if (premium === 'expired') {
      whereClauses.push('premium_limit > 5 AND premium_until IS NOT NULL AND premium_until < NOW()');
    } else if (premium === 'free') {
      whereClauses.push('premium_limit <= 5');
    }
  }

  // даты регистрации
  if (created_from) { params.push(created_from); whereClauses.push(`created_at::date >= $${i++}`); }
  if (created_to)   { params.push(created_to);   whereClauses.push(`created_at::date <= $${i++}`); }

  // активен за N дней
  if (active_within_days) {
    params.push(Number(active_within_days) || 7);
    whereClauses.push(`last_active >= NOW() - ($${i++}::int * INTERVAL '1 day')`);
  }

  // реферер
  if (has_referrer === 'yes') whereClauses.push('referrer_id IS NOT NULL');
  else if (has_referrer === 'no') whereClauses.push('referrer_id IS NULL');

  // источник трафика
  if (ref_source) {
    params.push(`%${ref_source}%`);
    whereClauses.push(`referral_source ILIKE $${i++}`);
  }

  // минимальные скачивания
  if (downloads_min !== '' && downloads_min !== null && downloads_min !== undefined) {
    params.push(Number(downloads_min) || 0);
    whereClauses.push(`total_downloads >= $${i++}`);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // total
  const totalQuery = `SELECT COUNT(*) FROM users ${whereSql}`;
  const totalRes = await query(totalQuery, params);
  const totalUsers = parseInt(totalRes.rows[0].count, 10);
  const totalPages = Math.max(1, Math.ceil(totalUsers / limit));

  // data
  params.push(limit, offset);
  const usersQuery = `
    SELECT id, first_name, username, active,
           premium_limit, premium_until,
           total_downloads, created_at, last_active, referrer_id, referral_source
    FROM users
    ${whereSql}
    ORDER BY ${safeSortBy} ${safeSortOrder}
    LIMIT $${i++} OFFSET $${i++}
  `;
  const usersRes = await query(usersQuery, params);

  return { users: usersRes.rows, totalPages, currentPage: page, totalUsers };
}

export async function getUsersAsCsv(options = {}) {
  let {
    searchQuery = '',
    statusFilter = '',

    // те же расширенные фильтры, что и в списке
    tariff = '',
    premium = '',
    created_from = '',
    created_to = '',
    active_within_days = '',
    has_referrer = '',
    ref_source = '',
    downloads_min = ''
  } = options;

  const whereClauses = [];
  const params = [];
  let i = 1;

  // статус
  if (statusFilter === 'active') whereClauses.push('active = TRUE');
  else if (statusFilter === 'inactive') whereClauses.push('active = FALSE');

  // поиск
  if (searchQuery) {
    params.push(`%${searchQuery}%`);
    whereClauses.push(`(CAST(id AS TEXT) ILIKE $${i} OR first_name ILIKE $${i} OR username ILIKE $${i})`);
    i++;
  }

  // тариф
  if (tariff) {
    if (tariff === 'Free') whereClauses.push('premium_limit <= 5');
    else if (tariff === 'Plus') whereClauses.push('premium_limit = 30');
    else if (tariff === 'Pro') whereClauses.push('premium_limit = 100');
    else if (tariff === 'Unlimited') whereClauses.push('premium_limit >= 10000');
    else if (tariff === 'Other') {
      whereClauses.push('(premium_limit IS NULL OR (premium_limit NOT IN (5,30,100) AND premium_limit < 10000))');
    }
  }

  // состояние премиума
  if (premium) {
    if (premium === 'active') {
      whereClauses.push('premium_limit > 5 AND (premium_until IS NULL OR premium_until >= NOW())');
    } else if (premium === 'expired') {
      whereClauses.push('premium_limit > 5 AND premium_until IS NOT NULL AND premium_until < NOW()');
    } else if (premium === 'free') {
      whereClauses.push('premium_limit <= 5');
    }
  }

  // даты регистрации
  if (created_from) { params.push(created_from); whereClauses.push(`created_at::date >= $${i++}`); }
  if (created_to)   { params.push(created_to);   whereClauses.push(`created_at::date <= $${i++}`); }

  // активность за N дней
  if (active_within_days) {
    params.push(Number(active_within_days) || 7);
    whereClauses.push(`last_active >= NOW() - ($${i++}::int * INTERVAL '1 day')`);
  }

  // реферер
  if (has_referrer === 'yes') whereClauses.push('referrer_id IS NOT NULL');
  else if (has_referrer === 'no') whereClauses.push('referrer_id IS NULL');

  // источник
  if (ref_source) {
    params.push(`%${ref_source}%`);
    whereClauses.push(`referral_source ILIKE $${i++}`);
  }

  // скачивания
  if (downloads_min !== '' && downloads_min !== null && downloads_min !== undefined) {
    params.push(Number(downloads_min) || 0);
    whereClauses.push(`total_downloads >= $${i++}`);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT id, first_name, username, active,
            total_downloads, premium_limit, premium_until,
            created_at, last_active
     FROM users
     ${whereSql}
     ORDER BY created_at DESC`,
    params
  );

  const headers = 'ID,FirstName,Username,Status,TotalDownloads,PremiumLimit,PremiumUntil,CreatedAt,LastActive\n';
  const csvRows = rows.map(u => [
    u.id,
    escapeCsv(u.first_name),
    escapeCsv(u.username),
    u.active ? 'active' : 'inactive',
    u.total_downloads || 0,
    u.premium_limit || 0,
    u.premium_until ? new Date(u.premium_until).toISOString() : '',
    new Date(u.created_at).toISOString(),
    u.last_active ? new Date(u.last_active).toISOString() : ''
  ].join(','));

  return headers + csvRows.join('\n');
}
export async function searchTracksInCache(searchQuery, limit = 7) {
  try {
    const { data, error } = await supabase.rpc('search_tracks', { search_query: searchQuery, result_limit: limit });
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

// ========================================
// СОХРАНЕНИЕ ТРЕКА В КЭШ
// ========================================
/**
 * Сохраняет трек в кэш с поддержкой множественных URL
 */
export async function cacheTrack(trackData) {
  const { url, fileId, title, artist, duration, thumbnail, aliases = [] } = trackData;
  
  try {
    // 1. Сохраняем основную запись
    await query(
      `INSERT INTO track_cache (url, file_id, title, artist, duration, thumbnail)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (url) DO UPDATE SET
         file_id = EXCLUDED.file_id,
         title = EXCLUDED.title,
         artist = EXCLUDED.artist,
         duration = EXCLUDED.duration,
         thumbnail = EXCLUDED.thumbnail,
         created_at = NOW()`,
      [url, fileId, title, artist, duration, thumbnail]
    );
    
    // 2. Сохраняем алиасы (короткие ссылки, sc:ID и т.д.)
    if (aliases.length > 0) {
      for (const alias of aliases) {
        if (alias && alias !== url) {
          await query(
            `INSERT INTO track_url_aliases (canonical_url, alias_url)
             VALUES ($1, $2)
             ON CONFLICT (alias_url) DO UPDATE SET canonical_url = EXCLUDED.canonical_url`,
            [url, alias]
          );
        }
      }
      console.log(`[Cache] Сохранено ${aliases.length} алиасов для: ${title}`);
    }
    
    console.log(`[✓ Cache Saved] ${title} - ${artist}`);
    
  } catch (e) {
    console.error('[✗ Cache Save Error]', e.message, { url, title });
  }
}

export async function findCachedTrack(trackUrl) {
  try {
    // ========================================
    // ✅ ВРЕМЕННАЯ ДИАГНОСТИКА
    // ========================================
    
    // Извлекаем ключевые слова из URL для поиска похожих записей
    const urlParts = trackUrl.split('/').filter(p => p && p.length > 3);
    const lastPart = urlParts[urlParts.length - 1]; // Например: "fallon-diet-coke-extended-mix"
    
    if (lastPart) {
      const debugQuery = `
        SELECT 
          url, 
          LEFT(file_id, 25) as file_id_preview, 
          title, 
          artist,
          duration
        FROM track_cache
        WHERE 
          url ILIKE $1 
          OR title ILIKE $2
        LIMIT 10
      `;
      
      try {
        const { rows: debugRows } = await query(debugQuery, [
          `%${lastPart}%`,
          `%${lastPart.replace(/-/g, ' ')}%`
        ]);
        
        if (debugRows.length > 0) {
          console.log(`[DB/Debug] 🔍 Найдено ${debugRows.length} похожих записей для "${lastPart}":`);
          debugRows.forEach((row, i) => {
            console.log(`  ${i + 1}. URL: ${row.url.substring(0, 60)}...`);
            console.log(`     Title: ${row.title} | Artist: ${row.artist} | Duration: ${row.duration}s`);
          });
        } else {
          console.log(`[DB/Debug] ❌ Похожих записей для "${lastPart}" не найдено в БД`);
        }
      } catch (debugErr) {
        console.warn('[DB/Debug] Ошибка диагностического запроса:', debugErr.message);
      }
    }
    
    // ========================================
    // ОСНОВНОЙ ЗАПРОС
    // ========================================
    const { rows } = await query(
      `SELECT 
        file_id, 
        title, 
        artist, 
        duration 
      FROM track_cache 
      WHERE url = $1 
      LIMIT 1`,
      [trackUrl]
    );
    
    if (rows.length > 0) {
      console.log(`[✓ Cache HIT] ${rows[0].title} (по URL)`);
      return {
        fileId: rows[0].file_id,
        trackName: rows[0].title,
        artist: rows[0].artist,
        duration: rows[0].duration
      };
    }
    
    console.log(`[✗ Cache MISS] Точного совпадения для URL не найдено: ${trackUrl.substring(0, 80)}...`);
    return null;
    
  } catch (e) {
    console.error('[DB Error] findCachedTrack:', e.message);
    return null;
  }
}

// ========================================
// ПОИСК ПО МЕТАДАННЫМ (title, artist, duration)
// ========================================
export async function findCachedTrackByMeta({ title, artist, duration }) {
    try {
        // Проверяем наличие данных
        if (!title || !artist || !duration) {
            console.log('[⚠ Cache] Недостаточно метаданных для поиска');
            return null;
        }
        
        const roundedDuration = Math.round(duration);
        
        // ✅ ИСПРАВЛЕНО: sqlQuery вместо query
        const sqlQuery = `
      SELECT file_id, title, artist, url, duration
      FROM track_cache
      WHERE 
        title ILIKE $1 AND 
        artist ILIKE $2 AND
        duration BETWEEN $3 AND $4
      LIMIT 1
    `;
        
        const { rows } = await query(
            sqlQuery,
            [title, artist, roundedDuration - 2, roundedDuration + 2]
        );
        
        if (rows.length > 0) {
            console.log(`[✓ Cache HIT by Meta] ${rows[0].title} - ${rows[0].artist}`);
            return {
                fileId: rows[0].file_id,
                trackName: rows[0].title,
                artist: rows[0].artist,
                url: rows[0].url
            };
        }
        
        console.log(`[✗ Cache MISS] ${title} - ${artist} (${roundedDuration}s)`);
        return null;
        
    } catch (e) {
        console.error('[DB Error] findCachedTrackByMeta:', e.message);
        return null;
    }
}
export async function getCachedTracksCount() {
  try {
    const { rows } = await query('SELECT COUNT(*) FROM track_cache');
    return parseInt(rows[0].count, 10);
  } catch (e) {
    console.error('Ошибка при подсчете кэшированных треков:', e.message);
    return 0;
  }
}
export async function deleteCachedTrack(url) {
  try {
    await query('DELETE FROM track_cache WHERE url = $1', [url]);
    console.log(`[Cache] Удалён устаревший file_id для: ${url}`);
  } catch (e) {
    console.error('[DB Error] deleteCachedTrack:', e.message);
  }
}
/* ========================= Логирование ========================= */

export async function incrementDownloadsAndSaveTrack(userId, trackName, fileId, url) {
  const newTrack = { title: trackName, fileId, url };
  const res = await query(
    `UPDATE users
     SET downloads_today = downloads_today + 1,
         total_downloads  = total_downloads + 1,
         tracks_today     = COALESCE(tracks_today, '[]'::jsonb) || $1::jsonb
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
    await supabase.from('downloads_log').insert([{ user_id: userId, track_title: trackTitle, url }]);
  } catch (e) {
    console.error('❌ Ошибка Supabase при logDownload:', e.message);
  }
}

export async function logEvent(userId, event) {
  try {
    await supabase.from('events').insert([{ user_id: userId, event_type: event }]);
  } catch (e) {
    console.error('❌ Ошибка Supabase при logEvent:', e.message);
  }
}

export async function logUserAction(userId, actionType, details = null) {
  try {
    await supabase.from('user_actions_log').insert([{ user_id: userId, action_type: actionType, details }]);
  } catch (e) {
    console.error(`❌ Ошибка логирования действия для пользователя ${userId}:`, e.message);
  }
}

export async function getUserActions(userId, limit = 20) {
  try {
    const { data, error } = await supabase
      .from('user_actions_log')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  } catch (e) {
    console.error(`❌ Ошибка получения лога действий для ${userId}:`, e.message);
    return [];
  }
}

/* ========================= Статистика / Дашборд ========================= */

export async function getReferralSourcesStats() {
  const { rows } = await query(
    `SELECT referral_source, COUNT(*) as count
     FROM users
     WHERE referral_source IS NOT NULL
     GROUP BY referral_source
     ORDER BY count DESC`
  );
  return rows.map(row => ({ source: row.referral_source, count: parseInt(row.count, 10) }));
}

export async function getRegistrationsByDate() {
  const { rows } = await query(
    `SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as date, COUNT(*) as count
     FROM users
     GROUP BY date
     ORDER BY date`
  );
  return rows.reduce((acc, row) => ({ ...acc, [row.date]: parseInt(row.count, 10) }), {});
}

export async function getDownloadsByDate() {
  const { rows } = await query(
    `SELECT TO_CHAR(downloaded_at, 'YYYY-MM-DD') as date, COUNT(*) as count
     FROM downloads_log
     GROUP BY date
     ORDER BY date`
  );
  return rows.reduce((acc, row) => ({ ...acc, [row.date]: parseInt(row.count, 10) }), {});
}

export async function getActiveUsersByDate() {
  const { rows } = await query(
    `SELECT TO_CHAR(last_active, 'YYYY-MM-DD') as date, COUNT(DISTINCT id) as count
     FROM users
     WHERE last_active IS NOT NULL
     GROUP BY date
     ORDER BY date`
  );
  return rows.reduce((acc, row) => ({ ...acc, [row.date]: parseInt(row.count, 10) }), {});
}

export async function getDownloadsByUserId(userId, limit = 50) {
  const { rows } = await query(
    `SELECT track_title, downloaded_at
     FROM downloads_log
     WHERE user_id = $1
     ORDER BY downloaded_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

export async function getReferralsByUserId(userId) {
  const { rows } = await query(
    `SELECT id, first_name, username, created_at
     FROM users
     WHERE referrer_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

export async function getUsersCountByTariff() {
  const { rows } = await query(`
    SELECT CASE 
        WHEN premium_limit <= 5 THEN 'Free'
        WHEN premium_limit = 30 THEN 'Plus'
        WHEN premium_limit = 100 THEN 'Pro'
        WHEN premium_limit >= 10000 THEN 'Unlimited'
        ELSE 'Other'
      END as tariff,
      COUNT(id) as count
    FROM users
    WHERE active = TRUE
    GROUP BY tariff
  `);
  const result = { Free: 0, Plus: 0, Pro: 0, Unlimited: 0, Other: 0 };
  rows.forEach(row => { result[row.tariff] = parseInt(row.count, 10); });
  return result;
}

export async function getTopReferralSources(limit = 5) {
  const { rows } = await query(
    `SELECT referral_source, COUNT(id) as count
     FROM users
     WHERE referral_source IS NOT NULL AND referral_source != ''
     GROUP BY referral_source
     ORDER BY count DESC
     LIMIT $1`,
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
    WITH date_series AS (
      SELECT generate_series($1::date, $2::date, '1 day')::date AS day
    ),
    daily_registrations AS (
      SELECT created_at::date AS day, COUNT(id) AS registrations
      FROM users
      WHERE created_at::date BETWEEN $1 AND $2
      GROUP BY created_at::date
    ),
    daily_activity AS (
      SELECT downloaded_at::date AS day, COUNT(id) AS downloads, COUNT(DISTINCT user_id) AS active_users
      FROM downloads_log
      WHERE downloaded_at::date BETWEEN $1 AND $2
      GROUP BY downloaded_at::date
    )
    SELECT to_char(ds.day, 'YYYY-MM-DD') as day,
           COALESCE(dr.registrations, 0)::int AS registrations,
           COALESCE(da.active_users, 0)::int AS active_users,
           COALESCE(da.downloads, 0)::int AS downloads
    FROM date_series ds
    LEFT JOIN daily_registrations dr ON ds.day = dr.day
    LEFT JOIN daily_activity da ON ds.day = da.day
    ORDER BY ds.day
  `, [startDateSql, endDateSql]);
  return rows;
}

export async function getActivityByWeekday() {
  const { rows } = await query(
    `SELECT TO_CHAR(downloaded_at, 'ID') as weekday_num, COUNT(*) as count
     FROM downloads_log
     WHERE downloaded_at >= NOW() - INTERVAL '90 days'
     GROUP BY 1
     ORDER BY 1`
  );
  const weekdays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
  const result = Array(7).fill(0).map((_, i) => ({ weekday: weekdays[i], count: 0 }));
  rows.forEach(row => { result[parseInt(row.weekday_num, 10) - 1].count = parseInt(row.count, 10); });
  return result;
}

export async function getHourlyActivity(days = 7) {
  const { rows } = await query(
    `SELECT EXTRACT(HOUR FROM downloaded_at AT TIME ZONE 'UTC') as hour, COUNT(*) as count
     FROM downloads_log
     WHERE downloaded_at >= NOW() - INTERVAL '${days} days'
     GROUP BY hour
     ORDER BY hour`
  );
  const hourlyCounts = Array(24).fill(0);
  rows.forEach(row => { hourlyCounts[parseInt(row.hour, 10)] = parseInt(row.count, 10); });
  return hourlyCounts;
}

export async function getTopTracks(limit = 10) {
  const { rows } = await query(
    `SELECT track_title, COUNT(*) as count
     FROM downloads_log
     GROUP BY track_title
     ORDER BY count DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getTopUsers(limit = 15) {
  const { rows } = await query(
    `SELECT id, first_name, username, total_downloads
     FROM users
     WHERE total_downloads > 0
     ORDER BY total_downloads DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

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
export { getUsersTotalsSnapshot as getDashboardCounters };

/* ========================= Рассылки ========================= */

export async function deleteBroadcastTask(taskId) {
  await query(`DELETE FROM broadcast_tasks WHERE id = $1 AND status = 'pending'`, [taskId]);
}

export async function getBroadcastTaskById(taskId) {
  const { rows } = await query(`SELECT * FROM broadcast_tasks WHERE id = $1`, [taskId]);
  return rows[0] || null;
}

export async function createBroadcastTask(taskData) {
  const {
    message, file_id, file_mime_type, keyboard,
    disable_web_page_preview, targetAudience, scheduledAt, disableNotification
  } = taskData;
  const queryText = `
    INSERT INTO broadcast_tasks (
      message, file_id, file_mime_type, keyboard,
      disable_web_page_preview, target_audience, status, scheduled_at, disable_notification
    ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
    RETURNING *;
  `;
  const values = [
    message, file_id, file_mime_type, keyboard ? JSON.stringify(keyboard) : null,
    disable_web_page_preview, targetAudience, scheduledAt || new Date(), !!disableNotification
  ];
  const result = await query(queryText, values);
  return result.rows[0];
}

export async function updateBroadcastTask(id, taskData) {
  const {
    message, file_id, file_mime_type, keyboard,
    disable_web_page_preview, targetAudience, scheduledAt, disableNotification
  } = taskData;
  const queryText = `
    UPDATE broadcast_tasks SET
      message = $1,
      file_id = $2,
      file_mime_type = $3,
      keyboard = $4,
      disable_web_page_preview = $5,
      target_audience = $6,
      scheduled_at = $7,
      disable_notification = $8,
      status = 'pending'
    WHERE id = $9
    RETURNING *;
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
    UPDATE broadcast_tasks
    SET status = 'processing', started_at = NOW()
    WHERE id = (
      SELECT id FROM broadcast_tasks
      WHERE status = 'pending' AND scheduled_at <= NOW()
      ORDER BY scheduled_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `;
  const { rows } = await query(sql);
  return rows[0] || null;
}

export async function getUsersForBroadcastBatch(broadcastId, audience, limit) {
  let sql = `
    SELECT id, first_name
    FROM users
    WHERE active = TRUE
      AND can_receive_broadcasts = TRUE
      AND id NOT IN (SELECT user_id FROM broadcast_log WHERE broadcast_id = $1)
  `;
  if (audience === 'free_users') {
    sql += ` AND premium_limit <= 5`;
  } else if (audience === 'premium_users') {
    sql += ` AND premium_limit > 5 AND (premium_until IS NULL OR premium_until >= NOW())`;
  }
  sql += ` LIMIT $2`;
  const { rows } = await query(sql, [broadcastId, limit]);
  return rows;
}

export async function logBroadcastSent(broadcastId, userId) {
  await query(
    `INSERT INTO broadcast_log (broadcast_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (broadcast_id, user_id) DO NOTHING`,
    [broadcastId, userId]
  );
}

export async function getBroadcastProgress(broadcastId, audience) {
  const sentResult = await query(`SELECT COUNT(*) FROM broadcast_log WHERE broadcast_id = $1`, [broadcastId]);
  const sent = parseInt(sentResult.rows[0].count, 10);

  let audienceFilter = 'WHERE active = TRUE';
  if (audience === 'free_users') {
    audienceFilter += ' AND premium_limit <= 5';
  } else if (audience === 'premium_users') {
    audienceFilter += ' AND premium_limit > 5 AND (premium_until IS NULL OR premium_until >= NOW())';
  }

  const totalResult = await query(`SELECT COUNT(*) FROM users ${audienceFilter}`);
  const total = parseInt(totalResult.rows[0].count, 10);
  return { total, sent };
}

export async function updateBroadcastStatus(taskId, status, errorMessage = null) {
  const report = status === 'failed' ? JSON.stringify({ error: errorMessage }) : null;
  const completedAt = status === 'completed' ? 'NOW()' : 'NULL';
  const sql = `
    UPDATE broadcast_tasks
    SET status = $1,
        report = COALESCE($2, report),
        completed_at = ${completedAt}
    WHERE id = $3
  `;
  await query(sql, [status, report, taskId]);
}

export async function findAndInterruptActiveBroadcast() {
  const sql = `
    UPDATE broadcast_tasks
    SET status = 'pending'
    WHERE status = 'processing'
    RETURNING id
  `;
  const { rows } = await query(sql);
  if (rows.length > 0) {
    console.log(`[Shutdown] Рассылка #${rows[0].id} возвращена в очередь.`);
  }
}

export async function getAllBroadcastTasks() {
  const { rows } = await query(`
    SELECT 
      t.*, 
      
      -- Подсчёт уже отправленных сообщений
      (SELECT COUNT(*) FROM broadcast_log WHERE broadcast_id = t.id)::int AS sent_count,
      
      -- Подсчёт всей целевой аудитории (только активные и подписанные на рассылки)
      (
        SELECT COUNT(*) 
        FROM users u 
        WHERE u.active = TRUE AND u.can_receive_broadcasts = TRUE
          AND (
            t.target_audience = 'all_users' OR
            (t.target_audience = 'free_users' AND u.premium_limit <= 5) OR
            (t.target_audience = 'premium_users' AND u.premium_limit > 5 AND (u.premium_until IS NULL OR u.premium_until >= NOW()))
          )
      )::int AS total_count
      
    FROM broadcast_tasks t
    ORDER BY t.scheduled_at DESC
  `);
  
  // Парсим JSON-поле report (если оно есть)
  return rows.map(row => {
    if (typeof row.report === 'string') {
      try {
        row.report = JSON.parse(row.report);
      } catch (e) {
        // Если невалидный JSON, оставляем как есть или обнуляем
        console.warn(`[DB] Не удалось распарсить report для задачи #${row.id}`);
        row.report = { error: row.report };
      }
    }
    return row;
  });
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

/* ========================= Прочее ========================= */

export async function resetOtherTariffsToFree() {
  console.log('[DB-Admin] Начинаю сброс нестандартных тарифов...');
  const sql = `
    UPDATE users
    SET
      premium_limit = 5,
      premium_until = NULL,
      notified_about_expiration = FALSE
    WHERE premium_limit IS NULL
       OR premium_limit NOT IN (5, 30, 100, 10000)
  `;
  const { rowCount } = await query(sql);
  console.log(`[DB-Admin] Сброшено ${rowCount} пользователей на тариф Free.`);
  return rowCount;
}

export async function getActiveFreeUsers() {
  const { rows } = await query(`SELECT id FROM users WHERE active = TRUE AND premium_limit <= 5`);
  return rows;
}

export async function getActivePremiumUsers() {
  const { rows } = await query(
    `SELECT id
     FROM users
     WHERE active = TRUE
       AND premium_limit > 5
       AND (premium_until IS NULL OR premium_until >= NOW())`
  );
  return rows;
}

export async function getLatestReviews(limit = 10) {
  const { data } = await supabase
    .from('reviews')
    .select('*')
    .order('time', { ascending: false })
    .limit(limit);
  return data || [];
}

export async function logSearchQuery({ query: searchQuery, userId, resultsCount, foundInCache }) {
  if (!searchQuery || !userId) return;
  const { error } = await supabase.from('search_queries').insert({
    query: searchQuery,
    user_id: userId,
    results_count: resultsCount,
    found_in_cache: foundInCache
  });
  if (error) console.error('[DB] Ошибка логирования поискового запроса:', error.message);
}

export async function logFailedSearch({ query: searchQuery, searchType }) {
  if (!searchQuery) return;
  const { error } = await supabase.rpc('increment_failed_search', { p_query: searchQuery, p_search_type: searchType });
  if (error) console.error('[DB] Ошибка логирования неудачного поиска:', error.message);
}

export async function getTopFailedSearches(limit = 5) {
  const { data, error } = await supabase
    .from('failed_searches')
    .select('query, search_count')
    .order('search_count', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[DB] Ошибка получения топа неудачных запросов:', error.message);
    return [];
  }
  return data;
}

export async function getTopRecentSearches(limit = 5) {
  const { data, error } = await supabase.rpc('get_top_recent_searches', { limit_count: limit });
  if (error) {
    console.error('[DB] Ошибка получения топа недавних запросов:', error.message);
    return [];
  }
  return data;
}

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
    SELECT TO_CHAR(last_active, 'YYYY-MM-DD') AS day,
           EXTRACT(HOUR FROM last_active) AS hour,
           COUNT(*) AS count
    FROM users
    WHERE last_active >= CURRENT_DATE - INTERVAL '${days} days'
    GROUP BY day, hour
    ORDER BY day, hour
  `);
  const activity = {};
  rows.forEach(row => {
    if (!activity[row.day]) activity[row.day] = Array(24).fill(0);
    activity[row.day][parseInt(row.hour, 10)] = parseInt(row.count, 10);
  });
  return activity;
}

export async function getReferredUsers(referrerId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, first_name, created_at')
    .eq('referrer_id', referrerId)
    .order('created_at', { ascending: false });
  return error ? [] : data;
}

export async function getReferralStats() {
  const { data: topReferrers, error: topError } = await supabase.rpc('get_top_referrers', { limit_count: 5 });
  const { count: totalReferred, error: countError } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .not('referrer_id', 'is', null);
  return {
    topReferrers: topError ? [] : topReferrers,
    totalReferred: countError ? 0 : totalReferred
  };
}

/* ========================= Нотифаер / Уведомления ========================= */

// Ещё один способ (старый): окно N дней вперёд — оставляем для обратной совместимости
export async function findUsersToNotify(days = 3) {
  const now = new Date();
  const nowIso = now.toISOString();
  const targetIso = new Date(now.getTime() + days * 86400000).toISOString();

  const { data, error } = await supabase
    .from('users')
    .select('id, first_name, premium_until, active')
    .gte('premium_until', nowIso)
    .lte('premium_until', targetIso)
    .eq('active', true)
    .or('notified_about_expiration.is.null,notified_about_expiration.eq.false');

  if (error) {
    console.error('[DB] Ошибка поиска пользователей для уведомления:', error);
    return [];
  }
  return data || [];
}

export async function markAsNotified(userId) {
  return updateUserField(userId, 'notified_about_expiration', true);
}

// Ровно N дней вперёд (полуночные окна UTC) — для 3д/1д/0д
export async function findUsersExpiringIn(days, flagField) {
  const allowed = new Set(['notified_exp_3d', 'notified_exp_1d', 'notified_exp_0d']);
  if (!allowed.has(flagField)) {
    throw new Error(`findUsersExpiringIn: invalid flag "${flagField}"`);
  }
  
  const sql = `
    SELECT id, first_name, premium_until
    FROM users
    WHERE active = TRUE
      AND premium_limit <> 5
      AND premium_until IS NOT NULL
      AND premium_until >= date_trunc('day', (NOW() AT TIME ZONE 'UTC')) + make_interval(days => $1::int)
      AND premium_until <  date_trunc('day', (NOW() AT TIME ZONE 'UTC')) + make_interval(days => ($1::int + 1))
      AND COALESCE(${flagField}, FALSE) = FALSE
    ORDER BY premium_until ASC
  `;
  const { rows } = await query(sql, [Number(days) || 0]);
  return rows || [];
}
export async function markStageNotified(userId, flagField) {
  const allowed = new Set(['notified_exp_3d', 'notified_exp_1d', 'notified_exp_0d']);
  if (!allowed.has(flagField)) {
    throw new Error(`markStageNotified: invalid flag "${flagField}"`);
  }
  // Обновляем только если флаг ещё не был выставлен
  const { rowCount } = await query(
    `UPDATE users
     SET ${flagField} = TRUE
     WHERE id = $1 AND COALESCE(${flagField}, FALSE) = FALSE`,
    [userId]
  );
  return rowCount > 0; // true, если реально проставили флаг
}

/* ========================= Вспомогательные ========================= */

export async function getUserUsage(userId) {
  const { rows } = await query(
    `SELECT id, active, premium_limit, downloads_today, subscribed_bonus_used
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return rows[0] || null;
}

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
      `INSERT INTO downloads_log (user_id, track_title, url)
       VALUES ($1, $2, $3)`,
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
// db.js -- ОБНОВЛЕННАЯ ВЕРСИЯ ФУНКЦИИ

/**
 * @description Получает пользователей, у которых премиум-подписка истекает в ближайшие 3 дня.
 * @returns {Promise<Array<{id: number, username: string, first_name: string, premium_until: string, premium_limit: number}>>}
 */
export async function getExpiringUsers() {
  try {
    const query = `
      SELECT id, username, first_name, premium_until, premium_limit
      FROM users
      WHERE premium_until IS NOT NULL
        AND premium_until BETWEEN NOW() AND NOW() + interval '3 days'
      ORDER BY premium_until ASC;
    `;
    const { rows } = await pool.query(query);
    return rows;
  } catch (error) {
    console.error('Ошибка при получении пользователей с истекающей подпиской:', error);
    return []; // Возвращаем пустой массив, чтобы приложение не падало
  }
}

/**
 * Получает все настройки из таблицы app_settings
 */
export async function getAppSettings() {
  const { rows } = await query('SELECT key, value FROM app_settings');
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

/**
 * Обновляет одну настройку
 */
export async function setAppSetting(key, value) {
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}