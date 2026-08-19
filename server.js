require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const methodOverride = require('method-override');
const path = require('path');

const { requireAdmin } = require('./middleware/auth');
const publicRoutes = require('./routes/public');
const adminAuthRoutes = require('./routes/adminAuth');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-env',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 小時
}));

// ---------- 前台 ----------
app.use('/', publicRoutes);

// ---------- 後台登入（唔使 auth）----------
app.use('/admin', adminAuthRoutes);

// ---------- 後台 CMS（需要 auth）----------
app.use('/admin', requireAdmin, adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).render('public/404');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
