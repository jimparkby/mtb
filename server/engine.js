// Round-up движок. Все суммы — в копейках (целые), курсы — BYN за 1 единицу актива.

export const ASSETS = {
  BTC: { name: 'Bitcoin', code: 'BTC', desc: 'Высокий риск, высокий потенциал' },
  ETH: { name: 'Ethereum', code: 'ETH', desc: 'Высокий риск, вторая крипта по капитализации' },
  SAFE: { name: 'Консервативный', code: 'BYN', desc: 'Спокойный рублёвый инструмент без скачков' },
};
export const STEPS = [100, 500, 1000];
export const MULTIPLIERS = [1, 2, 5];
export const THRESHOLDS = [1000, 2000, 5000];
export const MAX_PAYMENT = 10_000_000; // 100 000 BYN

// Округляет сумму покупки вверх до шага и считает сдачу с учётом множителя.
export function roundUp(amount, step, multiplier = 1) {
  if (!Number.isInteger(amount) || amount <= 0) throw new RangeError('amount must be a positive integer');
  if (!STEPS.includes(step)) throw new RangeError('unsupported step');
  if (!MULTIPLIERS.includes(multiplier)) throw new RangeError('unsupported multiplier');
  const rounded = Math.ceil(amount / step) * step;
  return { rounded, roundup: (rounded - amount) * multiplier };
}

// Сколько единиц актива получится на сумму в копейках по курсу.
export function quantity(amount, asset, rate) {
  if (asset === 'SAFE') return amount / 100;
  if (!(rate > 0)) throw new RangeError('rate must be positive');
  return amount / 100 / rate;
}

// Стоимость позиции в копейках по текущему курсу.
export function positionValue(asset, qty, cost, rate) {
  return asset === 'SAFE' ? cost : Math.round(qty * rate * 100);
}

export function shouldBuy(piggy, threshold) {
  return piggy > 0 && piggy >= threshold;
}

// Прогноз в месяцах до цели при заданном числе покупок в месяц.
export function forecastMonths(saved, target, avgRoundup, paymentsPerMonth = 60) {
  if (!(target > saved) || !(avgRoundup > 0)) return null;
  return Math.ceil((target - saved) / (avgRoundup * paymentsPerMonth));
}

// "6,40" / "6.4" / 6.4 -> 640 копеек; null, если сумма некорректна.
export function parseAmount(input) {
  const s = String(input ?? '').replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const k = Math.round(parseFloat(s) * 100);
  return k > 0 && k <= MAX_PAYMENT ? k : null;
}
