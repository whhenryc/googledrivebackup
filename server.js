/**
 * server.js — Google Drive 資料夾伺服器端複製工具（Web UI 版）
 * 支援：斷點續傳、同步更新模式（Sync）、掃描預估總量 + 速度/ETA
 *
 * 全部複製都經 Google Drive API 的 files.copy 完成，
 * 資料喺 Google 伺服器內部搬移，唔會下載到呢個 app 所在嘅主機，
 * 更加唔會落地使用者部電腦。
 *
 * 開始真正複製之前，會先做一次輕量掃描（只讀 metadata，唔會落地內容），
 * 攞到來源資料夾嘅總資料夾數、總檔案數、總大小，畀前端計算進度、
 * 即時速度同預計完成時間。
 *
 * 「同步更新」模式：目的地已有同名檔案時，比較 modifiedTime，
 * 較新先覆寫（做法：將舊檔案移入垃圾桶，再用 files.copy 複製一份新嘅，
 * 並且保留來源嘅原始修改時間）。
 */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const { google } = require('googleapis');
const { EventEmitter } = require('events');
const store = require('./db');

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  SESSION_SECRET,
  PORT = 3000,
} = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
  console.error('缺少 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI，請檢查 .env');
  process.exit(1);
}

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

const orphaned = store.markOrphanedJobsInterrupted();
if (orphaned > 0) {
  console.log(`發現 ${orphaned} 個上次未完成嘅搬運工作，已標示為 interrupted，可以喺畫面繼續。`);
}

const app = express();
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12, sameSite: 'lax' },
  })
);
app.use(express.static('public'));

// ---------- OAuth helpers ----------

function newOAuthClient() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

function getAuthedClient(req) {
  if (!req.session.tokens) return null;
  const client = newOAuthClient();
  client.setCredentials(req.session.tokens);
  client.on('tokens', (tokens) => {
    req.session.tokens = { ...req.session.tokens, ...tokens };
  });
  return client;
}

function requireAuth(req, res, next) {
  const client = getAuthedClient(req);
  if (!client) return res.status(401).json({ error: '未授權，請先連結 Google 帳戶' });
  req.driveAuth = client;
  next();
}

// ---------- Auth routes ----------

app.get('/auth/status', async (req, res) => {
  const client = getAuthedClient(req);
  if (!client) return res.json({ authenticated: false });
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    res.json({ authenticated: true, email: data.email, name: data.name });
  } catch (err) {
    res.json({ authenticated: false });
  }
});

app.get('/auth/google', (req, res) => {
  const client = newOAuthClient();
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...SCOPES, 'https://www.googleapis.com/auth/userinfo.email'],
    state,
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || state !== req.session.oauthState) {
    return res.status(400).send('授權失敗（state 不符或缺少 code），請返回重試。');
  }
  try {
    const client = newOAuthClient();
    const { tokens } = await client.getToken(code);
    req.session.tokens = tokens;
    res.redirect('/?connected=1');
  } catch (err) {
    console.error(err);
    res.status(500).send('授權交換 token 失敗：' + err.message);
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- Folder resolve ----------

function extractFolderId(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;
  if (trimmed === 'root') return 'root';
  const match = trimmed.match(/[-\w]{25,}/);
  return match ? match[0] : trimmed;
}

app.post('/api/resolve', requireAuth, async (req, res) => {
  const folderId = extractFolderId(req.body.input);
  if (!folderId) return res.status(400).json({ error: '請輸入資料夾連結或 ID' });

  const drive = google.drive({ version: 'v3', auth: req.driveAuth });
  try {
    if (folderId === 'root') {
      return res.json({ id: 'root', name: 'My Drive（最頂層）', mimeType: FOLDER_MIME });
    }
    const { data } = await drive.files.get({
      fileId: folderId,
      fields: 'id, name, mimeType, capabilities(canAddChildren)',
      supportsAllDrives: true,
    });
    if (data.mimeType !== FOLDER_MIME) {
      return res.status(400).json({ error: '呢個唔係一個資料夾，請確認連結。' });
    }
    res.json({ id: data.id, name: data.name, mimeType: data.mimeType });
  } catch (err) {
    const msg = err.code === 404
      ? '搵唔到呢個資料夾，或者目前帳戶未有權限存取（記得先分享畀呢個帳戶）。'
      : '讀取資料夾失敗：' + err.message;
    res.status(400).json({ error: msg });
  }
});

// ---------- Copy / Sync job engine ----------

const activeJobs = new Map(); // jobId -> { emitter, cancelled, bytesDone }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = err.code || (err.response && err.response.status);
      if ((code === 429 || code === 500 || code === 503) && i < retries - 1) {
        await sleep(1000 * Math.pow(2, i));
        continue;
      }
      throw err;
    }
  }
}

async function listChildren(drive, folderId) {
  let files = [];
  let pageToken = null;
  do {
    const res = await withRetry(() =>
      drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size)',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })
    );
    files = files.concat(res.data.files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

function itemSize(item) {
  return item.size ? parseInt(item.size, 10) : 0;
}

async function createFolder(drive, name, parentId) {
  const res = await withRetry(() =>
    drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
      fields: 'id, name',
      supportsAllDrives: true,
    })
  );
  return res.data;
}

async function copyFile(drive, fileId, name, parentId, modifiedTime) {
  const requestBody = { name, parents: [parentId] };
  if (modifiedTime) requestBody.modifiedTime = modifiedTime;
  const res = await withRetry(() =>
    drive.files.copy({
      fileId,
      requestBody,
      fields: 'id, name',
      supportsAllDrives: true,
    })
  );
  return res.data;
}

async function trashFile(drive, fileId) {
  await withRetry(() =>
    drive.files.update({
      fileId,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    })
  );
}

function emitEvent(active, type, payload) {
  const evt = { type, ts: Date.now(), ...payload };
  active.emitter.emit('event', evt);
}

function addBytes(jobId, active, bytes) {
  if (!bytes) return;
  store.addBytesDone(jobId, bytes);
  active.bytesDone += bytes;
}

// ---- 掃描階段：只讀 metadata，唔碰內容，攞返總資料夾/檔案數同總大小 ----
async function scanFolderRecursive(jobId, active, drive, folderId, counters) {
  if (active.cancelled) return;
  const children = await listChildren(drive, folderId);

  const now = Date.now();
  for (const item of children) {
    if (active.cancelled) return;
    if (item.mimeType === FOLDER_MIME) {
      counters.folders += 1;
      await scanFolderRecursive(jobId, active, drive, item.id, counters);
    } else if (item.mimeType !== SHORTCUT_MIME) {
      counters.files += 1;
      counters.bytes += itemSize(item);
    }
  }

  if (Date.now() - counters.lastEmit > 400) {
    counters.lastEmit = Date.now();
    emitEvent(active, 'scan-progress', { folders: counters.folders, files: counters.files, bytes: counters.bytes });
  }
}

// ---- 模式一：完整複製（每次喺目標位置建立新資料夾，唔理會目的地有咩） ----
async function copyFolderRecursive(jobId, active, drive, sourceFolderId, destFolderId, depth) {
  if (active.cancelled) return;
  const children = await listChildren(drive, sourceFolderId);

  for (const item of children) {
    if (active.cancelled) return;

    if (item.mimeType === FOLDER_MIME) {
      let destChildId = store.getFolderMapping(jobId, item.id);
      if (!destChildId) {
        const newFolder = await createFolder(drive, item.name, destFolderId);
        destChildId = newFolder.id;
        store.addFolderMapping(jobId, item.id, destChildId);
        store.touchJobStats(jobId, { folders: 1 });
        emitEvent(active, 'folder', { name: item.name, depth, bytesDone: active.bytesDone });
      }
      await copyFolderRecursive(jobId, active, drive, item.id, destChildId, depth + 1);
    } else if (item.mimeType === SHORTCUT_MIME) {
      if (!store.isSkipped(jobId, item.id)) {
        store.markSkipped(jobId, item.id);
        store.touchJobStats(jobId, { skipped: 1 });
        emitEvent(active, 'skip', { name: item.name, depth, reason: 'shortcut', bytesDone: active.bytesDone });
      }
    } else {
      if (!store.isFileCopied(jobId, item.id)) {
        await copyFile(drive, item.id, item.name, destFolderId, item.modifiedTime);
        store.markFileCopied(jobId, item.id);
        store.touchJobStats(jobId, { files: 1 });
        addBytes(jobId, active, itemSize(item));
        emitEvent(active, 'file', { name: item.name, depth, size: itemSize(item), bytesDone: active.bytesDone });
      }
    }
  }
}

// ---- 模式二：同步更新（目的地已有同名項目時，按 modifiedTime 判斷是否覆寫） ----
async function syncFolderRecursive(jobId, active, drive, sourceFolderId, destFolderId, depth) {
  if (active.cancelled) return;

  const [sourceChildren, destChildren] = await Promise.all([
    listChildren(drive, sourceFolderId),
    listChildren(drive, destFolderId),
  ]);

  const destByName = new Map();
  for (const d of destChildren) {
    if (!destByName.has(d.name)) destByName.set(d.name, d);
  }

  for (const item of sourceChildren) {
    if (active.cancelled) return;
    const existing = destByName.get(item.name);

    if (item.mimeType === FOLDER_MIME) {
      let destChildId;
      if (existing && existing.mimeType === FOLDER_MIME) {
        destChildId = existing.id;
      } else {
        const newFolder = await createFolder(drive, item.name, destFolderId);
        destChildId = newFolder.id;
        store.touchJobStats(jobId, { folders: 1 });
        emitEvent(active, 'folder', { name: item.name, depth, bytesDone: active.bytesDone });
      }
      store.addFolderMapping(jobId, item.id, destChildId);
      await syncFolderRecursive(jobId, active, drive, item.id, destChildId, depth + 1);
    } else if (item.mimeType === SHORTCUT_MIME) {
      if (!store.isSkipped(jobId, item.id)) {
        store.markSkipped(jobId, item.id);
        store.touchJobStats(jobId, { skipped: 1 });
        emitEvent(active, 'skip', { name: item.name, depth, reason: 'shortcut', bytesDone: active.bytesDone });
      }
    } else {
      const size = itemSize(item);
      if (!existing) {
        await copyFile(drive, item.id, item.name, destFolderId, item.modifiedTime);
        store.markFileCopied(jobId, item.id);
        store.touchJobStats(jobId, { files: 1 });
        addBytes(jobId, active, size);
        emitEvent(active, 'file', { name: item.name, depth, size, bytesDone: active.bytesDone });
      } else {
        const sourceTime = new Date(item.modifiedTime).getTime();
        const destTime = new Date(existing.modifiedTime).getTime();
        if (sourceTime > destTime) {
          await trashFile(drive, existing.id);
          await copyFile(drive, item.id, item.name, destFolderId, item.modifiedTime);
          store.markFileCopied(jobId, item.id);
          store.touchJobStats(jobId, { updated: 1 });
          addBytes(jobId, active, size);
          emitEvent(active, 'update', { name: item.name, depth, size, bytesDone: active.bytesDone });
        } else {
          store.touchJobStats(jobId, { unchanged: 1 });
          addBytes(jobId, active, size);
        }
      }
    }
  }
}

async function runCopyJob(jobId, oauthClient) {
  const job0 = store.getJob(jobId);
  const active = {
    emitter: new EventEmitter(),
    cancelled: false,
    bytesDone: job0.bytes_done || 0,
  };
  active.emitter.setMaxListeners(50);
  activeJobs.set(jobId, active);

  const drive = google.drive({ version: 'v3', auth: oauthClient });

  try {
    // ---- 掃描階段（只做一次；resume 嘅時候如果之前已經掃描完就跳過）----
    if (job0.scan_status !== 'done') {
      store.setScanStatus(jobId, 'scanning');
      emitEvent(active, 'scan-start', {});
      const counters = { folders: 1, files: 0, bytes: 0, lastEmit: 0 };
      await scanFolderRecursive(jobId, active, drive, job0.source_folder_id, counters);
      store.setJobTotals(jobId, counters);
      store.setScanStatus(jobId, 'done');
      emitEvent(active, 'scan-done', { totalFolders: counters.folders, totalFiles: counters.files, totalBytes: counters.bytes });
    } else {
      emitEvent(active, 'scan-done', {
        totalFolders: job0.total_folders,
        totalFiles: job0.total_files,
        totalBytes: job0.total_bytes,
        cached: true,
      });
    }

    if (active.cancelled) throw new Error('__cancelled__');

    const job = store.getJob(jobId); // 攞返最新（掃描階段可能已更新）

    if (job.mode === 'sync') {
      const already = job.folders_count + job.files_count + job.updated_count;
      emitEvent(active, 'start', { rootName: job.new_root_name || '同步目的地', mode: 'sync', resumed: already > 0 });
      await syncFolderRecursive(jobId, active, drive, job.source_folder_id, job.dest_parent_id, 0);
    } else {
      let newRootId = job.new_root_id;
      let newRootName = job.new_root_name;

      if (!newRootId) {
        const sourceMeta = await withRetry(() =>
          drive.files.get({ fileId: job.source_folder_id, fields: 'id, name, mimeType', supportsAllDrives: true })
        );
        newRootName = job.new_name && job.new_name.trim() ? job.new_name.trim() : sourceMeta.data.name;
        emitEvent(active, 'start', { rootName: newRootName, mode: 'copy', resumed: false });

        const newRoot = await createFolder(drive, newRootName, job.dest_parent_id);
        newRootId = newRoot.id;
        store.setJobRoot(jobId, newRootId, newRootName);
        store.addFolderMapping(jobId, job.source_folder_id, newRootId);
        store.touchJobStats(jobId, { folders: 1 });
        emitEvent(active, 'folder', { name: newRootName, depth: 0, bytesDone: active.bytesDone });
      } else {
        emitEvent(active, 'start', {
          rootName: newRootName,
          mode: 'copy',
          resumed: true,
          prevStats: { folders: job.folders_count, files: job.files_count, skipped: job.skipped_count },
        });
      }

      await copyFolderRecursive(jobId, active, drive, job.source_folder_id, newRootId, 1);
    }

    if (active.cancelled) throw new Error('__cancelled__');

    store.setJobStatus(jobId, 'done');
    const finalJob = store.getJob(jobId);
    emitEvent(active, 'done', {
      stats: {
        folders: finalJob.folders_count,
        files: finalJob.files_count,
        skipped: finalJob.skipped_count,
        updated: finalJob.updated_count,
        unchanged: finalJob.unchanged_count,
      },
      bytesDone: finalJob.bytes_done,
      totalBytes: finalJob.total_bytes,
      newRootId: finalJob.new_root_id || finalJob.dest_parent_id,
      newRootName: finalJob.new_root_name || '同步目的地',
    });
  } catch (err) {
    if (err.message === '__cancelled__' || active.cancelled) {
      store.setJobStatus(jobId, 'cancelled');
      emitEvent(active, 'cancelled', {});
    } else {
      const message = err.message || String(err);
      store.setJobStatus(jobId, 'error', message);
      emitEvent(active, 'error', { message });
    }
  } finally {
    setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
  }
}

app.post('/api/copy/start', requireAuth, async (req, res) => {
  const { sourceFolderId, destParentId, newName, mode } = req.body;
  if (!sourceFolderId || !destParentId) {
    return res.status(400).json({ error: '缺少來源或目標資料夾 ID' });
  }
  const jobMode = mode === 'sync' ? 'sync' : 'copy';

  const jobId = crypto.randomBytes(8).toString('hex');
  let accountEmail = null;
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: req.driveAuth });
    const { data } = await oauth2.userinfo.get();
    accountEmail = data.email;
  } catch (_) {}

  store.createJob({
    id: jobId,
    sourceFolderId,
    destParentId,
    newName,
    mode: jobMode,
    refreshToken: req.session.tokens.refresh_token,
    accountEmail,
  });

  res.json({ jobId });

  const client = newOAuthClient();
  client.setCredentials(req.session.tokens);
  runCopyJob(jobId, client);
});

app.get('/api/jobs', requireAuth, (req, res) => {
  res.json({ jobs: store.listActiveOrRecentJobs() });
});

app.post('/api/copy/resume/:jobId', requireAuth, async (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: '搵唔到呢個工作' });
  if (!['interrupted', 'error'].includes(job.status)) {
    return res.status(400).json({ error: `呢個工作目前狀態係 ${job.status}，唔可以繼續` });
  }
  if (!job.refresh_token) {
    return res.status(400).json({ error: '呢個工作冇儲存 refresh token，冇辦法自動繼續，請重新開始一次搬運。' });
  }

  store.setJobStatus(job.id, 'running');
  res.json({ jobId: job.id });

  const client = newOAuthClient();
  client.setCredentials({ refresh_token: job.refresh_token });
  runCopyJob(job.id, client);
});

app.get('/api/copy/stream/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = store.getJob(jobId);
  if (!job) return res.status(404).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({
    type: 'snapshot',
    ts: Date.now(),
    status: job.status,
    scanStatus: job.scan_status,
    stats: { folders: job.folders_count, files: job.files_count, skipped: job.skipped_count, updated: job.updated_count, unchanged: job.unchanged_count },
    totalBytes: job.total_bytes,
    totalFolders: job.total_folders,
    totalFiles: job.total_files,
    bytesDone: job.bytes_done,
  })}\n\n`);

  const active = activeJobs.get(jobId);
  if (!active) {
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      res.write(`data: ${JSON.stringify({
        type: job.status === 'done' ? 'done' : job.status,
        ts: Date.now(),
        stats: { folders: job.folders_count, files: job.files_count, skipped: job.skipped_count, updated: job.updated_count, unchanged: job.unchanged_count },
        bytesDone: job.bytes_done,
        totalBytes: job.total_bytes,
        message: job.error_message,
        newRootId: job.new_root_id || job.dest_parent_id,
        newRootName: job.new_root_name || '同步目的地',
      })}\n\n`);
    }
    return res.end();
  }

  const onEvent = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  active.emitter.on('event', onEvent);

  const keepAlive = setInterval(() => res.write(':\n\n'), 15000);

  req.on('close', () => {
    active.emitter.off('event', onEvent);
    clearInterval(keepAlive);
  });
});

app.post('/api/copy/cancel/:jobId', requireAuth, (req, res) => {
  const active = activeJobs.get(req.params.jobId);
  if (!active) return res.status(404).json({ error: '呢個工作目前冇喺度跑緊' });
  active.cancelled = true;
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Drive Transfer Web UI 已啟動： http://localhost:${PORT}`);
});
