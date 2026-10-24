/**
 * Auto-Pilot build tests (2026-10-24): the safety properties ARE the
 * feature. Covers the AutoPilot core (no order without a fresh tap,
 * invalidation, double-tap, auto-stops, arm refusals), the bridge
 * receiver contract asserted against dhaniwin-bridge.js's ACTUAL
 * receiver code, AUTO base bet, the balance block view-model, the
 * GovernedStreakGuard (one counter, one stop), the PatternStore, the
 * verdict lock, the conflict detector and session replans.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { AutoPilot, STOP_REASONS, autoBaseBet, ROUND_CLOSE_MS } from '../systems/autoPilot.js';
import { PatternStore } from '../systems/patternStore.js';
import { GovernedStreakGuard, HARD_STOP_REASON, evaluateSignalGate } from '../systems/signalGate.js';
import {
  VerdictLocker, detectSignalConflict, balanceBlockView, replanSession,
  LOGIN_STATES
} from '../systems/orb-bridge.js';
import { createSession } from '../systems/bankroll.js';

function memStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k)
  };
}

const SESSION = { state: 'CONTINUE', nextStake: 4, baseBet: 4, level: 0, ladderLevels: 6 };
function armedAp(storage = memStorage()) {
  const ap = new AutoPilot(storage, { now: () => 1_000_000 });
  const res = ap.arm({ verified: true, balance: 432.5 });
  assert.equal(res.ok, true);
  return ap;
}
function stageBet(ap, over = {}) {
  return ap.stage({ period: 'P100', timeframe: '30s', target: 'BIG', session: SESSION, periodDurationMs: 30000, ...over });
}

// ── (f) Toggle refuses when not VERIFIED ─────────────────────────────
test('AP arm: refuses when not VERIFIED, without balance, or while HARD_STOP is in force', () => {
  const ap = new AutoPilot(memStorage());
  assert.equal(ap.arm({ verified: false, balance: 500 }).ok, false);
  assert.match(ap.arm({ verified: false, balance: 500 }).reason, /not verified/i);
  assert.equal(ap.arm({ verified: true, balance: null }).ok, false);
  assert.equal(ap.arm({ verified: true, balance: 0 }).ok, false);
  const blocked = ap.arm({ verified: true, balance: 500, blockedReason: HARD_STOP_REASON });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, HARD_STOP_REASON);
  assert.equal(ap.enabled, false);
  assert.equal(ap.arm({ verified: true, balance: 500 }).ok, true);
  assert.equal(ap.enabled, true);
});

// ── (a) Full staging lifecycle with ZERO taps sends ZERO orders ──────
test('AP safety: staging, ticking, invalidating and settling produce no order without a tap', () => {
  const ap = armedAp();
  assert.equal(stageBet(ap), 'staged');
  assert.ok(ap.stagedBet());
  // The ONLY order-producing API is confirmFire. Everything else in
  // the lifecycle must return values that contain no order at all.
  const surfaces = [
    ap.tick({ nowMs: 1_000_100, countdownMsLeft: 20000 }),
    ap.noteSession(SESSION),
    ap.notePaused(false),
    ap.sessionLine(),
    ap.snapshot()
  ];
  for (const s of surfaces) {
    assert.ok(!JSON.stringify(s || {}).includes('EXECUTE_REAL_BET'), 'no order leaks out of a non-confirm path');
  }
  assert.equal(ap.invalidate('gate flipped to SKIP'), true);
  // After invalidation there is nothing to fire: the tap path refuses.
  const res = ap.confirmFire({ verified: true, gateDecision: 'BET', sessionStake: 4, countdownMsLeft: 20000, nowMs: 1_000_200 });
  assert.equal(res.ok, false);
  assert.equal(res.order, undefined);
});

// ── (b) Invalidation by period roll / gate flip / login loss / close ─
test('AP safety: an invalidated staged bet CANNOT be fired (period roll)', () => {
  const ap = armedAp();
  stageBet(ap);
  ap.tick({ nowMs: 1_000_000 + 30001, countdownMsLeft: 29000 }); // past expiresAt
  assert.equal(ap.stagedBet(), null);
  const res = ap.confirmFire({ period: 'P100', timeframe: '30s', verified: true, gateDecision: 'BET', sessionStake: 4, countdownMsLeft: 20000, nowMs: 1_031_000 });
  assert.equal(res.ok, false);
});

test('AP safety: gate flip to SKIP at tap time sends nothing', () => {
  const ap = armedAp();
  stageBet(ap);
  const res = ap.confirmFire({ period: 'P100', timeframe: '30s', verified: true, gateDecision: 'SKIP', sessionStake: 4, countdownMsLeft: 20000, nowMs: 1_000_100 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no longer calls this a BET/i);
});

test('AP safety: login loss pauses staging and blocks firing', () => {
  const ap = armedAp();
  stageBet(ap);
  ap.notePaused(true, 'Paused: login not verified.');
  assert.equal(ap.stagedBet(), null, 'pause invalidates the staged bet');
  assert.equal(stageBet(ap), 'blocked', 'no staging while paused');
  const res = ap.confirmFire({ period: 'P100', timeframe: '30s', verified: false, gateDecision: 'BET', sessionStake: 4, countdownMsLeft: 20000, nowMs: 1_000_100 });
  assert.equal(res.ok, false);
  ap.notePaused(false);
  assert.equal(stageBet(ap), 'staged', 'staging resumes when VERIFIED returns');
});

test('AP safety: countdown close (≤5s, the bridge lock) kills the staged bet', () => {
  const ap = armedAp();
  stageBet(ap);
  ap.tick({ nowMs: 1_000_100, countdownMsLeft: ROUND_CLOSE_MS });
  assert.equal(ap.stagedBet(), null);
  stageBet(ap);
  const res = ap.confirmFire({ period: 'P100', timeframe: '30s', verified: true, gateDecision: 'BET', sessionStake: 4, countdownMsLeft: 4999, nowMs: 1_000_100 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /closing/i);
});

test('AP safety: a ladder stake change voids the staged bet', () => {
  const ap = armedAp();
  stageBet(ap);
  ap.noteSession({ ...SESSION, nextStake: 8, level: 1 });
  assert.equal(ap.stagedBet(), null);
  const res = ap.confirmFire({ period: 'P100', timeframe: '30s', verified: true, gateDecision: 'BET', sessionStake: 8, countdownMsLeft: 20000, nowMs: 1_000_100 });
  assert.equal(res.ok, false);
});

// ── (c) Double-tap fires exactly one order ───────────────────────────
test('AP firing: one tap = one order; double-tap fires nothing twice', () => {
  const ap = armedAp();
  stageBet(ap);
  const v = { period: 'P100', timeframe: '30s', verified: true, gateDecision: 'BET', sessionStake: 4, countdownMsLeft: 20000, nowMs: 1_000_100, maxStake: 64 };
  const first = ap.confirmFire(v);
  assert.equal(first.ok, true);
  assert.equal(first.order.type, 'EXECUTE_REAL_BET');
  assert.equal(first.order.enabled, true);
  assert.equal(first.order.period, 'P100');
  assert.equal(first.order.target, 'BIG');
  assert.equal(first.order.stake, 4);
  assert.equal(first.order.maxStake, 64);
  assert.equal(first.order.timeframe, '30s');
  // Disclosed difference from the legacy dispatch: the single in-app
  // tap IS the authorisation, so manualConfirm is false (the bridge
  // would otherwise wait for a second tap on the DhaniWin page).
  assert.equal(first.order.manualConfirm, false);
  const second = ap.confirmFire(v);
  assert.equal(second.ok, false);
  assert.match(second.reason, /Already fired/);
  assert.equal(ap.state.session.fired, 1);
});

// ── (d) Auto-stops turn AP OFF and block staging until re-arm ────────
for (const stopState of ['STOP_LOSS', 'STOP_WIN', 'LADDER_EXHAUSTED']) {
  test(`AP stops: bankroll ${stopState} switches Auto-Pilot OFF with the reason kept visible`, () => {
    const ap = armedAp();
    stageBet(ap);
    const v = { period: 'P100', timeframe: '30s', verified: true, gateDecision: 'BET', sessionStake: 4, countdownMsLeft: 20000, nowMs: 1_000_100 };
    assert.equal(ap.confirmFire(v).ok, true);
    const res = ap.settleFired({ timeframe: '30s', period: 'P100', won: stopState === 'STOP_WIN', sessionState: stopState });
    assert.equal(res.stopped, true);
    assert.equal(ap.enabled, false);
    assert.equal(ap.state.stopReason, STOP_REASONS[stopState]);
    assert.equal(stageBet(ap), 'blocked', 'staging blocked after a stop');
    assert.match(ap.sessionLine(), /Auto-Pilot off/);
    // Manual re-arm is the way back.
    assert.equal(ap.arm({ verified: true, balance: 400 }).ok, true);
    assert.equal(ap.state.stopReason, null);
    assert.equal(stageBet(ap), 'staged');
  });
}

test('AP accounting: fired rounds settle once, P&L follows bankroll math, log records every kind', () => {
  const ap = armedAp();
  stageBet(ap);
  ap.confirmFire({ period: 'P100', timeframe: '30s', verified: true, gateDecision: 'BET', sessionStake: 4, countdownMsLeft: 20000, nowMs: 1_000_100 });
  ap.settleFired({ timeframe: '30s', period: 'P100', won: true, sessionState: 'RESET' });
  ap.settleFired({ timeframe: '30s', period: 'P100', won: true, sessionState: 'RESET' }); // duplicate settle: ignored
  assert.equal(ap.state.session.wins, 1);
  assert.equal(ap.state.session.pnl, 3.84); // 4 * 0.96
  assert.equal(ap.state.session.rounds, 1);
  ap.resolveUnfired('30s', 'P101', 'skipped');
  ap.resolveUnfired('30s', 'P101', 'skipped'); // counted once
  assert.equal(ap.state.session.rounds, 2);
  const kinds = ap.state.log.map(l => l.kind);
  for (const k of ['armed', 'staged', 'fired', 'settled', 'skipped']) assert.ok(kinds.includes(k), `log has ${k}`);
});

// ── (e) The bridge receiver contract, from the bridge's own code ─────
test('AP contract: the order fires dhaniwin-bridge.js handleIncomingOrder; enabled:false does not', () => {
  const src = fs.readFileSync('dhaniwin-bridge.js', 'utf8');
  const start = src.indexOf('function handleIncomingOrder(msg) {');
  assert.ok(start > 0, 'receiver exists in the bridge source');
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const fnText = src.slice(start, end);
  const calls = [];
  const factory = new vm.Script(`(function (executeRealBet) {
    let configuredStake = 2, configuredMaxStake = 999999, hasAppBetSettings = false, activeTimeframe = '30s';
    const INTERVAL_URL_MAP = {};
    const window = { location: { href: 'https://example.invalid/WinGo/WinGo_30S', origin: 'https://example.invalid' } };
    const notifyApp = () => {};
    const _userState = { noteDomBalance: () => {} };
    function scrapeRealBalanceFromDOM() { return null; }
    function onRealBalanceDetected() {}
    function activeWalletPoll() {}
    function scrapeUserSession() {}
    function performRealAuthInspection() { return {}; }
    function switchTimerTab() {}
    ${fnText}
    return handleIncomingOrder;
  })`);
  const handleIncomingOrder = factory.runInThisContext()(order => { calls.push(order); return true; });

  const ap = armedAp();
  stageBet(ap);
  const { order } = ap.confirmFire({ period: 'P100', timeframe: '30s', verified: true, gateDecision: 'BET', sessionStake: 4, countdownMsLeft: 20000, nowMs: 1_000_100, maxStake: 64 });
  handleIncomingOrder(order);
  assert.equal(calls.length, 1, 'the bridge receiver executes the Auto-Pilot order');
  assert.equal(calls[0].target, 'BIG');
  handleIncomingOrder({ ...order, enabled: false });
  assert.equal(calls.length, 1, 'enabled:false is refused by the receiver');
  handleIncomingOrder({ ...order, type: 'SOMETHING_ELSE' });
  assert.equal(calls.length, 1, 'other message types do not execute bets');

  // The receiver semantics Auto-Pilot relies on, read from its source:
  const execStart = src.indexOf('async function executeRealBet(order)');
  const execSrc = src.slice(execStart, execStart + 9000);
  assert.ok(execSrc.includes('order.manualConfirm === true'), 'bridge: manualConfirm:true = prepare-only path exists');
  assert.ok(execSrc.includes('isRoundLockingSoon()'), 'bridge: refuses at the <5s round lock');
  assert.ok(execSrc.includes('lastDispatchedPeriod'), 'bridge: dedupes per period');
});

// ── Addition 1: AUTO base bet + balance block ────────────────────────
test('AUTO base: bankroll fractions floored, min ₹1 (worked examples)', () => {
  assert.equal(autoBaseBet(432.5, 'balanced'), 4);
  assert.equal(autoBaseBet(1000, 'balanced'), 10);
  assert.equal(autoBaseBet(432.5, 'safe'), 2);
  assert.equal(autoBaseBet(432.5, 'growth'), 10);
  assert.equal(autoBaseBet(432.5, 'aggressive'), 21);
  assert.equal(autoBaseBet(40, 'balanced'), 1, 'min ₹1');
  assert.equal(autoBaseBet(0, 'balanced'), 0, 'no balance, no base');
});

test('Balance block: verified figure + source tag; stale after 60s; honest empty state', () => {
  const fresh = balanceBlockView({ state: LOGIN_STATES.VERIFIED, balance: 432.5, balanceSource: 'api', stateAgeMs: 5000 });
  assert.equal(fresh.text, '₹432.50');
  assert.equal(fresh.tag, 'exact · API');
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageText, '5s ago');
  const dom = balanceBlockView({ state: LOGIN_STATES.VERIFIED, balance: 100, balanceSource: 'dom', stateAgeMs: 1000 });
  assert.equal(dom.tag, 'from page');
  const stale = balanceBlockView({ state: LOGIN_STATES.VERIFIED, balance: 100, balanceSource: 'api', stateAgeMs: 90000 });
  assert.equal(stale.stale, true);
  assert.equal(stale.ageText, '90s ago');
  const empty = balanceBlockView({ state: LOGIN_STATES.NO_SIGNAL, balance: null });
  assert.equal(empty.text, '—');
  assert.equal(empty.hasState, false);
  assert.match(empty.emptyText, /No bridge signal/);
});

// ── Addition 5.2: GovernedStreakGuard — one counter, one stop ────────
test('Guard: loss,loss = cooldown only (raised edge); win at 2 resets; 3rd loss = HARD_STOP', () => {
  const g = new GovernedStreakGuard();
  g.recordSettledBet(false);
  assert.equal(g.consecutiveLosses, 1);
  assert.equal(g.beginRound().active, false, 'no cooldown after 1 loss');
  g.recordSettledBet(false);
  assert.equal(g.consecutiveLosses, 2);
  assert.equal(g.hardStopped, false);
  const cd = g.beginRound();
  assert.equal(cd.active, true, 'cooldown after 2 losses');
  assert.equal(cd.extraMargin, 0.03);
  assert.equal(cd.lossStreak, 2);
  g.recordSettledBet(true);
  assert.equal(g.consecutiveLosses, 0, 'a win at streak 2 resets to 0');
  assert.equal(g.beginRound().active, false);
  g.recordSettledBet(false); g.recordSettledBet(false); g.recordSettledBet(false);
  assert.equal(g.hardStopped, true);
  assert.equal(HARD_STOP_REASON, '3-loss streak — stopped');
  // While stopped, further settled-bet records do not move the counter.
  g.recordSettledBet(false);
  assert.equal(g.consecutiveLosses, 3);
});

test('Guard: HARD_STOP clears on two consecutive shadow wins, or manual re-arm; both logged in lastClear', () => {
  const g = new GovernedStreakGuard();
  g.recordSettledBet(false); g.recordSettledBet(false); g.recordSettledBet(false);
  assert.equal(g.hardStopped, true);
  g.recordShadowPick(true);
  assert.equal(g.hardStopped, true, 'one shadow win is not enough');
  g.recordShadowPick(false);
  assert.equal(g.shadowWins, 0, 'a shadow loss resets shadow wins');
  g.recordShadowPick(true); g.recordShadowPick(true);
  assert.equal(g.hardStopped, false, 'two consecutive shadow wins clear the stop');
  assert.equal(g.consecutiveLosses, 0);
  assert.equal(g.lastClear.source, 'shadow');
  g.recordSettledBet(false); g.recordSettledBet(false); g.recordSettledBet(false);
  assert.equal(g.manualRearm(), true);
  assert.equal(g.hardStopped, false);
  assert.equal(g.lastClear.source, 'manual');
  assert.equal(g.manualRearm(), false, 're-arm with no stop is a no-op');
  // Persistence round-trip: a reload cannot launder a stop.
  const g2 = new GovernedStreakGuard();
  g2.recordSettledBet(false); g2.recordSettledBet(false); g2.recordSettledBet(false);
  const g3 = new GovernedStreakGuard();
  g3.restore(g2.snapshot());
  assert.equal(g3.hardStopped, true);
  assert.equal(g3.consecutiveLosses, 3);
});

test('Guard + gate: while HARD_STOP is overlaid the verdict reasons carry the stop (integration shape)', () => {
  // The runtime overlays HARD_STOP onto the locked gate; this pins the
  // gate-side contract the overlay relies on: cooldown input from the
  // guard raises the required probability by exactly +0.03 after 2 losses.
  const g = new GovernedStreakGuard();
  g.recordSettledBet(false); g.recordSettledBet(false);
  const cd = g.beginRound();
  const tracker = { isCalibrated: () => true, expectedCalibrationError: () => 0.01, count: 100 };
  const base = evaluateSignalGate({ pick: 'BIG', sampleSize: 300, calibratedProb: 0.545, calibration: tracker, contenders: [{ pick: 'BIG' }, { pick: 'BIG' }] });
  assert.equal(base.decision, 'BET', '0.545 clears 51.02+2 without cooldown');
  const raised = evaluateSignalGate({ pick: 'BIG', sampleSize: 300, calibratedProb: 0.545, calibration: tracker, contenders: [{ pick: 'BIG' }, { pick: 'BIG' }], cooldown: cd });
  assert.equal(raised.decision, 'SKIP', 'the same probability fails with the +0.03 cooldown bar');
});

// ── Addition 3: PatternStore ─────────────────────────────────────────
test('PatternStore: firings persist across reload, idempotent per round, counters survive record pruning', () => {
  const storage = memStorage();
  const ps = new PatternStore(storage, 'k', { recordCap: 3 });
  assert.equal(ps.recordFiring({ patternId: 'BBS', timeframe: '30s', period: 'P1', prediction: 'BIG', hit: true }), true);
  assert.equal(ps.recordFiring({ patternId: 'BBS', timeframe: '30s', period: 'P1', prediction: 'BIG', hit: true }), false, 'same round never double-counted');
  ps.recordFiring({ patternId: 'BBS', timeframe: '30s', period: 'P2', prediction: 'BIG', hit: false });
  ps.recordFiring({ patternId: 'BBS', timeframe: '30s', period: 'P3', prediction: 'SMALL', hit: true });
  ps.recordFiring({ patternId: 'BBS', timeframe: '30s', period: 'P4', prediction: 'SMALL', hit: true });
  const reloaded = new PatternStore(storage, 'k', { recordCap: 3 });
  const st = reloaded.stats('BBS', '30s');
  assert.equal(st.fired, 4, 'counter keeps the full total');
  assert.equal(st.hits, 3);
  assert.equal(st.hitRate, 0.75);
  assert.equal(st.lastPeriod, 'P4');
  assert.equal(reloaded.records('BBS', '30s').length, 3, 'records pruned to the cap');
  assert.equal(reloaded.mergedStats('BBS').fired, 4);
  assert.equal(reloaded.allStats('1m').length, 0, 'timeframes stay separate');
});

test('PatternStore: deferSave batches persistence until flush (one write per feed cycle)', () => {
  const storage = memStorage();
  let writes = 0;
  const rawSet = storage.setItem.bind(storage);
  storage.setItem = (k, v) => { writes++; rawSet(k, v); };
  const ps = new PatternStore(storage, 'k2');
  ps.recordFiring({ patternId: 'BSB', timeframe: '30s', period: 'P1', prediction: 'BIG', hit: true, deferSave: true });
  ps.recordFiring({ patternId: 'BSB', timeframe: '30s', period: 'P2', prediction: 'BIG', hit: true, deferSave: true });
  assert.equal(writes, 0, 'deferred firings write nothing yet');
  assert.equal(ps.stats('BSB', '30s').fired, 2, 'in-memory counters are live immediately');
  ps.flush();
  assert.equal(writes, 1, 'flush persists the whole batch in one write');
  ps.flush();
  assert.equal(writes, 1, 'flush with nothing pending writes nothing');
  const reloaded = new PatternStore(storage, 'k2');
  assert.equal(reloaded.stats('BSB', '30s').fired, 2, 'batch survived the reload');
  ps.recordFiring({ patternId: 'BSB', timeframe: '30s', period: 'P3', prediction: 'SMALL', hit: false });
  assert.equal(writes, 2, 'the default path still persists immediately');
});

// ── Addition 2.3: verdict lock ───────────────────────────────────────
test('VerdictLocker: within a key the first verdict is final; a new key recomputes', () => {
  const locker = new VerdictLocker();
  let calls = 0;
  const compute = v => () => { calls++; return v; };
  assert.equal(locker.get('30s:P1', compute('BIG')), 'BIG');
  assert.equal(locker.get('30s:P1', compute('SMALL')), 'BIG', 'mid-period updates cannot flip the verdict');
  assert.equal(calls, 1);
  assert.equal(locker.get('30s:P2', compute('SMALL')), 'SMALL', 'period roll releases the lock');
  assert.equal(locker.get('1m:P1', compute('SKIP')), 'SKIP', 'timeframe switch is a new key');
  assert.equal(calls, 3);
});

// ── Addition 5.1: conflict detection ─────────────────────────────────
test('Conflict: a proven pattern firing against the pick is named; agreement and weak signals are silent', () => {
  const strong = { patternId: 'BBS', name: 'BBS', prediction: 'SMALL', fired: 34, hitRate: 0.64 };
  const c = detectSignalConflict({ pick: 'BIG', patternFiring: strong });
  assert.equal(c.kind, 'pattern');
  assert.match(c.reason, /BBS/);
  assert.match(c.reason, /SMALL against the leader's BIG/);
  assert.match(c.reason, /64% over 34 firings/);
  assert.equal(detectSignalConflict({ pick: 'SMALL', patternFiring: strong }), null, 'agreement is not a conflict');
  assert.equal(detectSignalConflict({ pick: 'BIG', patternFiring: { ...strong, fired: 19 } }), null, 'under 20 firings: not proven');
  assert.equal(detectSignalConflict({ pick: 'BIG', patternFiring: { ...strong, hitRate: 0.55 } }), null, 'not clearly above breakeven: not proven');
  const t = detectSignalConflict({ pick: 'BIG', trend: { type: 'SMALL', length: 5 } });
  assert.equal(t.kind, 'trend');
  assert.equal(detectSignalConflict({ pick: 'BIG', trend: { type: 'SMALL', length: 4 } }), null);
  assert.equal(detectSignalConflict({ pick: null, patternFiring: strong }), null);
});

// ── Addition 5.3: replan keeps ONE session truth ─────────────────────
test('replanSession: base changes, identity (start balance, P&L, rounds, streak) carries over', () => {
  const s0 = createSession(432.5, { mode: 'balanced' });
  const used = { ...s0, sessionPnL: -12.5, rounds: 7, consecutiveLosses: 2, level: 2, nextStake: 16 };
  const s1 = replanSession(used, 420, { mode: 'balanced', baseBet: 10 });
  assert.equal(s1.baseBet, 10);
  assert.equal(s1.level, 0, 'a replan starts a fresh ladder');
  assert.equal(s1.nextStake, 10);
  assert.equal(s1.startingBalance, s0.startingBalance, 'stop fractions still measured from the session start');
  assert.equal(s1.sessionPnL, -12.5);
  assert.equal(s1.rounds, 7);
  assert.equal(s1.consecutiveLosses, 2);
  const fresh = replanSession(null, 1000, { mode: 'balanced' });
  assert.equal(fresh.baseBet, 10, 'no previous session: a plain createSession (1% of 1000)');
});
