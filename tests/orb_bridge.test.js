/**
 * orb_bridge.test.js — Smart Ball bridge: per-model history store,
 * walk-forward pick computation, and the old pages' wiring (3-tab menu,
 * full-history rendering, theme + bridge script tags).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  ModelHistoryStore, MODEL_HISTORY_KEY, walkForwardEntries, nextRoundPicks
} from '../systems/orb-bridge.js';

const require = createRequire(import.meta.url);
const arena = require('../scripts/arena_models.cjs');

function fakeStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    _map: map
  };
}

test('ModelHistoryStore: records rounds and aggregates per model', () => {
  const store = new ModelHistoryStore(null);
  assert.equal(store.recordRound('30s', 'P1', [
    { modelId: 'a', pick: 'BIG', patternKey: 'pat1', patternName: 'Ladder', correct: true },
    { modelId: 'b', pick: 'RED', patternKey: null, correct: false }
  ]), true);
  assert.equal(store.recordRound('30s', 'P2', [
    { modelId: 'a', pick: 'BIG', patternKey: 'pat1', patternName: 'Ladder', correct: true },
    { modelId: 'b', pick: 'RED', patternKey: null, correct: true }
  ]), true);
  assert.equal(store.recordRound('30s', 'P3', [
    { modelId: 'a', pick: 'SMALL', patternKey: 'pat2', patternName: 'Zigzag', correct: false }
  ]), true);

  const a = store.modelStats('30s', 'a');
  assert.equal(a.evaluated, 3);
  assert.equal(a.wins, 2);
  assert.equal(a.losses, 1);
  assert.equal(a.winRate, 2 / 3);
  assert.equal(a.streak, 0); // last round was a loss
  assert.equal(a.recentEvaluated, 3);
  assert.equal(a.recentWinRate, 2 / 3);
  assert.ok(a.wilson > 0 && a.wilson < a.winRate, 'Wilson bound sits below the raw rate');

  const b = store.modelStats('30s', 'b');
  assert.equal(b.streak, 1);

  assert.equal(store.modelStats('30s', 'missing'), null);
  assert.equal(store.modelStats('1m', 'a'), null, 'timeframes are isolated');
  assert.equal(store.recordedPeriodCount('30s'), 3);
});

test('ModelHistoryStore: a settled round is never double-counted', () => {
  const store = new ModelHistoryStore(null);
  const entries = [{ modelId: 'a', pick: 'BIG', correct: true }];
  assert.equal(store.recordRound('30s', 'P1', entries), true);
  assert.equal(store.recordRound('30s', 'P1', entries), false, 'same period is a no-op');
  assert.equal(store.modelStats('30s', 'a').evaluated, 1);
  assert.equal(store.hasPeriod('30s', 'P1'), true);
  assert.equal(store.hasPeriod('30s', 'P2'), false);
});

test('ModelHistoryStore: persists to storage and reloads identically', () => {
  const storage = fakeStorage();
  const store = new ModelHistoryStore(storage);
  store.recordRound('30s', 'P1', [{ modelId: 'a', pick: 'BIG', patternKey: 'p', patternName: 'Pat', correct: true }]);
  store.save();
  assert.ok(storage._map.has(MODEL_HISTORY_KEY), 'versioned key written');

  const reloaded = new ModelHistoryStore(storage);
  const a = reloaded.modelStats('30s', 'a');
  assert.equal(a.evaluated, 1);
  assert.equal(a.wins, 1);
  assert.equal(reloaded.hasPeriod('30s', 'P1'), true);
});

test('ModelHistoryStore: pattern summary reports per-pattern hit rates, honestly empty when none', () => {
  const store = new ModelHistoryStore(null);
  store.recordRound('30s', 'P1', [
    { modelId: 'a', pick: 'BIG', patternKey: 'pat1', patternName: 'Ladder', correct: true },
    { modelId: 'b', pick: 'RED', patternKey: null, correct: true }
  ]);
  store.recordRound('30s', 'P2', [
    { modelId: 'a', pick: 'BIG', patternKey: 'pat1', patternName: 'Ladder', correct: false }
  ]);
  const summary = store.patternSummary('30s', 'a');
  assert.equal(summary.length, 1);
  assert.equal(summary[0].key, 'pat1');
  assert.equal(summary[0].fired, 2);
  assert.equal(summary[0].hits, 1);
  assert.equal(summary[0].hitRate, 0.5);
  assert.deepEqual(store.patternSummary('30s', 'b'), [], 'no pattern attribution -> empty, never fabricated');
});

test('walkForwardEntries: picks use only data from BEFORE the round', () => {
  const models = arena.ARENA_CANONICAL_MODELS.slice(0, 5);
  const nums = [3, 7, 1, 8, 2, 9, 4, 6, 0, 5, 3, 8];
  const history = nums.map((n, i) => ({
    period: 'P' + (100 + i), number: n,
    size: n >= 5 ? 'BIG' : 'SMALL',
    color: n % 2 === 0 ? 'RED' : 'GREEN', gap: false
  }));
  const sliceLengths = [];
  const genSpy = (model, slice, stats) => {
    sliceLengths.push(slice.length);
    return arena.generateModelNextPrediction(model, slice, stats);
  };
  const idx = 8;
  const entries = walkForwardEntries(models, history, idx, genSpy, arena.evaluatePredictionCorrectness, { key: 'ctx', name: 'Ctx' }, 'backfill');
  assert.ok(entries.length > 0, 'models produced evaluable picks');
  assert.ok(sliceLengths.every(l => l === idx), 'generator only ever saw history before the round');
  for (const e of entries) {
    assert.equal(e.source, 'backfill');
    assert.equal(e.patternKey, 'ctx');
    const expected = arena.evaluatePredictionCorrectness(e.pick, history[idx].number, history[idx].size, history[idx].color);
    assert.equal(e.correct, expected, 'correctness matches the arena evaluator');
  }
});

test('nextRoundPicks: returns a pick map for the upcoming round', () => {
  const models = arena.ARENA_CANONICAL_MODELS.slice(0, 3);
  const history = [2, 7, 4, 9, 1].map((n, i) => ({
    period: 'P' + i, number: n, size: n >= 5 ? 'BIG' : 'SMALL',
    color: n % 2 === 0 ? 'RED' : 'GREEN', gap: false
  }));
  const picks = nextRoundPicks(models, history, arena.generateModelNextPrediction);
  assert.ok(picks instanceof Map);
  assert.ok(picks.size >= 1);
  for (const pred of picks.values()) assert.ok(typeof pred.target === 'string' && pred.target.length > 0);
});

test('Rebased pages wiring: live base preserved, governance loaded on mobile only', () => {
  // PORTED at the 2026-10-24 rebase. The old assertions pinned the
  // round-1/2 restyle (Axofy theme links, 3-destination dock, ranking
  // overlay, orb line) — all of it lived in markup the base swap
  // replaced with the owner's live app, per his "exact same" order.
  const index = fs.readFileSync('index.html', 'utf8');
  const mobile = fs.readFileSync('mobile.html', 'utf8');
  const mobileJs = fs.readFileSync('mobile.js', 'utf8');
  const settings = fs.readFileSync('settings.html', 'utf8');

  for (const [name, html] of [['index', index], ['mobile', mobile], ['settings', settings]]) {
    assert.ok(!html.includes('axofy-theme.css'), `${name}.html does NOT link the Axofy theme (live look kept exact)`);
  }
  assert.ok(mobile.includes('systems/orb-bridge.js'), 'mobile loads the bridge');
  assert.ok(!index.includes('systems/orb-bridge.js'), 'index does not load the bridge (desktop keeps its own arena)');
  assert.ok(!mobile.includes('id="bridgeRankingOverlay"'), 'no duplicate ranking overlay: the live AI tab has the leaderboard');

  const dockTabs = [...mobile.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]);
  // Owner's order 2026-10-24 (Auto-Pilot build): the Patterns entry is
  // removed from the menu ONLY — the pattern engine, its persisted
  // data and the Analyse numbers stay. Dock is now Web / Home / AI.
  assert.deepEqual([...new Set(dockTabs)].sort(), ['ai', 'home', 'web'], 'dock per owner order: Web / Home / AI (Patterns entry removed from the menu)');
  assert.ok(mobile.includes('id="tab-pattern"'), 'the pattern section itself stays in the DOM, unlinked');
  assert.ok(mobile.includes('id="bridgeStatusLine"'), 'orb status line present in the live ball window');

  assert.ok(!mobileJs.includes('currentHistory.slice(0, 30)'), 'mobile Analyse history is not capped at 30 on the live base either');
  // NOTE: the desktop index (live == main) still slices its history
  // table at 20 in its own code — the round-1 removal was branch-only
  // and did not survive the rebase; recorded in the rebase report.
});
