import { randomUUID } from 'node:crypto';
import {
  ASSETS, STEPS, MULTIPLIERS, THRESHOLDS,
  roundUp, quantity, positionValue, shouldBuy, forecastMonths,
} from './engine.js';
import { FALLBACK } from './rates.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const nowIso = () => new Date().toISOString();
const USER_COLS = 'id, name, email, card_last4, is_demo, created_at';
const CARD_COLS = 'id, user_id, ref, provider, status, checkout_token, card_token, last4, brand, error, created_at, updated_at';
const PURCHASE_COLS = 'id, user_id, asset, amount, rate, qty, rate_source, status, charge_ref, order_ref, error, created_at, updated_at';
const PIGGY_SQL = 'SELECT COALESCE(SUM(roundup), 0) AS piggy FROM payments WHERE user_id = ? AND purchase_id IS NULL';

// Все суммы — в копейках. db — адаптер из database.js.
export function createStore(db) {
  const getUser = (id, q = db) => q.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [id]);
  async function requireUser(id, q = db) {
    const u = await getUser(id, q);
    if (!u) throw new HttpError(404, 'user not found');
    return u;
  }

  // ---------- пользователи и сессии ----------

  async function createUser({ email, name, passwordHash }) {
    return db.tx(async (t) => {
      if (await t.get('SELECT id FROM users WHERE email = ?', [email])) throw new HttpError(409, 'Этот email уже зарегистрирован');
      const id = await t.insert('INSERT INTO users (name, email, password_hash, card_last4, is_demo, created_at) VALUES (?, ?, ?, ?, 0, ?)',
        [name, email, passwordHash, '', nowIso()]);
      await t.run('INSERT INTO settings (user_id) VALUES (?)', [id]);
      await t.run('INSERT INTO goals (user_id, name, target) VALUES (?, ?, ?)', [id, 'Первая цель', 100000]);
      return getUser(id, t);
    });
  }

  const findUserByEmail = (email) =>
    db.get('SELECT id, password_hash FROM users WHERE email = ? AND is_demo = 0', [email]);

  async function createSession(userId, tokenHash, ttlMs) {
    const at = Date.now();
    await db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      [tokenHash, userId, new Date(at).toISOString(), new Date(at + ttlMs).toISOString()]);
  }
  async function userBySession(tokenHash) {
    const row = await db.get('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?', [tokenHash, nowIso()]);
    return row && getUser(row.user_id);
  }
  const deleteSession = (tokenHash) => db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);

  // ---------- пересылка уведомлений банка ----------

  async function setIngestToken(userId, tokenHash) {
    await db.tx(async (t) => {
      await t.run('DELETE FROM ingest_tokens WHERE user_id = ?', [userId]);
      await t.run('INSERT INTO ingest_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)', [tokenHash, userId, nowIso()]);
    });
  }
  const deleteIngestToken = (userId) => db.run('DELETE FROM ingest_tokens WHERE user_id = ?', [userId]);
  async function userByIngestToken(tokenHash) {
    const row = await db.get('SELECT user_id FROM ingest_tokens WHERE token_hash = ?', [tokenHash]);
    return row && getUser(row.user_id);
  }

  // ---------- карты ----------

  async function createCard(userId, provider) {
    const at = nowIso();
    const id = await db.insert(`INSERT INTO cards (user_id, ref, provider, status, created_at, updated_at)
                                VALUES (?, ?, ?, 'pending', ?, ?)`, [userId, randomUUID(), provider, at, at]);
    return getCard(id);
  }
  const getCard = (id) => db.get(`SELECT ${CARD_COLS} FROM cards WHERE id = ?`, [id]);
  const cardByRef = (ref) => db.get(`SELECT ${CARD_COLS} FROM cards WHERE ref = ?`, [ref]);
  const activeCard = (userId) =>
    db.get(`SELECT ${CARD_COLS} FROM cards WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, [userId]);
  const latestCard = (userId) =>
    db.get(`SELECT ${CARD_COLS} FROM cards WHERE user_id = ? AND status <> 'removed' ORDER BY id DESC LIMIT 1`, [userId]);

  // Активная карта у пользователя одна: новая заменяет прежнюю
  async function updateCard(id, patch) {
    return db.tx(async (t) => {
      const card = await t.get(`SELECT ${CARD_COLS} FROM cards WHERE id = ?`, [id]);
      if (!card) throw new HttpError(404, 'card not found');
      const next = { ...card, ...patch, updated_at: nowIso() };
      if (patch.status === 'active') {
        await t.run(`UPDATE cards SET status = 'removed', updated_at = ? WHERE user_id = ? AND status = 'active' AND id <> ?`,
          [next.updated_at, card.user_id, id]);
        await t.run('UPDATE users SET card_last4 = ? WHERE id = ?', [next.last4 ?? '', card.user_id]);
      }
      if (patch.status === 'removed' && card.status === 'active') {
        await t.run('UPDATE users SET card_last4 = ? WHERE id = ?', ['', card.user_id]);
      }
      await t.run(`UPDATE cards SET status = ?, checkout_token = ?, card_token = ?, last4 = ?, brand = ?, error = ?, updated_at = ?
                   WHERE id = ?`,
        [next.status, next.checkout_token, next.card_token, next.last4, next.brand, next.error, next.updated_at, id]);
      return next;
    });
  }

  // ---------- оплаты и копилка ----------

  // Резервирует всю копилку под новую покупку (status = pending) и привязывает к ней оплаты.
  // Списание с карты и покупка актива — в purchaser.js, уже вне транзакции.
  async function claimPiggy(t, userId, at) {
    const { piggy } = await t.get(PIGGY_SQL, [userId]);
    if (piggy <= 0) return null;
    const { asset } = await t.get('SELECT asset FROM settings WHERE user_id = ?', [userId]);
    const id = await t.insert(`INSERT INTO purchases (user_id, asset, amount, rate, qty, rate_source, status, created_at, updated_at)
                               VALUES (?, ?, ?, 0, 0, '', 'pending', ?, ?)`, [userId, asset, piggy, at, at]);
    await t.run('UPDATE payments SET purchase_id = ? WHERE user_id = ? AND purchase_id IS NULL', [id, userId]);
    return { id, user_id: userId, asset, amount: piggy, status: 'pending', created_at: at };
  }

  // Оплата картой: округление, сдача в копилку, при достижении порога — резерв под покупку.
  // externalId (id транзакции у банка) делает повторное уведомление безопасным.
  async function addPayment(userId, { merchant, amount, source = 'emulator', externalId = null, cardId = null, at = nowIso() }) {
    return db.tx(async (t) => {
      await requireUser(userId, t);
      await t.lockUser(userId);
      if (externalId) {
        const dup = await t.get('SELECT id FROM payments WHERE external_id = ?', [externalId]);
        if (dup) return { duplicate: true, payment: { id: dup.id }, purchase: null };
      }
      const s = await t.get('SELECT round_step, multiplier, threshold FROM settings WHERE user_id = ?', [userId]);
      const { rounded, roundup } = roundUp(amount, s.round_step, s.multiplier);
      const id = await t.insert(`INSERT INTO payments (user_id, merchant, amount, rounded, roundup, round_step, multiplier, source, external_id, card_id, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, merchant, amount, rounded, roundup, s.round_step, s.multiplier, source, externalId, cardId, at]);
      const { piggy } = await t.get(PIGGY_SQL, [userId]);
      const purchase = shouldBuy(piggy, s.threshold) ? await claimPiggy(t, userId, at) : null;
      return { payment: { id, merchant, amount, rounded, roundup, multiplier: s.multiplier, source, created_at: at }, purchase };
    });
  }

  async function claimNow(userId, at = nowIso()) {
    const purchase = await db.tx(async (t) => {
      await requireUser(userId, t);
      await t.lockUser(userId);
      return claimPiggy(t, userId, at);
    });
    if (!purchase) throw new HttpError(409, 'Копилка пуста');
    return purchase;
  }

  // ---------- покупки ----------

  const getPurchase = (id) => db.get(`SELECT ${PURCHASE_COLS} FROM purchases WHERE id = ?`, [id]);
  const purchasesByStatus = (statuses) =>
    db.all(`SELECT ${PURCHASE_COLS} FROM purchases WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY id`, statuses);

  async function markPurchase(id, patch) {
    const keys = Object.keys(patch);
    await db.run(`UPDATE purchases SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => patch[k]), nowIso(), id]);
    return getPurchase(id);
  }

  // Списание не прошло: покупка помечается failed, сдача возвращается в копилку
  async function failPurchase(id, error) {
    return db.tx(async (t) => {
      await t.run(`UPDATE purchases SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, [error, nowIso(), id]);
      await t.run('UPDATE payments SET purchase_id = NULL WHERE purchase_id = ?', [id]);
      return t.get(`SELECT ${PURCHASE_COLS} FROM purchases WHERE id = ?`, [id]);
    });
  }

  // ---------- настройки и цель ----------

  async function updateSettings(userId, patch) {
    await requireUser(userId);
    const s = await db.get('SELECT round_step, multiplier, asset, threshold FROM settings WHERE user_id = ?', [userId]);
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
    await db.run('UPDATE settings SET round_step = ?, multiplier = ?, asset = ?, threshold = ? WHERE user_id = ?',
      [next.round_step, next.multiplier, next.asset, next.threshold, userId]);
    return next;
  }

  async function updateGoal(userId, { name, target }) {
    await requireUser(userId);
    const n = String(name ?? '').trim().slice(0, 24);
    if (!n) throw new HttpError(400, 'Укажите название цели');
    if (!Number.isInteger(target) || target <= 0 || target > 1_000_000_000) throw new HttpError(400, 'Некорректная сумма цели');
    await db.run(`INSERT INTO goals (user_id, name, target) VALUES (?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, target = excluded.target`, [userId, n, target]);
    return { name: n, target };
  }

  // ---------- состояние дашборда ----------

  async function getState(userId, rates, { historyLimit = 20 } = {}) {
    const user = await requireUser(userId);
    const settings = await db.get('SELECT round_step, multiplier, asset, threshold FROM settings WHERE user_id = ?', [userId]);
    const goal = await db.get('SELECT name, target FROM goals WHERE user_id = ?', [userId]);
    const { piggy } = await db.get(PIGGY_SQL, [userId]);
    // В работе: сдача уже зарезервирована под покупку, но актив ещё не куплен
    const { inflight } = await db.get(`SELECT COALESCE(SUM(amount), 0) AS inflight FROM purchases
                                       WHERE user_id = ? AND status IN ('pending','charged','review')`, [userId]);

    const rows = await db.all(`SELECT asset, SUM(qty) AS qty, SUM(amount) AS cost, COUNT(*) AS buys
                               FROM purchases WHERE user_id = ? AND status = 'filled' GROUP BY asset`, [userId]);
    const byAsset = Object.fromEntries(rows.map((h) => [h.asset, h]));
    const holdings = Object.keys(ASSETS).map((asset) => {
      const h = byAsset[asset] ?? { qty: 0, cost: 0, buys: 0 };
      return { asset, ...ASSETS[asset], qty: h.qty, cost: h.cost, buys: h.buys, rate: rates[asset],
        value: positionValue(asset, h.qty, h.cost, rates[asset]) };
    });
    const invested = holdings.reduce((s, h) => s + h.cost, 0);
    const value = holdings.reduce((s, h) => s + h.value, 0);

    const stats = await db.get('SELECT COUNT(*) AS n, COALESCE(AVG(roundup), 0) AS avg FROM payments WHERE user_id = ?', [userId]);
    const saved = invested + piggy + inflight;
    const payments = await db.all(`SELECT id, merchant, amount, rounded, roundup, multiplier, source, purchase_id, created_at
                                   FROM payments WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`, [userId, historyLimit]);
    const purchases = await db.all(`SELECT id, asset, amount, rate, qty, rate_source, status, error, created_at
                                    FROM purchases WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`, [userId, historyLimit]);
    const history = [
      ...payments.map((p) => ({ type: 'round', ...p })),
      ...purchases.map((p) => ({ type: 'buy', ...p })),
    ].sort((a, b) => b.created_at.localeCompare(a.created_at)
        || (a.type === b.type ? b.id - a.id : a.type === 'buy' ? -1 : 1))
     .slice(0, historyLimit);

    const card = user.is_demo ? null : await latestCard(userId);
    const ingest = user.is_demo ? null : await db.get('SELECT created_at FROM ingest_tokens WHERE user_id = ?', [userId]);
    return {
      user: { id: user.id, name: user.name, email: user.email, card_last4: user.card_last4, is_demo: !!user.is_demo },
      card: card ? { id: card.id, ref: card.ref, provider: card.provider, status: card.status, last4: card.last4, brand: card.brand, error: card.error } : null,
      sms: { connected: !!ingest, since: ingest?.created_at ?? null },
      settings,
      piggy,
      inFlight: inflight,
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

  // ---------- демо ----------

  const demoUserId = async () => (await db.get('SELECT id FROM users WHERE is_demo = 1 ORDER BY id LIMIT 1'))?.id;

  // Демо-данные: три прошлые пакетные покупки и неделя покупок Ивана.
  // Прошлые покупки считаются от текущего курса (на 2,4% ниже), чтобы доходность была правдоподобной.
  async function seedDemo(rates = FALLBACK) {
    const id = await db.tx(async (t) => {
      await t.run('DELETE FROM users WHERE is_demo = 1');
      const uid = await t.insert('INSERT INTO users (name, card_last4, is_demo, created_at) VALUES (?, ?, 1, ?)', ['Иван К.', '4821', nowIso()]);
      await t.run('INSERT INTO settings (user_id) VALUES (?)', [uid]);
      await t.run('INSERT INTO goals (user_id, name, target) VALUES (?, ?, ?)', [uid, 'Ноутбук', 200000]);
      return uid;
    });

    const day = 86_400_000, start = Date.now() - 10 * day;
    const past = { BTC: rates.BTC / 1.024, ETH: rates.ETH / 1.024, SAFE: 1 };
    for (let i = 0; i < 3; i++) {
      const at = new Date(start + i * day).toISOString();
      await db.run(`INSERT INTO purchases (user_id, asset, amount, rate, qty, rate_source, status, order_ref, created_at, updated_at)
                    VALUES (?, 'BTC', 2000, ?, ?, 'seed', 'filled', 'seed', ?, ?)`, [id, past.BTC, quantity(2000, 'BTC', past.BTC), at, at]);
    }
    const week = [['Продукты', 4730], ['Кофе', 640], ['Такси', 1280], ['Шаурма', 990], ['Фастфуд', 1475], ['Продукты', 3215],
      ['Кофе', 640], ['Онлайн-заказ', 8915], ['Такси', 1640], ['Кофе', 720], ['Продукты', 2860], ['Фастфуд', 1185]];
    for (const [i, [merchant, amount]] of week.entries()) {
      const at = new Date(start + 3 * day + i * day / 2).toISOString();
      const { purchase } = await addPayment(id, { merchant, amount, at });
      if (purchase) {
        const rate = past[purchase.asset];
        await markPurchase(purchase.id, { status: 'filled', rate, qty: quantity(purchase.amount, purchase.asset, rate), rate_source: 'seed', order_ref: 'seed' });
      }
    }
    return id;
  }

  const ensureDemo = async (rates) => (await demoUserId()) ?? seedDemo(rates);

  return {
    getUser, createUser, findUserByEmail, createSession, userBySession, deleteSession,
    setIngestToken, deleteIngestToken, userByIngestToken,
    createCard, getCard, cardByRef, activeCard, latestCard, updateCard,
    addPayment, claimNow, getPurchase, purchasesByStatus, markPurchase, failPurchase,
    updateSettings, updateGoal, getState, demoUserId, seedDemo, ensureDemo,
  };
}
