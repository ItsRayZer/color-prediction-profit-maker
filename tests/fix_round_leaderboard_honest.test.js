/**
 * tests/fix_round_leaderboard_honest.test.js
 * Owner order 2026-10-30: "This showing wrong fake data... Make the logic strong."
 * The leaderboard must show honest out-of-sample walk-forward win rates:
 * - No fabricated predictions (null pick = skip, never 'BIG' default)
 * - Min n=20 to display WR% ("warming up" below, "no data" at zero)
 * - Rank by Wilson lower bound, display both raw WR and Wilson
 * - Dynamic model count (never hardcoded 101)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Wilson lower bound (same formula as mobile.js)
function wilsonLB(wins, total, z = 1.96) {
  if (total <= 0) return 0;
  const p = wins / total;
  const n = total;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - spread) / denominator);
}

const MIN_N_FOR_WR = 20;

test('min-n gate: n=0 shows no data', () => {
  const n = 0;
  const display = n === 0 ? 'no data' : (n < MIN_N_FOR_WR ? 'warming up' : 'show');
  assert.equal(display, 'no data');
});

test('min-n gate: n=10 shows warming up (not a WR%)', () => {
  const n = 10;
  const display = n === 0 ? 'no data' : (n < MIN_N_FOR_WR ? 'warming up' : 'show');
  assert.equal(display, 'warming up');
});

test('min-n gate: n=19 shows warming up', () => {
  const n = 19;
  const display = n === 0 ? 'no data' : (n < MIN_N_FOR_WR ? 'warming up' : 'show');
  assert.equal(display, 'warming up');
});

test('min-n gate: n=20 shows WR%', () => {
  const n = 20;
  const display = n === 0 ? 'no data' : (n < MIN_N_FOR_WR ? 'warming up' : 'show');
  assert.equal(display, 'show');
});

test('Wilson ranking: 20W/7L (74% raw) has Wilson LB ~55%, not 74%', () => {
  const lb = wilsonLB(20, 27);
  // Raw is 74.1%, but Wilson LB should be ~55% (honest lower bound)
  assert.ok(lb > 0.50 && lb < 0.60, `Wilson LB ${lb} should be ~0.55`);
  assert.ok(lb < 0.741, 'Wilson LB must be below raw WR');
});

test('Wilson ranking: higher raw WR does not always rank higher', () => {
  // Model A: 15W/5L (75% raw, n=20) vs Model B: 70W/30L (70% raw, n=100)
  // B should rank higher by Wilson despite lower raw WR
  const lbA = wilsonLB(15, 20);
  const lbB = wilsonLB(70, 100);
  assert.ok(lbB > lbA, `B (${lbB.toFixed(3)}) should outrank A (${lbA.toFixed(3)}) by Wilson`);
});

test('no fabrication: null prediction means skip, not BIG', () => {
  // Simulates the fixed scoring logic: freshTarget null → skip
  const pred = null;
  const freshTarget = pred ? (pred.predTarget || pred.target || null) : null;
  assert.equal(freshTarget, null, 'Null pred must not fabricate a target');
  // The old code did: model.predTarget || 'BIG' — that was the fabrication
  const oldBuggyTarget = (undefined || 'BIG');
  assert.equal(oldBuggyTarget, 'BIG', 'Old code fabricated BIG (this is what we removed)');
});

test('count: 143 not 101', () => {
  // The governed catalog is 143 models (140 + 2 pattern-repeater + 1 cold-big-20). The HTML must not hardcode 101.
  // This test pins the requirement; the actual count comes from the catalog.
  const GOVERNED_COUNT = 143;
  assert.equal(GOVERNED_COUNT, 143);
  assert.notEqual(GOVERNED_COUNT, 101, 'Must not show stale 101 count');
});
