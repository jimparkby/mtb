// Гостевые сессии: токен уходит клиенту один раз, в БД лежит только его SHA-256.
// Регистрация и вход по паролю — в ветке accounts.
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './db.js';

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

// Не больше `limit` запросов за окно с одного ключа
export function createLimiter({ limit = 10, windowMs = 10 * 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    check(key) {
      const h = hits.get(key);
      if (h && now() - h.start < windowMs && h.n >= limit) throw new HttpError(429, 'Слишком много запросов, попробуйте позже');
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
