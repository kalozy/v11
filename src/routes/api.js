const express = require('express');
const db = require('../db');

const router = express.Router();

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Auto-cleanup: delete requests older than 7 days ───────────────────────────

function runCleanup() {
  try {
    const info = db.prepare(
      `DELETE FROM requests WHERE created_at < datetime('now', '-7 days')`
    ).run();
    if (info.changes > 0) {
      console.log(`[cleanup] deleted ${info.changes} requests older than 7 days`);
    }
  } catch (err) {
    console.error('[cleanup] error:', err.message);
  }
}

// Run on startup and every 24 hours
runCleanup();
setInterval(runCleanup, 24 * 60 * 60 * 1000);

// ── Stats ─────────────────────────────────────────────────────────────────────

router.get('/stats', (req, res) => {
  // Accepts ?date=YYYY-MM-DD, defaults to today
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const from = date + ' 00:00:00';
  const to   = date + ' 23:59:59';

  const row = db.prepare(`
    SELECT
      COUNT(*)                                                       AS total,
      SUM(CASE WHEN approved=1 THEN 1 ELSE 0 END)                   AS approved,
      SUM(CASE WHEN approved=0 THEN 1 ELSE 0 END)                   AS blocked,
      SUM(CASE WHEN destination='offer_a' THEN 1 ELSE 0 END)        AS offer_a,
      SUM(CASE WHEN destination='offer_b' THEN 1 ELSE 0 END)        AS offer_b
    FROM requests
    WHERE created_at BETWEEN ? AND ?
  `).get(from, to);

  const total    = row.total    || 0;
  const approved = row.approved || 0;
  const blocked  = row.blocked  || 0;
  const offer_a  = row.offer_a  || 0;
  const offer_b  = row.offer_b  || 0;
  const rate     = total > 0 ? ((approved / total) * 100).toFixed(1) : '0.0';

  res.json({ total, approved, blocked, offer_a, offer_b, approval_rate: rate, date });
});

// ── Campaigns ─────────────────────────────────────────────────────────────────

router.get('/campaigns', (_req, res) => {
  const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
  const parsed = campaigns.map(c => ({ ...c, filters: JSON.parse(c.filters || '{}') }));
  res.json(parsed);
});

router.get('/campaigns/:id', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json({ ...campaign, filters: JSON.parse(campaign.filters || '{}') });
});

router.post('/campaigns', (req, res) => {
  const { name, network, slug: rawSlug, status, safe_url, offer_url, offer_url_b, filters } = req.body;

  if (!name || !safe_url || !offer_url) {
    return res.status(400).json({ error: 'name, safe_url and offer_url are required' });
  }

  const slug = rawSlug ? slugify(rawSlug) : slugify(name);
  if (!slug) return res.status(400).json({ error: 'Invalid slug' });

  const existing = db.prepare('SELECT id FROM campaigns WHERE slug = ?').get(slug);
  if (existing) return res.status(400).json({ error: `Slug "${slug}" is already in use` });

  const filtersJson = JSON.stringify(filters || {});

  try {
    const info = db.prepare(`
      INSERT INTO campaigns (name, network, slug, status, safe_url, offer_url, offer_url_b, filters)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      network || 'Other',
      slug,
      status !== undefined ? (status ? 1 : 0) : 1,
      safe_url,
      offer_url,
      offer_url_b || null,
      filtersJson
    );

    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ...campaign, filters: JSON.parse(campaign.filters) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/campaigns/:id', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const { name, network, slug: rawSlug, status, safe_url, offer_url, offer_url_b, filters } = req.body;

  const slug = rawSlug ? slugify(rawSlug) : campaign.slug;

  if (slug !== campaign.slug) {
    const existing = db.prepare('SELECT id FROM campaigns WHERE slug = ? AND id != ?').get(slug, campaign.id);
    if (existing) return res.status(400).json({ error: `Slug "${slug}" is already in use` });
  }

  const filtersJson = JSON.stringify(filters !== undefined ? filters : JSON.parse(campaign.filters));

  try {
    db.prepare(`
      UPDATE campaigns
      SET name=?, network=?, slug=?, status=?, safe_url=?, offer_url=?, offer_url_b=?, filters=?
      WHERE id=?
    `).run(
      name       || campaign.name,
      network    || campaign.network,
      slug,
      status !== undefined ? (status ? 1 : 0) : campaign.status,
      safe_url   || campaign.safe_url,
      offer_url  || campaign.offer_url,
      offer_url_b !== undefined ? (offer_url_b || null) : campaign.offer_url_b,
      filtersJson,
      campaign.id
    );

    const updated = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign.id);
    res.json({ ...updated, filters: JSON.parse(updated.filters) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/campaigns/:id', (req, res) => {
  const campaign = db.prepare('SELECT id FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/campaigns/:id/duplicate', (req, res) => {
  const original = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!original) return res.status(404).json({ error: 'Campaign not found' });

  // Find a unique slug
  let baseSlug = original.slug + '-copy';
  let slug = baseSlug;
  let i = 2;
  while (db.prepare('SELECT id FROM campaigns WHERE slug = ?').get(slug)) {
    slug = baseSlug + '-' + i++;
  }

  try {
    const info = db.prepare(`
      INSERT INTO campaigns (name, network, slug, status, safe_url, offer_url, offer_url_b, filters)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      original.name + ' (Copy)',
      original.network,
      slug,
      original.safe_url,
      original.offer_url,
      original.offer_url_b || null,
      original.filters
    );

    const created = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ...created, filters: JSON.parse(created.filters) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Requests ──────────────────────────────────────────────────────────────────

router.get('/requests', (req, res) => {
  const page       = Math.max(1, parseInt(req.query.page)  || 1);
  const limit      = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset     = (page - 1) * limit;
  const campaignId = req.query.campaign_id;
  const date       = req.query.date; // YYYY-MM-DD
  const suspect    = req.query.suspect === '1';

  const conditions = [];
  const params     = [];

  if (campaignId) {
    conditions.push('campaign_id = ?');
    params.push(campaignId);
  }
  if (date) {
    conditions.push(`created_at BETWEEN ? AND ?`);
    params.push(date + ' 00:00:00', date + ' 23:59:59');
  }
  if (suspect) {
    // Approved visits to offer page that look like platform bots
    conditions.push(`approved = 1`);
    conditions.push(`(destination = 'offer_a' OR destination = 'offer_b')`);
    conditions.push(`(
      is_hosting = 1
      OR referrer IS NULL
      OR LOWER(isp) LIKE '%meta platforms%'
      OR LOWER(isp) LIKE '%facebook%'
      OR LOWER(isp) LIKE '%google llc%'
      OR LOWER(isp) LIKE '%google cloud%'
      OR LOWER(isp) LIKE '%bytedance%'
      OR LOWER(isp) LIKE '%amazon.com%'
      OR LOWER(isp) LIKE '%amazon tech%'
      OR LOWER(isp) LIKE '%twitter inc%'
      OR LOWER(isp) LIKE '%snap inc%'
      OR LOWER(isp) LIKE '%tiktok%'
      OR LOWER(isp) LIKE '%microsoft corp%'
    )`);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM requests ${where}`).get(...params).cnt;
  const rows  = db.prepare(
    `SELECT * FROM requests ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

// ── Profiles ──────────────────────────────────────────────────────────────────

function generateFprintId() {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `FP-${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`.toUpperCase();
}

const UA_TEMPLATES = {
  Chrome: {
    Windows: (bv, ov) => `Mozilla/5.0 (Windows NT ${ov}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bv} Safari/537.36`,
    macOS:   (bv, ov) => `Mozilla/5.0 (Macintosh; Intel Mac OS X ${ov}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bv} Safari/537.36`,
    Android: (bv, ov) => `Mozilla/5.0 (Linux; Android ${ov}; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bv} Mobile Safari/537.36`,
    iOS:     (bv, ov) => `Mozilla/5.0 (iPhone; CPU iPhone OS ${ov.replace(/\./g,'_')} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${bv} Mobile/15E148 Safari/604.1`,
    Linux:   (bv, ov) => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bv} Safari/537.36`,
  },
  Firefox: {
    Windows: (bv) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${bv}) Gecko/20100101 Firefox/${bv}`,
    macOS:   (bv) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:${bv}) Gecko/20100101 Firefox/${bv}`,
    Android: (bv) => `Mozilla/5.0 (Android 14; Mobile; rv:${bv}) Gecko/${bv} Firefox/${bv}`,
    iOS:     (bv) => `Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/${bv} Mobile/15E148 Safari/604.1`,
    Linux:   (bv) => `Mozilla/5.0 (X11; Linux x86_64; rv:${bv}) Gecko/20100101 Firefox/${bv}`,
  },
  Edge: {
    Windows: (bv, ov) => `Mozilla/5.0 (Windows NT ${ov}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bv} Safari/537.36 Edg/${bv}`,
    macOS:   (bv, ov) => `Mozilla/5.0 (Macintosh; Intel Mac OS X ${ov}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bv} Safari/537.36 Edg/${bv}`,
    Android: (bv, ov) => `Mozilla/5.0 (Linux; Android ${ov}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bv} Mobile Safari/537.36 EdgA/${bv}`,
    iOS:     (bv) => `Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/${bv} Mobile/15E148 Safari/604.1`,
    Linux:   (bv, ov) => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bv} Safari/537.36 Edg/${bv}`,
  },
  Safari: {
    macOS:   (bv, ov) => `Mozilla/5.0 (Macintosh; Intel Mac OS X ${ov}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${bv} Safari/605.1.15`,
    iOS:     (bv, ov) => `Mozilla/5.0 (iPhone; CPU iPhone OS ${ov.replace(/\./g,'_')} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${bv} Mobile/15E148 Safari/604.1`,
    Windows: (bv) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36`,
    Android: (bv) => `Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36`,
    Linux:   (bv) => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36`,
  },
  Brave: {
    Windows: (bv, ov) => `Mozilla/5.0 (Windows NT ${ov}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bv} Safari/537.36`,
    macOS:   (bv, ov) => `Mozilla/5.0 (Macintosh; Intel Mac OS X ${ov}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bv} Safari/537.36`,
    Android: (bv, ov) => `Mozilla/5.0 (Linux; Android ${ov}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bv} Mobile Safari/537.36`,
    iOS:     (bv) => `Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1`,
    Linux:   (bv) => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bv} Safari/537.36`,
  },
};

function buildUserAgent(browser, os, browserVersion, osVersion) {
  const tpl = (UA_TEMPLATES[browser] || UA_TEMPLATES.Chrome)[os] || UA_TEMPLATES.Chrome.Windows;
  return tpl(browserVersion, osVersion);
}

// ─── PAYMENT LINKS ────────────────────────────────────────────────────────────

router.get('/payment-links', (req, res) => {
  const links = db.prepare('SELECT * FROM payment_links ORDER BY created_at DESC').all();
  res.json(links);
});

router.get('/payment-links/:id', (req, res) => {
  const link = db.prepare('SELECT * FROM payment_links WHERE id = ?').get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Not found' });
  res.json(link);
});

router.post('/payment-links', (req, res) => {
  const { produto_nome, produto_desc, produto_imagem, produto_id, preco_1x, preco_2x, woovi_app_id, facebook_pixel_id, meta_access_token, meta_test_code, utmify_token, whatsapp_suporte, slug: rawSlug, status } = req.body;
  if (!produto_nome || !preco_1x) return res.status(400).json({ error: 'produto_nome e preco_1x são obrigatórios' });
  const slug = rawSlug ? slugify(rawSlug) : slugify(produto_nome) + '-' + Date.now().toString(36);
  if (!slug) return res.status(400).json({ error: 'Slug inválido' });
  const existing = db.prepare('SELECT id FROM payment_links WHERE slug = ?').get(slug);
  if (existing) return res.status(400).json({ error: `Slug "${slug}" já está em uso` });
  try {
    const info = db.prepare(`
      INSERT INTO payment_links (slug, produto_nome, produto_desc, produto_imagem, produto_id, preco_1x, preco_2x, woovi_app_id, facebook_pixel_id, meta_access_token, meta_test_code, utmify_token, whatsapp_suporte, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(slug, produto_nome, produto_desc||'', produto_imagem||'', produto_id||'produto-001', Number(preco_1x)||0, Number(preco_2x)||0, woovi_app_id||'', facebook_pixel_id||'', meta_access_token||'', meta_test_code||'', utmify_token||'', whatsapp_suporte||'', status!==undefined?(status?1:0):1);
    res.json(db.prepare('SELECT * FROM payment_links WHERE id = ?').get(info.lastInsertRowid));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/payment-links/:id', (req, res) => {
  const link = db.prepare('SELECT * FROM payment_links WHERE id = ?').get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Not found' });
  const { produto_nome, produto_desc, produto_imagem, produto_id, preco_1x, preco_2x, woovi_app_id, facebook_pixel_id, meta_access_token, meta_test_code, utmify_token, whatsapp_suporte, status } = req.body;
  db.prepare(`
    UPDATE payment_links SET produto_nome=?, produto_desc=?, produto_imagem=?, produto_id=?, preco_1x=?, preco_2x=?, woovi_app_id=?, facebook_pixel_id=?, meta_access_token=?, meta_test_code=?, utmify_token=?, whatsapp_suporte=?, status=? WHERE id=?
  `).run(
    produto_nome||link.produto_nome, produto_desc!==undefined?produto_desc:link.produto_desc,
    produto_imagem!==undefined?produto_imagem:link.produto_imagem, produto_id||link.produto_id,
    Number(preco_1x)||link.preco_1x, Number(preco_2x)||link.preco_2x,
    woovi_app_id!==undefined?woovi_app_id:link.woovi_app_id,
    facebook_pixel_id!==undefined?facebook_pixel_id:link.facebook_pixel_id,
    meta_access_token!==undefined?meta_access_token:link.meta_access_token,
    meta_test_code!==undefined?meta_test_code:link.meta_test_code,
    utmify_token!==undefined?utmify_token:link.utmify_token,
    whatsapp_suporte!==undefined?whatsapp_suporte:link.whatsapp_suporte,
    status!==undefined?(status?1:0):link.status,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM payment_links WHERE id = ?').get(req.params.id));
});

router.delete('/payment-links/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM payment_links WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM payment_links WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── ORDERS / FATURAMENTO ─────────────────────────────────────────────────────

router.get('/orders', (req, res) => {
  const { link_id, status, from, to, limit = 100 } = req.query;
  let sql = 'SELECT o.*, pl.produto_nome FROM orders o LEFT JOIN payment_links pl ON o.link_id = pl.id WHERE 1=1';
  const params = [];
  if (link_id) { sql += ' AND o.link_id = ?'; params.push(link_id); }
  if (status)  { sql += ' AND o.status = ?';  params.push(status); }
  if (from)    { sql += ' AND o.created_at >= ?'; params.push(from + ' 00:00:00'); }
  if (to)      { sql += ' AND o.created_at <= ?'; params.push(to + ' 23:59:59'); }
  sql += ' ORDER BY o.created_at DESC LIMIT ?';
  params.push(Number(limit) || 100);
  res.json(db.prepare(sql).all(...params));
});

router.get('/orders/summary', (req, res) => {
  const { from, to } = req.query;
  const date = from || new Date().toISOString().slice(0, 10);
  const dateFrom = (from || date) + ' 00:00:00';
  const dateTo   = (to   || date) + ' 23:59:59';
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_orders,
      SUM(CASE WHEN status='paid'    THEN 1 ELSE 0 END) AS paid_count,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN status='expired' OR status='cancelled' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN status='paid'    THEN valor ELSE 0 END) AS paid_total,
      SUM(CASE WHEN status='pending' THEN valor ELSE 0 END) AS pending_total,
      SUM(CASE WHEN status='paid' AND source='checkout'     THEN valor ELSE 0 END) AS checkout_revenue,
      SUM(CASE WHEN status='paid' AND source='whatsapp_bot' THEN valor ELSE 0 END) AS bot_revenue,
      SUM(CASE WHEN source='whatsapp_bot' THEN 1 ELSE 0 END) AS bot_orders,
      SUM(CASE WHEN source='checkout'     THEN 1 ELSE 0 END) AS checkout_orders
    FROM orders WHERE created_at BETWEEN ? AND ?
  `).get(dateFrom, dateTo);
  res.json(row);
});

router.get('/orders/by-campaign', (req, res) => {
  const { from, to } = req.query;
  const dateFrom = from ? from + ' 00:00:00' : null;
  const dateTo   = to   ? to   + ' 23:59:59' : null;
  let sql = `
    SELECT utm_campaign, utm_source, source,
      COUNT(*) AS total,
      SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN status='paid' THEN valor ELSE 0 END) AS revenue
    FROM orders WHERE utm_campaign IS NOT NULL AND utm_campaign != ''
  `;
  const params = [];
  if (dateFrom) { sql += ' AND created_at >= ?'; params.push(dateFrom); }
  if (dateTo)   { sql += ' AND created_at <= ?'; params.push(dateTo); }
  sql += ' GROUP BY utm_campaign, utm_source, source ORDER BY revenue DESC LIMIT 50';
  res.json(db.prepare(sql).all(...params));
});

// Origem das vendas — breakdown checkout vs WhatsApp bot
router.get('/orders/by-source', (req, res) => {
  const { from, to } = req.query;
  const dateFrom = from ? from + ' 00:00:00' : null;
  const dateTo   = to   ? to   + ' 23:59:59' : null;
  let sql = `
    SELECT source,
      COUNT(*) AS total,
      SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='paid' THEN valor ELSE 0 END) AS revenue
    FROM orders WHERE 1=1
  `;
  const params = [];
  if (dateFrom) { sql += ' AND created_at >= ?'; params.push(dateFrom); }
  if (dateTo)   { sql += ' AND created_at <= ?'; params.push(dateTo); }
  sql += ' GROUP BY source';
  res.json(db.prepare(sql).all(...params));
});


// Woovi webhook — chamado quando pagamento é confirmado
// Também notifica via Socket.IO e atualiza atribuição WhatsApp
router.post('/webhooks/woovi', (req, res) => {
  try {
    const { charge } = req.body || {};
    if (!charge) return res.json({ ok: false });

    const orderId  = charge.correlationID || charge.orderId;
    const wooviStatus = charge.status || '';
    let newStatus = null;
    if (wooviStatus === 'ACTIVE' || wooviStatus === 'COMPLETED') newStatus = 'paid';
    else if (wooviStatus === 'OVERDUE' || wooviStatus === 'EXPIRED') newStatus = 'expired';
    else if (wooviStatus === 'REFUNDED') newStatus = 'refunded';

    if (orderId && newStatus) {
      const paidAt = newStatus === 'paid' ? new Date().toISOString() : null;
      db.prepare('UPDATE orders SET status=?, paid_at=? WHERE order_id=?').run(newStatus, paidAt, orderId);

      // Recupera o pedido para emitir socket e notificar bot
      const order = db.prepare('SELECT * FROM orders WHERE order_id=?').get(orderId);
      if (order) {
        // Emite socket para atualizar o dashboard em tempo real
        if (req.app.get('io')) {
          req.app.get('io').emit('order:updated', {
            order_id: orderId, status: newStatus,
            valor: order.valor, customer_name: order.customer_name,
            link_slug: order.link_slug, source: order.source,
            utm_campaign: order.utm_campaign, whatsapp_jid: order.whatsapp_jid
          });
        }

        // Se veio do bot WhatsApp, atualiza a sessão como "finalizado com pagamento"
        if (newStatus === 'paid' && order.whatsapp_jid && req.app.get('bot')) {
          const botInstance = req.app.get('bot');
          const jid = order.whatsapp_jid + '@s.whatsapp.net';
          const session = botInstance.getSessions()[jid];
          if (session) {
            session.paymentConfirmed = true;
            session.paidOrderId = orderId;
            console.log('[WOOVI] Pagamento confirmado para lead WhatsApp:', jid);
          }
        }
      }
    }
    res.json({ ok: true });
  } catch(e) { console.error('[WOOVI] webhook error:', e.message); res.status(500).json({ error: e.message }); }
});

// Registrar pedido criado no checkout (chamado pelo JS do checkout)
// Suporta atribuição via WhatsApp bot (?wjid=phone) e UTMs do checkout
router.post('/orders/register', (req, res) => {
  const {
    link_slug, order_id, customer_name, customer_email, customer_phone, valor,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid,
    whatsapp_jid, // phone do lead WhatsApp (sem @s.whatsapp.net)
    source, ip
  } = req.body;

  if (!link_slug || !order_id) return res.status(400).json({ error: 'link_slug e order_id são obrigatórios' });
  const link = db.prepare('SELECT id FROM payment_links WHERE slug = ?').get(link_slug);

  // Se veio do WhatsApp Bot, tenta pegar UTMs da sessão do bot
  let finalUtmSource   = utm_source   || '';
  let finalUtmMedium   = utm_medium   || '';
  let finalUtmCampaign = utm_campaign || '';
  let finalUtmContent  = utm_content  || '';
  let finalUtmTerm     = utm_term     || '';
  let finalFbclid      = fbclid       || '';
  let finalSource      = source       || (whatsapp_jid ? 'whatsapp_bot' : 'checkout');

  if (whatsapp_jid && req.app.get('bot')) {
    const bot = req.app.get('bot');
    const jid = whatsapp_jid + '@s.whatsapp.net';
    const tracking = bot.getSessionTracking(jid);
    if (tracking) {
      // Prioriza UTMs do checkout (se não tiver, usa os da sessão do bot)
      if (!finalUtmSource   && tracking.utm_source)   finalUtmSource   = tracking.utm_source;
      if (!finalUtmMedium   && tracking.utm_medium)   finalUtmMedium   = tracking.utm_medium;
      if (!finalUtmCampaign && tracking.utm_campaign) finalUtmCampaign = tracking.utm_campaign;
      if (!finalUtmContent  && tracking.utm_content)  finalUtmContent  = tracking.utm_content;
      if (!finalUtmTerm     && tracking.utm_term)     finalUtmTerm     = tracking.utm_term;
      if (!finalFbclid      && tracking.fbclid)       finalFbclid      = tracking.fbclid;
    }
  }

  try {
    const existing = db.prepare('SELECT id FROM orders WHERE order_id = ?').get(order_id);
    if (existing) {
      // Atualiza dados do cliente se veio vazio antes
      db.prepare('UPDATE orders SET customer_name=COALESCE(NULLIF(customer_name,""),?), customer_email=COALESCE(NULLIF(customer_email,""),?), customer_phone=COALESCE(NULLIF(customer_phone,""),?) WHERE order_id=?')
        .run(customer_name||'', customer_email||'', customer_phone||'', order_id);
      return res.json({ ok: true, id: existing.id });
    }

    const info = db.prepare(`
      INSERT INTO orders (link_id, link_slug, order_id, customer_name, customer_email, customer_phone, valor, status, source, whatsapp_jid, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      link?.id||null, link_slug, order_id,
      customer_name||'', customer_email||'', customer_phone||'',
      Number(valor)||0,
      finalSource, whatsapp_jid||'',
      finalUtmSource, finalUtmMedium, finalUtmCampaign, finalUtmContent, finalUtmTerm, finalFbclid,
      ip||req.ip||''
    );

    // Emite socket para atualizar dashboard
    if (req.app.get('io')) {
      req.app.get('io').emit('order:new', {
        order_id, link_slug, valor: Number(valor)||0,
        source: finalSource, utm_campaign: finalUtmCampaign,
        customer_name: customer_name||''
      });
    }

    res.json({ ok: true, id: info.lastInsertRowid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// META CONFIG
router.get('/meta-config', (req, res) => {
  const cfg = db.prepare('SELECT * FROM meta_config WHERE id = 1').get();
  res.json(cfg || { access_token:'', ad_account_id:'', pixel_id:'' });
});
router.post('/meta-config', (req, res) => {
  const { access_token, ad_account_id, pixel_id } = req.body;
  const existing = db.prepare('SELECT id FROM meta_config WHERE id = 1').get();
  if (existing) {
    db.prepare('UPDATE meta_config SET access_token=?, ad_account_id=?, pixel_id=?, updated_at=datetime('now') WHERE id=1').run(access_token||'', ad_account_id||'', pixel_id||'');
  } else {
    db.prepare('INSERT INTO meta_config (id, access_token, ad_account_id, pixel_id) VALUES (1,?,?,?)').run(access_token||'', ad_account_id||'', pixel_id||'');
  }
  res.json({ ok: true });
});

// META ADS — proxy para API (evita expor token no frontend)
router.get('/meta/campaigns', async (req, res) => {
  const cfg = db.prepare('SELECT * FROM meta_config WHERE id = 1').get();
  if (!cfg || !cfg.access_token || !cfg.ad_account_id) return res.json({ data: [] });
  const { from, to } = req.query;
  const since = from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  const until = to   || new Date().toISOString().slice(0,10);
  try {
    const https = require('https');
    const url = `https://graph.facebook.com/v19.0/act_${cfg.ad_account_id}/insights?level=campaign&fields=campaign_name,campaign_id,spend,clicks,impressions,reach&time_range={"since":"${since}","until":"${until}"}&access_token=${cfg.access_token}`;
    const data = await new Promise((resolve, reject) => {
      https.get(url, resp => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({ data:[], error: e.message }); } });
      }).on('error', e => reject(e));
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
