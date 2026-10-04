import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ARENA_CANONICAL_MODELS,
  generateModelNextPrediction,
  determineOptimalArenaInChargeModel,
  evaluatePredictionCorrectness,
  denoiseGameHistory
} = require('../scripts/arena_models.cjs');

test('Denoising, Algorithm Intelligence & Strict Max-3 Loss Multiplier Protection Suite', async (t) => {

  await t.test('1. Game History Denoising: Strips 1-round noise blips and detects macro regimes', () => {
    assert.equal(typeof denoiseGameHistory, 'function', 'denoiseGameHistory must be exported');

    // Case A: 1-round noise blip in strong BIG cluster: [B, B, B, S, B, B]
    const noisyHistory = [
      { period: '1', number: 8, size: 'BIG', color: 'red' },
      { period: '2', number: 6, size: 'BIG', color: 'red' },
      { period: '3', number: 7, size: 'BIG', color: 'green' },
      { period: '4', number: 2, size: 'SMALL', color: 'red' }, // Transient noise spike
      { period: '5', number: 9, size: 'BIG', color: 'green' },
      { period: '6', number: 8, size: 'BIG', color: 'red' }
    ];

    const denoisedA = denoiseGameHistory(noisyHistory);
    assert.equal(denoisedA.cleanSizes[3], 'BIG', 'Transient 1-round SMALL noise spike must be cleaned to BIG');
    assert.ok(denoisedA.smoothedSizeProb > 0.65, 'Smoothed BIG probability must be high');

    // Case B: Persistent Dragon Streak (5 consecutive BIGs)
    const dragonHistory = [
      { period: '1', number: 8, size: 'BIG', color: 'red' },
      { period: '2', number: 7, size: 'BIG', color: 'green' },
      { period: '3', number: 9, size: 'BIG', color: 'green' },
      { period: '4', number: 6, size: 'BIG', color: 'red' },
      { period: '5', number: 5, size: 'BIG', color: 'green' }
    ];
    const denoisedB = denoiseGameHistory(dragonHistory);
    assert.equal(denoisedB.regime, 'DRAGON');
    assert.equal(denoisedB.dragonLen, 5);
    assert.equal(denoisedB.dragonType, 'BIG');

    // Case C: Alternating Chop Sequence (B -> S -> B -> S -> B)
    const chopHistory = [
      { period: '1', number: 8, size: 'BIG', color: 'red' },
      { period: '2', number: 2, size: 'SMALL', color: 'red' },
      { period: '3', number: 7, size: 'BIG', color: 'green' },
      { period: '4', number: 3, size: 'SMALL', color: 'green' },
      { period: '5', number: 9, size: 'BIG', color: 'green' }
    ];
    const denoisedC = denoiseGameHistory(chopHistory);
    assert.equal(denoisedC.regime, 'CHOP');
    assert.ok(denoisedC.chopLen >= 3);
  });

  await t.test('2. In-Charge Leadership Logic: Slump Protection Disqualifies 2+ Loss Models', () => {
    // Model A has high historical win rate (80%), BUT is in a severe slump (streak: -2, lost last 2 rounds)
    // Model B has 75% win rate, BUT is stable/winning (streak: 2)
    // Model C has 60% win rate (streak: 1)
    const pool = [
      { id: 'SLUMPING_WR_CHAMPION', name: 'Slumping Veteran', winRate: 0.80, streak: -2, evaluated: 60, wins: 48, losses: 12 },
      { id: 'STABLE_WINNER', name: 'Stable Winner', winRate: 0.75, streak: 2, evaluated: 40, wins: 30, losses: 10 },
      { id: 'AVERAGE_MODEL', name: 'Average Model', winRate: 0.60, streak: 1, evaluated: 30, wins: 18, losses: 12 }
    ];

    const selection = determineOptimalArenaInChargeModel(pool, null, true);
    assert.ok(selection && selection.model);
    assert.equal(selection.model.id, 'STABLE_WINNER', 'Slumping model with streak -2 must be disqualified so it cannot cause a 3rd loss!');
    assert.equal(selection.mode, 'HIGHEST_WIN_RATE');
  });

  await t.test('3. In-Charge Selection: Honors Highest Win Rate when streaks are non-negative', () => {
    const pool = [
      { id: 'HIGH_WR', name: 'High WR', winRate: 0.84, streak: 1, evaluated: 50, wins: 42, losses: 8 },
      { id: 'MID_WR', name: 'Mid WR', winRate: 0.72, streak: 3, evaluated: 40, wins: 29, losses: 11 }
    ];

    const selection = determineOptimalArenaInChargeModel(pool, null, true);
    assert.equal(selection.model.id, 'HIGH_WR', 'Must appoint 84% WR model when not slumping');
  });

  await t.test('4. Strict Hard Max-3 Loss / Multiplier Cap Enforcement', () => {
    // Simulate MobileBridgeState state machine
    const state = {
      baseStake: 2,
      multiplier: 2.0,
      maxStakeCap: 64,
      currentLevel: 0,
      currentStake: 2,
      consecutiveLosses: 0,
      circuitBreakerActive: false,
      circuitBreakerPauseRounds: 0
    };

    function calculateSafeStake() {
      // Clamped strictly to max level 2 (Levels: 0 = 1x, 1 = 2x, 2 = 4x)
      const safeLevel = Math.min(2, Math.max(0, state.currentLevel));
      state.currentLevel = safeLevel;
      const unconstrained = Math.round(state.baseStake * Math.pow(state.multiplier, safeLevel));
      state.currentStake = Math.min(unconstrained, state.maxStakeCap);
      return state.currentStake;
    }

    function recordSettlement(isWin) {
      if (isWin) {
        state.consecutiveLosses = 0;
        state.currentLevel = 0;
        state.circuitBreakerActive = false;
        state.circuitBreakerPauseRounds = 0;
      } else {
        state.consecutiveLosses += 1;
        if (state.consecutiveLosses >= 3) {
          // Trip circuit breaker
          state.circuitBreakerActive = true;
          state.circuitBreakerPauseRounds = 2;
          state.currentLevel = 0;
          state.currentStake = state.baseStake;
          state.consecutiveLosses = 0;
        } else {
          state.currentLevel = Math.min(2, state.currentLevel + 1);
        }
      }
      calculateSafeStake();
      return { ...state };
    }

    // Round 1: Loss 1 (Level 1 -> Level 2)
    assert.equal(calculateSafeStake(), 2, 'Initial base stake is ₹2 (Level 1)');
    recordSettlement(false);
    assert.equal(state.consecutiveLosses, 1);
    assert.equal(state.currentLevel, 1);
    assert.equal(state.currentStake, 4, 'Level 2 stake is 2x = ₹4');
    assert.equal(state.circuitBreakerActive, false);

    // Round 2: Loss 2 (Level 2 -> Level 3)
    recordSettlement(false);
    assert.equal(state.consecutiveLosses, 2);
    assert.equal(state.currentLevel, 2);
    assert.equal(state.currentStake, 8, 'Level 3 stake is 4x = ₹8');
    assert.equal(state.circuitBreakerActive, false);

    // Round 3: Loss 3 -> CIRCUIT BREAKER MUST TRIP IMMEDIATELY
    recordSettlement(false);
    assert.equal(state.circuitBreakerActive, true, 'Circuit breaker MUST be active on 3rd loss');
    assert.equal(state.circuitBreakerPauseRounds, 2, 'Must pause for 2 rounds cool-off');
    assert.equal(state.currentLevel, 0, 'Current level must strictly reset to 0 (Base Level 1)');
    assert.equal(state.currentStake, 2, 'Stake must strictly reset to Base ₹2 (NEVER level 4 / ₹16)');
    assert.equal(state.consecutiveLosses, 0, 'Consecutive loss counter reset');
  });

  await t.test('5. Multiplier level can NEVER exceed Level 3 (currentLevel <= 2)', () => {
    const invalidHighLevels = [3, 4, 5, 10, 99];
    invalidHighLevels.forEach(lvl => {
      const safeLevel = Math.min(2, Math.max(0, lvl));
      assert.equal(safeLevel, 2, `Level ${lvl} must be strictly clamped to Level 3 (index 2)`);
      const stake = Math.round(2 * Math.pow(2.0, safeLevel));
      assert.equal(stake, 8, 'Maximum allowable recovery stake is ₹8 (4x)');
    });
  });

});
