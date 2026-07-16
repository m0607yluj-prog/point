async function apiGet(url) {
  const res = await fetch(url);
  return res.json();
}

async function apiSend(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'エラーが発生しました');
  return data;
}

const apiPost = (url, body) => apiSend('POST', url, body);
const apiPatch = (url, body) => apiSend('PATCH', url, body);
async function apiDelete(url) {
  const res = await fetch(url, { method: 'DELETE' });
  return res.json();
}

function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.display = 'block';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.display = 'none'; }, 2600);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// Custom confirm modal (avoids native confirm(), which some mobile browsers
// block or render inconsistently, and looks nicer for kids).
function askConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="card">
        <p>${escapeHtml(message)}</p>
        <div class="btn-row">
          <button class="btn secondary" data-choice="cancel">キャンセル</button>
          <button class="btn pink" data-choice="ok">OK</button>
        </div>
      </div>
    `;
    overlay.addEventListener('click', (e) => {
      const choice = e.target.dataset.choice;
      if (choice) {
        document.body.removeChild(overlay);
        resolve(choice === 'ok');
      }
    });
    document.body.appendChild(overlay);
  });
}

// Custom prompt modal for a single number input.
function askNumber(message, defaultValue) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="card">
        <p>${escapeHtml(message)}</p>
        <input type="number" id="ask-number-input" value="${defaultValue != null ? defaultValue : ''}" />
        <div class="btn-row">
          <button class="btn secondary" data-choice="cancel">キャンセル</button>
          <button class="btn" data-choice="ok">OK</button>
        </div>
      </div>
    `;
    const finish = (value) => {
      document.body.removeChild(overlay);
      resolve(value);
    };
    overlay.addEventListener('click', (e) => {
      const choice = e.target.dataset.choice;
      if (choice === 'cancel') finish(null);
      if (choice === 'ok') {
        const val = document.getElementById('ask-number-input').value;
        finish(val === '' ? null : Number(val));
      }
    });
    document.body.appendChild(overlay);
    document.getElementById('ask-number-input').focus();
  });
}
