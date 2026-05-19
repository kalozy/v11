const express  = require('express');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const db       = require('../db');

const router = express.Router();

// ── Register ──────────────────────────────────────────────────────────────────
router.get('/register', (req, res) => {
  if (req.session?.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, '../../public/auth/register.html'));
});

router.post('/register', async (req, res) => {
  const { name, email, password, confirm } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos' });
  if (password !== confirm)         return res.status(400).json({ error: 'Senhas não coincidem' });
  if (password.length < 6)          return res.status(400).json({ error: 'Senha mínimo 6 caracteres' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) return res.status(400).json({ error: 'E-mail já cadastrado' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const info = db.prepare(
      "INSERT INTO users (name, email, password_hash, plan, status) VALUES (?, ?, ?, 'free', 'active')"
    ).run(name.trim(), email.toLowerCase().trim(), hash);

    req.session.userId = info.lastInsertRowid;
    req.session.save(() => res.json({ ok: true, redirect: '/dashboard' }));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, '../../public/auth/login.html'));
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Preencha e-mail e senha' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  if (user.status !== 'active') return res.status(403).json({ error: 'Conta suspensa. Entre em contato com o suporte.' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'E-mail ou senha incorretos' });

  db.prepare('UPDATE users SET last_login=? WHERE id=?').run(new Date().toISOString(), user.id);
  req.session.userId = user.id;

  const redirect = user.plan === 'admin' ? '/admin' : '/dashboard';
  req.session.save(() => res.json({ ok: true, redirect }));
});

// ── Logout ────────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true, redirect: '/login' }));
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Current user info ─────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Não autenticado' });
  const user = db.prepare('SELECT id, name, email, plan, status, created_at, last_login FROM users WHERE id = ?').get(req.session.userId);
  res.json(user || { error: 'Usuário não encontrado' });
});

module.exports = router;
