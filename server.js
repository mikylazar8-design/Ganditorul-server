// Ganditorul - server real: conturi (nume afisat + parola, fara email) si chat comun.
// Inlocuieste mock-urile locale godot/autoload/Auth.gd si Chat.gd.
//
// Simplificat explicit de utilizator 2026-09-20: verificarea prin email (Resend) s-a
// dovedit nefiabila in practica (niciun aderent nu primea codul, doar contul Resend
// insusi - investigatie DMARC/deliverability abandonata odata cu asta, vezi
// PROGRESS.md) - a fost scoasa complet, in favoarea unui model simplu nume+parola,
// ca la majoritatea jocurilor casual. Contul devine activ imediat la inregistrare.

import express from 'express';
import cors from 'cors';
import { db } from './db.js';
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// Numele de bot (vezi godot/scripts/Bot.gd, BOT_NAMES) NU pot fi luate de un jucator
// real - altfel s-ar putea suprapune cu rotatia de boti si ar strica exact scopul ei
// (sa para jucatori reali distincti). Duplicat intentionat, cross-limbaj (GDScript vs.
// Node) - trebuie sa ramana identic cu lista din Bot.gd la orice modificare acolo.
const BOT_NAMES = new Set([
  'fritz98', 'issa85', 'freud6', 'libeina', 'anemarie', 'luise07', 'rudy',
  'hansi23', 'gundula', 'manfred71', 'waltraud9', 'juergen19', 'sabine84',
  'dieter42', 'ingrid7', 'klausi', 'brunhilde', 'helmut33', 'petra09',
  'wolfi88', 'gerda55', 'matthias12', 'ulrike6', 'reinhardt', 'monika77',
  'ottoline', 'heidi31', 'gunther14', 'roswitha', 'bernd63',
]);

// --- reguli identice cu validarea locala din Auth.gd de azi ---
function validateRegistration(displayName, password) {
  const name = String(displayName || '').trim();
  if (!name) return 'Alege un nume afișat.';
  if (name.length > 24) return 'Numele poate avea cel mult 24 de caractere.';
  if (BOT_NAMES.has(name.toLowerCase())) return 'Acest nume este rezervat. Alege alt nume afișat.';
  if (String(password || '').length < 6) return 'Parola trebuie să aibă minimum 6 caractere.';
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  if (!hasLetter || !hasDigit) return 'Parola trebuie să conțină atât litere, cât și cifre.';
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

const getAccountStmt = db.prepare('SELECT * FROM accounts WHERE display_name = ?');
const insertAccountStmt = db.prepare(`
  INSERT INTO accounts (display_name, password_hash, password_salt)
  VALUES (?, ?, ?)
`);

function getAccount(displayName) {
  return getAccountStmt.get(displayName);
}

function saveAccount(row) {
  db.prepare(`
    UPDATE accounts SET
      total_points = ?, games_played = ?, xp = ?, level = ?, day_streak = ?,
      last_login_date = ?, last_match_bonus_date = ?, win_streak = ?,
      bot_games_remaining = ?, color_hex = ?
    WHERE display_name = ?
  `).run(
    row.total_points, row.games_played, row.xp, row.level, row.day_streak,
    row.last_login_date, row.last_match_bonus_date, row.win_streak,
    row.bot_games_remaining, row.color_hex, row.display_name
  );
}

function publicAccount(row) {
  return {
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

app.post('/api/register', (req, res) => {
  const { password } = req.body || {};
  const displayName = String(req.body?.display_name || '').trim();
  const error = validateRegistration(displayName, password);
  if (error) return res.json({ ok: false, error });

  if (getAccount(displayName)) {
    return res.json({ ok: false, error: 'Acest nume există deja. Alege alt nume afișat.' });
  }

  const { hash, salt } = hashPassword(password);
  insertAccountStmt.run(displayName, hash, salt);

  const row = getAccount(displayName);
  applyDayStreak(row);
  saveAccount(row);
  res.json({ ok: true, token: signToken(row.display_name), account: publicAccount(row) });
});

app.post('/api/login', (req, res) => {
  const displayName = String(req.body?.display_name || '').trim();
  const password = String(req.body?.password || '');
  const row = getAccount(displayName);
  if (!row || !verifyPassword(password, row.password_salt, row.password_hash)) {
    return res.json({ ok: false, error: 'Nume sau parolă incorecte.' });
  }

  applyDayStreak(row);
  saveAccount(row);
  res.json({ ok: true, token: signToken(row.display_name), account: publicAccount(row) });
});

// --- middleware de autentificare (Bearer token) pt. rutele de mai jos ---
function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const displayName = verifyToken(token);
  if (!displayName) return res.status(401).json({ ok: false, error: 'Sesiune invalidă sau expirată.' });
  const row = getAccount(displayName);
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
