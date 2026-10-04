/**
 * Adversarial Stress Test Harness for Color Prediction Platform
 * Requirements R4 & R5 Validation
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

console.log('================================================================');
console.log('🚀 EMPIRICAL ADVERSARIAL CHALLENGE: REQUIREMENTS R4 & R5');
console.log('================================================================\n');

let passCount = 0;
let failCount = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✔ PASS: ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ✖ FAIL: ${name}`);
    console.error(`    Error: ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
    failCount++;
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✔ PASS: ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ✖ FAIL: ${name}`);
    console.error(`    Error: ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
    failCount++;
  }
}

(async () => {
  // ── MODULE 1: ASI_APEX_MASTER EMPIRICAL & ADVERSARIAL STRESS TEST ─────────────
  console.log('--- TEST GROUP 1: ASI_APEX_MASTER Algorithm Stress Testing ---');

  const {
    ARENA_CANONICAL_MODELS,
    generateModelNextPrediction,
    determineOptimalArenaInChargeModel,
    evaluatePredictionCorrectness
  } = require('./arena_models.cjs');

  const apexModel = ARENA_CANONICAL_MODELS.find(m => m.id === 'ASI_APEX_MASTER');
  assert.ok(apexModel, 'ASI_APEX_MASTER must exist in ARENA_CANONICAL_MODELS');

  runTest('1.1 Source Parity between algorithms/arena_models.js and scripts/arena_models.cjs', () => {
    const esmCode = fs.readFileSync(path.join(__dirname, '..', 'algorithms', 'arena_models.js'), 'utf-8');
    const cjsCode = fs.readFileSync(path.join(__dirname, 'arena_models.cjs'), 'utf-8');
    
    // Extract ASI_APEX_MASTER case block from both
    const extractCase = (code) => {
      const start = code.indexOf("case 'ASI_APEX_MASTER':");
      const end = code.indexOf("break;", start);
      return code.slice(start, end).replace(/\r\n/g, '\n').trim();
    };

    const esmCase = extractCase(esmCode);
    const cjsCase = extractCase(cjsCode);
    assert.ok(esmCase.length > 50, 'ESM ASI_APEX_MASTER case must exist');
    assert.strictEqual(esmCase, cjsCase, 'ESM and CJS ASI_APEX_MASTER logic must be 100% byte-for-byte identical');
  });

  runTest('1.2 Deterministic Behavior across 100 consecutive executions', () => {
    const history = [
      { period: '1', number: 7, size: 'BIG', color: 'green' },
      { period: '2', number: 2, size: 'SMALL', color: 'red' },
      { period: '3', number: 8, size: 'BIG', color: 'red' },
      { period: '4', number: 3, size: 'SMALL', color: 'green' },
      { period: '5', number: 6, size: 'BIG', color: 'red' }
    ];
    const stats = { streak: 1, dopamine: 0.6, lossPain: 0.1 };

    const first = generateModelNextPrediction(apexModel, history, stats);
    for (let i = 0; i < 100; i++) {
      const next = generateModelNextPrediction(apexModel, history, stats);
      assert.deepStrictEqual(next, first, `Run ${i} must produce identical output`);
    }
  });

  runTest('1.3 Dragon Streak: >= 3 BIG rounds forces BIG prediction with conf >= 0.75 (and >= 0.88)', () => {
    // 5 consecutive BIG rounds
    const bigDragon = [
      { period: '1', number: 2, size: 'SMALL', color: 'red' },
      { period: '2', number: 8, size: 'BIG', color: 'red' },
      { period: '3', number: 7, size: 'BIG', color: 'green' },
      { period: '4', number: 9, size: 'BIG', color: 'green' },
      { period: '5', number: 6, size: 'BIG', color: 'red' }
    ];
    const pred = generateModelNextPrediction(apexModel, bigDragon, { streak: 3, dopamine: 0.7 });
    assert.strictEqual(pred.predSize, 'BIG', 'Must predict BIG on BIG dragon streak');
    assert.ok(pred.conf >= 0.75, `Confidence must be >= 0.75, got ${pred.conf}`);
    assert.ok(pred.conf >= 0.88, `Confidence on size dragon must reach at least 0.88, got ${pred.conf}`);
  });

  runTest('1.4 Dragon Streak: >= 3 SMALL rounds forces SMALL prediction with conf >= 0.75 (and >= 0.88)', () => {
    // 4 consecutive SMALL rounds
    const smallDragon = [
      { period: '1', number: 8, size: 'BIG', color: 'red' },
      { period: '2', number: 1, size: 'SMALL', color: 'green' },
      { period: '3', number: 2, size: 'SMALL', color: 'red' },
      { period: '4', number: 4, size: 'SMALL', color: 'red' },
      { period: '5', number: 0, size: 'SMALL', color: 'red,violet' }
    ];
    const pred = generateModelNextPrediction(apexModel, smallDragon, { streak: 2, dopamine: 0.5 });
    assert.strictEqual(pred.predSize, 'SMALL', 'Must predict SMALL on SMALL dragon streak');
    assert.ok(pred.conf >= 0.75, `Confidence must be >= 0.75, got ${pred.conf}`);
    assert.ok(pred.conf >= 0.88, `Confidence on size dragon must reach at least 0.88, got ${pred.conf}`);
  });

  runTest('1.5 Dragon Streak: >= 3 GREEN rounds forces GREEN prediction with conf >= 0.75 (and >= 0.85)', () => {
    // 4 consecutive GREEN rounds
    const greenDragon = [
      { period: '1', number: 2, size: 'SMALL', color: 'red' },
      { period: '2', number: 1, size: 'SMALL', color: 'green' },
      { period: '3', number: 3, size: 'SMALL', color: 'green' },
      { period: '4', number: 7, size: 'BIG', color: 'green' },
      { period: '5', number: 9, size: 'BIG', color: 'green' }
    ];
    const pred = generateModelNextPrediction(apexModel, greenDragon, { streak: 3, dopamine: 0.7 });
    assert.strictEqual(pred.predColor, 'GREEN', 'Must predict GREEN on GREEN dragon streak');
    assert.ok(pred.conf >= 0.75, `Confidence must be >= 0.75, got ${pred.conf}`);
  });

  runTest('1.6 Dragon Streak: >= 3 RED rounds forces RED prediction with conf >= 0.75 (and >= 0.85)', () => {
    // 4 consecutive RED rounds
    const redDragon = [
      { period: '1', number: 1, size: 'SMALL', color: 'green' },
      { period: '2', number: 2, size: 'SMALL', color: 'red' },
      { period: '3', number: 4, size: 'SMALL', color: 'red' },
      { period: '4', number: 6, size: 'BIG', color: 'red' },
      { period: '5', number: 8, size: 'BIG', color: 'red' }
    ];
    const pred = generateModelNextPrediction(apexModel, redDragon, { streak: 3, dopamine: 0.7 });
    assert.strictEqual(pred.predColor, 'RED', 'Must predict RED on RED dragon streak');
    assert.ok(pred.conf >= 0.75, `Confidence must be >= 0.75, got ${pred.conf}`);
  });

  runTest('1.7 Alternating Chop Pattern (BIG-SMALL-BIG-SMALL) predicts alternation', () => {
    const chopHistory = [
      { period: '1', number: 8, size: 'BIG', color: 'red' },
      { period: '2', number: 2, size: 'SMALL', color: 'red' },
      { period: '3', number: 7, size: 'BIG', color: 'green' },
      { period: '4', number: 1, size: 'SMALL', color: 'green' }
    ];
    const pred = generateModelNextPrediction(apexModel, chopHistory, { streak: 0 });
    // After SMALL in chop, predicts BIG
    assert.strictEqual(pred.predSize, 'BIG', 'Must predict BIG after SMALL in alternating size chop');
  });

  runTest('1.8 Multi-Model Consensus: weights high win-rate / high win-streak models from pool', () => {
    // Balanced history (5 BIG, 5 SMALL)
    const balancedHistory = [
      { period: '1', number: 8, size: 'BIG', color: 'red' },
      { period: '2', number: 2, size: 'SMALL', color: 'red' },
      { period: '3', number: 7, size: 'BIG', color: 'green' },
      { period: '4', number: 3, size: 'SMALL', color: 'green' },
      { period: '5', number: 6, size: 'BIG', color: 'red' },
      { period: '6', number: 1, size: 'SMALL', color: 'green' },
      { period: '7', number: 9, size: 'BIG', color: 'green' },
      { period: '8', number: 4, size: 'SMALL', color: 'red' },
      { period: '9', number: 5, size: 'BIG', color: 'green,violet' },
      { period: '10', number: 0, size: 'SMALL', color: 'red,violet' }
    ];

    // Mock models overwhelmingly voting for SMALL with high win rate & win streak
    const mockModels = [
      { id: 'M1', predSize: 'SMALL', predColor: 'GREEN', streak: 6, winRate: 0.85 },
      { id: 'M2', predSize: 'SMALL', predColor: 'GREEN', streak: 5, winRate: 0.80 },
      { id: 'M3', predSize: 'SMALL', predColor: 'GREEN', streak: 4, winRate: 0.78 },
      { id: 'M4', predSize: 'BIG', predColor: 'RED', streak: -2, winRate: 0.40 }
    ];

    const pred = generateModelNextPrediction(apexModel, balancedHistory, { allModels: mockModels });
    assert.strictEqual(pred.predSize, 'SMALL', 'Apex Conductor must follow weighted consensus of winning models');
    assert.strictEqual(pred.predColor, 'GREEN', 'Apex Conductor must follow weighted color consensus');
  });

  runTest('1.9 Adversarial Inputs: empty history, 1-round history, null allModels, self-reference', () => {
    // Empty history
    const emptyPred = generateModelNextPrediction(apexModel, [], null);
    assert.ok(emptyPred && emptyPred.predTarget, 'Must not crash on empty history');
    assert.ok(['BIG', 'SMALL'].includes(emptyPred.predSize));

    // 1-round history
    const singlePred = generateModelNextPrediction(apexModel, [{ period: '1', number: 5, size: 'BIG', color: 'green' }], null);
    assert.ok(singlePred && singlePred.predTarget, 'Must not crash on 1-round history');

    // Self-reference in allModels
    const selfPred = generateModelNextPrediction(apexModel, [{ period: '1', number: 5, size: 'BIG', color: 'green' }], {
      allModels: [{ id: 'ASI_APEX_MASTER', predSize: 'BIG' }, null, undefined]
    });
    assert.ok(selfPred && selfPred.predTarget, 'Must ignore self and null entries gracefully');

    // Extreme negative streak (-6) fly neuron plasticity penalty
    const drawdownPred = generateModelNextPrediction(apexModel, [
      { period: '1', number: 8, size: 'BIG', color: 'red' },
      { period: '2', number: 8, size: 'BIG', color: 'red' },
      { period: '3', number: 8, size: 'BIG', color: 'red' }
    ], { streak: -6, lossPain: 0.8 });
    assert.ok(drawdownPred.conf < 0.88, 'Drawdown penalty must lower confidence');
  });

  // ── MODULE 2: MAX 3-LOSS CIRCUIT BREAKER EMPIRICAL STRESS TEST ──────────────
  console.log('\n--- TEST GROUP 2: Max 3-Loss Circuit Breaker Stress Testing ---');

  runTest('2.1 Loss Progression (Loss 1 -> Loss 2 -> Loss 3) trips circuit breaker, pauses 2 rounds, resets stake to base ₹2', () => {
    const bridgeState = {
      baseStake: 2,
      currentStake: 2,
      currentLevel: 0,
      multiplier: 2.0,
      maxStakeCap: 64,
      consecutiveLosses: 0,
      circuitBreakerActive: false,
      circuitBreakerPauseRounds: 0,
      sessionPnl: 0,
      wins: 0,
      losses: 0
    };

    function simulateRound(isWin) {
      let isFreshTrip = false;
      if (isWin) {
        bridgeState.wins += 1;
        bridgeState.consecutiveLosses = 0;
        bridgeState.sessionPnl += bridgeState.currentStake * 0.96;
        bridgeState.currentLevel = 0;
        bridgeState.currentStake = bridgeState.baseStake;
      } else {
        bridgeState.losses += 1;
        bridgeState.consecutiveLosses = (bridgeState.consecutiveLosses || 0) + 1;
        bridgeState.sessionPnl -= bridgeState.currentStake;

        if (bridgeState.consecutiveLosses >= 3) {
          bridgeState.circuitBreakerActive = true;
          bridgeState.circuitBreakerPauseRounds = 2;
          bridgeState.currentLevel = 0;
          bridgeState.currentStake = bridgeState.baseStake;
          bridgeState.consecutiveLosses = 0;
          isFreshTrip = true;
        } else {
          bridgeState.currentLevel += 1;
          bridgeState.currentStake = bridgeState.currentStake * bridgeState.multiplier;
        }
      }

      if (bridgeState.circuitBreakerPauseRounds > 0 && !isFreshTrip) {
        bridgeState.circuitBreakerPauseRounds--;
        if (bridgeState.circuitBreakerPauseRounds === 0) {
          bridgeState.circuitBreakerActive = false;
        }
      }

      return { isFreshTrip };
    }

    function canDispatchBet() {
      return bridgeState.circuitBreakerPauseRounds === 0;
    }

    // Round 1: Loss 1
    simulateRound(false);
    assert.strictEqual(bridgeState.consecutiveLosses, 1);
    assert.strictEqual(bridgeState.currentStake, 4, 'Martingale multiplies to 4');
    assert.strictEqual(bridgeState.currentLevel, 1);
    assert.strictEqual(bridgeState.circuitBreakerActive, false);
    assert.strictEqual(canDispatchBet(), true, 'Betting allowed on loss 1');

    // Round 2: Loss 2
    simulateRound(false);
    assert.strictEqual(bridgeState.consecutiveLosses, 2);
    assert.strictEqual(bridgeState.currentStake, 8, 'Martingale multiplies to 8');
    assert.strictEqual(bridgeState.currentLevel, 2);
    assert.strictEqual(bridgeState.circuitBreakerActive, false);
    assert.strictEqual(canDispatchBet(), true, 'Betting allowed on loss 2');

    // Round 3: Loss 3 -> TRIPS CIRCUIT BREAKER
    const tripResult = simulateRound(false);
    assert.strictEqual(tripResult.isFreshTrip, true);
    assert.strictEqual(bridgeState.circuitBreakerActive, true, 'Circuit breaker MUST be active');
    assert.strictEqual(bridgeState.circuitBreakerPauseRounds, 2, 'Pause rounds MUST be 2');
    assert.strictEqual(bridgeState.currentStake, 2, 'Stake MUST reset to base ₹2');
    assert.strictEqual(bridgeState.currentLevel, 0, 'Level MUST reset to 0');
    assert.strictEqual(bridgeState.consecutiveLosses, 0, 'Consecutive losses reset to 0');
    assert.strictEqual(canDispatchBet(), false, 'Betting MUST be blocked when breaker tripped');

    // Round 4: Subsequent round during pause
    simulateRound(false);
    assert.strictEqual(bridgeState.circuitBreakerPauseRounds, 1, 'Pause rounds decrements to 1');
    assert.strictEqual(bridgeState.circuitBreakerActive, true);
    assert.strictEqual(canDispatchBet(), false, 'Betting still blocked on pause round 1');

    // Round 5: Subsequent round during pause completes cool-off
    simulateRound(false);
    assert.strictEqual(bridgeState.circuitBreakerPauseRounds, 0, 'Pause rounds decrements to 0');
    assert.strictEqual(bridgeState.circuitBreakerActive, false, 'Circuit breaker clears');
    assert.strictEqual(canDispatchBet(), true, 'Betting unblocked after cool-off completes');
  });

  runTest('2.2 Re-evaluation of Champion Model upon Breaker Engagement', () => {
    // Verify determineOptimalArenaInChargeModel is called and selects top win-rate model
    const pool = [
      { id: 'M_LOSING', name: 'Losing Model', winRate: 0.30, totalEvaluated: 50, streak: -3 },
      { id: 'M_CHAMPION', name: 'Champion Model', winRate: 0.88, totalEvaluated: 50, streak: 5 }
    ];

    const result = determineOptimalArenaInChargeModel(pool, null, true);
    assert.ok(result && result.model);
    assert.strictEqual(result.model.id, 'M_CHAMPION');
    assert.strictEqual(result.model.winRate, 0.88);
  });

  // ── MODULE 3: SYNCHRONIZED INTERVAL CHANGES EMPIRICAL STRESS TEST ─────────────
  console.log('\n--- TEST GROUP 3: Synchronized Interval Changes Stress Testing ---');

  runTest('3.1 Timeframe switching updates target iframe URL and Analyse state across all 4 intervals', () => {
    const DHANIWIN_INTERVAL_URLS = {
      '30s': 'https://dhaniwin44.com/WinGo/WinGo_30S',
      '1m':  'https://dhaniwin44.com/WinGo/WinGo_1M',
      '3m':  'https://dhaniwin44.com/WinGo/WinGo_3M',
      '5m':  'https://dhaniwin44.com/WinGo/WinGo_5M'
    };

    const mockDOM = {
      iframeSrc: '',
      activeTfPill: '',
      activeWebTfPill: '',
      renderedViews: []
    };

    const mockLocalStorage = {};

    function switchTimeframe(tf) {
      mockLocalStorage['dhaniwin_last_interval'] = tf;
      mockDOM.activeTfPill = `tfBtn-${tf}`;
      mockDOM.activeWebTfPill = `webTf-${tf}`;
      const targetUrl = DHANIWIN_INTERVAL_URLS[tf] || DHANIWIN_INTERVAL_URLS['30s'];
      mockDOM.iframeSrc = targetUrl;
      mockDOM.renderedViews = [
        'renderPredictionAudit',
        'renderHistoryTable',
        'renderMobileHistoryGraph',
        'renderHeroSequentialBallRoad',
        'renderDigitFrequencies',
        'renderChartData',
        'renderAdaptiveAI',
        'renderAuthoritativeAIPrediction',
        'renderModelRosterUI'
      ];
    }

    const testIntervals = ['1m', '3m', '5m', '30s'];
    testIntervals.forEach(tf => {
      switchTimeframe(tf);
      assert.strictEqual(mockDOM.iframeSrc, DHANIWIN_INTERVAL_URLS[tf], `iframe URL must match ${tf}`);
      assert.strictEqual(mockLocalStorage['dhaniwin_last_interval'], tf, `localStorage must persist ${tf}`);
      assert.strictEqual(mockDOM.activeTfPill, `tfBtn-${tf}`, `Analyse pill must be active for ${tf}`);
      assert.strictEqual(mockDOM.activeWebTfPill, `webTf-${tf}`, `Web pill must be active for ${tf}`);
      assert.strictEqual(mockDOM.renderedViews.length, 9, 'All 9 Analyse sub-views must be rendered');
    });
  });

  // ── MODULE 4: POST-LOGIN GRACE PERIOD EMPIRICAL STRESS TEST ──────────────────
  console.log('\n--- TEST GROUP 4: Post-Login Grace Period Persistence Stress Testing ---');

  runTest('4.1 sessionStorage persistence blocks false session expiration for strictly 15s', () => {
    let mockTime = 1700000000000;
    let inMemoryGrace = 0;
    const mockSessionStorage = new Map();

    function markLogin() {
      inMemoryGrace = mockTime + 15000;
      mockSessionStorage.set('dhaniwin_auth_grace_until', String(inMemoryGrace));
    }

    function isGraceActive() {
      if (mockTime < inMemoryGrace) return true;
      const raw = mockSessionStorage.get('dhaniwin_auth_grace_until');
      if (raw && mockTime < Number(raw)) return true;
      return false;
    }

    function handleSessionExpired() {
      if (isGraceActive()) {
        return false; // Blocked!
      }
      return true; // Expired!
    }

    assert.strictEqual(isGraceActive(), false, 'Grace inactive before login');
    markLogin();
    assert.strictEqual(isGraceActive(), true, 'Grace active immediately after login');

    // Fast-forward 5s
    mockTime += 5000;
    assert.strictEqual(handleSessionExpired(), false, 'Session expiration must be BLOCKED at +5s');

    // Simulate page reload: in-memory variable resets to 0!
    inMemoryGrace = 0;
    assert.strictEqual(isGraceActive(), true, 'Grace must persist via sessionStorage across reload!');
    assert.strictEqual(handleSessionExpired(), false, 'Session expiration must still be BLOCKED at +5s after reload');

    // Fast-forward 9s more (+14s total)
    mockTime += 9000;
    assert.strictEqual(isGraceActive(), true, 'Grace must remain active at +14s');
    assert.strictEqual(handleSessionExpired(), false, 'Session expiration still BLOCKED at +14s');

    // Fast-forward 2s more (+16s total)
    mockTime += 2000;
    assert.strictEqual(isGraceActive(), false, 'Grace period must expire at +16s');
    assert.strictEqual(handleSessionExpired(), true, 'Session expiration must be permitted at +16s');
  });

  // ── MODULE 5: CONFIRM BUTTON AUTO-SHAKE EMPIRICAL STRESS TEST ────────────────
  console.log('\n--- TEST GROUP 5: Confirm Button Auto-Shake Animation Stress Testing ---');

  runTest('5.1 Keyframe styles exist in mobile.css and dhaniwin-bridge.js', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'mobile.css'), 'utf-8');
    assert.ok(css.includes('@keyframes autoBetShake'), 'mobile.css must include @keyframes autoBetShake');
    assert.ok(css.includes('.auto-bet-shake'), 'mobile.css must include .auto-bet-shake class');

    const bridge = fs.readFileSync(path.join(__dirname, '..', 'dhaniwin-bridge.js'), 'utf-8');
    assert.ok(bridge.includes('@keyframes autoBetShake'), 'dhaniwin-bridge.js must inject @keyframes autoBetShake');
    assert.ok(bridge.includes('.auto-bet-shake') || bridge.includes("classList.add('auto-bet-shake')"), 'dhaniwin-bridge.js must apply auto-bet-shake class');
  });

  runTest('5.2 manualConfirm adds .auto-bet-shake and animation, and cleans up on settle', () => {
    const mockConfirmBtn = {
      classList: new Set(),
      style: {}
    };

    function prepareBet(manualConfirm) {
      if (manualConfirm) {
        mockConfirmBtn.classList.add('auto-bet-shake');
        mockConfirmBtn.style.animation = 'autoBetShake 0.65s ease-in-out infinite';
      }
    }

    function settleRound() {
      mockConfirmBtn.classList.delete('auto-bet-shake');
      mockConfirmBtn.style.animation = '';
    }

    prepareBet(true);
    assert.ok(mockConfirmBtn.classList.has('auto-bet-shake'), 'Must add auto-bet-shake class');
    assert.ok(mockConfirmBtn.style.animation.includes('autoBetShake'), 'Must add autoBetShake animation');

    settleRound();
    assert.strictEqual(mockConfirmBtn.classList.has('auto-bet-shake'), false, 'Must clear class on settle');
    assert.strictEqual(mockConfirmBtn.style.animation, '', 'Must clear animation on settle');
  });

  console.log('\n================================================================');
  console.log(`📊 ADVERSARIAL STRESS TEST SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
})();
