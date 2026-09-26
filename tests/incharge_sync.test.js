import test from 'node:test';
import assert from 'node:assert/strict';

test('AI Target and In-Charge Model Synchronization', async (t) => {
  // Mock canonical models
  const CANONICAL_MODELS = [
    { id: 'BASE_PREDICTOR', name: 'BASE_PREDICTOR', predColor: 'GREEN', predType: 'COLOR', num: 7, conf: 0.75 },
    { id: 'DEEP_MOMENTUM', name: 'Deep Momentum', predColor: 'RED', predType: 'COLOR', num: 8, conf: 0.82 },
    { id: 'QUANT_SIZE', name: 'Quant Size Master', predSize: 'BIG', predType: 'SIZE', num: 9, conf: 0.85 }
  ];

  await t.test('Auto Mode ON selects highest win rate model by default', () => {
    let ARENA_AUTO_MODE = true;
    let manualArenaInChargeId = null;

    const stats = {
      BASE_PREDICTOR: { wins: 3, totalEvaluated: 10, winRate: 0.30, predTarget: 'GREEN', predType: 'COLOR', num: 7 },
      DEEP_MOMENTUM: { wins: 8, totalEvaluated: 10, winRate: 0.80, predTarget: 'RED', predType: 'COLOR', num: 8 },
      QUANT_SIZE: { wins: 6, totalEvaluated: 10, winRate: 0.60, predTarget: 'BIG', predType: 'SIZE', num: 9 }
    };

    const merged = CANONICAL_MODELS.map(m => ({ ...m, ...stats[m.id] }));
    merged.sort((a, b) => b.winRate - a.winRate);

    let inChargeModel = merged[0];
    assert.equal(inChargeModel.id, 'DEEP_MOMENTUM');
    assert.equal(inChargeModel.winRate, 0.80);

    // AI target must strictly equal inChargeModel prediction
    const aiTarget = inChargeModel.predTarget;
    assert.equal(aiTarget, 'RED');
    assert.equal(inChargeModel.num, 8);
  });

  await t.test('When win rate changes, in-charge model shifts to the new highest win rate model', () => {
    let ARENA_AUTO_MODE = true;
    let manualArenaInChargeId = null;

    // Suppose QUANT_SIZE wins consecutive rounds and overtakes DEEP_MOMENTUM
    const stats = {
      BASE_PREDICTOR: { wins: 3, totalEvaluated: 12, winRate: 0.25, predTarget: 'GREEN', predType: 'COLOR', num: 7 },
      DEEP_MOMENTUM: { wins: 8, totalEvaluated: 12, winRate: 0.667, predTarget: 'RED', predType: 'COLOR', num: 8 },
      QUANT_SIZE: { wins: 11, totalEvaluated: 12, winRate: 0.917, predTarget: 'BIG', predType: 'SIZE', num: 9 }
    };

    const merged = CANONICAL_MODELS.map(m => ({ ...m, ...stats[m.id] }));
    merged.sort((a, b) => b.winRate - a.winRate);

    let inChargeModel = merged[0];
    assert.equal(inChargeModel.id, 'QUANT_SIZE');
    assert.equal(inChargeModel.winRate, 0.917);

    // AI target immediately reflects the new in-charge model
    const aiTarget = inChargeModel.predTarget;
    assert.equal(aiTarget, 'BIG');
    assert.equal(inChargeModel.num, 9);
  });

  await t.test('Manual mode override locks the selected model even if another has higher win rate', () => {
    let ARENA_AUTO_MODE = false;
    let manualArenaInChargeId = 'BASE_PREDICTOR';

    const stats = {
      BASE_PREDICTOR: { wins: 3, totalEvaluated: 12, winRate: 0.25, predTarget: 'GREEN', predType: 'COLOR', num: 7 },
      DEEP_MOMENTUM: { wins: 8, totalEvaluated: 12, winRate: 0.667, predTarget: 'RED', predType: 'COLOR', num: 8 },
      QUANT_SIZE: { wins: 11, totalEvaluated: 12, winRate: 0.917, predTarget: 'BIG', predType: 'SIZE', num: 9 }
    };

    const merged = CANONICAL_MODELS.map(m => ({ ...m, ...stats[m.id] }));
    merged.sort((a, b) => b.winRate - a.winRate);

    let inChargeModel = merged[0];
    if (!ARENA_AUTO_MODE && manualArenaInChargeId) {
      inChargeModel = merged.find(m => m.id === manualArenaInChargeId) || merged[0];
    }

    assert.equal(inChargeModel.id, 'BASE_PREDICTOR');
    assert.equal(inChargeModel.predTarget, 'GREEN');
  });

  await t.test('Toggling Auto Mode back ON immediately restores top win rate model as in-charge', () => {
    let ARENA_AUTO_MODE = false;
    let manualArenaInChargeId = 'BASE_PREDICTOR';

    const stats = {
      BASE_PREDICTOR: { wins: 3, totalEvaluated: 12, winRate: 0.25, predTarget: 'GREEN', predType: 'COLOR', num: 7 },
      DEEP_MOMENTUM: { wins: 8, totalEvaluated: 12, winRate: 0.667, predTarget: 'RED', predType: 'COLOR', num: 8 },
      QUANT_SIZE: { wins: 11, totalEvaluated: 12, winRate: 0.917, predTarget: 'BIG', predType: 'SIZE', num: 9 }
    };

    // Toggle Auto Mode ON
    ARENA_AUTO_MODE = true;
    manualArenaInChargeId = null;

    const merged = CANONICAL_MODELS.map(m => ({ ...m, ...stats[m.id] }));
    merged.sort((a, b) => b.winRate - a.winRate);

    let inChargeModel = ARENA_AUTO_MODE ? merged[0] : (merged.find(m => m.id === manualArenaInChargeId) || merged[0]);
    assert.equal(inChargeModel.id, 'QUANT_SIZE');
    assert.equal(inChargeModel.predTarget, 'BIG');
  });

  await t.test('AI single result in history strictly matches in-charge model evaluation and target', () => {
    // Simulated active in-charge model
    const activeInCharge = { id: 'BASE_PREDICTOR', name: 'BASE_PREDICTOR (OG Algorithm)' };
    const inChargeStats = {
      historyPath: [
        { period: '20260926010510', won: true, predType: 'COLOR', predTarget: 'GREEN', actual: 'GREEN' },
        { period: '20260926010509', won: false, predType: 'COLOR', predTarget: 'RED', actual: 'GREEN' }
      ]
    };

    const historyRows = [
      { period: '20260926010510', number: 7, size: 'BIG', color: 'GREEN', aiTarget: 'BIG' }, // old legacy consensus was 'BIG'
      { period: '20260926010509', number: 3, size: 'SMALL', color: 'GREEN', aiTarget: 'SMALL' }
    ];

    // Priority lookup function matching smartHistoryRows logic
    function resolveRowAiPrediction(row) {
      const hp = inChargeStats.historyPath.find(p => p.period === row.period);
      if (hp && hp.predTarget) {
        return { target: hp.predTarget, type: hp.predType, won: hp.won };
      }
      return { target: row.aiTarget, type: 'SIZE', won: row.aiTarget === row.size };
    }

    const res1 = resolveRowAiPrediction(historyRows[0]);
    assert.equal(res1.target, 'GREEN');
    assert.equal(res1.type, 'COLOR');
    assert.equal(res1.won, true);

    const res2 = resolveRowAiPrediction(historyRows[1]);
    assert.equal(res2.target, 'RED');
    assert.equal(res2.type, 'COLOR');
    assert.equal(res2.won, false);
  });

  await t.test('Switching in-charge model updates history AI single result to match the newly in-charge model', () => {
    const stats = {
      MODEL_A: {
        historyPath: [
          { period: '20260926010510', won: true, predType: 'COLOR', predTarget: 'GREEN', actual: 'GREEN' }
        ]
      },
      MODEL_B: {
        historyPath: [
          { period: '20260926010510', won: false, predType: 'SIZE', predTarget: 'SMALL', actual: 'BIG' }
        ]
      }
    };

    const row = { period: '20260926010510', number: 7, size: 'BIG', color: 'GREEN' };

    function getHistoryResultForActiveModel(activeModelId) {
      const hp = stats[activeModelId]?.historyPath?.find(p => p.period === row.period);
      return hp ? { target: hp.predTarget, won: hp.won } : null;
    }

    // When MODEL_A is in charge
    assert.deepEqual(getHistoryResultForActiveModel('MODEL_A'), { target: 'GREEN', won: true });

    // When MODEL_B is in charge
    assert.deepEqual(getHistoryResultForActiveModel('MODEL_B'), { target: 'SMALL', won: false });
  });
});

