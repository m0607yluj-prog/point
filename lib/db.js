const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL が設定されていません。.env ファイルまたは環境変数を設定してください。');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: false }
});

const DEFAULT_DATA = {
  settings: { parentPin: '0000' },
  children: [],
  questions: [],
  answers: [],
  rewards: [],
  redemptions: [],
  chores: [],
  choreLogs: []
};

let initialized = false;

async function ensureInitialized() {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_data (
      id INT PRIMARY KEY,
      data JSONB NOT NULL
    )
  `);
  await pool.query(
    `INSERT INTO app_data (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(DEFAULT_DATA)]
  );
  initialized = true;
}

// Loads the whole document, runs `mutator` synchronously against it, and
// persists the result — all inside one transaction with a row lock so
// concurrent requests (e.g. two redemptions at once) can't race each other.
async function withDb(mutator) {
  await ensureInitialized();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data FROM app_data WHERE id = 1 FOR UPDATE');
    const data = { ...structuredClone(DEFAULT_DATA), ...rows[0].data };
    const result = mutator(data);
    await client.query('UPDATE app_data SET data = $1 WHERE id = 1', [JSON.stringify(data)]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function nextId(items) {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
}

module.exports = { withDb, nextId };
