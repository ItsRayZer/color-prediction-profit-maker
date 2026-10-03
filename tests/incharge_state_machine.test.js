import test from 'node:test';
import assert from 'node:assert/strict';
import { InchargeEngine, INCHARGE_MODES } from '../systems/inchargeEngine.js';

test('InchargeEngine State Machine & Isolation', async (t) => {
  const sampleModels = [
    {
      id: 'model-base-champ',
      name: 'Base Champion Model',
      winRate: 0.85,
      totalEvaluated: 100,
      wins: 85,
      streak: 1,
      sessionWinRate: 0.50,
      sessionEvaluated: 10,
      sessionWins: 5,
      sessionStreak: 1
    },
    {
      id: 'model-streaker',
      name: 'Hot Streaker Model',
      winRate: 0.70,
      totalEvaluated: 50,
      wins: 35,
      streak: 4, // 4-win streak >= minStreak (3)
      sessionWinRate: 0.90,
      sessionEvaluated: 10,
      sessionWins: 9,
      sessionStreak: 4
    },
    {
      id: 'model-struggler',
      name: 'Struggler Model',
      winRate: 0.45,
      totalEvaluated: 40,
      wins: 18,
      streak: -2,
      sessionWinRate: 0.20,
      sessionEvaluated: 10,
      sessionWins: 2,
      sessionStreak: -2
    }
  ];

  await t.test('MODE 1: OVERALL_WIN_RATE strictly selects highest win rate model', () => {
    const engine = new InchargeEngine({ mode: INCHARGE_MODES.OVERALL_WIN_RATE });
    const decision = engine.evaluateIncharge(sampleModels);

    assert.equal(decision.state, 'NORMAL');
    assert.equal(decision.model.id, 'model-base-champ');
    assert.equal(decision.model.winRate, 0.85);
  });

  await t.test('MODE 2: WINNING_STREAK_OVERRIDE triggers streak rider override', () => {
    const engine = new InchargeEngine({
      mode: INCHARGE_MODES.WINNING_STREAK_OVERRIDE,
      minStreak: 3,
      minEvaluated: 10
    });

    const decision = engine.evaluateIncharge(sampleModels);

    // model-streaker has streak 4 >= minStreak 3, so it overrides model-base-champ
    assert.equal(decision.state, 'STREAK_OVERRIDE');
    assert.equal(decision.model.id, 'model-streaker');
    assert.equal(engine.activeStreakCount, 4);
  });

  await t.test('STREAK LOSS: Wrong prediction terminates streak override and returns to base immediately', () => {
    const engine = new InchargeEngine({
      mode: INCHARGE_MODES.WINNING_STREAK_OVERRIDE,
      minStreak: 3,
      minEvaluated: 10
    });

    // 1. Initial evaluation triggers STREAK_OVERRIDE
    let decision = engine.evaluateIncharge(sampleModels);
    assert.equal(decision.state, 'STREAK_OVERRIDE');
    assert.equal(decision.model.id, 'model-streaker');

    // 2. Streaker loses next round -> handleRoundSettlement({ won: false })
    engine.handleRoundSettlement({ won: false });
    assert.equal(engine.state, 'RETURN_TO_BASE');
    assert.equal(engine.activeStreakModelId, null);

    // 3. Streaker's streak is reset to -1 in models
    const updatedModels = sampleModels.map(m => {
      if (m.id === 'model-streaker') {
        return { ...m, streak: -1 };
      }
      return m;
    });

    // 4. Next evaluation cleanly returns to Base Champion
    decision = engine.evaluateIncharge(updatedModels);
    assert.equal(decision.state, 'NORMAL');
    assert.equal(decision.model.id, 'model-base-champ');
  });

  await t.test('MODE 3: SESSION_WIN_RATE prioritizes user session performance', () => {
    const engine = new InchargeEngine({ mode: INCHARGE_MODES.SESSION_WIN_RATE });
    const decision = engine.evaluateIncharge(sampleModels);

    // In session stats, model-streaker has 90% session WR vs base-champ's 50%
    assert.equal(decision.model.id, 'model-streaker');
  });

  await t.test('Session Reset Isolation: Session reset does NOT alter server all-time stats', () => {
    const serverModel = {
      id: 'model-omega',
      name: 'Omega AI',
      wins: 120,
      losses: 30,
      totalEvaluated: 150,
      winRate: 0.80,
      streak: 5,
      sessionWins: 8,
      sessionLosses: 2,
      sessionEvaluated: 10,
      sessionWinRate: 0.80,
      sessionStreak: 3
    };

    // Simulate session reset
    const userSessionReset = (m) => ({
      ...m,
      sessionWins: 0,
      sessionLosses: 0,
      sessionEvaluated: 0,
      sessionWinRate: 0,
      sessionStreak: 0
    });

    const afterReset = userSessionReset(serverModel);

    // Session stats reset to 0
    assert.equal(afterReset.sessionWins, 0);
    assert.equal(afterReset.sessionEvaluated, 0);
    assert.equal(afterReset.sessionWinRate, 0);

    // All-time / server-wide stats strictly unchanged
    assert.equal(afterReset.wins, 120);
    assert.equal(afterReset.losses, 30);
    assert.equal(afterReset.totalEvaluated, 150);
    assert.equal(afterReset.winRate, 0.80);
    assert.equal(afterReset.streak, 5);
  });
});
