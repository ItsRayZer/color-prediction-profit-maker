/**
 * fix_round_cold_big_20.test.js — cold-big-20 model (owner order 2026-11-15)
 *
 * Edge-search signal, edge-report-2026-11-14/15: last-20 BIG rate below
 * 0.40 on 3m, bet BIG. Held-out 3m: 73/109 (67.0%, Wilson 0.577) on
 * 14 Nov and 79/121 (65.3%, Wilson 0.565) on 15 Nov, but train was
 * 45-46% and fresh paper-test data is still collecting, so the model
 * ships DISPLAY-ONLY: scored and ranked like every model, never
 * bet-driving until the paper test passes (100 fired rounds, Wilson
 * at least 53.02%).
 *
 * PINS:
 *  1. Catalog: 143 models, cold-big-20 is cat statistical, predType
 *     SIZE, conf 0.60, unique id.
 *  2. Rule (exact edge-search semantics): fires BIG only when the
 *     last 20 rounds hold fewer than 8 BIG (rate strictly below 0.40);
 *     null at exactly 0.40, null when hot, null when fewer than 20
 *     rounds are in the window, null on an empty window.
 *  3. The pick returns directly from the case (like Observer returns
 *     null): the signal is contrarian, so the post-switch rewrites
 *     would corrupt it — D2 regime attractor flips a pick that fights
 *     a dragon (a cold-BIG window usually IS a SMALL dragon), the
 *     streak/pain inversion flips it on a -5 run, and the adaptive
 *     override would replace it with trend/fade. The record stays
 *     pure signal, and an abstention can never be replaced by a guess.
 *  4. The pick scores through the real judge: BIG wins iff the round
 *     number is 5 or higher.
 *  5. Display-only gate: signalGate.js lists cold-big-20 in
 *     DISPLAY_ONLY_IDS; orb-bridge skips those ids in both
 *     bet-driver loops and rides displayOnlyNote when one would have
 *     led. ASI_TRIAL_IDS is untouched.
 *  6. Prediction window: live picks/scoring merge the deep-history
 *     tail with the live list (deduped by period, live wins, sorted,
 *     capped at 24, beforePeriod filter honoured) so a 20-round
 *     signal can fire on a live loop that only holds ~10 rounds.
 *     The 24 cap stays under ADAPTIVE_MIN_HISTORY (25), so the
 *     per-model adaptive override stays skipped live exactly as today.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const arenaSrc = fs.readFileSync(new URL('../algorithms/arena_models.js', import.meta.url), 'utf8');
const mobileSrc = fs.readFileSync(new URL('../mobile.js', import.meta.url), 'utf8');
const bridgeSrc = fs.readFileSync(new URL('../systems/orb-bridge.js', import.meta.url), 'utf8');
const gateSrc = fs.readFileSync(new URL('../systems/signalGate.js', import.meta.url), 'utf8');

function loadArena() {
  const sandbox = { window: {}, self: {}, console };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(arenaSrc, sandbox);
  return sandbox;
}

function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s + 1);
  assert.ok(s !== -1 && e !== -1 && e > s, `markers not found: ${startMarker} .. ${endMarker}`);
  return src.slice(s, e);
}

function loadPredictionHistoryFor(deepByTf, liveByTf) {
  const fnSrc = sliceFn(mobileSrc, 'function predictionHistoryFor', 'function updateIndividualModelSettlement');
  const sandbox = { MobileState: { historyByTf: liveByTf, deepHistoryByTf: deepByTf }, console };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);
  return sandbox.predictionHistoryFor;
}

// Rounds with explicit size fields matching the number derivation.
function mkRounds(nums, startPeriod = 100) {
  return nums.map((n, i) => ({
    period: '202611151000' + String(startPeriod + i),
    number: n,
    size: n >= 5 ? 'BIG' : 'SMALL',
    color: n % 2 === 1 ? 'GREEN' : 'RED'
  }));
}

const MODEL = { id: 'cold-big-20', predType: 'SIZE', streak: 0, dopamine: 0.5, lossPain: 0 };

test('catalog: 143 models, cold-big-20 is statistical SIZE with honest conf', () => {
  const ids = [...arenaSrc.matchAll(/"id":\s*"([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, 143, `catalog must be 143, got ${ids.length}`);
  assert.equal(new Set(ids).size, 143, 'catalog ids must be unique');
  assert.ok(ids.includes('cold-big-20'), 'cold-big-20 must be in the catalog');
  assert.ok(/"id":\s*"cold-big-20"[\s\S]{0,1200}?"cat":\s*"statistical"/.test(arenaSrc), 'cold-big-20 is statistical');
  assert.ok(/"id":\s*"cold-big-20"[\s\S]{0,1200}?"predType":\s*"SIZE"/.test(arenaSrc), 'cold-big-20 is SIZE');
  assert.ok(/"id":\s*"cold-big-20"[\s\S]{0,1200}?"conf":\s*0\.60/.test(arenaSrc), 'cold-big-20 conf is 0.60');
});

test('rule: fires BIG only when last-20 BIG rate is strictly below 0.40', () => {
  const { generateModelNextPrediction: gen, evaluatePredictionCorrectness: ev } = loadArena();
  // 7 BIG of 20 = 0.35, cold: fires.
  const cold = mkRounds([0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 5, 6, 7, 8, 9, 0, 1]);
  const p = gen(MODEL, cold, {}, true);
  assert.ok(p, 'cold window must produce a pick');
  assert.equal(p.predType, 'SIZE');
  assert.equal(p.predTarget, 'BIG');
  assert.equal(p.conf, 0.60);
  // 8 BIG of 20 = exactly 0.40: abstains (strictly below only).
  const edge = mkRounds([5, 6, 7, 8, 9, 0, 1, 2, 5, 6, 7, 0, 1, 2, 3, 4, 0, 1, 2, 3]);
  assert.equal(gen(MODEL, edge, {}, true), null, 'rate exactly 0.40 must abstain');
  // 12 BIG of 20 = 0.60, hot: abstains.
  const hot = mkRounds([5, 6, 7, 8, 9, 5, 6, 7, 8, 9, 5, 6, 0, 1, 2, 3, 4, 0, 1, 2]);
  assert.equal(gen(MODEL, hot, {}, true), null, 'hot window must abstain');
  // The pick scores through the real judge.
  assert.equal(ev(p.predTarget, 7, 'BIG', 'GREEN'), true, 'BIG wins on 7');
  assert.equal(ev(p.predTarget, 2, 'SMALL', 'RED'), false, 'BIG loses on 2');
});

test('rule: abstains on a short or empty window', () => {
  const { generateModelNextPrediction: gen } = loadArena();
  const short = mkRounds([0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3]);
  assert.equal(gen(MODEL, short, {}, true), null, '19 rounds must abstain');
  assert.equal(gen(MODEL, [], {}, true), null, 'empty history must abstain');
  assert.equal(gen(MODEL, null, {}, true), null, 'null history must abstain');
});

test('abstention is an early return: adaptive can never invent a pick from it', () => {
  const { generateModelNextPrediction: gen } = loadArena();
  // 30 rounds, last 20 hot (12 BIG): null even with adaptive enabled.
  const hot30 = mkRounds([5, 6, 7, 8, 9, 5, 6, 7, 8, 9, 5, 6, 0, 1, 2, 3, 4, 0, 1, 2, 5, 6, 7, 8, 9, 5, 6, 0, 1, 2]);
  assert.equal(gen(MODEL, hot30, {}, false), null, 'hot 30-round window must abstain with adaptive on');
  // 30 rounds, last 20 cold: pure signal (skipAdaptive) is BIG.
  const cold30 = mkRounds([5, 6, 7, 8, 9, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
  const pure = gen(MODEL, cold30, {}, true);
  assert.ok(pure && pure.predTarget === 'BIG', 'cold 30-round window, pure signal, must be BIG');
  // With adaptive on, a pick still exists and stays SIZE (core or winner).
  const live = gen(MODEL, cold30, {}, false);
  assert.ok(live, 'cold 30-round window must still produce a pick with adaptive on');
  assert.equal(live.predType, 'SIZE');
});

test('display-only gate: cold-big-20 never drives a bet', () => {
  assert.ok(gateSrc.includes("export const DISPLAY_ONLY_IDS = ['cold-big-20']"), 'signalGate must list cold-big-20 as display-only');
  assert.ok(gateSrc.includes('DISPLAY_ONLY_GATE_REASON'), 'signalGate must carry the display-only reason');
  assert.ok(gateSrc.includes("export const ASI_TRIAL_IDS = ['ASI', 'ASI_APEX_MASTER']"), 'ASI_TRIAL_IDS must be untouched');
  const skips = bridgeSrc.match(/if \(DISPLAY_ONLY_IDS\.includes\(m\.id\)\) continue;/g) || [];
  assert.equal(skips.length, 2, `orb-bridge must skip display-only ids in both bet-driver loops (found ${skips.length})`);
  assert.ok(bridgeSrc.includes('const displayOnlyNote = inchargeIsDisplayOnly ? DISPLAY_ONLY_GATE_REASON : null;'), 'orb-bridge must ride displayOnlyNote when one would have led');
  assert.ok(bridgeSrc.includes('displayOnlyNote: gate.displayOnlyNote || null'), 'displayOnlyNote must ride window.__o101Verdict');
});

test('prediction window: merges deep tail + live, deduped, sorted, capped at 24', () => {
  const deep = mkRounds([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 100);
  const live = mkRounds([5, 6, 7, 8, 9, 0, 1, 2, 3, 4], 125);
  // Overlap: live repeats the last 5 deep periods with different numbers (live wins).
  const fn = loadPredictionHistoryFor({ '3m': deep }, { '3m': live });
  const merged = fn('3m');
  assert.equal(merged.length, 24, 'merged window must cap at 24');
  assert.ok(merged.length <= 24 && merged.length < 25, 'cap stays under ADAPTIVE_MIN_HISTORY (25)');
  const periods = Array.from(merged, r => r.period); // Array.from: this-realm array (vm arrays fail deepStrictEqual on prototype)
  assert.equal(new Set(periods).size, periods.length, 'no duplicated periods');
  assert.deepEqual(periods, [...periods].sort(), 'sorted oldest-first');
  assert.equal(merged[merged.length - 1].period, live[live.length - 1].period, 'newest round is the latest live round');
  // Live wins on a shared period.
  const shared = merged.find(r => r.period === live[0].period);
  assert.equal(shared.number, live[0].number, 'live row wins on a shared period');
  // beforePeriod filter: nothing at or after the cutoff.
  const before = fn('3m', live[0].period);
  assert.ok(before.every(r => r.period < live[0].period), 'beforePeriod must exclude the cutoff round and later');
  assert.ok(before.length <= 24, 'filtered window still capped');
  // No deep history: live only, no throw.
  const liveOnly = loadPredictionHistoryFor({}, { '3m': live });
  assert.equal(liveOnly('3m').length, 10, 'without deep history the window is the live list');
  assert.ok(arenaSrc.includes('const ADAPTIVE_MIN_HISTORY = 25;'), 'adaptive threshold must stay 25');
});

test('orb-bridge prediction window: same 24 cap, used for live picks only', () => {
  assert.ok(bridgeSrc.includes('function predictionHistory(tf)'), 'orb-bridge must define predictionHistory');
  assert.ok(bridgeSrc.includes('.slice(-24);'), 'orb-bridge prediction window must cap at 24');
  assert.ok(bridgeSrc.includes('const picks = nextRoundPicks(arenaModels(), predictionHistory(tf), gen);'), 'cycle picks must use the merged window');
  assert.ok(bridgeSrc.includes('const history = settledHistory(tf);'), 'settlement must keep the live list');
});
