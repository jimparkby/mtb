import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createRates, fetchCrypto } from '../server/rates.js';

let server, base, fetches = 0;

before(async () => {
  const db = openDb(':memory:');
  const rates = createRates(db, { fetcher: async () => { fetches++; return { BTC: 250000, ETH: 10000, usd: 3.2 }; } });
  server = createApp(db, { rates });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('state is seeded and priced at the live rate', async () => {
  const { status, body } = await call('POST', '/api/reset');
  assert.equal(status, 200);
  assert.equal(body.user.name, 'Иван К.');
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

test('static files are served and traversal is blocked', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /KOPI/);
  assert.notEqual((await fetch(base + '/..%2Fpackage.json')).status, 200);
});

test('ticks endpoint returns live rates for the chart', async () => {
  await call('GET', '/api/rates?refresh');
  const { status, body } = await call('GET', '/api/ticks');
  assert.equal(status, 200);
  assert.ok(body.ticks.length > 0);
  assert.equal(body.ticks.at(-1).BTC, 250000);
});

test('falls through to the next exchange when one is unavailable', async () => {
  const r = await fetchCrypto([
    ['Down', async () => { throw new Error('HTTP 451'); }],
    ['Broken', async () => ({ BTC: NaN, ETH: 1 })],
    ['Up', async () => ({ BTC: 80000, ETH: 2400 })],
  ]);
  assert.deepEqual(r, { BTC: 80000, ETH: 2400, exchange: 'Up' });
  await assert.rejects(fetchCrypto([['Down', async () => { throw new Error('x'); }]]), /Down: x/);
});

test('failed refresh falls back to the last known rate without hammering the API', async () => {
  const db = openDb(':memory:');
  let calls = 0, fail = false, t = Date.parse('2026-10-18T10:00:00Z');
  const rates = createRates(db, { now: () => t,
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
});
