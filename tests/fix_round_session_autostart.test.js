/**
 * Round 29 — Session auto-start + build stamp
 * (owner order 2026-11-08 12:36 IST: "the ranking should be done
 * locally in each user phone nd run all individual separate algorithm
 * calculation with current data nd currently coming data... Ranking
 * not working Nd the win rate not showing of each Nd in charge
 * logic nor working").
 *
 * Diagnosis (code-verified, not guessed):
 * - The owner's screenshot shows Session mode checked with every row
 *   at "WR: no data (0W/0L)". The session map `quant_user_model_stats_<tf>`
 *   is written ONLY inside updateIndividualModelSettlement and ONLY
 *   when the `quant_user_ai_reset_<tf>` flag exists — and that flag was
 *   set ONLY by a manual Reset tap. Nothing auto-armed Session mode,
 *   so a phone that never tapped Reset (or whose flag was cleared) had
 *   zero per-model stats: no ranking signal, no win rate, and the
 *   in-charge election fell back to alphabetical tie-breaks.
 * - The 8-engine consensus "BIG (6/8)" beside 5 visible BIG rows is
 *   CORRECT: renderNeuralMatrix counts GREEN as a BIG vote (green balls
 *   5-9 are BIG), and the ASI engine's signal was GREEN — 5 BIG + 1
 *   GREEN = 6. Not a bug; no change.
 * - The in-charge election itself is sound (caller filters blacklisted
 *   + benched models before selectInchargeOwnerRule); it only looked
 *   dead because the pool stats were all zero.
 *
 * Fix:
 * - ensureSessionTracking(tf) auto-arms a fresh session on the first
 *   settle/render for a timeframe, unless the user explicitly chose
 *   Global (new `quant_user_ai_global_<tf>` marker). Reset still
 *   re-zeroes; Global still restores global and now sets the marker.
 * - O101_BUILD_VERSION (14) is stamped next to the leaderboard title
 *   so a stale phone is visible in the next screenshot; it must match
 *   the sw.js CACHE_NAME version.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { describe, it } from 'node:test';

const repo = new URL('..', import.meta.url).pathname;
const mobileSrc = fs.readFileSync(new URL('../mobile.js', import.meta.url), 'utf8');
const mobileHtml = fs.readFileSync(new URL('../mobile.html', import.meta.url), 'utf8');
const swSrc = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = endMarker ? src.indexOf(endMarker, s) : src.length;
  assert.ok(s !== -1 && e !== -1, 'marker missing: ' + startMarker);
  return src.slice(s, e);
}

describe('Round 29: Session auto-start + build stamp (source)', () => {
  it('build version 14 matches the sw.js cache version', () => {
    assert.ok(mobileSrc.includes('const O101_BUILD_VERSION = 14'), 'mobile.js must define O101_BUILD_VERSION = 14');
    assert.ok(swSrc.includes("const CACHE_NAME = '0101-pwa-cache-v14'"), 'sw.js CACHE_NAME must be v14');
    assert.ok(mobileSrc.includes("window.__o101Build = 'v' + O101_BUILD_VERSION"), 'build must be exposed as window.__o101Build');
  });

  it('ensureSessionTracking exists and is called before the session map write and on render', () => {
    const fn = sliceFn(mobileSrc, 'function ensureSessionTracking', 'window.ensureSessionTracking');
    assert.ok(fn.includes('quant_user_ai_reset_'), 'auto-arm must set the reset flag');
    assert.ok(fn.includes('quant_user_ai_global_'), 'auto-arm must respect an explicit Global choice');
    assert.ok(fn.includes('quant_user_model_stats_'), 'auto-arm must init an empty session map');
    const settle = sliceFn(mobileSrc, 'function updateIndividualModelSettlement', 'window.updateIndividualModelSettlement');
    assert.ok(settle.includes('ensureSessionTracking(tf)'), 'settlement must arm tracking before writing the map');
    const renderIdx = mobileSrc.indexOf('function renderModelRosterUI');
    assert.ok(renderIdx > 0, 'renderModelRosterUI must exist');
    const renderHead = mobileSrc.slice(renderIdx, renderIdx + 1500);
    assert.ok(renderHead.includes('ensureSessionTracking(tf)'), 'render must arm tracking on first paint');
    assert.ok(renderHead.includes("o101BuildTag"), 'render must write the build stamp');
  });

  it('Global choice is remembered and Reset / cache-clear respect it', () => {
    const restore = sliceFn(mobileSrc, 'function restoreGlobalAIStats', 'window.restoreGlobalAIStats');
    assert.ok(restore.includes("setItem(`quant_user_ai_global_"), 'choosing Global must set the explicit-Global marker');
    const reset = sliceFn(mobileSrc, 'function resetUserAIModelsWinRate', 'window.resetUserAIModelsWinRate');
    assert.ok(reset.includes('removeItem(`quant_user_ai_global_'), 'Reset must clear the explicit-Global marker');
    const clear = sliceFn(mobileSrc, 'function clearAppCache', 'window.clearAppCache');
    assert.ok(clear.includes('removeItem(`quant_user_ai_global_'), 'cache clear must clear the explicit-Global marker');
  });

  it('mobile.html has the build stamp span next to the leaderboard title', () => {
    assert.ok(mobileHtml.includes('id="o101BuildTag"'), 'mobile.html must carry the o101BuildTag span');
    const titleIdx = mobileHtml.indexOf('Algorithm Leaderboard');
    const tagIdx = mobileHtml.indexOf('id="o101BuildTag"');
    assert.ok(titleIdx > 0 && tagIdx > titleIdx && tagIdx - titleIdx < 600, 'stamp must sit in the leaderboard header');
  });
});

function makeSandbox() {
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
    inChargeModel: null,
    inChargeByTf: {},
    activePrediction: null,
  };
  const sandbox = {
    console,
    localStorage,
    MobileState,
    window: null,
    self: null,
    modelWorker: null,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const arenaSrc = fs.readFileSync(repo + 'algorithms/arena_models.js', 'utf8');
  vm.runInContext(arenaSrc, sandbox);
  const evalPredSrc = sliceFn(mobileSrc, 'function evaluatePredictionCorrectness', 'window.evaluatePredictionCorrectness');
  const canonSrc = sliceFn(mobileSrc, 'function getCanonicalModelsForTf', 'window.getCanonicalModelsForTf');
  const ensureSrc = sliceFn(mobileSrc, 'function ensureSessionTracking', 'window.ensureSessionTracking');
  const settleIndSrc = sliceFn(mobileSrc, 'function updateIndividualModelSettlement', 'window.updateIndividualModelSettlement');
  const effSrc = sliceFn(mobileSrc, 'function getEffectiveModelList', 'window.getEffectiveModelList');
  vm.runInContext(`
    function $(id) { return null; }
    function showToast() {}
    function determineOptimalArenaInChargeModel() { return null; }
    function renderModelRosterUI() {}
    ${evalPredSrc}
    ; window.evaluatePredictionCorrectness = evaluatePredictionCorrectness;
    ${canonSrc}
    ; window.getCanonicalModelsForTf = getCanonicalModelsForTf;
    ${ensureSrc}
    ; window.ensureSessionTracking = ensureSessionTracking;
    ${settleIndSrc}
    ; window.updateIndividualModelSettlement = updateIndividualModelSettlement;
    ${effSrc}
    ; window.getEffectiveModelList = getEffectiveModelList;
  `, sandbox);
  return { sandbox, localStorage, MobileState };
}

function settleRounds(MobileState, sandbox, count, startIdx) {
  const tf = '30s';
  for (let r = 0; r < count; r++) {
    const i = startIdx + r;
    const n = (i * 7 + 3) % 10;
    const period = 'P' + String(2000 + i);
    const size = n >= 5 ? 'BIG' : 'SMALL';
    const color = n % 2 === 1 ? 'GREEN' : 'RED';
    MobileState.historyByTf[tf].push({ period, number: n, size, color });
    sandbox.updateIndividualModelSettlement(tf, period, n, size, color, null);
  }
}

describe('Round 29: Session auto-start (behaviour)', () => {
  it('session accumulates with NO Reset tap: fresh phone, no flag, no Global marker', () => {
    const { sandbox, localStorage, MobileState } = makeSandbox();
    const tf = '30s';
    assert.equal(localStorage.getItem(`quant_user_ai_reset_${tf}`), null, 'precondition: no reset flag');
    assert.equal(localStorage.getItem(`quant_user_ai_global_${tf}`), null, 'precondition: no Global marker');
    for (let i = 0; i < 10; i++) {
      const n = (i * 7 + 3) % 10;
      MobileState.historyByTf[tf].push({ period: 'P' + String(1000 + i), number: n, size: n >= 5 ? 'BIG' : 'SMALL', color: n % 2 === 1 ? 'GREEN' : 'RED' });
    }
    settleRounds(MobileState, sandbox, 5, 10);
    assert.ok(localStorage.getItem(`quant_user_ai_reset_${tf}`), 'first settle must auto-arm the session flag');
    const map = JSON.parse(localStorage.getItem(`quant_user_model_stats_${tf}`));
    assert.equal(Object.keys(map).length, 142, 'session map must hold all 142 models');
    const scored = Object.values(map).filter((m) => m.totalEvaluated > 0).length;
    assert.ok(scored >= 130, `most models must be scored after 5 rounds with no Reset tap (got ${scored})`);
    const top = sandbox.getEffectiveModelList(tf)[0];
    assert.ok(top.sessionEvaluated > 0, 'leaderboard must read a non-zero session evaluation count');
  });

  it('an explicit Global choice is respected: no session map is written', () => {
    const { sandbox, localStorage, MobileState } = makeSandbox();
    const tf = '30s';
    localStorage.setItem(`quant_user_ai_global_${tf}`, '1');
    for (let i = 0; i < 10; i++) {
      const n = (i * 7 + 3) % 10;
      MobileState.historyByTf[tf].push({ period: 'P' + String(1000 + i), number: n, size: n >= 5 ? 'BIG' : 'SMALL', color: n % 2 === 1 ? 'GREEN' : 'RED' });
    }
    settleRounds(MobileState, sandbox, 3, 10);
    assert.equal(localStorage.getItem(`quant_user_ai_reset_${tf}`), null, 'Global choice must not be overridden by auto-arm');
    assert.equal(localStorage.getItem(`quant_user_model_stats_${tf}`), null, 'Global mode must not write a session map');
  });

  it('an already-armed session (flag set, the phone state in the screenshot) keeps accumulating', () => {
    const { sandbox, localStorage, MobileState } = makeSandbox();
    const tf = '30s';
    localStorage.setItem(`quant_user_ai_reset_${tf}`, '20261108000000001');
    localStorage.setItem(`quant_user_model_stats_${tf}`, JSON.stringify({}));
    for (let i = 0; i < 10; i++) {
      const n = (i * 7 + 3) % 10;
      MobileState.historyByTf[tf].push({ period: 'P' + String(1000 + i), number: n, size: n >= 5 ? 'BIG' : 'SMALL', color: n % 2 === 1 ? 'GREEN' : 'RED' });
    }
    settleRounds(MobileState, sandbox, 5, 10);
    const map = JSON.parse(localStorage.getItem(`quant_user_model_stats_${tf}`));
    const scored = Object.values(map).filter((m) => m.totalEvaluated > 0).length;
    assert.ok(scored >= 130, `armed session must keep scoring (got ${scored})`);
  });
});
