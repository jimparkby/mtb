// Проведение пакетной покупки: списать сдачу с карты → купить актив у брокера.
// Статусы: pending → charged → filled; при отказе в списании — failed (сдача
// возвращается в копилку). Если брокер не ответил после списания, покупка остаётся
// charged и повторяется при сверке; pending без ответа провайдера дольше
// STUCK_MS уходит в review — деньги могли списаться, нужен человек.
const STUCK_MS = 10 * 60_000;

export function createPurchaser({ store, rates, payments, broker, now = () => Date.now() }) {
  async function charge(purchase, user) {
    if (user.is_demo) return store.markPurchase(purchase.id, { status: 'charged', charge_ref: 'demo' });
    if (!payments) return store.failPurchase(purchase.id, 'Платёжный провайдер не подключён');
    const card = await store.activeCard(user.id);
    if (!card) return store.failPurchase(purchase.id, 'Карта не привязана');
    let r;
    try {
      r = await payments.charge({ cardToken: card.card_token, amount: purchase.amount,
        trackingId: `kopi-purchase-${purchase.id}`, description: 'KOPI: сдача на покупку ' + purchase.asset });
    } catch (err) {
      // Ответа нет — неизвестно, списались ли деньги. Оставляем pending, сверка разберётся.
      console.error('[purchaser] charge error', purchase.id, err.message);
      return store.markPurchase(purchase.id, { error: 'Нет ответа от платёжного провайдера' });
    }
    if (r.status !== 'successful') return store.failPurchase(purchase.id, r.message || 'Списание отклонено');
    return store.markPurchase(purchase.id, { status: 'charged', charge_ref: r.ref, error: null });
  }

  async function fill(purchase, user) {
    try {
      const o = await broker.buy({ asset: purchase.asset, amount: purchase.amount, rates: await rates.current(), demo: !!user.is_demo });
      return await store.markPurchase(purchase.id, { status: 'filled', rate: o.rate, qty: o.qty, order_ref: o.ref, rate_source: o.source, error: null });
    } catch (err) {
      console.error('[purchaser] broker error', purchase.id, err.message);
      return store.markPurchase(purchase.id, { error: err.message });
    }
  }

  // Одна покупка не обрабатывается дважды одновременно (вебхук и сверка),
  // иначе можно списать или купить дважды. Рассчитано на один экземпляр сервера.
  const busy = new Set();
  async function exclusive(id, fn) {
    if (busy.has(id)) return store.getPurchase(id);
    busy.add(id);
    try { return await fn(); } finally { busy.delete(id); }
  }

  function process(purchase) {
    return exclusive(purchase.id, async () => {
      const user = await store.getUser(purchase.user_id);
      let p = await store.getPurchase(purchase.id);
      if (p.status === 'pending') p = await charge(p, user);
      if (p.status === 'charged') p = await fill(p, user);
      return p;
    });
  }

  // Сверка: докупить то, что списано, и отправить на ручную проверку зависшее
  async function reconcile() {
    for (const p of await store.purchasesByStatus(['pending', 'charged'])) {
      if (busy.has(p.id)) continue;
      if (p.status === 'charged') { await exclusive(p.id, async () => fill(p, await store.getUser(p.user_id))); continue; }
      if (now() - Date.parse(p.updated_at ?? p.created_at) > STUCK_MS) {
        await store.markPurchase(p.id, { status: 'review', error: p.error ?? 'Нет ответа от платёжного провайдера' });
      }
    }
  }

  return { process, reconcile };
}
