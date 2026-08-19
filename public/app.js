(() => {
  const state = {
    currentStep: 1,
    source: null, // { id, name }
    dest: null,   // { id, name }
    accountEmail: null,
    mode: 'copy',
    totalBytes: 0,
    bytesSamples: [], // { t, bytes } — 用嚟計算即時速度
  };

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 60) return '少於 1 分鐘';
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    if (h > 0) return `約 ${h} 小時 ${m} 分鐘`;
    return `約 ${m} 分鐘`;
  }

  function resetProgressState() {
    state.totalBytes = 0;
    state.bytesSamples = [];
    el('progressWrap').hidden = true;
    el('progressBarFill').style.width = '0%';
    el('progressPercent').textContent = '0%';
    el('progressSize').textContent = '—';
    el('progressSpeed').textContent = '—';
    el('progressEta').textContent = '—';
    el('scanStatus').hidden = true;
  }

  function updateProgress(bytesDone) {
    if (!state.totalBytes) return;
    const pct = Math.min(100, (bytesDone / state.totalBytes) * 100);
    el('progressBarFill').style.width = `${pct}%`;
    el('progressPercent').textContent = `${pct.toFixed(1)}%`;
    el('progressSize').textContent = `${formatBytes(bytesDone)} / ${formatBytes(state.totalBytes)}`;

    const now = Date.now();
    state.bytesSamples.push({ t: now, bytes: bytesDone });
    // 只保留最近 20 秒嘅樣本嚟計即時速度，太舊嘅去晒佢
    while (state.bytesSamples.length > 1 && now - state.bytesSamples[0].t > 20000) {
      state.bytesSamples.shift();
    }

    if (state.bytesSamples.length >= 2) {
      const oldest = state.bytesSamples[0];
      const dt = (now - oldest.t) / 1000;
      const db = bytesDone - oldest.bytes;
      if (dt > 1 && db > 0) {
        const speed = db / dt;
        el('progressSpeed').textContent = `${formatBytes(speed)}/s`;
        const remaining = state.totalBytes - bytesDone;
        el('progressEta').textContent = remaining > 0 ? formatDuration(remaining / speed) : '即將完成';
      }
    }
  }

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

  // ---------- Resumable jobs ----------

  const STATUS_LABEL = {
    interrupted: '中斷咗',
    error: '失敗咗',
    running: '搬運中',
    done: '已完成',
    cancelled: '已取消',
  };

  async function loadResumableJobs() {
    try {
      const res = await fetch('/api/jobs');
      if (!res.ok) return;
      const { jobs } = await res.json();
      const resumable = jobs.filter((j) => j.status === 'interrupted' || j.status === 'error');
      renderResumeBanner(resumable);
    } catch (err) {
      // 靜默失敗，唔阻住主流程
    }
  }

  function renderResumeBanner(jobsList) {
    const banner = el('resumeBanner');
    const list = el('resumeList');
    if (!jobsList.length) {
      banner.hidden = true;
      list.innerHTML = '';
      return;
    }
    banner.hidden = false;
    list.innerHTML = '';
    for (const j of jobsList) {
      const row = document.createElement('div');
      row.className = 'resume-item';
      const name = j.new_root_name || j.source_folder_id;
      const statusClass = j.status === 'error' ? 'status-error' : '';
      const modeLabel = j.mode === 'sync' ? '同步' : '複製';
      row.innerHTML = `
        <div class="resume-item-info">
          <span class="resume-item-name">[${modeLabel}] ${escapeHtml(name)}</span>
          <span class="resume-item-meta ${statusClass}">${STATUS_LABEL[j.status] || j.status} · 已完成 ${j.folders_count} 個資料夾、${j.files_count} 個檔案${j.updated_count ? `、${j.updated_count} 個已更新` : ''}${j.error_message ? ' · ' + escapeHtml(j.error_message) : ''}</span>
        </div>
        <div class="resume-item-actions">
          <button class="btn btn-primary btn-sm" data-resume-id="${j.id}">繼續搬運</button>
        </div>
      `;
      list.appendChild(row);
    }
    list.querySelectorAll('[data-resume-id]').forEach((btn) => {
      btn.addEventListener('click', () => resumeJob(btn.dataset.resumeId));
    });
  }

  async function resumeJob(jobId) {
    const res = await fetch(`/api/copy/resume/${jobId}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || '繼續失敗');
      return;
    }
    goToStep(4);
    el('preRunActions').hidden = true;
    el('resultCard').hidden = true;
    el('manifest').hidden = false;
    el('manifestBody').innerHTML = '';
    el('statFolders').textContent = '0';
    el('statFiles').textContent = '0';
    el('statSkipped').textContent = '0';
    el('statUpdated').textContent = '0';
    el('statUnchanged').textContent = '0';
    el('pulseDot').style.display = '';
    el('manifestStatusText').textContent = '繼續搬運中…';
    resetProgressState();
    subscribeToJob(jobId);
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
    el('summaryMode').textContent = state.mode === 'sync' ? '同步更新（覆寫已變更檔案）' : '完整複製（建立新資料夾）';
    el('summarySource').textContent = `${state.source.name}  (${state.source.id})`;
    el('summaryDest').textContent = `${state.dest.name}  (${state.dest.id})`;
    goToStep(4);
  });

  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => goToStep(Number(btn.dataset.back)));
  });

  // ---------- Mode toggle ----------

  document.querySelectorAll('#modeToggle .mode-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll('#modeToggle .mode-option').forEach((b) => {
        b.setAttribute('aria-pressed', String(b === btn));
      });
      const isSync = state.mode === 'sync';
      el('newNameField').hidden = isSync;
      el('syncNote').hidden = !isSync;
      el('destLede').textContent = isSync
        ? '揀一個已經存在嘅資料夾作為同步目的地——內容會直接落喺呢個資料夾入面，唔會另外包一層。'
        : '揀已連結帳戶入面邊個資料夾作為存放位置。輸入 root 代表 My Drive 最頂層。';
    });
  });

  // ---------- Step 4: run copy ----------

  const ICONS = { folder: '▸', file: '·', update: '↻', skip: '×', start: '▸', done: '✓', error: '!' };
  function appendLogRow(evt) {
    const body = el('manifestBody');
    const row = document.createElement('div');
    row.className = `manifest-row ${evt.type}`;
    const time = new Date(evt.ts).toLocaleTimeString('zh-HK', { hour12: false });
    const indent = '　'.repeat(evt.depth || 0);
    let label = '';
    if (evt.type === 'folder') label = `${indent}${evt.name}/`;
    else if (evt.type === 'file') label = `${indent}${evt.name}`;
    else if (evt.type === 'update') label = `${indent}${evt.name}（覆寫較新版本）`;
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
    el('statUpdated').textContent = '0';
    el('statUnchanged').textContent = '0';
    el('pulseDot').style.display = '';
    el('manifestStatusText').textContent = '搬運中…';
    resetProgressState();

    const res = await fetch('/api/copy/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceFolderId: state.source.id,
        destParentId: state.dest.id,
        newName: el('newNameInput').value,
        mode: state.mode,
        scanSize: el('scanSizeToggle').checked,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      el('manifestStatusText').textContent = '啟動失敗';
      appendLogRow({ type: 'error', ts: Date.now(), message: data.error || '未知錯誤' });
      return;
    }
    subscribeToJob(data.jobId);
  });

  function updateStatEls(stats) {
    if (!stats) return;
    if (stats.folders !== undefined) el('statFolders').textContent = stats.folders;
    if (stats.files !== undefined) el('statFiles').textContent = stats.files;
    if (stats.skipped !== undefined) el('statSkipped').textContent = stats.skipped;
    if (stats.updated !== undefined) el('statUpdated').textContent = stats.updated;
    if (stats.unchanged !== undefined) el('statUnchanged').textContent = stats.unchanged;
  }

  function subscribeToJob(jobId) {
    const evtSource = new EventSource(`/api/copy/stream/${jobId}`);
    evtSource.onmessage = (msg) => {
      const evt = JSON.parse(msg.data);

      if (evt.type === 'snapshot') {
        updateStatEls(evt.stats);
        if (evt.totalBytes) {
          state.totalBytes = evt.totalBytes;
          el('progressWrap').hidden = false;
          updateProgress(evt.bytesDone || 0);
        }
        if (evt.scanStatus === 'scanning') {
          el('scanStatus').hidden = false;
        }
        return;
      }

      if (evt.type === 'scan-start') {
        el('scanStatus').hidden = false;
        el('scanStatusText').textContent = '掃描緊來源資料夾…';
        return;
      }

      if (evt.type === 'scan-progress') {
        el('scanStatusText').textContent = `掃描緊來源資料夾… 已發現 ${evt.folders} 個資料夾、${evt.files} 個檔案、${formatBytes(evt.bytes)}`;
        return;
      }

      if (evt.type === 'scan-done') {
        el('scanStatus').hidden = true;
        state.totalBytes = evt.totalBytes || 0;
        if (state.totalBytes > 0) {
          el('progressWrap').hidden = false;
          updateProgress(0);
        }
        appendLogRow({
          type: 'folder',
          ts: evt.ts,
          depth: 0,
          name: `${evt.cached ? '（沿用之前嘅掃描結果）' : '掃描完成'}：共 ${evt.totalFolders} 個資料夾、${evt.totalFiles} 個檔案、${formatBytes(evt.totalBytes)}`,
        });
        return;
      }

      if (evt.type === 'start' && evt.resumed) {
        appendLogRow({
          type: 'folder',
          ts: evt.ts,
          depth: 0,
          name: evt.prevStats
            ? `繼續之前嘅工作（之前已完成 ${evt.prevStats.folders} 個資料夾、${evt.prevStats.files} 個檔案）…`
            : `繼續同步…`,
        });
      } else if (evt.type === 'folder' || evt.type === 'file' || evt.type === 'update' || evt.type === 'skip' || (evt.type === 'start' && !evt.resumed)) {
        appendLogRow(evt);
      }

      updateStatEls(evt.stats);
      if (evt.bytesDone !== undefined) updateProgress(evt.bytesDone);

      if (evt.type === 'done') {
        appendLogRow(evt);
        el('pulseDot').style.display = 'none';
        el('manifestStatusText').textContent = '已完成';
        if (evt.bytesDone !== undefined) updateProgress(evt.bytesDone);
        evtSource.close();
        showResult(true, evt);
      } else if (evt.type === 'error') {
        appendLogRow(evt);
        el('pulseDot').style.display = 'none';
        el('manifestStatusText').textContent = '失敗（可以喺頁面頂部「繼續搬運」再試）';
        evtSource.close();
        showResult(false, evt);
      } else if (evt.type === 'cancelled') {
        el('pulseDot').style.display = 'none';
        el('manifestStatusText').textContent = '已取消';
        evtSource.close();
      }
    };
    evtSource.onerror = () => {
      el('manifestStatusText').textContent = '連線中斷 — 搬運喺伺服器繼續進行，重新整理頁面可以再睇返進度';
    };
  }

  function showResult(success, evt) {
    const card = el('resultCard');
    card.hidden = false;
    if (success) {
      el('resultTitle').textContent = '搬運完成';
      const parts = [`${evt.stats.folders} 個資料夾`, `${evt.stats.files} 個新檔案`];
      if (evt.stats.updated) parts.push(`${evt.stats.updated} 個已更新`);
      if (evt.stats.unchanged) parts.push(`${evt.stats.unchanged} 個已係最新`);
      if (evt.stats.skipped) parts.push(`略過 ${evt.stats.skipped} 個捷徑`);
      el('resultDetail').textContent = `已處理：${parts.join('、')}。`;
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
    if (authed) await loadResumableJobs();
  })();
})();
