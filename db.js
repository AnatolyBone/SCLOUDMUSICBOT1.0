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
// db.js -- ВСТАВЬ ЭТОТ КОД В САМЫЙ КОНЕЦ ФАЙЛА

/**
 * @description Получает пользователей, у которых премиум-подписка истекает в ближайшие 3 дня.
 * @returns {Promise<Array<{id: number, username: string, first_name: string, premium_until: string}>>}
 */
export async function getExpiringUsers() {
  try {
    const query = `
      SELECT id, username, first_name, premium_until
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