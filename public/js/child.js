let currentChild = null;
let allQuestions = [];
let allAnswers = [];
let allRewards = [];
let allChores = [];
let allChoreLogs = [];

async function init() {
  const savedId = sessionStorage.getItem('childId');
  const children = await apiGet('/api/children');
  if (savedId) {
    const found = children.find((c) => c.id === Number(savedId));
    if (found) {
      currentChild = found;
      showMain();
      return;
    }
  }
  renderProfilePicker(children);
}

function renderProfilePicker(children) {
  const picker = document.getElementById('child-picker');
  if (children.length === 0) {
    picker.innerHTML = '<p class="muted">まだ登録されていません。保護者に登録してもらってね。</p>';
    return;
  }
  picker.innerHTML = children.map((c) => `
    <div class="child-tile" onclick="selectChild(${c.id})">
      <div class="avatar">${escapeHtml(c.avatar)}</div>
      <div>${escapeHtml(c.name)}</div>
      <div class="points-badge">${c.points} P</div>
    </div>
  `).join('');
}

async function selectChild(id) {
  sessionStorage.setItem('childId', id);
  const children = await apiGet('/api/children');
  currentChild = children.find((c) => c.id === id);
  showMain();
}

function switchProfile() {
  sessionStorage.removeItem('childId');
  currentChild = null;
  document.getElementById('main-screen').classList.add('hidden');
  document.getElementById('profile-screen').classList.remove('hidden');
  init();
}

async function showMain() {
  document.getElementById('profile-screen').classList.add('hidden');
  document.getElementById('main-screen').classList.remove('hidden');
  document.getElementById('my-avatar').textContent = currentChild.avatar;
  document.getElementById('my-name').textContent = currentChild.name;
  await refreshAll();
}

async function refreshAll() {
  const children = await apiGet('/api/children');
  currentChild = children.find((c) => c.id === currentChild.id);
  document.getElementById('my-points').textContent = `${currentChild.points} P`;

  allQuestions = await apiGet('/api/questions?activeOnly=true');
  allAnswers = await apiGet(`/api/answers?childId=${currentChild.id}`);
  allRewards = await apiGet('/api/rewards');
  allChores = await apiGet('/api/chores?activeOnly=true');
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

function renderQuiz() {
  const answeredIds = new Set(allAnswers.map((a) => a.questionId));
  const unanswered = allQuestions.filter((q) =>
    !answeredIds.has(q.id) && (!q.assignedChildId || q.assignedChildId === currentChild.id)
  );
  const container = document.getElementById('quiz-list');

  if (unanswered.length === 0) {
    container.innerHTML = '<div class="card"><p class="muted">今はもんだいがないよ。あとでまた見てね！</p></div>';
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
          <button class="btn green" onclick="submitChoice(${q.id})">こたえる</button>
        </div>
      `;
    } else {
      return `
        <div class="card" id="qcard-${q.id}">
          <div class="row-between"><h3>${escapeHtml(q.question)}</h3><span class="muted">${q.points}P</span></div>
          ${dueLabel}
          <textarea rows="3" id="text-${q.id}" placeholder="こたえを かいてね"></textarea>
          <button class="btn green" onclick="submitText(${q.id})">こたえる</button>
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
  if (!checked) { showToast('こたえを えらんでね'); return; }
  await submitAnswer(qid, { answerIndex: Number(checked.value) });
}

async function submitText(qid) {
  const text = document.getElementById(`text-${qid}`).value.trim();
  if (!text) { showToast('こたえを かいてね'); return; }
  await submitAnswer(qid, { answerText: text });
}

async function submitAnswer(qid, payload) {
  try {
    const result = await apiPost('/api/answers', { childId: currentChild.id, questionId: qid, ...payload });
    if (result.answer.status === 'correct') {
      showToast(`せいかい！ +${result.answer.pointsAwarded}P 🎉`);
    } else if (result.answer.status === 'incorrect') {
      showToast('ざんねん、まちがいだよ');
    } else {
      showToast('こたえを送ったよ。保護者が採点するまで待っててね');
    }
    await refreshAll();
  } catch (e) {
    showToast(e.message);
  }
}

function renderChores() {
  const todayKeyClient = new Date().toISOString().slice(0, 10);
  const activeChores = allChores.filter((c) => c.active);

  const routine = activeChores.filter((c) => c.type === 'routine');
  const routineEl = document.getElementById('routine-chore-list');
  if (routine.length === 0) {
    routineEl.innerHTML = '<p class="muted">いつでもできるおてつだいはまだないよ。</p>';
  } else {
    routineEl.innerHTML = routine.map((c) => {
      const log = allChoreLogs.find((l) => l.choreId === c.id && l.dateKey === todayKeyClient && l.status !== 'rejected');
      return renderChoreRow(c, log);
    }).join('');
  }

  const adhoc = activeChores.filter((c) => c.type === 'adhoc' && (!c.assignedChildId || c.assignedChildId === currentChild.id));
  const adhocEl = document.getElementById('adhoc-chore-list');
  if (adhoc.length === 0) {
    adhocEl.innerHTML = '<p class="muted">今はおねがいされたおてつだいはないよ。</p>';
  } else {
    adhocEl.innerHTML = adhoc.map((c) => {
      const log = allChoreLogs.find((l) => l.choreId === c.id && l.status !== 'rejected');
      return renderChoreRow(c, log);
    }).join('');
  }

  const historyEl = document.getElementById('chore-history');
  if (allChoreLogs.length === 0) {
    historyEl.innerHTML = '<p class="muted">まだおてつだいをしていないよ。</p>';
  } else {
    const sorted = [...allChoreLogs].sort((a, b) => new Date(b.reportedAt) - new Date(a.reportedAt));
    historyEl.innerHTML = sorted.map((l) => {
      const statusLabel = l.status === 'pending' ? '承認待ち' : l.status === 'approved' ? 'かんりょう' : 'やりなおし';
      const badgeClass = l.status === 'pending' ? 'pending' : l.status === 'approved' ? 'correct' : 'incorrect';
      return `
        <div class="list-item row-between">
          <span>${escapeHtml(l.choreName)}</span>
          <span class="badge ${badgeClass}">${statusLabel}</span>
        </div>
      `;
    }).join('');
  }
}

function renderChoreRow(chore, log) {
  let statusHtml;
  if (log && log.status === 'pending') {
    statusHtml = '<span class="badge pending">承認待ち</span>';
  } else if (log && log.status === 'approved') {
    statusHtml = '<span class="badge correct">かんりょう！</span>';
  } else {
    statusHtml = `<button class="btn green small" onclick="reportChore(${chore.id})">やった！</button>`;
  }
  return `
    <div class="list-item row-between">
      <span>${escapeHtml(chore.name)} <span class="muted">${chore.points}P</span></span>
      ${statusHtml}
    </div>
  `;
}

async function reportChore(choreId) {
  try {
    await apiPost('/api/chore-logs', { childId: currentChild.id, choreId });
    showToast('報告したよ！保護者の確認を待っててね');
    await refreshAll();
  } catch (e) {
    showToast(e.message);
  }
}

function renderResults() {
  const container = document.getElementById('results-list');
  if (allAnswers.length === 0) {
    container.innerHTML = '<p class="muted">まだこたえていないよ。</p>';
    return;
  }
  const sorted = [...allAnswers].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  container.innerHTML = sorted.map((a) => {
    const q = allQuestions.find((x) => x.id === a.questionId) || { question: '(削除された問題)' };
    const statusLabel = a.status === 'pending' ? '採点中'
      : a.status === 'correct' ? 'せいかい'
      : a.status === 'expired' ? '期限切れ'
      : 'まちがい';
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
    container.innerHTML = '<p class="muted">ごほうびはまだ登録されていないよ。</p>';
  } else {
    container.innerHTML = active.map((r) => {
      const outOfStock = r.stock !== null && r.stock <= 0;
      const canAfford = currentChild.points >= r.cost && !outOfStock;
      return `
        <div class="reward-card">
          <div class="emoji">${escapeHtml(r.emoji)}</div>
          <div>${escapeHtml(r.name)}</div>
          <div class="cost">${r.cost} P</div>
          ${r.stock !== null ? `<div class="muted">のこり${r.stock}こ</div>` : ''}
          <button class="btn orange small" ${canAfford ? '' : 'disabled'} onclick="redeem(${r.id})">
            ${outOfStock ? '在庫なし' : 'こうかん'}
          </button>
        </div>
      `;
    }).join('');
  }

  apiGet(`/api/redemptions?childId=${currentChild.id}`).then((history) => {
    const el = document.getElementById('redemption-history');
    if (history.length === 0) {
      el.innerHTML = '<p class="muted">まだこうかんしていないよ。</p>';
      return;
    }
    const sorted = [...history].sort((a, b) => new Date(b.redeemedAt) - new Date(a.redeemedAt));
    el.innerHTML = sorted.map((h) => `
      <div class="list-item row-between">
        <span>${escapeHtml(h.rewardName)}</span>
        <span class="muted">-${h.cost}P</span>
      </div>
    `).join('');
  });
}

async function redeem(rewardId) {
  const reward = allRewards.find((r) => r.id === rewardId);
  const ok = await askConfirm(`「${reward.name}」に${reward.cost}Pをつかう？`);
  if (!ok) return;
  try {
    await apiPost('/api/redemptions', { childId: currentChild.id, rewardId });
    showToast('こうかんしたよ！🎁');
    await refreshAll();
  } catch (e) {
    showToast(e.message);
  }
}

init();
