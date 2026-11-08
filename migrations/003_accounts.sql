-- Accounts: one household per site. Members sign in with username + password.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,              -- lowercase login name
  name          TEXT    NOT NULL UNIQUE COLLATE NOCASE, -- display name used on Do's ("Mom", "Griffin")
  role          TEXT    NOT NULL DEFAULT 'requester',  -- fixer | requester
  pw            TEXT    NOT NULL,                      -- pbkdf2$iter$salt$hash
  session_v     INTEGER NOT NULL DEFAULT 1,            -- bump to sign out every device
  failed        INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- One-time codes: household invites (7 days) and password resets (24 hours). Stored hashed.
CREATE TABLE IF NOT EXISTS codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash  TEXT    NOT NULL UNIQUE,
  kind       TEXT    NOT NULL,          -- invite | reset
  role       TEXT,                      -- invite: role for the new member
  name_hint  TEXT,                      -- invite: suggested display name
  user_id    INTEGER,                   -- reset: whose password
  created_by INTEGER NOT NULL,
  expires_at TEXT    NOT NULL,
  used_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
