import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBankMessage } from '../server/sms.js';

// Типичные форматы уведомлений белорусских банков (номера и суммы вымышлены)
const PURCHASES = [
  ['Priorbank. Karta 4***1234. 18-10-2026 12:34:56. Oplata 6.40 BYN. BLR KOFEINYA ZERNO. Dostupno: 123.45 BYN. Spravka: 80172899292', 640, 'BLR KOFEINYA ZERNO'],
  ['Karta5***1234; Oplata: 12,80 BYN; 18.10.26 12:34; YANDEX GO; MINSK; Dostupno: 1 234,56 BYN', 1280, 'YANDEX GO'],
  ['Карта 1234: Покупка 47.30 BYN, ЕВРООПТ, Минск. Остаток 523.10 BYN', 4730, 'ЕВРООПТ'],
  ['Karta *1234 Pokupka 9.90 BYN SHAURMA NA RAYONE 18.10.2026 12:34 Dostupno 88.00 BYN', 990, 'SHAURMA NA RAYONE'],
  ['Оплата BYN 14,75 BURGER KING. Доступно BYN 100,00', 1475, 'BURGER KING'],
  ['Списание 1 089,15 руб. Карта ***1234. Магазин: 21VEK.BY. Остаток: 10,00 руб.', 108915, '21VEK.BY'],
];

for (const [text, amount, merchant] of PURCHASES) {
  test(`parses purchase: ${text.slice(0, 40)}…`, () => {
    const r = parseBankMessage(text);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.amount, amount);
    assert.equal(r.currency, 'BYN');
    if (merchant) assert.equal(r.merchant, merchant);
    assert.ok(r.merchant && !/dostupno|остаток|доступно/i.test(r.merchant), r.merchant);
  });
}

test('skips transfers, top-ups, refunds, cash and declines', () => {
  for (const t of [
    'Karta 4***1234. Zachislenie 500.00 BYN. Dostupno 623.45 BYN',
    'Пополнение карты 1234 на 50,00 BYN',
    'Перевод 20.00 BYN на карту 5***9876',
    'Vozvrat 6.40 BYN KOFEINYA',
    'Karta 1234 Snyatie nalichnyh 100.00 BYN ATM BELARUSBANK',
    'Oplata 6.40 BYN KOFEINYA otkaz: nedostatochno sredstv',
    'Ваш код подтверждения 1234',
  ]) assert.equal(parseBankMessage(t).ok, false, t);
});

test('reports foreign currency so it can be ignored', () => {
  const r = parseBankMessage('Oplata 12.99 USD NETFLIX.COM Dostupno 100.00 BYN');
  assert.equal(r.ok, true);
  assert.equal(r.currency, 'USD');
  assert.equal(r.amount, 1299);
});
