require('dotenv').config();
const express = require('express');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { withDb, nextId } = require('./lib/db');

function generateToken() {
  return crypto.randomUUID().replace(/-/g, '');
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function now() {
  return new Date().toISOString();
}

function todayKey() {
  return now().slice(0, 10);
}

// Treats full-width digits/letters/punctuation (e.g. "９", common on
// Japanese IMEs) as identical to their half-width form for exact-match
// grading, since that's a keyboard-input quirk, not a different answer.
function normalizeForExactMatch(str) {
  return String(str || '')
    .trim()
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

function normalizeDueAt(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const RETRY_DELAY_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

// When a child answers a question incorrectly, re-issue the same question to
// them personally with a fresh 2-day deadline (same points/penalty/explanation)
// so they get another chance. Grading that copy wrong again schedules yet
// another retry, so this repeats until they get it right.
function scheduleRetry(db, question, childId) {
  const retry = {
    id: nextId(db.questions),
    type: question.type,
    question: question.question,
    choices: question.choices || [],
    correctIndex: question.correctIndex !== undefined ? question.correctIndex : null,
    correctAnswer: question.correctAnswer || '',
    points: question.points,
    dueAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
    latePenalty: question.latePenalty || 0,
    assignedChildId: childId,
    subject: question.subject || '',
    unit: question.unit || '',
    difficulty: question.difficulty || '',
    explanation: question.explanation || '',
    retryOf: question.id,
    active: true,
    createdAt: now()
  };
  db.questions.push(retry);
  return retry;
}

// Strips leading numbering markers (①②…, "1.", "1)", "(1)", "1、" etc.) from
// a pasted line so the numbering used for humans doesn't end up in the question text.
function stripLeadingMarker(line) {
  return line.replace(/^\s*(?:[①-⑳]|\(?\d+\)?[.)、．]?)\s*/, '').trim();
}

// Minimal RFC4180-ish CSV parser: handles quoted fields, escaped quotes ("")
// commas/newlines inside quotes, and CRLF/LF line endings.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Wraps an async route handler so thrown errors become a 500 JSON response
// instead of an unhandled rejection.
function ah(handler) {
  return (req, res) => {
    handler(req, res).catch((err) => {
      console.error(err);
      res.status(500).json({ error: 'サーバーエラーが発生しました' });
    });
  };
}

// ---------- Parent auth (simple PIN gate, not real security) ----------

app.post('/api/auth/parent', ah(async (req, res) => {
  const { pin } = req.body;
  const ok = await withDb((db) => db.settings.parentPin === String(pin));
  res.json({ ok });
}));

app.patch('/api/settings/pin', ah(async (req, res) => {
  const { currentPin, newPin } = req.body;
  const result = await withDb((db) => {
    if (db.settings.parentPin !== String(currentPin)) {
      return { ok: false, error: '現在のPINが違います' };
    }
    if (!newPin || String(newPin).length < 4) {
      return { ok: false, error: '新しいPINは4文字以上にしてください' };
    }
    db.settings.parentPin = String(newPin);
    return { ok: true };
  });
  res.json(result);
}));

// ---------- Children ----------

// Never sent here — this listing is fetched by both parent.html and child.html,
// and child.html must not be able to see (or leak via devtools) siblings' tokens.
app.get('/api/children', ah(async (req, res) => {
  const children = await withDb((db) => {
    db.children.forEach((c) => { if (!c.token) c.token = generateToken(); });
    return db.children;
  });
  res.json(children.map((c) => ({ ...c, token: undefined })));
}));

// Parent-only lookup: fetches one child's dedicated access token on demand,
// so it's never included in the routinely-polled general listing above.
app.get('/api/children/:id/token', ah(async (req, res) => {
  const id = Number(req.params.id);
  const child = await withDb((db) => {
    const c = db.children.find((x) => x.id === id);
    if (c && !c.token) c.token = generateToken();
    return c;
  });
  if (!child) return res.status(404).json({ error: '見つかりません' });
  res.json({ token: child.token });
}));

// Used by child.html's dedicated URL (child.html?token=...) to resolve directly
// to one child's profile without exposing the full children list.
app.get('/api/children/by-token/:token', ah(async (req, res) => {
  const { token } = req.params;
  const child = await withDb((db) => db.children.find((c) => c.token === token));
  if (!child) return res.status(404).json({ error: 'リンクが正しくありません' });
  res.json(child);
}));

app.post('/api/children', ah(async (req, res) => {
  const { name, avatar } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '名前を入力してください' });
  const child = await withDb((db) => {
    const c = {
      id: nextId(db.children), name: name.trim(), avatar: avatar || '🙂', points: 0,
      token: generateToken(), createdAt: now()
    };
    db.children.push(c);
    return c;
  });
  res.json(child);
}));

app.patch('/api/children/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const { name, avatar } = req.body;
  const child = await withDb((db) => {
    const c = db.children.find((x) => x.id === id);
    if (!c) return null;
    if (name && name.trim()) c.name = name.trim();
    if (avatar) c.avatar = avatar;
    return c;
  });
  if (!child) return res.status(404).json({ error: '見つかりません' });
  res.json(child);
}));

app.delete('/api/children/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  await withDb((db) => {
    db.children = db.children.filter((x) => x.id !== id);
  });
  res.json({ ok: true });
}));

// Manual point adjustment by parent (e.g. bonus, correction)
app.post('/api/children/:id/points', ah(async (req, res) => {
  const id = Number(req.params.id);
  const { delta } = req.body;
  const result = await withDb((db) => {
    const c = db.children.find((x) => x.id === id);
    if (!c) return null;
    c.points += Number(delta);
    return c;
  });
  if (!result) return res.status(404).json({ error: '見つかりません' });
  res.json(result);
}));

// ---------- Questions ----------

app.get('/api/questions', ah(async (req, res) => {
  const { activeOnly } = req.query;
  const questions = await withDb((db) => db.questions);
  const filtered = activeOnly === 'true' ? questions.filter((q) => q.active) : questions;
  res.json(filtered);
}));

app.post('/api/questions', ah(async (req, res) => {
  const {
    type, question, choices, correctIndex, correctAnswer, points, dueAt, latePenalty, assignedChildId,
    subject, unit, difficulty, explanation, autoGradeExact
  } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: '問題文を入力してください' });
  if (type !== 'choice' && type !== 'text') return res.status(400).json({ error: '出題形式が不正です' });
  if (type === 'choice') {
    if (!Array.isArray(choices) || choices.length < 2) {
      return res.status(400).json({ error: '選択肢は2つ以上入力してください' });
    }
    if (correctIndex === undefined || correctIndex < 0 || correctIndex >= choices.length) {
      return res.status(400).json({ error: '正解の選択肢を指定してください' });
    }
  }
  const q = await withDb((db) => {
    const item = {
      id: nextId(db.questions),
      type,
      question: question.trim(),
      choices: type === 'choice' ? choices.map((c) => String(c).trim()) : [],
      correctIndex: type === 'choice' ? Number(correctIndex) : null,
      correctAnswer: type === 'text' ? (correctAnswer || '').trim() : '',
      points: Math.max(0, Number(points) || 0),
      dueAt: normalizeDueAt(dueAt),
      latePenalty: Math.max(0, Number(latePenalty) || 0),
      assignedChildId: assignedChildId ? Number(assignedChildId) : null,
      subject: (subject || '').trim(),
      unit: (unit || '').trim(),
      difficulty: (difficulty || '').trim(),
      explanation: (explanation || '').trim(),
      autoGradeExact: type === 'text' && Boolean(autoGradeExact),
      active: true,
      createdAt: now()
    };
    db.questions.push(item);
    return item;
  });
  res.json(q);
}));

// Bulk-create text-type questions from pasted multi-line text, one question
// per non-empty line, sharing the same points/deadline/penalty settings.
app.post('/api/questions/bulk', ah(async (req, res) => {
  const { rawText, points, dueAt, latePenalty, assignedChildId } = req.body;
  if (!rawText || !rawText.trim()) return res.status(400).json({ error: 'テキストを入力してください' });
  const lines = rawText
    .split('\n')
    .map((line) => stripLeadingMarker(line))
    .filter((line) => line.length > 0);
  if (lines.length === 0) return res.status(400).json({ error: '問題文が見つかりませんでした' });

  const created = await withDb((db) => {
    const items = lines.map((line) => {
      const item = {
        id: nextId(db.questions),
        type: 'text',
        question: line,
        choices: [],
        correctIndex: null,
        correctAnswer: '',
        points: Math.max(0, Number(points) || 0),
        dueAt: normalizeDueAt(dueAt),
        latePenalty: Math.max(0, Number(latePenalty) || 0),
        assignedChildId: assignedChildId ? Number(assignedChildId) : null,
        active: true,
        createdAt: now()
      };
      db.questions.push(item);
      return item;
    });
    return items;
  });
  res.json(created);
}));

// Bulk-create text-type questions from a pasted CSV: 教科,単元,難易度,問題,解答,解説,ポイント,期限
// (header row required; columns matched by name, so order/missing columns are tolerated).
// Per-row ポイント falls back to a numeric 難易度 value, then to the shared
// "points" field; per-row 期限 falls back to the shared "dueAt" field.
app.post('/api/questions/bulk-csv', ah(async (req, res) => {
  const { csvText, points, dueAt, latePenalty, assignedChildId, autoGradeExact } = req.body;
  if (!csvText || !csvText.trim()) return res.status(400).json({ error: 'CSVを入力してください' });

  const rows = parseCsv(csvText).filter((row) => row.some((cell) => cell.trim().length > 0));
  if (rows.length < 2) return res.status(400).json({ error: 'ヘッダー行とデータ行が必要です' });

  const header = rows[0].map((h) => h.trim());
  const colIndex = (name) => header.indexOf(name);
  const qIdx = colIndex('問題');
  if (qIdx === -1) return res.status(400).json({ error: 'ヘッダーに「問題」列が見つかりません' });
  const subjectIdx = colIndex('教科');
  const unitIdx = colIndex('単元');
  const difficultyIdx = colIndex('難易度');
  const answerIdx = colIndex('解答');
  const explanationIdx = colIndex('解説');
  const pointsIdx = colIndex('ポイント');
  const dueIdx = colIndex('期限');

  const dataRows = rows.slice(1);
  const parsedItems = dataRows
    .map((row) => {
      const difficultyRaw = difficultyIdx === -1 ? '' : (row[difficultyIdx] || '').trim();
      const pointsRaw = pointsIdx === -1 ? '' : (row[pointsIdx] || '').trim();
      const dueRaw = dueIdx === -1 ? '' : (row[dueIdx] || '').trim();

      let rowPoints;
      if (pointsRaw !== '') {
        rowPoints = Math.max(0, Number(pointsRaw) || 0);
      } else if (difficultyRaw !== '' && !Number.isNaN(Number(difficultyRaw))) {
        rowPoints = Math.max(0, Number(difficultyRaw) || 0);
      } else {
        rowPoints = Math.max(0, Number(points) || 0);
      }

      return {
        question: (row[qIdx] || '').trim(),
        subject: subjectIdx === -1 ? '' : (row[subjectIdx] || '').trim(),
        unit: unitIdx === -1 ? '' : (row[unitIdx] || '').trim(),
        difficulty: difficultyRaw,
        correctAnswer: answerIdx === -1 ? '' : (row[answerIdx] || '').trim(),
        explanation: explanationIdx === -1 ? '' : (row[explanationIdx] || '').trim(),
        points: rowPoints,
        dueAt: dueRaw !== '' ? normalizeDueAt(dueRaw) : normalizeDueAt(dueAt)
      };
    })
    .filter((item) => item.question.length > 0);
  if (parsedItems.length === 0) return res.status(400).json({ error: '問題文が見つかりませんでした' });

  const created = await withDb((db) => {
    return parsedItems.map((parsed) => {
      const item = {
        id: nextId(db.questions),
        type: 'text',
        question: parsed.question,
        choices: [],
        correctIndex: null,
        correctAnswer: parsed.correctAnswer,
        points: parsed.points,
        dueAt: parsed.dueAt,
        latePenalty: Math.max(0, Number(latePenalty) || 0),
        assignedChildId: assignedChildId ? Number(assignedChildId) : null,
        subject: parsed.subject,
        unit: parsed.unit,
        difficulty: parsed.difficulty,
        explanation: parsed.explanation,
        autoGradeExact: Boolean(autoGradeExact),
        active: true,
        createdAt: now()
      };
      db.questions.push(item);
      return item;
    });
  });
  res.json(created);
}));

app.patch('/api/questions/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const updates = req.body;
  const q = await withDb((db) => {
    const item = db.questions.find((x) => x.id === id);
    if (!item) return null;
    if (updates.question !== undefined) item.question = String(updates.question).trim();
    if (updates.choices !== undefined) item.choices = updates.choices.map((c) => String(c).trim());
    if (updates.correctIndex !== undefined) item.correctIndex = Number(updates.correctIndex);
    if (updates.correctAnswer !== undefined) item.correctAnswer = String(updates.correctAnswer).trim();
    if (updates.points !== undefined) item.points = Math.max(0, Number(updates.points) || 0);
    if (updates.dueAt !== undefined) item.dueAt = normalizeDueAt(updates.dueAt);
    if (updates.latePenalty !== undefined) item.latePenalty = Math.max(0, Number(updates.latePenalty) || 0);
    if (updates.assignedChildId !== undefined) {
      item.assignedChildId = updates.assignedChildId ? Number(updates.assignedChildId) : null;
    }
    if (updates.subject !== undefined) item.subject = String(updates.subject).trim();
    if (updates.unit !== undefined) item.unit = String(updates.unit).trim();
    if (updates.difficulty !== undefined) item.difficulty = String(updates.difficulty).trim();
    if (updates.explanation !== undefined) item.explanation = String(updates.explanation).trim();
    if (updates.autoGradeExact !== undefined) item.autoGradeExact = Boolean(updates.autoGradeExact);
    if (updates.active !== undefined) item.active = Boolean(updates.active);
    return item;
  });
  if (!q) return res.status(404).json({ error: '見つかりません' });
  res.json(q);
}));

// Parent extends a question's deadline and clears any already-expired answer
// records for it, so every child who got auto-penalized can try again.
// (Does not refund penalties already applied — see /api/answers/:id/cancel-penalty for that.)
app.patch('/api/questions/:id/extend-deadline', ah(async (req, res) => {
  const id = Number(req.params.id);
  const { dueAt } = req.body;
  const question = await withDb((db) => {
    const item = db.questions.find((x) => x.id === id);
    if (!item) return null;
    item.dueAt = normalizeDueAt(dueAt);
    db.answers = db.answers.filter((a) => !(a.questionId === id && a.status === 'expired'));
    return item;
  });
  if (!question) return res.status(404).json({ error: '見つかりません' });
  res.json(question);
}));

app.delete('/api/questions/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  await withDb((db) => {
    db.questions = db.questions.filter((x) => x.id !== id);
  });
  res.json({ ok: true });
}));

// ---------- Answers ----------

app.get('/api/answers', ah(async (req, res) => {
  const { childId, status } = req.query;
  let answers = await withDb((db) => db.answers);
  if (childId) answers = answers.filter((a) => a.childId === Number(childId));
  if (status) answers = answers.filter((a) => a.status === status);
  res.json(answers);
}));

// Child submits an answer to a question
app.post('/api/answers', ah(async (req, res) => {
  const { childId, questionId, answerIndex, answerText } = req.body;
  const result = await withDb((db) => {
    const child = db.children.find((c) => c.id === Number(childId));
    const question = db.questions.find((q) => q.id === Number(questionId));
    if (!child || !question) return { error: '子どもまたは問題が見つかりません' };

    // Prevent duplicate answers to the same question by the same child
    const already = db.answers.find((a) => a.childId === child.id && a.questionId === question.id);
    if (already) return { error: 'この問題はすでに回答済みです' };

    const answer = {
      id: nextId(db.answers),
      childId: child.id,
      questionId: question.id,
      type: question.type,
      answerIndex: question.type === 'choice' ? Number(answerIndex) : null,
      answerText: question.type === 'text' ? String(answerText || '').trim() : '',
      status: 'pending',
      pointsAwarded: 0,
      submittedAt: now(),
      gradedAt: null
    };

    if (question.type === 'choice') {
      const isCorrect = answer.answerIndex === question.correctIndex;
      answer.status = isCorrect ? 'correct' : 'incorrect';
      answer.gradedAt = now();
      if (isCorrect) {
        answer.pointsAwarded = question.points;
        child.points += question.points;
      } else {
        scheduleRetry(db, question, child.id);
      }
    } else if (question.autoGradeExact && question.correctAnswer &&
      normalizeForExactMatch(answer.answerText) === normalizeForExactMatch(question.correctAnswer)) {
      // Only ever auto-marks correct on an exact match; anything else (including
      // a near-miss) still falls through to manual grading below.
      answer.status = 'correct';
      answer.gradedAt = now();
      answer.pointsAwarded = question.points;
      child.points += question.points;
    }
    // otherwise stays 'pending' until parent grades it

    db.answers.push(answer);
    return { answer, child };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

// Parent grades a pending (text) answer
// Grades a pending answer, or re-grades one that was already graded (to fix
// a mistake) — either way, any previously-awarded points are undone first so
// correcting a grade never double-counts.
app.patch('/api/answers/:id/grade', ah(async (req, res) => {
  const id = Number(req.params.id);
  const { correct } = req.body;
  const result = await withDb((db) => {
    const answer = db.answers.find((a) => a.id === id);
    if (!answer) return null;
    if (answer.status !== 'pending' && answer.status !== 'correct' && answer.status !== 'incorrect') {
      return { error: 'この回答は採点し直せません' };
    }
    const question = db.questions.find((q) => q.id === answer.questionId);
    const child = db.children.find((c) => c.id === answer.childId);
    const previousStatus = answer.status;

    if (previousStatus !== 'pending' && child) {
      child.points -= answer.pointsAwarded;
    }

    answer.status = correct ? 'correct' : 'incorrect';
    answer.gradedAt = now();
    answer.pointsAwarded = 0;

    if (question && child) {
      if (correct) {
        answer.pointsAwarded = question.points;
        child.points += question.points;
        // Correcting incorrect -> correct: drop the retry that was scheduled
        // for the mistake, as long as the child hasn't already done it.
        if (previousStatus === 'incorrect') {
          const retryIdx = db.questions.findIndex((q) =>
            q.retryOf === question.id && q.assignedChildId === child.id &&
            !db.answers.some((a) => a.questionId === q.id && a.childId === child.id)
          );
          if (retryIdx !== -1) db.questions.splice(retryIdx, 1);
        }
      } else if (previousStatus !== 'incorrect') {
        scheduleRetry(db, question, child.id);
      }
    }
    return { answer, child };
  });
  if (!result) return res.status(404).json({ error: '見つかりません' });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

// Parent extends the deadline on an expired answer's question and removes the
// synthetic "expired" record so the child can submit a real answer again.
// (Does not touch the penalty already applied — pair with cancel-penalty for that.)
app.patch('/api/answers/:id/reopen', ah(async (req, res) => {
  const id = Number(req.params.id);
  const { dueAt } = req.body;
  const result = await withDb((db) => {
    const answer = db.answers.find((a) => a.id === id);
    if (!answer) return null;
    if (answer.status !== 'expired') return { error: '期限切れの回答のみ延長できます' };
    const question = db.questions.find((q) => q.id === answer.questionId);
    if (question) question.dueAt = normalizeDueAt(dueAt);
    db.answers = db.answers.filter((a) => a.id !== id);
    return { question };
  });
  if (!result) return res.status(404).json({ error: '見つかりません' });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

// Parent cancels the penalty already applied for an expired answer, refunding
// the deducted points. Leaves the answer record (and question deadline) as is.
app.patch('/api/answers/:id/cancel-penalty', ah(async (req, res) => {
  const id = Number(req.params.id);
  const result = await withDb((db) => {
    const answer = db.answers.find((a) => a.id === id);
    if (!answer) return null;
    if (answer.status !== 'expired') return { error: '期限切れの回答のみ減点を取り消せます' };
    if (answer.pointsAwarded === 0) return { error: 'すでに減点は取り消されています' };
    const child = db.children.find((c) => c.id === answer.childId);
    if (child) child.points -= answer.pointsAwarded;
    answer.pointsAwarded = 0;
    return { answer, child };
  });
  if (!result) return res.status(404).json({ error: '見つかりません' });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

// ---------- Rewards ----------

app.get('/api/rewards', ah(async (req, res) => {
  const rewards = await withDb((db) => db.rewards);
  res.json(rewards);
}));

app.post('/api/rewards', ah(async (req, res) => {
  const { name, cost, stock, emoji } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '名前を入力してください' });
  const reward = await withDb((db) => {
    const r = {
      id: nextId(db.rewards),
      name: name.trim(),
      cost: Math.max(0, Number(cost) || 0),
      stock: stock === '' || stock === undefined || stock === null ? null : Math.max(0, Number(stock)),
      emoji: emoji || '🎁',
      active: true,
      createdAt: now()
    };
    db.rewards.push(r);
    return r;
  });
  res.json(reward);
}));

app.patch('/api/rewards/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const updates = req.body;
  const reward = await withDb((db) => {
    const r = db.rewards.find((x) => x.id === id);
    if (!r) return null;
    if (updates.name !== undefined) r.name = String(updates.name).trim();
    if (updates.cost !== undefined) r.cost = Math.max(0, Number(updates.cost) || 0);
    if (updates.stock !== undefined) r.stock = updates.stock === null || updates.stock === '' ? null : Math.max(0, Number(updates.stock));
    if (updates.emoji !== undefined) r.emoji = updates.emoji;
    if (updates.active !== undefined) r.active = Boolean(updates.active);
    return r;
  });
  if (!reward) return res.status(404).json({ error: '見つかりません' });
  res.json(reward);
}));

app.delete('/api/rewards/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  await withDb((db) => {
    db.rewards = db.rewards.filter((x) => x.id !== id);
  });
  res.json({ ok: true });
}));

// ---------- Redemptions ----------

app.get('/api/redemptions', ah(async (req, res) => {
  const { childId, status } = req.query;
  let redemptions = await withDb((db) => db.redemptions);
  if (childId) redemptions = redemptions.filter((r) => r.childId === Number(childId));
  if (status) redemptions = redemptions.filter((r) => (r.status || 'pending') === status);
  res.json(redemptions);
}));

app.post('/api/redemptions', ah(async (req, res) => {
  const { childId, rewardId, quantity } = req.body;
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  const result = await withDb((db) => {
    const child = db.children.find((c) => c.id === Number(childId));
    const reward = db.rewards.find((r) => r.id === Number(rewardId));
    if (!child || !reward) return { error: '子どもまたはご褒美が見つかりません' };
    if (!reward.active) return { error: 'このご褒美は現在利用できません' };
    if (reward.stock !== null && reward.stock < qty) return { error: '在庫が足りません' };
    const totalCost = reward.cost * qty;
    if (child.points < totalCost) return { error: 'ポイントが足りません' };

    child.points -= totalCost;
    if (reward.stock !== null) reward.stock -= qty;

    const redemption = {
      id: nextId(db.redemptions),
      childId: child.id,
      rewardId: reward.id,
      rewardName: reward.name,
      quantity: qty,
      unitCost: reward.cost,
      cost: totalCost,
      status: 'pending',
      redeemedAt: now(),
      fulfilledAt: null
    };
    db.redemptions.push(redemption);
    return { redemption, child };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

// Parent marks a redemption as fulfilled (e.g. after actually adding the phone time)
app.patch('/api/redemptions/:id/fulfill', ah(async (req, res) => {
  const id = Number(req.params.id);
  const redemption = await withDb((db) => {
    const r = db.redemptions.find((x) => x.id === id);
    if (!r) return null;
    r.status = 'fulfilled';
    r.fulfilledAt = now();
    return r;
  });
  if (!redemption) return res.status(404).json({ error: '見つかりません' });
  res.json(redemption);
}));

// ---------- Chores (お手伝い・勉強タスク・ボーナスタスク) ----------

const CHORE_CATEGORIES = ['household', 'study', 'bonus', 'goal'];
function normalizeCategory(value) {
  return CHORE_CATEGORIES.includes(value) ? value : 'household';
}

// Achievement levels let a chore be graded at multiple tiers (e.g. かんぺき/
// まあまあ/もうすこし) each worth different points, instead of a single
// binary approve/reject. An empty array falls back to the plain `points` field.
function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((l) => ({ label: String(l && l.label || '').trim(), points: Math.max(0, Number(l && l.points) || 0) }))
    .filter((l) => l.label.length > 0);
}

app.get('/api/chores', ah(async (req, res) => {
  const { activeOnly, category } = req.query;
  const chores = await withDb((db) => db.chores);
  let filtered = activeOnly === 'true' ? chores.filter((c) => c.active) : chores;
  if (category) filtered = filtered.filter((c) => (c.category || 'household') === category);
  res.json(filtered);
}));

app.post('/api/chores', ah(async (req, res) => {
  const {
    name, type, points, assignedChildId, category, subject, unit, levels,
    periodDays, targetCount, periodPenalty, dueAt, latePenalty
  } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'お手伝いの名前を入力してください' });
  if (type !== 'routine' && type !== 'adhoc') return res.status(400).json({ error: '種類が不正です' });
  const chore = await withDb((db) => {
    const item = {
      id: nextId(db.chores),
      name: name.trim(),
      type,
      points: Math.max(0, Number(points) || 0),
      assignedChildId: assignedChildId ? Number(assignedChildId) : null,
      category: normalizeCategory(category),
      subject: (subject || '').trim(),
      unit: (unit || '').trim(),
      levels: normalizeLevels(levels),
      periodDays: type === 'routine' ? Math.max(0, Number(periodDays) || 0) : 0,
      targetCount: type === 'routine' ? Math.max(0, Number(targetCount) || 0) : 0,
      periodPenalty: Math.max(0, Number(periodPenalty) || 0),
      dueAt: type === 'adhoc' ? normalizeDueAt(dueAt) : null,
      latePenalty: Math.max(0, Number(latePenalty) || 0),
      active: true,
      createdAt: now()
    };
    db.chores.push(item);
    return item;
  });
  res.json(chore);
}));

app.patch('/api/chores/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const updates = req.body;
  const chore = await withDb((db) => {
    const item = db.chores.find((x) => x.id === id);
    if (!item) return null;
    if (updates.name !== undefined) item.name = String(updates.name).trim();
    if (updates.points !== undefined) item.points = Math.max(0, Number(updates.points) || 0);
    if (updates.assignedChildId !== undefined) {
      item.assignedChildId = updates.assignedChildId ? Number(updates.assignedChildId) : null;
    }
    if (updates.category !== undefined) item.category = normalizeCategory(updates.category);
    if (updates.subject !== undefined) item.subject = String(updates.subject).trim();
    if (updates.unit !== undefined) item.unit = String(updates.unit).trim();
    if (updates.levels !== undefined) item.levels = normalizeLevels(updates.levels);
    if (updates.periodDays !== undefined) item.periodDays = Math.max(0, Number(updates.periodDays) || 0);
    if (updates.targetCount !== undefined) item.targetCount = Math.max(0, Number(updates.targetCount) || 0);
    if (updates.periodPenalty !== undefined) item.periodPenalty = Math.max(0, Number(updates.periodPenalty) || 0);
    if (updates.dueAt !== undefined) item.dueAt = item.type === 'adhoc' ? normalizeDueAt(updates.dueAt) : null;
    if (updates.latePenalty !== undefined) item.latePenalty = Math.max(0, Number(updates.latePenalty) || 0);
    if (updates.active !== undefined) item.active = Boolean(updates.active);
    return item;
  });
  if (!chore) return res.status(404).json({ error: '見つかりません' });
  res.json(chore);
}));

app.delete('/api/chores/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  await withDb((db) => {
    db.chores = db.chores.filter((x) => x.id !== id);
  });
  res.json({ ok: true });
}));

// Bulk-create study-task chores from a pasted CSV: 教科,単元,内容,ポイント
// (header row required; columns matched by name).
app.post('/api/chores/bulk-csv', ah(async (req, res) => {
  const { csvText, assignedChildId, category } = req.body;
  if (!csvText || !csvText.trim()) return res.status(400).json({ error: 'CSVを入力してください' });

  const rows = parseCsv(csvText).filter((row) => row.some((cell) => cell.trim().length > 0));
  if (rows.length < 2) return res.status(400).json({ error: 'ヘッダー行とデータ行が必要です' });

  const header = rows[0].map((h) => h.trim());
  const colIndex = (name) => header.indexOf(name);
  const contentIdx = colIndex('内容');
  if (contentIdx === -1) return res.status(400).json({ error: 'ヘッダーに「内容」列が見つかりません' });
  const subjectIdx = colIndex('教科');
  const unitIdx = colIndex('単元');
  const pointsIdx = colIndex('ポイント');

  const dataRows = rows.slice(1);
  const parsedItems = dataRows
    .map((row) => ({
      name: (row[contentIdx] || '').trim(),
      subject: subjectIdx === -1 ? '' : (row[subjectIdx] || '').trim(),
      unit: unitIdx === -1 ? '' : (row[unitIdx] || '').trim(),
      points: pointsIdx === -1 ? 0 : Math.max(0, Number((row[pointsIdx] || '').trim()) || 0)
    }))
    .filter((item) => item.name.length > 0);
  if (parsedItems.length === 0) return res.status(400).json({ error: '内容が見つかりませんでした' });

  const created = await withDb((db) => {
    return parsedItems.map((parsed) => {
      const item = {
        id: nextId(db.chores),
        name: parsed.name,
        type: 'adhoc',
        points: parsed.points,
        assignedChildId: assignedChildId ? Number(assignedChildId) : null,
        category: category ? normalizeCategory(category) : 'study',
        subject: parsed.subject,
        unit: parsed.unit,
        levels: [],
        active: true,
        createdAt: now()
      };
      db.chores.push(item);
      return item;
    });
  });
  res.json(created);
}));

// ---------- Chore logs (お手伝いの完了報告・承認) ----------

app.get('/api/chore-logs', ah(async (req, res) => {
  const { childId, status } = req.query;
  let logs = await withDb((db) => db.choreLogs);
  if (childId) logs = logs.filter((l) => l.childId === Number(childId));
  if (status) logs = logs.filter((l) => l.status === status);
  res.json(logs);
}));

// Child reports a chore as done (goes to pending until a parent approves it)
app.post('/api/chore-logs', ah(async (req, res) => {
  const { childId, choreId, count } = req.body;
  const reportCount = Math.max(1, Math.min(99, Math.round(Number(count) || 1)));
  const result = await withDb((db) => {
    const child = db.children.find((c) => c.id === Number(childId));
    const chore = db.chores.find((c) => c.id === Number(choreId));
    if (!child || !chore) return { error: '子どもまたはお手伝いが見つかりません' };
    if (!chore.active) return { error: 'このお手伝いは現在受け付けていません' };
    if (chore.type === 'adhoc' && chore.assignedChildId && chore.assignedChildId !== child.id) {
      return { error: 'このお手伝いは他の子どもに割り当てられています' };
    }

    if (chore.type === 'routine') {
      const already = db.choreLogs.find(
        (l) => l.choreId === chore.id && l.childId === child.id && l.dateKey === todayKey() &&
          (l.status === 'pending' || l.status === 'approved')
      );
      if (already) return { error: '今日はすでに報告済みです' };
    } else {
      const already = db.choreLogs.find((l) => l.choreId === chore.id && (l.status === 'pending' || l.status === 'approved' || l.status === 'expired'));
      if (already) return { error: chore.dueAt && chore.dueAt < now() ? '期限が過ぎています' : 'このお手伝いはすでに報告されています' };
    }

    const log = {
      id: nextId(db.choreLogs),
      choreId: chore.id,
      choreName: chore.name,
      childId: child.id,
      dateKey: todayKey(),
      status: 'pending',
      count: reportCount,
      pointsAwarded: 0,
      reportedAt: now(),
      gradedAt: null
    };
    db.choreLogs.push(log);
    return { log };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

// Parent approves or rejects a pending chore report
app.patch('/api/chore-logs/:id/grade', ah(async (req, res) => {
  const id = Number(req.params.id);
  const { approved, levelIndex } = req.body;
  const result = await withDb((db) => {
    const log = db.choreLogs.find((l) => l.id === id);
    if (!log) return null;
    if (log.status !== 'pending') return { error: 'この報告はすでに処理済みです' };
    const chore = db.chores.find((c) => c.id === log.choreId);
    const child = db.children.find((c) => c.id === log.childId);
    log.status = approved ? 'approved' : 'rejected';
    log.gradedAt = now();
    if (approved && chore && child) {
      const count = Math.max(1, Number(log.count) || 1);
      const levels = chore.levels || [];
      if (levels.length > 0) {
        const level = levels[Number(levelIndex)];
        if (!level) return { error: '達成度レベルを指定してください' };
        log.pointsAwarded = level.points * count;
        log.levelLabel = level.label;
        child.points += log.pointsAwarded;
      } else {
        log.pointsAwarded = chore.points * count;
        child.points += log.pointsAwarded;
      }
      if (chore.type === 'adhoc') chore.active = false;
    }
    return { log, child };
  });
  if (!result) return res.status(404).json({ error: '見つかりません' });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

app.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  console.log('');
  console.log('=== ポイント管理 ===');
  console.log(`このPCから: http://localhost:${PORT}`);
  addresses.forEach((addr) => console.log(`同じWi-Fi内の他の端末から: http://${addr}:${PORT}`));
  console.log('');
});
