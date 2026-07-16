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
    applyExpiredPenalties(data);
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

// For each active question past its deadline, any child who hasn't answered
// yet gets a synthetic "expired" answer recording the late penalty — this
// runs on every withDb call so no separate cron job is needed.
function applyExpiredPenalties(db) {
  const nowIso = new Date().toISOString();
  for (const q of db.questions) {
    if (!q.active || !q.dueAt || q.dueAt >= nowIso) continue;
    const targets = q.assignedChildId ? db.children.filter((c) => c.id === q.assignedChildId) : db.children;
    for (const child of targets) {
      const already = db.answers.find((a) => a.questionId === q.id && a.childId === child.id);
      if (already) continue;
      const penalty = Math.max(0, Number(q.latePenalty) || 0);
      db.answers.push({
        id: nextId(db.answers),
        childId: child.id,
        questionId: q.id,
        type: q.type,
        answerIndex: null,
        answerText: '',
        status: 'expired',
        pointsAwarded: -penalty,
        submittedAt: nowIso,
        gradedAt: nowIso
      });
      child.points = Math.max(0, child.points - penalty);
    }
  }
}

module.exports = { withDb, nextId };
