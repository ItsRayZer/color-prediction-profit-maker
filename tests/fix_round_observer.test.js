/**
 * fix_round_observer.test.js — Observer, the background system model
 * (owner orders 2026-10-27 ~11:37 IST: "figure out how the game works
 * in bg for ever... when it succeed like continuously winning then
 * make it incharge" + "Same incharge logic as other").
 *
 * Variant A, governed model (observer-design.md §2) — NOT an
 * overseer, NO flag gate (the design's o101_observer_bet_driving
 * recommendation is SUPERSEDED by the owner's refined orders:
 * promotion is automatic via the same Incharge logic, and
 * Observer's own walk-forward record IS its validation under the
 * same 53.02% bar).
 *
 * PINS:
 *  1. Catalog: 140 entries (137 + observer-color/size/number),
 *     one predType each, unique ids, genFn returns null for
 *     observer ids (so backfill can never fabricate its record).
 *  2. All five follow-rules pick the right model (last-100 Wilson,
 *     full Wilson, streak surprise, top-5 vote, pool consensus)
 *     with the design tie-breaks; last-100 ignores full history.
 *  3. Eligibility: observer ids are never followed (no
 *     self-follow), wrong-type candidates never followed,
 *     candidates without a pick never followed.
 *  4. Null handling: no rule pick -> Observer pick null (pause,
 *     never an invented target, never SKIP/STOP — the module
 *     returns picks or null, never a decision).
 *  5. Best-measured rule: cold start follows last100; rule records
 *     switch the follow when another rule measures better; the
 *     fallback chain follows the best rule WITH a pick.
 *  6. Walk-forward loop: rule picks computed pre-round are scored
 *     at settlement and only then change the next round's choice
 *     (no look-ahead by construction — the pick function takes no
 *     result input).
 *  7. Rule store: record + persistence round-trip (fake storage).
 *  8. Same Incharge logic: selectInchargeOwnerRule picks Observer
 *     when its record dominates, and passes it over when it does
 *     not — no Observer privilege, no Observer handicap.
 *  9. Bars unchanged: colour bar still 53.02%.
 *
 * NOT pure-testable here (cycle-level, verified by inspection +
 * the owner's phone check, as the 3E file notes for its own
 * cycle-level behaviours): the orb-bridge injection (live branch
 * only, pendingPicks discipline, keyed by tf:latestPeriod so a
 * mid-round backfill cannot flip the pick), the settlement scoring
 * loop, the bet-driver loop's NUMBER skip that keeps
 * observer-number display-only until O4, bench/demotion/blacklist
 * filtering of Observer through the same incCandidates path as
 * every model, and the Analyse card rendering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  OBSERVER_IDS, OBSERVER_RULES, OBSERVER_RULE_LABELS,
  isObserverId, observerIdForType, rulePick, computeRulePicks,
  chooseRule, bestRuleOrder, ruleWilson, observerPickFor,
  rankFollowCandidates, ObserverRuleStore
} from '../systems/observer.js';
import { wilsonLowerBound, streakSurprise, selectInchargeOwnerRule } from '../systems/inchargeEngine.js';
import { barFor } from '../systems/ledger.js';

function mkEntry(id, o = {}) {
  return {
    id, name: o.name || id,
    predType: o.predType || 'COLOR',
    wins: o.wins ?? 0, totalEvaluated: o.evaluated ?? 0,
    streak: o.streak ?? 0,
    recentWins: o.recentWins ?? 0, recentEvaluated: o.recentEvaluated ?? 0,
    recentWinRate: o.recentEvaluated ? (o.recentWins ?? 0) / o.recentEvaluated : null,
    last10Wins: o.last10Wins ?? 0, last10Evaluated: o.last10Evaluated ?? 0,
    sessionWins: o.sessionWins ?? 0, sessionEvaluated: o.sessionEvaluated ?? 0
  };
}

function mkPicks(obj) {
  const m = new Map();
  for (const [id, target] of Object.entries(obj)) if (target !== null) m.set(id, { target, conf: null });
  return m;
}

test('catalog: 140 entries, observer ids with one predType each, genFn null for observer ids', () => {
  const src = fs.readFileSync(new URL('../algorithms/arena_models.js', import.meta.url), 'utf8');
  const ids = [...src.matchAll(/"id":\s*"([^"]+)"/g)].map(m => m[1]);
  // The catalog array is the only "id" list in the file (switch
  // cases use case '...', not "id":), so the count is the pool size.
  assert.equal(ids.length, 143, `catalog must be 143 (137 + 3 observer + 2 pattern-repeater + 1 cold-big-20), got ${ids.length}`);
  assert.equal(new Set(ids).size, 143, 'catalog ids must be unique');
  for (const oid of OBSERVER_IDS) assert.ok(ids.includes(oid), `${oid} must be in the catalog`);
  assert.ok(/"id":\s*"observer-color"[\s\S]{0,1200}?"predType":\s*"COLOR"/.test(src), 'observer-color is COLOR');
  assert.ok(/"id":\s*"observer-size"[\s\S]{0,1200}?"predType":\s*"SIZE"/.test(src), 'observer-size is SIZE');
  assert.ok(/"id":\s*"observer-number"[\s\S]{0,1200}?"predType":\s*"NUMBER"/.test(src), 'observer-number is NUMBER');
  assert.ok(src.includes("if (modelId.indexOf('observer-') === 0) return null;"), 'genFn must return null for observer ids');
});

test('isObserverId + observerIdForType', () => {
  assert.equal(isObserverId('observer-color'), true);
  assert.equal(isObserverId('observer-x'), true);
  assert.equal(isObserverId('asi'), false);
  assert.equal(isObserverId(null), false);
  assert.equal(observerIdForType('COLOR'), 'observer-color');
  assert.equal(observerIdForType('SIZE'), 'observer-size');
  assert.equal(observerIdForType('NUMBER'), 'observer-number');
  assert.equal(observerIdForType('color'), 'observer-color');
});

test('last100 rule follows the highest last-100 Wilson, ignoring full history', () => {
  const cands = [
    mkEntry('a', { recentWins: 80, recentEvaluated: 100, wins: 60, evaluated: 100 }),
    mkEntry('b', { recentWins: 60, recentEvaluated: 100, wins: 95, evaluated: 100 }),
    mkEntry('c', { recentWins: 40, recentEvaluated: 100, wins: 99, evaluated: 100 })
  ];
  const picks = mkPicks({ a: 'GREEN', b: 'RED', c: 'GREEN' });
  const r = rulePick('last100', { type: 'COLOR', candidates: cands, picks });
  assert.equal(r.followedId, 'a', 'last100 leader is a (80/100), not b/c with better full history');
  assert.equal(r.target, 'GREEN');
  assert.ok(Math.abs(r.followedLast100Wilson - wilsonLowerBound(80, 100)) < 1e-9);
  assert.equal(r.followedLast100N, 100);
});

test('last100 tie-breaks: full Wilson, then samples, then id', () => {
  const cands = [
    mkEntry('b', { recentWins: 50, recentEvaluated: 100, wins: 50, evaluated: 100 }),
    mkEntry('a', { recentWins: 50, recentEvaluated: 100, wins: 80, evaluated: 100 })
  ];
  const picks = mkPicks({ a: 'GREEN', b: 'RED' });
  assert.equal(rulePick('last100', { type: 'COLOR', candidates: cands, picks }).followedId, 'a', 'tied last-100 -> higher full Wilson wins');
  const tied = [
    mkEntry('b', { recentWins: 50, recentEvaluated: 100, wins: 50, evaluated: 100 }),
    mkEntry('a', { recentWins: 50, recentEvaluated: 100, wins: 50, evaluated: 100 })
  ];
  assert.equal(rulePick('last100', { type: 'COLOR', candidates: tied, picks }).followedId, 'a', 'fully tied -> lowest id wins');
});

test('full rule follows the highest full-history Wilson', () => {
  const cands = [
    mkEntry('a', { recentWins: 90, recentEvaluated: 100, wins: 55, evaluated: 100 }),
    mkEntry('b', { recentWins: 10, recentEvaluated: 100, wins: 88, evaluated: 100 })
  ];
  const picks = mkPicks({ a: 'GREEN', b: 'RED' });
  const r = rulePick('full', { type: 'COLOR', candidates: cands, picks });
  assert.equal(r.followedId, 'b', 'full leader is b (88/100), not a with better recent form');
  assert.equal(r.target, 'RED');
});

test('streak rule follows the highest streak surprise, not Wilson', () => {
  const cands = [
    mkEntry('a', { streak: 2, wins: 90, evaluated: 100, recentWins: 90, recentEvaluated: 100 }),
    mkEntry('b', { streak: 4, wins: 40, evaluated: 100, recentWins: 40, recentEvaluated: 100 })
  ];
  const picks = mkPicks({ a: 'GREEN', b: 'RED' });
  assert.ok(streakSurprise(4, 'COLOR') > streakSurprise(2, 'COLOR'));
  assert.equal(rulePick('streak', { type: 'COLOR', candidates: cands, picks }).followedId, 'b');
});

test('topk votes the top-5 by full Wilson; consensus votes the whole pool', () => {
  const cands = [
    mkEntry('m1', { wins: 95, evaluated: 100 }),
    mkEntry('m2', { wins: 90, evaluated: 100 }),
    mkEntry('m3', { wins: 85, evaluated: 100 }),
    mkEntry('m4', { wins: 80, evaluated: 100 }),
    mkEntry('m5', { wins: 75, evaluated: 100 }),
    mkEntry('m6', { wins: 10, evaluated: 100 })
  ];
  // Top-5 vote: m1 GREEN, m2 RED, m3 GREEN, m4 RED, m5 GREEN -> GREEN 3-2, representative m1.
  const picks = mkPicks({ m1: 'GREEN', m2: 'RED', m3: 'GREEN', m4: 'RED', m5: 'GREEN', m6: 'RED' });
  const tk = rulePick('topk', { type: 'COLOR', candidates: cands, picks });
  assert.equal(tk.target, 'GREEN');
  assert.equal(tk.followedId, 'm1', 'topk representative is the highest-ranked GREEN voter');
  // Consensus: all six vote, GREEN 3 vs RED 3 -> tie goes to the
  // highest-ranked voter among tied targets (m1 votes GREEN).
  const cons = rulePick('consensus', { type: 'COLOR', candidates: cands, picks });
  assert.equal(cons.target, 'GREEN');
  assert.equal(cons.followedId, 'm1');
  // Flip m1 to RED: consensus tie now resolves to RED via m1.
  const picks2 = mkPicks({ m1: 'RED', m2: 'RED', m3: 'GREEN', m4: 'RED', m5: 'GREEN', m6: 'GREEN' });
  const cons2 = rulePick('consensus', { type: 'COLOR', candidates: cands, picks: picks2 });
  assert.equal(cons2.target, 'RED');
  assert.equal(cons2.followedId, 'm1');
});

test('eligibility: observer ids, wrong types, and pick-less models are never followed', () => {
  const cands = [
    mkEntry('observer-color', { recentWins: 100, recentEvaluated: 100, wins: 100, evaluated: 100 }),
    mkEntry('size-model', { predType: 'SIZE', recentWins: 100, recentEvaluated: 100, wins: 100, evaluated: 100 }),
    mkEntry('nopick', { recentWins: 100, recentEvaluated: 100, wins: 100, evaluated: 100 }),
    mkEntry('real', { recentWins: 60, recentEvaluated: 100, wins: 60, evaluated: 100 })
  ];
  const picks = mkPicks({ 'observer-color': 'GREEN', 'size-model': 'GREEN', real: 'RED' });
  const r = rulePick('last100', { type: 'COLOR', candidates: cands, picks });
  assert.equal(r.followedId, 'real', 'perfect observer/size/pick-less entries must not be followed');
  assert.equal(r.target, 'RED');
  const all = observerPickFor({ type: 'COLOR', candidates: cands, picks, ruleRecords: {} });
  assert.notEqual(all.followedId, 'observer-color');
});

test('null handling: no rule pick -> Observer pick null, never invented, never a decision', () => {
  const cands = [mkEntry('a', { recentWins: 90, recentEvaluated: 100 })];
  const picks = mkPicks({}); // a has no pick this round
  const res = observerPickFor({ type: 'COLOR', candidates: cands, picks, ruleRecords: {} });
  assert.equal(res.target, null);
  assert.equal(res.rule, null);
  assert.ok(res.rulePicks, 'rulePicks still returned for settlement scoring');
  assert.ok(Object.values(res.rulePicks).every(v => v === null), 'all rule picks null when no candidate has a pick');
  assert.ok(!('decision' in res) && !('skip' in res) && !('stop' in res), 'Observer returns picks or null, never a decision');
  assert.equal(observerPickFor({ type: 'COLOR', candidates: [], picks, ruleRecords: {} }).target, null);
});

test('best-measured rule: cold start last100, switches when another rule measures better', () => {
  assert.equal(chooseRule({}), 'last100', 'cold start follows last100');
  assert.deepEqual(bestRuleOrder({})[0], 'last100');
  // last100 8/10 (Wilson ~0.49) beats full 5/10 (Wilson ~0.24).
  const recs = {
    last100: { evaluated: 10, wins: 8 },
    full: { evaluated: 10, wins: 5 },
    streak: { evaluated: 10, wins: 5 },
    topk: { evaluated: 10, wins: 5 },
    consensus: { evaluated: 10, wins: 5 }
  };
  assert.equal(chooseRule(recs), 'last100');
  // Full overtakes: full 45/50 (Wilson ~0.78) beats last100 8/10.
  recs.full = { evaluated: 50, wins: 45 };
  assert.equal(chooseRule(recs), 'full');
  // Unmeasured rules never beat a measured rule.
  const thin = { last100: { evaluated: 0, wins: 0 }, full: { evaluated: 3, wins: 3 } };
  assert.equal(chooseRule(thin), 'full');
});

test('fallback chain: best rule without a pick yields to the next rule with one', () => {
  // Rules filter to pick-holders first, so a pick-less leader does
  // NOT null a rule. The real fallback case is a Wilson-less
  // pick-holder: b has a pick and a full record but NO recent
  // window, so last100 (cold-start best) returns null and full
  // follows b instead.
  const cands = [
    mkEntry('a', { recentWins: 90, recentEvaluated: 100, wins: 90, evaluated: 100 }),
    mkEntry('b', { recentWins: 0, recentEvaluated: 0, wins: 50, evaluated: 100 })
  ];
  const picks = mkPicks({ b: 'RED' });
  const recs = { last100: { evaluated: 50, wins: 45 }, full: { evaluated: 50, wins: 40 }, streak: { evaluated: 50, wins: 35 }, topk: { evaluated: 50, wins: 30 }, consensus: { evaluated: 50, wins: 25 } };
  assert.equal(rulePick('last100', { type: 'COLOR', candidates: cands, picks }), null, 'last100 null: only pick-holder has no recent record');
  const res = observerPickFor({ type: 'COLOR', candidates: cands, picks, ruleRecords: recs });
  assert.equal(res.target, 'RED');
  assert.equal(res.followedId, 'b');
  assert.equal(res.rule, 'full', 'fallback to the next best-measured rule with a pick');
});

test('walk-forward loop: pre-round picks scored at settlement change only the NEXT choice', () => {
  const store = new ObserverRuleStore(null);
  const tf = '30s';
  const cands = [
    mkEntry('a', { recentWins: 90, recentEvaluated: 100, wins: 90, evaluated: 100 }),
    mkEntry('b', { recentWins: 50, recentEvaluated: 100, wins: 50, evaluated: 100 })
  ];
  // Round 1 (cold start -> last100): last100/full/streak all follow
  // a (GREEN); topk/consensus follow a too (a outranks b). Result:
  // GREEN wins -> every rule that picked GREEN scores a win.
  const picks1 = mkPicks({ a: 'GREEN', b: 'RED' });
  const round1 = observerPickFor({ type: 'COLOR', candidates: cands, picks: picks1, ruleRecords: store.recordsFor(tf, 'COLOR') });
  assert.equal(round1.rule, 'last100');
  assert.equal(round1.target, 'GREEN');
  for (const rule of OBSERVER_RULES) {
    const rp = round1.rulePicks[rule];
    if (rp && rp.target) store.record(tf, 'COLOR', rule, rp.target === 'GREEN');
  }
  const after1 = store.recordsFor(tf, 'COLOR');
  assert.equal(after1.last100.wins, 1, 'last100 scored its own pre-round pick, not the result alone');
  assert.equal(after1.last100.evaluated, 1);
  // Round 2: all rules 1/1 -> Wilson tie -> last100 still first.
  const round2 = observerPickFor({ type: 'COLOR', candidates: cands, picks: picks1, ruleRecords: after1 });
  assert.equal(round2.rule, 'last100');
  // Now make full dominate: 45/50 for full, others 1/1.
  for (let i = 0; i < 49; i++) store.record(tf, 'COLOR', 'full', true);
  store.record(tf, 'COLOR', 'full', false); // 46/50 incl. round 1? round1 already counted: full is 1/1 + 49 wins + 1 loss = 50/51... recompute below.
  const after2 = store.recordsFor(tf, 'COLOR');
  assert.ok(after2.full.wins / after2.full.evaluated > 0.85, 'full record dominates');
  const round3 = observerPickFor({ type: 'COLOR', candidates: cands, picks: picks1, ruleRecords: after2 });
  assert.equal(round3.rule, 'full', 'follow switches to the best-measured rule');
});

test('rule store: record + persistence round-trip', () => {
  const backing = {};
  const fake = { getItem: k => (k in backing ? backing[k] : null), setItem: (k, v) => { backing[k] = v; } };
  const s1 = new ObserverRuleStore(fake);
  s1.record('1m', 'SIZE', 'topk', true);
  s1.record('1m', 'SIZE', 'topk', false);
  s1.record('1m', 'SIZE', 'consensus', true);
  const s2 = new ObserverRuleStore(fake);
  assert.deepEqual(s2.recordsFor('1m', 'SIZE').topk, { evaluated: 2, wins: 1 });
  assert.deepEqual(s2.recordsFor('1m', 'SIZE').consensus, { evaluated: 1, wins: 1 });
  assert.deepEqual(s2.recordsFor('1m', 'COLOR').topk, { evaluated: 0, wins: 0 }, 'per-type isolation');
  assert.deepEqual(s2.recordsFor('30s', 'SIZE').topk, { evaluated: 0, wins: 0 }, 'per-timeframe isolation');
  // Unknown rule names are ignored, never stored.
  s2.record('1m', 'SIZE', 'hot-hand', true);
  assert.deepEqual(s2.recordsFor('1m', 'SIZE').topk, { evaluated: 2, wins: 1 });
});

test('observer pick is always the followed model pick (conf-carrying contract)', () => {
  const cands = [
    mkEntry('a', { recentWins: 90, recentEvaluated: 100, wins: 90, evaluated: 100 }),
    mkEntry('b', { recentWins: 50, recentEvaluated: 100, wins: 50, evaluated: 100 })
  ];
  const picks = mkPicks({ a: 'GREEN', b: 'RED' });
  for (const rule of OBSERVER_RULES) {
    const r = rulePick(rule, { type: 'COLOR', candidates: cands, picks });
    if (r) assert.equal(picks.get(r.followedId).target, r.target, `${rule}: followed model's pick is Observer's pick`);
  }
  const res = observerPickFor({ type: 'COLOR', candidates: cands, picks, ruleRecords: {} });
  assert.equal(picks.get(res.followedId).target, res.target);
});

test('rankFollowCandidates: last-100 order with computed Wilsons', () => {
  const cands = [
    mkEntry('observer-color', { recentWins: 100, recentEvaluated: 100, wins: 100, evaluated: 100 }),
    mkEntry('a', { recentWins: 70, recentEvaluated: 100, wins: 70, evaluated: 100, streak: 2 }),
    mkEntry('b', { recentWins: 85, recentEvaluated: 100, wins: 85, evaluated: 100, streak: 5 }),
    mkEntry('c', { predType: 'SIZE', recentWins: 99, recentEvaluated: 100, wins: 99, evaluated: 100 })
  ];
  const rows = rankFollowCandidates(cands, 'COLOR');
  assert.deepEqual(rows.map(r => r.id), ['b', 'a'], 'observer + wrong-type excluded, last-100 order');
  assert.ok(Math.abs(rows[0].last100Wilson - wilsonLowerBound(85, 100)) < 1e-9);
  assert.equal(rows[0].last100N, 100);
  assert.equal(rows[0].fullWilson, wilsonLowerBound(85, 100));
});

test('same Incharge logic: Observer wins when its record dominates, loses when it does not', () => {
  const obsWin = mkEntry('observer-color', { streak: 5, last10Wins: 10, last10Evaluated: 10, sessionWins: 45, sessionEvaluated: 50, wins: 90, evaluated: 100 });
  const rivalWeak = mkEntry('rival', { streak: 1, last10Wins: 5, last10Evaluated: 10, sessionWins: 25, sessionEvaluated: 50, wins: 55, evaluated: 100 });
  const v1 = selectInchargeOwnerRule([obsWin, rivalWeak]);
  assert.equal(v1.model.id, 'observer-color', 'dominant Observer record wins the normal competition');
  const obsWeak = mkEntry('observer-color', { streak: 0, last10Wins: 2, last10Evaluated: 10, sessionWins: 10, sessionEvaluated: 50, wins: 30, evaluated: 100 });
  const rivalStrong = mkEntry('rival', { streak: 3, last10Wins: 8, last10Evaluated: 10, sessionWins: 40, sessionEvaluated: 50, wins: 80, evaluated: 100 });
  const v2 = selectInchargeOwnerRule([obsWeak, rivalStrong]);
  assert.equal(v2.model.id, 'rival', 'weak Observer record loses the normal competition — no privilege');
});

test('bars unchanged: colour bar still 53.02%', () => {
  assert.ok(Math.abs(barFor('COLOR') - 0.5302) < 0.001, `colour bar must stay 53.02%, got ${barFor('COLOR')}`);
});

test('rule labels exist for every rule (card copy)', () => {
  for (const rule of OBSERVER_RULES) assert.ok(OBSERVER_RULE_LABELS[rule], `label for ${rule}`);
});
