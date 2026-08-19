/**
 * server.js — Google Drive 資料夾伺服器端複製工具（Web UI 版）
 *
 * 全部複製都經 Google Drive API 的 files.copy 完成，
 * 資料喺 Google 伺服器內部搬移，唔會下載到呢個 app 所在嘅主機，
 * 更加唔會落地使用者部電腦。
 */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const { google } = require('googleapis');
const { EventEmitter } = require('events');

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
    // 保存 refresh 後嘅新 access token
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
  const match = trimmed.match(/[-\w]{25,}/); // Drive IDs are long alnum/-/_ strings
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

// ---------- Copy job engine ----------

const jobs = new Map(); // jobId -> { emitter, log, stats, done, error, tokens }

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
        fields: 'nextPageToken, files(id, name, mimeType)',
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

async function copyFile(drive, fileId, name, parentId) {
  const res = await withRetry(() =>
    drive.files.copy({
      fileId,
      requestBody: { name, parents: [parentId] },
      fields: 'id, name',
      supportsAllDrives: true,
    })
  );
  return res.data;
}

function emitEvent(job, type, payload) {
  const evt = { type, ts: Date.now(), ...payload };
  job.log.push(evt);
  if (job.log.length > 2000) job.log.shift(); // cap buffer
  job.emitter.emit('event', evt);
}

async function copyFolderRecursive(job, drive, sourceFolderId, destParentId, depth) {
  if (job.cancelled) return;
  const children = await listChildren(drive, sourceFolderId);

  for (const item of children) {
    if (job.cancelled) return;
    if (item.mimeType === FOLDER_MIME) {
      const newFolder = await createFolder(drive, item.name, destParentId);
      job.stats.folders++;
      emitEvent(job, 'folder', { name: item.name, depth });
      await copyFolderRecursive(job, drive, item.id, newFolder.id, depth + 1);
    } else if (item.mimeType === SHORTCUT_MIME) {
      job.stats.skipped++;
      emitEvent(job, 'skip', { name: item.name, depth, reason: 'shortcut' });
    } else {
      await copyFile(drive, item.id, item.name, destParentId);
      job.stats.files++;
      emitEvent(job, 'file', { name: item.name, depth });
    }
  }
}

app.post('/api/copy/start', requireAuth, async (req, res) => {
  const { sourceFolderId, destParentId, newName } = req.body;
  if (!sourceFolderId || !destParentId) {
    return res.status(400).json({ error: '缺少來源或目標資料夾 ID' });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  const job = {
    id: jobId,
    emitter: new EventEmitter(),
    log: [],
    stats: { folders: 0, files: 0, skipped: 0 },
    done: false,
    error: null,
    cancelled: false,
    tokens: req.session.tokens,
  };
  jobs.set(jobId, job);
  job.emitter.setMaxListeners(50);

  res.json({ jobId });

  // Run async — 用當初 session 嘅 tokens 建立獨立 client，唔再依賴呢次 request
  const client = newOAuthClient();
  client.setCredentials(job.tokens);
  const drive = google.drive({ version: 'v3', auth: client });

  try {
    const sourceMeta = await withRetry(() =>
      drive.files.get({ fileId: sourceFolderId, fields: 'id, name, mimeType', supportsAllDrives: true })
    );
    const rootName = newName && newName.trim() ? newName.trim() : sourceMeta.data.name;

    emitEvent(job, 'start', { rootName });
    const newRoot = await createFolder(drive, rootName, destParentId);
    job.stats.folders++;
    emitEvent(job, 'folder', { name: rootName, depth: 0 });

    await copyFolderRecursive(job, drive, sourceFolderId, newRoot.id, 1);

    job.done = true;
    job.result = { newRootId: newRoot.id, newRootName: rootName };
    emitEvent(job, 'done', { stats: job.stats, newRootId: newRoot.id, newRootName: rootName });
  } catch (err) {
    job.done = true;
    job.error = err.message || String(err);
    emitEvent(job, 'error', { message: job.error });
  }
});

app.get('/api/copy/stream/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  // 補發之前已經發生嘅事件（處理連線遲咗嘅情況）
  for (const evt of job.log) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }
  if (job.done) {
    res.write(`data: ${JSON.stringify({ type: job.error ? 'error' : 'done', ts: Date.now(), stats: job.stats, message: job.error, ...(job.result || {}) })}\n\n`);
  }

  const onEvent = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  job.emitter.on('event', onEvent);

  const keepAlive = setInterval(() => res.write(':\n\n'), 15000);

  req.on('close', () => {
    job.emitter.off('event', onEvent);
    clearInterval(keepAlive);
  });
});

app.post('/api/copy/cancel/:jobId', requireAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '搵唔到呢個工作' });
  job.cancelled = true;
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Drive Copy Web UI 已啟動： http://localhost:${PORT}`);
});
