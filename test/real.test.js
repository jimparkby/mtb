import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, signBankWebhook } from '../server/app.js';
import { createRates } from '../server/rates.js';
import { createSandbox } from '../server/payments.js';
import { createPaperBroker } from '../server/broker.js';
import { openDatabase } from '../server/database.js';
import { DIALECTS, openTestDb, listen } from './helpers.js';

const SECRET = 'test-bank-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Провайдер и брокер, которыми тест управляет: можно уронить списание или покупку
function controllable() {
  const sandbox = createSandbox();
  const ctl = { chargeFails: false, brokerFails: false, charges: 0, binding: 'instant', pendingStatus: { status: 'pending' } };
  const payments = {
    ...sandbox,
    async startBinding(a) {
      if (ctl.binding === 'redirect') return { checkoutToken: 'chk-' + a.ref, redirectUrl: 'https://pay.example/checkout' };
      return sandbox.startBinding(a);
    },
    async bindingStatus() { return ctl.pendingStatus; },
    async charge(a) {
      ctl.charges++;
      return ctl.chargeFails ? { status: 'failed', message: 'Недостаточно средств' } : sandbox.charge(a);
    },
  };
  const paper = createPaperBroker();
  const broker = { name: 'paper', async buy(a) { if (ctl.brokerFails) throw new Error('биржа недоступна'); return paper.buy(a); } };
  return { ctl, payments, broker };
}

for (const dialect of DIALECTS) {
  describe(`real accounts (${dialect})`, () => {
    let server, close, call, base, ctl;

    before(async () => {
      const t = await openTestDb(dialect);
      close = t.close;
      const rates = await createRates(t.db, { fetcher: async () => ({ BTC: 250000, ETH: 10000, usd: 3.2, exchange: 'Dzengi', currency: 'BYN' }) });
      const c = controllable();
      ctl = c.ctl;
      server = await createApp(t.db, { rates, payments: c.payments, broker: c.broker, bankWebhookSecret: SECRET });
      ({ call, base } = await listen(server));
    });
    after(async () => { server.close(); await close(); });

    async function register(email = `u${Math.random().toString(36).slice(2)}@kopi.by`) {
      const r = await call('POST', '/api/auth/register', { email, password: 'correct horse', name: 'Аня' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return { token: r.body.token, email, user: r.body.user };
    }
    async function bank(tx, { secret = SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
      const raw = JSON.stringify(tx);
      const res = await fetch(base + '/api/webhooks/bank', {
        method: 'POST', body: raw,
        headers: { 'content-type': 'application/json', 'x-kopi-timestamp': String(ts), 'x-kopi-signature': signBankWebhook(secret, ts, raw) },
      });
      return { status: res.status, body: await res.json() };
    }
    async function withCard() {
      const u = await register();
      const r = await call('POST', '/api/cards', {}, u.token);
      assert.equal(r.status, 200);
      return { ...u, card: r.body.state.card };
    }
    async function waitFor(fn, ms = 2000) {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v || Date.now() > end) return v;
        await sleep(20);
      }
    }

    test('register, login, logout', async () => {
      const u = await register();
      assert.equal(u.user.email, u.email);
      assert.equal((await call('POST', '/api/auth/register', { email: u.email.toUpperCase(), password: 'another one', name: 'X' })).status, 409);
      assert.equal((await call('POST', '/api/auth/register', { email: 'bad', password: 'correct horse', name: 'X' })).status, 400);
      assert.equal((await call('POST', '/api/auth/register', { email: 'a@b.by', password: 'short', name: 'X' })).status, 400);

      assert.equal((await call('POST', '/api/auth/login', { email: u.email, password: 'wrong password' })).status, 401);
      const login = await call('POST', '/api/auth/login', { email: u.email, password: 'correct horse' });
      assert.equal(login.status, 200);

      const state = await call('GET', '/api/state', null, login.body.token);
      assert.equal(state.body.user.is_demo, false);
      assert.equal(state.body.user.name, 'Аня');
      assert.equal(state.body.totals.invested, 0);
      assert.equal(state.body.card, null);

      await call('POST', '/api/auth/logout', null, login.body.token);
      assert.equal((await call('GET', '/api/state', null, login.body.token)).status, 401);
      assert.equal((await call('GET', '/api/state', null, 'garbage')).status, 401);
    });

    test('login attempts are rate limited', async () => {
      const u = await register();
      for (let i = 0; i < 10; i++) await call('POST', '/api/auth/login', { email: u.email, password: 'wrong password' });
      assert.equal((await call('POST', '/api/auth/login', { email: u.email, password: 'correct horse' })).status, 429);
    });

    test('real accounts cannot use the demo emulator or reset', async () => {
      const u = await register();
      assert.equal((await call('POST', '/api/payments', { amount: '6,40' }, u.token)).status, 403);
      assert.equal((await call('POST', '/api/reset', null, u.token)).status, 403);
      // а демо по-прежнему работает без входа
      assert.equal((await call('POST', '/api/payments', { amount: '6,40' })).status, 200);
      assert.equal((await call('POST', '/api/cards')).status, 403);
    });

    test('card binding through a redirect is confirmed on refresh', async () => {
      const u = await register();
      ctl.binding = 'redirect';
      const r = await call('POST', '/api/cards', {}, u.token);
      ctl.binding = 'instant';
      assert.equal(r.body.redirectUrl, 'https://pay.example/checkout');
      assert.equal(r.body.state.card.status, 'pending');
      const id = r.body.state.card.id;

      assert.equal((await call('POST', `/api/cards/${id}/refresh`, null, u.token)).body.card.status, 'pending');
      ctl.pendingStatus = { status: 'active', cardToken: 'tok-1', last4: '1097', brand: 'visa' };
      const done = await call('POST', `/api/cards/${id}/refresh`, null, u.token);
      ctl.pendingStatus = { status: 'pending' };
      assert.equal(done.body.card.status, 'active');
      assert.equal(done.body.card.last4, '1097');
      assert.equal(done.body.user.card_last4, '1097');
      assert.equal(done.body.card.card_token, undefined, 'card token must not leak to the client');

      // чужую карту не видно и не удалить
      const other = await register();
      assert.equal((await call('POST', `/api/cards/${id}/refresh`, null, other.token)).status, 404);
      assert.equal((await call('DELETE', `/api/cards/${id}`, null, other.token)).status, 404);
      const removed = await call('DELETE', `/api/cards/${id}`, null, u.token);
      assert.equal(removed.body.card, null);
      assert.equal(removed.body.user.card_last4, '');
    });

    test('bank webhook rejects bad signatures, stale timestamps and unknown cards', async () => {
      const { card } = await withCard();
      const tx = { id: 'tx-sig', card_ref: card.ref, amount: 640, currency: 'BYN', merchant: 'Кофе' };
      assert.equal((await bank(tx, { secret: 'wrong' })).status, 401);
      assert.equal((await bank(tx, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
      assert.equal((await bank({ ...tx, card_ref: 'nope' })).status, 422);
      assert.equal((await bank({ ...tx, amount: 6.4 })).status, 400);
      assert.equal((await bank({ ...tx, currency: 'USD' })).body.ignored, 'currency');
    });

    test('bank payments round up, are idempotent and buy at the threshold', async () => {
      const u = await withCard();
      await call('PATCH', '/api/settings', { round_step: 1000, threshold: 1000, asset: 'BTC' }, u.token);

      const first = await bank({ id: 'tx-1', card_ref: u.card.ref, amount: 640, currency: 'BYN', merchant: 'Кофе' });
      assert.equal(first.status, 200);
      assert.equal(first.body.payment.roundup, 360);
      assert.equal((await bank({ id: 'tx-1', card_ref: u.card.ref, amount: 640, currency: 'BYN' })).body.duplicate, true);
      assert.equal((await call('GET', '/api/state', null, u.token)).body.piggy, 360);

      const before = ctl.charges;
      const second = await bank({ id: 'tx-2', card_ref: u.card.ref, amount: 360, merchant: 'Такси' }); // сдача 6,40 → 10,00 в копилке
      assert.ok(second.body.purchaseId);
      const state = await waitFor(async () => {
        const s = (await call('GET', '/api/state', null, u.token)).body;
        return s.history.find((h) => h.type === 'buy')?.status === 'filled' && s;
      });
      assert.ok(state, 'purchase should be filled');
      assert.equal(ctl.charges, before + 1);
      assert.equal(state.piggy, 0);
      const btc = state.holdings.find((h) => h.asset === 'BTC');
      assert.equal(btc.cost, 1000);
      assert.equal(btc.qty, 10 / 250000);
      assert.equal(state.history.find((h) => h.type === 'buy').rate_source, 'Dzengi');
      assert.equal(state.history.find((h) => h.source === 'bank').merchant, 'Такси');
    });

    test('declined charge returns the change to the piggy bank', async () => {
      const u = await withCard();
      await call('PATCH', '/api/settings', { round_step: 1000, threshold: 5000 }, u.token);
      await bank({ id: 'tx-d1', card_ref: u.card.ref, amount: 100, merchant: 'Кофе' }); // сдача 9,00
      ctl.chargeFails = true;
      const r = await call('POST', '/api/purchases', null, u.token);
      ctl.chargeFails = false;
      assert.equal(r.body.purchase.status, 'failed');
      assert.equal(r.body.purchase.error, 'Недостаточно средств');
      assert.equal(r.body.state.piggy, 900);
      assert.equal(r.body.state.totals.invested, 0);
    });

    test('purchase without a bound card fails and keeps the change', async () => {
      const u = await withCard();
      await call('PATCH', '/api/settings', { round_step: 1000, threshold: 5000 }, u.token);
      await bank({ id: 'tx-nc', card_ref: u.card.ref, amount: 100 });
      await call('DELETE', `/api/cards/${u.card.id}`, null, u.token);
      const r = await call('POST', '/api/purchases', null, u.token);
      assert.equal(r.body.purchase.status, 'failed');
      assert.equal(r.body.state.piggy, 900);
    });

    test('if the broker fails after the charge, reconciliation finishes the purchase', async () => {
      const u = await withCard();
      await call('PATCH', '/api/settings', { round_step: 1000, threshold: 5000 }, u.token);
      await bank({ id: 'tx-b1', card_ref: u.card.ref, amount: 100 });
      ctl.brokerFails = true;
      const r = await call('POST', '/api/purchases', null, u.token);
      assert.equal(r.body.purchase.status, 'charged');
      assert.equal(r.body.state.inFlight, 900);
      assert.equal(r.body.state.goal.saved, 900, 'charged money still counts toward the goal');
      const charges = ctl.charges;
      ctl.brokerFails = false;
      await server.purchaser.reconcile();
      assert.equal(ctl.charges, charges, 'reconcile must not charge again');
      const s = (await call('GET', '/api/state', null, u.token)).body;
      assert.equal(s.history.find((h) => h.type === 'buy').status, 'filled');
      assert.equal(s.inFlight, 0);
      assert.equal(s.totals.invested, 900);
    });

    test('users only see their own data', async () => {
      const a = await withCard(), b = await register();
      await bank({ id: 'tx-iso', card_ref: a.card.ref, amount: 640, merchant: 'Секрет' });
      const sb = (await call('GET', '/api/state', null, b.token)).body;
      assert.equal(sb.history.length, 0);
      assert.equal(sb.piggy, 0);
    });
  });
}

test('an existing SQLite database from the demo version is migrated in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kopi-'));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, card_last4 TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE settings (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, round_step INTEGER NOT NULL DEFAULT 100,
      multiplier INTEGER NOT NULL DEFAULT 1, asset TEXT NOT NULL DEFAULT 'BTC', threshold INTEGER NOT NULL DEFAULT 2000);
    CREATE TABLE goals (user_id INTEGER PRIMARY KEY, name TEXT NOT NULL, target INTEGER NOT NULL);
    CREATE TABLE purchases (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, asset TEXT NOT NULL, amount INTEGER NOT NULL,
      rate REAL NOT NULL, qty REAL NOT NULL, rate_source TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE payments (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, merchant TEXT NOT NULL, amount INTEGER NOT NULL,
      rounded INTEGER NOT NULL, roundup INTEGER NOT NULL, round_step INTEGER NOT NULL, multiplier INTEGER NOT NULL,
      purchase_id INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE rates (id INTEGER PRIMARY KEY, btc REAL NOT NULL, eth REAL NOT NULL, usd_byn REAL NOT NULL, source TEXT NOT NULL, fetched_at TEXT NOT NULL);
    INSERT INTO users VALUES (1, 'Иван К.', '4821', '2026-10-01T00:00:00Z');
    INSERT INTO settings (user_id) VALUES (1);
    INSERT INTO goals VALUES (1, 'Ноутбук', 200000);
    INSERT INTO purchases VALUES (1, 1, 'BTC', 2000, 240000, 0.0000833, 'live', '2026-10-02T00:00:00Z');
    INSERT INTO payments VALUES (1, 1, 'Кофе', 640, 700, 60, 100, 1, NULL, '2026-10-03T00:00:00Z');
  `);
  old.close();

  const db = await openDatabase(path);
  const rates = await createRates(db, { fetcher: async () => ({ BTC: 250000, ETH: 10000, usd: 3.2 }) });
  const server = await createApp(db, { rates });
  const { call } = await listen(server);
  const s = (await call('GET', '/api/state')).body;
  assert.equal(s.user.id, 1);
  assert.equal(s.user.is_demo, true);
  assert.equal(s.totals.invested, 2000, 'old purchases count as filled');
  assert.equal(s.piggy, 60);
  server.close();
  await db.close();
  // повторное открытие не применяет миграции заново
  const again = await openDatabase(path);
  assert.equal((await again.all('SELECT version FROM schema_migrations')).length, 2);
  await again.close();
  rmSync(dir, { recursive: true, force: true });
});
