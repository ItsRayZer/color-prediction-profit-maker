/**
 * fix_round_2.test.js — 2026-10-23 fix round 2:
 *  A. Login verification starvation: the verifier was fed ONLY by
 *     window 'message', but dhaniwin-bridge.js notifyApp() sends
 *     primarily on BroadcastChannel('dhaniwin_quant_channel'). The
 *     merge helpers below are the exact functions the channel
 *     listener + MobileBridgeState poll consume.
 *  B. NO_SIGNAL: no sync of any kind 15s after load must say the
 *     bridge is silent instead of "Checking login…" forever.
 *  C. Smart Ball mini window wiring — SUPERSEDED at the 2026-10-24
 *     rebase: the owner's live app has the real floating ball window,
 *     which replaces the mini window (section C tests below now pin
 *     the live window + its governance wiring instead).
 *  D. REBASE v2 login rule: legacy USER_SYNC traffic can never verify;
 *     only the bridge's API-proven DHANIWIN_USER_STATE can.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  LoginVerifier, LOGIN_STATES, NO_SIGNAL_AFTER_MS,
  signalFromBridgeMessage, signalFromBridgeStateSnapshot, loginEvidenceLine
} from '../systems/orb-bridge.js';

const T0 = 1_700_000_000_000;

// ── A. Bridge-message merge (the BroadcastChannel feed path) ───────
test('signalFromBridgeMessage: USER_SYNC maps to a verifier signal', () => {
  const sig = signalFromBridgeMessage({
    type: 'DHANIWIN_USER_SYNC', isLoggedIn: true, balance: 432.5,
    token: 'tok-123', url: 'https://dhaniwin44.com/WinGo/WinGo_30S'
  });
  assert.deepEqual(sig, { isLoggedIn: true, balance: 432.5, hasToken: true, isAuthPage: false });
});

test('signalFromBridgeMessage: auth URL is an explicit negative context', () => {
  const sig = signalFromBridgeMessage({
    type: 'DHANIWIN_USER_SYNC', isLoggedIn: false, balance: null, token: null,
    url: 'https://dhaniwin44.com/login'
  });
  assert.equal(sig.isAuthPage, true);
  assert.equal(sig.isLoggedIn, false);
  assert.equal(sig.balance, null);
  assert.equal(sig.hasToken, false);
});

test('signalFromBridgeMessage: balance / login / logout message types', () => {
  assert.deepEqual(signalFromBridgeMessage({ type: 'DHANIWIN_REAL_BALANCE', balance: '250.5' }), { balance: 250.5 });
  assert.deepEqual(signalFromBridgeMessage({ type: 'DHANIWIN_LOGIN_DETECTED', loggedIn: true }), { isLoggedIn: true });
  assert.deepEqual(signalFromBridgeMessage({ type: 'DHANIWIN_USER_LOGGED_OUT' }), { explicitLogout: true });
  assert.deepEqual(signalFromBridgeMessage({ type: 'DHANIWIN_SESSION_OUT' }), { explicitLogout: true });
});

test('signalFromBridgeMessage: non-login traffic is ignored', () => {
  assert.equal(signalFromBridgeMessage({ type: 'DHANIWIN_BRIDGE_HANDSHAKE' }), null);
  assert.equal(signalFromBridgeMessage({ type: 'UPDATE_BET_SETTINGS', stake: 2 }), null);
  assert.equal(signalFromBridgeMessage(null), null);
  assert.equal(signalFromBridgeMessage('DHANIWIN_USER_SYNC'), null);
  assert.equal(signalFromBridgeMessage({}), null);
});

// The runtime feed: bridgeState signals go to observeBridgeState,
// legacy signals to observe — exactly what orb-bridge's feed does.
function makeFeed(v) {
  return (msg, t) => {
    const s = signalFromBridgeMessage(msg);
    if (!s) return;
    if (s.bridgeState) v.observeBridgeState(s.bridgeState, t);
    else v.observe(s, t);
  };
}

test('channel path: USER_SYNC traffic can never verify under the v2 rule; USER_STATE can', () => {
  // This simulates the BroadcastChannel listener: raw bridge messages
  // -> signalFromBridgeMessage -> LoginVerifier.
  const v = new LoginVerifier({ startedAt: T0 });
  const feed = makeFeed(v);
  feed({ type: 'DHANIWIN_BRIDGE_HANDSHAKE', url: 'https://dhaniwin44.com/' }, T0);
  assert.equal(v.status(T0).state, LOGIN_STATES.UNKNOWN, 'handshake is not a login signal');
  feed({ type: 'DHANIWIN_USER_SYNC', isLoggedIn: true, balance: null, token: null, url: 'https://dhaniwin44.com/WinGo' }, T0);
  assert.equal(v.status(T0).state, LOGIN_STATES.UNKNOWN, 'bridge flag alone is not proof');
  feed({ type: 'DHANIWIN_USER_SYNC', isLoggedIn: true, balance: 432.5, token: 'a.b.c', url: 'https://dhaniwin44.com/WinGo' }, T0);
  assert.equal(v.status(T0).state, LOGIN_STATES.UNKNOWN, 'even flag + balance + token from legacy syncs is not API proof');
  feed({ type: 'DHANIWIN_USER_STATE', isLoggedIn: true, balance: 432.5, balanceSource: 'api', apiProven: true, fetchMode: 'active', userId: '998877', ts: T0, seq: 7 }, T0);
  const s = v.status(T0);
  assert.equal(s.state, LOGIN_STATES.VERIFIED, 'the API-proven published user state verifies');
  assert.equal(s.balance, 432.5);
  assert.equal(s.fetchMode, 'active');
});

test('channel path: logout message through the merge drops to NOT_LOGGED_IN', () => {
  const v = new LoginVerifier({ startedAt: T0 });
  const feed = makeFeed(v);
  feed({ type: 'DHANIWIN_USER_STATE', isLoggedIn: true, balance: 100, balanceSource: 'api', apiProven: true, fetchMode: 'intercept', ts: T0, seq: 1 }, T0);
  assert.equal(v.status(T0).state, LOGIN_STATES.VERIFIED);
  feed({ type: 'DHANIWIN_USER_LOGGED_OUT', url: 'https://dhaniwin44.com/login' }, T0 + 1000);
  assert.equal(v.status(T0 + 1000).state, LOGIN_STATES.NOT_LOGGED_IN, 'a newer explicit logout beats the still-fresh verified state');
});

// ── B. NO_SIGNAL ────────────────────────────────────────────────────
test('LoginVerifier: silence for 15s after load is NO_SIGNAL, not endless checking', () => {
  const v = new LoginVerifier({ startedAt: T0 });
  assert.equal(v.status(T0).state, LOGIN_STATES.UNKNOWN, 'grace window: still checking');
  assert.equal(v.status(T0 + NO_SIGNAL_AFTER_MS - 1).state, LOGIN_STATES.UNKNOWN);
  const s = v.status(T0 + NO_SIGNAL_AFTER_MS);
  assert.equal(s.state, LOGIN_STATES.NO_SIGNAL);
  assert.equal(s.everSynced, false);
  assert.equal(s.lastSyncAt, null);
});

test('LoginVerifier: any observation permanently ends the NO_SIGNAL possibility', () => {
  const v = new LoginVerifier({ startedAt: T0 });
  v.observe({ balance: 100 }, T0 + 2000); // one kind only — never verifies
  assert.equal(v.status(T0 + 60000).state, LOGIN_STATES.UNKNOWN, 'a sync arrived, so not NO_SIGNAL');
  const v2 = new LoginVerifier({ startedAt: T0 });
  v2.observe({ explicitLogout: true }, T0 + 100);
  assert.equal(v2.status(T0 + 99999).state, LOGIN_STATES.NOT_LOGGED_IN, 'explicit negative beats NO_SIGNAL');
});

test('LoginVerifier: sync age is reported for the evidence line', () => {
  const v = new LoginVerifier({ startedAt: T0 });
  assert.equal(v.status(T0).syncAgeMs, null, 'no sync yet: no age');
  v.observeBridgeState({ type: 'DHANIWIN_USER_STATE', isLoggedIn: true, balance: 432, balanceSource: 'api', apiProven: true, fetchMode: 'intercept', ts: T0 + 1000, seq: 1 }, T0 + 1000);
  const s = v.status(T0 + 9000);
  assert.equal(s.syncAgeMs, 8000);
  assert.equal(s.stateAgeMs, 8000, 'bridge-state age is reported separately from legacy sync age');
  assert.equal(s.state, LOGIN_STATES.VERIFIED);
});

// ── Evidence line text ─────────────────────────────────────────────
test('loginEvidenceLine: verified shows balance, source label and sync age', () => {
  const line = loginEvidenceLine({ state: LOGIN_STATES.VERIFIED, balance: 432, balanceSource: 'api', stateAgeMs: 8000, syncAgeMs: 8000, everSynced: true });
  assert.ok(line.startsWith('Login verified'));
  assert.ok(line.includes('₹432'), line);
  assert.ok(line.includes('exact · API'), line);
  assert.ok(line.includes('sync 8s ago'), line);
  const domLine = loginEvidenceLine({ state: LOGIN_STATES.VERIFIED, balance: 432, balanceSource: 'dom', stateAgeMs: 8000, everSynced: true });
  assert.ok(domLine.includes('from page'), domLine, 'a DOM-sourced balance is labelled, never passed off as exact');
});

test('loginEvidenceLine: NO_SIGNAL names the missing bridge, not "checking"', () => {
  const line = loginEvidenceLine({ state: LOGIN_STATES.NO_SIGNAL, balance: null, syncAgeMs: null, everSynced: false });
  assert.equal(line, 'No bridge signal — open DhaniWin with the bridge active');
  assert.equal(
    loginEvidenceLine({ state: LOGIN_STATES.NOT_LOGGED_IN, balance: null, syncAgeMs: null, everSynced: true }),
    'Not logged in'
  );
  const unknown = loginEvidenceLine({ state: LOGIN_STATES.UNKNOWN, balance: null, syncAgeMs: 3000, everSynced: true });
  assert.ok(unknown.includes('sync 3s ago'), unknown);
});

// ── MobileBridgeState snapshot merge (the poll path) ───────────────
test('signalFromBridgeStateSnapshot: derives positive-only signals + stable signature', () => {
  const a = signalFromBridgeStateSnapshot({ userBalance: 432.5, authToken: 'a.b.c', loggedIn: true });
  assert.deepEqual(a.sig, { isLoggedIn: true, balance: 432.5, hasToken: true });
  const b = signalFromBridgeStateSnapshot({ userBalance: 432.5, authToken: 'a.b.c', loggedIn: true });
  assert.equal(a.signature, b.signature, 'unchanged state must produce the same signature (no fake freshness)');
  const c = signalFromBridgeStateSnapshot({ userBalance: 500, authToken: 'a.b.c', loggedIn: true });
  assert.notEqual(a.signature, c.signature, 'a balance change is a new signature');
});

test('signalFromBridgeStateSnapshot: never fabricates a negative or a balance', () => {
  const empty = signalFromBridgeStateSnapshot({ userBalance: 0, authToken: null, loggedIn: null });
  assert.deepEqual(empty.sig, { isLoggedIn: null, balance: null, hasToken: false });
  const loggedOut = signalFromBridgeStateSnapshot({ userBalance: 0, authToken: null, loggedIn: false });
  assert.equal(loggedOut.sig.isLoggedIn, null, 'poll path is positive-only: false from state is NOT an explicit negative');
});

test('poll path: app-state snapshots feed evidence but can never verify (v2 rule)', () => {
  // PORTED at the rebase: the snapshot merge itself is unchanged
  // (signature-gated, positive-only — polling still cannot fake
  // freshness), but what it feeds is now evidence only. Verification
  // comes exclusively from the bridge's published user state.
  const v = new LoginVerifier({ startedAt: T0 });
  let last = null;
  const poll = (snap, t) => {
    const { sig, signature } = signalFromBridgeStateSnapshot(snap);
    if (signature === last) return 'skipped';
    last = signature;
    v.observe(sig, t);
    return 'fed';
  };
  assert.equal(poll({ userBalance: 0, authToken: null, loggedIn: null }, T0), 'fed');
  assert.equal(v.status(T0).state, LOGIN_STATES.UNKNOWN);
  assert.equal(poll({ userBalance: 0, authToken: null, loggedIn: null }, T0 + 2000), 'skipped', 'static snapshot is not re-fed');
  assert.equal(poll({ userBalance: 432.5, authToken: 'a.b.c', loggedIn: true }, T0 + 4000), 'fed');
  assert.equal(v.status(T0 + 4000).state, LOGIN_STATES.UNKNOWN, 'app-state wealth of signals is still not API proof');
  assert.ok(v.status(T0 + 4000).evidence.length >= 1, 'the snapshot signals are carried as evidence');
  assert.equal(poll({ userBalance: 432.5, authToken: 'a.b.c', loggedIn: true }, T0 + 4000 + 95000), 'skipped');
  assert.equal(v.status(T0 + 4000 + 95000).state, LOGIN_STATES.UNKNOWN, 'past every freshness window nothing lingers: polling never faked a refresh');
});

// ── C. Live ball window (rebase) ───────────────────────────────────
test('Live ball window: mobile.html carries the owner\'s real floating window', () => {
  // The round-2 mini window is GONE: the base swap restored the live
  // app's own floating assistant window, byte-exact except the one
  // slim bridge status line.
  const mobile = fs.readFileSync('mobile.html', 'utf8');
  assert.ok(!mobile.includes('id="smartBallWindow"'), 'round-2 mini window is removed');
  assert.ok(mobile.includes('id="dhaniwinAssistantModal"'), 'live assistant modal present');
  assert.ok(mobile.includes('id="dhaniwinAssistantSheet"'), 'live floating sheet present');
  assert.ok(mobile.includes('assistant-resize-handle'), 'live window keeps its resize handles');
  for (const id of ['mobileWebTargetDisplay', 'assistantConfBadge', 'assistantBaseStakeDisplay', 'mobileWebStakeDisplay', 'assistantPeriodNum', 'assistantCountdown', 'assistantMiniRoad', 'mobileWebLevelBadge']) {
    assert.ok(mobile.includes(`id="${id}"`), `live window has #${id}`);
  }
  assert.ok(mobile.includes('id="bridgeStatusLine"'), 'the one slim bridge status line was added inside the window');
});

test('Live ball window: orb-bridge drives its prediction area, mini routing is gone', () => {
  const bridge = fs.readFileSync('systems/orb-bridge.js', 'utf8');
  assert.ok(!bridge.includes('smartBallWindow'), 'mini window code removed from the bridge');
  assert.ok(!bridge.includes('openMini'), '__smartBall no longer exposes the mini window');
  for (const id of ['mobileWebTargetDisplay', 'assistantConfBadge', 'assistantBaseStakeDisplay', 'mobileWebStakeDisplay', 'bridgeStatusLine']) {
    assert.ok(bridge.includes(id), `bridge drives #${id}`);
  }
  assert.ok(bridge.includes('renderWindowStatus'), 'governed status line renderer present');
});

test('Verifier feed: orb-bridge subscribes to the BroadcastChannel and polls MobileBridgeState', () => {
  const bridge = fs.readFileSync('systems/orb-bridge.js', 'utf8');
  assert.ok(bridge.includes("new BroadcastChannel('dhaniwin_quant_channel')"), 'channel subscription present (the starvation fix)');
  assert.ok(bridge.includes('signalFromBridgeMessage'), 'channel + window messages share one merge');
  assert.ok(bridge.includes('pollBridgeState') && bridge.includes('MobileBridgeState'), 'read-only state poll present');
  assert.ok(bridge.includes('signalFromBridgeStateSnapshot'), 'poll uses the tested snapshot merge');
  assert.ok(bridge.includes('pollRtdbUserState') && bridge.includes('/user_state.json'), 'RTDB user-state poll present (the fourth feed)');
});

test('Rebase: index.html has no orb and does not load orb-bridge (desktop keeps its own arena)', () => {
  const index = fs.readFileSync('index.html', 'utf8');
  assert.ok(!index.includes('dhaniwinFloatingOrb'), 'index.html has no floating orb element');
  assert.ok(!index.includes('id="smartBallWindow"'), 'no mini window on desktop either');
  assert.ok(!index.includes('systems/orb-bridge.js'), 'orb-bridge is mobile-only after the rebase');
});
