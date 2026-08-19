const express = require('express');
const router = express.Router();
const db = require('../db/database');

// 語言中介：/en/... 或 /zh/... (預設 /zh)
router.use((req, res, next) => {
  const seg = req.path.split('/')[1];
  res.locals.lang = seg === 'en' ? 'en' : 'zh';
  res.locals.t = (row, field) => row ? row[`${field}_${res.locals.lang}`] : '';
  next();
});

// 網站設計設定（顏色/字體/logo/自訂CSS），全部前台頁面共用
const THEME_DEFAULTS = {
  theme_primary_color: '#7a1f1f',
  theme_bg_color: '#ffffff',
  theme_text_color: '#111111',
  theme_font_family: "-apple-system, 'PingFang HK', 'Noto Sans TC', sans-serif",
  theme_google_font_url: '',
  theme_logo: '/images/logo.svg',
  theme_custom_css: ''
};

function getTheme() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  rows.forEach(r => map[r.key] = r.value);
  return { ...THEME_DEFAULTS, ...map };
}

router.use((req, res, next) => {
  res.locals.theme = getTheme();
  next();
});

function getBlocks(pageKey) {
  const rows = db.prepare('SELECT * FROM page_blocks WHERE page_key = ? ORDER BY sort_order, id').all(pageKey);
  const map = {};
  rows.forEach(r => map[r.block_key] = r);
  return map;
}

// ---------- 首頁 ----------
router.get(['/', '/en', '/zh', '/en/home', '/zh/home'], (req, res) => {
  const news = db.prepare('SELECT * FROM news WHERE is_published=1 ORDER BY sort_order, published_at DESC LIMIT 2').all();
  const programmes = db.prepare('SELECT * FROM programmes WHERE is_published=1 AND parent_id IS NULL ORDER BY sort_order LIMIT 8').all();
  const publications = db.prepare('SELECT * FROM publications WHERE is_published=1 ORDER BY sort_order').all();
  const designers = db.prepare('SELECT * FROM gdtp_designers WHERE is_published=1 ORDER BY sort_order LIMIT 4').all();
  const press = db.prepare('SELECT * FROM press WHERE is_published=1 ORDER BY sort_order, published_date DESC LIMIT 4').all();
  const about = getBlocks('about');
  const contact = getBlocks('contact');
  const homeBlocks = getBlocks('home');
  const gdtpBlocks = getBlocks('gdtp');
  const gdtpIntro = gdtpBlocks.intro || null;
  const heroImage = homeBlocks.hero ? homeBlocks.hero.image : null;
  const sectionBg = {
    news: homeBlocks.bg_news ? homeBlocks.bg_news.image : null,
    programmes: homeBlocks.bg_programmes ? homeBlocks.bg_programmes.image : null,
    press: homeBlocks.bg_press ? homeBlocks.bg_press.image : null,
    publications: homeBlocks.bg_publications ? homeBlocks.bg_publications.image : null,
    gdtp: homeBlocks.bg_gdtp ? homeBlocks.bg_gdtp.image : null,
    about: homeBlocks.bg_about ? homeBlocks.bg_about.image : null,
    contact: homeBlocks.bg_contact ? homeBlocks.bg_contact.image : null
  };
  res.render('public/home', { news, programmes, publications, designers, press, about, contact, heroImage, sectionBg, gdtpIntro });
});

// ---------- 關於我們 ----------
router.get(['/en/about', '/zh/about'], (req, res) => {
  const blocks = getBlocks('about');
  res.render('public/about', { blocks });
});

// ---------- 最新消息 list ----------
router.get(['/en/news', '/zh/news'], (req, res) => {
  const news = db.prepare('SELECT * FROM news WHERE is_published=1 ORDER BY sort_order, published_at DESC').all();
  res.render('public/news-list', { news });
});

// 最新消息 內部詳情頁（如果 link_type = internal）
router.get(['/en/news/:slug', '/zh/news/:slug'], (req, res) => {
  const item = db.prepare('SELECT * FROM news WHERE slug = ?').get(req.params.slug);
  if (!item) return res.status(404).render('public/404');
  res.render('public/news-detail', { item });
});

// ---------- 活動資訊 list（只顯示頂層活動） ----------
router.get(['/en/programmes', '/zh/programmes'], (req, res) => {
  const programmes = db.prepare('SELECT * FROM programmes WHERE is_published=1 AND parent_id IS NULL ORDER BY sort_order').all();
  res.render('public/programmes-list', { programmes });
});

// 活動詳情頁 + 子活動
router.get(['/en/programmes/:slug', '/zh/programmes/:slug'], (req, res) => {
  const item = db.prepare('SELECT * FROM programmes WHERE slug = ?').get(req.params.slug);
  if (!item) return res.status(404).render('public/404');
  const children = db.prepare('SELECT * FROM programmes WHERE parent_id = ? AND is_published=1 ORDER BY sort_order').all(item.id);
  res.render('public/programme-detail', { item, children });
});

// ---------- GDTP ----------
router.get(['/en/gdtp', '/zh/gdtp'], (req, res) => {
  const designers = db.prepare('SELECT * FROM gdtp_designers WHERE is_published=1 ORDER BY sort_order').all();
  const publications = db.prepare('SELECT * FROM publications WHERE is_published=1 ORDER BY sort_order').all();
  res.render('public/gdtp', { designers, publications });
});

// ---------- 媒體報導 ----------
router.get(['/en/press', '/zh/press'], (req, res) => {
  const press = db.prepare('SELECT * FROM press WHERE is_published=1 ORDER BY sort_order, published_date DESC').all();
  res.render('public/press', { press });
});

// ---------- 聯絡我們 ----------
router.get(['/en/contact', '/zh/contact'], (req, res) => {
  const blocks = getBlocks('contact');
  res.render('public/contact', { blocks });
});

module.exports = router;
