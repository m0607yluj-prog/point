require('dotenv').config();
const express = require('express');
const os = require('os');
const path = require('path');
const { withDb, nextId } = require('./lib/db');

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

app.get('/api/children', ah(async (req, res) => {
  const children = await withDb((db) => db.children);
  res.json(children);
}));

app.post('/api/children', ah(async (req, res) => {
  const { name, avatar } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '名前を入力してください' });
  const child = await withDb((db) => {
    const c = { id: nextId(db.children), name: name.trim(), avatar: avatar || '🙂', points: 0, createdAt: now() };
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
    c.points = Math.max(0, c.points + Number(delta));
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
    subject, unit, difficulty, explanation
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

// Bulk-create text-type questions from a pasted CSV: 教科,単元,難易度,問題,解答,解説
// (header row required; columns matched by name, so order/missing columns are tolerated).
app.post('/api/questions/bulk-csv', ah(async (req, res) => {
  const { csvText, points, dueAt, latePenalty, assignedChildId } = req.body;
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

  const dataRows = rows.slice(1);
  const parsedItems = dataRows
    .map((row) => ({
      question: (row[qIdx] || '').trim(),
      subject: subjectIdx === -1 ? '' : (row[subjectIdx] || '').trim(),
      unit: unitIdx === -1 ? '' : (row[unitIdx] || '').trim(),
      difficulty: difficultyIdx === -1 ? '' : (row[difficultyIdx] || '').trim(),
      correctAnswer: answerIdx === -1 ? '' : (row[answerIdx] || '').trim(),
      explanation: explanationIdx === -1 ? '' : (row[explanationIdx] || '').trim()
    }))
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
        points: Math.max(0, Number(points) || 0),
        dueAt: normalizeDueAt(dueAt),
        latePenalty: Math.max(0, Number(latePenalty) || 0),
        assignedChildId: assignedChildId ? Number(assignedChildId) : null,
        subject: parsed.subject,
        unit: parsed.unit,
        difficulty: parsed.difficulty,
        explanation: parsed.explanation,
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
    if (updates.active !== undefined) item.active = Boolean(updates.active);
    return item;
  });
  if (!q) return res.status(404).json({ error: '見つかりません' });
  res.json(q);
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
    }
    // text type stays 'pending' until parent grades it

    db.answers.push(answer);
    return { answer, child };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

// Parent grades a pending (text) answer
app.patch('/api/answers/:id/grade', ah(async (req, res) => {
  const id = Number(req.params.id);
  const { correct } = req.body;
  const result = await withDb((db) => {
    const answer = db.answers.find((a) => a.id === id);
    if (!answer) return null;
    if (answer.status !== 'pending') return { error: 'この回答はすでに採点済みです' };
    const question = db.questions.find((q) => q.id === answer.questionId);
    const child = db.children.find((c) => c.id === answer.childId);
    answer.status = correct ? 'correct' : 'incorrect';
    answer.gradedAt = now();
    if (question && child) {
      if (correct) {
        answer.pointsAwarded = question.points;
        child.points += question.points;
      } else {
        scheduleRetry(db, question, child.id);
      }
    }
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
  const { childId } = req.query;
  let redemptions = await withDb((db) => db.redemptions);
  if (childId) redemptions = redemptions.filter((r) => r.childId === Number(childId));
  res.json(redemptions);
}));

app.post('/api/redemptions', ah(async (req, res) => {
  const { childId, rewardId } = req.body;
  const result = await withDb((db) => {
    const child = db.children.find((c) => c.id === Number(childId));
    const reward = db.rewards.find((r) => r.id === Number(rewardId));
    if (!child || !reward) return { error: '子どもまたはご褒美が見つかりません' };
    if (!reward.active) return { error: 'このご褒美は現在利用できません' };
    if (reward.stock !== null && reward.stock <= 0) return { error: '在庫がありません' };
    if (child.points < reward.cost) return { error: 'ポイントが足りません' };

    child.points -= reward.cost;
    if (reward.stock !== null) reward.stock -= 1;

    const redemption = {
      id: nextId(db.redemptions),
      childId: child.id,
      rewardId: reward.id,
      rewardName: reward.name,
      cost: reward.cost,
      redeemedAt: now()
    };
    db.redemptions.push(redemption);
    return { redemption, child };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

// ---------- Chores (お手伝い) ----------

app.get('/api/chores', ah(async (req, res) => {
  const { activeOnly } = req.query;
  const chores = await withDb((db) => db.chores);
  const filtered = activeOnly === 'true' ? chores.filter((c) => c.active) : chores;
  res.json(filtered);
}));

app.post('/api/chores', ah(async (req, res) => {
  const { name, type, points, assignedChildId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'お手伝いの名前を入力してください' });
  if (type !== 'routine' && type !== 'adhoc') return res.status(400).json({ error: '種類が不正です' });
  const chore = await withDb((db) => {
    const item = {
      id: nextId(db.chores),
      name: name.trim(),
      type,
      points: Math.max(0, Number(points) || 0),
      assignedChildId: type === 'adhoc' && assignedChildId ? Number(assignedChildId) : null,
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
  const { childId, choreId } = req.body;
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
        (l) => l.choreId === chore.id && l.childId === child.id && l.dateKey === todayKey() && l.status !== 'rejected'
      );
      if (already) return { error: '今日はすでに報告済みです' };
    } else {
      const already = db.choreLogs.find((l) => l.choreId === chore.id && l.status !== 'rejected');
      if (already) return { error: 'このお手伝いはすでに報告されています' };
    }

    const log = {
      id: nextId(db.choreLogs),
      choreId: chore.id,
      choreName: chore.name,
      childId: child.id,
      dateKey: todayKey(),
      status: 'pending',
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
  const { approved } = req.body;
  const result = await withDb((db) => {
    const log = db.choreLogs.find((l) => l.id === id);
    if (!log) return null;
    if (log.status !== 'pending') return { error: 'この報告はすでに処理済みです' };
    const chore = db.chores.find((c) => c.id === log.choreId);
    const child = db.children.find((c) => c.id === log.childId);
    log.status = approved ? 'approved' : 'rejected';
    log.gradedAt = now();
    if (approved && chore && child) {
      log.pointsAwarded = chore.points;
      child.points += chore.points;
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
  console.log('=== きっずポイント ===');
  console.log(`このPCから: http://localhost:${PORT}`);
  addresses.forEach((addr) => console.log(`同じWi-Fi内の他の端末から: http://${addr}:${PORT}`));
  console.log('');
});
