-- Daddy-Do schema (Cloudflare D1 / SQLite)
-- Apply: npx wrangler d1 execute daddy-do --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS tickets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',
  requester     TEXT    NOT NULL,
  assignee      TEXT    NOT NULL DEFAULT '',
  -- P1 = today / safety, P2 = this week, P3 = when you can, P4 = someday
  priority      INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  -- estimate in minutes (0 = not yet triaged)
  estimate_min  INTEGER NOT NULL DEFAULT 0,
  category      TEXT    NOT NULL DEFAULT 'general',
  location      TEXT    NOT NULL DEFAULT '',
  -- new -> backlog -> scheduled -> in_progress -> blocked -> resolved -> closed
  status        TEXT    NOT NULL DEFAULT 'new',
  blocked_reason TEXT   NOT NULL DEFAULT '',
  due_date      TEXT,              -- YYYY-MM-DD, optional
  sprint_week   TEXT,              -- Monday of the planned week, YYYY-MM-DD
  recur_days    INTEGER NOT NULL DEFAULT 0, -- >0: reopen a copy N days after close
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT,
  closed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_sprint ON tickets(sprint_week);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author     TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  -- 1 = system-generated audit entry (status change etc.)
  is_system  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id);

-- Key/value settings: household members, weekly capacity, etc.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('members', '[{"name":"Dad","role":"fixer"},{"name":"Mom","role":"requester"}]'),
  ('capacity_min', '240');
