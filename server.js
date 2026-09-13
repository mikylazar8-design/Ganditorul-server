// Ganditorul - server real: conturi (cu verificare de email), sesiuni si chat comun.
// Inlocuieste mock-urile locale godot/autoload/Auth.gd si Chat.gd.

import express from 'express';
import cors from 'cors';
import { db, normalizeEmail } from './db.js';
import { hashPassword, verifyPassword, signToken, verifyToken, generateVerificationCode } from './auth.js';
import { sendVerificationCode } from './email.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const VERIFICATION_TTL_SECONDS = 15 * 60;

// --- reguli identice cu validarea locala din Auth.gd de azi ---
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function validateRegistration(email, password, displayName) {
  if (!EMAIL_PATTERN.test(String(email || ''))) return 'Introdu o adresă de email validă.';
  if (String(password || '').length < 6) return 'Parola trebuie să aibă minimum 6 caractere.';
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  if (!hasLetter || !hasDigit) return 'Parola trebuie să conțină atât litere, cât și cifre.';
  if (!String(displayName || '').trim()) return 'Alege un nume afișat.';
  return null;
}

// --- XP/nivel/streak - portate identic din Auth.gd (record_match_result) ---
const XP_BASE = 100;
const XP_PER_LEVEL = 30;
const XP_MATCH_COMPLETE = 40;
const XP_FIRST_MATCH_TODAY = 25;

function xpForLevel(level) {
  return XP_BASE + level * XP_PER_LEVEL;
}

function todayString() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function isConsecutiveDay(previous, current) {
  if (!previous) return false;
  const prev = Date.parse(previous + 'T00:00:00Z');
  const curr = Date.parse(current + 'T00:00:00Z');
  return curr - prev === 86400 * 1000;
}

function applyDayStreak(row) {
  const today = todayString();
  if (row.last_login_date === today) {
    // deja contorizat azi
  } else if (isConsecutiveDay(row.last_login_date, today)) {
    row.day_streak += 1;
  } else {
    row.day_streak = 1;
  }
  row.last_login_date = today;
}

// --- acces DB ---

const getAccountStmt = db.prepare('SELECT * FROM accounts WHERE email = ?');
const getAccountByNameStmt = db.prepare('SELECT email FROM accounts WHERE LOWER(display_name) = LOWER(?)');
const insertAccountStmt = db.prepare(`
  INSERT INTO accounts (email, display_name, password_hash, password_salt, verification_code, verification_expires)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const deleteAccountStmt = db.prepare('DELETE FROM accounts WHERE email = ?');

function getAccount(email) {
  return getAccountStmt.get(normalizeEmail(email));
}

function saveAccount(row) {
  db.prepare(`
    UPDATE accounts SET
      display_name = ?, verified = ?, verification_code = ?, verification_expires = ?,
      total_points = ?, games_played = ?, xp = ?, level = ?, day_streak = ?,
      last_login_date = ?, last_match_bonus_date = ?, win_streak = ?,
      bot_games_remaining = ?, color_hex = ?
    WHERE email = ?
  `).run(
    row.display_name, row.verified, row.verification_code, row.verification_expires,
    row.total_points, row.games_played, row.xp, row.level, row.day_streak,
    row.last_login_date, row.last_match_bonus_date, row.win_streak,
    row.bot_games_remaining, row.color_hex, row.email
  );
}

function publicAccount(row) {
  return {
    email: row.email,
    display_name: row.display_name,
    total_points: row.total_points,
    games_played: row.games_played,
    xp: row.xp,
    level: row.level,
    day_streak: row.day_streak,
    win_streak: row.win_streak,
    bot_games_remaining: row.bot_games_remaining,
    color_hex: row.color_hex,
  };
}

// --- app ---

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/register', async (req, res) => {
  const { email, password, display_name } = req.body || {};
  const error = validateRegistration(email, password, display_name);
  if (error) return res.json({ ok: false, error });

  const key = normalizeEmail(email);
  if (getAccount(key)) {
    return res.json({ ok: false, error: 'Există deja un cont cu acest email.' });
  }
  if (getAccountByNameStmt.get(String(display_name).trim())) {
    return res.json({ ok: false, error: 'Acest nume există deja. Alege alt nume afișat.' });
  }

  const { hash, salt } = hashPassword(password);
  const code = generateVerificationCode();
  const expires = Math.floor(Date.now() / 1000) + VERIFICATION_TTL_SECONDS;

  insertAccountStmt.run(key, String(display_name).trim(), hash, salt, code, expires);

  try {
    await sendVerificationCode(key, code);
  } catch (err) {
    deleteAccountStmt.run(key);
    console.error('Trimitere email esuata:', err);
    return res.json({ ok: false, error: 'Nu am putut trimite emailul de verificare. Încearcă din nou.' });
  }

  res.json({ ok: true, pending_verification: true });
});

app.post('/api/resend-code', async (req, res) => {
  const key = normalizeEmail(req.body?.email || '');
  const row = getAccount(key);
  if (!row) return res.json({ ok: false, error: 'Cont inexistent.' });
  if (row.verified) return res.json({ ok: false, error: 'Contul e deja verificat.' });

  const code = generateVerificationCode();
  const expires = Math.floor(Date.now() / 1000) + VERIFICATION_TTL_SECONDS;
  row.verification_code = code;
  row.verification_expires = expires;
  saveAccount(row);

  try {
    await sendVerificationCode(key, code);
  } catch (err) {
    console.error('Retrimitere email esuata:', err);
    return res.json({ ok: false, error: 'Nu am putut retrimite emailul. Încearcă din nou.' });
  }

  res.json({ ok: true });
});

app.post('/api/verify', (req, res) => {
  const key = normalizeEmail(req.body?.email || '');
  const code = String(req.body?.code || '').trim();
  const row = getAccount(key);
  if (!row) return res.json({ ok: false, error: 'Cont inexistent.' });

  if (!row.verified) {
    if (!row.verification_code || row.verification_code !== code) {
      return res.json({ ok: false, error: 'Cod incorect.' });
    }
    if (row.verification_expires < Math.floor(Date.now() / 1000)) {
      return res.json({ ok: false, error: 'Codul a expirat, cere unul nou.', expired: true });
    }
    row.verified = 1;
    row.verification_code = null;
    row.verification_expires = null;
    applyDayStreak(row);
    saveAccount(row);
  }

  res.json({ ok: true, token: signToken(key), account: publicAccount(row) });
});

app.post('/api/login', (req, res) => {
  const key = normalizeEmail(req.body?.email || '');
  const password = String(req.body?.password || '');
  const row = getAccount(key);
  if (!row || !verifyPassword(password, row.password_salt, row.password_hash)) {
    return res.json({ ok: false, error: 'Email sau parolă incorecte.' });
  }
  if (!row.verified) {
    return res.json({ ok: false, error: 'Email neverificat.', needs_verification: true });
  }

  applyDayStreak(row);
  saveAccount(row);
  res.json({ ok: true, token: signToken(key), account: publicAccount(row) });
});

// --- middleware de autentificare (Bearer token) pt. rutele de mai jos ---
function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const email = verifyToken(token);
  if (!email) return res.status(401).json({ ok: false, error: 'Sesiune invalidă sau expirată.' });
  const row = getAccount(email);
  if (!row) return res.status(401).json({ ok: false, error: 'Cont inexistent.' });
  req.account = row;
  next();
}

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ ok: true, account: publicAccount(req.account) });
});

app.put('/api/me/color', requireAuth, (req, res) => {
  const row = req.account;
  row.color_hex = String(req.body?.color_hex || row.color_hex);
  saveAccount(row);
  res.json({ ok: true, account: publicAccount(row) });
});

app.post('/api/match-result', requireAuth, (req, res) => {
  const row = req.account;
  const points = Math.trunc(Number(req.body?.points || 0));
  const placement = Math.trunc(Number(req.body?.placement || 0));

  row.total_points += points;
  row.games_played += 1;

  if (placement === 1) row.win_streak += 1;
  else if (placement > 1) row.win_streak = 0;

  const breakdown = [{ label: 'Finalizare și răspunsuri', xp: XP_MATCH_COMPLETE }];
  let xpGained = XP_MATCH_COMPLETE;
  const today = todayString();
  if (row.last_match_bonus_date !== today) {
    breakdown.push({ label: 'Primul joc azi', xp: XP_FIRST_MATCH_TODAY });
    xpGained += XP_FIRST_MATCH_TODAY;
    row.last_match_bonus_date = today;
  }

  let { level, xp } = row;
  xp += xpGained;
  let leveledUp = false;
  while (xp >= xpForLevel(level)) {
    xp -= xpForLevel(level);
    level += 1;
    leveledUp = true;
  }
  row.xp = xp;
  row.level = level;

  saveAccount(row);

  res.json({
    ok: true,
    xp_gained: xpGained,
    breakdown,
    leveled_up: leveledUp,
    level,
    xp,
    xp_for_next_level: xpForLevel(level),
    day_streak: row.day_streak,
    win_streak: row.win_streak,
    account: publicAccount(row),
  });
});

app.post('/api/bot-games/add', requireAuth, (req, res) => {
  const row = req.account;
  const amount = Math.trunc(Number(req.body?.amount || 0));
  row.bot_games_remaining += amount;
  saveAccount(row);
  res.json({ ok: true, remaining: row.bot_games_remaining });
});

app.post('/api/bot-games/consume', requireAuth, (req, res) => {
  const row = req.account;
  row.bot_games_remaining = Math.max(0, row.bot_games_remaining - 1);
  saveAccount(row);
  res.json({ ok: true, remaining: row.bot_games_remaining });
});

// --- chat comun (polling simplu - vezi motivatia in PROGRESS.md/plan: mai robust
// decat WebSocket pt. o prima versiune, fara stare de conexiune de gestionat) ---

const MAX_CHAT_MESSAGES = 200;
const insertChatStmt = db.prepare(
  'INSERT INTO chat_messages (kind, from_name, color, text, ts) VALUES (?, ?, ?, ?, ?)'
);
const trimChatStmt = db.prepare(`
  DELETE FROM chat_messages WHERE id NOT IN (
    SELECT id FROM chat_messages ORDER BY ts DESC LIMIT ?
  )
`);

function appendChatMessage(kind, fromName, color, text) {
  const ts = Date.now() / 1000;
  insertChatStmt.run(kind, fromName, color, text, ts);
  trimChatStmt.run(MAX_CHAT_MESSAGES);
}

app.get('/api/chat', (req, res) => {
  const since = Number(req.query.since || 0);
  const rows = db
    .prepare('SELECT kind, from_name AS "from", color, text, ts FROM chat_messages WHERE ts > ? ORDER BY ts ASC LIMIT 200')
    .all(since);
  res.json({ ok: true, messages: rows });
});

app.post('/api/chat', requireAuth, (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 300);
  if (!text) return res.json({ ok: false, error: 'Mesaj gol.' });
  appendChatMessage('user', req.account.display_name, req.account.color_hex, text);
  res.json({ ok: true });
});

app.post('/api/chat/announce', requireAuth, (req, res) => {
  appendChatMessage('system', '', '', `Bun venit, ${req.account.display_name}!`);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Ganditorul server ruleaza pe portul ${PORT}`);
});
