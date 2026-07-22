let currentChild = null;
let allQuestions = [];
let allAnswers = [];
let allRewards = [];
let allChores = [];
let allChoreLogs = [];

function getTokenFromUrl() {
  return new URLSearchParams(window.location.search).get('token');
}

async function init() {
  const token = getTokenFromUrl() || sessionStorage.getItem('childToken');
  if (!token) {
    showBlocked();
    return;
  }
  try {
    const child = await apiGet(`/api/children/by-token/${encodeURIComponent(token)}`);
    if (!child || child.error || !child.id) {
      showBlocked();
      return;
    }
    sessionStorage.setItem('childToken', token);
    currentChild = child;
    await showMain();
  } catch (e) {
    showBlocked();
  }
}

function showBlocked() {
  document.getElementById('blocked-screen').classList.remove('hidden');
  document.getElementById('locked-out-screen').classList.add('hidden');
  document.getElementById('main-screen').classList.add('hidden');
}

function showLockedOut(points) {
  document.getElementById('blocked-screen').classList.add('hidden');
  document.getElementById('main-screen').classList.add('hidden');
  document.getElementById('locked-out-screen').classList.remove('hidden');
  document.getElementById('locked-points').textContent = `${points} P`;
}

async function showMain() {
  document.getElementById('blocked-screen').classList.add('hidden');
  document.getElementById('my-avatar').textContent = currentChild.avatar;
  document.getElementById('my-name').textContent = currentChild.name;
  await refreshAll();
}

async function refreshAll() {
  const children = await apiGet('/api/children');
  currentChild = children.find((c) => c.id === currentChild.id);

  if (currentChild.points < 0) {
    showLockedOut(currentChild.points);
    return;
  }
  document.getElementById('locked-out-screen').classList.add('hidden');
  document.getElementById('main-screen').classList.remove('hidden');
  document.getElementById('my-points').textContent = `${currentChild.points} P`;

  allQuestions = await apiGet('/api/questions?activeOnly=true');
  allAnswers = await apiGet(`/api/answers?childId=${currentChild.id}`);
  allRewards = await apiGet('/api/rewards');
  allChores = await apiGet('/api/chores');
  allChoreLogs = await apiGet(`/api/chore-logs?childId=${currentChild.id}`);

  renderQuiz();
  renderChores();
  renderResults();
  renderRewards();
}

function showTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
}

function showTaskCategory(cat) {
  document.querySelectorAll('.subtab-btn').forEach((b) => b.classList.toggle('active', b.dataset.taskcat === cat));
  document.querySelectorAll('.task-category-content').forEach((c) => c.classList.add('hidden'));
  document.getElementById(`taskcat-${cat}`).classList.remove('hidden');
}

function populateFilterSelect(id, values, allLabel) {
  const select = document.getElementById(id);
  if (!select) return;
  const current = select.value;
  const distinct = [...new Set(values.filter((v) => v))].sort();
  select.innerHTML = `<option value="">${allLabel}</option>` +
    distinct.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  select.value = distinct.includes(current) ? current : '';
}

function renderQuiz() {
  const answeredIds = new Set(allAnswers.map((a) => a.questionId));
  const eligible = allQuestions.filter((q) =>
    !answeredIds.has(q.id) && (!q.assignedChildId || q.assignedChildId === currentChild.id)
  );

  applyTabUrgency('quiz', eligible);

  populateFilterSelect('quiz-filter-subject', eligible.map((q) => q.subject), '教科: すべて');
  populateFilterSelect('quiz-filter-unit', eligible.map((q) => q.unit), '単元: すべて');
  populateFilterSelect('quiz-filter-difficulty', eligible.map((q) => q.difficulty), '難易度: すべて');

  const subjectFilter = document.getElementById('quiz-filter-subject').value;
  const unitFilter = document.getElementById('quiz-filter-unit').value;
  const difficultyFilter = document.getElementById('quiz-filter-difficulty').value;
  const dueFilter = document.getElementById('quiz-filter-due').value;

  const unanswered = eligible.filter((q) => {
    if (subjectFilter && q.subject !== subjectFilter) return false;
    if (unitFilter && q.unit !== unitFilter) return false;
    if (difficultyFilter && q.difficulty !== difficultyFilter) return false;
    if (dueFilter === 'has' && !q.dueAt) return false;
    if (dueFilter === 'none' && q.dueAt) return false;
    return true;
  });

  const container = document.getElementById('quiz-list');

  if (unanswered.length === 0) {
    container.innerHTML = '<div class="card"><p class="muted">今は問題がないよ。あとでまた見てね！</p></div>';
    return;
  }

  container.innerHTML = unanswered.map((q) => {
    const dueLabel = q.dueAt
      ? `<div class="muted">期限: ${new Date(q.dueAt).toLocaleString('ja-JP')}${q.latePenalty > 0 ? ` (すぎると-${q.latePenalty}P)` : ''}</div>`
      : '';
    if (q.type === 'choice') {
      const options = q.choices.map((c, i) => `
        <label class="choice-option">
          <input type="radio" name="q${q.id}" value="${i}" onclick="markSelected(${q.id}, ${i})" />
          ${escapeHtml(c)}
        </label>
      `).join('');
      return `
        <div class="card" id="qcard-${q.id}">
          <div class="row-between"><h3>${escapeHtml(q.question)}</h3><span class="muted">${q.points}P</span></div>
          ${dueLabel}
          ${options}
          <button class="btn green" onclick="submitChoice(${q.id})">答える</button>
        </div>
      `;
    } else {
      return `
        <div class="card" id="qcard-${q.id}">
          <div class="row-between"><h3>${escapeHtml(q.question)}</h3><span class="muted">${q.points}P</span></div>
          ${dueLabel}
          <textarea rows="3" id="text-${q.id}" placeholder="答えを書いてね"></textarea>
          <button class="btn green" onclick="submitText(${q.id})">答える</button>
        </div>
      `;
    }
  }).join('');
}

function markSelected(qid, index) {
  const card = document.getElementById(`qcard-${qid}`);
  card.querySelectorAll('.choice-option').forEach((el, i) => el.classList.toggle('selected', i === index));
}

async function submitChoice(qid) {
  const card = document.getElementById(`qcard-${qid}`);
  const checked = card.querySelector('input[type=radio]:checked');
  if (!checked) { showToast('答えを選んでね'); return; }
  await submitAnswer(qid, { answerIndex: Number(checked.value) });
}

async function submitText(qid) {
  const text = document.getElementById(`text-${qid}`).value.trim();
  if (!text) { showToast('答えを書いてね'); return; }
  await submitAnswer(qid, { answerText: text });
}

async function submitAnswer(qid, payload) {
  try {
    const result = await apiPost('/api/answers', { childId: currentChild.id, questionId: qid, ...payload });
    if (result.answer.status === 'correct') {
      showToast(`正解！ +${result.answer.pointsAwarded}P 🎉`);
    } else if (result.answer.status === 'incorrect') {
      showToast('残念、間違いだよ');
    } else {
      showToast('答えを送ったよ。保護者が採点するまで待っててね');
    }
    await refreshAll();
  } catch (e) {
    showToast(e.message);
  }
}

function renderChores() {
  renderChoreCategory('household', 'routine-chore-list', 'adhoc-chore-list', 'chore-history',
    'いつでもできるお手伝いはまだないよ。', '今は依頼されたお手伝いはないよ。', 'まだお手伝いをしていないよ。');
  renderChoreCategory('study', 'study-routine-list', 'study-adhoc-list', 'study-history',
    'いつでもできる勉強タスクはまだないよ。', '今は勉強タスクはないよ。', 'まだ勉強をしていないよ。');
  renderChoreCategory('bonus', 'bonus-routine-list', 'bonus-adhoc-list', 'bonus-history',
    'いつでもできるボーナスはまだないよ。', '今はボーナスタスクはないよ。', 'まだボーナスはないよ。');
  renderChoreCategory('goal', 'goal-routine-list', 'goal-adhoc-list', 'goal-history',
    'いつでもできる目標はまだないよ。', '今は目標タスクはないよ。', 'まだ目標に取り組んでいないよ。');
}

function renderChoreCategory(category, routineElId, adhocElId, historyElId, routineEmptyMsg, adhocEmptyMsg, historyEmptyMsg) {
  const todayKeyClient = new Date().toISOString().slice(0, 10);
  const categoryChores = allChores.filter((c) => (c.category || 'household') === category);
  const activeChores = categoryChores.filter((c) => c.active);

  const routine = activeChores.filter((c) => c.type === 'routine');
  const routineEl = document.getElementById(routineElId);
  if (routine.length === 0) {
    routineEl.innerHTML = `<p class="muted">${routineEmptyMsg}</p>`;
  } else {
    routineEl.innerHTML = routine.map((c) => {
      const log = allChoreLogs.find((l) => l.choreId === c.id && l.dateKey === todayKeyClient && l.status !== 'rejected');
      return renderChoreRow(c, log, category);
    }).join('');
  }

  const adhoc = activeChores.filter((c) => c.type === 'adhoc' && (!c.assignedChildId || c.assignedChildId === currentChild.id));
  const adhocEl = document.getElementById(adhocElId);
  if (adhoc.length === 0) {
    adhocEl.innerHTML = `<p class="muted">${adhocEmptyMsg}</p>`;
  } else {
    adhocEl.innerHTML = adhoc.map((c) => {
      const log = allChoreLogs.find((l) => l.choreId === c.id && l.status !== 'rejected');
      return renderChoreRow(c, log, category);
    }).join('');
  }

  const categoryChoreIds = new Set(categoryChores.map((c) => c.id));
  const relevantLogs = allChoreLogs.filter((l) => categoryChoreIds.has(l.choreId));
  const historyEl = document.getElementById(historyElId);
  if (relevantLogs.length === 0) {
    historyEl.innerHTML = `<p class="muted">${historyEmptyMsg}</p>`;
  } else {
    const sorted = [...relevantLogs].sort((a, b) => new Date(b.reportedAt) - new Date(a.reportedAt));
    historyEl.innerHTML = sorted.map((l) => {
      const countLabel = l.count > 1 ? `${l.count}回分 ` : '';
      const statusLabel = l.status === 'pending' ? '承認待ち'
        : l.status === 'approved' ? `${countLabel}${l.levelLabel || '完了'}`
        : l.status === 'period_penalty' ? `目標未達成 (${l.completedCount}/${l.targetCount}回)`
        : l.status === 'expired' ? '期限切れ'
        : 'やり直し';
      const badgeClass = l.status === 'pending' ? 'pending'
        : l.status === 'approved' ? 'correct'
        : (l.status === 'period_penalty' || l.status === 'expired') ? 'expired'
        : 'incorrect';
      return `
        <div class="list-item row-between">
          <span>${escapeHtml(l.choreName)}</span>
          <span class="badge ${badgeClass}">${escapeHtml(statusLabel)}${l.pointsAwarded ? ` ${l.pointsAwarded > 0 ? '+' : ''}${l.pointsAwarded}P` : ''}</span>
        </div>
      `;
    }).join('');
  }
}

function computePeriodProgress(chore) {
  const periodDays = Number(chore.periodDays) || 0;
  const targetCount = Number(chore.targetCount) || 0;
  if (periodDays <= 0 || targetCount <= 0) return null;
  const periodMs = periodDays * 24 * 60 * 60 * 1000;
  const startMs = new Date(chore.createdAt).getTime();
  const nowMs = Date.now();
  const currentPeriodIndex = Math.floor((nowMs - startMs) / periodMs);
  const periodStart = startMs + currentPeriodIndex * periodMs;
  const periodEnd = periodStart + periodMs;
  const completedCount = allChoreLogs
    .filter((l) =>
      l.choreId === chore.id && l.status === 'approved' &&
      new Date(l.gradedAt).getTime() >= periodStart && new Date(l.gradedAt).getTime() < periodEnd
    )
    .reduce((sum, l) => sum + Math.max(1, Number(l.count) || 1), 0);
  const daysLeft = Math.max(0, Math.ceil((periodEnd - nowMs) / (24 * 60 * 60 * 1000)));
  return { completedCount, targetCount, daysLeft };
}

function renderChoreRow(chore, log, category) {
  let statusHtml;
  if (log && log.status === 'pending') {
    const countLabel = log.count > 1 ? `${log.count}回分 ` : '';
    statusHtml = `<span class="badge pending">${countLabel}承認待ち</span>`;
  } else if (log && log.status === 'approved') {
    const countLabel = log.count > 1 ? `${log.count}回分 ` : '';
    statusHtml = `<span class="badge correct">${countLabel}${escapeHtml(log.levelLabel || '完了！')}</span>`;
  } else if (log && log.status === 'expired') {
    statusHtml = '<span class="badge expired">期限切れ</span>';
  } else if (category === 'study') {
    statusHtml = `
      <span class="btn-row" style="gap:4px;">
        <input type="number" id="study-count-${chore.id}" value="1" min="1" max="99" style="width:56px;" />
        <button class="btn green small" onclick="reportChore(${chore.id}, document.getElementById('study-count-${chore.id}').value)">やった！</button>
      </span>
    `;
  } else {
    statusHtml = `<button class="btn green small" onclick="reportChore(${chore.id})">やった！</button>`;
  }
  const pointsLabel = (chore.levels && chore.levels.length > 0)
    ? chore.levels.map((l) => `${escapeHtml(l.label)}${l.points}P`).join(' / ')
    : `${chore.points}P`;
  const progress = computePeriodProgress(chore);
  const progressLabel = progress
    ? `<div class="muted">今の期間: ${progress.completedCount}/${progress.targetCount}回（あと${progress.daysLeft}日）</div>`
    : '';
  const dueLabel = chore.dueAt ? `<div class="muted">期限: ${new Date(chore.dueAt).toLocaleString('ja-JP')}</div>` : '';
  return `
    <div class="list-item">
      <div class="row-between">
        <span>${escapeHtml(chore.name)} <span class="muted">${pointsLabel}</span></span>
        ${statusHtml}
      </div>
      ${progressLabel}
      ${dueLabel}
    </div>
  `;
}

async function reportChore(choreId, count) {
  const reportCount = Math.max(1, Math.min(99, Number(count) || 1));
  try {
    await apiPost('/api/chore-logs', { childId: currentChild.id, choreId, count: reportCount });
    showToast(reportCount > 1 ? `${reportCount}回分報告したよ！保護者の確認を待っててね` : '報告したよ！保護者の確認を待っててね');
    await refreshAll();
  } catch (e) {
    showToast(e.message);
  }
}

function renderResults() {
  const container = document.getElementById('results-list');
  if (allAnswers.length === 0) {
    container.innerHTML = '<p class="muted">まだ答えていないよ。</p>';
    return;
  }
  const sorted = [...allAnswers].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  container.innerHTML = sorted.map((a) => {
    const q = allQuestions.find((x) => x.id === a.questionId) || { question: '(削除された問題)' };
    const statusLabel = a.status === 'pending' ? '採点中'
      : a.status === 'correct' ? '正解'
      : a.status === 'expired' ? '期限切れ'
      : '間違い';
    const showExplanation = a.status !== 'pending' && q.explanation;
    return `
      <div class="list-item">
        <div class="row-between">
          <span>${escapeHtml(q.question)}</span>
          <span class="badge ${a.status}">${statusLabel}</span>
        </div>
        <div class="muted">${a.pointsAwarded !== 0 ? `${a.pointsAwarded > 0 ? '+' : ''}${a.pointsAwarded}P` : ''}</div>
        ${showExplanation ? `<div class="muted">解説: ${escapeHtml(q.explanation)}</div>` : ''}
      </div>
    `;
  }).join('');
}

function renderRewards() {
  const container = document.getElementById('reward-list');
  const active = allRewards.filter((r) => r.active);
  if (active.length === 0) {
    container.innerHTML = '<p class="muted">ご褒美はまだ登録されていないよ。</p>';
  } else {
    container.innerHTML = active.map((r) => {
      const outOfStock = r.stock !== null && r.stock <= 0;
      const canAfford = currentChild.points >= r.cost && !outOfStock;
      return `
        <div class="reward-card">
          <div class="emoji">${escapeHtml(r.emoji)}</div>
          <div>${escapeHtml(r.name)}</div>
          <div class="cost">${r.cost} P / 1個</div>
          ${r.stock !== null ? `<div class="muted">残り${r.stock}個</div>` : ''}
          <div class="row-between" style="justify-content:center; gap:6px; margin:6px 0;">
            <span class="muted">個数</span>
            <input type="number" id="reward-qty-${r.id}" value="1" min="1" ${r.stock !== null ? `max="${r.stock}"` : ''}
              oninput="updateRewardCost(${r.id})" style="width:60px; text-align:center; margin:0;" />
          </div>
          <div class="muted">合計: <span id="reward-total-${r.id}">${r.cost}</span>P</div>
          <button class="btn orange small" ${canAfford ? '' : 'disabled'} onclick="redeem(${r.id})">
            ${outOfStock ? '在庫なし' : '交換'}
          </button>
        </div>
      `;
    }).join('');
  }

  apiGet(`/api/redemptions?childId=${currentChild.id}`).then((history) => {
    const el = document.getElementById('redemption-history');
    if (history.length === 0) {
      el.innerHTML = '<p class="muted">まだ交換していないよ。</p>';
      return;
    }
    const sorted = [...history].sort((a, b) => new Date(b.redeemedAt) - new Date(a.redeemedAt));
    el.innerHTML = sorted.map((h) => {
      const isFulfilled = (h.status || 'pending') === 'fulfilled';
      return `
      <div class="list-item row-between">
        <span>${escapeHtml(h.rewardName)}${h.quantity > 1 ? ` ×${h.quantity}` : ''} <span class="badge ${isFulfilled ? 'correct' : 'pending'}">${isFulfilled ? '受け取り済み' : '準備中'}</span></span>
        <span class="muted">-${h.cost}P</span>
      </div>
    `;
    }).join('');
  });
}

function updateRewardCost(rewardId) {
  const reward = allRewards.find((r) => r.id === rewardId);
  const input = document.getElementById(`reward-qty-${rewardId}`);
  let qty = Math.max(1, parseInt(input.value, 10) || 1);
  if (reward.stock !== null) qty = Math.min(qty, Math.max(1, reward.stock));
  input.value = qty;
  document.getElementById(`reward-total-${rewardId}`).textContent = reward.cost * qty;
}

async function redeem(rewardId) {
  const reward = allRewards.find((r) => r.id === rewardId);
  const qtyInput = document.getElementById(`reward-qty-${rewardId}`);
  const quantity = Math.max(1, parseInt(qtyInput.value, 10) || 1);
  const totalCost = reward.cost * quantity;
  const label = quantity > 1 ? `「${reward.name}」を${quantity}個` : `「${reward.name}」`;
  const ok = await askConfirm(`${label}に${totalCost}Pを使う？`);
  if (!ok) return;
  try {
    await apiPost('/api/redemptions', { childId: currentChild.id, rewardId, quantity });
    showToast('交換したよ！🎁');
    await refreshAll();
  } catch (e) {
    showToast(e.message);
  }
}

init();
