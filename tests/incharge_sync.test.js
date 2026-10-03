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

  await t.test('Locked AI target for in-charge model is preserved on settlement and matches history exactly', () => {
    const activeChamp = { id: 'CHAMP_QUANT', name: 'Champ Quant' };
    const period = '20260926010515';

    // 1. Prediction locked while round is active
    const aiPredictionMap = {
      [period]: { target: 'BIG', type: 'SIZE', prob: 0.82, engines: ['Champ Quant'] }
    };
    const history = [];

    // 2. Round settles with Number 8 (BIG, RED)
    const number = 8;
    const actualSize = 'BIG';
    const actualColor = 'RED';

    // 3. Evaluation logic matching evaluateArenaModelsOnSettledRound
    const locked = aiPredictionMap[period];
    assert.ok(locked);
    const evaluatedTarget = locked.target; // 'BIG'
    const evaluatedType = locked.type;     // 'SIZE'
    const won = evaluatedTarget === actualSize;
    assert.equal(won, true);

    // Save to history
    history.push({
      period,
      number,
      size: actualSize,
      color: actualColor,
      aiTarget: evaluatedTarget,
      aiType: evaluatedType,
      aiCorrect: won
    });

    // 4. Verify history row strictly matches AI In-Charge target and outcome
    assert.equal(history[0].aiTarget, 'BIG');
    assert.equal(history[0].aiType, 'SIZE');
    assert.equal(history[0].aiCorrect, true);
  });

  // ══════════════════════════════════════════════════════════════════
  // Strict Win Rate Model Rating & Authoritative In-Charge Selection
  // ══════════════════════════════════════════════════════════════════
  function determineOptimalArenaInChargeModel(models, manualId, isAutoMode = true) {
    if (!Array.isArray(models) || models.length === 0) return null;

    if (isAutoMode === false && manualId) {
      const manual = models.find(m => m.id === manualId || m.name === manualId);
      if (manual) return { model: manual, mode: 'MANUAL_LOCK', reason: `Manual Lock: ${manual.name}` };
    }

    const getStreak = m => Number(m.streak !== undefined ? m.streak : 0);
    const getEvaluated = m => Number(m.totalEvaluated !== undefined ? m.totalEvaluated : (m.evaluated || 0));
    const getWinRate = m => {
      if (m.winRate !== undefined) return Number(m.winRate);
      if (m.winRatePct) return parseFloat(m.winRatePct) / 100;
      return 0;
    };

    // Strict Win Rate Rating Ranking:
    // Models are rated and in-charge champion is selected strictly upon Win Rate
    const sortedByWinRate = [...models].sort((a, b) => {
      const wrA = getWinRate(a);
      const wrB = getWinRate(b);
      if (wrB !== wrA) return wrB - wrA; // Highest Win Rate first
      const evA = getEvaluated(a);
      const evB = getEvaluated(b);
      if (evB !== evA) return evB - evA; // Tie-breaker 1: Total evaluated rounds
      const sA = getStreak(a);
      const sB = getStreak(b);
      if (sB !== sA) return sB - sA; // Tie-breaker 2: Active streak
      const wA = Number(a.wins || 0);
      const wB = Number(b.wins || 0);
      if (wB !== wA) return wB - wA; // Tie-breaker 3: Total wins
      return (a.name || '').localeCompare(b.name || '');
    });

    const best = sortedByWinRate[0] || models[0];
    return {
      model: best,
      mode: 'HIGHEST_WIN_RATE',
      reason: `👑 ${best.name} (${(getWinRate(best) * 100).toFixed(1)}% WR · ${best.wins || 0}W / ${best.losses || 0}L)`
    };
  }

  await t.test('Model rating and In-Charge champion selection is strictly ranked upon Win Rate', () => {
    const models = [
      { id: 'VETERAN_WR', name: 'Veteran WR Champion', winRate: 0.85, streak: 0, evaluated: 50, wins: 42, losses: 8, predTarget: 'RED', predType: 'COLOR', num: 8 },
      { id: 'HOT_STREAK_MODEL', name: 'Hot Streak Model', winRate: 0.68, streak: 4, evaluated: 25, wins: 17, losses: 8, predTarget: 'GREEN', predType: 'COLOR', num: 7 },
      { id: 'AVERAGE_MODEL', name: 'Average Model', winRate: 0.50, streak: 1, evaluated: 20, wins: 10, losses: 10, predTarget: 'BIG', predType: 'SIZE', num: 6 }
    ];

    const selection = determineOptimalArenaInChargeModel(models, null, true);
    assert.equal(selection.mode, 'HIGHEST_WIN_RATE');
    assert.equal(selection.model.id, 'VETERAN_WR');
    assert.equal(selection.model.winRate, 0.85);
    assert.equal(selection.model.predTarget, 'RED');
  });

  await t.test('When win rates shift, leadership strictly passes to the new highest win rate model', () => {
    const models = [
      { id: 'FORMER_LEADER', name: 'Former Leader', winRate: 0.72, streak: 1, evaluated: 50, wins: 36, losses: 14, predTarget: 'RED', predType: 'COLOR', num: 8 },
      { id: 'NEW_WR_CHAMPION', name: 'New WR Champion', winRate: 0.82, streak: 2, evaluated: 30, wins: 25, losses: 5, predTarget: 'BIG', predType: 'SIZE', num: 9 },
      { id: 'HOT_STREAK_MODEL', name: 'Hot Streak Model', winRate: 0.65, streak: 5, evaluated: 26, wins: 17, losses: 9, predTarget: 'GREEN', predType: 'COLOR', num: 7 }
    ];

    const selection = determineOptimalArenaInChargeModel(models, null, true);
    assert.equal(selection.mode, 'HIGHEST_WIN_RATE');
    assert.equal(selection.model.id, 'NEW_WR_CHAMPION');
    assert.equal(selection.model.winRate, 0.82);
    assert.equal(selection.model.predTarget, 'BIG');
  });

  await t.test('Ties in Win Rate are resolved by total evaluated rounds, active streak, and total wins', () => {
    const models = [
      { id: 'TIED_ROUNDS_FEWER', name: 'Tied Fewer Rounds', winRate: 0.75, streak: 1, evaluated: 20, wins: 15, losses: 5, predTarget: 'SMALL' },
      { id: 'TIED_ROUNDS_MORE', name: 'Tied More Rounds', winRate: 0.75, streak: 1, evaluated: 40, wins: 30, losses: 10, predTarget: 'BIG' }
    ];

    const selection = determineOptimalArenaInChargeModel(models, null, true);
    assert.equal(selection.mode, 'HIGHEST_WIN_RATE');
    assert.equal(selection.model.id, 'TIED_ROUNDS_MORE');
    assert.equal(selection.model.evaluated, 40);
  });

  await t.test('Manual mode override strictly locks chosen model regardless of win rate', () => {
    const models = [
      { id: 'TOP_WR_MODEL', name: 'Top WR Model', winRate: 0.88, streak: 2, evaluated: 50, wins: 44, losses: 6 },
      { id: 'MANUAL_CHOICE', name: 'Manual Choice Model', winRate: 0.55, streak: -1, evaluated: 20, wins: 11, losses: 9 }
    ];

    const selection = determineOptimalArenaInChargeModel(models, 'MANUAL_CHOICE', false);
    assert.equal(selection.mode, 'MANUAL_LOCK');
    assert.equal(selection.model.id, 'MANUAL_CHOICE');
  });

  await t.test('Individual AI Model Win Rate reset sets stats to 0% and starts fresh rating calculation without altering global data', () => {
    // 1. Initial global model performance
    const globalCatalog = [
      { id: 'MODEL_A', name: 'Model A', winRate: 0.80, wins: 40, losses: 10, streak: 3 },
      { id: 'MODEL_B', name: 'Model B', winRate: 0.70, wins: 35, losses: 15, streak: 1 }
    ];

    // 2. User performs personal reset:
    const userStats = {};
    globalCatalog.forEach(m => {
      userStats[m.id] = {
        id: m.id,
        name: m.name,
        wins: 0,
        losses: 0,
        totalEvaluated: 0,
        streak: 0,
        winRate: 0,
        winRatePct: '0.0%',
        historyPath: []
      };
    });

    // Verify all models become 0%
    Object.values(userStats).forEach(s => {
      assert.equal(s.winRate, 0);
      assert.equal(s.wins, 0);
      assert.equal(s.losses, 0);
      assert.equal(s.winRatePct, '0.0%');
    });

    // Global catalog remains intact (not modified on server)
    assert.equal(globalCatalog[0].winRate, 0.80);
    assert.equal(globalCatalog[0].wins, 40);

    // 3. New round settles after reset: MODEL_B predicts correctly, MODEL_A misses
    userStats['MODEL_B'].wins += 1;
    userStats['MODEL_B'].totalEvaluated += 1;
    userStats['MODEL_B'].winRate = 1.0;
    userStats['MODEL_B'].winRatePct = '100.0%';
    userStats['MODEL_B'].streak = 1;

    userStats['MODEL_A'].losses += 1;
    userStats['MODEL_A'].totalEvaluated += 1;
    userStats['MODEL_A'].winRate = 0.0;
    userStats['MODEL_A'].winRatePct = '0.0%';
    userStats['MODEL_A'].streak = -1;

    // Leaderboard re-ranks based strictly on new individual ratings: MODEL_B takes #1 with 100%!
    const updatedSelection = determineOptimalArenaInChargeModel(Object.values(userStats), null, true);
    assert.equal(updatedSelection.model.id, 'MODEL_B');
    assert.equal(updatedSelection.model.winRate, 1.0);
  });

  // ══════════════════════════════════════════════════════════════════
  // Canonical Correctness: Loss is NEVER reported as Win
  // ══════════════════════════════════════════════════════════════════
  function evaluatePredictionCorrectness(target, numVal, sizeVal, colorVal) {
    if (!target || target === 'TESTING' || target === 'WAITING...' || target === '—') return null;
    const t = String(target).trim().toUpperCase();

    if (t === 'BIG' || t === 'SMALL') {
      if (!sizeVal) return null;
      return t === String(sizeVal).trim().toUpperCase();
    }

    if (t === 'GREEN') {
      const n = parseInt(numVal, 10);
      if (!isNaN(n)) return [1, 3, 5, 7, 9].includes(n);
      if (colorVal) return String(colorVal).toUpperCase().includes('GREEN');
      return null;
    }
    if (t === 'RED') {
      const n = parseInt(numVal, 10);
      if (!isNaN(n)) return [0, 2, 4, 6, 8].includes(n);
      if (colorVal) return String(colorVal).toUpperCase().includes('RED');
      return null;
    }

    const targetDigit = parseInt(t, 10);
    if (!isNaN(targetDigit)) {
      const actDigit = parseInt(numVal, 10);
      if (!isNaN(actDigit)) return targetDigit === actDigit;
    }

    return null;
  }

  await t.test('evaluatePredictionCorrectness never reports WIN after a LOSS', () => {
    // 1. Predicted BIG, but result was SMALL (number 2, RED) -> MUST BE FALSE
    assert.equal(evaluatePredictionCorrectness('BIG', 2, 'SMALL', 'RED'), false);

    // 2. Predicted BIG, but result was SMALL (number 0, RED+VIOLET) -> MUST BE FALSE
    assert.equal(evaluatePredictionCorrectness('BIG', 0, 'SMALL', 'RED'), false);

    // 3. Predicted SMALL, but result was BIG (number 8, RED) -> MUST BE FALSE
    assert.equal(evaluatePredictionCorrectness('SMALL', 8, 'BIG', 'RED'), false);

    // 4. Predicted GREEN, but result was RED (number 8, BIG, RED) -> MUST BE FALSE
    assert.equal(evaluatePredictionCorrectness('GREEN', 8, 'BIG', 'RED'), false);

    // 5. Predicted RED, but result was GREEN (number 7, BIG, GREEN) -> MUST BE FALSE
    assert.equal(evaluatePredictionCorrectness('RED', 7, 'BIG', 'GREEN'), false);

    // 6. Predicted GREEN on 5 (GREEN+VIOLET) -> MUST BE TRUE
    assert.equal(evaluatePredictionCorrectness('GREEN', 5, 'BIG', 'GREEN'), true);

    // 7. Predicted RED on 0 (RED+VIOLET) -> MUST BE TRUE
    assert.equal(evaluatePredictionCorrectness('RED', 0, 'SMALL', 'RED'), true);

    // 8. Predicted BIG on 7 (BIG) -> MUST BE TRUE
    assert.equal(evaluatePredictionCorrectness('BIG', 7, 'BIG', 'GREEN'), true);

    // 9. Predicted SMALL on 3 (SMALL) -> MUST BE TRUE
    assert.equal(evaluatePredictionCorrectness('SMALL', 3, 'SMALL', 'GREEN'), true);
  });

  await t.test('In-Charge prediction, AI Signal target, and History AI Single strictly match and correctly show LOSS', () => {
    const inChargeModel = { id: 'CHAMP_AI', name: 'Champ AI', predTarget: 'BIG', predType: 'SIZE', num: 8 };

    // 1. AI Signal matches In-Charge Model
    const aiSignal = {
      target: inChargeModel.predTarget,
      type: inChargeModel.predType,
      num: inChargeModel.num
    };
    assert.equal(aiSignal.target, 'BIG');

    // 2. Pre-draw lock in prediction map
    const period = '20260927010001';
    const aiPredictionMap = {
      [period]: { target: aiSignal.target, type: aiSignal.type }
    };

    // 3. Round settles with Number 3 (SMALL, GREEN) -> AI Predicted BIG so it LOST!
    const settledNumber = 3;
    const settledSize = 'SMALL';
    const settledColor = 'GREEN';

    const existingPred = aiPredictionMap[period];
    const aiMainTarget = existingPred.target; // 'BIG'
    const aiMainCorrect = evaluatePredictionCorrectness(aiMainTarget, settledNumber, settledSize, settledColor);

    // AI Main Correct MUST BE FALSE (LOSS)
    assert.equal(aiMainCorrect, false);

    // 4. Stored in history
    const historyRow = {
      period,
      number: settledNumber,
      size: settledSize,
      color: settledColor,
      aiTarget: aiMainTarget,
      aiCorrect: aiMainCorrect
    };

    // 5. History table row resolution
    const effectiveTarget = historyRow.aiTarget;
    const isCorrect = evaluatePredictionCorrectness(effectiveTarget, historyRow.number, historyRow.size, historyRow.color);

    // Verify all 3 match:
    assert.equal(inChargeModel.predTarget, 'BIG');
    assert.equal(aiSignal.target, 'BIG');
    assert.equal(effectiveTarget, 'BIG');
    assert.equal(isCorrect, false); // STRICTLY LOSS, NEVER WIN
  });

  await t.test('settleRoundOutcome strictly triggers LOSS on a miss and never triggers WIN first or duplicates', () => {
    const animationCalls = [];
    const MobileStateMock = {
      lastCelebratedPeriodByTf: { '30s': null },
      scheduledPredictionsByPeriod: {
        '30s': {
          '20260928100050350': { target: 'BIG', type: 'SIZE', color: 'RED' }
        }
      },
      activePrediction: { period: '20260928100050350', target: 'BIG', type: 'SIZE' },
      sim: { running: false }
    };

    function mockShowCelebration(isWin, target, number, size, period) {
      animationCalls.push({ isWin, target, number, size, period });
    }

    function mockSettleOutcome(tf, period, number, size, color, cloudRow, universalState) {
      const periodStr = String(period);
      if (MobileStateMock.lastCelebratedPeriodByTf[tf] === periodStr) {
        return; // Deduplication
      }

      let isWin = null;
      let target = null;

      if (cloudRow) {
        if (cloudRow.aiCorrect !== undefined && cloudRow.aiCorrect !== null) {
          isWin = !!cloudRow.aiCorrect;
        } else if (cloudRow.result === 'WIN' || cloudRow.result === 'LOSS') {
          isWin = (cloudRow.result === 'WIN');
        }
        if (cloudRow.aiTarget) target = cloudRow.aiTarget;
      }

      if (isWin === null && universalState && Array.isArray(universalState.inChargeHistoryPath)) {
        const entry = universalState.inChargeHistoryPath.find(p => String(p.period) === periodStr);
        if (entry) {
          isWin = !!entry.won;
          target = entry.predTarget;
        }
      }

      if (isWin === null || !target) {
        const scheduled = (MobileStateMock.scheduledPredictionsByPeriod?.[tf] || {})[periodStr];
        if (scheduled) {
          target = target || scheduled.target;
          if (isWin === null) {
            isWin = String(target).toUpperCase() === String(size).toUpperCase();
          }
        }
      }

      if (isWin === null || !target) {
        MobileStateMock.lastCelebratedPeriodByTf[tf] = periodStr;
        return;
      }

      MobileStateMock.lastCelebratedPeriodByTf[tf] = periodStr;
      mockShowCelebration(isWin, target, number, size, periodStr);
    }

    // Round 20260928100050350 settled with #3 (SMALL, GREEN). In-charge predicted BIG.
    const roundPeriod = '20260928100050350';
    const settledNum = 3;
    const settledSize = 'SMALL';
    const settledColor = 'GREEN';

    // 1. First event arrives from direct lottery fetch (missing aiCorrect)
    mockSettleOutcome('30s', roundPeriod, settledNum, settledSize, settledColor, {
      period: roundPeriod,
      number: settledNum,
      size: settledSize,
      color: settledColor
    }, null);

    // 2. Second event arrives from Firebase RTDB live_history (with aiCorrect: false)
    mockSettleOutcome('30s', roundPeriod, settledNum, settledSize, settledColor, {
      period: roundPeriod,
      number: settledNum,
      size: settledSize,
      color: settledColor,
      aiTarget: 'BIG',
      aiCorrect: false,
      result: 'LOSS'
    }, null);

    // 3. Third event arrives from universal_state
    mockSettleOutcome('30s', roundPeriod, settledNum, settledSize, settledColor, null, {
      inChargeHistoryPath: [
        { period: roundPeriod, predTarget: 'BIG', actual: 'SMALL', won: false }
      ]
    });

    // Verification:
    // Exactly ONE animation call was emitted across all 3 concurrent events
    assert.equal(animationCalls.length, 1);
    // The animation call is STRICTLY a LOSS, NEVER a WIN!
    assert.equal(animationCalls[0].isWin, false);
    assert.equal(animationCalls[0].target, 'BIG');
    assert.equal(animationCalls[0].period, roundPeriod);
  });

  await t.test('Accuracy audit resets on refresh, working reset button resets session, and calculates longest win/loss streaks', () => {
    const history = [
      { period: '20260928100050301', result: 'WIN', aiCorrect: true },
      { period: '20260928100050302', result: 'WIN', aiCorrect: true },
      { period: '20260928100050303', result: 'LOSS', aiCorrect: false },
      { period: '20260928100050304', result: 'LOSS', aiCorrect: false },
      { period: '20260928100050305', result: 'LOSS', aiCorrect: false },
      { period: '20260928100050306', result: 'WIN', aiCorrect: true }
    ];

    function calculateAudit(list, cutoff) {
      let wins = 0;
      let losses = 0;
      let maxWinStreak = 0;
      let maxLossStreak = 0;
      let curWinStreak = 0;
      let curLossStreak = 0;

      const sortedList = [...list].sort((a, b) => String(a.period).localeCompare(String(b.period)));
      sortedList.forEach(r => {
        if (cutoff && cutoff !== 'SESSION_START' && String(r.period) <= String(cutoff)) {
          return;
        }
        const isWin = r.aiCorrect !== undefined ? !!r.aiCorrect : (r.result === 'WIN');
        if (isWin) {
          wins++;
          curWinStreak++;
          curLossStreak = 0;
          if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
        } else {
          losses++;
          curLossStreak++;
          curWinStreak = 0;
          if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak;
        }
      });

      const total = wins + losses;
      const rate = total > 0 ? ((wins / total) * 100).toFixed(1) : '--';
      return { total, wins, losses, rate, maxWinStreak, maxLossStreak };
    }

    // 1. Initial Page Load / Refresh: Baseline set to latest historical period
    const loadCutoff = history[history.length - 1].period;
    const initialAudit = calculateAudit(history, loadCutoff);
    assert.equal(initialAudit.total, 0);
    assert.equal(initialAudit.wins, 0);
    assert.equal(initialAudit.losses, 0);
    assert.equal(initialAudit.rate, '--');
    assert.equal(initialAudit.maxWinStreak, 0);
    assert.equal(initialAudit.maxLossStreak, 0);

    // 2. Live rounds settle during the session:
    // Round 7 settles (WIN)
    history.push({ period: '20260928100050307', result: 'WIN', aiCorrect: true });
    // Round 8 settles (WIN)
    history.push({ period: '20260928100050308', result: 'WIN', aiCorrect: true });
    // Round 9 settles (WIN)
    history.push({ period: '20260928100050309', result: 'WIN', aiCorrect: true });
    // Round 10 settles (LOSS)
    history.push({ period: '20260928100050310', result: 'LOSS', aiCorrect: false });
    // Round 11 settles (LOSS)
    history.push({ period: '20260928100050311', result: 'LOSS', aiCorrect: false });

    const liveAudit = calculateAudit(history, loadCutoff);
    assert.equal(liveAudit.total, 5);
    assert.equal(liveAudit.wins, 3);
    assert.equal(liveAudit.losses, 2);
    assert.equal(liveAudit.rate, '60.0');
    assert.equal(liveAudit.maxWinStreak, 3);
    assert.equal(liveAudit.maxLossStreak, 2);

    // 3. User clicks "Reset": Sets cutoff to latest settled period ('...311')
    const resetCutoff = history[history.length - 1].period;
    const resetAudit = calculateAudit(history, resetCutoff);
    assert.equal(resetAudit.total, 0);
    assert.equal(resetAudit.wins, 0);
    assert.equal(resetAudit.losses, 0);
    assert.equal(resetAudit.rate, '--');
    assert.equal(resetAudit.maxWinStreak, 0);
    assert.equal(resetAudit.maxLossStreak, 0);

    // 4. Draw history itself is still completely preserved (11 rounds)
    assert.equal(history.length, 11);
  });

  await t.test('Hero AI Target Signal strictly matches In-Charge Model prediction across all modes', () => {
    const models = [
      { id: 'M1', name: 'Fly-01 Sensory Gate', predTarget: 'SMALL', predType: 'SIZE', predColor: 'RED', num: 2, conf: 0.82, winRate: 0.78, totalEvaluated: 50 },
      { id: 'M2', name: 'Deep Momentum', predTarget: 'BIG', predType: 'SIZE', predColor: 'GREEN', num: 7, conf: 0.88, winRate: 0.72, totalEvaluated: 40 },
      { id: 'M3', name: 'Color Wave Hunter', predTarget: 'GREEN', predType: 'COLOR', predColor: 'GREEN', num: 5, conf: 0.91, winRate: 0.65, totalEvaluated: 30 }
    ];

    // Helper simulating the synchronized resolution logic
    function resolveAuthoritativePrediction(models, inChargeName, autoMode, cloudUniversalState) {
      let activeName = inChargeName;
      if (autoMode) {
        activeName = cloudUniversalState?.inChargeModel || [...models].sort((a, b) => b.winRate - a.winRate)[0].name;
      }
      const inChargeObj = models.find(m => m.name === activeName || m.id === activeName) || models[0];
      return {
        target: inChargeObj.predTarget,
        type: inChargeObj.predType,
        color: inChargeObj.predColor,
        num: inChargeObj.num,
        modelName: inChargeObj.name
      };
    }

    // 1. Auto Mode: #1 model Fly-01 is In-Charge
    const autoResult = resolveAuthoritativePrediction(models, null, true, { inChargeModel: 'Fly-01 Sensory Gate', target: 'SMALL' });
    const inChargeAuto = models.find(m => m.name === autoResult.modelName);
    assert.equal(autoResult.modelName, 'Fly-01 Sensory Gate');
    assert.equal(autoResult.target, inChargeAuto.predTarget);
    assert.equal(autoResult.target, 'SMALL');

    // 2. Manual Lock Mode: User manually selects M2 Deep Momentum
    const manualResult = resolveAuthoritativePrediction(models, 'Deep Momentum', false, { inChargeModel: 'Fly-01 Sensory Gate', target: 'SMALL' });
    const inChargeManual = models.find(m => m.name === manualResult.modelName);
    assert.equal(manualResult.modelName, 'Deep Momentum');
    assert.equal(manualResult.target, inChargeManual.predTarget);
    assert.equal(manualResult.target, 'BIG');
    assert.notEqual(manualResult.target, 'SMALL'); // Must NOT be overridden by server state!

    // 3. User Selects Color Model M3
    const colorResult = resolveAuthoritativePrediction(models, 'Color Wave Hunter', false, { inChargeModel: 'Fly-01 Sensory Gate', target: 'SMALL' });
    const inChargeColor = models.find(m => m.name === colorResult.modelName);
    assert.equal(colorResult.modelName, 'Color Wave Hunter');
    assert.equal(colorResult.target, inChargeColor.predTarget);
    assert.equal(colorResult.target, 'GREEN');
    assert.equal(colorResult.type, 'COLOR');
  });
});



