/**
 * rebase_user_state.test.js — 2026-10-24 rebase: the login + exact
 * balance system.
 *  A. dhaniwin-bridge.js user-state core (pure block between the
 *     O101-STATE-CORE markers): API-proof login rule, balance
 *     provenance, endpoint learning shape, active-poll verdicts.
 *  B. orb-bridge LoginVerifier v2: bridge-state merge from channel /
 *     RTDB shapes, freshness, ordering, token-leak guard, diagnostic.
 *  C. Wiring assertions on the rebased files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  LoginVerifier, LOGIN_STATES, normaliseBridgeState, bridgeDiagnostic, loginEvidenceLine
} from '../systems/orb-bridge.js';

const T0 = 1_700_000_000_000;

// ── A. Bridge user-state core ──────────────────────────────────────
const bridgeSrc = fs.readFileSync('dhaniwin-bridge.js', 'utf8');
const coreSrc = bridgeSrc.split('// [O101-STATE-CORE-BEGIN]')[1].split('// [O101-STATE-CORE-END]')[0];
const { createUserStateTracker, extractUserIdFromJson, detectTokenAttachment } =
  new Function(coreSrc + '\nreturn { createUserStateTracker, extractUserIdFromJson, detectTokenAttachment };')();

test('bridge core: token alone is NOT login proof; token + API payload is', () => {
  const t = createUserStateTracker();
  t.noteToken(true, T0);
  assert.equal(t.buildState(T0).isLoggedIn, false, 'a stored token can be stale — not proof');
  t.noteApiPayload({ balance: 250.75, userId: '42' }, T0);
  const s = t.buildState(T0);
  assert.equal(s.isLoggedIn, true);
  assert.equal(s.balance, 250.75);
  assert.equal(s.balanceSource, 'api');
  assert.equal(s.apiProven, true);
  assert.equal(s.userId, '42');
});

test('bridge core: API payload alone (no token) is not login either', () => {
  const t = createUserStateTracker();
  t.noteApiPayload({ balance: 100 }, T0);
  assert.equal(t.buildState(T0).isLoggedIn, false);
  t.noteAuthPage(true);
  t.noteToken(true, T0);
  assert.equal(t.buildState(T0).isLoggedIn, false, 'on the auth page there is no session');
});

test('bridge core: DOM balance is labelled from-page and only fills in when API is stale/absent', () => {
  const t = createUserStateTracker();
  t.noteToken(true, T0);
  t.noteDomBalance(300, T0);
  let s = t.buildState(T0);
  assert.equal(s.balance, 300);
  assert.equal(s.balanceSource, 'dom');
  assert.equal(s.isLoggedIn, false, 'a scraped number never proves login');
  t.noteApiPayload({ balance: 299.5 }, T0 + 1000);
  s = t.buildState(T0 + 1000);
  assert.equal(s.balance, 299.5, 'fresh API figure wins — it is the exact one');
  assert.equal(s.balanceSource, 'api');
  s = t.buildState(T0 + 1000 + 46000);
  assert.equal(s.balance, 300, 'once the API figure is stale, the fresher page figure is shown');
  assert.equal(s.balanceSource, 'dom', '…and it is labelled from-page, never passed off as exact');
});

test('bridge core: logout clears proof; the built state can never contain a token', () => {
  const t = createUserStateTracker();
  t.noteToken(true, T0);
  t.noteApiPayload({ balance: 100, userId: '7' }, T0);
  assert.equal(t.buildState(T0).isLoggedIn, true);
  t.noteLogout(T0 + 1000);
  const s = t.buildState(T0 + 1000);
  assert.equal(s.isLoggedIn, false);
  assert.equal(s.apiProven, false);
  assert.deepEqual(Object.keys(s).sort(), ['apiProven', 'balance', 'balanceSource', 'betSlipOpen', 'fetchMode', 'isLoggedIn', 'userId'],
    'the published state has exactly the seven public fields (Addition 3 added the betSlipOpen UI boolean) — no token field exists to leak');
});

test('bridge core: fetchMode pending -> active -> intercept on auth failure', () => {
  const t = createUserStateTracker();
  assert.equal(t.buildState(T0).fetchMode, 'pending', 'nothing learned yet: active mode pending, stated honestly');
  t.noteEndpoint({ url: 'https://dhaniwin44.com/api/wallet/info', method: 'POST', tokenMode: 'header', headerName: 'Authorization', scheme: 'Bearer' });
  assert.equal(t.buildState(T0).fetchMode, 'active', 'endpoint learned: session-powered re-query is live');
  t.noteActivePoll({ verdict: 'auth' }, T0 + 1000);
  const s = t.buildState(T0 + 1000);
  assert.equal(s.fetchMode, 'intercept', 'a 401/403 from the re-query falls back to interception-only');
  assert.equal(s.isLoggedIn, false, '…and is a logged-out signal');
  t.noteApiPayload({ balance: 10 }, T0 + 2000);
  assert.equal(t.buildState(T0 + 2000).fetchMode, 'active', 'a fresh intercepted success re-arms active mode');
});

test('bridge core: token attachment detection keeps name + scheme, never the value', () => {
  const h = detectTokenAttachment([['Content-Type', 'application/json'], ['Authorization', 'Bearer SECRET-TOKEN-VALUE']]);
  assert.deepEqual(h, { mode: 'header', headerName: 'Authorization', scheme: 'Bearer' });
  assert.ok(!JSON.stringify(h).includes('SECRET'), 'the descriptor must not retain the token value');
  assert.deepEqual(detectTokenAttachment([['Content-Type', 'application/json']]), { mode: 'cookie' });
  assert.deepEqual(detectTokenAttachment([]), { mode: 'cookie' });
  const x = detectTokenAttachment([['X-Token', 'abc']]);
  assert.equal(x.mode, 'header');
  assert.equal(x.scheme, '');
});

test('bridge core: userId extraction reads the payload wrappers', () => {
  assert.equal(extractUserIdFromJson({ data: { userId: 998877 } }), '998877');
  assert.equal(extractUserIdFromJson({ result: { member: { uid: 'm-1' } } }), 'm-1', 'ids are found inside wrapper objects (data/result/user/member)');
  assert.equal(extractUserIdFromJson({ data: { member: { memberId: 'm-2' } } }), 'm-2');
  assert.equal(extractUserIdFromJson({ balance: 5 }), null);
  assert.equal(extractUserIdFromJson(null), null);
});

// ── B. Verifier: bridge-state merge, freshness, ordering ──────────
const state = (over = {}) => ({
  type: 'DHANIWIN_USER_STATE', isLoggedIn: true, balance: 432.5, balanceSource: 'api',
  apiProven: true, fetchMode: 'active', userId: '998877', ts: T0, seq: 1, ...over
});

test('verifier: RTDB-shaped state (no type field) normalises and verifies', () => {
  const raw = { isLoggedIn: true, balance: 432.5, balanceSource: 'api', apiProven: true, fetchMode: 'intercept', userId: '998877', ts: T0, seq: 3 };
  const st = normaliseBridgeState(raw);
  assert.ok(st, 'the RTDB node has no message type — it must still parse');
  const v = new LoginVerifier({ startedAt: T0 });
  v.observeBridgeState(raw, T0);
  assert.equal(v.status(T0).state, LOGIN_STATES.VERIFIED);
});

test('verifier: a token smuggled into a state payload is dropped, never propagated', () => {
  const st = normaliseBridgeState(state({ token: 'SECRET-TOKEN', ar_token: 'SECRET-2' }));
  assert.ok(st);
  assert.ok(!('token' in st) && !('ar_token' in st), 'normalised state has no token fields');
  assert.ok(!JSON.stringify(st).includes('SECRET'), 'token values never survive normalisation');
});

test('verifier: out-of-order states are ignored; a bridge restart after silence is accepted', () => {
  const v = new LoginVerifier({ startedAt: T0 });
  v.observeBridgeState(state({ seq: 10, ts: T0 }), T0);
  v.observeBridgeState(state({ seq: 9, ts: T0 - 1000, balance: 1 }), T0 + 1000);
  assert.equal(v.status(T0 + 1000).balance, 432.5, 'the older state did not overwrite the newer one');
  v.observeBridgeState(state({ seq: 1, ts: T0 + 121000, balance: 500 }), T0 + 121000);
  assert.equal(v.status(T0 + 121000).balance, 500, 'after >120s silence a reset seq is a restarted bridge, accepted');
});

test('verifier: zero is a real balance', () => {
  const v = new LoginVerifier({ startedAt: T0 });
  v.observeBridgeState(state({ balance: 0 }), T0);
  const s = v.status(T0);
  assert.equal(s.state, LOGIN_STATES.VERIFIED);
  assert.equal(s.balance, 0, 'an empty wallet is ₹0, not "no balance"');
});

test('verifier: bridgeDiagnostic carries mode, source and sync age for settings', () => {
  const v = new LoginVerifier({ startedAt: T0 });
  v.observeBridgeState(state(), T0);
  const d = bridgeDiagnostic(v.status(T0 + 4000));
  assert.equal(d.loginState, 'VERIFIED');
  assert.equal(d.balanceText, '₹432.5');
  assert.equal(d.balanceSource, 'api');
  assert.equal(d.fetchMode, 'active');
  assert.equal(d.syncAgeText, '4s ago');
  const empty = bridgeDiagnostic(null);
  assert.equal(empty.loginState, 'UNKNOWN');
  assert.equal(empty.balanceText, '—');
});

test('verifier: NO_SIGNAL still applies when only silence exists', () => {
  const v = new LoginVerifier({ startedAt: T0 });
  assert.equal(v.status(T0 + 15000).state, LOGIN_STATES.NO_SIGNAL);
  assert.equal(loginEvidenceLine(v.status(T0 + 15000)), 'No bridge signal — open DhaniWin with the bridge active');
});

// ── C. Wiring on the rebased files ────────────────────────────────
test('wiring: bridge publishes user state on all transports + active polling, no hard-coded wallet endpoint', () => {
  assert.ok(bridgeSrc.includes("type: 'DHANIWIN_USER_STATE'"), 'publishes DHANIWIN_USER_STATE');
  assert.ok(bridgeSrc.includes('/user_state.json'), 'publishes to RTDB /user_state');
  assert.ok(bridgeSrc.includes('activeWalletPoll'), 'session-powered active polling exists');
  assert.ok(bridgeSrc.includes("credentials: 'include'"), 're-query rides the live session cookies');
  assert.ok(bridgeSrc.includes('LEARNED_ENDPOINT_KEY') || bridgeSrc.includes('o101_learned_wallet_endpoint_v1'), 'learned endpoint persists (descriptor only)');
  assert.ok(bridgeSrc.includes('onApiWalletPayload'), 'endpoint learning is driven by real intercepted payloads');
  assert.ok(bridgeSrc.includes('firebasedatabase.app'), 'own RTDB traffic is excluded from interception');
  assert.ok(!bridgeSrc.includes('GetUserInfo'), 'no guessed wallet endpoint path is hard-coded');
  assert.ok(!bridgeSrc.includes('getWalletInfo'), 'no guessed wallet endpoint path is hard-coded');
});

test('wiring: orb-bridge consumes the state on channel + RTDB and persists the settings snapshot', () => {
  const orb = fs.readFileSync('systems/orb-bridge.js', 'utf8');
  assert.ok(orb.includes('observeBridgeState'), 'verifier consumes bridge states');
  assert.ok(orb.includes('pollRtdbUserState'), 'RTDB poll feed present');
  assert.ok(orb.includes('o101_bridge_state_v1'), 'snapshot persisted for settings');
  assert.ok(orb.includes('BRIDGE_STATE_FRESH_MS = 60000') || orb.includes('stateFreshMs'), 'freshness window is 60s');
});
