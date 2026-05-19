const db = require('../db');

// Require user to be logged in
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    if (req.headers['content-type'] === 'application/json' || req.path.startsWith('/api') || req.path.startsWith('/bot-api')) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    return res.redirect('/login');
  }
  // Attach user to request
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.status !== 'active') {
    req.session.destroy();
    return res.redirect('/login?error=suspended');
  }
  req.user = user;
  next();
}

// Require super admin
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.plan !== 'admin') return res.status(403).send('Acesso negado');
  req.user = user;
  next();
}

module.exports = { requireAuth, requireAdmin };
