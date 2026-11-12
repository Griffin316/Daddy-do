-- Daddy-Do schema v2 (Cloudflare D1 / SQLite): accounts + households.
-- Anyone can sign up; two accounts become a household by email invite. Every row of
-- household data carries household_id, and every query is scoped to the signed-in
-- member's household.
--
-- Fresh database: npx wrangler d1 execute daddy-do --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS households (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,              -- lowercase; used to sign in and to receive invites
  name          TEXT    NOT NULL,                     -- shown on Do's ("Dad", "Sarah"); unique within a household
  role          TEXT    NOT NULL DEFAULT 'requester', -- fixer (does the Do's) | requester (asks for Do's)
  pw            TEXT    NOT NULL,                     -- pbkdf2$iter$salt$hash
  household_id  INTEGER REFERENCES households(id),    -- NULL until linked
  session_v     INTEGER NOT NULL DEFAULT 1,           -- bump to sign out every device
  failed        INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_household ON users(household_id);

-- Household invites, addressed to an email. Accepted by the account with that email
-- (or by whoever opens the invite link).
CREATE TABLE IF NOT EXISTS invites (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL REFERENCES households(id),
  from_user    INTEGER NOT NULL REFERENCES users(id),
  to_email     TEXT    NOT NULL,
  code_hash    TEXT    NOT NULL UNIQUE,
  status       TEXT    NOT NULL DEFAULT 'pending',   -- pending | accepted | declined | cancelled
  expires_at   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  accepted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(to_email, status);

-- One-time password-reset codes a household member makes for another (24 h). Stored hashed.
CREATE TABLE IF NOT EXISTS reset_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash  TEXT    NOT NULL UNIQUE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT    NOT NULL,
  used_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id   INTEGER NOT NULL REFERENCES households(id),
  title          TEXT    NOT NULL,
  description    TEXT    NOT NULL DEFAULT '',
  requester      TEXT    NOT NULL,
  assignee       TEXT    NOT NULL DEFAULT '',
  -- P1 = today / safety, P2 = this week, P3 = when you can, P4 = someday
  priority       INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  estimate_min   INTEGER NOT NULL DEFAULT 0,
  category       TEXT    NOT NULL DEFAULT 'general',
  location       TEXT    NOT NULL DEFAULT '',
  -- new -> backlog -> scheduled -> in_progress -> blocked -> resolved -> closed
  status         TEXT    NOT NULL DEFAULT 'new',
  blocked_reason TEXT    NOT NULL DEFAULT '',
  due_date       TEXT,
  sprint_week    TEXT,
  scheduled_for  TEXT,
  scheduled_time TEXT,
  recur_days     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at    TEXT,
  closed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_hh_status ON tickets(household_id, status);

CREATE TABLE IF NOT EXISTS comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL,
  ticket_id    INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author       TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  is_system    INTEGER NOT NULL DEFAULT 0,  -- 1 = audit entry (status change etc.)
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id);

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL,
  recipient    TEXT    NOT NULL,
  ticket_id    INTEGER,
  actor        TEXT    NOT NULL,
  kind         TEXT    NOT NULL,  -- new | status | update | scheduled | resolved | comment | reward | points
  body         TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  read_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications(household_id, recipient, read_at);

-- Points ledger. Positive = earned, negative = spent on a reward.
CREATE TABLE IF NOT EXISTS points (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL,
  member       TEXT    NOT NULL,
  ticket_id    INTEGER,
  kind         TEXT    NOT NULL,  -- complete | ontime | thanks | redeem | bonus
  points       INTEGER NOT NULL,
  note         TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_points_hh ON points(household_id, member);
CREATE INDEX IF NOT EXISTS idx_points_ticket ON points(ticket_id);

CREATE TABLE IF NOT EXISTS rewards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL,
  title        TEXT    NOT NULL,
  cost         INTEGER NOT NULL CHECK (cost > 0),
  emoji        TEXT    NOT NULL DEFAULT '🎁',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Per-household key/value settings: capacity_min, dictionary, gemini_key_enc, ...
CREATE TABLE IF NOT EXISTS settings (
  household_id INTEGER NOT NULL,
  key          TEXT    NOT NULL,
  value        TEXT    NOT NULL,
  PRIMARY KEY (household_id, key)
);
-- Site-wide config set by the site owner (first account), e.g. the Google OAuth client.
CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Each person's own Gmail connection (tokens encrypted with SESSION_SECRET). Email bodies are never stored.
CREATE TABLE IF NOT EXISTS gmail_accounts (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id),
  email        TEXT    NOT NULL,
  refresh_enc  TEXT    NOT NULL,
  access_enc   TEXT,
  access_exp   INTEGER NOT NULL DEFAULT 0,  -- ms since epoch
  connected_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Email threads linked to a Do. Only metadata; the chain is read live from the owner's Gmail.
CREATE TABLE IF NOT EXISTS ticket_threads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id  INTEGER NOT NULL,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),  -- whose Gmail the thread is in
  thread_id     TEXT    NOT NULL,
  subject       TEXT    NOT NULL DEFAULT '',
  correspondent TEXT    NOT NULL DEFAULT '',
  linked_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (ticket_id, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_threads_thread ON ticket_threads(household_id, thread_id);

-- Semantic search passages (lib/search.js). vec = normalised int8 embedding, base64 (bge-base-en-v1.5, 768 dims).
CREATE TABLE IF NOT EXISTS search_chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL,
  ticket_id    INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,   -- do | comment | history | email
  text         TEXT    NOT NULL,
  vec          TEXT    NOT NULL,
  indexed_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_search_chunks_hh ON search_chunks(household_id, ticket_id);
