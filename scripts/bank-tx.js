#!/usr/bin/env node
// Имитация банка-партнёра: отправляет в KOPI подписанное уведомление об оплате картой.
//   BANK_WEBHOOK_SECRET=… node scripts/bank-tx.js --card <ref> --amount 6,40 [--merchant Кофе] [--url http://localhost:3000]
// ref карты виден в приложении: «Оплатить» → «Идентификатор карты для банка».
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { signBankWebhook } from '../server/app.js';
import { parseAmount } from '../server/engine.js';

const { values: a } = parseArgs({
  options: {
    card: { type: 'string' },
    amount: { type: 'string' },
    merchant: { type: 'string', default: 'Покупка' },
    url: { type: 'string', default: process.env.KOPI_URL ?? 'http://localhost:3000' },
    id: { type: 'string' },
  },
});
const secret = process.env.BANK_WEBHOOK_SECRET;
const amount = parseAmount(a.amount);
if (!secret || !a.card || !amount) {
  console.error('Использование: BANK_WEBHOOK_SECRET=… node scripts/bank-tx.js --card <ref> --amount 6,40 [--merchant Кофе] [--url …]');
  process.exit(1);
}

const tx = { id: a.id ?? 'sim-' + randomUUID(), type: 'purchase', card_ref: a.card, amount, currency: 'BYN',
  merchant: a.merchant, created_at: new Date().toISOString() };
const raw = JSON.stringify(tx);
const ts = Math.floor(Date.now() / 1000);
const res = await fetch(new URL('/api/webhooks/bank', a.url), {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-kopi-timestamp': String(ts), 'x-kopi-signature': signBankWebhook(secret, ts, raw) },
  body: raw,
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
