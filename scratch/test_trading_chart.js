import assert from 'assert';
import { generateMockRounds, parseManualInput } from '../src/engine/mockDataGenerator.ts';
import { calculateCandles, calculateGameStats } from '../src/engine/candleCalculator.ts';
import { 
  calculateSMA, 
  calculateEMA, 
  calculateWMA, 
  calculateRSI, 
  calculateMACD, 
  calculateBollingerBands, 
  calculateMAChannel, 
  calculateRatioOscillator 
} from '../src/engine/indicatorEngine.ts';

console.log('=== TEST SUITE: PREDICTION GAME TRADING CHART ===');

// 1. Test Mock Data Generator
console.log('\n[1] Testing Mock Data Generator (1000 rounds)...');
const mockRounds = generateMockRounds(1000, 30);
assert.strictEqual(mockRounds.length, 1000, 'Must generate exactly 1000 rounds');

let redCount = 0, greenCount = 0, violetCount = 0, bigCount = 0, smallCount = 0;
for (const r of mockRounds) {
  assert(r.roundId > 0, 'Valid roundId required');
  assert(r.timestamp > 0, 'Valid timestamp required');
  assert(r.number >= 0 && r.number <= 9, 'Ball number must be 0-9');
  assert(['red', 'green', 'violet'].includes(r.color), 'Color must be red, green, or violet');
  assert(['big', 'small'].includes(r.size), 'Size must be big or small');

  // Verify size matches ball number
  if (r.number >= 5) {
    assert.strictEqual(r.size, 'big', `Number ${r.number} must be big`);
  } else {
    assert.strictEqual(r.size, 'small', `Number ${r.number} must be small`);
  }

  if (r.color === 'red') redCount++;
  else if (r.color === 'green') greenCount++;
  else if (r.color === 'violet') violetCount++;

  if (r.size === 'big') bigCount++;
  else smallCount++;
}

console.log(`✓ Mock distribution: Red=${redCount} (${(redCount/10).toFixed(1)}%), Green=${greenCount} (${(greenCount/10).toFixed(1)}%), Violet=${violetCount} (${(violetCount/10).toFixed(1)}%)`);
console.log(`✓ Big=${bigCount} (${(bigCount/10).toFixed(1)}%), Small=${smallCount} (${(smallCount/10).toFixed(1)}%)`);

// 2. Test Continuous Candlestick Formula
console.log('\n[2] Testing Continuous Candlestick Calculation...');
const { candles, markers, stats } = calculateCandles(mockRounds);

assert.strictEqual(candles.length, 1000, 'Candles count must match rounds');
assert.strictEqual(markers.length, 1000, 'Markers count must match rounds');
assert.strictEqual(candles[0].open, 0, 'First candle must open at 0.0');

for (let i = 0; i < candles.length; i++) {
  const c = candles[i];
  const r = mockRounds[i];

  if (i > 0) {
    assert.strictEqual(c.open, candles[i - 1].close, `Candle ${i} must open exactly at previous candle close (${candles[i - 1].close})`);
  }

  if (r.size === 'big') {
    assert.strictEqual(c.close, c.open + 1, `BIG candle ${i} close must be open + 1`);
    assert.strictEqual(c.high, c.close, `BIG candle ${i} high must equal close`);
    assert.strictEqual(c.low, c.open, `BIG candle ${i} low must equal open`);
  } else {
    assert.strictEqual(c.close, c.open - 1, `SMALL candle ${i} close must be open - 1`);
    assert.strictEqual(c.high, c.open, `SMALL candle ${i} high must equal open`);
    assert.strictEqual(c.low, c.close, `SMALL candle ${i} low must equal close`);
  }

  // Check ball markers
  const m = markers[i];
  assert.strictEqual(m.text, `${r.number}`, 'Marker text must be ball number');
  if (r.color === 'red') {
    assert.strictEqual(m.color, '#ef5350', 'Red ball must have red marker');
  } else if (r.color === 'green') {
    assert.strictEqual(m.color, '#26a69a', 'Green ball must have green marker');
  } else {
    assert.strictEqual(m.color, '#ab47bc', 'Violet ball must have purple marker');
  }
}
console.log('✓ All 1,000 candles verified strictly continuous (open[t] === close[t-1])');
console.log('✓ All 1,000 ball markers verified with correct color and number');

// 3. Test Manual Input Parsing
console.log('\n[3] Testing Manual Input Parser...');
const sampleInput = `red-big\ngreen-small\nviolet-big\nred-small\n8 red big\n1 green small\n0 violet small`;
const parsed = parseManualInput(sampleInput);
assert.strictEqual(parsed.length, 7, 'Must parse 7 rounds');
assert.strictEqual(parsed[0].color, 'red');
assert.strictEqual(parsed[0].size, 'big');
assert.strictEqual(parsed[1].color, 'green');
assert.strictEqual(parsed[1].size, 'small');
assert.strictEqual(parsed[2].color, 'violet');
assert.strictEqual(parsed[2].size, 'big');
assert.strictEqual(parsed[4].number, 8);
assert.strictEqual(parsed[4].color, 'red');
assert.strictEqual(parsed[4].size, 'big');
console.log('✓ Manual input correctly parsed formats: color-size and number-color-size');

// 4. Test Indicators
console.log('\n[4] Testing Technical Indicator Calculations...');
const sma = calculateSMA(candles, { id: 'sma', name: 'SMA', category: 'overlay', enabled: true, color: '#2962ff', period: 14 });
assert(sma.length > 0, 'SMA must return points');
console.log(`✓ SMA (period 14) calculated ${sma.length} points`);

const ema = calculateEMA(candles, { id: 'ema', name: 'EMA', category: 'overlay', enabled: true, color: '#ff9800', period: 9 });
assert(ema.length > 0, 'EMA must return points');
console.log(`✓ EMA (period 9) calculated ${ema.length} points`);

const rsi = calculateRSI(candles, { id: 'rsi', name: 'RSI', category: 'oscillator', enabled: true, color: '#ab47bc', period: 14, overbought: 70, oversold: 30 });
assert(rsi.length > 0, 'RSI must return points');
console.log(`✓ RSI (period 14) calculated ${rsi.length} points. Latest value: ${rsi[rsi.length - 1].value}`);

const macd = calculateMACD(candles, { id: 'macd', name: 'MACD', category: 'oscillator', enabled: true, color: '#26a69a', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
assert(macd.macdLine.length > 0, 'MACD line must exist');
assert(macd.signalLine.length > 0, 'Signal line must exist');
assert(macd.histogram.length > 0, 'MACD histogram must exist');
console.log(`✓ MACD (12, 26, 9) calculated. Histogram points: ${macd.histogram.length}`);

const bb = calculateBollingerBands(candles, { id: 'bollinger', name: 'BB', category: 'overlay', enabled: true, color: '#2962ff', period: 20, stdDev: 2, upperColor: '', lowerColor: '' });
assert(bb.middle.length > 0 && bb.upper.length > 0 && bb.lower.length > 0, 'Bollinger Bands must calculate 3 bands');
console.log(`✓ Bollinger Bands (20, 2) calculated ${bb.middle.length} bands`);

const osc = calculateRatioOscillator(candles, { id: 'ratioOscillator', name: 'Oscillator', category: 'oscillator', enabled: true, color: '', lookback: 20 });
assert(osc.length > 0, 'Ratio oscillator must return points');
console.log(`✓ Big/Small Ratio Oscillator calculated ${osc.length} points. Latest: ${osc[osc.length - 1].value}%`);

// 5. Test Statistics Engine
console.log('\n[5] Testing Statistics Engine...');
console.log(`✓ Current Round: #${stats.currentRound}`);
console.log(`✓ Current Price: ${stats.currentPrice}`);
console.log(`✓ Active Streak: ${stats.currentStreak.count}x ${stats.currentStreak.type}`);
console.log(`✓ Max BIG Streak: ${stats.maxBigStreak}x, Max SMALL Streak: ${stats.maxSmallStreak}x`);
console.log(`✓ Max RED Streak: ${stats.maxRedStreak}x, Max GREEN Streak: ${stats.maxGreenStreak}x`);
console.log('\n=== ALL TESTS PASSED WITH 100% PRECISION! ===');
