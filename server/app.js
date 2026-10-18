import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, HttpError } from './db.js';
import { createRates } from './rates.js';
import { parseAmount } from './engine.js';
import { newToken, hashToken, createLimiter } from './auth.js';
import { createPurchaser } from './purchaser.js';
import { createPaperBroker } from './broker.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};
const MAX_BODY = 16 * 1024;
const GUEST_TTL_MS = 7 * 86_400_000;

async function readRaw(req) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function parseJson(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw new HttpError(400, 'invalid JSON'); }
}
const readJson = async (req) => parseJson(await readRaw(req));

// Фронт может быть открыт с другого адреса (Live Server, GitHub Pages) — разрешаем CORS для API.
// Авторизация — заголовком Bearer, не cookie, поэтому `*` безопасен.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS });
  res.end(JSON.stringify(body));
}

async function serveStatic(res, pathname) {
  const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^[/\\]+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || rel.split(sep).includes('..')) return send(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

export async function createApp(db, {
  rates,
  broker = createPaperBroker(),
  now = () => Date.now(),
} = {}) {
  rates ??= await createRates(db);
  const store = createStore(db);
  await store.ensureDemo(rates.cached());
  const purchaser = createPurchaser({ store, rates, broker, now });
  // На презентации весь зал может сидеть за одним Wi-Fi — лимит гостей с одного IP щедрый
  const guests = createLimiter({ limit: 300, windowMs: 60 * 60_000, now });
  // За прокси Railway адрес соединения у всех один — берём клиента из X-Forwarded-For
  const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress;

  // Без токена — общий демо-пользователь (старые версии фронта), с токеном — своя гостевая копия демо
  async function resolveUser(req) {
    const h = String(req.headers.authorization ?? '');
    if (!h) return store.getUser(await store.ensureDemo(rates.cached()));
    const m = /^Bearer\s+(\S+)$/.exec(h);
    const user = m && await store.userBySession(hashToken(m[1]));
    if (!user) throw new HttpError(401, 'Сессия истекла');
    return user;
  }

  async function startSession(userId, ttl) {
    const token = newToken();
    await store.createSession(userId, hashToken(token), ttl);
    return token;
  }

  // Покупка проводится сразу, а ответ отдаётся с её итоговым статусом
  const settle = async (purchase) => purchase && purchaser.process(purchase);

  const routes = {
    'GET /api/health': async () => ({ ok: true }),

    'GET /api/config': async () => ({ payments: null, broker: broker.name }),

    // Своя копия демо для посетителя по QR — без регистрации
    'POST /api/auth/guest': async ({ req }) => {
      guests.check(clientIp(req));
      guests.fail(clientIp(req));
      const id = await store.createGuest(await rates.current());
      return { token: await startSession(id, GUEST_TTL_MS), user: await store.getUser(id) };
    },

    'POST /api/auth/logout': async ({ req }) => {
      const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization ?? ''));
      if (m) await store.deleteSession(hashToken(m[1]));
      return { ok: true };
    },

    // ---------- дашборд ----------

    'GET /api/state': async ({ user }) => store.getState(user.id, await rates.current()),

    'GET /api/rates': async ({ url }) => rates.current({ force: url.searchParams.has('refresh') }),

    // Тики курса за последний час — для графика стоимости портфеля
    'GET /api/ticks': async () => ({ ticks: rates.ticks() }),

    // Эмулятор кассы
    'POST /api/payments': async ({ req, user }) => {
      const body = await readJson(req);
      const amount = Number.isInteger(body.amountKop) ? body.amountKop : parseAmount(body.amount);
      if (!amount || amount <= 0) throw new HttpError(400, 'Введите сумму покупки, например 6,40');
      const merchant = String(body.merchant ?? 'Покупка').trim().slice(0, 40) || 'Покупка';
      const r = await store.addPayment(user.id, { merchant, amount });
      const purchase = await settle(r.purchase);
      return { payment: r.payment, purchase, state: await store.getState(user.id, await rates.current()) };
    },

    'POST /api/purchases': async ({ user }) => {
      const purchase = await purchaser.process(await store.claimNow(user.id));
      return { purchase, state: await store.getState(user.id, await rates.current()) };
    },

    'PATCH /api/settings': async ({ req, user }) => {
      await store.updateSettings(user.id, await readJson(req));
      return store.getState(user.id, rates.cached());
    },

    'PUT /api/goal': async ({ req, user }) => {
      await store.updateGoal(user.id, await readJson(req));
      return store.getState(user.id, rates.cached());
    },

    'POST /api/reset': async ({ user }) => {
      if (!user.is_demo) throw new HttpError(403, 'Сбросить можно только демо');
      const r = await rates.current();
      await store.fillDemo(user.id, r);
      return store.getState(user.id, r);
    },
  };

  // Эти маршруты работают без пользователя
  const OPEN = new Set(['GET /api/health', 'GET /api/config', 'POST /api/auth/guest', 'POST /api/auth/logout']);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      res.writeHead(204, CORS);
      return res.end();
    }
    try {
      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key];
      if (handler) {
        const user = OPEN.has(key) ? null : await resolveUser(req);
        return send(res, 200, await handler({ req, url, user }));
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      return await serveStatic(res, url.pathname);
    } catch (err) {
      const status = err.status ?? (err instanceof RangeError ? 400 : 500);
      if (status === 500) console.error(err);
      send(res, status, { error: status === 500 ? 'internal error' : err.message });
    }
  });

  return Object.assign(server, { purchaser, store, cleanupGuests: () => store.cleanupGuests() });
}
