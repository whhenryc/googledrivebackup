const express = require('express');
const router = express.Router();
const db = require('../db/database');
const upload = require('../middleware/upload');

function slugify(str) {
  return (str || '')
    .toString().trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/(^-|-$)/g, '') || `item-${Date.now()}`;
}

// =========================================================
// 網站設計 Theme (顏色/字體/logo/自訂CSS)
// =========================================================
const THEME_KEYS = [
  'theme_primary_color', 'theme_bg_color', 'theme_text_color',
  'theme_font_family', 'theme_google_font_url', 'theme_logo', 'theme_custom_css'
];
const THEME_DEFAULTS = {
  theme_primary_color: '#7a1f1f',
  theme_bg_color: '#ffffff',
  theme_text_color: '#111111',
  theme_font_family: "-apple-system, 'PingFang HK', 'Noto Sans TC', sans-serif",
  theme_google_font_url: '',
  theme_logo: '/images/logo.svg',
  theme_custom_css: ''
};

function getThemeSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  rows.forEach(r => map[r.key] = r.value);
  return { ...THEME_DEFAULTS, ...map };
}

router.get('/theme', (req, res) => {
  res.render('admin/theme-form', { theme: getThemeSettings() });
});

router.post('/theme', upload.single('logo_file'), (req, res) => {
  const b = req.body;
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  upsert.run('theme_primary_color', b.theme_primary_color || THEME_DEFAULTS.theme_primary_color);
  upsert.run('theme_bg_color', b.theme_bg_color || THEME_DEFAULTS.theme_bg_color);
  upsert.run('theme_text_color', b.theme_text_color || THEME_DEFAULTS.theme_text_color);
  upsert.run('theme_font_family', b.theme_font_family || THEME_DEFAULTS.theme_font_family);
  upsert.run('theme_google_font_url', b.theme_google_font_url || '');
  upsert.run('theme_custom_css', b.theme_custom_css || '');

  if (req.file) {
    upsert.run('theme_logo', `/uploads/${req.file.filename}`);
  } else if (b.existing_logo) {
    upsert.run('theme_logo', b.existing_logo);
  }

  res.redirect('/admin/theme');
});

// ---------- Dashboard ----------
router.get('/', (req, res) => {
  const counts = {
    news: db.prepare('SELECT COUNT(*) c FROM news').get().c,
    programmes: db.prepare('SELECT COUNT(*) c FROM programmes').get().c,
    gdtp: db.prepare('SELECT COUNT(*) c FROM gdtp_designers').get().c,
    press: db.prepare('SELECT COUNT(*) c FROM press').get().c,
    publications: db.prepare('SELECT COUNT(*) c FROM publications').get().c,
  };
  res.render('admin/dashboard', { counts });
});

// =========================================================
// 最新消息 News
// =========================================================
router.get('/news', (req, res) => {
  const rows = db.prepare('SELECT * FROM news ORDER BY sort_order, published_at DESC').all();
  res.render('admin/news-list', { rows });
});

router.get('/news/new', (req, res) => {
  res.render('admin/news-form', { item: null });
});

router.get('/news/:id/edit', (req, res) => {
  const item = db.prepare('SELECT * FROM news WHERE id = ?').get(req.params.id);
  if (!item) return res.redirect('/admin/news');
  res.render('admin/news-form', { item });
});

router.post('/news', upload.single('cover_image'), (req, res) => {
  const b = req.body;
  const slug = b.slug ? slugify(b.slug) : slugify(b.title_en);
  const cover = req.file ? `/uploads/${req.file.filename}` : (b.existing_cover || null);
  db.prepare(`
    INSERT INTO news (title_en, title_zh, summary_en, summary_zh, cover_image, link_type, link_url, slug, content_en, content_zh, is_published, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(b.title_en, b.title_zh, b.summary_en, b.summary_zh, cover, b.link_type, b.link_url, slug, b.content_en, b.content_zh, b.is_published ? 1 : 0, b.sort_order || 0);
  res.redirect('/admin/news');
});

router.post('/news/:id', upload.single('cover_image'), (req, res) => {
  const b = req.body;
  const slug = b.slug ? slugify(b.slug) : slugify(b.title_en);
  const cover = req.file ? `/uploads/${req.file.filename}` : (b.existing_cover || null);
  db.prepare(`
    UPDATE news SET title_en=?, title_zh=?, summary_en=?, summary_zh=?, cover_image=?, link_type=?, link_url=?, slug=?, content_en=?, content_zh=?, is_published=?, sort_order=?
    WHERE id=?
  `).run(b.title_en, b.title_zh, b.summary_en, b.summary_zh, cover, b.link_type, b.link_url, slug, b.content_en, b.content_zh, b.is_published ? 1 : 0, b.sort_order || 0, req.params.id);
  res.redirect('/admin/news');
});

router.post('/news/:id/delete', (req, res) => {
  db.prepare('DELETE FROM news WHERE id = ?').run(req.params.id);
  res.redirect('/admin/news');
});

// =========================================================
// 活動資訊 Programmes（支援上下層 parent_id）
// =========================================================
router.get('/programmes', (req, res) => {
  const rows = db.prepare('SELECT * FROM programmes ORDER BY parent_id IS NULL DESC, parent_id, sort_order').all();
  res.render('admin/programmes-list', { rows });
});

router.get('/programmes/new', (req, res) => {
  const parents = db.prepare('SELECT id, title_zh FROM programmes ORDER BY title_zh').all();
  res.render('admin/programmes-form', { item: null, parents });
});

router.get('/programmes/:id/edit', (req, res) => {
  const item = db.prepare('SELECT * FROM programmes WHERE id = ?').get(req.params.id);
  if (!item) return res.redirect('/admin/programmes');
  const parents = db.prepare('SELECT id, title_zh FROM programmes WHERE id != ? ORDER BY title_zh').all(req.params.id);
  res.render('admin/programmes-form', { item, parents });
});

router.post('/programmes', upload.single('cover_image'), (req, res) => {
  const b = req.body;
  const slug = b.slug ? slugify(b.slug) : slugify(b.title_en);
  const cover = req.file ? `/uploads/${req.file.filename}` : (b.existing_cover || null);
  db.prepare(`
    INSERT INTO programmes (parent_id, slug, title_en, title_zh, cover_image, date_text_en, date_text_zh, location_en, location_zh, content_en, content_zh, external_link, is_published, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(b.parent_id || null, slug, b.title_en, b.title_zh, cover, b.date_text_en, b.date_text_zh, b.location_en, b.location_zh, b.content_en, b.content_zh, b.external_link, b.is_published ? 1 : 0, b.sort_order || 0);
  res.redirect('/admin/programmes');
});

router.post('/programmes/:id', upload.single('cover_image'), (req, res) => {
  const b = req.body;
  const slug = b.slug ? slugify(b.slug) : slugify(b.title_en);
  const cover = req.file ? `/uploads/${req.file.filename}` : (b.existing_cover || null);
  db.prepare(`
    UPDATE programmes SET parent_id=?, slug=?, title_en=?, title_zh=?, cover_image=?, date_text_en=?, date_text_zh=?, location_en=?, location_zh=?, content_en=?, content_zh=?, external_link=?, is_published=?, sort_order=?
    WHERE id=?
  `).run(b.parent_id || null, slug, b.title_en, b.title_zh, cover, b.date_text_en, b.date_text_zh, b.location_en, b.location_zh, b.content_en, b.content_zh, b.external_link, b.is_published ? 1 : 0, b.sort_order || 0, req.params.id);
  res.redirect('/admin/programmes');
});

router.post('/programmes/:id/delete', (req, res) => {
  db.prepare('DELETE FROM programmes WHERE id = ?').run(req.params.id);
  res.redirect('/admin/programmes');
});

// =========================================================
// GDTP 設計師
// =========================================================
router.get('/gdtp', (req, res) => {
  const rows = db.prepare('SELECT * FROM gdtp_designers ORDER BY sort_order').all();
  res.render('admin/gdtp-list', { rows });
});

router.get('/gdtp/new', (req, res) => res.render('admin/gdtp-form', { item: null }));

router.get('/gdtp/:id/edit', (req, res) => {
  const item = db.prepare('SELECT * FROM gdtp_designers WHERE id = ?').get(req.params.id);
  if (!item) return res.redirect('/admin/gdtp');
  res.render('admin/gdtp-form', { item });
});

const gdtpUpload = upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'logo_image', maxCount: 1 },
  { name: 'collection_image', maxCount: 1 },
]);

router.post('/gdtp', gdtpUpload, (req, res) => {
  const b = req.body;
  const f = req.files || {};
  const photo = f.photo ? `/uploads/${f.photo[0].filename}` : (b.existing_photo || null);
  const logo = f.logo_image ? `/uploads/${f.logo_image[0].filename}` : (b.existing_logo_image || null);
  const coll = f.collection_image ? `/uploads/${f.collection_image[0].filename}` : (b.existing_collection_image || null);
  db.prepare(`
    INSERT INTO gdtp_designers (name_en, name_zh, brand_name, collection_name_en, collection_name_zh, instagram, website, photo, logo_image, collection_image, bio_en, bio_zh, is_published, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(b.name_en, b.name_zh, b.brand_name, b.collection_name_en, b.collection_name_zh, b.instagram, b.website, photo, logo, coll, b.bio_en, b.bio_zh, b.is_published ? 1 : 0, b.sort_order || 0);
  res.redirect('/admin/gdtp');
});

router.post('/gdtp/:id', gdtpUpload, (req, res) => {
  const b = req.body;
  const f = req.files || {};
  const photo = f.photo ? `/uploads/${f.photo[0].filename}` : (b.existing_photo || null);
  const logo = f.logo_image ? `/uploads/${f.logo_image[0].filename}` : (b.existing_logo_image || null);
  const coll = f.collection_image ? `/uploads/${f.collection_image[0].filename}` : (b.existing_collection_image || null);
  db.prepare(`
    UPDATE gdtp_designers SET name_en=?, name_zh=?, brand_name=?, collection_name_en=?, collection_name_zh=?, instagram=?, website=?, photo=?, logo_image=?, collection_image=?, bio_en=?, bio_zh=?, is_published=?, sort_order=?
    WHERE id=?
  `).run(b.name_en, b.name_zh, b.brand_name, b.collection_name_en, b.collection_name_zh, b.instagram, b.website, photo, logo, coll, b.bio_en, b.bio_zh, b.is_published ? 1 : 0, b.sort_order || 0, req.params.id);
  res.redirect('/admin/gdtp');
});

router.post('/gdtp/:id/delete', (req, res) => {
  db.prepare('DELETE FROM gdtp_designers WHERE id = ?').run(req.params.id);
  res.redirect('/admin/gdtp');
});

// =========================================================
// 媒體報導 Press
// =========================================================
router.get('/press', (req, res) => {
  const rows = db.prepare('SELECT * FROM press ORDER BY sort_order, published_date DESC').all();
  res.render('admin/press-list', { rows });
});

router.get('/press/new', (req, res) => res.render('admin/press-form', { item: null }));

router.get('/press/:id/edit', (req, res) => {
  const item = db.prepare('SELECT * FROM press WHERE id = ?').get(req.params.id);
  if (!item) return res.redirect('/admin/press');
  res.render('admin/press-form', { item });
});

router.post('/press', upload.single('cover_image'), (req, res) => {
  const b = req.body;
  const cover = req.file ? `/uploads/${req.file.filename}` : (b.existing_cover || null);
  db.prepare(`
    INSERT INTO press (title_en, title_zh, cover_image, source_name, published_date, link_url, is_published, sort_order)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(b.title_en, b.title_zh, cover, b.source_name, b.published_date, b.link_url, b.is_published ? 1 : 0, b.sort_order || 0);
  res.redirect('/admin/press');
});

router.post('/press/:id', upload.single('cover_image'), (req, res) => {
  const b = req.body;
  const cover = req.file ? `/uploads/${req.file.filename}` : (b.existing_cover || null);
  db.prepare(`
    UPDATE press SET title_en=?, title_zh=?, cover_image=?, source_name=?, published_date=?, link_url=?, is_published=?, sort_order=?
    WHERE id=?
  `).run(b.title_en, b.title_zh, cover, b.source_name, b.published_date, b.link_url, b.is_published ? 1 : 0, b.sort_order || 0, req.params.id);
  res.redirect('/admin/press');
});

router.post('/press/:id/delete', (req, res) => {
  db.prepare('DELETE FROM press WHERE id = ?').run(req.params.id);
  res.redirect('/admin/press');
});

// =========================================================
// 刊物 Publications
// =========================================================
router.get('/publications', (req, res) => {
  const rows = db.prepare('SELECT * FROM publications ORDER BY sort_order').all();
  res.render('admin/publications-list', { rows });
});

router.get('/publications/new', (req, res) => res.render('admin/publications-form', { item: null }));

router.get('/publications/:id/edit', (req, res) => {
  const item = db.prepare('SELECT * FROM publications WHERE id = ?').get(req.params.id);
  if (!item) return res.redirect('/admin/publications');
  res.render('admin/publications-form', { item });
});

const pubUpload = upload.fields([
  { name: 'cover_image', maxCount: 1 },
  { name: 'pdf_file', maxCount: 1 },
]);

router.post('/publications', pubUpload, (req, res) => {
  const b = req.body;
  const f = req.files || {};
  const cover = f.cover_image ? `/uploads/${f.cover_image[0].filename}` : (b.existing_cover || null);
  const pdf = f.pdf_file ? `/uploads/${f.pdf_file[0].filename}` : (b.pdf_url || null);
  db.prepare(`
    INSERT INTO publications (title_en, title_zh, cover_image, pdf_url, is_published, sort_order)
    VALUES (?,?,?,?,?,?)
  `).run(b.title_en, b.title_zh, cover, pdf, b.is_published ? 1 : 0, b.sort_order || 0);
  res.redirect('/admin/publications');
});

router.post('/publications/:id', pubUpload, (req, res) => {
  const b = req.body;
  const f = req.files || {};
  const cover = f.cover_image ? `/uploads/${f.cover_image[0].filename}` : (b.existing_cover || null);
  const pdf = f.pdf_file ? `/uploads/${f.pdf_file[0].filename}` : (b.pdf_url || null);
  db.prepare(`
    UPDATE publications SET title_en=?, title_zh=?, cover_image=?, pdf_url=?, is_published=?, sort_order=?
    WHERE id=?
  `).run(b.title_en, b.title_zh, cover, pdf, b.is_published ? 1 : 0, b.sort_order || 0, req.params.id);
  res.redirect('/admin/publications');
});

router.post('/publications/:id/delete', (req, res) => {
  db.prepare('DELETE FROM publications WHERE id = ?').run(req.params.id);
  res.redirect('/admin/publications');
});

// =========================================================
// 靜態頁面 Blocks（About / Contact / Home）
// =========================================================
router.get('/pages/:pageKey', (req, res) => {
  const rows = db.prepare('SELECT * FROM page_blocks WHERE page_key = ? ORDER BY sort_order, id').all(req.params.pageKey);
  res.render('admin/pages-list', { rows, pageKey: req.params.pageKey });
});

router.get('/pages/:pageKey/new', (req, res) => {
  res.render('admin/pages-form', { item: null, pageKey: req.params.pageKey });
});

router.get('/pages/:pageKey/:id/edit', (req, res) => {
  const item = db.prepare('SELECT * FROM page_blocks WHERE id = ?').get(req.params.id);
  if (!item) return res.redirect(`/admin/pages/${req.params.pageKey}`);
  res.render('admin/pages-form', { item, pageKey: req.params.pageKey });
});

router.post('/pages/:pageKey', upload.single('image'), (req, res) => {
  const b = req.body;
  const image = req.file ? `/uploads/${req.file.filename}` : (b.existing_image || null);
  db.prepare(`
    INSERT INTO page_blocks (page_key, block_key, title_en, title_zh, content_en, content_zh, image, sort_order)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(req.params.pageKey, b.block_key, b.title_en, b.title_zh, b.content_en, b.content_zh, image, b.sort_order || 0);
  res.redirect(`/admin/pages/${req.params.pageKey}`);
});

router.post('/pages/:pageKey/:id', upload.single('image'), (req, res) => {
  const b = req.body;
  const image = req.file ? `/uploads/${req.file.filename}` : (b.existing_image || null);
  db.prepare(`
    UPDATE page_blocks SET title_en=?, title_zh=?, content_en=?, content_zh=?, image=?, sort_order=?
    WHERE id=?
  `).run(b.title_en, b.title_zh, b.content_en, b.content_zh, image, b.sort_order || 0, req.params.id);
  res.redirect(`/admin/pages/${req.params.pageKey}`);
});

router.post('/pages/:pageKey/:id/delete', (req, res) => {
  db.prepare('DELETE FROM page_blocks WHERE id = ?').run(req.params.id);
  res.redirect(`/admin/pages/${req.params.pageKey}`);
});

module.exports = router;
