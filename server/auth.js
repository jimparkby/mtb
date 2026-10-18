// Аккаунты: пароли (scrypt), токены сессий и ограничение попыток входа.
// Токен уходит клиенту один раз, в БД лежит только его SHA-256.
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './db.js';

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;
const COST = { N: 16384, r: 8, p: 1 };
export const SESSION_TTL_MS = 30 * 86_400_000;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored ?? '').split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(key, expected);
}

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function validateCredentials({ email, password, name }, { register = false } = {}) {
  const e = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw new HttpError(400, 'Введите корректный email');
  const pw = String(password ?? '');
  if (register && pw.length < 8) throw new HttpError(400, 'Пароль — минимум 8 символов');
  if (pw.length > 200) throw new HttpError(400, 'Слишком длинный пароль');
  const n = String(name ?? '').trim().slice(0, 40);
  if (register && !n) throw new HttpError(400, 'Укажите имя');
  return { email: e, password: pw, name: n };
}

// Не больше `limit` неудачных попыток за окно с одного ключа (IP + email)
export function createLimiter({ limit = 10, windowMs = 10 * 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    check(key) {
      const h = hits.get(key);
      if (h && now() - h.start < windowMs && h.n >= limit) throw new HttpError(429, 'Слишком много попыток, попробуйте через 10 минут');
    },
    fail(key) {
      const h = hits.get(key);
      if (!h || now() - h.start >= windowMs) hits.set(key, { start: now(), n: 1 });
      else h.n++;
      if (hits.size > 10_000) hits.clear(); // не даём карте расти бесконечно
    },
    reset(key) { hits.delete(key); },
  };
}
