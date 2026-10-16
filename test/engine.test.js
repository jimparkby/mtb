import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundUp, quantity, parseAmount, forecastMonths, shouldBuy } from '../server/engine.js';

test('roundUp rounds up to the step and applies the multiplier', () => {
  assert.deepEqual(roundUp(640, 100), { rounded: 700, roundup: 60 });
  assert.deepEqual(roundUp(640, 500), { rounded: 1000, roundup: 360 });
  assert.deepEqual(roundUp(640, 100, 5), { rounded: 700, roundup: 300 });
  assert.deepEqual(roundUp(700, 100), { rounded: 700, roundup: 0 });
});

test('roundUp rejects bad input', () => {
  assert.throws(() => roundUp(0, 100), RangeError);
  assert.throws(() => roundUp(6.4, 100), RangeError);
  assert.throws(() => roundUp(640, 300), RangeError);
  assert.throws(() => roundUp(640, 100, 3), RangeError);
});

test('quantity converts kopecks at the given rate', () => {
  assert.equal(quantity(2000, 'BTC', 200000), 0.0001);
  assert.equal(quantity(2000, 'SAFE'), 20);
  assert.throws(() => quantity(2000, 'ETH', 0), RangeError);
});

test('parseAmount accepts comma and dot decimals', () => {
  assert.equal(parseAmount('6,40'), 640);
  assert.equal(parseAmount('6.4'), 640);
  assert.equal(parseAmount(' 1 280 '), 128000);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount('0'), null);
  assert.equal(parseAmount('1.999'), null);
});

test('shouldBuy and forecastMonths', () => {
  assert.equal(shouldBuy(1999, 2000), false);
  assert.equal(shouldBuy(2000, 2000), true);
  assert.equal(forecastMonths(0, 6000, 50, 60), 2);
  assert.equal(forecastMonths(7000, 6000, 50), null);
  assert.equal(forecastMonths(0, 6000, 0), null);
});
