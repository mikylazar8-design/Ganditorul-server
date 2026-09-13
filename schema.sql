-- Ganditorul - schema serverului real (conturi + chat comun).
-- Inlocuieste user://accounts.json si user://chat_log.json (mock-uri locale).
-- SQLite

CREATE TABLE IF NOT EXISTS accounts (
  email TEXT PRIMARY KEY,             -- normalizat: strip + lowercase
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,        -- scrypt, hex
  password_salt TEXT NOT NULL,        -- hex, per cont

  verified INTEGER NOT NULL DEFAULT 0,      -- 0/1 - devine 1 la /api/verify
  verification_code TEXT,                   -- 6 cifre, NULL dupa verificare
  verification_expires INTEGER,             -- unix seconds, NULL dupa verificare

  total_points INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  day_streak INTEGER NOT NULL DEFAULT 0,
  last_login_date TEXT NOT NULL DEFAULT '',
  last_match_bonus_date TEXT NOT NULL DEFAULT '',
  win_streak INTEGER NOT NULL DEFAULT 0,
  bot_games_remaining INTEGER NOT NULL DEFAULT 0,
  color_hex TEXT NOT NULL DEFAULT '#1b3a6b',

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- numele afisat trebuie sa fie unic (necesar in chat/clasament) - insensibil la
-- majuscule, ca "Ion" si "ion" sa nu poata coexista ca doua conturi diferite
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_display_name_unique ON accounts(display_name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'system'
  from_name TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  ts REAL NOT NULL                      -- unix seconds (cu zecimale), ca Time.get_unix_time_from_system()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_ts ON chat_messages(ts);
