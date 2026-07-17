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
    applyPeriodicChorePenalties(data);
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

// For each active routine chore with a period/target-count set (e.g. "5 times
// in 7 days"), checks every fully-elapsed period since the chore was created;
// a child who fell short gets a one-time penalty logged for that period. Runs
// on every withDb call — same lazy, cron-free approach as applyExpiredPenalties.
function applyPeriodicChorePenalties(db) {
  const nowMs = Date.now();
  for (const chore of db.chores) {
    if (!chore.active || chore.type !== 'routine') continue;
    const periodDays = Number(chore.periodDays) || 0;
    const targetCount = Number(chore.targetCount) || 0;
    const periodPenalty = Math.max(0, Number(chore.periodPenalty) || 0);
    if (periodDays <= 0 || targetCount <= 0) continue;

    const periodMs = periodDays * 24 * 60 * 60 * 1000;
    const startMs = new Date(chore.createdAt).getTime();
    const elapsedPeriods = Math.floor((nowMs - startMs) / periodMs);
    if (elapsedPeriods <= 0) continue;
    const targets = chore.assignedChildId ? db.children.filter((c) => c.id === chore.assignedChildId) : db.children;

    for (let k = 0; k < elapsedPeriods; k++) {
      const periodStart = startMs + k * periodMs;
      const periodEnd = periodStart + periodMs;
      for (const child of targets) {
        const alreadyMarked = db.choreLogs.some(
          (l) => l.choreId === chore.id && l.childId === child.id && l.status === 'period_penalty' && l.periodIndex === k
        );
        if (alreadyMarked) continue;
        const completedCount = db.choreLogs.filter((l) =>
          l.choreId === chore.id && l.childId === child.id && l.status === 'approved' &&
          new Date(l.gradedAt).getTime() >= periodStart && new Date(l.gradedAt).getTime() < periodEnd
        ).length;
        if (completedCount < targetCount) {
          child.points = Math.max(0, child.points - periodPenalty);
          db.choreLogs.push({
            id: nextId(db.choreLogs),
            choreId: chore.id,
            choreName: chore.name,
            childId: child.id,
            dateKey: new Date(periodEnd).toISOString().slice(0, 10),
            status: 'period_penalty',
            pointsAwarded: -periodPenalty,
            periodIndex: k,
            completedCount,
            targetCount,
            reportedAt: new Date(periodEnd).toISOString(),
            gradedAt: new Date(periodEnd).toISOString()
          });
        }
      }
    }
  }
}

module.exports = { withDb, nextId };
