import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudDatabase } from '../backend/cloud/database.js';
import { globalModelRegistry, RegisteredModel } from '../backend/cloud/modelRegistry.js';
import { DualInchargeController } from '../backend/cloud/dualInchargeController.js';
import { RebuildEngine } from '../backend/cloud/rebuildEngine.js';
import { IngestionService } from '../backend/cloud/ingestionService.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ARENA_CANONICAL_MODELS,
  generateModelNextPrediction,
  determineOptimalArenaInChargeModel,
  evaluatePredictionCorrectness
} = require('../scripts/arena_models.cjs');

test('Comprehensive Cloud Architecture & 53+ Model Engine Verification Suite', async (t) => {
  const db = new CloudDatabase(':memory:');
  const inchargeController = new DualInchargeController(db);
  const rebuildEngine = new RebuildEngine(db, globalModelRegistry);

  t.after(() => {
    db.close();
  });

  await t.test('1. Model Registry: All 101 Canonical Models Loaded Correctly', () => {
    assert.equal(globalModelRegistry.getModelCount(), 101, 'Must have exactly 101 canonical models');
    const defs = globalModelRegistry.getAllModelDefinitions();
    assert.equal(defs.length, 101);

    const categories = new Set(defs.map(d => d.cat));
    assert.ok(categories.has('fly'));
    assert.ok(categories.has('neural'));
    assert.ok(categories.has('classical'));
    assert.ok(categories.has('statistical'));
    assert.ok(categories.has('meta'));
    assert.ok(categories.has('signal'));
    assert.ok(categories.has('chaos'));
    assert.ok(categories.has('game_theory'));
    assert.ok(categories.has('pattern'));
    assert.ok(categories.has('quantum'));

    // Check specific anchor models
    assert.ok(defs.find(d => d.id === 'fly-mushroom-body-spiking'));
    assert.ok(defs.find(d => d.id === 'BASE_PREDICTOR'));
    assert.ok(defs.find(d => d.id === 'ASI'));
    assert.ok(defs.find(d => d.id === 'SIGNAL_KALMAN_FILTER'));
    assert.ok(defs.find(d => d.id === 'GAME_MINIMAX_EXPLOITER'));
    assert.ok(defs.find(d => d.id === 'ASI_APEX_MASTER'));
  });

  await t.test('2. Deterministic Replay Verification: Local vs Cloud Engine for ALL 101 Models', () => {
    // Generate deterministic 20-round synthetic history
    const syntheticRounds = [
      { period: '202610010001', number: 2, size: 'SMALL', color: 'red' },
      { period: '202610010002', number: 7, size: 'BIG', color: 'green' },
      { period: '202610010003', number: 9, size: 'BIG', color: 'green' },
      { period: '202610010004', number: 4, size: 'SMALL', color: 'red' },
      { period: '202610010005', number: 0, size: 'SMALL', color: 'red,violet' },
      { period: '202610010006', number: 5, size: 'BIG', color: 'green,violet' },
      { period: '202610010007', number: 8, size: 'BIG', color: 'red' },
      { period: '202610010008', number: 3, size: 'SMALL', color: 'green' },
      { period: '202610010009', number: 1, size: 'SMALL', color: 'green' },
      { period: '202610010010', number: 6, size: 'BIG', color: 'red' },
      { period: '202610010011', number: 7, size: 'BIG', color: 'green' },
      { period: '202610010012', number: 8, size: 'BIG', color: 'red' },
      { period: '202610010013', number: 2, size: 'SMALL', color: 'red' },
      { period: '202610010014', number: 3, size: 'SMALL', color: 'green' },
      { period: '202610010015', number: 5, size: 'BIG', color: 'green,violet' },
      { period: '202610010016', number: 9, size: 'BIG', color: 'green' },
      { period: '202610010017', number: 1, size: 'SMALL', color: 'green' },
      { period: '202610010018', number: 0, size: 'SMALL', color: 'red,violet' },
      { period: '202610010019', number: 4, size: 'SMALL', color: 'red' },
      { period: '202610010020', number: 6, size: 'BIG', color: 'red' }
    ];

    const pool = globalModelRegistry.createPool();
    const verifiedModels = [];

    // Compare each model in isolation
    for (let idx = 0; idx < ARENA_CANONICAL_MODELS.length; idx++) {
      const canonicalTmpl = ARENA_CANONICAL_MODELS[idx];
      const cloudModel = pool[idx];
      assert.equal(cloudModel.id, canonicalTmpl.id);

      const localModel = { ...canonicalTmpl };

      // Local canonical walk-forward
      let localWins = 0;
      let localLosses = 0;
      let localStreak = 0;
      let localBestStreak = 0;
      let localDopamine = 0.5;
      let localLossPain = 0.0;
      let lastLocalPred = null;

      // Cloud walk-forward
      for (let i = 2; i < syntheticRounds.length; i++) {
        const prior = syntheticRounds.slice(0, i);
        const cur = syntheticRounds[i];

        // 1. Local calculation
        const localStats = { streak: localStreak, bestStreak: localBestStreak, dopamine: localDopamine, lossPain: localLossPain };
        const localPred = generateModelNextPrediction(localModel, prior, localStats);
        localModel.predType = localPred.predType;
        localModel.predTarget = localPred.predTarget;
        lastLocalPred = localPred;
        const localWon = !!evaluatePredictionCorrectness(localPred.predTarget, cur.number, cur.size, cur.color);
        if (localWon) {
          localWins++;
          localStreak = localStreak >= 0 ? localStreak + 1 : 1;
          if (localStreak > localBestStreak) localBestStreak = localStreak;
          localDopamine = Math.min(1.0, Number((localDopamine + 0.10).toFixed(2)));
          localLossPain = Math.max(0.0, Number((localLossPain - 0.15).toFixed(2)));
        } else {
          localLosses++;
          localStreak = localStreak <= 0 ? localStreak - 1 : -1;
          localLossPain = Math.min(1.0, Number((localLossPain + 0.15).toFixed(2)));
          localDopamine = Math.max(0.0, Number((localDopamine - 0.10).toFixed(2)));
        }

        // 2. Cloud Model calculation
        cloudModel.predict(prior);
        const cloudEval = cloudModel.evaluatePrediction(cur);

        // Assert step-by-step match
        assert.equal(cloudEval.won, localWon, `Step outcome mismatch at round ${i} for model ${cloudModel.id}`);
        assert.equal(cloudModel.streak, localStreak, `Streak mismatch at round ${i} for model ${cloudModel.id}`);
      }

      // Assert cumulative stats match
      assert.equal(cloudModel.wins, localWins, `Wins mismatch for model ${cloudModel.id}`);
      assert.equal(cloudModel.losses, localLosses, `Losses mismatch for model ${cloudModel.id}`);
      assert.equal(cloudModel.streak, localStreak, `Final streak mismatch for model ${cloudModel.id}`);

      // Final prediction comparison on full history
      const localFinalPred = generateModelNextPrediction(localModel, syntheticRounds, {
        streak: localStreak,
        bestStreak: localBestStreak,
        dopamine: localDopamine,
        lossPain: localLossPain
      });
      const cloudFinalPred = cloudModel.predict(syntheticRounds);

      assert.equal(cloudFinalPred.predTarget, localFinalPred.predTarget, `Final predTarget mismatch for model ${cloudModel.id}`);
      assert.equal(cloudFinalPred.predType, localFinalPred.predType, `Final predType mismatch for model ${cloudModel.id}`);

      verifiedModels.push(cloudModel.id);
    }

    assert.equal(verifiedModels.length, 101, 'All 101 models must match 100% deterministically');
  });

  await t.test('3. Database: Deduplication and Unique Constraint Integrity', () => {
    const round1 = {
      interval: '30s',
      period: '202610010099',
      number: 8,
      size: 'BIG',
      color: 'red'
    };

    const insertedFirst = db.insertRound(round1);
    assert.equal(insertedFirst, true, 'First insert must succeed');

    // Duplicate insert attempt
    const insertedDuplicate = db.insertRound(round1);
    assert.equal(insertedDuplicate, false, 'Duplicate insert with same interval & period must be ignored');

    const history = db.getPaginatedHistory('30s', 1, 10);
    assert.equal(history.records.length, 1, 'Database must contain strictly one copy of the round');
  });

  await t.test('4. Dual Incharge: Incharge B (Server) vs Incharge A (User Session)', () => {
    const pool = [
      { id: 'MODEL_A', name: 'Model A', predTarget: 'BIG', predType: 'SIZE', streak: 2, totalEvaluated: 10, wins: 8, losses: 2, winRate: 0.80 },
      { id: 'MODEL_B', name: 'Model B', predTarget: 'RED', predType: 'COLOR', streak: 1, totalEvaluated: 10, wins: 5, losses: 5, winRate: 0.50 }
    ];

    // INCHARGE B: Server Service Incharge
    const serviceIncharge = inchargeController.evaluateServiceIncharge('30s', pool, null, true);
    assert.equal(serviceIncharge.model.id, 'MODEL_A');
    assert.equal(serviceIncharge.model.winRate, 0.80);

    // Populate user session stats where MODEL_B has 100% win rate
    const sessionId = 'test-session-user-123';
    db.saveUserSessionStat(sessionId, '30s', 'MODEL_A', {
      totalEvaluated: 4,
      wins: 1,
      losses: 3,
      winRate: 0.25,
      streak: -2,
      bestStreak: 1
    });
    db.saveUserSessionStat(sessionId, '30s', 'MODEL_B', {
      totalEvaluated: 4,
      wins: 4,
      losses: 0,
      winRate: 1.00,
      streak: 4,
      bestStreak: 4
    });

    // INCHARGE A: User Session Incharge selects MODEL_B because of session stats!
    const sessionIncharge = inchargeController.evaluateSessionIncharge(sessionId, '30s', pool, null, true);
    assert.equal(sessionIncharge.model.id, 'MODEL_B');
    assert.equal(sessionIncharge.model.winRate, 1.00);

    // Service incharge remains MODEL_A!
    const serviceInchargeAfter = inchargeController.evaluateServiceIncharge('30s', pool, null, true);
    assert.equal(serviceInchargeAfter.model.id, 'MODEL_A');
    assert.equal(serviceInchargeAfter.model.winRate, 0.80);
  });

  await t.test('5. User Reset Rule: Session Reset Wipes Incharge A but leaves Incharge B 100% Untouched', () => {
    const sessionId = 'test-session-user-123';

    // Before reset
    const statsBefore = db.getUserSessionStats(sessionId, '30s');
    assert.ok(statsBefore.length > 0);

    // Call User Reset
    const resetResult = inchargeController.resetUserSession(sessionId);
    assert.equal(resetResult.sessionId, sessionId);

    // Session stats are now wiped to 0
    const statsAfter = db.getUserSessionStats(sessionId, '30s');
    assert.equal(statsAfter.length, 0);

    // Server Service Incharge remains completely unchanged
    const pool = [
      { id: 'MODEL_A', name: 'Model A', predTarget: 'BIG', predType: 'SIZE', streak: 2, totalEvaluated: 10, wins: 8, losses: 2, winRate: 0.80 },
      { id: 'MODEL_B', name: 'Model B', predTarget: 'RED', predType: 'COLOR', streak: 1, totalEvaluated: 10, wins: 5, losses: 5, winRate: 0.50 }
    ];
    const serviceIncharge = inchargeController.evaluateServiceIncharge('30s', pool, null, true);
    assert.equal(serviceIncharge.model.id, 'MODEL_A');
    assert.equal(serviceIncharge.model.winRate, 0.80);
  });

  await t.test('6. Full Rebuild Engine: Replays Full Database History and Reconstructs State', async () => {
    // Populate database with 10 rounds
    for (let i = 1; i <= 10; i++) {
      db.insertRound({
        interval: '1m',
        period: `2026100100${i.toString().padStart(2, '0')}`,
        number: i % 10,
        size: (i % 10) >= 5 ? 'BIG' : 'SMALL',
        color: (i % 10) % 2 === 1 ? 'green' : 'red'
      });
    }

    const rebuildResult = await rebuildEngine.rebuildAllModels('1m');
    assert.equal(rebuildResult.success, true);
    assert.equal(rebuildResult.totalModels, 101);
    assert.equal(rebuildResult.totalRounds, 10);

    // Verify model state in DB was persisted
    const baseState = db.getModelState('BASE_PREDICTOR', '1m');
    assert.ok(baseState, 'Base model state must be persisted after rebuild');

    const baseStats = db.getModelServerStats('BASE_PREDICTOR', '1m');
    assert.ok(baseStats, 'Base model stats must be persisted after rebuild');
    assert.ok(baseStats.total_evaluated > 0);
  });
});
