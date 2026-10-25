/**
 * Fix round #6 pins (2026-10-25, owner complaints on the mini-ship #8
 * direct build: (1) "not possible to login same account in two
 * accounts — make it automated"; (2) "always saying skip"; (3) "3-4s
 * white screen while the Dhani app loads").
 *
 * Pins: (1) the bridge is a proper one-time Tampermonkey userscript
 * that auto-runs inside the app's OWN DhaniWin iframe (no @noframes
 * by design) with a .user.js install target byte-identical to the
 * bridge; NO RTDB order channel exists — live RTDB rules deny even
 * reads (proven 2026-10-25 by a direct GET returning Permission
 * denied), so orders travel ONLY via window postMessage, which the
 * app's iframe provides. (2) The always-skip cause is a starved
 * store on fresh preview origins (the live loop replaces history
 * with ONE upstream page per cycle, and localStorage is per-origin):
 * the deep warm-up feeds REAL older upstream rounds to a deep
 * backfill that records every model's walk-forward pick per settled
 * round — no threshold moves, and re-walks never double-count.
 * (3) The DhaniWin iframe surface gets a branded matte loading
 * splash that clears ONLY on the iframe's real `load` event, with
 * an 8s slow-connection note and a manual dismiss.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { ModelHistoryStore, walkForwardEntries } from '../systems/orb-bridge.js';
import { evaluateSignalGate, GATE_DECISIONS } from '../systems/signalGate.js';

const require = createRequire(import.meta.url);
const arena = require('../scripts/arena_models.cjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function synthHistory(n) {
  let seed = 987654;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [];
  for (let i = 0; i < n; i++) {
    const num = Math.floor(rnd() * 10);
    out.push({
      period: String(2025102508000 + i),
      number: num,
      size: num >= 5 ? 'BIG' : 'SMALL',
      color: num === 0 ? 'RED' : num === 5 ? 'GREEN' : (num % 2 ? 'GREEN' : 'RED'),
    });
  }
  return out;
}

// ── (1) Userscript: header, install target, no RTDB order channel ──

test('userscript header: dhaniwin family match, iframe operation, no @noframes', () => {
  const bridge = read('dhaniwin-bridge.js');
  const header = bridge.slice(0, bridge.indexOf('==/UserScript=='));
  assert.match(header, /@version\s+3\.3/);
  const matches = header.match(/@match\s+.*dhaniwin.*/g) || [];
  assert.ok(matches.length >= 5, `expected >=5 dhaniwin @match lines, got ${matches.length}`);
  assert.ok(matches.some((m) => m.includes('*dhaniwin*')), 'wildcard *dhaniwin* match covers rotated domains');
  assert.match(header, /@run-at\s+document-idle/);
  assert.match(header, /@grant\s+none/);
  assert.ok(!/^\/\/ @noframes/m.test(header), 'no @noframes: the script MUST run inside the app iframe');
  assert.match(header, /iframe/i);
});

test('copy-assets emits a byte-identical .user.js Tampermonkey target', () => {
  const copyAssets = read('scripts/copy-assets.js');
  assert.ok(copyAssets.includes('dhaniwin-bridge.user.js'), 'copy-assets must emit the .user.js target');
  const a = fs.readFileSync(path.join(root, 'deploy/dhaniwin-bridge.js'));
  const b = fs.readFileSync(path.join(root, 'deploy/dhaniwin-bridge.user.js'));
  assert.ok(a.equals(b), '.user.js must be byte-identical to dhaniwin-bridge.js');
});

test('Settings gains the userscript row; frozen bridge ids untouched', () => {
  const settings = read('settings.html');
  for (const id of ['bridgeUserscriptLink', 'bridgeUserscriptCopyBtn']) {
    assert.ok(settings.includes(`id="${id}"`), `settings.html must contain ${id}`);
  }
  assert.ok(settings.includes('dhaniwin-bridge.user.js'));
  assert.ok(settings.includes('Tampermonkey'));
  assert.ok(settings.includes('Firefox'));
  for (const frozen of ['bridgeDiagLine', 'bridgeDiagDetail', 'bridgeBookmarkletLink', 'bridgeBookmarkletCopyBtn']) {
    assert.ok(settings.includes(`id="${frozen}"`), `frozen id ${frozen} must survive`);
  }
});

test('no RTDB order channel anywhere: app files never PUT/POST orders to RTDB', () => {
  for (const f of ['mobile.js', 'systems/orb-bridge.js']) {
    const src = read(f);
    assert.ok(!src.includes('orders.json'), `${f} must not reference an RTDB orders node`);
    assert.ok(!/RTDB_BASE.*PUT|PUT.*RTDB_BASE/.test(src), `${f} must not PUT to RTDB`);
  }
  const bridge = read('dhaniwin-bridge.js');
  assert.ok(!bridge.includes('/orders'), 'bridge must not poll or write an orders node');
});

// ── (2) Deep warm-up: real rounds → evaluated counts → gate opens ──

test('deep backfill walk: 250 real rounds lift every model past the 200 gate, idempotently', () => {
  const models = arena.ARENA_CANONICAL_MODELS;
  const gen = arena.generateModelNextPrediction;
  const ev = arena.evaluatePredictionCorrectness;
  const deep = synthHistory(250);
  const store = new ModelHistoryStore(null);
  // Walk newest -> oldest, exactly like backfillDeep.
  for (let idx = deep.length - 1; idx >= 1; idx--) {
    if (!store.hasPeriod('30s', deep[idx].period)) {
      store.recordRound('30s', deep[idx].period, walkForwardEntries(models, deep, idx, gen, ev, null, 'deep'));
    }
  }
  assert.equal(store.recordedPeriodCount('30s'), 249);
  const s = store.modelStats('30s', models[0].id);
  assert.ok(s && s.evaluated >= 200, `leading model must clear 200 after deep walk, got ${s ? s.evaluated : null}`);
  // Re-walk: idempotent per (tf, period) — nothing double-counts.
  for (let idx = deep.length - 1; idx >= 1; idx--) {
    if (!store.hasPeriod('30s', deep[idx].period)) {
      store.recordRound('30s', deep[idx].period, walkForwardEntries(models, deep, idx, gen, ev, null, 'deep'));
    }
  }
  const s2 = store.modelStats('30s', models[0].id);
  assert.equal(s2.evaluated, s.evaluated, 're-walk must not double-count');
});

test('gate reason names the LIVE sample count, and 250 clears the sample check', () => {
  const cal = { isCalibrated: true, ece: 0.0, count: 60 };
  const g14 = evaluateSignalGate({ pick: 'GREEN', sampleSize: 14, calibratedProb: 0.65, calibration: cal, contenders: [] });
  assert.equal(g14.decision, GATE_DECISIONS.SKIP);
  assert.match(g14.reason, /only 14 evaluated rounds \(needs 200\)/);
  const g15 = evaluateSignalGate({ pick: 'GREEN', sampleSize: 15, calibratedProb: 0.65, calibration: cal, contenders: [] });
  assert.match(g15.reason, /only 15 evaluated rounds/, 'reason must track the live count, not a stale number');
  const g250 = evaluateSignalGate({ pick: 'GREEN', sampleSize: 250, calibratedProb: 0.65, calibration: cal, contenders: [] });
  assert.ok(!g250.reason.includes('Sample too small'), '250 evaluated rounds must pass the sample check');
  assert.equal(g250.decision, GATE_DECISIONS.BET);
});

test('warm-up wiring exists: paged upstream fetch + deep slot + orb-bridge deep walk', () => {
  const mobile = read('mobile.js');
  assert.ok(mobile.includes('warmDeepHistory'), 'mobile.js must define warmDeepHistory');
  assert.ok(mobile.includes('pageNo=${page}'), 'warm-up must page the upstream (pageNo=2..N)');
  assert.ok(mobile.includes('quant_deep_history_'), 'deep list must persist per-tf');
  assert.ok(mobile.includes('deepHistoryByTf'), 'deep list must live outside historyByTf (the live loop wipes that)');
  const orb = read('systems/orb-bridge.js');
  for (const marker of ['backfillDeep', 'consumeDeepHistory', 'deepBackfillGen', 'backfillGen']) {
    assert.ok(orb.includes(marker), `orb-bridge.js must contain ${marker}`);
  }
  assert.ok(orb.includes("walkForwardEntries(models, deepHistory, idx, gen, ev, patternCtx, 'deep')"), 'deep walk must record entries with source deep');
});

// ── (3) DhaniWin loading overlay ──

test('loading overlay: element, styles, and load-event wiring', () => {
  const html = read('mobile.html');
  for (const id of ['dhaniwinLoadingOverlay', 'dhaniwinLoadingText', 'dhaniwinLoadingDismissBtn']) {
    assert.ok(html.includes(`id="${id}"`), `mobile.html must contain ${id}`);
  }
  const css = read('mobile.css');
  assert.ok(css.includes('o101-loading-visible'), 'mobile.css must define the visible overlay class');
  // Round #10 (owner order): the matte spinner is gone; the overlay now
  // reuses the app loader's 3-dot quantum-wave animation exactly.
  assert.ok(css.includes('@keyframes appleQuantumWave'), 'mobile.css must define the reused app-loader wave keyframes');
  assert.ok(css.includes('.apple-dot {'), 'mobile.css must define the reused app-loader dot class');
  const mobile = read('mobile.js');
  for (const marker of ['showDhaniLoadingOverlay', 'hideDhaniLoadingOverlay', '8000']) {
    assert.ok(mobile.includes(marker), `mobile.js must contain ${marker}`);
  }
  // Wiring: show on navigation, hide on the iframe's real load event.
  assert.ok(mobile.includes('hookDhaniIframeLoad();\n  showDhaniLoadingOverlay();'), 'noteDhaniTransport must show the splash on every DhaniWin navigation');
  const loadBlock = mobile.slice(mobile.indexOf("iframe.addEventListener('load'"));
  assert.ok(loadBlock.slice(0, 800).includes('hideDhaniLoadingOverlay()'), 'iframe load must hide the splash');
});
