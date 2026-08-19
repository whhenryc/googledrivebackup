(() => {
  const state = {
    currentStep: 1,
    source: null, // { id, name }
    dest: null,   // { id, name }
    accountEmail: null,
  };

  const el = (id) => document.getElementById(id);

  const railSteps = [...document.querySelectorAll('.rail-step')];
  const stepSections = {
    1: el('step1'), 2: el('step2'), 3: el('step3'), 4: el('step4'),
  };

  function goToStep(n) {
    state.currentStep = n;
    for (const [num, section] of Object.entries(stepSections)) {
      section.dataset.active = String(Number(num) === n);
    }
    railSteps.forEach((li) => {
      const num = Number(li.dataset.step);
      if (num < n) li.dataset.state = 'done';
      else if (num === n) li.dataset.state = 'active';
      else li.dataset.state = 'pending';
    });
  }

  // ---------- Step 1: auth ----------

  async function checkAuth() {
    const res = await fetch('/auth/status');
    const data = await res.json();
    if (data.authenticated) {
      state.accountEmail = data.email;
      el('accountBadge').hidden = false;
      el('accountEmail').textContent = data.email;
      el('destEmailHint').textContent = data.email;
      if (state.currentStep === 1) goToStep(2);
    }
    return data.authenticated;
  }

  el('logoutBtn').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    window.location.href = '/';
  });

  // ---------- Step 2: source folder ----------

  async function resolveFolder(inputId, resolvedId, errorId) {
    const input = el(inputId).value.trim();
    const resolvedEl = el(resolvedId);
    const errorEl = el(errorId);
    resolvedEl.hidden = true;
    errorEl.hidden = true;

    if (!input) {
      errorEl.textContent = '請輸入資料夾連結或 ID';
      errorEl.hidden = false;
      return null;
    }

    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || '驗證失敗';
        errorEl.hidden = false;
        return null;
      }
      resolvedEl.textContent = `已確認資料夾： ${data.name}`;
      resolvedEl.hidden = false;
      return data;
    } catch (err) {
      errorEl.textContent = '網路錯誤，請重試';
      errorEl.hidden = false;
      return null;
    }
  }

  el('resolveSourceBtn').addEventListener('click', async () => {
    const data = await resolveFolder('sourceInput', 'sourceResolved', 'sourceError');
    if (data) {
      state.source = data;
      el('toStep3Btn').disabled = false;
    } else {
      state.source = null;
      el('toStep3Btn').disabled = true;
    }
  });

  el('toStep3Btn').addEventListener('click', () => goToStep(3));

  // ---------- Step 3: dest folder ----------

  el('resolveDestBtn').addEventListener('click', async () => {
    const data = await resolveFolder('destInput', 'destResolved', 'destError');
    if (data) {
      state.dest = data;
      el('toStep4Btn').disabled = false;
    } else {
      state.dest = null;
      el('toStep4Btn').disabled = true;
    }
  });

  el('toStep4Btn').addEventListener('click', () => {
    el('summarySource').textContent = `${state.source.name}  (${state.source.id})`;
    el('summaryDest').textContent = `${state.dest.name}  (${state.dest.id})`;
    goToStep(4);
  });

  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => goToStep(Number(btn.dataset.back)));
  });

  // ---------- Step 4: run copy ----------

  const ICONS = { folder: '▸', file: '·', skip: '×', start: '▸', done: '✓', error: '!' };

  function appendLogRow(evt) {
    const body = el('manifestBody');
    const row = document.createElement('div');
    row.className = `manifest-row ${evt.type}`;
    const time = new Date(evt.ts).toLocaleTimeString('zh-HK', { hour12: false });
    const indent = '　'.repeat(evt.depth || 0);
    let label = '';
    if (evt.type === 'folder') label = `${indent}${evt.name}/`;
    else if (evt.type === 'file') label = `${indent}${evt.name}`;
    else if (evt.type === 'skip') label = `${indent}${evt.name}（略過：${evt.reason}）`;
    else if (evt.type === 'start') label = `開始搬運 → ${evt.rootName}`;
    else if (evt.type === 'done') label = `全部完成`;
    else if (evt.type === 'error') label = `發生錯誤：${evt.message}`;

    row.innerHTML = `<span class="row-time">${time}</span><span class="row-icon">${ICONS[evt.type] || '·'}</span><span class="row-name">${escapeHtml(label)}</span>`;
    body.appendChild(row);
    body.scrollTop = body.scrollHeight;
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  el('startCopyBtn').addEventListener('click', async () => {
    el('preRunActions').hidden = true;
    el('manifest').hidden = false;
    el('manifestBody').innerHTML = '';
    el('statFolders').textContent = '0';
    el('statFiles').textContent = '0';
    el('statSkipped').textContent = '0';
    el('pulseDot').style.display = '';
    el('manifestStatusText').textContent = '搬運中…';

    const res = await fetch('/api/copy/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceFolderId: state.source.id,
        destParentId: state.dest.id,
        newName: el('newNameInput').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      el('manifestStatusText').textContent = '啟動失敗';
      appendLogRow({ type: 'error', ts: Date.now(), message: data.error || '未知錯誤' });
      return;
    }

    const evtSource = new EventSource(`/api/copy/stream/${data.jobId}`);
    evtSource.onmessage = (msg) => {
      const evt = JSON.parse(msg.data);
      if (evt.type === 'folder' || evt.type === 'file' || evt.type === 'skip' || evt.type === 'start') {
        appendLogRow(evt);
      }
      if (evt.stats) {
        el('statFolders').textContent = evt.stats.folders;
        el('statFiles').textContent = evt.stats.files;
        el('statSkipped').textContent = evt.stats.skipped;
      }
      if (evt.type === 'done') {
        appendLogRow(evt);
        el('pulseDot').style.display = 'none';
        el('manifestStatusText').textContent = '已完成';
        evtSource.close();
        showResult(true, evt);
      } else if (evt.type === 'error') {
        appendLogRow(evt);
        el('pulseDot').style.display = 'none';
        el('manifestStatusText').textContent = '失敗';
        evtSource.close();
        showResult(false, evt);
      }
    };
    evtSource.onerror = () => {
      // SSE 連線中斷（例如網路波動），保留現有 log，唔強行判定失敗
      el('manifestStatusText').textContent = '連線中斷 — 檢查中…';
    };
  });

  function showResult(success, evt) {
    const card = el('resultCard');
    card.hidden = false;
    if (success) {
      el('resultTitle').textContent = '搬運完成';
      el('resultDetail').textContent = `已複製 ${evt.stats.folders} 個資料夾、${evt.stats.files} 個檔案${evt.stats.skipped ? `，略過 ${evt.stats.skipped} 個捷徑` : ''}。`;
      el('openDriveBtn').href = `https://drive.google.com/drive/folders/${evt.newRootId}`;
      el('openDriveBtn').hidden = false;
    } else {
      el('resultTitle').textContent = '搬運失敗';
      el('resultTitle').style.color = 'var(--err)';
      el('resultDetail').textContent = evt.message || '發生未知錯誤，請查看上面嘅記錄。';
      el('openDriveBtn').hidden = true;
    }
  }

  el('restartBtn').addEventListener('click', () => {
    window.location.href = '/';
  });

  // ---------- Init ----------

  (async () => {
    const authed = await checkAuth();
    if (!authed) goToStep(1);
  })();
})();
