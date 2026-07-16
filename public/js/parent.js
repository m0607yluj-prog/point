let choiceFieldCount = 0;

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
        <button class="btn small secondary" onclick="deleteChild(${c.id}, '${escapeHtml(c.name)}')">削除</button>
      </div>
    `).join('');
  }
  populateAdhocChildSelect(children);
}

function populateAdhocChildSelect(children) {
  const select = document.getElementById('new-adhoc-chore-child');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">誰でもOK</option>' +
    children.map((c) => `<option value="${c.id}">${escapeHtml(c.avatar)} ${escapeHtml(c.name)}</option>`).join('');
  select.value = current;
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
  const payload = { type, question, points };

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
    showToast('問題を登録しました');
    loadQuestions();
  } catch (e) { showToast(e.message); }
}

async function loadQuestions() {
  const questions = await apiGet('/api/questions');
  const el = document.getElementById('questions-list');
  if (questions.length === 0) {
    el.innerHTML = '<p class="muted">まだ問題がありません。</p>';
    return;
  }
  el.innerHTML = questions.map((q) => `
    <div class="list-item">
      <div class="row-between">
        <span>${escapeHtml(q.question)} <span class="muted">(${q.type === 'choice' ? '選択式' : '記述式'} / ${q.points}P)</span></span>
        <span>
          <button class="btn small secondary" onclick="toggleQuestionActive(${q.id}, ${!q.active})">${q.active ? '非公開にする' : '公開する'}</button>
          <button class="btn small secondary" onclick="deleteQuestion(${q.id})">削除</button>
        </span>
      </div>
      ${q.type === 'choice' ? `<div class="muted">選択肢: ${q.choices.map((c, i) => (i === q.correctIndex ? `✅${escapeHtml(c)}` : escapeHtml(c))).join(' / ')}</div>` : ''}
    </div>
  `).join('');
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
    const q = questions.find((x) => x.id === a.questionId) || { question: '(削除された問題)', correctAnswer: '' };
    return `
      <div class="list-item">
        <div>${escapeHtml(child.name)} さんの回答</div>
        <div><strong>問題:</strong> ${escapeHtml(q.question)}</div>
        ${q.correctAnswer ? `<div class="muted">参考正解: ${escapeHtml(q.correctAnswer)}</div>` : ''}
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

// ---------- Chores (お手伝い) ----------

async function addRoutineChore() {
  const name = document.getElementById('new-routine-chore-name').value;
  const points = document.getElementById('new-routine-chore-points').value;
  if (!name.trim()) { showToast('お手伝いの名前を入力してください'); return; }
  try {
    await apiPost('/api/chores', { name, type: 'routine', points });
    document.getElementById('new-routine-chore-name').value = '';
    showToast('追加しました');
    loadChores();
  } catch (e) { showToast(e.message); }
}

async function addAdhocChore() {
  const name = document.getElementById('new-adhoc-chore-name').value;
  const points = document.getElementById('new-adhoc-chore-points').value;
  const assignedChildId = document.getElementById('new-adhoc-chore-child').value;
  if (!name.trim()) { showToast('お手伝いの名前を入力してください'); return; }
  try {
    await apiPost('/api/chores', { name, type: 'adhoc', points, assignedChildId: assignedChildId || null });
    document.getElementById('new-adhoc-chore-name').value = '';
    showToast('依頼しました');
    loadChores();
  } catch (e) { showToast(e.message); }
}

async function loadChores() {
  const [chores, children] = await Promise.all([apiGet('/api/chores'), apiGet('/api/children')]);
  populateAdhocChildSelect(children);

  const el = document.getElementById('chores-list');
  if (chores.length === 0) {
    el.innerHTML = '<p class="muted">まだお手伝いが登録されていません。</p>';
  } else {
    el.innerHTML = chores.map((c) => {
      const assignedChild = children.find((x) => x.id === c.assignedChildId);
      const typeLabel = c.type === 'routine' ? '定型' : '随時';
      const targetLabel = c.type === 'adhoc' ? (assignedChild ? `${escapeHtml(assignedChild.name)}へ依頼` : '誰でもOK') : '';
      return `
        <div class="list-item row-between">
          <span>${escapeHtml(c.name)} <span class="muted">(${typeLabel} / ${c.points}P${targetLabel ? ' / ' + targetLabel : ''})</span></span>
          <span>
            <button class="btn small secondary" onclick="toggleChoreActive(${c.id}, ${!c.active})">${c.active ? '非公開にする' : '公開する'}</button>
            <button class="btn small secondary" onclick="deleteChore(${c.id})">削除</button>
          </span>
        </div>
      `;
    }).join('');
  }

  loadChoreApprovals(children);
}

async function loadChoreApprovals(children) {
  const pending = await apiGet('/api/chore-logs?status=pending');
  const el = document.getElementById('chore-approval-list');
  if (pending.length === 0) {
    el.innerHTML = '<p class="muted">承認待ちのお手伝いはありません。</p>';
    return;
  }
  el.innerHTML = pending.map((l) => {
    const child = children.find((c) => c.id === l.childId) || { name: '(不明)' };
    return `
      <div class="list-item">
        <div>${escapeHtml(child.name)} さんが「${escapeHtml(l.choreName)}」を報告しました</div>
        <div class="btn-row">
          <button class="btn green small" onclick="gradeChore(${l.id}, true)">承認してポイント付与</button>
          <button class="btn pink small" onclick="gradeChore(${l.id}, false)">やり直し</button>
        </div>
      </div>
    `;
  }).join('');
}

async function toggleChoreActive(id, active) {
  await apiPatch(`/api/chores/${id}`, { active });
  loadChores();
}

async function deleteChore(id) {
  const ok = await askConfirm('このお手伝いを削除しますか？');
  if (!ok) return;
  await apiDelete(`/api/chores/${id}`);
  loadChores();
}

async function gradeChore(id, approved) {
  await apiPatch(`/api/chore-logs/${id}/grade`, { approved });
  showToast(approved ? 'ポイントを付与しました' : 'やり直しにしました');
  loadChores();
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
