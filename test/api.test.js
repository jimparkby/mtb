import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/database.js';
import { createRates, fetchCrypto } from '../server/rates.js';
import { DIALECTS, openTestDb, listen } from './helpers.js';

for (const dialect of DIALECTS) {
  describe(`demo API (${dialect})`, () => {
    let server, close, call, fetches = 0;

    before(async () => {
      const t = await openTestDb(dialect);
      close = t.close;
      const rates = await createRates(t.db, { fetcher: async () => { fetches++; return { BTC: 250000, ETH: 10000, usd: 3.2 }; } });
      server = await createApp(t.db, { rates });
      ({ call } = await listen(server));
    });
    after(async () => { server.close(); await close(); });

    test('state is seeded and priced at the live rate', async () => {
      const { status, body } = await call('POST', '/api/reset');
      assert.equal(status, 200);
      assert.equal(body.user.name, 'Иван К.');
      assert.equal(body.user.is_demo, true);
      assert.equal(body.rates.source, 'live');
      assert.equal(body.rates.BTC, 250000);
      assert.ok(body.totals.invested > 0);
      assert.ok(body.history.length > 0);
      // демо-покупки сделаны на 2,4% ниже текущего курса
      assert.ok(Math.abs(body.totals.profitPct - 2.4) < 0.1, `profit ${body.totals.profitPct}`);
    });

    test('payment rounds up into the piggy bank and batch-buys at threshold', async () => {
      await call('POST', '/api/reset');
      await call('PATCH', '/api/settings', { round_step: 100, multiplier: 1, asset: 'ETH', threshold: 1000 });
      const before = (await call('GET', '/api/state')).body;

      const r1 = await call('POST', '/api/payments', { merchant: 'Кофе', amount: '6,40' });
      assert.equal(r1.status, 200);
      assert.equal(r1.body.payment.roundup, 60);
      assert.equal(r1.body.state.piggy, before.piggy + 60);

      // добиваем копилку до порога одной покупкой (шаг 10 BYN, чтобы сдача могла быть до 9,99)
      await call('PATCH', '/api/settings', { round_step: 1000 });
      const need = 1000 - r1.body.state.piggy;
      const r2 = await call('POST', '/api/payments', { merchant: 'Такси', amountKop: 100000 - need });
      assert.equal(r2.body.payment.roundup, need);
      assert.ok(r2.body.purchase, 'batch purchase expected');
      assert.equal(r2.body.purchase.status, 'filled');
      assert.equal(r2.body.purchase.asset, 'ETH');
      assert.equal(r2.body.purchase.amount, 1000);
      assert.equal(r2.body.purchase.rate, 10000);
      assert.equal(r2.body.purchase.qty, 0.001);
      assert.equal(r2.body.state.piggy, 0);
      assert.equal(r2.body.state.holdings.find((h) => h.asset === 'ETH').cost, 1000);
    });

    test('buy now empties the piggy bank and rejects when empty', async () => {
      await call('POST', '/api/reset');
      await call('PATCH', '/api/settings', { threshold: 5000 });
      await call('POST', '/api/payments', { amount: '1,10' });
      const r = await call('POST', '/api/purchases');
      assert.equal(r.status, 200);
      assert.equal(r.body.state.piggy, 0);
      const again = await call('POST', '/api/purchases');
      assert.equal(again.status, 409);
    });

    test('validation errors return 400', async () => {
      assert.equal((await call('POST', '/api/payments', { amount: 'abc' })).status, 400);
      assert.equal((await call('PATCH', '/api/settings', { round_step: 300 })).status, 400);
      assert.equal((await call('PUT', '/api/goal', { name: '', target: 100 })).status, 400);
      const g = await call('PUT', '/api/goal', { name: 'Велосипед', target: 150000 });
      assert.equal(g.body.goal.name, 'Велосипед');
      assert.equal(g.body.goal.target, 150000);
    });

    test('rates are cached between requests', async () => {
      const n = fetches;
      await call('GET', '/api/rates');
      await call('GET', '/api/rates');
      assert.equal(fetches, n);
    });

    test('ticks endpoint returns live rates for the chart', async () => {
      await call('GET', '/api/rates?refresh');
      const { status, body } = await call('GET', '/api/ticks');
      assert.equal(status, 200);
      assert.ok(body.ticks.length > 0);
      assert.equal(body.ticks.at(-1).BTC, 250000);
    });

    test('every QR visitor gets an own demo copy without registration', async () => {
      const g1 = (await call('POST', '/api/auth/guest')).body;
      const g2 = (await call('POST', '/api/auth/guest')).body;
      assert.ok(g1.token && g2.token);
      const s1 = (await call('GET', '/api/state', null, g1.token)).body;
      assert.equal(s1.user.is_demo, true);
      assert.equal(s1.user.guest, true);
      assert.equal(s1.user.name, 'Иван К.');
      assert.ok(Math.abs(s1.totals.profitPct - 2.4) < 0.1);
      const shared = (await call('GET', '/api/state')).body;

      const pay = await call('POST', '/api/payments', { merchant: 'Кофе', amount: '6,40' }, g1.token);
      assert.equal(pay.status, 200);
      assert.equal(pay.body.state.piggy, s1.piggy + 60);
      assert.equal((await call('GET', '/api/state', null, g2.token)).body.piggy, s1.piggy, 'other guest untouched');
      assert.equal((await call('GET', '/api/state')).body.piggy, shared.piggy, 'shared demo untouched');

      // сброс возвращает к исходной неделе только этого гостя
      await call('POST', '/api/payments', { amount: '1,10' }, g2.token);
      const reset = await call('POST', '/api/reset', null, g1.token);
      assert.equal(reset.body.user.id, s1.user.id);
      assert.equal(reset.body.piggy, s1.piggy);
      assert.equal((await call('GET', '/api/state', null, g2.token)).body.piggy, s1.piggy + 90);

      // аккаунтов, карт и SMS в этой версии нет
      assert.equal((await call('POST', '/api/auth/register', { email: 'a@b.by', password: '12345678', name: 'A' })).status, 404);
      assert.equal((await call('POST', '/api/cards', null, g1.token)).status, 404);

      // гость без живой сессии удаляется, остальные остаются
      await call('POST', '/api/auth/logout', null, g1.token);
      assert.equal(await server.cleanupGuests(), 1);
      assert.equal((await call('GET', '/api/state', null, g2.token)).status, 200);
      assert.equal((await call('GET', '/api/state')).status, 200);
    });

    test('static files are served and traversal is blocked', async () => {
      const res = await fetch(server.address() && `http://127.0.0.1:${server.address().port}/`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /KOPI/);
      assert.notEqual((await fetch(`http://127.0.0.1:${server.address().port}/..%2Fpackage.json`)).status, 200);
    });
  });
}

test('falls through to the next exchange when one is unavailable', async () => {
  const r = await fetchCrypto([
    ['Down', async () => { throw new Error('HTTP 451'); }],
    ['Broken', async () => ({ BTC: NaN, ETH: 1 })],
    ['Up', async () => ({ BTC: 80000, ETH: 2400 })],
  ]);
  assert.deepEqual(r, { BTC: 80000, ETH: 2400, exchange: 'Up', currency: 'USD' });
  const byn = await fetchCrypto([['ПВТ', async () => ({ BTC: 245000, ETH: 7300 }), 'BYN']]);
  assert.equal(byn.currency, 'BYN');
  await assert.rejects(fetchCrypto([['Down', async () => { throw new Error('x'); }]]), /Down: x/);
});

test('failed refresh falls back to the last known rate without hammering the API', async () => {
  const { db, close } = await openTestDb('sqlite');
  let calls = 0, fail = false, t = Date.parse('2026-10-18T10:00:00Z');
  const rates = await createRates(db, { now: () => t,
    fetcher: async () => { calls++; if (fail) throw new Error('down'); return { BTC: 1, ETH: 2, usd: 3, exchange: 'X' }; } });
  await rates.current();
  fail = true; t += 10_000;
  const r = await rates.current();
  assert.equal(r.stale, true);
  assert.equal(r.BTC, 1);
  const n = calls; t += 1_000;
  assert.equal((await rates.current()).stale, true);
  assert.equal(calls, n);
  t += 5_000;
  await rates.current();
  assert.equal(calls, n + 1);
  await close();
});

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
  assert.equal((await again.all('SELECT version FROM schema_migrations')).length, 4);
  await again.close();
  rmSync(dir, { recursive: true, force: true });
});
