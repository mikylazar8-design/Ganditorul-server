// Puntea live pt. locul AI din camera Razboiul AI (2026-09-23) - inlocuieste complet
// mecanismul CLI local / chei API de provider de dinainte. Jucatorul genereaza un cod
// scurt de meci (POST /api/ai-match/create), il copiaza o singura data in propriul AI
// (orice client MCP - Claude, ChatGPT, Gemini prin CLI-ul/aplicatia lor), iar de-acolo
// AI-ul joaca singur, in bucla, prin uneltele MCP din mcp-server/match_tools.js.
//
// Stare 100% in memorie (Map, nu SQLite) - un meci e efemer prin natura lui, spre
// deosebire de conturi. Fara autentificare pe rutele per-meci: codul insusi e secretul
// de acces, acceptabil fiindca Razboiul AI e deja o camera fara scor in clasament
// (vezi ClasicMatch.gd, record_match_result sarit cand mode_label == "Razboiul AI").

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // fara 0/O/1/I/L, usor de citit/copiat
const CODE_LENGTH = 6;

const WAITING_TTL_MS = 10 * 60 * 1000; // meci nepreluat de niciun AI
const ACTIVE_TTL_MS = 30 * 60 * 1000; // meci activ dar fara nicio activitate recenta
const ENDED_GRACE_MS = 2 * 60 * 1000; // pastreaza un meci incheiat putin, pt. un ultim poll

const matches = new Map(); // code -> record

function randomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function freshCode() {
  let code = randomCode();
  while (matches.has(code)) code = randomCode();
  return code;
}

function touch(record) {
  record.last_activity_at = Date.now();
}

function resolveWaiters(record, payload) {
  const waiters = record.question_waiters;
  record.question_waiters = [];
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(payload);
  }
}

// Purjeaza orice meci neincheiat al aceluiasi cont, ca sa nu ramana coduri orfane la
// fiecare vizita noua pe ecranul AiSelect.
export function purgeOwnerMatches(ownerName) {
  for (const [code, record] of matches) {
    if (record.owner_name === ownerName && record.status !== 'ended') {
      resolveWaiters(record, { ended: true, question: null });
      matches.delete(code);
    }
  }
}

export function createMatch(ownerName) {
  purgeOwnerMatches(ownerName);
  const code = freshCode();
  const now = Date.now();
  const record = {
    code,
    owner_name: ownerName,
    status: 'waiting',
    ai_name: null,
    created_at: now,
    joined_at: null,
    ended_at: null,
    last_activity_at: now,
    seq: 0,
    question: null,
    answer: null,
    question_waiters: [],
  };
  matches.set(code, record);
  return record;
}

export function getMatch(code) {
  return matches.get(String(code || '').toUpperCase()) || null;
}

export function joinMatch(code, aiName) {
  const record = getMatch(code);
  if (!record) return { error: 'Cod de meci necunoscut sau expirat.' };
  if (record.status === 'ended') return { error: 'Meciul s-a încheiat deja.' };
  record.status = 'active';
  record.ai_name = String(aiName || '').trim().slice(0, 40) || 'AI';
  record.joined_at = record.joined_at || Date.now();
  touch(record);
  return { record };
}

export function postQuestion(code, fields) {
  const record = getMatch(code);
  if (!record) return { error: 'Cod de meci necunoscut sau expirat.' };
  record.seq += 1;
  record.question = {
    seq: record.seq,
    question_id: fields.question_id,
    question_type: fields.question_type,
    question_text: fields.question_text,
    options: fields.options || null,
    context: fields.context || '',
    posted_at: Date.now(),
  };
  record.answer = null;
  touch(record);
  resolveWaiters(record, { ended: false, question: record.question });
  return { record };
}

// Long-poll marginit - se intoarce imediat daca exista deja o intrebare mai noua decat
// after_seq (sau meciul s-a incheiat), altfel asteapta pana la wait_ms inainte sa se
// intoarca goala ("mai incearca"). Tinut sub limita implicita de 60s a SDK-ului MCP.
export function waitForQuestion(code, afterSeq, waitMs) {
  const record = getMatch(code);
  if (!record) return Promise.resolve({ error: 'Cod de meci necunoscut sau expirat.' });
  touch(record);

  if (record.status === 'ended') {
    return Promise.resolve({ ended: true, question: null });
  }
  if (record.question && record.question.seq > afterSeq) {
    return Promise.resolve({ ended: false, question: record.question });
  }

  return new Promise((resolve) => {
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        record.question_waiters = record.question_waiters.filter((w) => w !== waiter);
        resolve({ ended: false, question: null });
      }, waitMs),
    };
    record.question_waiters.push(waiter);
  });
}

export function submitAnswer(code, seq, answer) {
  const record = getMatch(code);
  if (!record) return { error: 'Cod de meci necunoscut sau expirat.' };
  if (record.status === 'ended') return { error: 'Meciul s-a încheiat deja.' };
  if (!record.question || record.question.seq !== Number(seq)) {
    return { error: 'Întrebarea asta nu mai e curentă (răspuns învechit sau dublu).' };
  }
  record.answer = { seq: record.question.seq, answer: String(answer), submitted_at: Date.now() };
  touch(record);
  return { record };
}

export function getAnswer(code, seq) {
  const record = getMatch(code);
  if (!record) return { error: 'Cod de meci necunoscut sau expirat.' };
  if (record.answer && record.answer.seq === Number(seq)) return { answer: record.answer };
  return { answer: null };
}

export function endMatch(code) {
  const record = getMatch(code);
  if (!record) return { error: 'Cod de meci necunoscut sau expirat.' };
  record.status = 'ended';
  record.ended_at = Date.now();
  resolveWaiters(record, { ended: true, question: null });
  return { record };
}

function sweep() {
  const now = Date.now();
  for (const [code, record] of matches) {
    if (record.status === 'waiting' && now - record.created_at > WAITING_TTL_MS) {
      matches.delete(code);
    } else if (record.status === 'active' && now - record.last_activity_at > ACTIVE_TTL_MS) {
      endMatch(code);
    } else if (record.status === 'ended' && now - record.ended_at > ENDED_GRACE_MS) {
      matches.delete(code);
    }
  }
}

setInterval(sweep, 60 * 1000).unref?.();
