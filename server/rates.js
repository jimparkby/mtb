// Реальный курс. Сначала — белорусские площадки-резиденты ПВТ, где пара сразу в рублях
// (BTC/BYN, ETH/BYN): берём середину между ценой покупки и продажи — она двигается
// с каждой котировкой, а не только при сделке. Если они недоступны — мировые биржи
// (USD/USDT) × официальный курс НБРБ (BYN за $1).
// Площадки опрашиваются по очереди: если одна недоступна (например, Binance отвечает 451
// для серверов в США), берётся следующая. Курс НБРБ меняется раз в день и кэшируется на час.
// Тики держатся в памяти для графика, в таблицу rates пишется не чаще раза в минуту;
// при недоступности API используется последний известный курс, а если его нет — зашитая оценка.

export const FALLBACK = { BTC: 200850, ETH: 8206, usd: 3.0113 };
const TTL_MS = 5_000;
const TIMEOUT_MS = 4_000;
const USD_TTL_MS = 3_600_000;
const PERSIST_MS = 60_000;
const TICKS_MAX = 720; // час при тике раз в 5 с

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const mid = (bid, ask) => (Number(bid) + Number(ask)) / 2;

// [название, получение { BTC, ETH }, валюта цены]
export const EXCHANGES = [
  // Dzengi (ЗАО «Дзеньги», резидент ПВТ): открытый документированный API
  ['Dzengi', async () => {
    const [btc, eth] = await Promise.all(['BTC/BYN', 'ETH/BYN'].map((s) =>
      getJson(`https://api-adapter.dzengi.com/api/v2/ticker/24hr?symbol=${encodeURIComponent(s)}`)));
    return { BTC: mid(btc.bidPrice, btc.askPrice), ETH: mid(eth.bidPrice, eth.askPrice) };
  }, 'BYN'],
  // Bynex (резидент ПВТ): эндпоинт их страницы обмена, не документирован и может измениться
  ['Bynex', async () => {
    const [btc, eth] = await Promise.all(['BTC-BYN', 'ETH-BYN'].map((s) =>
      getJson(`https://bynex.io/exchange/en/api/rate/${s}`)));
    return { BTC: mid(btc.sell, btc.buy), ETH: mid(eth.sell, eth.buy) };
  }, 'BYN'],
  ['Binance', async () => {
    const list = await getJson('https://api.binance.com/api/v3/ticker/price?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22%5D');
    const p = Object.fromEntries(list.map((t) => [t.symbol, Number(t.price)]));
    return { BTC: p.BTCUSDT, ETH: p.ETHUSDT };
  }],
  ['OKX', async () => {
    const [btc, eth] = await Promise.all(['BTC-USDT', 'ETH-USDT'].map((id) =>
      getJson(`https://www.okx.com/api/v5/market/ticker?instId=${id}`)));
    return { BTC: Number(btc.data?.[0]?.last), ETH: Number(eth.data?.[0]?.last) };
  }],
  ['Kraken', async () => {
    const r = await getJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD');
    return { BTC: Number(r.result?.XXBTZUSD?.c?.[0]), ETH: Number(r.result?.XETHZUSD?.c?.[0]) };
  }],
  ['Coinbase', async () => {
    const [btc, eth] = await Promise.all(['BTC-USD', 'ETH-USD'].map((id) =>
      getJson(`https://api.exchange.coinbase.com/products/${id}/ticker`)));
    return { BTC: Number(btc.price), ETH: Number(eth.price) };
  }],
  ['CoinGecko', async () => {
    const r = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd');
    return { BTC: r.bitcoin?.usd, ETH: r.ethereum?.usd };
  }],
];

export async function fetchCrypto(exchanges = EXCHANGES) {
  const errors = [];
  for (const [name, get, currency = 'USD'] of exchanges) {
    try {
      const p = await get();
      if (p.BTC > 0 && p.ETH > 0) return { ...p, exchange: name, currency };
      errors.push(`${name}: unexpected payload`);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(errors.join('; '));
}

let usdCache = null;
async function fetchUsd() {
  if (usdCache && Date.now() - usdCache.at < USD_TTL_MS) return usdCache.usd;
  try {
    const usd = (await getJson('https://api.nbrb.by/exrates/rates/USD?parammode=2'))?.Cur_OfficialRate;
    if (!(usd > 0)) throw new Error('unexpected NBRB payload');
    usdCache = { usd, at: Date.now() };
    return usd;
  } catch (err) {
    if (usdCache) return usdCache.usd; // вчерашний официальный курс лучше, чем никакого
    throw err;
  }
}

export async function fetchLive() {
  const [crypto, usd] = await Promise.allSettled([fetchCrypto(), fetchUsd()]);
  if (crypto.status === 'rejected') throw crypto.reason;
  const p = crypto.value, base = { exchange: p.exchange, currency: p.currency };
  // Рублёвой паре НБРБ не нужен, курс доллара — только для справки
  if (p.currency === 'BYN') return { BTC: round2(p.BTC), ETH: round2(p.ETH), usd: usd.value ?? 0, ...base };
  if (usd.status === 'rejected') throw usd.reason;
  return { BTC: round2(p.BTC * usd.value), ETH: round2(p.ETH * usd.value), usd: usd.value, ...base };
}

const round2 = (n) => Math.round(n * 100) / 100;

// Асинхронная фабрика: при старте поднимает из БД последний курс и тики за час.
export async function createRates(db, { fetcher = fetchLive, now = () => Date.now() } = {}) {
  let pending = null, last = null, persistedAt = 0, failedAt = -Infinity, timer = null;

  const row = await db.get('SELECT btc, eth, usd_byn, source, fetched_at FROM rates ORDER BY id DESC LIMIT 1');
  // Сохранённый курс — до первого успешного запроса; без него — зашитая оценка
  const saved = row
    ? { BTC: row.btc, ETH: row.eth, SAFE: 1, usd: row.usd_byn, source: row.source, fetchedAt: row.fetched_at }
    : { ...FALLBACK, SAFE: 1, source: 'fallback', fetchedAt: null };

  // График после рестарта начинается с поминутных записей из БД
  const ticks = (await db.all('SELECT btc, eth, fetched_at FROM rates WHERE fetched_at >= ? ORDER BY id',
    [new Date(now() - TICKS_MAX * TTL_MS).toISOString()]))
    .map((r) => ({ t: r.fetched_at, BTC: r.btc, ETH: r.eth }));

  const cached = () => last ?? saved;

  async function refresh() {
    try {
      const r = await fetcher();
      const at = new Date(now()).toISOString();
      last = { BTC: r.BTC, ETH: r.ETH, SAFE: 1, usd: r.usd, source: 'live', exchange: r.exchange, currency: r.currency, fetchedAt: at };
      ticks.push({ t: at, BTC: r.BTC, ETH: r.ETH });
      if (ticks.length > TICKS_MAX) ticks.splice(0, ticks.length - TICKS_MAX);
      if (now() - persistedAt >= PERSIST_MS) {
        persistedAt = now();
        await db.run('INSERT INTO rates (btc, eth, usd_byn, source, fetched_at) VALUES (?, ?, ?, ?, ?)', [r.BTC, r.ETH, r.usd, 'live', at])
          .catch((err) => console.warn('[rates] could not persist rate:', err.message));
      }
      return last;
    } catch (err) {
      console.warn('[rates] live rate unavailable:', err.message);
      failedAt = now();
      return { ...cached(), stale: true };
    }
  }

  // Свежий курс (не старше TTL). Параллельные запросы делят одно обращение к API.
  async function current({ force = false } = {}) {
    const c = cached();
    const age = c.fetchedAt && c.source === 'live' ? now() - Date.parse(c.fetchedAt) : Infinity;
    if (!force && age < TTL_MS) return c;
    if (!force && now() - failedAt < TTL_MS) return { ...c, stale: true }; // не долбим упавшие API
    pending ??= refresh().finally(() => { pending = null; });
    return pending;
  }

  // Фоновый опрос, чтобы график шёл, даже когда страницу никто не открывал
  function start(intervalMs = TTL_MS) {
    timer ??= setInterval(() => current().catch(() => {}), intervalMs);
    timer.unref?.();
    return current();
  }
  function stop() { clearInterval(timer); timer = null; }

  return { current, cached, ticks: () => ticks.slice(), start, stop };
}
