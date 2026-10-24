/**
 * fix_round_bridge.test.js — Fix round "bridge transport + one verdict"
 * (owner phone test of the Auto-Pilot preview, 2026-10-24):
 *
 * Fix A — the embedded DhaniWin must ride the Cloudflare edge proxy so
 * the worker injects dhaniwin-bridge.js into the page; on a direct load
 * the bridge can never exist and every diagnostic must say so.
 * Fix B — the assistant sheet has ONE verdict surface: the hero follows
 * the locked governed verdict on every cycle (SKIP can never coexist
 * with a prediction), and the status region is fixed-height so verdict
 * text swaps cannot resize the sheet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { bridgeDiagnostic, heroVerdictView, LOGIN_STATES } from '../systems/orb-bridge.js';

const WORKER = 'https://wingo-edge-sync.itsrayzer.workers.dev';
const ORIGIN = 'https://dhaniwin44.com';

function loadTransport() {
  const src = fs.readFileSync(new URL('../systems/dhani-transport.js', import.meta.url), 'utf8');
  const ctx = {};
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.DhaniTransport;
}

// ── Fix A: URL routing (pure) ──────────────────────────────────────
test('proxify: built-in DhaniWin URLs ride the worker proxy route', () => {
  const T = loadTransport();
  assert.equal(T.proxifyDhaniUrl(ORIGIN + '/', WORKER), WORKER + '/proxy/dhaniwin/');
  assert.equal(T.proxifyDhaniUrl(ORIGIN, WORKER), WORKER + '/proxy/dhaniwin/');
  assert.equal(T.proxifyDhaniUrl(ORIGIN + '/login', WORKER), WORKER + '/proxy/dhaniwin/login');
  assert.equal(
    T.proxifyDhaniUrl(ORIGIN + '/register?inviteCode=EEJKXQN&from=app', WORKER),
    WORKER + '/proxy/dhaniwin/register?inviteCode=EEJKXQN&from=app'
  );
  assert.equal(T.proxifyDhaniUrl(ORIGIN + '/WinGo/WinGo_30S', WORKER), WORKER + '/proxy/dhaniwin/WinGo/WinGo_30S');
  assert.equal(T.proxifyDhaniUrl(ORIGIN + '/WinGo/WinGo_5M', WORKER), WORKER + '/proxy/dhaniwin/WinGo/WinGo_5M');
});

test('proxify: custom and foreign URLs are returned untouched', () => {
  const T = loadTransport();
  const custom = 'https://dhaniwin0.com/WinGo/WinGo_30S';
  assert.equal(T.proxifyDhaniUrl(custom, WORKER), custom, 'a user-chosen mirror domain is never rewritten');
  assert.equal(T.proxifyDhaniUrl('https://example.com/', WORKER), 'https://example.com/');
  assert.equal(
    T.proxifyDhaniUrl('https://dhaniwin44.com.evil.example/', WORKER),
    'https://dhaniwin44.com.evil.example/',
    'a look-alike host that merely starts with the origin string is not proxified'
  );
  const already = WORKER + '/proxy/dhaniwin/login';
  assert.equal(T.proxifyDhaniUrl(already, WORKER), already, 'proxify is idempotent');
  assert.equal(T.proxifyDhaniUrl(null, WORKER), null);
  assert.equal(T.proxifyDhaniUrl(ORIGIN + '/', ''), ORIGIN + '/', 'no worker base → no rewrite');
});

test('transport classification + unproxify round-trip (fallback path)', () => {
  const T = loadTransport();
  assert.equal(T.dhaniTransportForUrl(WORKER + '/proxy/dhaniwin/', WORKER), 'proxy');
  assert.equal(T.dhaniTransportForUrl(WORKER + '/proxy/dhaniwin/WinGo/WinGo_1M', WORKER), 'proxy');
  assert.equal(T.dhaniTransportForUrl(ORIGIN + '/', WORKER), 'direct');
  assert.equal(T.dhaniTransportForUrl('https://dhaniwin0.com/', WORKER), 'direct');
  const proxied = T.proxifyDhaniUrl(ORIGIN + '/WinGo/WinGo_3M?x=1', WORKER);
  assert.equal(T.unproxifyDhaniUrl(proxied, WORKER), ORIGIN + '/WinGo/WinGo_3M?x=1');
  assert.equal(T.unproxifyDhaniUrl(ORIGIN + '/login', WORKER), ORIGIN + '/login', 'unproxify leaves direct URLs alone');
});

// ── Fix A: wiring pins in mobile.js / mobile.html ──────────────────
test('mobile.js routes the entry flow through the proxy and keeps custom URLs sovereign', () => {
  const js = fs.readFileSync('mobile.js', 'utf8');
  const entry = js.slice(js.indexOf('function getDhaniEntryUrl()'), js.indexOf('window.getDhaniEntryUrl'));
  const customBranch = entry.indexOf('return custom;');
  assert.ok(customBranch > -1, 'custom URL branch returns the custom value');
  assert.ok(entry.indexOf('proxifyDhaniUrl(DHANIWIN_HOME_URL)') > customBranch, 'built-in home is proxified AFTER the custom branch');
  // Fix round #3: no login-state routing from our side — the entry
  // URL is always home, and the login nav functions are deleted.
  assert.ok(!entry.includes('DHANIWIN_LOGIN_URL'), 'no login variant in the entry URL');
  assert.ok(!entry.includes('DHANIWIN_REGISTRATION_URL'), 'no registration variant in the entry URL');
  assert.ok(!js.includes('function openDhaniLogin'), 'openDhaniLogin is gone');
  assert.ok(!js.includes('function openDhaniRegister'), 'openDhaniRegister is gone');
  assert.ok(js.includes("DHANIWIN_INTERVAL_URLS[tfKey] = proxifyDhaniUrl(DHANIWIN_INTERVAL_URLS[tfKey])"), 'interval deep links proxified');
  assert.ok(!js.includes("const wingoUrl = 'https://dhaniwin44.com/WinGo/WinGo_30S'"), 'the login flow no longer hardcodes a direct WinGo URL');
  assert.ok(!js.includes("|| 'https://dhaniwin44.com/WinGo/WinGo_30S'"), 'the bet-prep fallback no longer hardcodes a direct WinGo URL');
});

test('proxy load failure falls back to direct and records the honest transport', () => {
  const js = fs.readFileSync('mobile.js', 'utf8');
  assert.ok(js.includes('function noteDhaniTransport(url)'), 'transport recorder exists');
  assert.ok(js.includes("localStorage.setItem(DHANI_TRANSPORT_KEY, transport)"), 'transport persisted for the settings document');
  assert.ok(js.includes('DHANI_PROXY_LOAD_TIMEOUT_MS = 15000'), 'load watchdog armed at 15s');
  assert.ok(js.includes('_dhaniProxyFallbackUsed = true'), 'fallback is one-shot');
  assert.ok(js.includes('unproxifyDhaniUrl(expected)'), 'fallback target is the direct equivalent');
  assert.ok(js.includes('noteDhaniTransport(targetSrc);'), 'the central loader records the transport');
});

test('mobile.html loads the transport module before mobile.js', () => {
  const html = fs.readFileSync('mobile.html', 'utf8');
  const tIdx = html.indexOf('systems/dhani-transport.js');
  assert.ok(tIdx > -1, 'transport module included');
  assert.ok(tIdx < html.indexOf('src="mobile.js"'), 'transport module loads before mobile.js');
});

// ── Fix A: diagnostic honesty ──────────────────────────────────────
const fakeLogin = {
  state: LOGIN_STATES.UNKNOWN, balance: null, balanceSource: null,
  fetchMode: 'pending', stateAgeMs: null, syncAgeMs: null, evidence: [], everSynced: false
};

test('bridgeDiagnostic: direct transport reads bridge-inactive, proxy passes the real mode', () => {
  const direct = bridgeDiagnostic(fakeLogin, 'direct');
  assert.equal(direct.fetchMode, 'inactive (direct load)');
  assert.equal(direct.transport, 'direct');
  const proxy = bridgeDiagnostic(fakeLogin, 'proxy');
  assert.equal(proxy.fetchMode, 'pending', 'proxied route keeps the bridge’s own pending → active modes');
  assert.equal(proxy.transport, 'proxy');
  const noLogin = bridgeDiagnostic(null, 'direct');
  assert.equal(noLogin.fetchMode, 'inactive (direct load)', 'even with no login state, direct never promises a bridge');
});

test('diagnostic surfaces carry the direct-load honesty', () => {
  const bridge = fs.readFileSync('systems/orb-bridge.js', 'utf8');
  assert.ok(bridge.includes("currentDhaniTransport() === 'direct'"), 'sheet status line has a direct branch');
  assert.ok(bridge.includes('Direct load — bridge inactive'), 'sheet status states the bridge is inactive on direct');
  assert.ok(bridge.includes('bridgeDiagnostic(login, currentDhaniTransport())'), 'snapshot carries the transport-aware diagnostic');
  const settings = fs.readFileSync('settings.html', 'utf8');
  assert.ok(settings.includes("localStorage.getItem('o101_dhani_transport')"), 'settings diagnostic reads the recorded transport');
  assert.ok(settings.includes("mode = 'inactive (direct load)'"), 'settings mode is honest on direct');
});

// ── Fix B: the hero verdict view ───────────────────────────────────
const TARGET_TOKENS = ['BIG', 'SMALL', 'GREEN', 'RED', 'VIOLET'];

test('heroVerdictView: SKIP renders SKIP and no prediction token anywhere', () => {
  // The display-overlaid SKIP gate still carries the engine's pick and
  // probability — neither may leak into the hero.
  const view = heroVerdictView({ decision: 'SKIP', pick: 'BIG', prob: 0.83, reason: 'Login not verified yet' });
  assert.equal(view.decision, 'SKIP');
  assert.equal(view.targetText, 'SKIP');
  assert.equal(view.confText, '—');
  for (const tok of TARGET_TOKENS) {
    assert.ok(!view.targetText.includes(tok) || view.targetText === 'SKIP', `no ${tok} in target`);
    assert.ok(!view.confText.includes(tok), `no ${tok} in confidence`);
  }
  assert.ok(!/\d+%/.test(view.confText), 'no percentage confidence on a SKIP');
});

test('heroVerdictView: BET renders exactly one target with its governed confidence', () => {
  const view = heroVerdictView({ decision: 'BET', pick: 'SMALL', prob: 0.62 });
  assert.equal(view.decision, 'BET');
  assert.equal(view.targetText, 'SMALL');
  assert.equal(view.confText, '62%');
  const noProb = heroVerdictView({ decision: 'BET', pick: 'BIG', prob: null });
  assert.equal(noProb.targetText, 'BIG');
  assert.equal(noProb.confText, '—', 'no invented confidence when the gate carries none');
  const none = heroVerdictView(null);
  assert.equal(none.targetText, '—');
  assert.equal(none.confText, '—');
});

test('hero ownership: governed render runs every cycle; native render mirrors the lock', () => {
  const bridge = fs.readFileSync('systems/orb-bridge.js', 'utf8');
  assert.ok(bridge.includes('renderHeroVerdict(gate);'), 'cycle renders the hero from the locked verdict unconditionally');
  assert.ok(bridge.includes('window.__o101Verdict ='), 'the lock is published for native renders');
  const renderSignal = bridge.slice(bridge.indexOf('function renderSignal'), bridge.indexOf('function renderSignal') + 1400);
  assert.ok(!renderSignal.includes("$('mobileWebTargetDisplay')"), 'renderSignal no longer writes the hero target');
  assert.ok(!renderSignal.includes("$('assistantConfBadge')"), 'renderSignal no longer writes the hero confidence');
  const js = fs.readFileSync('mobile.js', 'utf8');
  const ui = js.slice(js.indexOf('function _updateAllPredictionUI'), js.indexOf('function _updateAllPredictionUI') + 9000);
  assert.ok(ui.includes('window.__o101Verdict'), 'native prediction render consults the governed lock');
  assert.ok(ui.includes("governedVerdict.decision === 'BET' ? (governedVerdict.pick || '—') : (governedVerdict.decision === 'SKIP' ? 'SKIP' : '—')"), 'native render mirrors the locked verdict verbatim');
});

test('sheet layout cannot shift on verdict text swaps (fixed-height regions)', () => {
  const html = fs.readFileSync('mobile.html', 'utf8');
  const status = html.slice(html.indexOf('id="bridgeStatusLine"') - 200, html.indexOf('id="bridgeStatusLine"') + 400);
  assert.ok(status.includes('h-[62px]'), 'bridge status line has a fixed height');
  assert.ok(status.includes('overflow-y-auto'), 'long reasons scroll inside the fixed region instead of reflowing');
  const slot = html.indexOf('id="autoPilotConfirmBtn"');
  const slotWrap = html.slice(slot - 500, slot);
  assert.ok(slotWrap.includes('h-[34px]'), 'the confirm button slot height is reserved while nothing is staged');
  const session = html.slice(html.indexOf('id="autoPilotSessionLine"') - 200, html.indexOf('id="autoPilotSessionLine"') + 200);
  assert.ok(session.includes('h-[26px]'), 'Auto-Pilot session line has a fixed height');
  const css = fs.readFileSync('mobile.css', 'utf8');
  assert.ok(css.includes('#bridgeStatusLine') && css.includes('height: 62px'), 'plain-CSS fixed height backs the status region (no Tailwind dependency)');
  assert.ok(css.includes('#autoPilotConfirmSlot') && css.includes('height: 34px'), 'plain-CSS fixed height backs the confirm slot');
  const target = html.slice(html.indexOf('id="mobileWebTargetDisplay"') - 100, html.indexOf('id="mobileWebTargetDisplay"') + 300);
  assert.ok(target.includes('>—</span>'), 'hero target paints neutral before the first governed render');
  assert.ok(!html.includes('>84%</span>'), 'the old fake 84% initial confidence is gone');
});
