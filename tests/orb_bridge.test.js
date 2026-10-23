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

test('Old pages wiring: theme, bridge, 3-destination menu, full-history rendering', () => {
  const index = fs.readFileSync('index.html', 'utf8');
  const mobile = fs.readFileSync('mobile.html', 'utf8');
  const mobileJs = fs.readFileSync('mobile.js', 'utf8');
  const terminal = fs.readFileSync('terminal.html', 'utf8');
  const settings = fs.readFileSync('settings.html', 'utf8');

  for (const [name, html] of [['index', index], ['mobile', mobile], ['terminal', terminal], ['settings', settings]]) {
    assert.ok(html.includes('axofy-theme.css'), `${name}.html links the Axofy theme`);
    assert.ok(html.includes('Instrument+Serif'), `${name}.html loads the display font`);
  }
  assert.ok(index.includes('systems/orb-bridge.js'), 'index loads the bridge');
  assert.ok(mobile.includes('systems/orb-bridge.js'), 'mobile loads the bridge');
  assert.ok(index.includes('id="bridgeRankingOverlay"'), 'index has the ranking overlay');
  assert.ok(mobile.includes('id="bridgeRankingList"') && mobile.includes('id="bridgeBlacklistList"'), 'mobile ranking page hosts ranking + blacklist sections');

  const dock = mobile.match(/<nav id="mobileBottomDock"[\s\S]*?<\/nav>/);
  assert.ok(dock, 'mobile dock exists');
  const tabs = [...dock[0].matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(tabs, ['web', 'home', 'ai'], 'dock is exactly Home / Analyse / Ranking');
  assert.ok(mobile.includes('id="smartBallLine"') && index.includes('id="smartBallLine"'), 'orb line element present on both pages');

  assert.ok(!mobileJs.includes('currentHistory.slice(0, 30)'), 'mobile Analyse history is no longer capped at 30');
  assert.ok(!index.includes('S.history.slice(-20)'), 'index history table is no longer capped at 20');
});
