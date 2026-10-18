import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, HttpError } from './db.js';
import { createRates } from './rates.js';
import { parseAmount, MAX_PAYMENT } from './engine.js';
import { hashPassword, verifyPassword, newToken, hashToken, validateCredentials, createLimiter, SESSION_TTL_MS } from './auth.js';
import { createPurchaser } from './purchaser.js';
import { createPaperBroker } from './broker.js';
import { parseBankMessage } from './sms.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};
const MAX_BODY = 16 * 1024;
const WEBHOOK_SKEW_MS = 5 * 60_000;
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

// Подпись уведомлений банка: hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))
export function signBankWebhook(secret, timestamp, raw) {
  return createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
}
function verifyBankSignature(secret, req, raw, now) {
  const ts = Number(req.headers['x-kopi-timestamp']);
  const sig = String(req.headers['x-kopi-signature'] ?? '');
  if (!Number.isFinite(ts) || Math.abs(now() - ts * 1000) > WEBHOOK_SKEW_MS) return false;
  const want = Buffer.from(signBankWebhook(secret, ts, raw));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

// Хэш для выравнивания времени ответа, когда email не найден
const DUMMY_HASH = await hashPassword('timing-equalizer');

export async function createApp(db, {
  rates,
  payments = null,
  broker = createPaperBroker(),
  bankWebhookSecret = null,
  publicUrl = null,
  now = () => Date.now(),
} = {}) {
  rates ??= await createRates(db);
  const store = createStore(db);
  await store.ensureDemo(rates.cached());
  const purchaser = createPurchaser({ store, rates, payments, broker, now });
  const limiter = createLimiter({ now });
  const signups = createLimiter({ limit: 20, windowMs: 60 * 60_000, now });
  const ingests = createLimiter({ limit: 30, windowMs: 60_000, now });
  // На презентации весь зал может сидеть за одним Wi-Fi — лимит гостей с одного IP щедрый
  const guests = createLimiter({ limit: 300, windowMs: 60 * 60_000, now });
  // За прокси Railway адрес соединения у всех один — берём клиента из X-Forwarded-For
  const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress;

  // Без токена — демо-пользователь (как раньше), с токеном — свой аккаунт
  async function resolveUser(req) {
    const h = String(req.headers.authorization ?? '');
    if (!h) return store.getUser(await store.ensureDemo(rates.cached()));
    const m = /^Bearer\s+(\S+)$/.exec(h);
    const user = m && await store.userBySession(hashToken(m[1]));
    if (!user) throw new HttpError(401, 'Сессия истекла, войдите снова');
    return user;
  }
  const requireReal = (user) => { if (user.is_demo) throw new HttpError(403, 'Войдите в аккаунт'); };

  async function startSession(userId, ttl = SESSION_TTL_MS) {
    const token = newToken();
    await store.createSession(userId, hashToken(token), ttl);
    return token;
  }

  const baseUrl = (req) => publicUrl ?? `http://${req.headers.host}`;

  // Покупка проводится сразу, а ответ отдаётся с её итоговым статусом
  const settle = async (purchase) => purchase && purchaser.process(purchase);

  const routes = {
    'GET /api/health': async () => ({ ok: true }),

    'GET /api/config': async () => ({
      payments: payments && { provider: payments.name, test: payments.test },
      broker: broker.name,
    }),

    // ---------- аккаунт ----------

    'POST /api/auth/register': async ({ req }) => {
      const c = validateCredentials(await readJson(req), { register: true });
      signups.check(clientIp(req));
      signups.fail(clientIp(req)); // считаем каждую регистрацию, не только неудачные
      const user = await store.createUser({ email: c.email, name: c.name, passwordHash: await hashPassword(c.password) });
      return { token: await startSession(user.id), user };
    },

    // Своя копия демо для посетителя по QR — без регистрации
    'POST /api/auth/guest': async ({ req }) => {
      guests.check(clientIp(req));
      guests.fail(clientIp(req));
      const id = await store.createGuest(await rates.current());
      return { token: await startSession(id, GUEST_TTL_MS), user: await store.getUser(id) };
    },

    'POST /api/auth/login': async ({ req }) => {
      const c = validateCredentials(await readJson(req));
      const key = `${clientIp(req)}|${c.email}`;
      limiter.check(key);
      const row = await store.findUserByEmail(c.email);
      const ok = await verifyPassword(c.password, row?.password_hash ?? DUMMY_HASH).catch(() => false);
      if (!row || !ok) {
        limiter.fail(key);
        throw new HttpError(401, 'Неверный email или пароль');
      }
      limiter.reset(key);
      return { token: await startSession(row.id), user: await store.getUser(row.id) };
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

    // Эмулятор кассы — только в демо. У настоящего аккаунта оплаты приходят от банка.
    'POST /api/payments': async ({ req, user }) => {
      if (!user.is_demo) throw new HttpError(403, 'Оплаты приходят от банка по привязанной карте');
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

    // ---------- карта ----------

    // Начать привязку: провайдер вернёт страницу, где пользователь сам вводит карту
    'POST /api/cards': async ({ req, user }) => {
      requireReal(user);
      if (!payments) throw new HttpError(503, 'Платёжный провайдер не подключён');
      const card = await store.createCard(user.id, payments.name);
      const base = baseUrl(req);
      let b;
      try {
        b = await payments.startBinding({
          ref: card.ref,
          returnUrl: `${base}/?card=${card.id}#pay`,
          notificationUrl: `${base}/api/webhooks/${payments.name}`,
        });
      } catch (err) {
        await store.updateCard(card.id, { status: 'failed', error: 'Провайдер недоступен' });
        console.error('[cards] start binding', err.message);
        throw new HttpError(502, 'Платёжный провайдер недоступен, попробуйте позже');
      }
      const patch = { checkout_token: b.checkoutToken };
      if (b.card) Object.assign(patch, { status: b.card.status, card_token: b.card.cardToken, last4: b.card.last4, brand: b.card.brand });
      await store.updateCard(card.id, patch);
      return { redirectUrl: b.redirectUrl, state: await store.getState(user.id, rates.cached()) };
    },

    // Пользователь вернулся со страницы провайдера — уточняем статус привязки
    'POST /api/cards/:id/refresh': async ({ user, params }) => {
      requireReal(user);
      const card = await store.getCard(Number(params.id));
      if (!card || card.user_id !== user.id) throw new HttpError(404, 'Карта не найдена');
      await refreshCard(card);
      return store.getState(user.id, rates.cached());
    },

    'DELETE /api/cards/:id': async ({ user, params }) => {
      requireReal(user);
      const card = await store.getCard(Number(params.id));
      if (!card || card.user_id !== user.id) throw new HttpError(404, 'Карта не найдена');
      await store.updateCard(card.id, { status: 'removed' });
      return store.getState(user.id, rates.cached());
    },

    // ---------- уведомления банка с телефона ----------

    // Личная ссылка, на которую телефон пересылает SMS/push банка. Показывается один раз;
    // повторный вызов выдаёт новую, старая перестаёт работать.
    'POST /api/sms-link': async ({ req, user }) => {
      requireReal(user);
      const token = newToken();
      await store.setIngestToken(user.id, hashToken(token));
      return { url: `${baseUrl(req)}/api/ingest/${token}`, state: await store.getState(user.id, rates.cached()) };
    },

    'DELETE /api/sms-link': async ({ user }) => {
      requireReal(user);
      await store.deleteIngestToken(user.id);
      return store.getState(user.id, rates.cached());
    },

    // Текст уведомления — телом запроса (text/plain) или { "text": "…" }.
    // Отвечаем 200 и на то, что не покупка: «Команды» и MacroDroid не должны показывать ошибку на каждое SMS банка.
    'POST /api/ingest/:token': async ({ req, params }) => {
      const tokenHash = hashToken(params.token);
      ingests.check(tokenHash);
      ingests.fail(tokenHash);
      const user = await store.userByIngestToken(tokenHash);
      if (!user) throw new HttpError(404, 'unknown link');
      const raw = await readRaw(req);
      const text = String(/^\s*\{/.test(raw) ? parseJson(raw).text ?? '' : raw).slice(0, 1000);
      const m = parseBankMessage(text);
      if (!m.ok) return { ignored: m.reason };
      if (m.currency !== 'BYN') return { ignored: 'currency ' + m.currency };
      if (m.amount > MAX_PAYMENT) return { ignored: 'amount too large' };
      // Одно и то же уведомление, пересланное дважды, засчитывается один раз
      const externalId = 'sms:' + createHash('sha256').update(`${user.id}|${text.trim()}`).digest('hex');
      const card = await store.activeCard(user.id);
      const r = await store.addPayment(user.id, { merchant: m.merchant, amount: m.amount, source: 'sms', externalId, cardId: card?.id ?? null });
      if (r.duplicate) return { duplicate: true };
      if (r.purchase) purchaser.process(r.purchase).catch((err) => console.error('[ingest] purchase', err));
      return { ok: true, merchant: m.merchant, amount: m.amount, roundup: r.payment.roundup };
    },

    // ---------- вебхуки ----------

    // Банк-партнёр присылает каждую оплату по карте. Формат и подпись — в README.
    'POST /api/webhooks/bank': async ({ req }) => {
      if (!bankWebhookSecret) throw new HttpError(503, 'bank webhook is not configured');
      const raw = await readRaw(req);
      if (!verifyBankSignature(bankWebhookSecret, req, raw, now)) throw new HttpError(401, 'bad signature');
      const tx = parseJson(raw);
      const id = String(tx.id ?? '').slice(0, 100);
      if (!id) throw new HttpError(400, 'id is required');
      if (tx.type && tx.type !== 'purchase') return { ignored: 'not a purchase' };
      if (tx.currency && tx.currency !== 'BYN') return { ignored: 'currency' };
      if (!Number.isInteger(tx.amount) || tx.amount <= 0 || tx.amount > MAX_PAYMENT) throw new HttpError(400, 'amount must be a positive integer in kopecks');
      const card = await store.cardByRef(String(tx.card_ref ?? ''));
      if (!card || card.status !== 'active') throw new HttpError(422, 'unknown card');
      const merchant = String(tx.merchant ?? 'Покупка').trim().slice(0, 40) || 'Покупка';
      const at = tx.created_at && !Number.isNaN(Date.parse(tx.created_at)) ? new Date(tx.created_at).toISOString() : undefined;
      const r = await store.addPayment(card.user_id, { merchant, amount: tx.amount, source: 'bank', externalId: id, cardId: card.id, at });
      if (r.duplicate) return { duplicate: true };
      // Банку отвечаем сразу; списание и покупка идут в фоне, недоделанное подберёт сверка
      if (r.purchase) purchaser.process(r.purchase).catch((err) => console.error('[webhook] purchase', err));
      return { ok: true, payment: r.payment, purchaseId: r.purchase?.id ?? null };
    },

    // Уведомление bePaid о привязке карты. Данным из тела не верим — статус спрашиваем у bePaid.
    'POST /api/webhooks/bepaid': async ({ req }) => {
      if (payments?.name !== 'bepaid') throw new HttpError(404, 'not found');
      if (!payments.verifyNotification(req.headers)) throw new HttpError(401, 'unauthorized');
      const body = parseJson(await readRaw(req));
      const ref = findTrackingId(body);
      const card = ref && await store.cardByRef(ref);
      if (card && card.status === 'pending') await refreshCard(card);
      return { ok: true };
    },
  };

  async function refreshCard(card) {
    if (card.status !== 'pending' || !card.checkout_token || !payments) return card;
    const s = await payments.bindingStatus(card.checkout_token);
    if (s.status === 'active') return store.updateCard(card.id, { status: 'active', card_token: s.cardToken, last4: s.last4, brand: s.brand, error: null });
    if (s.status === 'failed') return store.updateCard(card.id, { status: 'failed', error: s.error });
    return card;
  }

  // Маршруты с параметрами (`/api/cards/:id`) превращаются в регулярные выражения
  const table = Object.entries(routes).map(([key, handler]) => {
    const [method, path] = key.split(' ');
    const names = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    return { method, re, names, handler, open: path.startsWith('/api/webhooks/') || path.startsWith('/api/ingest/') || path.startsWith('/api/auth/') || path === '/api/health' || path === '/api/config' };
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      res.writeHead(204, CORS);
      return res.end();
    }
    try {
      for (const r of table) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        const user = r.open ? null : await resolveUser(req);
        return send(res, 200, await r.handler({ req, url, params, user }));
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

function findTrackingId(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (typeof obj.tracking_id === 'string') return obj.tracking_id;
  for (const v of Object.values(obj)) {
    const t = findTrackingId(v, depth + 1);
    if (t) return t;
  }
  return null;
}
