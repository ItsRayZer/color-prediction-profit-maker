import fs from 'node:fs';
import '../algorithms/quant_algorithm.js';
import '../systems/timeframe_manager.js';

const csvPath = process.argv[2] || 'wingo_30s_history.csv';
const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
const history = lines.slice(1).filter(Boolean).map((line) => {
  const [period, number, size] = line.split(',');
  return { period, number: Number(number), size };
});

if (history.length < 100) {
  console.log(`INSUFFICIENT_HISTORY: ${history.length} rounds; need at least 100 before comparing strategies.`);
}

const tf = 'verification';
globalThis.TimeframeManager.setHistory(tf, history);
const observed = globalThis.TimeframeManager.getStats(tf);

let correct = 0;
let maxLossStreak = 0;
let lossStreak = 0;
for (let index = 2; index < history.length; index += 1) {
  const prediction = globalThis.QuantAlgorithm.predictNextBet({
    history: history.slice(0, index),
    balance: 1000,
    lossStreak: 0,
    timeframe: tf,
  });
  const won = prediction.type === 'COLOR'
    ? (prediction.target === 'GREEN'
      ? [1, 3, 5, 7, 9].includes(history[index].number)
      : ![1, 3, 5, 7, 9].includes(history[index].number))
    : prediction.target === history[index].size;
  if (won) {
    correct += 1;
    lossStreak = 0;
  } else {
    lossStreak += 1;
    maxLossStreak = Math.max(maxLossStreak, lossStreak);
  }
}

const expected = {
  totalSettled: Math.max(0, history.length - 2),
  correctCount: correct,
  wrongCount: Math.max(0, history.length - 2) - correct,
  maxLossStreak,
};

console.log(JSON.stringify({ expected, observed }, null, 2));
if (Object.entries(expected).some(([key, value]) => observed[key] !== value)) {
  throw new Error('AUDIT_MISMATCH: displayed audit differs from production prediction replay.');
}
console.log('PASS: audit replay matches the production predictor without look-ahead.');
