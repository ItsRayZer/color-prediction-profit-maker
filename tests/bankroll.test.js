import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STAKING_MODES, suggestBaseBet, ladderLevels, ladderTable, ladderCumulativeCost,
  riskBudget, planLadder, createSession, settle, settleBet, BREAKEVEN_WIN_RATE,
  BALANCE_NOT_DETECTED_MESSAGE
} from '../systems/bankroll.js';

test('Bankroll: base bet suggestions reuse the mobile.js staking fractions', async (t) => {
  await t.test('fractions: safe .5%, balanced 1% (default), growth 2.5%, aggressive 5%', () => {
    assert.equal(STAKING_MODES.safe.baseFraction, 0.005);
    assert.equal(STAKING_MODES.balanced.baseFraction, 0.01);
    assert.equal(STAKING_MODES.growth.baseFraction, 0.025);
    assert.equal(STAKING_MODES.aggressive.baseFraction, 0.05);
    assert.equal(suggestBaseBet(1000, 'safe'), 5);
    assert.equal(suggestBaseBet(1000, 'balanced'), 10);
    assert.equal(suggestBaseBet(1000), 10); // balanced is the default
    assert.equal(suggestBaseBet(1000, 'growth'), 25);
    assert.equal(suggestBaseBet(1000, 'aggressive'), 50);
  });

  await t.test('rounds down to whole rupees, minimum ₹1, zero balance gives 0', () => {
    assert.equal(suggestBaseBet(199, 'balanced'), 1); // floor(1.99) = 1
    assert.equal(suggestBaseBet(50, 'safe'), 1); // floor(0.25) -> min 1
    assert.equal(suggestBaseBet(0, 'balanced'), 0);
    assert.equal(suggestBaseBet(-100), 0);
    assert.ok(Math.abs(BREAKEVEN_WIN_RATE - 0.5102) < 0.001);
    assert.match(BALANCE_NOT_DETECTED_MESSAGE, /Balance not detected/);
  });
});

test('Bankroll: ladder fitting and reserve protection', async (t) => {
  await t.test('cumulative cost follows base * (2^n - 1)', () => {
    assert.equal(ladderCumulativeCost(10, 1), 10);
    assert.equal(ladderCumulativeCost(10, 3), 70);
    assert.equal(ladderCumulativeCost(10, 4), 150);
  });

  await t.test('ladderLevels stays inside the 50% risk budget and protects the 30% reserve', () => {
    const balance = 1000;
    const base = 10;
    const levels = ladderLevels(balance, base);
    assert.ok(ladderCumulativeCost(base, levels) <= riskBudget(balance));
    assert.ok(ladderCumulativeCost(base, levels + 1) > riskBudget(balance));
    // After a full ladder loss, at least the 30% reserve is still there.
    assert.ok(balance - ladderCumulativeCost(base, levels) >= balance * 0.3);
  });

  await t.test('plan lowers the base so a minimum 3-level ladder fits', () => {
    // Aggressive suggestion on ₹300 is ₹15; 3 levels would cost ₹105 > 50% budget ₹150? 105 <= 150 fits.
    // Use a tighter case: ₹100 aggressive -> base ₹5, 3 levels ₹35 <= ₹50 fits already.
    // Tightest: balance ₹20 -> suggested balanced base ₹1 (min), 3 levels ₹7 <= ₹10 fits.
    const plan = planLadder(20, { mode: 'balanced' });
    assert.equal(plan.state, 'OK');
    assert.ok(plan.levels >= 3);
    // Forced oversized base gets lowered:
    const forced = planLadder(100, { baseBet: 40 });
    assert.equal(forced.state, 'OK');
    assert.ok(forced.baseBet < 40);
    assert.ok(forced.levels >= 3);
    assert.ok(forced.cumulativeRisk <= riskBudget(100));
  });

  await t.test('STOP when even a ₹1 base cannot fit a safe ladder', () => {
    // ₹10 balance: budget ₹5, a 3-level ₹1 ladder costs ₹7 -> STOP.
    const plan = planLadder(10, { mode: 'balanced' });
    assert.equal(plan.state, 'STOP');
    assert.match(plan.reason, /too low for a safe ladder/);
    const session = createSession(10);
    assert.equal(session.state, 'STOP');
    assert.equal(session.nextStake, 0);
  });

  await t.test('ladderTable shows stake, cumulative risk and net-if-win per level', () => {
    const rows = ladderTable(1000, 10, 3);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => r.stake), [10, 20, 40]);
    assert.deepEqual(rows.map(r => r.cumulativeRisk), [10, 30, 70]);
    // Win at level 3: profit 40*0.96 - 30 already lost = +8.4
    assert.ok(Math.abs(rows[2].netIfWin - 8.4) < 1e-9);
    // Win at level 1: +9.6
    assert.ok(Math.abs(rows[0].netIfWin - 9.6) < 1e-9);
  });
});

test('Bankroll: settle() win / loss / stop states', async (t) => {
  await t.test('win pays stake * 0.96 and resets to base', () => {
    const s = createSession(1000, { mode: 'balanced' }); // base 10
    const r = settle(s, true);
    assert.equal(r.stakeUsed, 10);
    assert.equal(r.balance, 1009.6);
    assert.equal(r.state, 'RESET');
    assert.equal(r.nextStake, 10);
    assert.equal(r.level, 0);
    // pure: input untouched
    assert.equal(s.balance, 1000);
  });

  await t.test('loss doubles the next stake inside the ladder', () => {
    const s = createSession(1000, { mode: 'balanced' });
    const r1 = settle(s, false);
    assert.equal(r1.state, 'CONTINUE');
    assert.equal(r1.nextStake, 20);
    const r2 = settle(r1, false);
    assert.equal(r2.nextStake, 40);
    assert.equal(r2.balance, 970);
  });

  await t.test('3-loss circuit breaker ends the ladder (LADDER_EXHAUSTED), no chasing', () => {
    let s = createSession(1000, { mode: 'balanced' });
    s = settle(s, false);
    s = settle(s, false);
    s = settle(s, false);
    assert.equal(s.state, 'LADDER_EXHAUSTED');
    assert.equal(s.nextStake, 0);
    assert.equal(s.balance, 930);
    assert.equal(s.drawdown, 70);
  });

  await t.test('stop-loss at -20% of starting balance', () => {
    // Aggressive base on ₹200 = ₹10; force deep losses via a big base session.
    let s = createSession(200, { baseBet: 30 }); // plan lowers base if needed; settle until stop or 12 rounds
    let guard = 0;
    while (s.state === 'CONTINUE' || s.state === 'RESET') {
      s = settle(s, false);
      if (++guard > 30) break;
      if (s.state === 'LADDER_EXHAUSTED') {
        // start the next ladder as a fresh session object on remaining balance
        s = { ...createSession(s.balance, { baseBet: 30 }), startingBalance: 200, peakBalance: 200 };
      }
    }
    assert.ok(s.sessionPnL <= -40 + 1e-9 || s.state === 'STOP_LOSS', `expected stop-loss path, got ${s.state} pnl ${s.sessionPnL}`);
  });

  await t.test('stop-win locks at +20%', () => {
    let s = createSession(100, { baseBet: 30 });
    // plan may lower base; win repeatedly until stop-win
    let guard = 0;
    while ((s.state === 'CONTINUE' || s.state === 'RESET') && guard++ < 50) {
      s = settle(s, true);
    }
    assert.equal(s.state, 'STOP_WIN');
    assert.ok(s.sessionPnL >= 20 - 1e-9);
    assert.equal(s.nextStake, 0);
  });

  await t.test('settleBet matches signal_validation.py payout math', () => {
    assert.deepEqual(settleBet(1000, 10, true), { balance: 1009.6, delta: 9.6, won: true });
    assert.deepEqual(settleBet(1000, 10, false), { balance: 990, delta: -10, won: false });
  });
});
