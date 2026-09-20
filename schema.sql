-- Ganditorul - schema serverului real (conturi + chat comun).
-- Inlocuieste user://accounts.json si user://chat_log.json (mock-uri locale).
-- SQLite

-- Cont = nume afisat + parola, fara email/verificare (simplificat explicit de
-- utilizator 2026-09-20, dupa ce verificarea prin email s-a dovedit nefiabila -
-- vezi PROGRESS.md pt. investigatia Resend/DMARC abandonata odata cu asta).
-- Numele e chiar cheia primara - COLLATE NOCASE face unicitatea insensibila la
-- majuscule direct la nivel de coloana ("Ion"/"ion" nu pot coexista), fara index
-- separat. Restrictia ca numele sa nu se suprapuna cu un nume de bot (vezi
-- BOT_NAMES din server.js) se verifica separat, in validateRegistration.
CREATE TABLE IF NOT EXISTS accounts (
  display_name TEXT PRIMARY KEY COLLATE NOCASE,
  password_hash TEXT NOT NULL,        -- scrypt, hex
  password_salt TEXT NOT NULL,        -- hex, per cont

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

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'system'
  from_name TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  ts REAL NOT NULL                      -- unix seconds (cu zecimale), ca Time.get_unix_time_from_system()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_ts ON chat_messages(ts);
