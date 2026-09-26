import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createSimBotEnvironment(htmlFileName = 'index.html') {
  const htmlPath = path.join(__dirname, '..', htmlFileName);
  const html = fs.readFileSync(htmlPath, 'utf8');

  const start = html.indexOf('const SimBot = (() => {');
  const end = html.indexOf('// ── Buttons wired from HTML', start);
  const simBotCode = html.slice(start, end);

  const domElements = {};
  const mockDocument = {
    getElementById(id) {
      if (!domElements[id]) {
        domElements[id] = {
          id,
          value: '',
          textContent: '',
          className: '',
          innerHTML: '',
          classList: {
            toggle: () => {},
            add: () => {},
            remove: () => {}
          },
          firstChild: null,
          insertBefore: () => {},
          appendChild: () => {},
          remove: () => {}
        };
      }
      return domElements[id];
    },
    createElement(tag) {
      return {
        id: '',
        style: {},
        className: '',
        innerHTML: '',
        appendChild: () => {},
        parentNode: null
      };
    }
  };

  mockDocument.getElementById('simCfgBalance').value = '1000';
  mockDocument.getElementById('simCfgBaseBet').value = '10';
  mockDocument.getElementById('simCfgStopProfit').value = '500';
  mockDocument.getElementById('simCfgStopLoss').value = '300';
  mockDocument.getElementById('simCfgMaxBets').value = '100';

  const mockWindow = {
    S: {
      timeframe: '30s',
      currentPeriod: '20260926001',
      secondsLeft: 20,
      myBets: [],
      myBetsByTimeframe: { '30s': [], '1m': [], '3m': [], '5m': [] },
      aiPredictionMap: { '20260926001': { target: 'BIG' } }
    },
    TimeframeManager: {
      getPredictionForPeriod: (tf, period) => ({ target: 'BIG' })
    }
  };

  const fn = new Function('document', 'window', 'S', 'setInterval', simBotCode + '; return SimBot;');
  const SimBot = fn(mockDocument, mockWindow, mockWindow.S, () => {});
  return { SimBot, mockWindow, mockDocument };
}

test('Simulation Test Bot - Stake Deduction from Balance', async (t) => {
  await t.test('Stake is immediately deducted from balance when bet is placed in active round', () => {
    const { SimBot, mockWindow, mockDocument } = createSimBotEnvironment();

    mockWindow.S.currentPeriod = '20260926001';
    mockWindow.S.secondsLeft = 20;

    SimBot.start();

    const balDisplay = mockDocument.getElementById('simDisplayBalance').textContent;
    assert.equal(balDisplay, '₹990.00', 'UI balance must show ₹990.00 immediately after ₹10 bet is placed');

    assert.equal(mockWindow.S.myBets.length, 1);
    assert.equal(mockWindow.S.myBets[0].status, 'PENDING');
    assert.equal(mockWindow.S.myBets[0].stake, 10);
    assert.equal(mockWindow.S.myBets[0].choice, 'BIG');
  });

  await t.test('On round settlement WIN, stake and payout profit are credited back', () => {
    const { SimBot, mockWindow, mockDocument } = createSimBotEnvironment();

    mockWindow.S.currentPeriod = '20260926001';
    mockWindow.S.secondsLeft = 20;

    SimBot.start();
    assert.equal(mockDocument.getElementById('simDisplayBalance').textContent, '₹990.00');

    // Result arrives: 7 (BIG) -> WIN
    SimBot.processResult(7, '20260926001', '30s');

    const balDisplay = mockDocument.getElementById('simDisplayBalance').textContent;
    // 990 + (10 * 1.96) = 1009.60
    assert.equal(balDisplay, '₹1009.60', 'UI balance must show ₹1009.60 after winning round');

    const bet = mockWindow.S.myBets.find(b => b.period === '20260926001');
    assert.equal(bet.status, 'WON');
    assert.equal(bet.profit, 9.60);
  });

  await t.test('On round settlement LOSS, balance is NOT double-deducted, and Martingale stake doubles', () => {
    const { SimBot, mockWindow, mockDocument } = createSimBotEnvironment();

    mockWindow.S.currentPeriod = '20260926001';
    mockWindow.S.secondsLeft = 20;

    SimBot.start();
    assert.equal(mockDocument.getElementById('simDisplayBalance').textContent, '₹990.00');

    // Result arrives: 2 (SMALL) -> LOSS
    SimBot.processResult(2, '20260926001', '30s');

    // Balance should remain ₹990.00 (stake was already deducted when placed)
    const balDisplay = mockDocument.getElementById('simDisplayBalance').textContent;
    assert.equal(balDisplay, '₹990.00', 'Balance should stay ₹990.00 after loss (not deducted twice)');

    const bet = mockWindow.S.myBets.find(b => b.period === '20260926001');
    assert.equal(bet.status, 'LOST');
    assert.equal(bet.profit, -10);

    // New round begins: Period 002
    mockWindow.S.currentPeriod = '20260926002';
    mockWindow.S.secondsLeft = 25;
    SimBot.tick();

    // Martingale bet is 20: balance drops from 990 to 970 immediately
    const nextBalDisplay = mockDocument.getElementById('simDisplayBalance').textContent;
    assert.equal(nextBalDisplay, '₹970.00', 'Balance should immediately drop by Martingale stake ₹20 to ₹970.00');

    const bet2 = mockWindow.S.myBets.find(b => b.period === '20260926002');
    assert.equal(bet2.stake, 20);
    assert.equal(bet2.status, 'PENDING');
  });

  await t.test('Stopping SimBot refunds unsettled pending bet to balance', () => {
    const { SimBot, mockWindow, mockDocument } = createSimBotEnvironment();

    mockWindow.S.currentPeriod = '20260926001';
    mockWindow.S.secondsLeft = 20;

    SimBot.start();
    assert.equal(mockDocument.getElementById('simDisplayBalance').textContent, '₹990.00');

    SimBot.stop();
    // 10 refunded back
    assert.equal(mockDocument.getElementById('simDisplayBalance').textContent, '₹1000.00');
  });

  await t.test('terminal.html SimBot behaves identically', () => {
    const { SimBot, mockWindow, mockDocument } = createSimBotEnvironment('terminal.html');

    mockWindow.S.currentPeriod = '20260926001';
    mockWindow.S.secondsLeft = 20;

    SimBot.start();
    assert.equal(mockDocument.getElementById('simDisplayBalance').textContent, '₹990.00');

    SimBot.processResult(7, '20260926001', '30s');
    assert.equal(mockDocument.getElementById('simDisplayBalance').textContent, '₹1009.60');
  });
});
