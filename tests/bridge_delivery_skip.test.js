/**
 * Bridge delivery + always-skip pins (2026-10-25, owner complaint on the
 * fix-round #5 direct build: DhaniWin header showed ₹67.45 — he WAS
 * logged in — but the app showed "No bridge signal", balance "no
 * signal", "Auto-Pilot refused: Login not verified", and every
 * prediction SKIP).
 *
 * Pins: (1) no raw credential is ever published by the bridge or read
 * by the app — only a boolean presence flag; (2) the bookmarklet path
 * exists in Settings and the bridge refuses double-loads; (3) Auto-Pilot
 * refuses honestly with no order channel and stages/fires (on a tap)
 * with a live one; (4) a SKIP shows its firing gate reason on the hero;
 * (5) calibration persists across loads (the always-skip root cause:
 * it used to reset to zero on every page load, so the gate skipped
 * every round until 50 fresh in-session settlements accrued).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { AutoPilot } from '../systems/autoPilot.js';
import { CalibrationTracker, CALIBRATION_MAX_RECORDS } from '../systems/calibration.js';
import { evaluateSignalGate } from '../systems/signalGate.js';
import {
  ModelHistoryStore,
  heroVerdictView,
  signalFromBridgeMessage
} from '../systems/orb-bridge.js';

function memStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k)
  };
}
const SESSION = { state: 'CONTINUE', nextStake: 4, baseBet: 4, level: 0, ladderLevels: 6 };
function armedAp() {
  const ap = new AutoPilot(memStorage(), { now: () => 1_000_000 });
  assert.equal(ap.arm({ verified: true, balance: 432.5 }).ok, true);
  return ap;
}
function stageBet(ap) {
  return ap.stage({ period: 'P100', timeframe: '30s', target: 'BIG', session: SESSION, periodDurationMs: 30000 });
}
const FIRE = { period: 'P100', timeframe: '30s', verified: true, gateDecision: 'BET', sessionStake: 4, countdownMsLeft: 20000, nowMs: 1_000_100 };

// ── (1) No raw credential anywhere on the bridge → app path ────────
test('bridge delivery: the bridge publishes NO raw token field, only a boolean', () => {
  const bridge = fs.readFileSync(new URL('../dhaniwin-bridge.js', import.meta.url), 'utf8');
  // An object-literal field literally named `token:` would be a publish.
  assert.ok(!/^\s*token:/m.test(bridge), 'no token: field in the bridge source');
  // The scrape tick's sync block carries the boolean instead.
  const syncIdx = bridge.lastIndexOf("type: 'DHANIWIN_USER_SYNC'");
  const syncBlock = bridge.slice(syncIdx, syncIdx + 400);
  assert.ok(syncBlock.includes('tokenPresent'), 'USER_SYNC carries tokenPresent');
  assert.ok(!syncBlock.includes('token:'), 'USER_SYNC block has no raw token field');
  // Idempotence: a bookmarklet tap on a userscript-loaded page is a no-op.
  assert.ok(bridge.includes('window.__o101BridgeLoaded'), 'double-load guard present');
});

test('bridge delivery: the app reads tokenPresent only, never msg.token', () => {
  const mobile = fs.readFileSync(new URL('../mobile.js', import.meta.url), 'utf8');
  // msg.tokenPresent is the boolean; a bare msg.token read would be
  // the raw field (the regex excludes the Present suffix).
  assert.ok(!/msg\.token(?![A-Za-z])/.test(mobile), 'no msg.token read in the app');
  assert.ok(!mobile.includes("setItem('ar_token'"), 'no raw-token persist in the app');
  assert.ok(mobile.includes('msg.tokenPresent'), 'app handles the boolean presence flag');
  assert.ok(mobile.includes("removeItem('ar_token')"), 'leftover raw tokens are purged');
});

test('bridge delivery: signalFromBridgeMessage ignores a legacy raw token field', () => {
  const live = signalFromBridgeMessage({ type: 'DHANIWIN_USER_SYNC', tokenPresent: true, balance: 67.45, isLoggedIn: true, url: 'https://x.dhaniwin.com/' });
  assert.equal(live.hasToken, true);
  assert.equal(live.balance, 67.45);
  // An older bridge build that still sends the raw field must NOT have
  // it read: hasToken comes only from the boolean.
  const legacy = signalFromBridgeMessage({ type: 'DHANIWIN_USER_SYNC', token: 'aaa.bbb.ccc', balance: 10, isLoggedIn: true, url: 'https://x.dhaniwin.com/' });
  assert.equal(legacy.hasToken, false, 'raw token field is ignored, not stored or forwarded');
});

// ── (2) The bookmarklet exists in Settings ──────────────────────────
test('bridge delivery: Settings carries the app-origin bookmarklet link + copy', () => {
  const settings = fs.readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
  assert.ok(settings.includes('id="bridgeBookmarkletLink"'), 'draggable bookmarklet link');
  assert.ok(settings.includes('id="bridgeBookmarkletCopyBtn"'), 'copy button for mobile install');
  assert.ok(settings.includes("location.origin + '/dhaniwin-bridge.js'"), 'loader baked with the serving origin');
  assert.ok(settings.includes('__o101BridgeLoaded'), 'loader refuses an already-active page');
  assert.ok(settings.includes('/dhaniwin/i.test(location.hostname)'), 'loader refuses non-DhaniWin pages');
  assert.ok(settings.includes('Tampermonkey userscript'), 'CSP-blocked fallback named');
  // The hero reason element exists on the app page.
  const mobileHtml = fs.readFileSync(new URL('../mobile.html', import.meta.url), 'utf8');
  assert.ok(mobileHtml.includes('id="mobileWebVerdictReason"'), 'hero skip-reason element');
});

// ── (3) Auto-Pilot: honest refusal, honest fire ─────────────────────
test('bridge delivery: arm refusal names the missing channel + remedy', () => {
  const ap = new AutoPilot(memStorage());
  const res = ap.arm({ verified: false, balance: 500 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /bridge channel/i, 'names the missing channel, not the user login');
  assert.match(res.reason, /bookmarklet/i, 'points at the bookmarklet remedy');
  assert.ok(!res.reason.includes('Login not verified —'), 'old login-blaming wording is gone');
});

test('bridge delivery: confirmFire refuses with no order channel, fires with one', () => {
  const ap = armedAp();
  stageBet(ap);
  const noChannel = ap.confirmFire({ ...FIRE, orderChannel: false });
  assert.equal(noChannel.ok, false);
  assert.match(noChannel.reason, /order channel/i);
  assert.equal(noChannel.order, undefined, 'nothing sent to nowhere');
  const ap2 = armedAp();
  stageBet(ap2);
  const withChannel = ap2.confirmFire({ ...FIRE, orderChannel: true });
  assert.equal(withChannel.ok, true, 'a live window channel + tap fires');
  assert.equal(withChannel.order.type, 'EXECUTE_REAL_BET');
  // Callers that omit orderChannel keep the old validation behaviour.
  const ap3 = armedAp();
  stageBet(ap3);
  assert.equal(ap3.confirmFire({ ...FIRE }).ok, true, 'omitted channel flag does not break existing callers');
});

// ── (4) SKIP shows WHY on the hero ──────────────────────────────────
test('skip reason: heroVerdictView carries the firing gate reason on SKIP only', () => {
  const skip = heroVerdictView({ decision: 'SKIP', pick: 'BIG', prob: 0.52, reason: 'Sample too small: the leading model has only 47 evaluated rounds (needs 200) before its record means anything.' });
  assert.equal(skip.decision, 'SKIP');
  assert.equal(skip.reasonText, 'Sample too small: the leading model has only 47 evaluated rounds (needs 200) before its record means anything.');
  const bet = heroVerdictView({ decision: 'BET', pick: 'BIG', prob: 0.6, reason: 'Calibrated chance 60.0% clears the 53.0% bar.' });
  assert.equal(bet.reasonText, '', 'BET carries no reason line');
  const none = heroVerdictView(null);
  assert.equal(none.reasonText, '');
});

// ── (5) Always-skip root cause: calibration persistence ─────────────
test('skip reason: a fresh tracker skips even with 1000 rounds + 60% edge', () => {
  const fresh = new CalibrationTracker();
  assert.equal(fresh.records.length, 0);
  const gate = evaluateSignalGate({
    pick: { target: 'BIG', prob: 0.60, model: 'M1' },
    sampleSize: 1000,
    contenders: [{ target: 'BIG' }, { target: 'BIG' }, { target: 'BIG' }],
    calibration: fresh,
    calibratedProb: 0.60
  });
  assert.equal(gate.decision, 'SKIP');
  assert.match(gate.reason, /uncalibrated/i, 'the per-load reset fires the calibration rule');
});

test('skip reason: a hydrated tracker with the same inputs bets', () => {
  const hydrated = new CalibrationTracker();
  for (let i = 0; i < 60; i++) hydrated.record(0.60, i < 36); // observed 60% => ECE 0
  assert.equal(hydrated.isCalibrated(), true);
  const gate = evaluateSignalGate({
    pick: { target: 'BIG', prob: 0.60, model: 'M1' },
    sampleSize: 1000,
    contenders: [{ target: 'BIG' }, { target: 'BIG' }, { target: 'BIG' }],
    calibration: hydrated,
    calibratedProb: 0.60
  });
  assert.equal(gate.decision, 'BET');
});

test('skip reason: thin sample and thin edge still skip (thresholds untouched)', () => {
  const hydrated = new CalibrationTracker();
  for (let i = 0; i < 60; i++) hydrated.record(0.60, i < 36);
  const thin = evaluateSignalGate({
    pick: { target: 'BIG', prob: 0.60, model: 'M1' }, sampleSize: 47,
    contenders: [{ target: 'BIG' }, { target: 'BIG' }, { target: 'BIG' }],
    calibration: hydrated, calibratedProb: 0.60
  });
  assert.equal(thin.decision, 'SKIP');
  assert.match(thin.reason, /200/);
  const edge = evaluateSignalGate({
    pick: { target: 'BIG', prob: 0.52, model: 'M1' }, sampleSize: 1000,
    contenders: [{ target: 'BIG' }, { target: 'BIG' }, { target: 'BIG' }],
    calibration: hydrated, calibratedProb: 0.52
  });
  assert.equal(edge.decision, 'SKIP');
  assert.match(edge.reason, /53\.0%/);
  assert.ok(Math.abs(edge.requiredProb - (1 / 1.96 + 0.02)) < 1e-9, 'breakeven 51.02% + 2% margin = 53.02% unchanged');
});

test('skip reason: calibration records survive a reload, bounded recent-only', () => {
  const mem = memStorage();
  const t1 = new CalibrationTracker({ storage: mem });
  t1.record(0.6, true); t1.record(0.6, false); t1.record(0.55, true);
  const t2 = new CalibrationTracker({ storage: mem });
  assert.equal(t2.records.length, 3, 'records hydrate on construct');
  assert.deepEqual(t2.records[0], { prob: 0.6, won: true });
  const mem2 = memStorage();
  const t3 = new CalibrationTracker({ storage: mem2 });
  for (let i = 0; i < CALIBRATION_MAX_RECORDS + 100; i++) t3.record(0.6, i % 2 === 0);
  assert.ok(t3.records.length <= CALIBRATION_MAX_RECORDS, 'bounded to recent records');
  const t4 = new CalibrationTracker({ storage: mem2 });
  assert.ok(t4.records.length <= CALIBRATION_MAX_RECORDS, 'bound holds across reloads');
});

test('skip reason: model history already persisted (isolation: calibration was the reset)', () => {
  const mem = memStorage();
  const s1 = new ModelHistoryStore(mem);
  s1.recordRound('30s', '20261025001', [{ modelId: 'M1', target: 'BIG', correct: true }]);
  s1.save();
  const s2 = new ModelHistoryStore(mem);
  const stats = s2.modelStats('30s', 'M1');
  assert.ok(stats && stats.evaluated === 1, 'model evaluations survive reloads');
});
