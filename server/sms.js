// Разбор SMS и push-уведомлений банка об оплате картой.
// Форматы у банков разные, поэтому разбор эвристический:
//   1. переводы, пополнения, возвраты, снятие наличных — не покупки, пропускаем;
//   2. нужна пометка покупки: «Оплата», «Покупка», «Oplata», «Pokupka», «Списание»…;
//   3. сумма — первая сумма с валютой после этой пометки, не считая остатка/доступного лимита;
//   4. магазин — первый фрагмент текста после суммы, похожий на название.
// Исходный текст не сохраняется: в нём бывают остаток на счёте и маска карты.

const SKIP = /(zachisl|зачисл|popoln|пополн|perevod|перевод|vozvrat|возврат|otmen|отмен|snyat|сняти|nalichn|наличн|cash|atm|банкомат|bankomat|refund|credit|поступлен|postuplen|отказ|otkaz|decline|недостаточно|nedostatochno)/i;
const PURCHASE = /(oplata|оплата|pokupka|покупка|spisanie|списание|payment|purchase|retail|покупк)/i;
const BALANCE = /(dostupno|доступно|ostatok|остаток|balance|баланс|limit|лимит|ost\.|ост\.)\s*:?\s*$/i;
const CUR = '(BYN|BYR|руб\\.?|бел\\.?\\s?руб\\.?|р\\.|USD|EUR|RUB)';
const NUM = '(\\d{1,3}(?:[ \\u00a0]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
const AMOUNT = new RegExp(`${NUM}\\s*${CUR}|${CUR}\\s*${NUM}`, 'gi');

const toKop = (s) => Math.round(parseFloat(s.replace(/[ \u00a0]/g, '').replace(',', '.')) * 100);
const currencyOf = (c) => /^(BYN|BYR|руб|бел|р\.)/i.test(c) ? 'BYN' : c.toUpperCase();

function findAmounts(text) {
  const out = [];
  for (const m of text.matchAll(AMOUNT)) {
    const before = text.slice(Math.max(0, m.index - 25), m.index);
    if (BALANCE.test(before)) continue;
    out.push({ index: m.index, end: m.index + m[0].length, kop: toKop(m[1] ?? m[4]), currency: currencyOf(m[2] ?? m[3]) });
  }
  return out;
}

// \b в JS не видит границ кириллических слов, поэтому границы задаются явно
const TAIL = /(dostupno|доступно|ostatok|остаток|balance|баланс|spravka|справка|lim(it)?\b|лимит)/i;
const LABEL = /^(magazin|магазин|shop|merchant|место|mesto|torgovec|торговец|tsp|тсп)\s*:?\s*/i;
function findMerchant(rest) {
  const cut = rest.split(TAIL)[0]
    .replace(/\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}/g, '|')   // даты
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '|');                // время
  const parts = cut.split(/[;\n|]|\.\s|,\s|\s{2,}/).map((p) => p.trim().replace(/^[.,:\-\s]+|[.,:\-\s]+$/g, ''));
  for (const raw of parts) {
    const p = raw.replace(LABEL, '');
    if (p.length < 2 || !/[a-zа-яё]/i.test(p)) continue;
    if (/^(karta|карта|card)(\s|$|\*|\d)/i.test(p) || /^(tel|тел)(\s|\.|:)/i.test(p)) continue;
    return p.replace(/\s+/g, ' ').slice(0, 40);
  }
  return null;
}

// -> { ok: true, amount, currency, merchant } | { ok: false, reason }
export function parseBankMessage(raw) {
  const text = String(raw ?? '').replace(/\u00a0/g, ' ').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (SKIP.test(text)) return { ok: false, reason: 'not a purchase' };
  const kw = PURCHASE.exec(text);
  if (!kw) return { ok: false, reason: 'not a purchase' };
  const amounts = findAmounts(text);
  const a = amounts.find((x) => x.index >= kw.index) ?? amounts[0];
  if (!a || !(a.kop > 0)) return { ok: false, reason: 'no amount' };
  const merchant = findMerchant(text.slice(a.end)) ?? findMerchant(text.slice(kw.index + kw[0].length, a.index)) ?? 'Покупка';
  return { ok: true, amount: a.kop, currency: a.currency, merchant };
}
