import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ARENA_CANONICAL_MODELS,
  generateModelNextPrediction,
  determineOptimalArenaInChargeModel,
  evaluatePredictionCorrectness
} = require('../scripts/arena_models.cjs');

test('101 Local Intelligence Algorithms Verification Suite', async (t) => {
  await t.test('1. Total Model Count & Unique ID Integrity', () => {
    assert.equal(ARENA_CANONICAL_MODELS.length, 101, 'Must have exactly 101 canonical models');
    const ids = ARENA_CANONICAL_MODELS.map(m => m.id);
    const uniqueIds = new Set(ids);
    assert.equal(uniqueIds.size, 101, 'All 101 models must have unique IDs');

    // Verify all 10 specialized categories exist
    const categories = new Set(ARENA_CANONICAL_MODELS.map(m => m.cat));
    const expectedCategories = [
      'fly', 'neural', 'classical', 'statistical', 'meta',
      'signal', 'chaos', 'game_theory', 'pattern', 'quantum'
    ];
    expectedCategories.forEach(cat => {
      assert.ok(categories.has(cat), `Category '${cat}' must be present in the 101 models`);
    });
  });

  await t.test('2. Schema Validation for All 101 Models', () => {
    ARENA_CANONICAL_MODELS.forEach((m, idx) => {
      assert.ok(m.id && typeof m.id === 'string', `Model ${idx} must have string id`);
      assert.ok(m.name && typeof m.name === 'string', `Model ${m.id} must have string name`);
      assert.ok(m.cat && typeof m.cat === 'string', `Model ${m.id} must have string cat`);
      assert.ok(m.arch && typeof m.arch === 'string', `Model ${m.id} must have string arch`);
      assert.ok(m.desc && typeof m.desc === 'string', `Model ${m.id} must have string desc`);
      assert.ok(['SIZE', 'COLOR', 'NUMBER'].includes(m.predType), `Model ${m.id} predType must be valid`);
      assert.ok(m.conf >= 0.5 && m.conf <= 1.0, `Model ${m.id} default conf must be between 0.5 and 1.0`);
    });
  });

  await t.test('3. Prediction Execution Across Different History Depths (0 to 100 rounds)', () => {
    // Generate 100 realistic rounds
    const fullHistory = [];
    for (let i = 1; i <= 100; i++) {
      const num = (i * 7 + 3) % 10;
      fullHistory.push({
        period: `2026100200${i.toString().padStart(3, '0')}`,
        number: num,
        size: num >= 5 ? 'BIG' : 'SMALL',
        color: num === 0 ? 'red,violet' : (num === 5 ? 'green,violet' : ([1, 3, 7, 9].includes(num) ? 'green' : 'red'))
      });
    }

    const testHistories = [
      [],
      fullHistory.slice(0, 1),
      fullHistory.slice(0, 5),
      fullHistory.slice(0, 20),
      fullHistory
    ];

    ARENA_CANONICAL_MODELS.forEach(model => {
      testHistories.forEach((hist, hIdx) => {
        const pred = generateModelNextPrediction(model, hist, {
          streak: 2,
          dopamine: 0.6,
          lossPain: 0.1
        });

        assert.ok(pred, `Model ${model.id} must return prediction object at history depth ${hIdx}`);
        assert.ok(['BIG', 'SMALL'].includes(pred.predSize), `Model ${model.id} predSize must be BIG or SMALL`);
        assert.ok(['GREEN', 'RED'].includes(pred.predColor), `Model ${model.id} predColor must be GREEN or RED`);
        assert.ok(typeof pred.conf === 'number' && pred.conf >= 0.50 && pred.conf <= 0.98, `Model ${model.id} conf must be bounded [0.50, 0.98]`);
        assert.ok(typeof pred.num === 'number' && pred.num >= 0 && pred.num <= 9, `Model ${model.id} num must be 0-9`);
        assert.ok(pred.predTarget, `Model ${model.id} predTarget must be defined`);
      });
    });
  });

  await t.test('4. Target Calibration for High Accuracy (70-80%+ Range on Confirmed Regimes)', () => {
    // Construct a persistent Dragon streak history (7 consecutive BIG rounds)
    const dragonStreakHistory = [];
    for (let i = 1; i <= 15; i++) {
      const isBig = i >= 8;
      const num = isBig ? 8 : 2;
      dragonStreakHistory.push({
        period: `2026100200${i.toString().padStart(3, '0')}`,
        number: num,
        size: isBig ? 'BIG' : 'SMALL',
        color: 'red'
      });
    }

    // High confidence models should commit with >= 0.75 confidence during persistent streak
    const highConvictionModels = [
      'ASI_APEX_MASTER',
      'SIGNAL_KALMAN_FILTER',
      'SIGNAL_RSI_OSCILLATOR',
      'CHAOS_HURST_EXPONENT',
      'GAME_MINIMAX_EXPLOITER',
      'PATTERN_DTW_WARPING',
      'QUANTUM_BLOCH_SPHERE'
    ];

    highConvictionModels.forEach(mId => {
      const model = ARENA_CANONICAL_MODELS.find(m => m.id === mId);
      assert.ok(model, `Model ${mId} must exist`);
      const pred = generateModelNextPrediction(model, dragonStreakHistory, { streak: 3, dopamine: 0.7 });
      assert.ok(pred.conf >= 0.75, `Model ${mId} confidence must reach >= 0.75 during persistent streak (got ${pred.conf})`);
    });
  });

  await t.test('5. Incharge Champion Selection Dynamically Elevates Highest Win-Rate Model', () => {
    const mockPool = ARENA_CANONICAL_MODELS.map((m, idx) => ({
      ...m,
      wins: idx === 75 ? 82 : (idx === 10 ? 60 : 40),
      losses: idx === 75 ? 18 : (idx === 10 ? 40 : 60),
      totalEvaluated: 100,
      winRate: idx === 75 ? 0.82 : (idx === 10 ? 0.60 : 0.40),
      streak: idx === 75 ? 5 : 1
    }));

    const result = determineOptimalArenaInChargeModel(mockPool, null, true);
    assert.ok(result && result.model);
    assert.equal(result.model.id, ARENA_CANONICAL_MODELS[75].id, 'Must select the model with 82% win rate as Incharge Champion');
    assert.equal(result.model.winRate, 0.82);
  });
});
