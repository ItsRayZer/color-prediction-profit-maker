/**
 * Frozen Session leaderboard — settleRoundOutcome ReferenceError
 * (owner order 2026-11-08: "Rank not updatung", "Repeat until it fully works").
 *
 * Root cause found by full debug + live browser checks: on the live app
 * the Analyse Session leaderboard showed 0W/0L (user's phone) and frozen
 * 5W/3L counts (computer check 00:42-00:45 IST) while history verdicts,
 * accuracy, P&L and the prediction road all kept moving. The per-model
 * session scoring never ran because settleRoundOutcome threw on every
 * round: `_hadTargetBeforeReplay` was declared with const INSIDE the
 * `if (isWin === null || !target)` replay block but referenced AFTER it.
 * When an early priority already resolved BOTH target and isWin — the
 * normal case since PR #25, where Priority 0a (settled governed
 * verdict) provides pick + won — the block was skipped, the const never
 * existed, and the reference threw ReferenceError, killing the function
 * before it ever reached updateIndividualModelSettlement at the end.
 * History/P&L/accuracy kept working because they flow through
 * independent paths (fetch-tick restoration, orb-bridge settlement).
 * The fix declares the flag before the block; semantics unchanged.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { describe, it } from 'node:test';

const repo = new URL('..', import.meta.url).pathname;
const mobileSrc = fs.readFileSync(new URL('../mobile.js', import.meta.url), 'utf8');

function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = endMarker ? src.indexOf(endMarker, s) : src.length;
  assert.ok(s !== -1 && e !== -1, 'marker missing: ' + startMarker);
  return src.slice(s, e);
}

describe('settleRoundOutcome must not throw when an early priority resolves target + outcome', () => {
  it('_hadTargetBeforeReplay is declared before the replay if-block, not inside it', () => {
    const fn = sliceFn(mobileSrc, 'function settleRoundOutcome', 'window.settleRoundOutcome');
    const decl = fn.indexOf('const _hadTargetBeforeReplay');
    const ifBlock = fn.indexOf('if (isWin === null || !target) {');
    const use = fn.indexOf("if (!_hadTargetBeforeReplay && target) targetSource = 'replay';");
    assert.ok(decl > 0 && ifBlock > 0 && use > 0, 'all three markers must exist');
    assert.ok(decl < ifBlock, 'the flag must be declared BEFORE the replay if-block');
    assert.ok(decl < use, 'the flag must be declared before its use');
  });

  it('a settled governed verdict (target + won) settles without throwing and scores the session', () => {
    const store = new Map();
    const localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    };
    const MobileState = {
      timeframe: '30s',
      historyByTf: { '30s': [] },
      modelPools: {},
      autoMode: false,
      cloudUniversalState: {},
      inchargeConfig: { predictionSource: 'LOCAL' },
      workerStateByTf: {},
      lastCelebratedPeriodByTf: { '30s': null },
      lastSettledPeriodByTf: {},
      scheduledPredictionsByPeriod: {},
      inChargeModel: null,
      inChargeByTf: {},
      sim: { running: false, pendingBet: null },
      activePrediction: null,
    };
    const sandbox = {
      console,
      localStorage,
      MobileState,
      window: null,
      self: null,
      modelWorker: null,
      MobileBridgeState: undefined,
      TimeframeManager: undefined,
      PatternIntelligence: undefined,
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    // Priority 0a: the orb-bridge settled verdict provides pick + won.
    sandbox.__o101SettledVerdict = (tf, period) => ({ pick: 'BIG', won: true });
    vm.createContext(sandbox);
    const arenaSrc = fs.readFileSync(repo + 'algorithms/arena_models.js', 'utf8');
    vm.runInContext(arenaSrc, sandbox);

    const evalPredSrc = sliceFn(mobileSrc, 'function evaluatePredictionCorrectness', 'window.evaluatePredictionCorrectness');
    const canonSrc = sliceFn(mobileSrc, 'function getCanonicalModelsForTf', 'window.getCanonicalModelsForTf');
    const settleIndSrc = sliceFn(mobileSrc, 'function updateIndividualModelSettlement', 'window.updateIndividualModelSettlement');
    const effSrc = sliceFn(mobileSrc, 'function getEffectiveModelList', 'window.getEffectiveModelList');
    const settleRoundSrc = sliceFn(mobileSrc, 'function settleRoundOutcome', 'window.settleRoundOutcome');
    const calcStreakSrc = sliceFn(mobileSrc, 'function calculateConsecutiveWinStreak', 'window.calculateConsecutiveWinStreak');
    vm.runInContext(`
      function $(id) { return null; }
      function showToast() {}
      function showWinLossCelebration() {}
      function resolveSimBet() {}
      function calculateAndRenderMobileStake() {}
      function renderMobileWalletStats() {}
      function toggleMobileRealAutoBet() {}
      function renderModelRosterUI() {}
      function determineOptimalArenaInChargeModel() { return null; }
      function updatePredictionSourceUI() {}
      ${evalPredSrc}
      ; window.evaluatePredictionCorrectness = evaluatePredictionCorrectness;
      ${canonSrc}
      ; window.getCanonicalModelsForTf = getCanonicalModelsForTf;
      ${settleIndSrc}
      ; window.updateIndividualModelSettlement = updateIndividualModelSettlement;
      ${effSrc}
      ; window.getEffectiveModelList = getEffectiveModelList;
      ${calcStreakSrc}
      ${settleRoundSrc}
      ; window.settleRoundOutcome = settleRoundOutcome;
    `, sandbox);

    const tf = '30s';
    localStorage.setItem(`quant_user_ai_reset_${tf}`, '20261108000000001');
    localStorage.setItem(`quant_user_model_stats_${tf}`, JSON.stringify({}));
    for (let i = 0; i < 15; i++) {
      const n = (i * 7 + 3) % 10;
      MobileState.historyByTf[tf].push({ period: 'P' + String(1000 + i), number: n, size: n >= 5 ? 'BIG' : 'SMALL', color: n % 2 === 1 ? 'GREEN' : 'RED' });
    }
    // Settle 5 rounds the way the fetch tick does. Before the fix every
    // one of these threw `_hadTargetBeforeReplay is not defined`.
    for (let r = 0; r < 5; r++) {
      const n = (r * 3 + 1) % 10;
      const period = 'P' + String(1000 + 15 + r);
      const size = n >= 5 ? 'BIG' : 'SMALL';
      const color = n % 2 === 1 ? 'GREEN' : 'RED';
      MobileState.historyByTf[tf].push({ period, number: n, size, color });
      assert.doesNotThrow(() => sandbox.settleRoundOutcome(tf, period, n, size, color, null, null), 'settleRoundOutcome must not throw on a governed settled verdict');
    }
    const map = JSON.parse(localStorage.getItem(`quant_user_model_stats_${tf}`));
    assert.equal(Object.keys(map).length, 142, 'session map must hold all 142 models');
    const scored = Object.values(map).filter((m) => m.totalEvaluated > 0).length;
    assert.ok(scored >= 130, `most models must be scored after 5 rounds (got ${scored})`);
    const top = sandbox.getEffectiveModelList(tf)[0];
    assert.ok(top.sessionEvaluated > 0, 'leaderboard must read a non-zero session evaluation count');
  });
});
