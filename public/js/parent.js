let choiceFieldCount = 0;
let cachedQuestions = [];
let cachedChildrenForQuestions = [];
let cachedChores = [];
let cachedChildrenForChores = [];

function checkPin() {
  const pin = document.getElementById('pin-input').value;
  apiPost('/api/auth/parent', { pin }).then((res) => {
    if (res.ok) {
      sessionStorage.setItem('parentPin', pin);
      document.getElementById('pin-overlay').classList.add('hidden');
      document.getElementById('main-screen').classList.remove('hidden');
      initMain();
    } else {
      document.getElementById('pin-error').textContent = 'PINが違います';
    }
  });
}

// Auto-login if PIN already verified this session
(function tryAutoLogin() {
  const saved = sessionStorage.getItem('parentPin');
  if (saved) {
    apiPost('/api/auth/parent', { pin: saved }).then((res) => {
      if (res.ok) {
        document.getElementById('pin-overlay').classList.add('hidden');
        document.getElementById('main-screen').classList.remove('hidden');
        initMain();
      }
    });
  }
})();

function showTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  if (tab === 'grading') loadGrading();
  if (tab === 'chores') loadChores();
  if (tab === 'study') loadStudyTasks();
  if (tab === 'bonus') loadBonusTasks();
  if (tab === 'points') loadPoints();
  if (tab === 'rewards') loadRewards();
}

function initMain() {
  loadChildren();
  onQTypeChange();
  loadQuestions();
}

// ---------- Children ----------

async function loadChildren() {
  const children = await apiGet('/api/children');
  const el = document.getElementById('children-list');
  if (children.length === 0) {
    el.innerHTML = '<p class="muted">まだ登録されていません。</p>';
  } else {
    el.innerHTML = children.map((c) => `
      <div class="list-item row-between">
        <span>${escapeHtml(c.avatar)} ${escapeHtml(c.name)} <span class="muted">(${c.points}P)</span></span>
        <span>
          <button class="btn small secondary" onclick="copyChildUrl(${c.id}, '${escapeHtml(c.name)}')">専用URLをコピー</button>
          <button class="btn small secondary" onclick="deleteChild(${c.id}, '${escapeHtml(c.name)}')">削除</button>
        </span>
      </div>
    `).join('');
  }
  populateAdhocChildSelect(children);
}

async function copyChildUrl(id, name) {
  try {
    const { token } = await apiGet(`/api/children/${id}/token`);
    const url = `${location.origin}/child.html?token=${token}`;
    await navigator.clipboard.writeText(url);
    showToast(`${name}さん専用のURLをコピーしました`);
  } catch (e) {
    showToast('コピーに失敗しました。手動でご確認ください: ' + e.message);
  }
}

const CHILD_TARGET_SELECT_IDS = [
  'new-adhoc-chore-child', 'q-assigned-child', 'bulk-assigned-child', 'bulk-csv-assigned-child',
  'new-study-task-child', 'bulk-study-csv-assigned-child', 'new-recurring-task-child',
  'new-bonus-task-child', 'bulk-bonus-csv-assigned-child'
];

function populateAdhocChildSelect(children) {
  CHILD_TARGET_SELECT_IDS.forEach((id) => {
    const select = document.getElementById(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">誰でもOK</option>' +
      children.map((c) => `<option value="${c.id}">${escapeHtml(c.avatar)} ${escapeHtml(c.name)}</option>`).join('');
    select.value = current;
  });
}

async function addChild() {
  const name = document.getElementById('new-child-name').value;
  const avatar = document.getElementById('new-child-avatar').value || '🙂';
  if (!name.trim()) { showToast('名前を入力してください'); return; }
  try {
    await apiPost('/api/children', { name, avatar });
    document.getElementById('new-child-name').value = '';
    showToast('追加しました');
    loadChildren();
  } catch (e) { showToast(e.message); }
}

async function deleteChild(id, name) {
  const ok = await askConfirm(`「${name}」を削除しますか？回答履歴も含めて元に戻せません。`);
  if (!ok) return;
  await apiDelete(`/api/children/${id}`);
  loadChildren();
}

// ---------- Questions ----------

function onQTypeChange() {
  const type = document.getElementById('q-type').value;
  document.getElementById('choice-fields').classList.toggle('hidden', type !== 'choice');
  document.getElementById('text-fields').classList.toggle('hidden', type !== 'text');
  if (type === 'choice' && document.getElementById('choice-inputs').children.length === 0) {
    addChoiceField();
    addChoiceField();
  }
}

function addChoiceField() {
  const idx = choiceFieldCount++;
  const wrap = document.getElementById('choice-inputs');
  const row = document.createElement('div');
  row.className = 'row-between';
  row.style.marginBottom = '6px';
  row.innerHTML = `
    <input type="radio" name="correct-choice" value="${idx}" style="width:auto;" />
    <input type="text" data-choice-idx="${idx}" placeholder="選択肢${idx + 1}" style="flex:1; margin:0 0 0 8px;" />
  `;
  wrap.appendChild(row);
}

async function addQuestion() {
  const type = document.getElementById('q-type').value;
  const question = document.getElementById('q-question').value;
  const points = document.getElementById('q-points').value;
  const dueAt = document.getElementById('q-due-at').value;
  const latePenalty = document.getElementById('q-late-penalty').value;
  const assignedChildId = document.getElementById('q-assigned-child').value;
  const payload = { type, question, points, dueAt: dueAt || null, latePenalty, assignedChildId: assignedChildId || null };

  if (type === 'choice') {
    const inputs = [...document.querySelectorAll('#choice-inputs input[type=text]')];
    const choices = inputs.map((i) => i.value);
    const checked = document.querySelector('input[name=correct-choice]:checked');
    payload.choices = choices;
    payload.correctIndex = checked ? Number(checked.value) : undefined;
  } else {
    payload.correctAnswer = document.getElementById('q-correct-text').value;
  }

  try {
    await apiPost('/api/questions', payload);
    document.getElementById('q-question').value = '';
    document.getElementById('choice-inputs').innerHTML = '';
    choiceFieldCount = 0;
    addChoiceField();
    addChoiceField();
    document.getElementById('q-correct-text').value = '';
    document.getElementById('q-due-at').value = '';
    document.getElementById('q-late-penalty').value = '0';
    showToast('問題を登録しました');
    loadQuestions();
  } catch (e) { showToast(e.message); }
}

async function addBulkQuestions() {
  const rawText = document.getElementById('bulk-question-text').value;
  const points = document.getElementById('bulk-points').value;
  const dueAt = document.getElementById('bulk-due-at').value;
  const latePenalty = document.getElementById('bulk-late-penalty').value;
  const assignedChildId = document.getElementById('bulk-assigned-child').value;
  if (!rawText.trim()) { showToast('テキストを入力してください'); return; }
  try {
    const created = await apiPost('/api/questions/bulk', {
      rawText, points, dueAt: dueAt || null, latePenalty, assignedChildId: assignedChildId || null
    });
    document.getElementById('bulk-question-text').value = '';
    document.getElementById('bulk-due-at').value = '';
    document.getElementById('bulk-late-penalty').value = '0';
    showToast(`${created.length}問を登録しました`);
    loadQuestions();
  } catch (e) { showToast(e.message); }
}

async function addBulkCsvQuestions() {
  const csvText = document.getElementById('bulk-csv-text').value;
  const points = document.getElementById('bulk-csv-points').value;
  const dueAt = document.getElementById('bulk-csv-due-at').value;
  const latePenalty = document.getElementById('bulk-csv-late-penalty').value;
  const assignedChildId = document.getElementById('bulk-csv-assigned-child').value;
  if (!csvText.trim()) { showToast('CSVを入力してください'); return; }
  try {
    const created = await apiPost('/api/questions/bulk-csv', {
      csvText, points, dueAt: dueAt || null, latePenalty, assignedChildId: assignedChildId || null
    });
    document.getElementById('bulk-csv-text').value = '';
    document.getElementById('bulk-csv-due-at').value = '';
    document.getElementById('bulk-csv-late-penalty').value = '0';
    showToast(`${created.length}問を登録しました`);
    loadQuestions();
  } catch (e) { showToast(e.message); }
}

async function loadQuestions() {
  const [questions, children] = await Promise.all([apiGet('/api/questions'), apiGet('/api/children')]);
  cachedQuestions = questions;
  cachedChildrenForQuestions = children;
  applyTabUrgency('questions', questions.filter((q) => q.active));
  populateFilterSelect('filter-subject', questions.map((q) => q.subject), '教科: すべて');
  populateFilterSelect('filter-unit', questions.map((q) => q.unit), '単元: すべて');
  populateFilterSelect('filter-difficulty', questions.map((q) => q.difficulty), '難易度: すべて');
  renderQuestionsList();
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

function renderQuestionsList() {
  const el = document.getElementById('questions-list');
  const subjectFilter = document.getElementById('filter-subject').value;
  const unitFilter = document.getElementById('filter-unit').value;
  const difficultyFilter = document.getElementById('filter-difficulty').value;
  const dueFilter = document.getElementById('filter-due').value;
  const nowIso = new Date().toISOString();

  const questions = cachedQuestions.filter((q) => {
    if (subjectFilter && q.subject !== subjectFilter) return false;
    if (unitFilter && q.unit !== unitFilter) return false;
    if (difficultyFilter && q.difficulty !== difficultyFilter) return false;
    if (dueFilter === 'has' && !q.dueAt) return false;
    if (dueFilter === 'none' && q.dueAt) return false;
    if (dueFilter === 'expired' && !(q.dueAt && q.dueAt < nowIso)) return false;
    return true;
  });

  if (questions.length === 0) {
    el.innerHTML = '<p class="muted">条件に一致する問題がありません。</p>';
    return;
  }
  el.innerHTML = questions.map((q) => {
    const assignedChild = cachedChildrenForQuestions.find((c) => c.id === q.assignedChildId);
    const dueLabel = q.dueAt ? `期限: ${new Date(q.dueAt).toLocaleString('ja-JP')}${q.latePenalty > 0 ? ` (未回答-${q.latePenalty}P)` : ''}` : '';
    const tags = [q.subject, q.unit, q.difficulty].filter((t) => t).map((t) => escapeHtml(t)).join(' / ');
    return `
    <div class="list-item">
      <div class="row-between">
        <span>${escapeHtml(q.question)} <span class="muted">(${q.type === 'choice' ? '選択式' : '記述式'} / ${q.points}P${assignedChild ? ` / ${escapeHtml(assignedChild.name)}へ` : ''})</span></span>
        <span>
          <button class="btn small secondary" onclick="editQuestion(${q.id})">編集</button>
          <button class="btn small secondary" onclick="toggleQuestionActive(${q.id}, ${!q.active})">${q.active ? '非公開にする' : '公開する'}</button>
          <button class="btn small secondary" onclick="deleteQuestion(${q.id})">削除</button>
        </span>
      </div>
      ${tags ? `<div class="muted">${tags}</div>` : ''}
      ${q.type === 'choice' ? `<div class="muted">選択肢: ${q.choices.map((c, i) => (i === q.correctIndex ? `✅${escapeHtml(c)}` : escapeHtml(c))).join(' / ')}</div>` : ''}
      ${q.correctAnswer ? `<div class="muted">参考正解: ${escapeHtml(q.correctAnswer)}</div>` : ''}
      ${dueLabel ? `<div class="muted">${dueLabel}</div>` : ''}
    </div>
  `;
  }).join('');
}

async function toggleQuestionActive(id, active) {
  await apiPatch(`/api/questions/${id}`, { active });
  loadQuestions();
}

async function deleteQuestion(id) {
  const ok = await askConfirm('この問題を削除しますか？');
  if (!ok) return;
  await apiDelete(`/api/questions/${id}`);
  loadQuestions();
}

function toLocalDateTimeValue(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addEditChoiceField(containerId, radioName, value, checked) {
  const wrap = document.getElementById(containerId);
  const idx = wrap.children.length;
  const row = document.createElement('div');
  row.className = 'row-between';
  row.style.marginBottom = '6px';
  row.innerHTML = `
    <input type="radio" name="${radioName}" value="${idx}" ${checked ? 'checked' : ''} style="width:auto;" />
    <input type="text" class="edit-choice-text" value="${escapeHtml(value || '')}" placeholder="選択肢${idx + 1}" style="flex:1; margin:0 0 0 8px;" />
  `;
  wrap.appendChild(row);
}

// Every field/id below is suffixed with the question id so multiple edit
// modals (e.g. opened in quick succession) can never collide with each other.
async function editQuestion(id) {
  const q = cachedQuestions.find((x) => x.id === id);
  if (!q) return;
  const isChoice = q.type === 'choice';
  const choicesId = `edit-q-choices-${id}`;
  const radioName = `edit-correct-choice-${id}`;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="card" style="max-width:480px; max-height:90vh; overflow-y:auto;">
      <h3>問題を編集</h3>
      <label>問題文</label>
      <textarea id="edit-q-question-${id}" rows="2">${escapeHtml(q.question)}</textarea>
      ${isChoice ? `
        <label>選択肢（正解をラジオボタンで選択）</label>
        <div id="${choicesId}"></div>
        <button class="btn small secondary" type="button" onclick="addEditChoiceField('${choicesId}', '${radioName}', '', false)">選択肢を追加</button>
      ` : `
        <label>正解例（採点の参考用・任意）</label>
        <input type="text" id="edit-q-correct-text-${id}" value="${escapeHtml(q.correctAnswer || '')}" />
      `}
      <label>教科（任意）</label>
      <input type="text" id="edit-q-subject-${id}" value="${escapeHtml(q.subject || '')}" />
      <label>単元（任意）</label>
      <input type="text" id="edit-q-unit-${id}" value="${escapeHtml(q.unit || '')}" />
      <label>難易度（任意）</label>
      <input type="text" id="edit-q-difficulty-${id}" value="${escapeHtml(q.difficulty || '')}" />
      <label>解説（任意）</label>
      <input type="text" id="edit-q-explanation-${id}" value="${escapeHtml(q.explanation || '')}" />
      <label>正解ポイント</label>
      <input type="number" id="edit-q-points-${id}" value="${q.points}" min="0" />
      <label>期限（任意）</label>
      <input type="datetime-local" id="edit-q-due-at-${id}" value="${q.dueAt ? toLocalDateTimeValue(q.dueAt) : ''}" />
      <label>期限切れの減点（任意）</label>
      <input type="number" id="edit-q-late-penalty-${id}" value="${q.latePenalty || 0}" min="0" />
      <label>対象の子ども</label>
      <select id="edit-q-assigned-child-${id}"><option value="">誰でも</option></select>
      <div class="btn-row">
        <button class="btn secondary" onclick="this.closest('.overlay').remove()">キャンセル</button>
        <button class="btn green" onclick="saveQuestionEdit(${id}, this)">保存する</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  if (isChoice) {
    q.choices.forEach((c, i) => addEditChoiceField(choicesId, radioName, c, i === q.correctIndex));
  }

  const children = await apiGet('/api/children');
  const sel = document.getElementById(`edit-q-assigned-child-${id}`);
  if (sel) {
    sel.innerHTML = '<option value="">誰でも</option>' +
      children.map((c) => `<option value="${c.id}" ${c.id === q.assignedChildId ? 'selected' : ''}>${escapeHtml(c.avatar)} ${escapeHtml(c.name)}</option>`).join('');
  }
}

async function saveQuestionEdit(id, btn) {
  const q = cachedQuestions.find((x) => x.id === id);
  if (!q) return;
  const overlay = btn.closest('.overlay');
  const dueAt = overlay.querySelector(`#edit-q-due-at-${id}`).value;
  const assignedChildId = overlay.querySelector(`#edit-q-assigned-child-${id}`).value;
  const payload = {
    question: overlay.querySelector(`#edit-q-question-${id}`).value,
    points: overlay.querySelector(`#edit-q-points-${id}`).value,
    subject: overlay.querySelector(`#edit-q-subject-${id}`).value,
    unit: overlay.querySelector(`#edit-q-unit-${id}`).value,
    difficulty: overlay.querySelector(`#edit-q-difficulty-${id}`).value,
    explanation: overlay.querySelector(`#edit-q-explanation-${id}`).value,
    dueAt: dueAt || null,
    latePenalty: overlay.querySelector(`#edit-q-late-penalty-${id}`).value,
    assignedChildId: assignedChildId || null
  };
  if (q.type === 'choice') {
    const rows = [...overlay.querySelectorAll(`#edit-q-choices-${id} > div`)];
    payload.choices = rows.map((r) => r.querySelector('.edit-choice-text').value);
    const checked = overlay.querySelector(`input[name=edit-correct-choice-${id}]:checked`);
    payload.correctIndex = checked ? Number(checked.value) : undefined;
  } else {
    payload.correctAnswer = overlay.querySelector(`#edit-q-correct-text-${id}`).value;
  }
  try {
    await apiPatch(`/api/questions/${id}`, payload);
    overlay.remove();
    showToast('更新しました');
    loadQuestions();
  } catch (e) { showToast(e.message); }
}

// ---------- Grading ----------

async function loadGrading() {
  const [pending, children, questions] = await Promise.all([
    apiGet('/api/answers?status=pending'),
    apiGet('/api/children'),
    apiGet('/api/questions')
  ]);
  const el = document.getElementById('grading-list');
  if (pending.length === 0) {
    el.innerHTML = '<p class="muted">採点待ちの回答はありません。</p>';
    return;
  }
  el.innerHTML = pending.map((a) => {
    const child = children.find((c) => c.id === a.childId) || { name: '(不明)' };
    const q = questions.find((x) => x.id === a.questionId) || { question: '(削除された問題)', correctAnswer: '', explanation: '' };
    return `
      <div class="list-item">
        <div>${escapeHtml(child.name)} さんの回答</div>
        <div><strong>問題:</strong> ${escapeHtml(q.question)}</div>
        ${q.correctAnswer ? `<div class="muted">参考正解: ${escapeHtml(q.correctAnswer)}</div>` : ''}
        ${q.explanation ? `<div class="muted">解説: ${escapeHtml(q.explanation)}</div>` : ''}
        <div><strong>回答:</strong> ${escapeHtml(a.answerText)}</div>
        <div class="btn-row">
          <button class="btn green small" onclick="gradeAnswer(${a.id}, true)">正解</button>
          <button class="btn pink small" onclick="gradeAnswer(${a.id}, false)">不正解</button>
        </div>
      </div>
    `;
  }).join('');
}

async function gradeAnswer(id, correct) {
  await apiPatch(`/api/answers/${id}/grade`, { correct });
  showToast('採点しました');
  loadGrading();
}

// ---------- Chores (お手伝い・勉強タスク) ----------
// Both tabs share the same `chores`/`chore-logs` API, filtered by `category`.

function addLevelRow(containerId) {
  const container = document.getElementById(containerId);
  const row = document.createElement('div');
  row.className = 'row-between';
  row.style.marginBottom = '6px';
  row.innerHTML = `
    <input type="text" class="level-label" placeholder="ラベル (例: かんぺき)" style="flex:1; margin:0 4px 0 0;" />
    <input type="number" class="level-points" placeholder="ポイント" min="0" style="width:90px; margin:0 4px 0 0;" />
    <button type="button" class="btn small secondary" onclick="this.parentElement.remove()">×</button>
  `;
  container.appendChild(row);
}

function collectLevels(containerId) {
  const container = document.getElementById(containerId);
  return [...container.children].map((row) => ({
    label: row.querySelector('.level-label').value,
    points: row.querySelector('.level-points').value
  })).filter((l) => l.label.trim().length > 0);
}

function clearLevelRows(containerId) {
  document.getElementById(containerId).innerHTML = '';
}

async function addRoutineChore() {
  const name = document.getElementById('new-routine-chore-name').value;
  const points = document.getElementById('new-routine-chore-points').value;
  const levels = collectLevels('routine-levels');
  if (!name.trim()) { showToast('お手伝いの名前を入力してください'); return; }
  try {
    await apiPost('/api/chores', { name, type: 'routine', points, levels, category: 'household' });
    document.getElementById('new-routine-chore-name').value = '';
    clearLevelRows('routine-levels');
    showToast('追加しました');
    loadChores();
  } catch (e) { showToast(e.message); }
}

async function addAdhocChore() {
  const name = document.getElementById('new-adhoc-chore-name').value;
  const points = document.getElementById('new-adhoc-chore-points').value;
  const assignedChildId = document.getElementById('new-adhoc-chore-child').value;
  const levels = collectLevels('adhoc-levels');
  if (!name.trim()) { showToast('お手伝いの名前を入力してください'); return; }
  try {
    await apiPost('/api/chores', { name, type: 'adhoc', points, levels, assignedChildId: assignedChildId || null, category: 'household' });
    document.getElementById('new-adhoc-chore-name').value = '';
    clearLevelRows('adhoc-levels');
    showToast('依頼しました');
    loadChores();
  } catch (e) { showToast(e.message); }
}

async function addStudyTask() {
  const name = document.getElementById('new-study-task-name').value;
  const subject = document.getElementById('new-study-task-subject').value;
  const unit = document.getElementById('new-study-task-unit').value;
  const points = document.getElementById('new-study-task-points').value;
  const assignedChildId = document.getElementById('new-study-task-child').value;
  const levels = collectLevels('study-levels');
  if (!name.trim()) { showToast('内容を入力してください'); return; }
  try {
    await apiPost('/api/chores', {
      name, type: 'adhoc', points, levels, subject, unit,
      assignedChildId: assignedChildId || null, category: 'study'
    });
    document.getElementById('new-study-task-name').value = '';
    document.getElementById('new-study-task-subject').value = '';
    document.getElementById('new-study-task-unit').value = '';
    clearLevelRows('study-levels');
    showToast('追加しました');
    loadStudyTasks();
  } catch (e) { showToast(e.message); }
}

async function addRecurringStudyTask() {
  const name = document.getElementById('new-recurring-task-name').value;
  const subject = document.getElementById('new-recurring-task-subject').value;
  const unit = document.getElementById('new-recurring-task-unit').value;
  const points = document.getElementById('new-recurring-task-points').value;
  const periodDays = document.getElementById('new-recurring-task-period').value;
  const targetCount = document.getElementById('new-recurring-task-target').value;
  const periodPenalty = document.getElementById('new-recurring-task-penalty').value;
  const assignedChildId = document.getElementById('new-recurring-task-child').value;
  const levels = collectLevels('recurring-levels');
  if (!name.trim()) { showToast('内容を入力してください'); return; }
  try {
    await apiPost('/api/chores', {
      name, type: 'routine', points, levels, subject, unit, periodDays, targetCount, periodPenalty,
      assignedChildId: assignedChildId || null, category: 'study'
    });
    document.getElementById('new-recurring-task-name').value = '';
    document.getElementById('new-recurring-task-subject').value = '';
    document.getElementById('new-recurring-task-unit').value = '';
    clearLevelRows('recurring-levels');
    showToast('追加しました');
    loadStudyTasks();
  } catch (e) { showToast(e.message); }
}

async function addBulkCsvStudyTasks() {
  const csvText = document.getElementById('bulk-study-csv-text').value;
  const assignedChildId = document.getElementById('bulk-study-csv-assigned-child').value;
  if (!csvText.trim()) { showToast('CSVを入力してください'); return; }
  try {
    const created = await apiPost('/api/chores/bulk-csv', { csvText, assignedChildId: assignedChildId || null });
    document.getElementById('bulk-study-csv-text').value = '';
    showToast(`${created.length}件を登録しました`);
    loadStudyTasks();
  } catch (e) { showToast(e.message); }
}

async function addBonusTask() {
  const name = document.getElementById('new-bonus-task-name').value;
  const points = document.getElementById('new-bonus-task-points').value;
  const assignedChildId = document.getElementById('new-bonus-task-child').value;
  const levels = collectLevels('bonus-levels');
  if (!name.trim()) { showToast('内容を入力してください'); return; }
  try {
    await apiPost('/api/chores', {
      name, type: 'adhoc', points, levels, assignedChildId: assignedChildId || null, category: 'bonus'
    });
    document.getElementById('new-bonus-task-name').value = '';
    clearLevelRows('bonus-levels');
    showToast('追加しました');
    loadBonusTasks();
  } catch (e) { showToast(e.message); }
}

async function addBulkCsvBonusTasks() {
  const csvText = document.getElementById('bulk-bonus-csv-text').value;
  const assignedChildId = document.getElementById('bulk-bonus-csv-assigned-child').value;
  if (!csvText.trim()) { showToast('CSVを入力してください'); return; }
  try {
    const created = await apiPost('/api/chores/bulk-csv', { csvText, assignedChildId: assignedChildId || null, category: 'bonus' });
    document.getElementById('bulk-bonus-csv-text').value = '';
    showToast(`${created.length}件を登録しました`);
    loadBonusTasks();
  } catch (e) { showToast(e.message); }
}

async function loadChores() {
  await renderChoreCategory('household', 'chores-list', 'chore-approval-list', 'まだお手伝いが登録されていません。');
}

async function loadStudyTasks() {
  await renderChoreCategory('study', 'study-tasks-list', 'study-approval-list', 'まだ勉強タスクが登録されていません。');
}

async function loadBonusTasks() {
  await renderChoreCategory('bonus', 'bonus-tasks-list', 'bonus-approval-list', 'まだボーナスタスクが登録されていません。');
}

async function renderChoreCategory(category, listElId, approvalElId, emptyMessage) {
  const [allChores, children, pendingLogs] = await Promise.all([
    apiGet('/api/chores'),
    apiGet('/api/children'),
    apiGet('/api/chore-logs?status=pending')
  ]);
  populateAdhocChildSelect(children);
  cachedChores = allChores;
  cachedChildrenForChores = children;

  const chores = allChores.filter((c) => (c.category || 'household') === category);
  const listEl = document.getElementById(listElId);
  if (chores.length === 0) {
    listEl.innerHTML = `<p class="muted">${emptyMessage}</p>`;
  } else {
    listEl.innerHTML = chores.map((c) => {
      const assignedChild = children.find((x) => x.id === c.assignedChildId);
      const typeLabel = c.type === 'routine' ? '定型' : '随時';
      const targetLabel = assignedChild ? `${escapeHtml(assignedChild.name)}へ` : (c.type === 'adhoc' ? '誰でもOK' : '');
      const tags = [c.subject, c.unit].filter((t) => t).map((t) => escapeHtml(t)).join(' / ');
      const levelsLabel = (c.levels && c.levels.length > 0)
        ? c.levels.map((l) => `${escapeHtml(l.label)}(${l.points}P)`).join(' / ')
        : `${c.points}P`;
      const periodLabel = (c.periodDays > 0 && c.targetCount > 0)
        ? `${c.periodDays}日間で${c.targetCount}回未満だと-${c.periodPenalty}P`
        : '';
      return `
        <div class="list-item">
          <div class="row-between">
            <span>${escapeHtml(c.name)} <span class="muted">(${typeLabel} / ${levelsLabel}${targetLabel ? ' / ' + targetLabel : ''})</span></span>
            <span>
              <button class="btn small secondary" onclick="editChore(${c.id})">編集</button>
              <button class="btn small secondary" onclick="toggleChoreActive(${c.id}, ${!c.active})">${c.active ? '非公開にする' : '公開する'}</button>
              <button class="btn small secondary" onclick="deleteChore(${c.id})">削除</button>
            </span>
          </div>
          ${tags ? `<div class="muted">${tags}</div>` : ''}
          ${periodLabel ? `<div class="muted">${periodLabel}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  const relevantLogs = pendingLogs.filter((l) => {
    const chore = allChores.find((c) => c.id === l.choreId);
    return chore && (chore.category || 'household') === category;
  });
  const approvalEl = document.getElementById(approvalElId);
  if (relevantLogs.length === 0) {
    approvalEl.innerHTML = '<p class="muted">承認待ちはありません。</p>';
    return;
  }
  approvalEl.innerHTML = relevantLogs.map((l) => {
    const child = children.find((c) => c.id === l.childId) || { name: '(不明)' };
    const chore = allChores.find((c) => c.id === l.choreId);
    const levels = (chore && chore.levels) || [];
    const approveButtons = levels.length > 0
      ? levels.map((lv, i) => `<button class="btn green small" onclick="gradeChore(${l.id}, true, ${i})">${escapeHtml(lv.label)} (+${lv.points}P)</button>`).join('')
      : `<button class="btn green small" onclick="gradeChore(${l.id}, true)">承認してポイント付与</button>`;
    return `
      <div class="list-item">
        <div>${escapeHtml(child.name)} さんが「${escapeHtml(l.choreName)}」を報告しました</div>
        <div class="btn-row">
          ${approveButtons}
          <button class="btn pink small" onclick="gradeChore(${l.id}, false)">やり直し</button>
        </div>
      </div>
    `;
  }).join('');
}

async function toggleChoreActive(id, active) {
  await apiPatch(`/api/chores/${id}`, { active });
  loadChores();
  loadStudyTasks();
  loadBonusTasks();
}

async function deleteChore(id) {
  const ok = await askConfirm('削除しますか？');
  if (!ok) return;
  await apiDelete(`/api/chores/${id}`);
  loadChores();
  loadStudyTasks();
  loadBonusTasks();
}

async function editChore(id) {
  const chore = cachedChores.find((c) => c.id === id);
  if (!chore) return;
  const categoryLabel = chore.category === 'study' ? '勉強タスク' : chore.category === 'bonus' ? 'ボーナスタスク' : 'お手伝い';
  const hasSubjectUnit = chore.category === 'study' || chore.category === 'bonus';
  const isRoutine = chore.type === 'routine';
  const levelsId = `edit-chore-levels-${id}`;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="card" style="max-width:480px; max-height:90vh; overflow-y:auto;">
      <h3>${categoryLabel}を編集</h3>
      <label>内容</label>
      <input type="text" id="edit-chore-name-${id}" value="${escapeHtml(chore.name)}" />
      ${hasSubjectUnit ? `
        <label>教科（任意）</label>
        <input type="text" id="edit-chore-subject-${id}" value="${escapeHtml(chore.subject || '')}" />
        <label>単元・教材（任意）</label>
        <input type="text" id="edit-chore-unit-${id}" value="${escapeHtml(chore.unit || '')}" />
      ` : ''}
      <label>ポイント（達成度レベルを使わない場合）</label>
      <input type="number" id="edit-chore-points-${id}" value="${chore.points}" min="0" />
      <label>達成度レベル（任意・設定するとポイントより優先されます）</label>
      <div id="${levelsId}"></div>
      <button class="btn small secondary" type="button" onclick="addLevelRow('${levelsId}')">レベルを追加</button>
      ${isRoutine ? `
        <label>期間（日数・任意）</label>
        <input type="number" id="edit-chore-period-${id}" value="${chore.periodDays || ''}" min="0" />
        <label>期間内の目標回数（任意）</label>
        <input type="number" id="edit-chore-target-${id}" value="${chore.targetCount || ''}" min="0" />
        <label>目標未達成時の減点</label>
        <input type="number" id="edit-chore-penalty-${id}" value="${chore.periodPenalty || 0}" min="0" />
      ` : ''}
      <label>対象の子ども</label>
      <select id="edit-chore-child-${id}"><option value="">誰でもOK</option></select>
      <div class="btn-row">
        <button class="btn secondary" onclick="this.closest('.overlay').remove()">キャンセル</button>
        <button class="btn green" onclick="saveChoreEdit(${id}, this)">保存する</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const levelsContainer = document.getElementById(levelsId);
  (chore.levels || []).forEach(() => addLevelRow(levelsId));
  [...levelsContainer.children].forEach((row, i) => {
    const level = chore.levels[i];
    row.querySelector('.level-label').value = level.label;
    row.querySelector('.level-points').value = level.points;
  });

  const sel = document.getElementById(`edit-chore-child-${id}`);
  sel.innerHTML = '<option value="">誰でもOK</option>' +
    cachedChildrenForChores.map((c) => `<option value="${c.id}" ${c.id === chore.assignedChildId ? 'selected' : ''}>${escapeHtml(c.avatar)} ${escapeHtml(c.name)}</option>`).join('');
}

async function saveChoreEdit(id, btn) {
  const chore = cachedChores.find((c) => c.id === id);
  if (!chore) return;
  const overlay = btn.closest('.overlay');
  const assignedChildId = overlay.querySelector(`#edit-chore-child-${id}`).value;
  const payload = {
    name: overlay.querySelector(`#edit-chore-name-${id}`).value,
    points: overlay.querySelector(`#edit-chore-points-${id}`).value,
    levels: collectLevels(`edit-chore-levels-${id}`),
    assignedChildId: assignedChildId || null
  };
  if (chore.category === 'study' || chore.category === 'bonus') {
    payload.subject = overlay.querySelector(`#edit-chore-subject-${id}`).value;
    payload.unit = overlay.querySelector(`#edit-chore-unit-${id}`).value;
  }
  if (chore.type === 'routine') {
    payload.periodDays = overlay.querySelector(`#edit-chore-period-${id}`).value;
    payload.targetCount = overlay.querySelector(`#edit-chore-target-${id}`).value;
    payload.periodPenalty = overlay.querySelector(`#edit-chore-penalty-${id}`).value;
  }
  try {
    await apiPatch(`/api/chores/${id}`, payload);
    overlay.remove();
    showToast('更新しました');
    loadChores();
    loadStudyTasks();
    loadBonusTasks();
  } catch (e) { showToast(e.message); }
}

async function gradeChore(id, approved, levelIndex) {
  const payload = { approved };
  if (levelIndex !== undefined) payload.levelIndex = levelIndex;
  try {
    await apiPatch(`/api/chore-logs/${id}/grade`, payload);
    showToast(approved ? 'ポイントを付与しました' : 'やり直しにしました');
    loadChores();
    loadStudyTasks();
    loadBonusTasks();
  } catch (e) { showToast(e.message); }
}

// ---------- Points ----------

async function loadPoints() {
  const children = await apiGet('/api/children');
  const el = document.getElementById('points-list');
  if (children.length === 0) {
    el.innerHTML = '<p class="muted">まだ登録されていません。</p>';
    return;
  }
  el.innerHTML = children.map((c) => `
    <div class="list-item">
      <div class="row-between">
        <span>${escapeHtml(c.avatar)} ${escapeHtml(c.name)}</span>
        <span class="points-display">${c.points} P</span>
      </div>
      <div class="btn-row">
        <button class="btn small green" onclick="adjustPoints(${c.id}, 10)">+10</button>
        <button class="btn small green" onclick="adjustPoints(${c.id}, 50)">+50</button>
        <button class="btn small secondary" onclick="adjustPointsCustom(${c.id})">その他</button>
      </div>
    </div>
  `).join('');
}

async function adjustPoints(id, delta) {
  await apiPost(`/api/children/${id}/points`, { delta });
  showToast(`${delta > 0 ? '+' : ''}${delta}P しました`);
  loadPoints();
}

async function adjustPointsCustom(id) {
  const delta = await askNumber('増減するポイント数を入力してください（マイナスも可）', 0);
  if (delta === null || Number.isNaN(delta)) return;
  await adjustPoints(id, delta);
}

// ---------- Rewards ----------

async function addReward() {
  const name = document.getElementById('new-reward-name').value;
  const cost = document.getElementById('new-reward-cost').value;
  const stock = document.getElementById('new-reward-stock').value;
  const emoji = document.getElementById('new-reward-emoji').value || '🎁';
  if (!name.trim()) { showToast('名前を入力してください'); return; }
  try {
    await apiPost('/api/rewards', { name, cost, stock: stock === '' ? null : stock, emoji });
    document.getElementById('new-reward-name').value = '';
    document.getElementById('new-reward-stock').value = '';
    showToast('追加しました');
    loadRewards();
  } catch (e) { showToast(e.message); }
}

async function loadRewards() {
  const [rewards, redemptions, children] = await Promise.all([
    apiGet('/api/rewards'),
    apiGet('/api/redemptions'),
    apiGet('/api/children')
  ]);
  const el = document.getElementById('rewards-list');
  if (rewards.length === 0) {
    el.innerHTML = '<p class="muted">まだ登録されていません。</p>';
  } else {
    el.innerHTML = rewards.map((r) => `
      <div class="list-item row-between">
        <span>${escapeHtml(r.emoji)} ${escapeHtml(r.name)} <span class="muted">(${r.cost}P${r.stock !== null ? ` / 残${r.stock}` : ''})</span></span>
        <span>
          <button class="btn small secondary" onclick="toggleRewardActive(${r.id}, ${!r.active})">${r.active ? '非公開にする' : '公開する'}</button>
          <button class="btn small secondary" onclick="deleteReward(${r.id})">削除</button>
        </span>
      </div>
    `).join('');
  }

  const logEl = document.getElementById('redemption-log');
  if (redemptions.length === 0) {
    logEl.innerHTML = '<p class="muted">まだ交換履歴はありません。</p>';
    return;
  }
  const sorted = [...redemptions].sort((a, b) => new Date(b.redeemedAt) - new Date(a.redeemedAt));
  logEl.innerHTML = sorted.map((r) => {
    const child = children.find((c) => c.id === r.childId) || { name: '(不明)' };
    const date = new Date(r.redeemedAt).toLocaleString('ja-JP');
    return `<div class="list-item row-between"><span>${escapeHtml(child.name)}: ${escapeHtml(r.rewardName)}</span><span class="muted">-${r.cost}P (${date})</span></div>`;
  }).join('');
}

async function toggleRewardActive(id, active) {
  await apiPatch(`/api/rewards/${id}`, { active });
  loadRewards();
}

async function deleteReward(id) {
  const ok = await askConfirm('このご褒美を削除しますか？');
  if (!ok) return;
  await apiDelete(`/api/rewards/${id}`);
  loadRewards();
}

// ---------- Settings ----------

async function changePin() {
  const currentPin = document.getElementById('current-pin').value;
  const newPin = document.getElementById('new-pin').value;
  const res = await apiPatch('/api/settings/pin', { currentPin, newPin });
  if (res.ok) {
    sessionStorage.setItem('parentPin', newPin);
    showToast('PINを変更しました');
    document.getElementById('current-pin').value = '';
    document.getElementById('new-pin').value = '';
  } else {
    showToast(res.error || '変更に失敗しました');
  }
}
