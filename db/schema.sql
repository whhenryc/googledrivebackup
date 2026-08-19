-- ============================================
-- 網站資料庫 Schema (SQLite)
-- 所有內容欄位都分 _en / _zh 兩個版本
-- ============================================

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 靜態頁面內容（About / Contact 等，可自由增加 block）
CREATE TABLE IF NOT EXISTS page_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_key TEXT NOT NULL,          -- e.g. 'about', 'contact', 'home_hero'
  block_key TEXT NOT NULL,         -- e.g. 'intro', 'sponsor', 'organiser'
  title_en TEXT,
  title_zh TEXT,
  content_en TEXT,
  content_zh TEXT,
  image TEXT,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(page_key, block_key)
);

-- 最新消息
CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_en TEXT NOT NULL,
  title_zh TEXT NOT NULL,
  summary_en TEXT,
  summary_zh TEXT,
  cover_image TEXT,
  link_type TEXT DEFAULT 'external',  -- 'external' | 'internal'
  link_url TEXT,                      -- 外部連結，或內部 slug (/news/slug)
  slug TEXT UNIQUE,
  content_en TEXT,                    -- 內部文章用（link_type = internal 先用到）
  content_zh TEXT,
  published_at TEXT DEFAULT CURRENT_TIMESTAMP,
  is_published INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0
);

-- 活動資訊（支援 parent-child，例如 CENTRESTAGE2025 底下有 Showcase / Workshops）
CREATE TABLE IF NOT EXISTS programmes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES programmes(id) ON DELETE CASCADE,
  slug TEXT UNIQUE NOT NULL,
  title_en TEXT NOT NULL,
  title_zh TEXT NOT NULL,
  cover_image TEXT,
  date_text_en TEXT,       -- 直接存文字，例如 "3-6 Sep 2025, 10am-7pm"
  date_text_zh TEXT,
  location_en TEXT,
  location_zh TEXT,
  content_en TEXT,
  content_zh TEXT,
  external_link TEXT,      -- 如果呢個活動係連去外部網站
  is_published INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0
);

-- GDTP 設計師
CREATE TABLE IF NOT EXISTS gdtp_designers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  brand_name TEXT,
  collection_name_en TEXT,
  collection_name_zh TEXT,
  instagram TEXT,
  website TEXT,
  photo TEXT,
  logo_image TEXT,
  collection_image TEXT,
  bio_en TEXT,
  bio_zh TEXT,
  is_published INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0
);

-- 媒體報導
CREATE TABLE IF NOT EXISTS press (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_en TEXT NOT NULL,
  title_zh TEXT NOT NULL,
  cover_image TEXT,
  source_name TEXT,        -- e.g. "Muse TV"
  published_date TEXT,
  link_url TEXT,
  is_published INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0
);

-- 刊物 / Lookbook / PDF
CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_en TEXT NOT NULL,
  title_zh TEXT NOT NULL,
  cover_image TEXT,
  pdf_url TEXT,
  is_published INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0
);

-- 網站全域設定（社交連結、聯絡email等）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
