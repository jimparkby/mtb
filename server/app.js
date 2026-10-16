import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, DEMO_USER, HttpError } from './db.js';
import { createRates } from './rates.js';
import { parseAmount } from './engine.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};
const MAX_BODY = 16 * 1024;

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'invalid JSON'); }
}

// Фронт может быть открыт с другого адреса (Live Server, GitHub Pages) — разрешаем CORS для API.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, OPTIONS',
  'access-control-allow-headers': 'content-type',
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

export function createApp(db, { rates = createRates(db) } = {}) {
  const store = createStore(db);
  store.ensureSeeded();
  const user = DEMO_USER; // демо: один пользователь, авторизация — следующий этап

  const routes = {
    'GET /api/health': async () => ({ ok: true }),

    'GET /api/state': async () => store.getState(user, await rates.current()),

    'GET /api/rates': async (req, url) => rates.current({ force: url.searchParams.has('refresh') }),

    // Эмулятор оплаты: сумма приходит строкой ("6,40") или числом в копейках (amountKop).
    'POST /api/payments': async (req) => {
      const body = await readJson(req);
      const amount = Number.isInteger(body.amountKop) ? body.amountKop : parseAmount(body.amount);
      if (!amount || amount <= 0) throw new HttpError(400, 'Введите сумму покупки, например 6,40');
      const merchant = String(body.merchant ?? 'Покупка').trim().slice(0, 40) || 'Покупка';
      const r = await rates.current();
      const result = store.addPayment(user, merchant, amount, r);
      return { ...result, state: store.getState(user, r) };
    },

    'POST /api/purchases': async () => {
      const r = await rates.current();
      const purchase = store.buyNow(user, r);
      return { purchase, state: store.getState(user, r) };
    },

    'PATCH /api/settings': async (req) => {
      store.updateSettings(user, await readJson(req));
      return store.getState(user, rates.cached());
    },

    'PUT /api/goal': async (req) => {
      store.updateGoal(user, await readJson(req));
      return store.getState(user, rates.cached());
    },

    'POST /api/reset': async () => {
      store.seed(user);
      return store.getState(user, await rates.current());
    },
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const handler = routes[`${req.method} ${url.pathname}`];
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      res.writeHead(204, CORS);
      return res.end();
    }
    try {
      if (handler) return send(res, 200, await handler(req, url));
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      return await serveStatic(res, url.pathname);
    } catch (err) {
      const status = err.status ?? (err instanceof RangeError ? 400 : 500);
      if (status === 500) console.error(err);
      send(res, status, { error: status === 500 ? 'internal error' : err.message });
    }
  });
}
