/**
 * fix_round_phone2.test.js — fix round 2 (owner phone test #2 of the
 * Auto-Pilot preview, 2026-10-24):
 *
 *  Fix 1 — a failed proxy load must fail FAST and HONESTLY. The
 *    worker hostname does not resolve (NXDOMAIN), so the embed shows
 *    the browser's DNS error page — which fires `load` and used to
 *    count as "loaded", leaving the pane dead forever. Now: a hard
 *    embed error falls back at once; a completed load with no bridge
 *    signal inside 5s falls back; the 15s no-load watchdog remains
 *    the outer bound; the fallback is one-shot; and every status
 *    surface names the failure (proxy unreachable, direct mode,
 *    bridge inactive, login cannot be verified in this mode).
 *  Fix 2 — REVERSED by fix round #2 (owner's order, 2026-10-24):
 *    the VERIFIED gate is deleted. The owner found the gate itself
 *    caused bugs and ordered the app fully usable without login.
 *    Dispatch still never paints the hero or claims "Ready" before
 *    the bridge's BET_PREPARED ack (that honesty rule stands).
 *  Fix 3 — CF_WORKER_BASE lives in exactly one place (mobile.js),
 *    with a localStorage 'o101_worker_base' runtime override that
 *    wins over the constant so a corrected address can be tested
 *    on-device without a rebuild.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { bridgeDiagnostic, PROXY_FAILED_LINE } from '../systems/orb-bridge.js';

const MOBILE = fs.readFileSync('mobile.js', 'utf8');
const SETTINGS = fs.readFileSync('settings.html', 'utf8');
const ORB = fs.readFileSync('systems/orb-bridge.js', 'utf8');
const PROXY_LINE = 'Proxy unreachable — direct mode · bridge inactive · login cannot be verified in this mode';
const WORKER = 'https://worker.test';
const ORIGIN = 'https://dhaniwin44.com';

function sliceFn(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  assert.ok(i > -1, `start marker found: ${startMarker}`);
  const j = src.indexOf(endMarker, i) + endMarker.length;
  assert.ok(j > endMarker.length, `end marker found: ${endMarker}`);
  return src.slice(i, j);
}

// Values produced inside a vm context carry that realm's prototypes;
// compare them through JSON so deepEqual is about content, not realm.
const J = x => JSON.parse(JSON.stringify(x));

// ── Fix 3: worker base resolution (behavioural, exact shipped code) ─
function resolveWith(preset) {
  const span = sliceFn(MOBILE, 'const CF_WORKER_BASE_DEFAULT', 'window.CF_WORKER_BASE = CF_WORKER_BASE;');
  const ctx = {};
  ctx.window = ctx;
  ctx.__preset = preset;
  vm.createContext(ctx);
  const script = `
    const localStorage = { getItem: k => (k === 'o101_worker_base' ? globalThis.__preset : null), setItem() {}, removeItem() {} };
    ${span}
    globalThis.__resolved = CF_WORKER_BASE;
  `;
  vm.runInContext(script, ctx);
  return ctx.__resolved;
}

test('worker base: default when no override is set', () => {
  assert.equal(resolveWith(null), 'https://wingo-edge-sync.itsrayzer.workers.dev');
});

test('worker base: o101_worker_base override wins and is normalised', () => {
  assert.equal(resolveWith('https://real-worker.example.dev/'), 'https://real-worker.example.dev', 'trailing slash stripped so /api/wingo cannot double-slash');
  assert.equal(resolveWith('  https://real-worker.example.dev/sub  '), 'https://real-worker.example.dev/sub', 'whitespace trimmed');
});

test('worker base: a non-URL override is ignored, never trusted', () => {
  assert.equal(resolveWith('notaurl'), 'https://wingo-edge-sync.itsrayzer.workers.dev');
  assert.equal(resolveWith(''), 'https://wingo-edge-sync.itsrayzer.workers.dev');
});

test('worker base: the URL literal lives in exactly one place in mobile.js', () => {
  const count = MOBILE.split('wingo-edge-sync.itsrayzer.workers.dev').length - 1;
  assert.equal(count, 1, 'one literal — the default; everything else reads CF_WORKER_BASE');
  assert.ok(MOBILE.includes('`${CF_WORKER_BASE}/api/wingo?tf=${tf}&_=${Date.now()}`'.replace('${tf}', '${tf}')) || MOBILE.includes('${CF_WORKER_BASE}/api/wingo'), 'results fetch consumes the resolved base');
  assert.ok(MOBILE.includes("const WORKER_BASE_OVERRIDE_KEY = 'o101_worker_base'"), 'override key named once');
});

// ── Fix 1: the fallback state machine (behavioural, exact shipped code)
function loadTransportMachine() {
  const transportSrc = fs.readFileSync('systems/dhani-transport.js', 'utf8');
  const span = sliceFn(MOBILE, 'function proxifyDhaniUrl(url)', 'window.noteDhaniTransport = noteDhaniTransport;');
  const ctx = {};
  ctx.window = ctx;
  vm.createContext(ctx);
  const script = `
    ${transportSrc}
    const __store = new Map();
    const localStorage = {
      getItem: k => (__store.has(k) ? __store.get(k) : null),
      setItem: (k, v) => __store.set(k, String(v)),
      removeItem: k => __store.delete(k)
    };
    const __timers = new Map();
    let __tid = 0;
    function setTimeout(fn, ms) { const id = ++__tid; __timers.set(id, { fn, ms }); return id; }
    function clearTimeout(id) { __timers.delete(id); }
    const __iframe = { src: '', __listeners: {},
      addEventListener(t, f) { (this.__listeners[t] = this.__listeners[t] || []).push(f); } };
    const __bar = { textContent: '' };
    function $(id) { return id === 'dhaniwinIframe' ? __iframe : id === 'mobileWebAddressBarText' ? __bar : null; }
    const __statusCalls = [];
    function setMobileBridgeStatus(connected, label) { __statusCalls.push([connected, label]); }
    const CF_WORKER_BASE = '${WORKER}';
    const DHANIWIN_INTERVAL_URLS = { '30s': '${ORIGIN}/WinGo/WinGo_30S', '1m': '${ORIGIN}/WinGo/WinGo_1M', '3m': '${ORIGIN}/WinGo/WinGo_3M', '5m': '${ORIGIN}/WinGo/WinGo_5M' };
    ${span}
    globalThis.__t = {
      noteDhaniTransport, runDhaniProxyFallback, noteDhaniBridgeSignal,
      iframe: __iframe, bar: __bar, store: __store, statusCalls: __statusCalls,
      timers: __timers,
      fire: (type) => { (__iframe.__listeners[type] || []).slice().forEach(f => f()); },
      fireTimer: (ms) => { for (const [id, t] of [...__timers]) { if (t.ms === ms) { __timers.delete(id); t.fn(); return true; } } return false; },
      pendingMs: () => [...__timers.values()].map(t => t.ms).sort((a, b) => a - b),
      transport: () => window.__o101DhaniTransport,
      proxyFailed: () => window.__o101DhaniProxyFailed
    };
  `;
  vm.runInContext(script, ctx);
  return ctx.__t;
}

test('fallback: completed load with no bridge signal falls back to direct within the 5s window', () => {
  const t = loadTransportMachine();
  const proxied = WORKER + '/proxy/dhaniwin/';
  t.iframe.src = proxied;
  t.noteDhaniTransport(proxied);
  assert.deepEqual(J(t.pendingMs()), [15000], 'no-load watchdog armed at 15s');
  t.fire('load'); // e.g. the browser DNS error page completing
  assert.deepEqual(J(t.pendingMs()), [5000], 'load swaps the watchdog for the 5s bridge-signal window');
  assert.equal(t.fireTimer(5000), true);
  assert.equal(t.iframe.src, ORIGIN + '/', 'embed now loads the direct URL');
  assert.equal(t.transport(), 'direct', 'transport recorded as direct');
  assert.equal(t.proxyFailed(), true, 'failure recorded on the window');
  assert.ok(t.store.get('o101_dhani_proxy_failed'), 'failure persisted for Settings');
  assert.equal(t.store.get('o101_dhani_transport'), 'direct');
  assert.ok(t.statusCalls.some(([c, l]) => c === false && l === PROXY_LINE), 'bridge status states the proxy failure in plain words');
});

test('fallback: a hard embed error falls back immediately, without waiting for any timer', () => {
  const t = loadTransportMachine();
  const proxied = WORKER + '/proxy/dhaniwin/login';
  t.iframe.src = proxied;
  t.noteDhaniTransport(proxied);
  t.fire('error');
  assert.equal(t.iframe.src, ORIGIN + '/login', 'direct equivalent loaded at once');
  assert.equal(t.proxyFailed(), true);
  assert.deepEqual(J(t.pendingMs()), [], 'all timers cleared');
});

test('fallback: the 15s no-load watchdog still bounds a load that never completes', () => {
  const t = loadTransportMachine();
  const proxied = WORKER + '/proxy/dhaniwin/';
  t.iframe.src = proxied;
  t.noteDhaniTransport(proxied);
  assert.equal(t.fireTimer(15000), true);
  assert.equal(t.iframe.src, ORIGIN + '/');
  assert.equal(t.store.get('o101_dhani_proxy_failed'), 'load-timeout');
});

test('fallback: one-shot — a second attempt changes nothing', () => {
  const t = loadTransportMachine();
  const proxied = WORKER + '/proxy/dhaniwin/';
  t.iframe.src = proxied;
  t.noteDhaniTransport(proxied);
  t.fire('error');
  const srcAfter = t.iframe.src;
  const statusCount = t.statusCalls.length;
  t.runDhaniProxyFallback('again');
  assert.equal(t.iframe.src, srcAfter);
  assert.equal(t.statusCalls.length, statusCount, 'no duplicate fallback, no duplicate status');
});

test('fallback: a bridge signal inside the window cancels the fallback and clears a stale failure', () => {
  const t = loadTransportMachine();
  const proxied = WORKER + '/proxy/dhaniwin/';
  t.iframe.src = proxied;
  t.noteDhaniTransport(proxied);
  t.fire('load');
  t.noteDhaniBridgeSignal(); // bridge handshake/state arrived in time
  assert.deepEqual(J(t.pendingMs()), [], 'both timers cancelled by the signal');
  assert.equal(t.fireTimer(5000), false, 'nothing left to fire');
  assert.equal(t.iframe.src, proxied, 'still on the proxy route');
  assert.ok(!t.proxyFailed(), 'no failure recorded');
});

test('fallback wiring pins: signal hook, timers, one-shot flag, honest status text', () => {
  assert.ok(MOBILE.includes('DHANI_PROXY_BRIDGE_SIGNAL_MS = 5000'), 'bridge-signal window is 5s');
  assert.ok(MOBILE.includes('DHANI_PROXY_LOAD_TIMEOUT_MS = 15000'), 'outer watchdog unchanged');
  assert.ok(MOBILE.includes("runDhaniProxyFallback('no-bridge-signal')"), 'silent load falls back');
  assert.ok(MOBILE.includes("runDhaniProxyFallback('load-error')"), 'hard error falls back');
  assert.ok(MOBILE.includes("runDhaniProxyFallback('load-timeout')"), 'watchdog falls back');
  const fb = sliceFn(MOBILE, 'function runDhaniProxyFallback(reason)', 'window.runDhaniProxyFallback = runDhaniProxyFallback;');
  assert.ok(fb.indexOf('_dhaniProxyFallbackUsed = true') > -1, 'one-shot flag set inside the fallback');
  assert.ok(fb.includes('unproxifyDhaniUrl(expected)'), 'fallback target is the direct equivalent of the proxied URL');
  assert.ok(fb.includes('markDhaniProxyFailed(reason)'), 'failure is recorded');
  assert.ok(fb.includes(PROXY_LINE), 'fallback status text names the failure');
  const handler = sliceFn(MOBILE, 'function handleMobileBridgeMessage(msg)', 'function setMobileBridgeStatus(');
  assert.ok(handler.includes('noteDhaniBridgeSignal()'), 'bridge messages feed the signal hook');
  assert.ok(handler.includes("msg.type === 'DHANIWIN_BRIDGE_HANDSHAKE'") && handler.includes("msg.type === 'DHANIWIN_USER_STATE'"), 'handshake + user state count as bridge life');
});

// ── Fix 1: wording surfaces agree ───────────────────────────────────
test('diagnostic: proxy-failed line overrides on direct, never on proxy', () => {
  assert.equal(PROXY_FAILED_LINE, PROXY_LINE, 'orb-bridge exports the same sentence the other surfaces print');
  const login = { state: 'UNKNOWN', balance: null, balanceSource: null, fetchMode: 'pending', stateAgeMs: 1000, evidence: [] };
  const dFail = bridgeDiagnostic(login, 'direct', true);
  assert.equal(dFail.line, PROXY_LINE);
  assert.equal(dFail.proxyFailed, true);
  assert.equal(dFail.fetchMode, 'inactive (direct load)', 'mode stays honestly inactive');
  const dDirect = bridgeDiagnostic(login, 'direct', false);
  assert.notEqual(dDirect.line, PROXY_LINE, 'a plain direct load keeps the generic line');
  assert.equal(dDirect.proxyFailed, false);
  const dProxy = bridgeDiagnostic(login, 'proxy', true);
  assert.equal(dProxy.proxyFailed, false, 'the flag can never stain a working proxy route');
  const dNull = bridgeDiagnostic(null, 'direct', true);
  assert.equal(dNull.line, PROXY_LINE, 'even before any login state exists, the failure is named');
});

test('wording surfaces: sheet + settings print the identical proxy-failure sentence', () => {
  assert.ok(ORB.includes('PROXY_FAILED_LINE'), 'sheet status line uses the shared sentence');
  assert.ok(ORB.includes('currentDhaniProxyFailed()'), 'sheet reads the recorded failure');
  assert.ok(SETTINGS.includes(PROXY_LINE), 'settings diagnostic prints the same sentence');
  assert.ok(SETTINGS.includes("localStorage.getItem('o101_dhani_proxy_failed')"), 'settings reads the persisted failure key');
});

// ── Fix 2 REVERSED (fix round #2, owner's order): the VERIFIED gate
// is GONE. The helpers and the refusal surface are deleted, and
// dispatch / auto-prep / chips / tabs proceed without any login
// check. What survives unchanged: the safety guards (circuit
// breaker, stop-loss / take-profit, solvency), the neutral
// sent-state, and "Ready" only from the bridge's BET_PREPARED ack
// (pinned below in 'no fake feedback').

test('no login gate: the verifier and refusal helpers are deleted from mobile.js', () => {
  assert.ok(!MOBILE.includes('isLoginVerifiedForBet'), 'no verifier helper left');
  assert.ok(!MOBILE.includes('refuseBetUnverified'), 'no refusal surface left');
  assert.ok(!MOBILE.includes('Login not verified yet'), 'no not-verified refusal wording left');
});

test('no login gate wiring: dispatch builds and posts without any login check', () => {
  const body = sliceFn(MOBILE, 'function dispatchMobileBetOrder(targetOverride)', 'window.dispatchMobileBetOrder = dispatchMobileBetOrder;');
  assert.ok(!body.includes('isLoginVerifiedForBet'), 'dispatch has no login check');
  assert.ok(!body.includes('refuseBetUnverified'), 'dispatch has no refusal');
  assert.ok(body.includes('const orderPayload'), 'the order is still built');
  assert.ok(body.includes('postMobileBridge(orderPayload)'), 'the order is still posted');
  assert.ok(body.includes('circuitBreakerPauseRounds'), 'the circuit-breaker guard survives');
  assert.ok(body.includes('waiting for the bridge'), 'the neutral sent-state survives');
});

test('no login gate wiring: arming auto-prep has no login check', () => {
  const body = sliceFn(MOBILE, 'function toggleMobileRealAutoBet(forceState)', 'window.toggleMobileRealAutoBet = toggleMobileRealAutoBet;');
  assert.ok(!body.includes('isLoginVerifiedForBet'), 'turn-on has no login check');
  assert.ok(!body.includes('refuseBetUnverified'), 'turn-on has no refusal');
  assert.ok(body.includes('dispatchMobileBetOrder()'), 'arming still dispatches');
});

test('no login gate wiring: the sheet stake chips set the base without any login check', () => {
  const body = sliceFn(MOBILE, 'function setAssistantBaseStake(amt)', 'window.setAssistantBaseStake = setAssistantBaseStake;');
  assert.ok(!body.includes('isLoginVerifiedForBet'), 'chips have no login check');
  assert.ok(body.indexOf('MobileBridgeState.baseStake = amount') > -1, 'the chip still sets the base');
});

test('no login gate wiring: prediction tabs are never blocked, and no tab wears a lock', () => {
  assert.ok(!MOBILE.includes("if (tab !== 'web' && !isUserLoggedIn())"), 'the tab gate is gone');
  const unlockBody = sliceFn(MOBILE, 'function updateAppUnlockState()', 'window.updateAppUnlockState = updateAppUnlockState;');
  assert.ok(!unlockBody.includes('toggleUnlockModal(true)'), 'logged-out never reopens the unlock modal');
  assert.ok(!unlockBody.includes('🔒'), 'no lock badge is ever set on a tab');
});

test('no fake feedback: dispatch never paints the hero or claims Ready before the bridge ack', () => {
  const body = sliceFn(MOBILE, 'function dispatchMobileBetOrder(targetOverride)', 'window.dispatchMobileBetOrder = dispatchMobileBetOrder;');
  assert.ok(!body.includes("targetEl.textContent = target"), 'no hero target paint at dispatch time');
  assert.ok(!MOBILE.includes('👉 Ready:'), 'the presumptive Ready claim is gone from the app');
  assert.ok(body.includes('waiting for the bridge'), 'dispatch status is a neutral sent-state');
  const prep = sliceFn(MOBILE, "msg.type === 'DHANIWIN_BET_PREPARED'", "msg.type === 'DHANIWIN_BET_PREP_FAILED'");
  assert.ok(prep.includes('Tap Bet'), 'the Ready/Tap Bet state comes only from the bridge BET_PREPARED ack');
});

test('gate uniformity: Auto-Pilot confirm passes the same VERIFIED check (already gated, pinned)', () => {
  assert.ok(ORB.includes('verified: login.state === LOGIN_STATES.VERIFIED'), 'confirmAutoPilotBet feeds the strict state into confirmFire');
  const ap = fs.readFileSync('systems/autoPilot.js', 'utf8');
  assert.ok(ap.includes("type: 'EXECUTE_REAL_BET'"), 'the governed order builder is the only other order source in the mobile app');
});
