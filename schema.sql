-- GTM Auditor – Full Schema
-- Run via: npx wrangler d1 execute gtm-chat-history --file=./schema.sql --remote

-- ── Enforce foreign key constraints (SQLite has them OFF by default) ──────────

PRAGMA foreign_keys = ON;

-- ── Authentication ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    password TEXT NOT NULL,
    app TEXT NOT NULL DEFAULT 'gtm' CHECK(app IN ('gtm', 'ga4')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
);

-- Composite unique: same username/email allowed across different apps
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_app ON users(username, app);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_app ON users(email, app);

CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invite_keys (
    invite_key TEXT PRIMARY KEY,
    app TEXT, -- 'gtm' or 'ga4'
    created_by TEXT NOT NULL,
    used_by TEXT,
    used_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (used_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    mode TEXT, -- 'gtm' or 'ga4'
    ga4_property_id TEXT,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL, -- 'user' or 'model'
    text TEXT NOT NULL,
    charts TEXT, -- JSON array of chart URLs
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- ── Auth indexes ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user
  ON auth_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires
  ON auth_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_invite_keys_created_by
  ON invite_keys(created_by);

-- ── Chat History ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT    PRIMARY KEY,
  title           TEXT    NOT NULL DEFAULT 'New Chat',
  mode            TEXT    NOT NULL DEFAULT 'gtm' CHECK(mode IN ('gtm', 'ga4')),
  ga4_property_id TEXT,
  user_id         TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL CHECK(role IN ('user', 'model')),
  text       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

-- ── Chat indexes ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON sessions(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_user_mode
  ON sessions(user_id, mode, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages(session_id, created_at);

-- ── GA4 OAuth Tokens ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ga4_oauth_tokens (
  user_id         TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token    TEXT    NOT NULL,
  refresh_token   TEXT    NOT NULL,
  token_expiry    INTEGER NOT NULL,
  scope           TEXT    NOT NULL,
  connected_email TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) WITHOUT ROWID;

-- ── Maintenance ───────────────────────────────────────────────────────────────
-- Purge expired auth tokens periodically (run manually or via a CRON trigger):
--   DELETE FROM auth_tokens WHERE expires_at < (strftime('%s','now') * 1000);
