// Ganditorul - parole (scrypt, nativ Node) + token de sesiune stateless (HMAC-SHA256).
// Fara dependente noi - Node are tot ce trebuie in modulul 'crypto'.

import crypto from 'crypto';

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.warn(
    'ATENTIE: SESSION_SECRET nu e setat - folosesc un secret fix, DOAR pentru dezvoltare locala. ' +
    'Seteaza-l in Render, la Environment, inainte de deploy.'
  );
}
const SECRET = SESSION_SECRET || 'dev-only-secret-nu-folosi-in-productie';

const TOKEN_LIFETIME_SECONDS = 180 * 24 * 60 * 60; // 180 zile - login persistent, cerut explicit

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function signToken(displayName) {
  const payload = { name: displayName, exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS };
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (!payload.name || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload.name;
}
