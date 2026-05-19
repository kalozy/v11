const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || './data/cloaker.db';
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS campaigns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    network     TEXT    NOT NULL DEFAULT 'Other',
    slug        TEXT    NOT NULL UNIQUE,
    status      INTEGER NOT NULL DEFAULT 1,
    safe_url    TEXT    NOT NULL,
    offer_url   TEXT    NOT NULL,
    filters     TEXT    NOT NULL DEFAULT '{}',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id     INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    campaign_name   TEXT,
    ip              TEXT,
    country         TEXT,
    region          TEXT,
    city            TEXT,
    isp             TEXT,
    is_proxy        INTEGER DEFAULT 0,
    is_vpn          INTEGER DEFAULT 0,
    is_hosting      INTEGER DEFAULT 0,
    device          TEXT,
    os              TEXT,
    browser         TEXT,
    approved        INTEGER NOT NULL DEFAULT 1,
    block_reason    TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_requests_campaign ON requests(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_requests_created  ON requests(created_at);
  CREATE INDEX IF NOT EXISTS idx_campaigns_slug    ON campaigns(slug);
`);

db.exec(`
`);

// ── Payment Links & Orders ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS payment_links (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER REFERENCES users(id) ON DELETE CASCADE,
    slug              TEXT    NOT NULL UNIQUE,
    produto_nome      TEXT    NOT NULL,
    produto_desc      TEXT    NOT NULL DEFAULT '',
    produto_imagem    TEXT    NOT NULL DEFAULT '',
    produto_id        TEXT    NOT NULL DEFAULT 'produto-001',
    preco_1x          INTEGER NOT NULL DEFAULT 0,
    preco_2x          INTEGER NOT NULL DEFAULT 0,
    woovi_app_id      TEXT    NOT NULL DEFAULT '',
    facebook_pixel_id TEXT    NOT NULL DEFAULT '',
    meta_access_token TEXT    NOT NULL DEFAULT '',
    meta_test_code    TEXT    NOT NULL DEFAULT '',
    utmify_token      TEXT    NOT NULL DEFAULT '',
    whatsapp_suporte  TEXT    NOT NULL DEFAULT '',
    status            INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    link_id         INTEGER REFERENCES payment_links(id) ON DELETE SET NULL,
    link_slug       TEXT,
    order_id        TEXT    NOT NULL UNIQUE,
    customer_name   TEXT,
    customer_email  TEXT,
    customer_phone  TEXT,
    valor           INTEGER NOT NULL DEFAULT 0,
    status          TEXT    NOT NULL DEFAULT 'pending',
    source          TEXT    NOT NULL DEFAULT 'checkout',
    whatsapp_jid    TEXT,
    utm_source      TEXT,
    utm_medium      TEXT,
    utm_campaign    TEXT,
    utm_content     TEXT,
    utm_term        TEXT,
    fbclid          TEXT,
    meta_campaign_id TEXT,
    meta_ad_id      TEXT,
    ip              TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    paid_at         TEXT
  );

  CREATE TABLE IF NOT EXISTS meta_config (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    access_token    TEXT    NOT NULL DEFAULT '',
    ad_account_id   TEXT    NOT NULL DEFAULT '',
    pixel_id        TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_orders_link     ON orders(link_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_created  ON orders(created_at);

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    plan          TEXT    NOT NULL DEFAULT 'free',
    status        TEXT    NOT NULL DEFAULT 'active',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    last_login    TEXT
  );

  CREATE TABLE IF NOT EXISTS user_sessions_store (
    sid    TEXT PRIMARY KEY,
    sess   TEXT NOT NULL,
    expire INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_plinks_slug     ON payment_links(slug);
`);

// Migrations: add new columns to existing DBs without breaking deployments
const migrations = [
  'ALTER TABLE requests ADD COLUMN user_agent TEXT',
  'ALTER TABLE requests ADD COLUMN referrer TEXT',
  'ALTER TABLE requests ADD COLUMN url_params TEXT',
  'ALTER TABLE requests ADD COLUMN browser_version TEXT',
  // v2 migrations
  'ALTER TABLE requests ADD COLUMN destination TEXT',
  'ALTER TABLE requests ADD COLUMN accept_language TEXT',
  'ALTER TABLE requests ADD COLUMN sec_ch_ua TEXT',
  'ALTER TABLE requests ADD COLUMN sec_ch_ua_platform TEXT',
  'ALTER TABLE campaigns ADD COLUMN offer_url_b TEXT',
  // v3 — payment links & orders
  'ALTER TABLE orders ADD COLUMN user_id INTEGER',
  'ALTER TABLE payment_links ADD COLUMN user_id INTEGER',
  "ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'checkout'",
  'ALTER TABLE orders ADD COLUMN whatsapp_jid TEXT',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists, skip */ }
}

module.exports = db;
