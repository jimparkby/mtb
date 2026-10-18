// Клиент KOPI: все расчёты и данные — на сервере (/api), здесь только отображение.
const LOGO = new URL('logo.png', import.meta.url).href;
const PRESETS = [['Кофе', 640], ['Шаурма', 990], ['Такси', 1280], ['Продукты', 4730], ['Онлайн-заказ', 8915], ['Фастфуд', 1475]];
const $ = (id) => document.getElementById(id);

let S = null;
let ticks = []; // курс за последний час: { t, BTC, ETH }
let prev = null; // прошлое состояние — чтобы подсветить, что выросло, а что упало

// Если страница открыта не с нашего сервера (Live Server, file://, GitHub Pages),
// запросы идут на бэкенд в Railway.
const PROD_API = 'https://kopi-production-6db1.up.railway.app';
const API_BASE = await (async () => {
  if (location.protocol === 'file:') return PROD_API;
  try {
    const r = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
    if (r.ok && (await r.json()).ok) return '';
  } catch { /* своего бэкенда нет */ }
  return PROD_API;
})();

// Сессия аккаунта. Без токена сервер отвечает данными демо-пользователя.
const TOKEN_KEY = 'kopi.token';
let token = (() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } })();
function setToken(t) {
  token = t;
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* приватный режим */ }
}

async function api(method, path, body) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && !path.startsWith('/api/auth/')) {
    setToken(null);
    toast('Сессия истекла', 'Войдите снова — пока показываем демо');
    setTimeout(() => reload(), 0);
  }
  if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
  return data;
}
let CFG = { payments: null, broker: 'paper' };

const fmt = (k) => (k / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (k) => Math.round(k / 100).toLocaleString('ru-RU');
const fmtQty = (q, a) => a === 'SAFE' ? fmt(q * 100) : q.toLocaleString('ru-RU', { maximumFractionDigits: a === 'BTC' ? 6 : 5 });
const fmtPct = (p) => (p >= 0 ? '+' : '') + p.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + '%';
const fmtWhen = (iso) => {
  const d = new Date(iso), today = new Date();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? time : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + time;
};
const assetLabel = (a) => a === 'SAFE' ? 'BYN' : a;

function toast(title, text) {
  const box = $('toasts');
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = '<img alt="" src="' + LOGO + '"><div><b></b><span></span></div>';
  el.querySelector('b').textContent = title; el.querySelector('span').textContent = text;
  box.prepend(el);
  while (box.children.length > 3) box.lastChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3600);
}
function toastPurchase(p) {
  if (p.status === 'failed') return toast('Покупка не прошла', (p.error || 'Списание отклонено') + '. Сдача осталась в копилке');
  if (p.status !== 'filled') return toast('Покупка в обработке', 'Сдача ' + fmt(p.amount) + ' BYN списана, покупаем ' + p.asset);
  toast('Куплено ' + (p.asset === 'SAFE' ? 'в консервативный' : p.asset) + ' на ' + fmt(p.amount) + ' BYN',
    p.asset === 'SAFE' ? 'Деньги работают на цель'
      : fmtQty(p.qty, p.asset) + ' ' + p.asset + ' по курсу ' + Math.round(p.rate).toLocaleString('ru-RU') + ' BYN');
}

// Подсвечивает элемент зелёным или красным, если число изменилось с прошлого рендера
function flash(el, now, before) {
  if (before == null || now === before) return;
  el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth;
  el.classList.add(now > before ? 'flash-up' : 'flash-down');
}

function addTick(r) {
  if (r.source !== 'live' || !r.fetchedAt) return;
  if (ticks.length && ticks[ticks.length - 1].t >= r.fetchedAt) return;
  ticks.push({ t: r.fetchedAt, BTC: r.BTC, ETH: r.ETH });
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  while (ticks.length > 2 && ticks[0].t < hourAgo) ticks.shift();
}

// Сколько стоил бы текущий портфель по каждому тику курса — так видно, как меняется капитал
function renderSpark() {
  const svg = $('spark');
  const fixed = S.holdings.filter((h) => h.asset === 'SAFE').reduce((s, h) => s + h.value, 0);
  const crypto = S.holdings.filter((h) => h.asset !== 'SAFE' && h.qty > 0);
  const pts = ticks.map((t) => fixed + crypto.reduce((s, h) => s + Math.round(h.qty * t[h.asset] * 100), 0));
  if (pts.length < 2 || !crypto.length) {
    svg.toggleAttribute('hidden', true); // у SVG нет свойства hidden, только атрибут
    $('sparkFrom').textContent = crypto.length ? 'График появится через пару обновлений курса' : '';
    $('sparkDelta').textContent = '';
    return;
  }
  svg.toggleAttribute('hidden', false);
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const W = 300, H = 64, pad = 4;
  const xy = pts.map((v, i) => [i / (pts.length - 1) * W, pad + (1 - (v - min) / span) * (H - 2 * pad)]);
  const line = xy.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join(' ');
  svg.querySelector('.line').setAttribute('d', line);
  svg.querySelector('.area').setAttribute('d', line + ' L' + W + ' ' + H + ' L0 ' + H + ' Z');
  const d = pts[pts.length - 1] - pts[0];
  svg.classList.toggle('down', d < 0);
  $('sparkFrom').textContent = 'С ' + new Date(ticks[0].t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  $('sparkDelta').textContent = (d >= 0 ? '+' : '−') + fmt(Math.abs(d)) + ' BYN (' + fmtPct(pts[0] ? d / pts[0] * 100 : 0) + ')';
}

function render() {
  const { totals, settings, goal, piggy, holdings, history, stats, rates, user } = S;
  const A = S.options.assets[settings.asset];
  addTick(rates);

  $('totalValue').innerHTML = fmt(totals.value) + ' <small>BYN</small>';
  if (prev && prev.invested === totals.invested) flash($('totalValue'), totals.value, prev.value);
  const lb = $('liveBadge');
  lb.hidden = rates.source !== 'live';
  lb.classList.toggle('stale', !!rates.stale);
  $('liveSrc').textContent = (rates.stale ? 'Нет связи · ' : 'Live · ') + (rates.exchange || 'биржа');
  renderSpark();
  $('investedLine').textContent = 'Вложено ' + fmt(totals.invested) + ' BYN';
  $('deltaLine').textContent = fmtPct(totals.profitPct);
  $('deltaLine').className = 'delta num ' + (totals.profitPct >= 0 ? 'up' : 'down');

  $('assetNow').textContent = 'Вкладываем в ' + A.code;
  $('piggy').textContent = fmt(piggy) + ' BYN';
  $('piggyOf').textContent = 'покупка на ' + fmt(settings.threshold);
  $('piggyBar').style.width = Math.min(100, piggy / settings.threshold * 100) + '%';
  const bn = $('buyNow');
  bn.textContent = 'Купить ' + A.code + ' сейчас' + (piggy > 0 ? ' на ' + fmt(piggy) + ' BYN' : '');
  bn.disabled = piggy <= 0;

  $('goalName').textContent = goal.name;
  $('goalOf').textContent = fmtInt(goal.saved) + ' из ' + fmtInt(goal.target) + ' BYN';
  $('goalPct').textContent = goal.pct.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + '%';
  $('goalBar').style.width = goal.pct + '%';
  $('goalHint').textContent = goal.saved >= goal.target ? 'Цель достигнута.'
    : goal.forecastMonths ? 'При 60 покупках в месяц цель будет достигнута примерно через ' + goal.forecastMonths + ' мес.'
    : 'Сделайте первую покупку, чтобы увидеть прогноз.';

  const as = $('assets'); as.innerHTML = '';
  holdings.forEach((h) => {
    if (!h.cost && h.asset !== settings.asset) return;
    const row = document.createElement('div'); row.className = 'asset';
    row.innerHTML = '<div class="coin ' + h.asset + '">' + assetLabel(h.asset) + '</div><div><b></b><div class="sub num"></div></div><div class="r"><b class="num"></b><div class="sub num"></div></div>';
    row.querySelectorAll('b')[0].textContent = h.name;
    row.querySelectorAll('.sub')[0].textContent = h.asset === 'SAFE' ? 'без изменения курса'
      : fmtQty(h.qty, h.asset) + ' ' + h.asset + ' · курс ' + Math.round(h.rate).toLocaleString('ru-RU') + ' BYN';
    row.querySelectorAll('b')[1].textContent = fmt(h.value) + ' BYN';
    if (h.asset !== 'SAFE') {
      flash(row.querySelectorAll('.sub')[0], h.rate, prev?.rates[h.asset]);
      if (prev?.qty[h.asset] === h.qty) flash(row.querySelectorAll('b')[1], h.value, prev.values[h.asset]);
    }
    const s2 = row.querySelectorAll('.sub')[1];
    const dd = h.cost ? (h.value - h.cost) / h.cost * 100 : 0;
    s2.textContent = h.cost ? fmtPct(dd) : 'пока пусто';
    s2.style.color = h.cost ? (dd >= 0 ? 'var(--good)' : 'var(--bad)') : '';
    as.appendChild(row);
  });

  const hl = $('hist'); hl.innerHTML = '';
  history.slice(0, 12).forEach((h) => {
    const r = document.createElement('div'); r.className = 'h';
    if (h.type === 'round') {
      r.innerHTML = '<div class="ic">↑</div><div class="t"><div></div><div class="s num"></div></div><div class="v num"></div>';
      r.querySelector('.t div').textContent = h.merchant + (h.source === 'bank' ? ' · карта' : '');
      r.querySelector('.s').textContent = fmt(h.amount) + ' → ' + fmt(h.rounded) + ' BYN · ' + fmtWhen(h.created_at);
      r.querySelector('.v').textContent = '+' + fmt(h.roundup);
    } else {
      r.innerHTML = '<div class="ic buy"></div><div class="t"><div></div><div class="s num"></div></div><div class="v num" style="color:var(--blue)"></div>';
      r.querySelector('.ic').textContent = h.asset === 'BTC' ? '₿' : (h.asset === 'ETH' ? 'Ξ' : 'Br');
      r.querySelector('.t div').textContent = 'Покупка ' + (h.asset === 'SAFE' ? 'консервативного' : h.asset);
      const st = PURCHASE_STATUS[h.status];
      r.querySelector('.s').textContent = (st ? st + (h.error && h.status !== 'charged' ? ': ' + h.error : '')
        : h.asset === 'SAFE' ? 'пакетом' : fmtQty(h.qty, h.asset) + ' ' + h.asset) + ' · ' + fmtWhen(h.created_at);
      r.querySelector('.v').textContent = fmt(h.amount) + ' BYN';
      if (st) { r.querySelector('.v').style.color = ''; r.querySelector('.v').classList.add(h.status === 'failed' ? 'fail' : 'wait'); }
    }
    hl.appendChild(r);
  });
  $('histCount').textContent = stats.roundups + ' округлений';

  $('cardPan').textContent = user.card_last4 ? '•••• •••• •••• ' + user.card_last4 : 'Карта не привязана';
  $('cardHolder').textContent = user.name;
  $('cardRule').textContent = 'Округление до ' + fmtInt(settings.round_step) + ' BYN' + (settings.multiplier > 1 ? ' ×' + settings.multiplier : '');
  renderAccount();
  $('rateNote').textContent = (user.is_demo ? 'Демо: оплаты эмулируются, деньги не списываются. '
    : 'Оплаты приходят от банка по привязанной карте. ' + (CFG.payments?.test ? 'Платёжный провайдер в тестовом режиме — реальные деньги не списываются. ' : '')
      + (CFG.broker === 'paper' ? 'Покупка учебная: записывается по реальному курсу площадки, ордер на биржу уйдёт после подключения криптоплатформы. ' : ''))
    + (rates.source === 'live'
    ? 'Курс реальный: ' + (rates.currency === 'BYN'
        ? 'BTC/BYN и ETH/BYN на ' + rates.exchange + ' (резидент ПВТ), середина между покупкой и продажей'
        : 'спот ' + (rates.exchange || 'биржи') + ' × официальный курс НБРБ (' + rates.usd.toLocaleString('ru-RU') + ' BYN за $1)')
      + ', обновляется каждые 5 секунд, последний раз в ' + new Date(rates.fetchedAt).toLocaleTimeString('ru-RU') + (rates.stale ? ' — сейчас биржи недоступны' : '') + '.'
    : 'Курс API недоступен, используется оценка на октябрь 2026.')
    + ' Покупка криптовалюты в продукте — через биржу-резидента ПВТ.';
  renderSettings();
  prev = {
    invested: totals.invested, value: totals.value, rates: { ...rates },
    qty: Object.fromEntries(holdings.map((h) => [h.asset, h.qty])),
    values: Object.fromEntries(holdings.map((h) => [h.asset, h.value])),
  };
}

const PURCHASE_STATUS = { pending: 'Списываем сдачу', charged: 'Сдача списана, покупаем', failed: 'Не прошла', review: 'На проверке' };

// Демо или свой аккаунт: что показывать на «Оплатить» и в «Настройках»
function renderAccount() {
  const { user, card } = S, real = !user.is_demo;
  $('accountBtn').textContent = real ? user.name : 'Демо · Войти';
  $('emuCard').hidden = real;
  if (real) $('receiptCard').hidden = true;
  $('bankCard').hidden = !real;
  $('resetBtn').hidden = real;
  $('accountText').textContent = real
    ? 'Вы вошли как ' + user.email + '.'
    : 'Сейчас открыто демо с данными Ивана. Создайте аккаунт, чтобы привязать свою карту и копить со своих покупок.';
  $('accountAction').textContent = real ? 'Выйти' : 'Войти или создать аккаунт';
  if (!real) return;

  const st = $('cardStatus'), text = $('cardText'), bind = $('bindCard');
  const status = card?.status;
  st.className = 'pill' + (status === 'active' ? ' ok' : status === 'failed' ? ' bad' : '');
  st.textContent = { active: 'Привязана', pending: 'Ожидает', failed: 'Ошибка' }[status] ?? 'Нет карты';
  text.textContent = !CFG.payments ? 'Привязка карт появится после подключения платёжного провайдера.'
    : status === 'active' ? (card.brand ? card.brand.toUpperCase() + ' ' : '') + '•••• ' + card.last4 + '. Каждая оплата этой картой округляется, сдача списывается с неё пакетом.'
    : status === 'pending' ? 'Завершите привязку на странице платёжного провайдера.'
    : status === 'failed' ? 'Не удалось привязать: ' + (card.error || 'ошибка провайдера') + '. Попробуйте ещё раз.'
    : 'Номер карты вводится на защищённой странице платёжного провайдера — KOPI его не видит и не хранит.';
  bind.hidden = status === 'active' || !CFG.payments;
  bind.textContent = status === 'pending' ? 'Продолжить привязку' : 'Привязать карту';
  $('unbindCard').hidden = status !== 'active';
  $('cardRefBox').hidden = status !== 'active';
  $('cardRef').textContent = card?.ref ?? '';
}

async function patchSettings(patch) {
  try { S = await api('PATCH', '/api/settings', patch); render(); }
  catch (e) { toast('Не удалось сохранить', e.message); }
}

function chipGroup(id, items, current, onPick) {
  const box = $(id); box.innerHTML = '';
  items.forEach(([val, label, tag]) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
    b.textContent = label; if (tag) { const e = document.createElement('em'); e.textContent = tag; b.appendChild(e); }
    b.setAttribute('aria-pressed', String(val === current));
    b.onclick = () => onPick(val);
    box.appendChild(b);
  });
}
function renderSettings() {
  const { settings, options, goal } = S;
  chipGroup('steps', options.steps.map((v) => [v, fmtInt(v) + ' BYN']), settings.round_step, (v) => patchSettings({ round_step: v }));
  chipGroup('mults', options.multipliers.map((v) => [v, '×' + v, v > 1 ? 'PREMIUM' : '']), settings.multiplier, (v) => patchSettings({ multiplier: v }));
  chipGroup('thresholds', options.thresholds.map((v) => [v, fmtInt(v) + ' BYN']), settings.threshold, (v) => patchSettings({ threshold: v }));
  const ao = $('assetOpts'); ao.innerHTML = '';
  Object.entries(options.assets).forEach(([a, info]) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'opt';
    b.setAttribute('aria-pressed', String(settings.asset === a));
    b.innerHTML = '<div class="coin ' + a + '">' + assetLabel(a) + '</div><div><b></b><span></span></div>';
    b.querySelector('b').textContent = info.name; b.querySelector('span').textContent = info.desc;
    b.onclick = () => patchSettings({ asset: a });
    ao.appendChild(b);
  });
  const gn = $('goalNameInput'), ga = $('goalAmountInput');
  if (document.activeElement !== gn) gn.value = goal.name;
  if (document.activeElement !== ga) ga.value = Math.round(goal.target / 100);
}

// Касса
PRESETS.forEach(([n, a]) => {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
  b.textContent = n + ' ' + fmt(a);
  b.onclick = () => { $('amountInput').value = fmt(a); pay(n); };
  $('presets').appendChild(b);
});

let paying = false;
async function pay(merchant) {
  if (paying) return;
  const err = $('payError'), btn = $('payBtn');
  paying = true; btn.disabled = true; err.textContent = '';
  try {
    const r = await api('POST', '/api/payments', { merchant, amount: $('amountInput').value });
    S = r.state; render();
    const { payment: p, purchase } = r;
    const rc = $('receipt'); rc.innerHTML = '';
    const rows = [['Покупка', fmt(p.amount) + ' BYN'], ['Округлено до', fmt(p.rounded) + ' BYN']];
    if (p.multiplier > 1) rows.push(['Множитель', '×' + p.multiplier]);
    rows.forEach(([l, v]) => { const d = document.createElement('div'); d.className = 'row'; d.innerHTML = '<span></span><b></b>'; d.children[0].textContent = l; d.children[1].textContent = v; rc.appendChild(d); });
    const t = document.createElement('div'); t.className = 'row total'; t.innerHTML = '<span>В копилку</span><b></b>';
    t.querySelector('b').textContent = '+' + fmt(p.roundup) + ' BYN'; rc.appendChild(t);
    if (purchase) {
      const d = document.createElement('div'); d.className = 'note';
      d.textContent = 'Копилка набрала ' + fmt(purchase.amount) + ' BYN: куплено ' + (purchase.asset === 'SAFE' ? 'консервативного инструмента' : fmtQty(purchase.qty, purchase.asset) + ' ' + purchase.asset) + ' одним пакетом.';
      rc.appendChild(d);
    }
    const card = $('receiptCard'); card.hidden = false; card.classList.remove('pop'); void card.offsetWidth; card.classList.add('pop');
    toast('Оплачено ' + fmt(p.amount) + ' BYN', p.roundup > 0 ? 'В копилку +' + fmt(p.roundup) + ' BYN. Всего в копилке ' + fmt(S.piggy) + ' BYN' : 'Сумма уже круглая, сдачи нет');
    if (purchase) setTimeout(() => toastPurchase(purchase), 700);
  } catch (e) {
    err.textContent = e.message;
  } finally {
    paying = false; btn.disabled = false;
  }
}
$('payBtn').onclick = () => pay('Покупка');
$('amountInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') pay('Покупка'); });

$('buyNow').onclick = async () => {
  try { const r = await api('POST', '/api/purchases'); S = r.state; render(); toastPurchase(r.purchase); }
  catch (e) { toast('Покупка не прошла', e.message); }
};

// Цель: сохраняем с небольшой задержкой, пока пользователь печатает
let goalTimer;
function saveGoal() {
  clearTimeout(goalTimer);
  goalTimer = setTimeout(async () => {
    const name = $('goalNameInput').value.trim();
    const n = parseInt($('goalAmountInput').value.replace(/\D/g, ''), 10);
    if (!name || !(n > 0)) return;
    try { S = await api('PUT', '/api/goal', { name, target: n * 100 }); render(); }
    catch (e) { toast('Цель не сохранена', e.message); }
  }, 400);
}
$('goalNameInput').addEventListener('input', saveGoal);
$('goalAmountInput').addEventListener('input', saveGoal);

let resetArmed = false;
$('resetBtn').onclick = async (e) => {
  if (!resetArmed) { resetArmed = true; e.target.textContent = 'Нажмите ещё раз, чтобы сбросить'; setTimeout(() => { resetArmed = false; e.target.textContent = 'Начать демо заново'; }, 3000); return; }
  resetArmed = false; e.target.textContent = 'Начать демо заново';
  try { S = await api('POST', '/api/reset'); render(); toast('Демо сброшено', 'Снова неделя покупок Ивана'); }
  catch (err) { toast('Не удалось сбросить', err.message); }
};

// Карта
$('bindCard').onclick = async () => {
  const btn = $('bindCard'); btn.disabled = true;
  try {
    const r = await api('POST', '/api/cards');
    if (r.redirectUrl) { location.href = r.redirectUrl; return; }
    S = r.state; render();
    if (S.card?.status === 'active') toast('Карта привязана', '•••• ' + S.card.last4 + ' — теперь сдача с каждой оплаты идёт в копилку');
  } catch (e) { toast('Карта не привязана', e.message); }
  finally { btn.disabled = false; }
};
$('unbindCard').onclick = async () => {
  try { S = await api('DELETE', '/api/cards/' + S.card.id); render(); toast('Карта отвязана', 'Новые оплаты не будут округляться'); }
  catch (e) { toast('Не удалось отвязать', e.message); }
};

// Вход и регистрация
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $('authLoginTab').setAttribute('aria-selected', String(mode === 'login'));
  $('authRegTab').setAttribute('aria-selected', String(mode === 'register'));
  $('nameField').hidden = mode !== 'register';
  $('authPassword').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('authSubmit').textContent = mode === 'register' ? 'Создать аккаунт' : 'Войти';
  $('authError').textContent = '';
}
function showAuth(on) {
  $('auth').hidden = !on;
  document.querySelector('.tabs').hidden = on;
  if (on) { ['home', 'pay', 'set'].forEach((id) => $(id).hidden = true); $('authEmail').focus(); }
  else $('tab-home').click();
}
$('authLoginTab').onclick = () => setAuthMode('login');
$('authRegTab').onclick = () => setAuthMode('register');
$('authBack').onclick = () => showAuth(false);
$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('authSubmit'); btn.disabled = true; $('authError').textContent = '';
  try {
    const body = { email: $('authEmail').value, password: $('authPassword').value };
    if (authMode === 'register') body.name = $('authName').value;
    const r = await api('POST', '/api/auth/' + authMode, body);
    setToken(r.token);
    $('authPassword').value = '';
    await reload();
    showAuth(false);
    toast(authMode === 'register' ? 'Аккаунт создан' : 'С возвращением', authMode === 'register' ? 'Привяжите карту на вкладке «Оплатить»' : r.user.email);
  } catch (err) { $('authError').textContent = err.message; }
  finally { btn.disabled = false; }
};
$('accountBtn').onclick = () => S && !S.user.is_demo ? $('tab-set').click() : (setAuthMode('login'), showAuth(true));
$('accountAction').onclick = async () => {
  if (S.user.is_demo) { setAuthMode('register'); return showAuth(true); }
  await api('POST', '/api/auth/logout').catch(() => {});
  setToken(null);
  await reload();
  $('tab-home').click();
  toast('Вы вышли', 'Снова открыто демо');
};

// Вкладки
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  ['home', 'pay', 'set'].forEach((id) => $(id).hidden = id !== b.dataset.tab);
  window.scrollTo({ top: 0 });
});
const hash = location.hash.slice(1);
if (hash === 'pay' || hash === 'set') $('tab-' + hash).click();

async function reload() {
  prev = null;
  S = await api('GET', '/api/state');
  render();
}

try {
  const [cfg, t] = await Promise.all([
    api('GET', '/api/config').catch(() => CFG),
    api('GET', '/api/ticks').catch(() => ({ ticks: [] })),
  ]);
  CFG = cfg; ticks = t.ticks ?? [];
  await reload();
  // Вернулись со страницы платёжного провайдера после привязки карты
  const cardId = new URLSearchParams(location.search).get('card');
  if (cardId && !S.user.is_demo) {
    history.replaceState(null, '', location.pathname + location.hash);
    S = await api('POST', '/api/cards/' + encodeURIComponent(cardId) + '/refresh');
    render();
    toast(S.card?.status === 'active' ? 'Карта привязана' : 'Привязка не завершена',
      S.card?.status === 'active' ? '•••• ' + S.card.last4 : 'Статус: ' + ($('cardStatus').textContent || 'неизвестен'));
  }
}
catch (e) { toast('Сервер недоступен', e.message); }

// Курс и стоимость портфеля обновляются сами, пока вкладка открыта
const REFRESH_MS = 5_000;
async function refresh() {
  if (document.hidden || paying) return;
  try { S = await api('GET', '/api/state'); render(); } catch { /* следующая попытка через REFRESH_MS */ }
}
setInterval(refresh, REFRESH_MS);
document.addEventListener('visibilitychange', refresh);
