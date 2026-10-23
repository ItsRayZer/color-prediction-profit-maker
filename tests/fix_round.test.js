/**
 * fix_round.test.js — 2026-10-23 fix round:
 *  1/2. Coffee popup trap (orb + settings blocked) — dismissal persists.
 *  3.   LoginVerifier: VERIFIED / NOT_LOGGED_IN / expiry. PORTED at the
 *       2026-10-24 rebase: VERIFIED now requires the bridge's
 *       API-proven published user state (see the v2 tests below).
 *  4.   Governed settlement fires the win/loss sound hook.
 *  5a.  Per-timeframe governance scope + labelled global fallback.
 *  5b.  Pattern-conditioned ranking blend (bounded, >= 20 samples).
 *  5c.  Display probability: cap + Platt scale.
 *  5d.  Anti-tilt cooldown raises the gate margin after 2 governed losses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ModelHistoryStore, LoginVerifier, LOGIN_STATES,
  resolveGovernanceScope, mergedModelStats, buildPoolFromStore,
  displayProbability, settleGovernedPick
} from '../systems/orb-bridge.js';
import { CalibrationTracker } from '../systems/calibration.js';
import { InchargeEngine } from '../systems/inchargeEngine.js';
import { evaluateSignalGate, GateCooldown, GATE_DECISIONS } from '../systems/signalGate.js';
import { createSession } from '../systems/bankroll.js';
import { BOT_EVENTS } from '../systems/predictBot.js';

const T0 = 1_700_000_000_000;

// ── 3. LoginVerifier ────────────────────────────────────────────────
test('LoginVerifier: no signals and single-signal flickers stay UNKNOWN', () => {
  const v = new LoginVerifier();
  assert.equal(v.status(T0).state, LOGIN_STATES.UNKNOWN);
  v.observe({ isLoggedIn: true }, T0);
  assert.equal(v.status(T0).state, LOGIN_STATES.UNKNOWN, 'bridge flag alone is one signal kind');
  const v2 = new LoginVerifier();
  v2.observe({ balance: 250 }, T0);
  v2.observe({ balance: 250 }, T0 + 1000);
  assert.equal(v2.status(T0 + 1000).state, LOGIN_STATES.UNKNOWN, 'balance alone is one signal kind');
});

// REBASE v2 (2026-10-24): the two-kind rule was itself a guess — a
// token or a page-scraped number is not a live session. VERIFIED now
// requires the bridge's published user state with apiProven=true.
const provenState = (over = {}) => ({
  type: 'DHANIWIN_USER_STATE', isLoggedIn: true, balance: 512.5,
  balanceSource: 'api', apiProven: true, fetchMode: 'active',
  userId: '998877', ts: T0, seq: 1, ...over
});

test('LoginVerifier: legacy signal kinds never verify on their own (v2 rule)', () => {
  const v = new LoginVerifier();
  v.observe({ isLoggedIn: true, balance: 512.5, hasToken: true }, T0);
  const s = v.status(T0);
  assert.equal(s.state, LOGIN_STATES.UNKNOWN, 'flag + balance + token from legacy syncs is still not API proof');
  assert.ok(s.evidence.length >= 1, 'the legacy signals are reported as evidence, not proof');
});

test('LoginVerifier: API-proven bridge state verifies; unproven state does not', () => {
  const v = new LoginVerifier();
  v.observeBridgeState(provenState(), T0);
  const s = v.status(T0);
  assert.equal(s.state, LOGIN_STATES.VERIFIED);
  assert.equal(s.balance, 512.5);
  assert.equal(s.balanceSource, 'api');
  assert.ok(s.evidence.length >= 2);

  const v2 = new LoginVerifier();
  v2.observeBridgeState(provenState({ apiProven: false }), T0);
  const s2 = v2.status(T0);
  assert.equal(s2.state, LOGIN_STATES.UNKNOWN, 'bridge-reported login without API proof waits');
  assert.ok(s2.evidence.some(e => e.includes('API wallet proof')), 'evidence names what is missing');
});

test('LoginVerifier: explicit negative drops to NOT_LOGGED_IN immediately', () => {
  const v = new LoginVerifier();
  v.observeBridgeState(provenState(), T0);
  assert.equal(v.status(T0).state, LOGIN_STATES.VERIFIED);
  v.observe({ isLoggedIn: false }, T0 + 500);
  assert.equal(v.status(T0 + 500).state, LOGIN_STATES.NOT_LOGGED_IN, 'a newer negative beats a still-fresh VERIFIED');

  const v2 = new LoginVerifier();
  v2.observeBridgeState(provenState(), T0);
  v2.observe({ isAuthPage: true }, T0 + 500);
  assert.equal(v2.status(T0 + 500).state, LOGIN_STATES.NOT_LOGGED_IN, 'auth page is an explicit negative');

  const v3 = new LoginVerifier();
  v3.observeBridgeState(provenState(), T0);
  v3.observe({ explicitLogout: true }, T0 + 500);
  assert.equal(v3.status(T0 + 500).state, LOGIN_STATES.NOT_LOGGED_IN, 'logout event is an explicit negative');

  const v4 = new LoginVerifier();
  v4.observeBridgeState(provenState(), T0);
  v4.observeBridgeState(provenState({ isLoggedIn: false, seq: 2, ts: T0 + 500 }), T0 + 500);
  assert.equal(v4.status(T0 + 500).state, LOGIN_STATES.NOT_LOGGED_IN, 'bridge state isLoggedIn=false is an explicit negative');
});

test('LoginVerifier: VERIFIED expires to UNKNOWN when the bridge state goes stale (>60s)', () => {
  const v = new LoginVerifier();
  v.observeBridgeState(provenState(), T0);
  assert.equal(v.status(T0 + 30_000).state, LOGIN_STATES.VERIFIED);
  assert.equal(v.status(T0 + 61_000).state, LOGIN_STATES.UNKNOWN, 'a stale bridge state decays VERIFIED, never extends it');
  assert.equal(v.status(T0 + 91_000).state, LOGIN_STATES.UNKNOWN);
});

test('LoginVerifier: fresh positives after a negative can re-verify', () => {
  const v = new LoginVerifier();
  v.observe({ isLoggedIn: false }, T0);
  assert.equal(v.status(T0).state, LOGIN_STATES.NOT_LOGGED_IN);
  v.observe({ isLoggedIn: true, balance: 42 }, T0 + 1000);
  assert.equal(v.status(T0 + 1000).state, LOGIN_STATES.UNKNOWN, 'legacy positives alone cannot re-verify under the v2 rule');
  v.observeBridgeState(provenState({ balance: 42, ts: T0 + 2000, seq: 2 }), T0 + 2000);
  assert.equal(v.status(T0 + 2000).state, LOGIN_STATES.VERIFIED);
});

// ── 5a. Per-timeframe governance ────────────────────────────────────
function seedTwoTimeframes() {
  const store = new ModelHistoryStore(null);
  // 30s: model A dominant. 5m: model B dominant. 60 rounds each.
  for (let i = 0; i < 60; i++) {
    store.recordRound('30s', 'S' + i, [
      { modelId: 'a', pick: 'BIG', correct: i % 10 !== 9 },
      { modelId: 'b', pick: 'BIG', correct: i % 10 === 9 }
    ]);
    store.recordRound('5m', 'L' + i, [
      { modelId: 'a', pick: 'BIG', correct: i % 10 === 9 },
      { modelId: 'b', pick: 'BIG', correct: i % 10 !== 9 }
    ]);
  }
  return store;
}
const MODELS = [{ id: 'a', name: 'Model A' }, { id: 'b', name: 'Model B' }];

test('Governance scope: timeframe with >= 50 rounds governs itself', () => {
  const store = seedTwoTimeframes();
  const scope = resolveGovernanceScope(store, '5m');
  assert.equal(scope.key, '5m');
  assert.equal(scope.perTimeframe, true);

  const engine = new InchargeEngine({});
  const top30 = engine.rankModels(buildPoolFromStore(store, MODELS, '30s'))[0];
  const top5m = engine.rankModels(buildPoolFromStore(store, MODELS, '5m'))[0];
  assert.equal(top30.id, 'a', '30s leader is the 30s-strong model');
  assert.equal(top5m.id, 'b', '5m leader is the 5m-strong model, not the 30s leader');
});

test('Governance scope: thin timeframe falls back to labelled global record', () => {
  const store = new ModelHistoryStore(null);
  for (let i = 0; i < 60; i++) store.recordRound('30s', 'S' + i, [{ modelId: 'a', pick: 'BIG', correct: true }]);
  for (let i = 0; i < 10; i++) store.recordRound('5m', 'L' + i, [{ modelId: 'a', pick: 'BIG', correct: false }]);
  const scope = resolveGovernanceScope(store, '5m');
  assert.equal(scope.key, 'ALL');
  assert.equal(scope.perTimeframe, false);
  assert.match(scope.label, /global record/);
  assert.match(scope.label, /5m has 10/);

  const merged = mergedModelStats(store, 'a');
  assert.equal(merged.evaluated, 70);
  assert.equal(merged.wins, 60);
});

// ── 5b. Pattern-conditioned blend ───────────────────────────────────
test('Pattern blend: bounded at 0.25 and requires >= 20 pattern samples', () => {
  const engine = new InchargeEngine({});
  const base = { id: 'x', name: 'X', wins: 60, totalEvaluated: 100, winRate: 0.6, streak: 0, recentWinRate: null, recentEvaluated: 0 };
  const plain = engine.scoreModel(base);
  const few = engine.scoreModel({ ...base, patternHitRate: 1.0, patternSamples: 19 });
  assert.equal(few, plain, 'fewer than 20 pattern firings: no blend');
  const blended = engine.scoreModel({ ...base, patternHitRate: 1.0, patternSamples: 20 });
  assert.ok(Math.abs(blended - (0.75 * plain + 0.25 * 1.0)) < 1e-9, 'blend is exactly 75/25 at the cap');
  const greedy = new InchargeEngine({ patternWeight: 0.9 });
  assert.equal(greedy.scoreModel({ ...base, patternHitRate: 1.0, patternSamples: 40 }), blended, 'config weight above 0.25 is clamped to the cap');
});

test('Pattern blend: pool carries the active pattern hit rate from the store', () => {
  const store = new ModelHistoryStore(null);
  for (let i = 0; i < 25; i++) {
    store.recordRound('30s', 'P' + i, [{ modelId: 'a', pick: 'BIG', patternKey: 'dragon', patternName: 'Dragon', correct: i < 20 }]);
  }
  const pool = buildPoolFromStore(store, MODELS, '30s', { key: 'dragon', name: 'Dragon' });
  const a = pool.find(m => m.id === 'a');
  assert.equal(a.patternSamples, 25);
  assert.equal(a.patternHitRate, 20 / 25);
  const noCtx = buildPoolFromStore(store, MODELS, '30s', null);
  assert.equal(noCtx.find(m => m.id === 'a').patternHitRate, undefined, 'no active pattern -> no pattern fields');
});

// ── 5c. Display probability ─────────────────────────────────────────
test('Display probability: hard 0/1 capped, then Platt-scaled', () => {
  const fresh = new CalibrationTracker();
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  assert.ok(near(displayProbability(1.0, fresh), 0.95), 'raw 1.0 caps to 0.95 (identity fit before 20 records)');
  assert.ok(near(displayProbability(0.0, fresh), 0.05));
  assert.ok(near(displayProbability(0.5, fresh), 0.5));
  assert.equal(displayProbability(null, fresh), null);
  assert.equal(displayProbability(2, null), 0.95, 'no tracker: cap still applies');

  const overconfident = new CalibrationTracker();
  for (let i = 0; i < 60; i++) overconfident.record(0.9, i % 4 === 0); // claims 90%, wins 25%
  const shown = displayProbability(0.9, overconfident);
  assert.ok(shown < 0.9, `Platt fit pulls an overconfident 0.9 down (got ${shown})`);
  assert.ok(shown > 0 && shown < 1);
});

// ── 5d. Cooldown ────────────────────────────────────────────────────
test('GateCooldown: two governed losses raise the bar for exactly 3 rounds', () => {
  const cd = new GateCooldown();
  assert.equal(cd.beginRound().active, false);
  cd.recordSettledBet(false);
  assert.equal(cd.beginRound().active, false, 'one loss is not enough');
  cd.recordSettledBet(false);
  for (let r = 0; r < 3; r++) {
    const round = cd.beginRound();
    assert.equal(round.active, true, `cooldown round ${r + 1} active`);
    assert.equal(round.extraMargin, 0.03);
  }
  assert.equal(cd.beginRound().active, false, 'cooldown spent after 3 rounds');
  cd.recordSettledBet(false);
  cd.recordSettledBet(false);
  cd.recordSettledBet(true);
  assert.equal(cd.beginRound().active, false, 'a win clears the cooldown immediately');
});

test('Gate: cooldown margin turns a marginal BET into a SKIP with the reason stated', () => {
  const cal = { isCalibrated: () => true, expectedCalibrationError: () => 0.01, count: 120 };
  const input = {
    pick: 'BIG',
    model: { id: 'a', name: 'A', totalEvaluated: 300 },
    sampleSize: 300,
    calibratedProb: 0.545, // clears breakeven+0.02 (0.5302) but not +0.05 under cooldown
    calibration: cal,
    contenders: [{ pick: 'BIG' }, { pick: 'BIG' }]
  };
  const normal = evaluateSignalGate(input);
  assert.equal(normal.decision, GATE_DECISIONS.BET);
  const cooled = evaluateSignalGate({ ...input, cooldown: { active: true, roundsLeft: 2, extraMargin: 0.03, lossStreak: 2 } });
  assert.equal(cooled.decision, GATE_DECISIONS.SKIP);
  assert.ok(cooled.requiredProb > normal.requiredProb);
  assert.match(cooled.reason, /cooldown/i);
});

// ── 4. Governed settlement sound hook ───────────────────────────────
test('Governed settlement: BET rounds fire the sound hook, SKIP rounds stay silent', () => {
  const sounds = [];
  const hooks = { playSound: t => sounds.push(t) };
  const session = createSession(1000, {});
  assert.ok(session.nextStake > 0, 'session has a stake to settle');

  const win = settleGovernedPick({ won: true, session, gateDecision: GATE_DECISIONS.BET, hooks });
  assert.deepEqual(sounds, ['win'], 'win plays the Suii hook exactly once');
  assert.equal(win.sound, 'win');
  assert.equal(win.events[0], BOT_EVENTS.WIN);
  assert.ok(win.session.balance > session.balance || win.session.sessionPnL > 0, 'bankroll settled the win');

  const loss = settleGovernedPick({ won: false, session, gateDecision: GATE_DECISIONS.BET, hooks });
  assert.deepEqual(sounds, ['win', 'loss'], 'loss plays the Bruh hook');
  assert.equal(loss.events[0], BOT_EVENTS.LOSS);

  const skip = settleGovernedPick({ won: false, session, gateDecision: GATE_DECISIONS.SKIP, hooks });
  assert.deepEqual(sounds, ['win', 'loss'], 'a skipped round has no user outcome to sonify');
  assert.equal(skip.sound, null);
  assert.deepEqual(skip.events, []);

  const noSession = settleGovernedPick({ won: true, session: null, gateDecision: GATE_DECISIONS.BET, hooks });
  assert.deepEqual(sounds, ['win', 'loss', 'win'], 'sound fires even before a bankroll session exists');
  assert.equal(noSession.events[0], BOT_EVENTS.WIN);
});

// ── 1/2. Coffee trap wiring + login pills ───────────────────────────
test('Coffee popup: Maybe Later dismisses for the day, popup respects it', () => {
  const mobileJs = fs.readFileSync('mobile.js', 'utf8');
  const mobileHtml = fs.readFileSync('mobile.html', 'utf8');
  assert.ok(mobileJs.includes("localStorage.setItem('coffee_dismissed_date'"), 'dismissal is persisted');
  assert.ok(mobileJs.includes('isCoffeeDismissedToday()'), 'auto-open checks the dismissal');
  assert.ok(mobileHtml.includes('dismissCoffeeSupportModalToday();'), 'popup buttons use the persisting dismiss');
  assert.ok(!mobileHtml.includes('closeCoffeeSupportModal(false);" class="hover:text-white'), 'Maybe Later no longer uses the non-persisting close');
});

test('Index settings: panel toggle re-homed standalone (dormant block stays untouched)', () => {
  const indexHtml = fs.readFileSync('index.html', 'utf8');
  assert.ok(indexHtml.includes("typeof window.toggleSettingsPanel !== 'function'"), 'standalone guard present');
  assert.ok(indexHtml.includes('_settingsPanelOpenStandalone'), 'standalone toggle state present');
  assert.ok(indexHtml.includes("panel.style.transform = 'translateX(0)'"), 'open behaviour matches the original');
  assert.ok(indexHtml.includes("panel.style.transform = 'translateX(100%)'"), 'close behaviour matches the original');
});

test('Login evidence surfaces on the rebased app: live ball window line + settings diagnostic', () => {
  // PORTED (rebase 2026-10-24): the round-1 pill elements lived in
  // markup the base swap replaced. On the live base the evidence
  // surfaces are (a) the ONE slim status line inside the live ball
  // window and (b) the DhaniWin Bridge diagnostic row in settings.
  const mobileHtml = fs.readFileSync('mobile.html', 'utf8');
  const settingsHtml = fs.readFileSync('settings.html', 'utf8');
  assert.ok(mobileHtml.includes('id="bridgeStatusLine"'), 'live ball window carries the bridge status line');
  assert.ok(mobileHtml.includes('systems/orb-bridge.js'), 'mobile loads the bridge');
  assert.ok(settingsHtml.includes('id="bridgeDiagLine"') && settingsHtml.includes('id="bridgeDiagDetail"') && settingsHtml.includes('id="bridgeDiagTag"'), 'settings shows the bridge diagnostic');
  assert.ok(settingsHtml.includes('o101_bridge_state_v1'), 'settings diagnostic consumes the persisted bridge snapshot');
  const bridge = fs.readFileSync('systems/orb-bridge.js', 'utf8');
  assert.ok(bridge.includes('verifyLogin'), 'bridge exposes verifyLogin for checks');
  assert.ok(bridge.includes('DHANIWIN_USER_STATE'), 'bridge consumes the published user state');
  assert.ok(bridge.includes('bridgeDiagnostic'), 'bridge exposes the structured diagnostic');
});
