/**
 * betslip_dock.test.js — Addition 3 (2026-10-24): auto-hide the bottom
 * dock while the DhaniWin bet slip is open.
 *
 * Bridge side: the slip detector + edge-triggered watcher are a pure
 * block in dhaniwin-bridge.js (between the O101-BETSLIP markers),
 * driven here against a DOM fixture replicating the slip markup the
 * bridge's own bet engine recognises (visible .van-popup carrying a
 * stepper / the Total Amount row).
 * App side: wiring pins (the behaviour itself — real postMessage in,
 * dock class out, failsafe — is proven in the browser probe; see the
 * fix-round report).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const bridgeSrc = fs.readFileSync('dhaniwin-bridge.js', 'utf8');
const mobileJs = fs.readFileSync('mobile.js', 'utf8');

function loadBetSlipBlock() {
  const start = bridgeSrc.indexOf('// [O101-BETSLIP-START]');
  const end = bridgeSrc.indexOf('// [O101-BETSLIP-END]');
  assert.ok(start > -1 && end > start, 'betslip markers present');
  const src = bridgeSrc.slice(start, end);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.createBetSlipDetector = createBetSlipDetector; this.createBetSlipWatcher = createBetSlipWatcher;', ctx);
  return ctx;
}

// ── DOM fixture ────────────────────────────────────────────────────
function el({ id = '', display = 'block', visibility = 'visible', offsetParent = {}, stepper = false, text = '', inHud = false } = {}) {
  return {
    id,
    offsetParent,
    innerText: text,
    textContent: text,
    closest: sel => (sel === '#quant-ai-hud' ? (inHud ? {} : null) : null),
    querySelector: sel => (stepper && /stepper/.test(sel) ? {} : null)
  };
}
function fixtureDoc(popups) {
  return { querySelectorAll: () => popups };
}
const fakeWin = { getComputedStyle: p => ({ display: p.__display || 'block', visibility: p.__visibility || 'visible' }) };
function styled(e, display, visibility) { e.__display = display; e.__visibility = visibility; return e; }

test('detector: a visible popup with a stepper is the open slip', () => {
  const { createBetSlipDetector } = loadBetSlipBlock();
  const slip = el({ stepper: true, text: 'WinGo 30sec — Amount Quantity Total amount ₹1.00' });
  const d = createBetSlipDetector(fixtureDoc([slip]), fakeWin);
  assert.equal(d.detectBetSlipOpen(), true);
});

test('detector: Total Amount text alone also identifies the slip', () => {
  const { createBetSlipDetector } = loadBetSlipBlock();
  const slip = el({ text: 'Select Small · Amount 1 · Total amount ₹1.00 · Cancel' });
  const d = createBetSlipDetector(fixtureDoc([slip]), fakeWin);
  assert.equal(d.detectBetSlipOpen(), true);
});

test('detector: hidden slips, plain dialogs and our own surfaces are not the slip', () => {
  const { createBetSlipDetector } = loadBetSlipBlock();
  const hiddenSlip = styled(el({ stepper: true, text: 'Total amount' }), 'none', 'visible');
  const dialog = el({ text: 'Announcement — Confirm' }); // visible dialog, no stepper, no Total amount
  const ours = el({ id: 'dhaniwinAssistantModal', stepper: true, text: 'Total amount' });
  const d1 = createBetSlipDetector(fixtureDoc([hiddenSlip]), fakeWin);
  assert.equal(d1.detectBetSlipOpen(), false, 'display:none slip is closed');
  const d2 = createBetSlipDetector(fixtureDoc([dialog]), fakeWin);
  assert.equal(d2.detectBetSlipOpen(), false, 'a generic confirm dialog is not the bet slip');
  const d3 = createBetSlipDetector(fixtureDoc([ours]), fakeWin);
  assert.equal(d3.detectBetSlipOpen(), false, 'our own assistant modal is excluded');
  const d4 = createBetSlipDetector(fixtureDoc([]), fakeWin);
  assert.equal(d4.detectBetSlipOpen(), false, 'no popups → closed');
});

test('watcher: open → one message, churn → none, close → one message', () => {
  const { createBetSlipDetector, createBetSlipWatcher } = loadBetSlipBlock();
  const popups = [];
  const detector = createBetSlipDetector(fixtureDoc(popups), fakeWin);
  const sent = [];
  const watcher = createBetSlipWatcher(detector, open => sent.push(open));

  watcher.check();
  assert.deepEqual(sent, [], 'closed at boot: nothing sent');

  popups.push(el({ stepper: true, text: 'Total amount ₹1.00' }));
  watcher.check();
  assert.deepEqual(sent, [true], 'open transition sends exactly one open message');

  // Unrelated DOM churn while open: extra nodes appear/disappear,
  // the slip stays open — the watcher must stay silent.
  popups.push(el({ text: 'some toast' }));
  watcher.check();
  popups.pop();
  watcher.check();
  assert.deepEqual(sent, [true], 'no repeat messages while the state is unchanged');
  assert.equal(watcher.isOpen(), true);

  popups.length = 0;
  watcher.check();
  assert.deepEqual(sent, [true, false], 'close transition sends exactly one close message');
  watcher.check();
  assert.deepEqual(sent, [true, false], 'staying closed sends nothing more');
});

test('bridge wiring: debounced observer, transition message, state field', () => {
  assert.ok(bridgeSrc.includes('new MutationObserver('), 'observer installed');
  assert.ok(bridgeSrc.includes("attributeFilter: ['class', 'style']"), 'observes class/style transitions');
  assert.ok(bridgeSrc.includes('_betSlipDebounce = setTimeout('), 'debounced');
  assert.ok(bridgeSrc.includes("type: 'O101_BETSLIP'"), 'posts the O101_BETSLIP transition message');
  assert.ok(bridgeSrc.includes('betSlipOpen: !!t.betSlipOpen'), 'state publish carries betSlipOpen for late joiners');
  assert.ok(bridgeSrc.includes("publishUserState('betslip')"), 'transitions refresh the published state');
  assert.ok(bridgeSrc.includes('setInterval(checkBetSlip, 2000)'), 'interval backstop runs');
});

test('app wiring: message branches, dock-hidden mechanism, never-stuck restores', () => {
  const handler = mobileJs.slice(mobileJs.indexOf('function handleMobileBridgeMessage'), mobileJs.indexOf('function handleMobileBridgeMessage') + 1200);
  assert.ok(handler.includes("msg.type === 'O101_BETSLIP'"), 'transition messages handled');
  assert.ok(handler.includes("typeof msg.betSlipOpen === 'boolean'"), 'state-sync field handled');
  assert.ok(mobileJs.includes('function setBetSlipDockHidden(open)'), 'dock controller exists');
  assert.ok(mobileJs.includes("window._dockSetHidden(true)"), 'hides through the existing dock mechanism');
  assert.ok(mobileJs.includes(': 90000;'), '90s failsafe default');
  assert.ok(mobileJs.includes("window.__o101BetSlipFailsafeMs"), 'failsafe is test-overridable');
  assert.ok(mobileJs.includes('betSlipPeriodAtHide'), 'period-rollover restore armed');
  assert.ok(mobileJs.includes("closest('#dhaniwinFloatingOrb, #dockRestoreHandle')"), 'orb / restore-handle tap unlocks');
  // The assistant orb/sheet is never hidden by this feature.
  const block = mobileJs.slice(mobileJs.indexOf('Bet-slip dock auto-hide'), mobileJs.indexOf('window.setBetSlipDockHidden'));
  assert.ok(!block.includes("getElementById('dhaniwinAssistantSheet')") && !block.includes("getElementById('dhaniwinFloatingOrb')"), 'orb/sheet untouched by the hide');
});
