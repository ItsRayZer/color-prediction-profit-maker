/**
 * Verdict stamp via the settled governed verdict (owner order 2026-11-07).
 *
 * Root cause found by full debug + live browser checks: the AI TARGET
 * column stayed all dashes and the accuracy card read 0/0/0 on the
 * production site even though the governed verdict was computed every
 * round (hero/signal showed it) and the P&L settlement moved — the
 * history stamp depended ONLY on the in-memory disposition lookup at
 * settle time, and that lookup missed for every round (timing /
 * period-format mismatch between the orb-bridge's recordP and the
 * settle's periodStr). The fix makes the stamp read the verdict from
 * the SAME authoritative source as P&L: the orb-bridge settlement
 * records the settled governed verdict (period -> pick -> outcome)
 * in-memory + persisted (o101_settled_verdicts), exposes it as
 * window.__o101SettledVerdict, and the live app consults it first in
 * settleRoundOutcome (Priority 0a) and in the fetch tick's restoration
 * (both branches). A verdict is only ever a record the app itself
 * settled — never fabricated, never derived from native.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

const orbSrc = fs.readFileSync(new URL('../systems/orb-bridge.js', import.meta.url), 'utf8');
const mobileSrc = fs.readFileSync(new URL('../mobile.js', import.meta.url), 'utf8');

describe('settled governed verdict record (orb-bridge)', () => {
  it('records the settled verdict when the settlement evaluates a BET', () => {
    const settle = orbSrc.slice(orbSrc.indexOf('const settleCheck = governedSettlementAllowed'));
    assert.ok(settle.includes('recordSettledVerdict({ tf, period: latestPeriod, pick: settleTarget, won: !!won, decision })'), 'settlement must record the settled verdict');
    assert.ok(settle.includes("if (decision === GATE_DECISIONS.BET && settleTarget)"), 'only a BET with a pick is recorded');
  });

  it('persists the record (o101_settled_verdicts) and caps it', () => {
    assert.ok(orbSrc.includes("const SETTLED_VERDICTS_KEY = 'o101_settled_verdicts'"), 'must have the persisted key');
    assert.ok(orbSrc.includes('SETTLED_VERDICTS_CAP'), 'must cap the record');
    assert.ok(orbSrc.includes('store.setItem(SETTLED_VERDICTS_KEY, JSON.stringify(map))'), 'must persist the map');
  });

  it('exposes window.__o101SettledVerdict with a last-5-digits fallback', () => {
    assert.ok(orbSrc.includes('window.__o101SettledVerdict = (tf, period) => readSettledVerdict(tf, period)'), 'must expose the hook');
    assert.ok(orbSrc.includes('const suffix = String(period).slice(-5)'), 'must try a last-5 period match when the exact key misses');
  });
});

describe('settleRoundOutcome reads the settled verdict first (mobile.js)', () => {
  it('Priority 0a consults __o101SettledVerdict before the disposition', () => {
    const fn = mobileSrc.slice(mobileSrc.indexOf('function settleRoundOutcome'));
    const p0a = fn.indexOf('__o101SettledVerdict');
    const p0b = fn.indexOf('__o101GovernedDisposition');
    assert.ok(p0a > 0 && p0b > 0 && p0a < p0b, 'settled verdict must be consulted before the disposition');
    assert.ok(fn.includes("targetSource = 'governed'"), 'a settled BET must mark the verdict governed');
  });

  it('the disposition lookup is now a fallback (never overwrites the settled verdict)', () => {
    const fn = mobileSrc.slice(mobileSrc.indexOf('function settleRoundOutcome'));
    assert.ok(fn.includes("if (!target && typeof window.__o101GovernedDisposition === 'function')"), 'disposition must only run when no target yet');
  });

  it('a settled verdict carries its outcome (no re-evaluation needed)', () => {
    const fn = mobileSrc.slice(mobileSrc.indexOf('function settleRoundOutcome'));
    assert.ok(fn.includes("if (isWin === null && _sv.won !== null && _sv.won !== undefined) isWin = !!_sv.won"), 'settled outcome must be used when present');
  });
});

describe('fetch tick restoration reads the settled verdicts (mobile.js)', () => {
  it('current-session branch fills a missing verdict from the settled record', () => {
    const fn = mobileSrc.slice(mobileSrc.indexOf('async function fetchLiveAPIResults'));
    assert.ok(fn.includes("if (!verdictPick && typeof window.__o101SettledVerdict === 'function')"), 'restoration must consult the settled verdicts');
    assert.ok(fn.includes("if (_sv && _sv.decision === 'BET' && _sv.pick)"), 'only a settled BET may fill the verdict');
  });

  it('pre-cutoff branch also restores a settled verdict (never fabricates)', () => {
    const fn = mobileSrc.slice(mobileSrc.indexOf('async function fetchLiveAPIResults'));
    const cutoffBlock = fn.slice(fn.indexOf('if (isPastRoundBeforeCutoff) {'), fn.indexOf('} else {'));
    assert.ok(cutoffBlock.includes('__o101SettledVerdict'), 'cutoff branch must consult the settled verdicts');
    assert.ok(cutoffBlock.includes("if (_sv && _sv.decision === 'BET' && _sv.pick)"), 'cutoff branch must only restore a settled BET');
  });
});
