import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ASSETS, STEPS, MULTIPLIERS, THRESHOLDS,
  roundUp, quantity, positionValue, shouldBuy, forecastMonths,
} from './engine.js';
import { FALLBACK } from './rates.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  card_last4  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  round_step  INTEGER NOT NULL DEFAULT 100,
  multiplier  INTEGER NOT NULL DEFAULT 1,
  asset       TEXT    NOT NULL DEFAULT 'BTC' CHECK (asset IN ('BTC','ETH','SAFE')),
  threshold   INTEGER NOT NULL DEFAULT 2000
);
CREATE TABLE IF NOT EXISTS goals (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  target      INTEGER NOT NULL CHECK (target > 0)
);
-- Пакетная покупка: одна операция на всю накопленную сдачу.
CREATE TABLE IF NOT EXISTS purchases (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset       TEXT    NOT NULL CHECK (asset IN ('BTC','ETH','SAFE')),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  rate        REAL    NOT NULL,
  qty         REAL    NOT NULL,
  rate_source TEXT    NOT NULL,
  created_at  TEXT    NOT NULL
);
-- Оплата картой и её сдача. purchase_id = NULL, пока сдача лежит в копилке.
CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant    TEXT    NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  rounded     INTEGER NOT NULL,
  roundup     INTEGER NOT NULL CHECK (roundup >= 0),
  round_step  INTEGER NOT NULL,
  multiplier  INTEGER NOT NULL,
  purchase_id INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_piggy ON payments(user_id, purchase_id);
CREATE TABLE IF NOT EXISTS rates (
  id          INTEGER PRIMARY KEY,
  btc         REAL NOT NULL,
  eth         REAL NOT NULL,
  usd_byn     REAL NOT NULL,
  source      TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);
`;

export const DEMO_USER = 1;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createStore(db) {
  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    settings: db.prepare('SELECT * FROM settings WHERE user_id = ?'),
    goal: db.prepare('SELECT name, target FROM goals WHERE user_id = ?'),
    piggy: db.prepare('SELECT COALESCE(SUM(roundup), 0) AS piggy FROM payments WHERE user_id = ? AND purchase_id IS NULL'),
    holdings: db.prepare(`SELECT asset, SUM(qty) AS qty, SUM(amount) AS cost, COUNT(*) AS buys
                          FROM purchases WHERE user_id = ? GROUP BY asset`),
    roundStats: db.prepare('SELECT COUNT(*) AS n, COALESCE(AVG(roundup), 0) AS avg FROM payments WHERE user_id = ?'),
    recentPayments: db.prepare(`SELECT id, merchant, amount, rounded, roundup, multiplier, purchase_id, created_at
                                FROM payments WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`),
    recentPurchases: db.prepare(`SELECT id, asset, amount, rate, qty, rate_source, created_at
                                 FROM purchases WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`),
    insertPayment: db.prepare(`INSERT INTO payments (user_id, merchant, amount, rounded, roundup, round_step, multiplier, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    insertPurchase: db.prepare(`INSERT INTO purchases (user_id, asset, amount, rate, qty, rate_source, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?)`),
    attachPayments: db.prepare('UPDATE payments SET purchase_id = ? WHERE user_id = ? AND purchase_id IS NULL'),
    updateSettings: db.prepare('UPDATE settings SET round_step = ?, multiplier = ?, asset = ?, threshold = ? WHERE user_id = ?'),
    upsertGoal: db.prepare(`INSERT INTO goals (user_id, name, target) VALUES (?, ?, ?)
                            ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, target = excluded.target`),
  };

  function requireUser(userId) {
    if (!q.user.get(userId)) throw new HttpError(404, 'user not found');
  }

  // Покупает актив на всю сдачу из копилки и привязывает к покупке её платежи.
  function buyPiggy(userId, rates, at) {
    const { piggy } = q.piggy.get(userId);
    if (piggy <= 0) return null;
    const { asset } = q.settings.get(userId);
    const rate = rates[asset];
    const qty = quantity(piggy, asset, rate);
    const { lastInsertRowid } = q.insertPurchase.run(userId, asset, piggy, rate, qty, rates.source, at);
    q.attachPayments.run(lastInsertRowid, userId);
    return { id: Number(lastInsertRowid), asset, amount: piggy, rate, qty, rate_source: rates.source, created_at: at };
  }

  function addPayment(userId, merchant, amount, rates, at = new Date().toISOString()) {
    requireUser(userId);
    return tx(db, () => {
      const s = q.settings.get(userId);
      const { rounded, roundup } = roundUp(amount, s.round_step, s.multiplier);
      const { lastInsertRowid } = q.insertPayment.run(userId, merchant, amount, rounded, roundup, s.round_step, s.multiplier, at);
      const { piggy } = q.piggy.get(userId);
      const purchase = shouldBuy(piggy, s.threshold) ? buyPiggy(userId, rates, at) : null;
      return { payment: { id: Number(lastInsertRowid), merchant, amount, rounded, roundup, multiplier: s.multiplier, created_at: at }, purchase };
    });
  }

  function buyNow(userId, rates, at = new Date().toISOString()) {
    requireUser(userId);
    const purchase = tx(db, () => buyPiggy(userId, rates, at));
    if (!purchase) throw new HttpError(409, 'Копилка пуста');
    return purchase;
  }

  function updateSettings(userId, patch) {
    requireUser(userId);
    const s = q.settings.get(userId);
    const next = {
      round_step: patch.round_step ?? s.round_step,
      multiplier: patch.multiplier ?? s.multiplier,
      asset: patch.asset ?? s.asset,
      threshold: patch.threshold ?? s.threshold,
    };
    if (!STEPS.includes(next.round_step)) throw new HttpError(400, 'round_step must be one of ' + STEPS);
    if (!MULTIPLIERS.includes(next.multiplier)) throw new HttpError(400, 'multiplier must be one of ' + MULTIPLIERS);
    if (!(next.asset in ASSETS)) throw new HttpError(400, 'asset must be one of ' + Object.keys(ASSETS));
    if (!THRESHOLDS.includes(next.threshold)) throw new HttpError(400, 'threshold must be one of ' + THRESHOLDS);
    q.updateSettings.run(next.round_step, next.multiplier, next.asset, next.threshold, userId);
    return next;
  }

  function updateGoal(userId, { name, target }) {
    requireUser(userId);
    const n = String(name ?? '').trim().slice(0, 24);
    if (!n) throw new HttpError(400, 'Укажите название цели');
    if (!Number.isInteger(target) || target <= 0 || target > 1_000_000_000) throw new HttpError(400, 'Некорректная сумма цели');
    q.upsertGoal.run(userId, n, target);
    return { name: n, target };
  }

  function getState(userId, rates, { historyLimit = 20 } = {}) {
    const user = q.user.get(userId);
    if (!user) throw new HttpError(404, 'user not found');
    const settings = q.settings.get(userId);
    const goal = q.goal.get(userId);
    const { piggy } = q.piggy.get(userId);

    const byAsset = Object.fromEntries(q.holdings.all(userId).map((h) => [h.asset, h]));
    const holdings = Object.keys(ASSETS).map((asset) => {
      const h = byAsset[asset] ?? { qty: 0, cost: 0, buys: 0 };
      return { asset, ...ASSETS[asset], qty: h.qty, cost: h.cost, buys: h.buys, rate: rates[asset],
        value: positionValue(asset, h.qty, h.cost, rates[asset]) };
    });
    const invested = holdings.reduce((s, h) => s + h.cost, 0);
    const value = holdings.reduce((s, h) => s + h.value, 0);

    const stats = q.roundStats.get(userId);
    const saved = invested + piggy;
    const history = [
      ...q.recentPayments.all(userId, historyLimit).map((p) => ({ type: 'round', ...p })),
      ...q.recentPurchases.all(userId, historyLimit).map((p) => ({ type: 'buy', ...p })),
    ].sort((a, b) => b.created_at.localeCompare(a.created_at)
        || (a.type === b.type ? b.id - a.id : a.type === 'buy' ? -1 : 1))
     .slice(0, historyLimit);

    return {
      user: { id: user.id, name: user.name, card_last4: user.card_last4 },
      settings,
      piggy,
      totals: { invested, value, profitPct: invested ? (value - invested) / invested * 100 : 0 },
      holdings,
      goal: goal && {
        ...goal, saved,
        pct: Math.min(100, saved / goal.target * 100),
        forecastMonths: forecastMonths(saved, goal.target, stats.avg),
      },
      stats: { roundups: stats.n, avgRoundup: Math.round(stats.avg) },
      history,
      rates,
      options: { assets: ASSETS, steps: STEPS, multipliers: MULTIPLIERS, thresholds: THRESHOLDS },
    };
  }

  // Демо-данные: три прошлые пакетные покупки и неделя покупок Ивана.
  function seed(userId = DEMO_USER) {
    tx(db, () => {
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      db.prepare('INSERT INTO users (id, name, card_last4, created_at) VALUES (?, ?, ?, ?)')
        .run(userId, 'Иван К.', '4821', new Date().toISOString());
      db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(userId);
      q.upsertGoal.run(userId, 'Ноутбук', 200000);
    });

    const day = 86_400_000, start = Date.now() - 10 * day;
    const past = { BTC: FALLBACK.BTC / 1.024, ETH: FALLBACK.ETH / 1.024, SAFE: 1, source: 'seed' };
    for (let i = 0; i < 3; i++) {
      const at = new Date(start + i * day).toISOString();
      const qty = quantity(2000, 'BTC', past.BTC);
      q.insertPurchase.run(userId, 'BTC', 2000, past.BTC, qty, 'seed', at);
    }
    const week = [['Продукты', 4730], ['Кофе', 640], ['Такси', 1280], ['Шаурма', 990], ['Фастфуд', 1475], ['Продукты', 3215],
      ['Кофе', 640], ['Онлайн-заказ', 8915], ['Такси', 1640], ['Кофе', 720], ['Продукты', 2860], ['Фастфуд', 1185]];
    week.forEach(([m, a], i) => addPayment(userId, m, a, past, new Date(start + 3 * day + i * day / 2).toISOString()));
  }

  function ensureSeeded() {
    if (!q.user.get(DEMO_USER)) seed(DEMO_USER);
  }

  return { addPayment, buyNow, updateSettings, updateGoal, getState, seed, ensureSeeded };
}
