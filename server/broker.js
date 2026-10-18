// Брокер — тот, кто покупает актив на собранную сдачу.
// Интерфейс: name, buy({ asset, amount, rates, demo }) -> { rate, qty, ref, source }
//
// Пока договора с криптоплатформой-резидентом ПВТ нет, работает «бумажный» брокер:
// покупка записывается по реальному текущему курсу площадки, но ордер никуда не уходит.
// Адаптер настоящей площадки (Dzengi, Bynex, Whitebird) реализует тот же buy()
// и подключается в brokerFromEnv по ключам API от партнёра.
import { randomUUID } from 'node:crypto';
import { quantity } from './engine.js';

export function createPaperBroker() {
  return {
    name: 'paper',
    async buy({ asset, amount, rates, demo = false }) {
      // Настоящие деньги не покупаем по устаревшей оценке; демо — можно
      if (!demo && asset !== 'SAFE' && rates.source !== 'live') {
        throw new Error('Нет актуального курса — покупка будет повторена');
      }
      const rate = rates[asset];
      return { rate, qty: quantity(amount, asset, rate), ref: 'paper-' + randomUUID(), source: rates.exchange ?? rates.source };
    },
  };
}

export function brokerFromEnv() {
  return createPaperBroker();
}
