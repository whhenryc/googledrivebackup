/**
 * db.js — 搬運工作嘅持久化紀錄（SQLite）
 *
 * 用途：每複製一個資料夾/檔案就即時記一筆，中斷後可以憑住呢啲紀錄
 * 判斷邊啲已經做咗，跳過重複，唔使由頭嚟過。
 *
 * 同步模式（sync）下，「已經做咗未」嘅判斷主要靠直接查詢目的地資料夾
 * （名稱 + modifiedTime），呢個 db 主要用嚟計統計、記 log 同支援斷點續傳。
 *
 * 注意：refresh_token 存喺呢個資料庫入面（用嚟喺伺服器重啟後,
 * 唔使使用者重新登入都可以繼續個工作）。呢個 db 檔案要當敏感資料處理,
 * 千祈唔好 commit 落 git（已經加咗落 .gitignore）。
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'jobs.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  source_folder_id TEXT NOT NULL,
  dest_parent_id TEXT NOT NULL,
  new_name TEXT,
  mode TEXT NOT NULL DEFAULT 'copy', -- copy | sync
  new_root_id TEXT,
  new_root_name TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- running | interrupted | done | error | cancelled
  error_message TEXT,
  refresh_token TEXT,
  account_email TEXT,
  folders_count INTEGER NOT NULL DEFAULT 0,
  files_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS folder_map (
  job_id TEXT NOT NULL,
  source_folder_id TEXT NOT NULL,
  dest_folder_id TEXT NOT NULL,
  PRIMARY KEY (job_id, source_folder_id)
);

CREATE TABLE IF NOT EXISTS copied_files (
  job_id TEXT NOT NULL,
  source_file_id TEXT NOT NULL,
  PRIMARY KEY (job_id, source_file_id)
);

CREATE TABLE IF NOT EXISTS skipped_items (
  job_id TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  PRIMARY KEY (job_id, source_item_id)
);
`);

// ---- 輕量 migration：舊資料庫冇呢啲欄位嘅話就補返 ----
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('jobs', 'mode', `TEXT NOT NULL DEFAULT 'copy'`);
ensureColumn('jobs', 'updated_count', `INTEGER NOT NULL DEFAULT 0`);
ensureColumn('jobs', 'unchanged_count', `INTEGER NOT NULL DEFAULT 0`);

// ---------- Job rows ----------

function createJob({ id, sourceFolderId, destParentId, newName, mode, refreshToken, accountEmail }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO jobs (id, source_folder_id, dest_parent_id, new_name, mode, status, refresh_token, account_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`
  ).run(id, sourceFolderId, destParentId, newName || null, mode || 'copy', refreshToken || null, accountEmail || null, now, now);
}

function getJob(id) {
  return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
}

function listResumableJobs() {
  return db
    .prepare(`SELECT * FROM jobs WHERE status IN ('interrupted', 'error') ORDER BY updated_at DESC LIMIT 20`)
    .all();
}

function listActiveOrRecentJobs() {
  return db.prepare(`SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 20`).all();
}

function setJobRoot(id, newRootId, newRootName) {
  db.prepare(`UPDATE jobs SET new_root_id = ?, new_root_name = ?, updated_at = ? WHERE id = ?`).run(
    newRootId,
    newRootName,
    Date.now(),
    id
  );
}

function setJobStatus(id, status, errorMessage) {
  db.prepare(`UPDATE jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`).run(
    status,
    errorMessage || null,
    Date.now(),
    id
  );
}

function touchJobStats(id, { folders = 0, files = 0, skipped = 0, updated = 0, unchanged = 0 }) {
  db.prepare(
    `UPDATE jobs SET folders_count = folders_count + ?, files_count = files_count + ?, skipped_count = skipped_count + ?, updated_count = updated_count + ?, unchanged_count = unchanged_count + ?, updated_at = ? WHERE id = ?`
  ).run(folders, files, skipped, updated, unchanged, Date.now(), id);
}

function markOrphanedJobsInterrupted() {
  const info = db
    .prepare(`UPDATE jobs SET status = 'interrupted', updated_at = ? WHERE status = 'running'`)
    .run(Date.now());
  return info.changes;
}

// ---------- Folder mapping (source folder id -> dest folder id) ----------

function getFolderMapping(jobId, sourceFolderId) {
  const row = db
    .prepare(`SELECT dest_folder_id FROM folder_map WHERE job_id = ? AND source_folder_id = ?`)
    .get(jobId, sourceFolderId);
  return row ? row.dest_folder_id : null;
}

function addFolderMapping(jobId, sourceFolderId, destFolderId) {
  db.prepare(
    `INSERT OR IGNORE INTO folder_map (job_id, source_folder_id, dest_folder_id) VALUES (?, ?, ?)`
  ).run(jobId, sourceFolderId, destFolderId);
}

// ---------- Copied files ----------

function isFileCopied(jobId, sourceFileId) {
  return !!db
    .prepare(`SELECT 1 FROM copied_files WHERE job_id = ? AND source_file_id = ?`)
    .get(jobId, sourceFileId);
}

function markFileCopied(jobId, sourceFileId) {
  db.prepare(`INSERT OR IGNORE INTO copied_files (job_id, source_file_id) VALUES (?, ?)`).run(jobId, sourceFileId);
}

// ---------- Skipped items (e.g. shortcuts) ----------

function isSkipped(jobId, sourceItemId) {
  return !!db
    .prepare(`SELECT 1 FROM skipped_items WHERE job_id = ? AND source_item_id = ?`)
    .get(jobId, sourceItemId);
}

function markSkipped(jobId, sourceItemId) {
  db.prepare(`INSERT OR IGNORE INTO skipped_items (job_id, source_item_id) VALUES (?, ?)`).run(jobId, sourceItemId);
}

module.exports = {
  db,
  createJob,
  getJob,
  listResumableJobs,
  listActiveOrRecentJobs,
  setJobRoot,
  setJobStatus,
  touchJobStats,
  markOrphanedJobsInterrupted,
  getFolderMapping,
  addFolderMapping,
  isFileCopied,
  markFileCopied,
  isSkipped,
  markSkipped,
};
