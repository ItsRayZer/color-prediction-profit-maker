import test from 'node:test';
import assert from 'node:assert/strict';
import { BOT_EVENTS, botLine, eventLines, answerQuestion, PredictBot } from '../systems/predictBot.js';

const CTX = {
  userName: 'Ray',
  balance: 1500,
  balanceSource: 'dhaniwin',
  balanceSourceLabel: 'DhaniWin (live bridge)',
  baseBet: 15,
  ladderLevel: 1,
  ladderLevels: 5,
  nextStake: 30,
  sessionPnL: 45,
  startingBalance: 1500,
  inchargeModel: { name: 'Quantum Bloch Sphere' },
  inchargeReason: 'Base Champion on a Wilson score of 55.4% over 1000 rounds',
  gateDecision: { decision: 'BET', reason: 'Calibrated chance clears the bar', pick: 'GREEN' },
  pick: 'GREEN',
  calibratedConfidence: 0.58,
  isCalibrated: true,
  streak: 2,
  lastResult: 'GREEN 7 BIG',
  circuitBreakerState: 'ARMED'
};

const SKIP_CTX = {
  ...CTX,
  gateDecision: { decision: 'SKIP', reason: 'Edge too thin: calibrated chance 52.0% is below the 53.02% needed.', pick: null },
  gateReason: 'Edge too thin: calibrated chance 52.0% is below the 53.02% needed.',
  pick: null
};

const ALL_EVENTS = Object.values(BOT_EVENTS).filter((v, i, a) => a.indexOf(v) === i);

test('PredictBot: every event returns a non-empty, context-correct line', async (t) => {
  for (const ev of ALL_EVENTS) {
    await t.test(`event ${ev}`, () => {
      const { line, tone } = botLine(ev, CTX);
      assert.ok(typeof line === 'string' && line.trim().length > 20, `line for ${ev} must be substantive`);
      assert.ok(['playful', 'neutral', 'serious'].includes(tone));
    });
  }

  await t.test('eventLines covers a batch in order', () => {
    const lines = eventLines([BOT_EVENTS.GREETING, BOT_EVENTS.WIN], CTX);
    assert.equal(lines.length, 2);
    assert.ok(lines.every(l => l.line.length > 20));
  });

  await t.test('greeting uses the real balance and the leading model', () => {
    const { line } = botLine(BOT_EVENTS.GREETING, CTX);
    assert.match(line, /1,500/);
    assert.match(line, /Quantum Bloch Sphere/);
  });

  await t.test('balance events use the detected balance; low balance warns honestly', () => {
    assert.match(botLine(BOT_EVENTS.BALANCE_DETECTED, CTX).line, /1,500/);
    const low = botLine(BOT_EVENTS.BALANCE_LOW, { ...CTX, balance: 10 });
    assert.match(low.line, /too low for a safe ladder/);
    assert.equal(low.tone, 'serious');
    const none = botLine(BOT_EVENTS.BALANCE_NOT_DETECTED, { balance: null, balanceSource: 'none' });
    assert.match(none.line, /Balance not detected — open the DhaniWin tab or enter it manually/);
  });

  await t.test('model change names the new Incharge and why', () => {
    const { line } = botLine(BOT_EVENTS.MODEL_CHANGE, CTX);
    assert.match(line, /Quantum Bloch Sphere/);
    assert.match(line, /Wilson/);
  });
});

test('PredictBot: SKIP is explained, never silent', async (t) => {
  await t.test('skip line includes the gate reason verbatim', () => {
    const { line } = botLine(BOT_EVENTS.SIGNAL_SKIP, SKIP_CTX);
    assert.ok(line.includes(SKIP_CTX.gateReason), 'skip line must carry the gate reason');
    assert.match(line, /deliberate decision/);
  });

  await t.test('"why skip" answer includes the gate reason', () => {
    const { line } = answerQuestion('Why did you skip that round?', SKIP_CTX);
    assert.ok(line.includes(SKIP_CTX.gateReason));
  });
});

test('PredictBot: tone rules — serious on money problems, light on wins', async (t) => {
  for (const ev of [BOT_EVENTS.LOSS, BOT_EVENTS.CIRCUIT_BREAKER, BOT_EVENTS.STOP_LOSS, BOT_EVENTS.STOP_WIN, BOT_EVENTS.BALANCE_LOW]) {
    await t.test(`${ev} is serious`, () => {
      assert.equal(botLine(ev, CTX).tone, 'serious');
    });
  }
  await t.test('win and greeting are playful', () => {
    assert.equal(botLine(BOT_EVENTS.WIN, CTX).tone, 'playful');
    assert.equal(botLine(BOT_EVENTS.GREETING, CTX).tone, 'playful');
  });
  await t.test('loss line is supportive and anti-chasing', () => {
    const { line } = botLine(BOT_EVENTS.LOSS, CTX);
    assert.match(line, /No chasing/);
  });
  await t.test('breaker and stop lines state the protection plainly', () => {
    assert.match(botLine(BOT_EVENTS.CIRCUIT_BREAKER, CTX).line, /3 losses in a row/);
    assert.match(botLine(BOT_EVENTS.STOP_LOSS, CTX).line, /stop-loss/);
    assert.match(botLine(BOT_EVENTS.STOP_WIN, CTX).line, /banked/);
  });
  await t.test('ladder-up explains the double and the cap', () => {
    const { line } = botLine(BOT_EVENTS.LADDER_UP, CTX);
    assert.match(line, /double/);
    assert.match(line, /₹30/);
  });
});

test('PredictBot: answers come from context, for every question type', async (t) => {
  await t.test('how was this prediction made', () => {
    const { line } = answerQuestion('How was this prediction made?', CTX);
    assert.match(line, /Wilson/);
    assert.match(line, /calibration/);
  });
  await t.test('base bet / ladder risk answer uses real numbers', () => {
    const { line } = answerQuestion('What is my base bet and ladder risk?', CTX);
    assert.match(line, /₹15/);
    assert.match(line, /51\.02%/);
    assert.match(line, /reserve/);
  });
  await t.test('leading model answer names the model', () => {
    const { line } = answerQuestion('Which model is leading and why?', CTX);
    assert.match(line, /Quantum Bloch Sphere/);
    assert.match(line, /200/);
  });
  await t.test('money status answer reports balance, P&L and stops', () => {
    const { line } = answerQuestion('Money status', CTX);
    assert.match(line, /1,500/);
    assert.match(line, /stop-win|\+20%|20%/);
  });
  await t.test('unknown questions still get a real status answer, never silence', () => {
    const { line } = answerQuestion('What is the weather on Mars?', CTX);
    assert.ok(line.length > 40);
    assert.match(line, /1,500|Quantum Bloch Sphere/);
  });
  await t.test('class API works', () => {
    const bot = new PredictBot();
    assert.ok(bot.speak(BOT_EVENTS.WIN, CTX).line.length > 20);
    assert.ok(bot.ask('Money status', CTX).line.length > 20);
  });
});

test('PredictBot: honesty — no promised outcomes in any line', async (t) => {
  const outputs = [];
  for (const ev of ALL_EVENTS) outputs.push(botLine(ev, CTX).line, botLine(ev, SKIP_CTX).line);
  for (const q of ['Why this signal?', 'Money status', 'Leading model', 'How was this prediction made?', 'What are the rules?', 'How sure are you?']) {
    outputs.push(answerQuestion(q, CTX).line);
  }
  for (const line of outputs) {
    assert.ok(!/guarantee/i.test(line), `line must not promise outcomes: ${line}`);
    assert.ok(!/guaranteed profit/i.test(line));
    assert.ok(!/100% sure|can't lose|risk-free|risk free/i.test(line), `line overpromises: ${line}`);
  }
});
