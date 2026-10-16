// Реальный курс: CoinGecko (USD) × официальный курс НБРБ (BYN за $1).
// Каждое успешное получение пишется в таблицу rates; при недоступности API
// используется последний сохранённый курс, а если его нет — зашитая оценка.

export const FALLBACK = { BTC: 200850, ETH: 8206, usd: 3.0113 };
const TTL_MS = 30_000;
const TIMEOUT_MS = 6_000;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

export async function fetchLive() {
  const [cg, nb] = await Promise.all([
    getJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd'),
    getJson('https://api.nbrb.by/exrates/rates/USD?parammode=2'),
  ]);
  const usd = nb?.Cur_OfficialRate, btc = cg?.bitcoin?.usd, eth = cg?.ethereum?.usd;
  if (!(usd > 0 && btc > 0 && eth > 0)) throw new Error('unexpected rate payload');
  return { BTC: round2(btc * usd), ETH: round2(eth * usd), usd };
}

const round2 = (n) => Math.round(n * 100) / 100;

export function createRates(db, { fetcher = fetchLive, now = () => Date.now() } = {}) {
  const insert = db.prepare(
    'INSERT INTO rates (btc, eth, usd_byn, source, fetched_at) VALUES (?, ?, ?, ?, ?)');
  const latest = db.prepare('SELECT * FROM rates ORDER BY id DESC LIMIT 1');
  let pending = null;

  function fromRow(row) {
    return { BTC: row.btc, ETH: row.eth, SAFE: 1, usd: row.usd_byn, source: row.source, fetchedAt: row.fetched_at };
  }

  function cached() {
    const row = latest.get();
    if (row) return fromRow(row);
    return { ...FALLBACK, SAFE: 1, source: 'fallback', fetchedAt: null };
  }

  async function refresh() {
    try {
      const r = await fetcher();
      const at = new Date(now()).toISOString();
      insert.run(r.BTC, r.ETH, r.usd, 'live', at);
      return { BTC: r.BTC, ETH: r.ETH, SAFE: 1, usd: r.usd, source: 'live', fetchedAt: at };
    } catch (err) {
      console.warn('[rates] live rate unavailable:', err.message);
      return { ...cached(), stale: true };
    }
  }

  // Свежий курс (не старше TTL). Параллельные запросы делят одно обращение к API.
  async function current({ force = false } = {}) {
    const c = cached();
    const age = c.fetchedAt && c.source === 'live' ? now() - Date.parse(c.fetchedAt) : Infinity;
    if (!force && age < TTL_MS) return c;
    pending ??= refresh().finally(() => { pending = null; });
    return pending;
  }

  return { current, cached };
}
