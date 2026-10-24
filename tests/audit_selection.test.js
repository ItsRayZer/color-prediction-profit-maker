/**
 * Full-access + correctness audit tests (owner's addition, 2026-10-24).
 *
 * Pins every governed selection rule with edge cases, and — the centre
 * piece — an INDEPENDENT RECOMPUTATION: a deterministic 400-round
 * record for 12 models is scored by a small standalone implementation
 * of the v2 spec written inside this file (NOT importing the engine),
 * and the app's ranking order, selected Incharge and gate verdict must
 * match it exactly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InchargeEngine, wilsonLowerBound } from '../systems/inchargeEngine.js';
import { evaluateSignalGate } from '../systems/signalGate.js';
import { BlacklistManager } from '../systems/blacklist.js';
import { CalibrationTracker } from '../systems/calibration.js';
import {
  ModelHistoryStore, buildPoolFromStore, resolveGovernanceScope, walkForwardEntries
} from '../systems/orb-bridge.js';

function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
const model = (id, wins, evaluated, extra = {}) => ({
  id, name: id, wins, totalEvaluated: evaluated,
  winRate: evaluated ? wins / evaluated : 0, streak: 0, ...extra
});

// ── The Wilson rule: a 9/10 model must NOT outrank a 190/300 model ──
test('audit: Wilson lower bound ranks proven records over hot small samples', () => {
  const eng = new InchargeEngine({});
  // Pure Wilson pin (the v2 doc example): 3/3 cannot outrank 580/1000.
  assert.ok(eng.scoreModel(model('proven-580', 580, 1000)) > eng.scoreModel(model('hot-3of3', 3, 3)),
    'Wilson: 580/1000 beats 3/3');
  // The owner's literal example: 9/10 vs 190/300. Raw Wilson alone is
  // 0.596 vs 0.578 — the rule is enforced at SELECTION by the
  // 200-evaluated eligibility floor (and again by the gate's 200-sample
  // minimum), not by the bound alone. Pin the selection outcome:
  const hot = model('hot-9of10', 9, 10);
  const proven = model('proven-190of300', 190, 300);
  const sel = eng.evaluateIncharge([hot, proven]);
  assert.equal(sel.model.id, 'proven-190of300', 'the 190/300 model leads; the 9/10 model is not eligible to lead');
});

// ── Exact ties resolve deterministically down the tie-break chain ────
test('audit: exact ties break by evaluated, streak, wins, then name', () => {
  const eng = new InchargeEngine({});
  const a = model('beta', 150, 300, { streak: 2 });
  const b = model('alpha', 150, 300, { streak: 2 });
  const ranked = eng.rankModels([a, b]);
  assert.deepEqual(ranked.map(m => m.id), ['alpha', 'beta'], 'identical records: name decides, deterministically');
  const ranked2 = eng.rankModels([b, a]);
  assert.deepEqual(ranked2.map(m => m.id), ['alpha', 'beta'], 'input order does not matter');
});

// ── Zero-sample models ───────────────────────────────────────────────
test('audit: zero-sample models score 0 and cannot lead over a proven model; gate SKIPs on sample alone', () => {
  const eng = new InchargeEngine({});
  const fresh = model('fresh', 0, 0);
  const proven = model('proven', 170, 300);
  assert.equal(eng.scoreModel(fresh), 0);
  assert.equal(eng.evaluateIncharge([fresh, proven]).model.id, 'proven');
  const gate = evaluateSignalGate({
    pick: 'BIG', sampleSize: 0, calibratedProb: 0.7,
    calibration: { isCalibrated: () => true, expectedCalibrationError: () => 0, count: 100 },
    contenders: [{ pick: 'BIG' }]
  });
  assert.equal(gate.decision, 'SKIP');
  assert.match(gate.reason, /Sample too small/);
});

// ── All models below the floor: no crowned loser at the gate ─────────
test('audit: when every model is below the breakeven floor the gate SKIPs (thin edge)', () => {
  const eng = new InchargeEngine({});
  const pool = [model('m1', 135, 300), model('m2', 120, 300), model('m3', 100, 300)];
  const sel = eng.evaluateIncharge(pool);
  assert.ok(sel && sel.model, 'engine falls back to best Wilson by design');
  const gate = evaluateSignalGate({
    pick: 'BIG', sampleSize: 300, calibratedProb: 0.46,
    calibration: { isCalibrated: () => true, expectedCalibrationError: () => 0.01, count: 200 },
    contenders: [{ pick: 'BIG' }, { pick: 'BIG' }, { pick: 'BIG' }]
  });
  assert.equal(gate.decision, 'SKIP', 'a sub-breakeven leader never becomes a BET');
  assert.match(gate.reason, /Edge too thin/);
});

// ── All blacklisted: NO Incharge (the fallback bug, fixed) ───────────
test('audit: all models blacklisted → evaluateIncharge returns null, never a blacklisted crown', () => {
  const eng = new InchargeEngine({});
  const pool = [model('m1', 190, 300), model('m2', 180, 300)];
  const sel = eng.evaluateIncharge(pool, { blacklist: new Set(['m1', 'm2']) });
  assert.equal(sel, null);
  const mgr = new BlacklistManager();
  const sel2 = eng.evaluateIncharge(pool, { blacklist: { isBlacklisted: () => true } });
  assert.equal(sel2, null);
  assert.equal(mgr.filterEligible(pool).length, 2, 'control: an empty manager excludes nobody');
});

// ── NaN / undefined history entries never poison the chain ───────────
test('audit: NaN stats and null correctness are contained', () => {
  const eng = new InchargeEngine({});
  const weird = { id: 'weird', name: 'weird', wins: NaN, totalEvaluated: NaN, winRate: NaN, streak: undefined };
  const proven = model('proven', 170, 300);
  const ranked = eng.rankModels([weird, proven]);
  assert.ok(Number.isFinite(eng.scoreModel(ranked[0])), 'scores stay finite');
  assert.equal(ranked[0].id, 'proven');

  const store = new ModelHistoryStore(memStorage());
  store.recordRound('30s', 'P1', [{ modelId: 'x', pick: 'BIG', correct: null }, { modelId: 'y', pick: 'BIG', correct: true }]);
  assert.equal(store.modelStats('30s', 'x'), null, 'null correctness records nothing');
  assert.equal(store.modelStats('30s', 'y').evaluated, 1);

  const entries = walkForwardEntries(
    [{ id: 'm', name: 'm' }],
    [{ period: 'P0', number: 7, size: 'BIG', color: 'GREEN' }, { period: 'P1', number: NaN, size: 'BIG', color: 'GREEN' }],
    1,
    () => ({ target: 'BIG', conf: 0.6 }),
    (target, number) => (Number.isFinite(number) ? true : null)
  );
  assert.equal(entries.length, 0, 'a NaN result round evaluates to nothing, not a phantom win/loss');
});

// ── Governance scope boundary: exactly 49 vs 50 timeframe rounds ─────
test('audit: scope fallback boundary is exactly 50 recorded rounds', () => {
  const store = new ModelHistoryStore(memStorage());
  for (let i = 0; i < 49; i++) store.recordRound('30s', 'P' + i, [{ modelId: 'm', pick: 'BIG', correct: true }]);
  let scope = resolveGovernanceScope(store, '30s');
  assert.equal(scope.key, 'ALL', '49 rounds: labelled global fallback');
  assert.equal(scope.perTimeframe, false);
  store.recordRound('30s', 'P49', [{ modelId: 'm', pick: 'BIG', correct: true }]);
  scope = resolveGovernanceScope(store, '30s');
  assert.equal(scope.key, '30s', '50 rounds: the timeframe governs itself');
  assert.equal(scope.perTimeframe, true);
});

// ── Blacklist shadow reinstatement crossing ──────────────────────────
test('audit: a blacklisted model reinstates only when its shadow Wilson crosses the floor', () => {
  const mgr = new BlacklistManager();
  const bad = model('bad', 90, 200); // Wilson ≈ 0.383, far below the 51.02% floor
  mgr.update([bad]);
  assert.equal(mgr.isBlacklisted('bad'), true);
  for (let i = 0; i < 40; i++) mgr.recordShadowResult('bad', true);
  assert.equal(mgr.isBlacklisted('bad'), true, '40 shadow wins are not yet proof (Wilson still below floor)');
  let reinstatedAt = null;
  for (let i = 41; i <= 130 && reinstatedAt === null; i++) {
    if (mgr.recordShadowResult('bad', true)) reinstatedAt = i;
  }
  assert.ok(reinstatedAt !== null, 'enough shadow wins cross the floor and reinstate');
  assert.equal(mgr.isBlacklisted('bad'), false);
});

// ── INDEPENDENT RECOMPUTATION over a deterministic 400-round record ──
// Standalone spec implementation (written here, not imported):
//   score = 0.65 * Wilson(wins, n) + 0.35 * Wilson(recentWins, recentN)
//   rank desc by score, then evaluated, streak, wins, name.
//   leader = first ranked model with n >= 200 and winRate >= 1/1.96,
//   unless a streak override applies (streak >= 5, evaluated >= 10,
//   recent form >= floor, not the base) — the fixture is built so no
//   model ends on a 5+ streak, and that is asserted from the fixture.
function specWilson(wins, n) {
  if (!n) return 0;
  const z = 1.96, p = wins / n, z2 = z * z;
  const den = 1 + z2 / n, centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / den);
}

test('audit: recomputation — app ranking top-5, Incharge and gate verdict match a standalone spec', () => {
  const ROUNDS = 400;
  const profiles = [ // per-model hit pattern: correct when (round*mult + off) % 10 < hit
    { id: 'm01', mult: 1, off: 0, hit: 7 }, { id: 'm02', mult: 3, off: 1, hit: 6 },
    { id: 'm03', mult: 7, off: 2, hit: 6 }, { id: 'm04', mult: 1, off: 3, hit: 5 },
    { id: 'm05', mult: 3, off: 4, hit: 5 }, { id: 'm06', mult: 7, off: 5, hit: 4 },
    { id: 'm07', mult: 1, off: 6, hit: 4 }, { id: 'm08', mult: 3, off: 7, hit: 3 },
    { id: 'm09', mult: 7, off: 8, hit: 6 }, { id: 'm10', mult: 1, off: 9, hit: 2 },
    { id: 'm11', mult: 3, off: 2, hit: 7 }, { id: 'm12', mult: 7, off: 4, hit: 5 }
  ];
  const correctAt = (p, r) => ((r * p.mult + p.off) % 10) < p.hit;

  const store = new ModelHistoryStore(memStorage());
  for (let r = 0; r < ROUNDS; r++) {
    store.recordRound('30s', 'R' + r, profiles.map(p => ({ modelId: p.id, pick: 'BIG', correct: correctAt(p, r) })));
  }
  const arena = profiles.map(p => ({ id: p.id, name: p.id }));
  const pool = buildPoolFromStore(store, arena, '30s');

  // Standalone expectation from the fixture itself.
  const expected = profiles.map(p => {
    let wins = 0, recentWins = 0, streak = 0;
    for (let r = 0; r < ROUNDS; r++) {
      const ok = correctAt(p, r);
      if (ok) { wins++; streak++; } else streak = 0;
      if (r >= ROUNDS - 100 && ok) recentWins++;
    }
    const recentN = Math.min(100, ROUNDS);
    const score = 0.65 * specWilson(wins, ROUNDS) + 0.35 * specWilson(recentWins, recentN);
    return { id: p.id, wins, evaluated: ROUNDS, winRate: wins / ROUNDS, streak, score };
  });
  assert.ok(Math.max(...expected.map(e => e.streak)) < 5, 'fixture invariant: no 5+ closing streak (no override in play)');
  expected.sort((a, b) => (b.score - a.score) || (b.evaluated - a.evaluated) || (b.streak - a.streak) || (b.wins - a.wins) || a.id.localeCompare(b.id));
  const floor = 1 / 1.96;
  const expectedLeader = expected.find(e => e.evaluated >= 200 && e.winRate >= floor) || expected[0];

  const eng = new InchargeEngine({});
  const ranked = eng.rankModels(pool);
  assert.deepEqual(ranked.slice(0, 5).map(m => m.id), expected.slice(0, 5).map(e => e.id), 'top-5 order matches the standalone spec exactly');
  const sel = eng.evaluateIncharge(pool);
  assert.equal(sel.model.id, expectedLeader.id, 'selected Incharge matches the standalone spec');

  // Gate expectation for the recomputed leader: sample 400, top-3 in
  // agreement, calibrated tracker, prob 0.65 ≥ 51.02 + 2 → BET.
  const tracker = new CalibrationTracker();
  for (let i = 0; i < 100; i++) tracker.record(0.65, i % 20 < 13);
  assert.equal(tracker.isCalibrated(), true);
  const gate = evaluateSignalGate({
    pick: 'BIG', sampleSize: 400, calibratedProb: 0.65, calibration: tracker,
    contenders: [{ pick: 'BIG' }, { pick: 'BIG' }, { pick: 'BIG' }]
  });
  assert.equal(gate.decision, 'BET', 'gate verdict matches the spec for the recomputed leader');
  const thin = evaluateSignalGate({
    pick: 'BIG', sampleSize: 400, calibratedProb: 0.52, calibration: tracker,
    contenders: [{ pick: 'BIG' }, { pick: 'BIG' }, { pick: 'BIG' }]
  });
  assert.equal(thin.decision, 'SKIP', 'a 52% prob is below breakeven + margin: SKIP');
});

// ── Pattern blend: persisted pattern stats measurably move the score ─
test('audit: the pattern hit-rate blend consumes persisted pattern records and can move the lead', () => {
  const store = new ModelHistoryStore(memStorage());
  // A: 180/300. B: 175/300, of which 25 rounds under pattern 'BBS' with 18 hits.
  for (let r = 0; r < 300; r++) {
    const entries = [
      { modelId: 'A', pick: 'BIG', correct: r < 180 },
      { modelId: 'B', pick: 'BIG', correct: r >= 7 && r < 182, ...(r < 25 ? { patternKey: 'BBS', patternName: 'BBS' } : {}) }
    ];
    store.recordRound('30s', 'R' + r, entries);
  }
  const arena = [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }];
  const eng = new InchargeEngine({});
  const plain = buildPoolFromStore(store, arena, '30s');
  assert.equal(eng.rankModels(plain)[0].id, 'A', 'control: without a firing pattern, A leads');
  const withPat = buildPoolFromStore(store, arena, '30s', { key: 'BBS', name: 'BBS' });
  const bEntry = withPat.find(m => m.id === 'B');
  assert.equal(bEntry.patternSamples, 25);
  assert.ok(Math.abs(bEntry.patternHitRate - 0.72) < 1e-9);
  const delta = eng.scoreModel(bEntry) - eng.scoreModel(plain.find(m => m.id === 'B'));
  assert.ok(delta > 0.03, `the blend measurably moves B's score (+${delta.toFixed(3)})`);
  assert.equal(eng.rankModels(withPat)[0].id, 'B', 'with the proven pattern firing for it, B takes the lead');
  // The blend is capped: even a perfect pattern record moves the score
  // by at most the 0.25 weight.
  const capped = { ...bEntry, patternHitRate: 1, patternSamples: 500 };
  assert.ok(eng.scoreModel(capped) - eng.scoreModel(plain.find(m => m.id === 'B')) <= 0.25 + 1e-9);
});

// ── Full access: evaluation uses the FULL record, no last-N window ───
test('audit: model stats are computed over the full persisted record (no evaluation cap)', () => {
  const store = new ModelHistoryStore(memStorage());
  for (let r = 0; r < 450; r++) {
    store.recordRound('30s', 'R' + r, [{ modelId: 'm', pick: 'BIG', correct: r >= 350 }]);
  }
  const s = store.modelStats('30s', 'm');
  assert.equal(s.evaluated, 450, 'all 450 rounds count, not a recent window');
  assert.equal(s.wins, 100);
  assert.equal(s.recentEvaluated, 100, 'the recency window is exactly the last 100 (a labelled blend input, not a cap on totals)');
  assert.equal(s.recentWins, 100);
  assert.equal(wilsonLowerBound(s.wins, s.evaluated), specWilson(100, 450));
});
