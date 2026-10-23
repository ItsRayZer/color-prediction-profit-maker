/**
 * fix_round_2.test.js — 2026-10-23 fix round 2:
 *  A. Login verification starvation: the verifier was fed ONLY by
 *     window 'message', but dhaniwin-bridge.js notifyApp() sends
 *     primarily on BroadcastChannel('dhaniwin_quant_channel'). The
 *     merge helpers below are the exact functions the channel
 *     listener + MobileBridgeState poll consume.
 *  B. NO_SIGNAL: no sync of any kind 15s after load must say the
 *     bridge is silent instead of "Checking login…" forever.
 *  C. Smart Ball mini window wiring (mobile.html + orb-bridge).
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

test('channel path: USER_SYNC messages through the merge verify with two kinds', () => {
  // This simulates the BroadcastChannel listener: raw bridge messages
  // -> signalFromBridgeMessage -> LoginVerifier.observe.
  const v = new LoginVerifier({ startedAt: T0 });
  const feed = msg => { const s = signalFromBridgeMessage(msg); if (s) v.observe(s, T0); };
  feed({ type: 'DHANIWIN_BRIDGE_HANDSHAKE', url: 'https://dhaniwin44.com/' });
  assert.equal(v.status(T0).state, LOGIN_STATES.UNKNOWN, 'handshake is not a login signal');
  feed({ type: 'DHANIWIN_USER_SYNC', isLoggedIn: true, balance: null, token: null, url: 'https://dhaniwin44.com/WinGo' });
  assert.equal(v.status(T0).state, LOGIN_STATES.UNKNOWN, 'bridge flag alone is still one kind');
  feed({ type: 'DHANIWIN_USER_SYNC', isLoggedIn: true, balance: 432.5, token: null, url: 'https://dhaniwin44.com/WinGo' });
  const s = v.status(T0);
  assert.equal(s.state, LOGIN_STATES.VERIFIED, 'flag + fresh balance from channel syncs verifies');
  assert.equal(s.balance, 432.5);
});

test('channel path: logout message through the merge drops to NOT_LOGGED_IN', () => {
  const v = new LoginVerifier({ startedAt: T0 });
  const feed = (msg, t) => { const s = signalFromBridgeMessage(msg); if (s) v.observe(s, t); };
  feed({ type: 'DHANIWIN_USER_SYNC', isLoggedIn: true, balance: 100, token: 'a.b.c', url: 'https://dhaniwin44.com/' }, T0);
  assert.equal(v.status(T0).state, LOGIN_STATES.VERIFIED);
  feed({ type: 'DHANIWIN_USER_LOGGED_OUT', url: 'https://dhaniwin44.com/login' }, T0 + 1000);
  assert.equal(v.status(T0 + 1000).state, LOGIN_STATES.NOT_LOGGED_IN);
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
  v.observe({ isLoggedIn: true, balance: 432 }, T0 + 1000);
  const s = v.status(T0 + 9000);
  assert.equal(s.syncAgeMs, 8000);
  assert.equal(s.state, LOGIN_STATES.VERIFIED);
});

// ── Evidence line text ─────────────────────────────────────────────
test('loginEvidenceLine: verified shows balance and sync age', () => {
  const line = loginEvidenceLine({ state: LOGIN_STATES.VERIFIED, balance: 432, syncAgeMs: 8000, everSynced: true });
  assert.ok(line.startsWith('Login verified'));
  assert.ok(line.includes('₹432'), line);
  assert.ok(line.includes('sync 8s ago'), line);
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

test('poll path: a changed snapshot feeds the verifier to VERIFIED', () => {
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
  assert.equal(v.status(T0 + 4000).state, LOGIN_STATES.VERIFIED);
  // Stale check: a repeated identical poll must NOT extend freshness.
  assert.equal(poll({ userBalance: 432.5, authToken: 'a.b.c', loggedIn: true }, T0 + 4000 + 65000), 'skipped');
  assert.equal(v.status(T0 + 4000 + 65000).state, LOGIN_STATES.VERIFIED, 'at +65s only the balance kind (60s) expired; flag+token (90s) still count — the two-signal rule is unchanged');
  assert.equal(poll({ userBalance: 432.5, authToken: 'a.b.c', loggedIn: true }, T0 + 4000 + 95000), 'skipped');
  assert.equal(v.status(T0 + 4000 + 95000).state, LOGIN_STATES.UNKNOWN, 'past every freshness window the state decays: polling never faked a refresh');
});

// ── C. Mini window wiring ──────────────────────────────────────────
test('Mini window: mobile.html carries the window, hidden at start, with all controls', () => {
  const mobile = fs.readFileSync('mobile.html', 'utf8');
  const win = mobile.match(/<div id="smartBallWindow"[^>]*>/);
  assert.ok(win, '#smartBallWindow exists');
  assert.ok(win[0].includes('hidden'), '#smartBallWindow starts hidden');
  for (const id of ['smartBallWindowHeader', 'smartBallLoginDot', 'smartBallExpandBtn', 'smartBallCloseBtn', 'smartBallCall', 'smartBallReason', 'smartBallLadder', 'smartBallPnl', 'smartBallLoginLine', 'smartBallResizeGrip']) {
    assert.ok(mobile.includes(`id="${id}"`), `mobile.html has #${id}`);
  }
  // The window shows ONLY the governed essentials — no ranking/menu clones.
  const slice = mobile.slice(mobile.indexOf('id="smartBallWindow"'), mobile.indexOf('id="dhaniwinAssistantModal"'));
  assert.ok(!slice.includes('bridgeRankingList'), 'mini window stays minimal');
});

test('Mini window: orb-bridge routes ball taps to it and exposes openMini/closeMini', () => {
  const bridge = fs.readFileSync('systems/orb-bridge.js', 'utf8');
  assert.ok(bridge.includes('__o101MiniRouted'), 'ball tap routing wraps the sheet toggle');
  assert.ok(bridge.includes('toggleMini()'), 'ball tap toggles the mini window');
  assert.ok(bridge.includes('lastRouteAt') && bridge.includes('< 350'), 'double-fire from one tap is coalesced (app fires the toggle twice per tap)');
  assert.ok(bridge.includes('openMini') && bridge.includes('closeMini'), '__smartBall exposes openMini/closeMini');
  assert.ok(bridge.includes("localStorage.getItem(MINI_KEY)") || bridge.includes('o101_smartball_window_v1'), 'geometry persists in localStorage');
  assert.ok(bridge.includes('smartBallResizeGrip'), 'resize grip is wired');
  assert.ok(bridge.includes('smartBallWindowHeader'), 'drag header is wired');
});

test('Verifier feed: orb-bridge subscribes to the BroadcastChannel and polls MobileBridgeState', () => {
  const bridge = fs.readFileSync('systems/orb-bridge.js', 'utf8');
  assert.ok(bridge.includes("new BroadcastChannel('dhaniwin_quant_channel')"), 'channel subscription present (the starvation fix)');
  assert.ok(bridge.includes('signalFromBridgeMessage'), 'channel + window messages share one merge');
  assert.ok(bridge.includes('pollBridgeState') && bridge.includes('MobileBridgeState'), 'read-only state poll present');
  assert.ok(bridge.includes('signalFromBridgeStateSnapshot'), 'poll uses the tested snapshot merge');
});

test('Mini window: index.html has no orb, so no mini window there (mobile only)', () => {
  const index = fs.readFileSync('index.html', 'utf8');
  assert.ok(!index.includes('dhaniwinFloatingOrb'), 'index.html has no floating orb element');
  assert.ok(!index.includes('id="smartBallWindow"'), 'mini window is mobile-only, as reported');
});
