const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');

router.get('/login', (req, res) => {
  res.render('admin/login', { error: null, layout: false });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.render('admin/login', { error: '用戶名或密碼錯誤', layout: false });
  }
  req.session.adminId = user.id;
  req.session.adminUser = user.username;
  res.redirect('/admin');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

module.exports = router;
