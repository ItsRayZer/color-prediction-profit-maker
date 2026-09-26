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
});
