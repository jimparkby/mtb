// Платёжный провайдер: привязка карты (токенизация) и списание сдачи по токену.
// Номер карты к нам не попадает: пользователь вводит его на странице провайдера,
// мы храним только токен, последние 4 цифры и тип карты.
//
// Интерфейс провайдера:
//   name, test
//   startBinding({ ref, returnUrl, notificationUrl }) -> { checkoutToken, redirectUrl, card? }
//       card — если провайдер привязал карту сразу (тестовый провайдер)
//   bindingStatus(checkoutToken) -> { status: 'pending'|'active'|'failed', cardToken, last4, brand, error }
//   charge({ cardToken, amount, trackingId, description }) -> { status: 'successful'|'failed', ref, message }
//   verifyNotification(headers) -> boolean
import { randomUUID, timingSafeEqual } from 'node:crypto';

const TIMEOUT_MS = 15_000;

// bePaid (bepaid.by). Ключи — в настройках магазина в личном кабинете bePaid.
// Форматы запросов взяты из документации docs.bepaid.by; ответы разбираются
// с запасом, потому что поля токенизации в документации описаны неполно.
export function createBepaid({ shopId, secretKey, test = true, fetchImpl = fetch }) {
  const auth = 'Basic ' + Buffer.from(`${shopId}:${secretKey}`).toString('base64');
  async function call(method, url, body) {
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json', 'x-api-version': '2' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 422) throw new Error(`bePaid ${method} ${url} -> HTTP ${res.status}: ${data.message ?? ''}`);
    return data;
  }

  // Ищет в ответе объект карты с токеном — он лежит в разных местах в зависимости от типа операции
  function findCard(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    if (obj.token && (obj.last_4 || obj.last4)) return obj;
    for (const v of Object.values(obj)) {
      const c = findCard(v, depth + 1);
      if (c) return c;
    }
    return null;
  }

  return {
    name: 'bepaid',
    test,

    async startBinding({ ref, returnUrl, notificationUrl }) {
      const r = await call('POST', 'https://checkout.bepaid.by/ctp/api/checkouts', {
        checkout: {
          test,
          transaction_type: 'tokenization',
          attempts: 3,
          settings: { return_url: returnUrl, notification_url: notificationUrl, language: 'ru' },
          payment_method: { types: ['credit_card'] },
          // Токенизация не списывает деньги, сумма нужна только для проверки карты
          order: { amount: 100, currency: 'BYN', description: 'Привязка карты KOPI', tracking_id: ref,
            additional_data: { contract: ['recurring'] } },
        },
      });
      if (!r.checkout?.token) throw new Error('bePaid: ' + (r.message || 'не удалось создать привязку карты'));
      return { checkoutToken: r.checkout.token, redirectUrl: r.checkout.redirect_url };
    },

    async bindingStatus(checkoutToken) {
      const r = await call('GET', `https://checkout.bepaid.by/ctp/api/checkouts/${encodeURIComponent(checkoutToken)}`);
      const c = r.checkout ?? {};
      const card = findCard(c);
      if (c.status === 'successful' && card) {
        return { status: 'active', cardToken: card.token, last4: String(card.last_4 ?? card.last4), brand: card.brand ?? null };
      }
      if (c.finished || c.expired || ['failed', 'declined', 'expired', 'error'].includes(c.status)) {
        return { status: 'failed', error: c.message || 'Карта не привязана' };
      }
      return { status: 'pending' };
    },

    async charge({ cardToken, amount, trackingId, description }) {
      const r = await call('POST', 'https://gateway.bepaid.by/services/credit_cards/charges', {
        request: { amount, currency: 'BYN', description, tracking_id: trackingId, test,
          credit_card: { token: cardToken }, additional_data: { contract: ['recurring'] } },
      });
      const t = r.transaction ?? r;
      if (t.status === 'successful') return { status: 'successful', ref: t.uid, message: t.message };
      // incomplete = банк требует 3-D Secure; для фоновых списаний это отказ, сдача вернётся в копилку
      return { status: 'failed', ref: t.uid ?? null, message: t.status === 'incomplete'
        ? 'Банк требует подтверждения 3-D Secure' : (t.message || r.message || 'Списание отклонено') };
    },

    // bePaid подписывает уведомления Basic-авторизацией с Shop ID и Secret key
    verifyNotification(headers) {
      const got = Buffer.from(String(headers.authorization ?? ''));
      const want = Buffer.from(auth);
      return got.length === want.length && timingSafeEqual(got, want);
    },
  };
}

// Тестовый провайдер для разработки и показа без договора с эквайером:
// карта «привязывается» сразу, списания всегда проходят. Включается явно: PAYMENTS_PROVIDER=sandbox.
export function createSandbox() {
  return {
    name: 'sandbox',
    test: true,
    async startBinding() {
      return { checkoutToken: 'sandbox-' + randomUUID(), redirectUrl: null,
        card: { status: 'active', cardToken: 'sandbox-' + randomUUID(), last4: '4242', brand: 'visa' } };
    },
    async bindingStatus() { return { status: 'pending' }; },
    async charge() { return { status: 'successful', ref: 'sandbox-' + randomUUID() }; },
    verifyNotification() { return false; },
  };
}

// Провайдер по переменным окружения; null — привязка карт выключена
export function paymentsFromEnv(env = process.env) {
  if (env.BEPAID_SHOP_ID && env.BEPAID_SECRET_KEY) {
    return createBepaid({ shopId: env.BEPAID_SHOP_ID, secretKey: env.BEPAID_SECRET_KEY, test: env.BEPAID_TEST !== 'false' });
  }
  if (env.PAYMENTS_PROVIDER === 'sandbox') return createSandbox();
  return null;
}
