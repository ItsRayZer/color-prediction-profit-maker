/**
 * systems/observer.js — Observer, the background system model.
 *
 * Owner orders 2026-10-27 ~11:37 IST (binding, stated to the owner
 * with a correction path):
 *   (1) "Write the observer as to figure out how the game works in
 *       bg for ever and try every possible way to try and figure
 *       out the logic when it succeed like continuously winning
 *       then make it incharge"
 *   (2) "Same incharge logic as other"
 *
 * SCOPE = Variant A of observer-design.md (governed model, NOT an
 * overseer). Three catalog entries — observer-color, observer-size,
 * observer-number — compete through the NORMAL Incharge competition
 * (v2 Steps 1–3: streak surprise + Wilson margin + hysteresis) like
 * every model, and are subject to demotion at 2, bench at 3,
 * 10-clean-round restoration, and the 2-window blacklist —
 * identically. Observer never overrides Incharge and never bypasses
 * the gate, the bar, or bench/blacklist.
 *
 * SUPERSESSION (recorded, vs the design doc §5): the design
 * recommended an evaluated-first trial with a separate flag
 * (o101_observer_bet_driving) flipped only after a harness PASS.
 * The owner's refined orders supersede that: promotion is AUTOMATIC
 * via the same Incharge logic — no flag, no bypass, no special gate.
 * Observer's own walk-forward record IS its validation, judged under
 * the same 53.02% bar as all models. Until that record wins the
 * normal competition, Observer does not lead and does not bet-drive.
 * Its stake, when it leads, uses the ledger with Observer's Wilson,
 * unchanged.
 *
 * HONEST LIMITS (stated in code comments AND in the Analyse copy,
 * never otherwise): Observer measures which models/approaches are
 * CURRENTLY working; it does NOT discover a secret game mechanism.
 * Draws are server-side and independent; no observation available to
 * this app (results feed, walk-forward records, pattern firings) can
 * reveal how they are generated. OUT OF SCOPE, never implemented
 * here: hot/cold/due outcome trends, any "game mechanism" claim, any
 * rule bypassing gate/bar/bench/blacklist, and S2–S5 trend signals
 * in selection (they stay display-only). Observer's follow-rule
 * candidates below are MODEL-SELECTION rules, not outcome-trend
 * signals — they choose among models by measured accuracy, never
 * among outcomes by past results.
 *
 * HOW IT RUNS (background, forever): every cycle, orb-bridge
 * computes Observer's pick for the upcoming round from LIVE STORE
 * evidence (pre-round only — never the round's own result), injects
 * it into the pending picks, and at settlement scores ALL FIVE
 * candidate follow-rules against the settled result, updating their
 * walk-forward records (persisted, o101_observer_v1). Observer
 * follows the best-MEASURED rule (highest Wilson over its own rule
 * record; cold start = last100). genFn returns null for observer
 * ids, so backfill/deep-backfill can never fabricate an Observer
 * record — live branch only, under the same pendingPicks discipline
 * as the bench/shadow feeds. A null pick pauses (no entry, no bench
 * movement), like every model. Observer never yields SKIP/STOP:
 * this module returns picks or null, never a decision.
 *
 * Candidate pool entries are the buildPoolFromStore shape:
 * { id, name, wins, totalEvaluated, streak, recentWinRate,
 *   recentEvaluated, recentWins, last10Wins, last10Evaluated,
 *   predType }. Callers pass the ELIGIBLE list (governed −
 *   blacklisted − benched − demoted); this module additionally
 *   filters to the requested type and excludes observer ids, so
 *   Observer can never follow itself or an excluded model back
 *   into leadership.
 */

import { wilsonLowerBound, streakSurprise } from './inchargeEngine.js';

export const OBSERVER_STORE_KEY = 'o101_observer_v1';
export const OBSERVER_IDS = ['observer-color', 'observer-size', 'observer-number'];
export const OBSERVER_RULES = ['last100', 'full', 'streak', 'topk', 'consensus'];
export const OBSERVER_RULE_LABELS = {
  last100: 'Last-100 Wilson leader',
  full: 'Full-history Wilson leader',
  streak: 'Streak-surprise leader',
  topk: 'Top-5 vote',
  consensus: 'Pool consensus'
};

export function isObserverId(id) {
  return typeof id === 'string' && id.indexOf('observer-') === 0;
}

export function observerIdForType(type) {
  const t = String(type || 'COLOR').toUpperCase();
  if (t === 'SIZE') return 'observer-size';
  if (t === 'NUMBER') return 'observer-number';
  return 'observer-color';
}

/** Pick lookup that accepts a Map (nextRoundPicks) or a plain object. */
function pickOf(picks, id) {
  if (!picks) return null;
  if (typeof picks.get === 'function') return picks.get(id) || null;
  return picks[id] || null;
}

function pickTarget(picks, id) {
  const p = pickOf(picks, id);
  return p ? (p.target || p.predTarget || null) : null;
}

function fullWilson(m) {
  const n = Number(m.totalEvaluated ?? m.evaluated) || 0;
  if (n <= 0) return null;
  return wilsonLowerBound(Number(m.wins) || 0, n);
}

function recentWinsOf(m) {
  if (Number.isFinite(Number(m.recentWins))) return Number(m.recentWins);
  if (Number.isFinite(Number(m.recentWinRate)) && Number.isFinite(Number(m.recentEvaluated))) {
    return Math.round(Number(m.recentWinRate) * Number(m.recentEvaluated));
  }
  return 0;
}

function last100Wilson(m) {
  const n = Number(m.recentEvaluated) || 0;
  if (n <= 0) return null;
  return wilsonLowerBound(recentWinsOf(m), n);
}

function last100N(m) {
  return Number(m.recentEvaluated) || 0;
}

/** Eligible candidates of one type, observer ids excluded (no self-follow). */
export function followCandidates(candidates, type) {
  const t = String(type || 'COLOR').toUpperCase();
  return (candidates || []).filter(m => {
    if (!m || !m.id) return false;
    if (isObserverId(m.id)) return false;
    return String(m.predType || 'COLOR').toUpperCase() === t;
  });
}

/** Candidates with a pick for the upcoming round (null-pick models cannot be followed). */
function withPick(cands, picks) {
  return cands.filter(m => pickTarget(picks, m.id) !== null && pickTarget(picks, m.id) !== undefined);
}

/** Tie-break order (design §2): key desc, full Wilson desc, samples desc, modelId asc. */
function compareBy(keyFn) {
  return (a, b) => {
    const ka = keyFn(a), kb = keyFn(b);
    if (ka === null && kb === null) return 0;
    if (ka === null) return 1;
    if (kb === null) return -1;
    if (ka !== kb) return kb - ka;
    const fa = fullWilson(a), fb = fullWilson(b);
    if (fa !== fb) {
      if (fa === null) return 1;
      if (fb === null) return -1;
      return fb - fa;
    }
    const na = Number(a.totalEvaluated ?? a.evaluated) || 0;
    const nb = Number(b.totalEvaluated ?? b.evaluated) || 0;
    if (na !== nb) return nb - na;
    return String(a.id).localeCompare(String(b.id));
  };
}

function followedFrom(model, picks) {
  return {
    target: pickTarget(picks, model.id),
    followedId: model.id,
    followedName: model.name || model.id,
    followedLast100Wilson: last100Wilson(model),
    followedLast100N: last100N(model)
  };
}

/**
 * One candidate follow-rule's pick (pure). Returns null when no
 * eligible candidate of this type has a pick — a null pick pauses,
 * it never invents a target.
 */
export function rulePick(rule, { type, candidates, picks }) {
  const cands = withPick(followCandidates(candidates, type), picks);
  if (!cands.length) return null;
  const t = String(type || 'COLOR').toUpperCase();
  if (rule === 'last100') {
    const sorted = cands.slice().sort(compareBy(m => last100Wilson(m)));
    // A last-100 leader needs a real recent record; a model with no
    // recent window cannot lead this rule (nulls sort last, but a
    // null-only field must not yield a pick — fall through to null).
    if (last100Wilson(sorted[0]) === null) return null;
    return followedFrom(sorted[0], picks);
  }
  if (rule === 'full') {
    const sorted = cands.slice().sort(compareBy(m => fullWilson(m)));
    if (fullWilson(sorted[0]) === null) return null;
    return followedFrom(sorted[0], picks);
  }
  if (rule === 'streak') {
    const sorted = cands.slice().sort(compareBy(m => streakSurprise(Number(m.streak) || 0, t)));
    return followedFrom(sorted[0], picks);
  }
  if (rule === 'topk' || rule === 'consensus') {
    // Vote among picks: topk votes the top-5 by full Wilson;
    // consensus votes the whole eligible pool. Winner = most votes;
    // a tie goes to the target of the highest-ranked voter among the
    // tied targets (ranked by full Wilson, then samples, then id).
    const ranked = cands.slice().sort(compareBy(m => fullWilson(m)));
    const voters = rule === 'topk' ? ranked.slice(0, 5) : ranked;
    const votes = new Map(); // target -> { count, bestRank }
    voters.forEach((m, i) => {
      const target = pickTarget(picks, m.id);
      const cur = votes.get(target) || { count: 0, bestRank: Infinity, model: null };
      cur.count += 1;
      if (i < cur.bestRank) { cur.bestRank = i; cur.model = m; }
      votes.set(target, cur);
    });
    let winner = null;
    for (const [target, v] of votes.entries()) {
      if (!winner || v.count > winner.v.count || (v.count === winner.v.count && v.bestRank < winner.v.bestRank)) {
        winner = { target, v };
      }
    }
    if (!winner || !winner.v.model) return null;
    return followedFrom(winner.v.model, picks);
  }
  return null;
}

/** All five rules' picks for one (type) — the background record's input. */
export function computeRulePicks({ type, candidates, picks }) {
  const out = {};
  for (const rule of OBSERVER_RULES) out[rule] = rulePick(rule, { type, candidates, picks });
  return out;
}

/** Wilson of a rule record; unmeasured rules score -1 (never beat a measured rule). */
export function ruleWilson(rec) {
  if (!rec || !Number.isFinite(Number(rec.evaluated)) || Number(rec.evaluated) <= 0) return -1;
  return wilsonLowerBound(Number(rec.wins) || 0, Number(rec.evaluated));
}

/** Best-measured rule first; ties follow OBSERVER_RULES order (cold start = last100). */
export function bestRuleOrder(ruleRecords) {
  const recs = ruleRecords || {};
  return OBSERVER_RULES.slice().sort((a, b) => {
    const wa = ruleWilson(recs[a]), wb = ruleWilson(recs[b]);
    if (wa !== wb) return wb - wa;
    return OBSERVER_RULES.indexOf(a) - OBSERVER_RULES.indexOf(b);
  });
}

/** The single best-measured rule (first of bestRuleOrder). */
export function chooseRule(ruleRecords) {
  return bestRuleOrder(ruleRecords)[0];
}

/**
 * Observer's pick for one (type): the best-measured rule WITH a pick
 * (fallback down the best-measured order — never an empty board
 * while any rule has a pick). Returns null only when no rule has a
 * pick. rulePicks is always returned (for settlement scoring) even
 * when the pick itself is null.
 */
export function observerPickFor({ type, candidates, picks, ruleRecords }) {
  const rulePicks = computeRulePicks({ type, candidates, picks });
  const order = bestRuleOrder(ruleRecords);
  for (const rule of order) {
    const rp = rulePicks[rule];
    if (rp && rp.target !== null && rp.target !== undefined) {
      return { ...rp, rule, rulePicks, ruleOrder: order };
    }
  }
  return { target: null, followedId: null, followedName: null, rule: null, rulePicks, ruleOrder: order };
}

/**
 * Eligible candidates ranked for the Analyse top-5 table (last-100
 * Wilson order, nulls last, then full Wilson, samples, id). Each row
 * carries its computed Wilsons so the renderer shows numbers, never
 * re-derives them differently.
 */
export function rankFollowCandidates(candidates, type) {
  return followCandidates(candidates, type)
    .map(m => ({ ...m, last100Wilson: last100Wilson(m), last100N: last100N(m), fullWilson: fullWilson(m) }))
    .sort((a, b) => {
      const ka = a.last100Wilson, kb = b.last100Wilson;
      if (ka === null && kb === null) return 0;
      if (ka === null) return 1;
      if (kb === null) return -1;
      if (ka !== kb) return kb - ka;
      const fa = a.fullWilson, fb = b.fullWilson;
      if (fa !== fb) {
        if (fa === null) return 1;
        if (fb === null) return -1;
        return fb - fa;
      }
      const na = Number(a.totalEvaluated ?? a.evaluated) || 0;
      const nb = Number(b.totalEvaluated ?? b.evaluated) || 0;
      if (na !== nb) return nb - na;
      return String(a.id).localeCompare(String(b.id));
    });
}

/**
 * Per-rule walk-forward records, persisted (same family as the bench
 * store). Structure: { tf: { TYPE: { rule: { evaluated, wins } } } }.
 * Storage null-safe: in-memory only when localStorage is unavailable.
 */
export class ObserverRuleStore {
  constructor(storage) {
    this.storage = storage || null;
    this.data = {};
    try {
      if (this.storage) {
        const raw = this.storage.getItem(OBSERVER_STORE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            for (const tf of Object.keys(parsed)) {
              const bucket = parsed[tf];
              if (!bucket || typeof bucket !== 'object') continue;
              this.data[tf] = {};
              for (const t of Object.keys(bucket)) {
                const tb = bucket[t];
                if (!tb || typeof tb !== 'object') continue;
                this.data[tf][t] = {};
                for (const rule of OBSERVER_RULES) {
                  const r = tb[rule];
                  this.data[tf][t][rule] = {
                    evaluated: Number.isFinite(Number(r && r.evaluated)) && Number(r.evaluated) >= 0 ? Math.floor(Number(r.evaluated)) : 0,
                    wins: Number.isFinite(Number(r && r.wins)) && Number(r.wins) >= 0 ? Math.floor(Number(r.wins)) : 0
                  };
                }
              }
            }
          }
        }
      }
    } catch (e) { this.data = {}; }
  }

  save() {
    try {
      if (this.storage) this.storage.setItem(OBSERVER_STORE_KEY, JSON.stringify(this.data));
    } catch (e) { /* storage failure must never break governance */ }
  }

  recordsFor(tf, type) {
    const t = String(type || 'COLOR').toUpperCase();
    const out = {};
    const bucket = (this.data[tf] && this.data[tf][t]) || {};
    for (const rule of OBSERVER_RULES) {
      out[rule] = { evaluated: (bucket[rule] && bucket[rule].evaluated) || 0, wins: (bucket[rule] && bucket[rule].wins) || 0 };
    }
    return out;
  }

  record(tf, type, rule, correct) {
    if (!OBSERVER_RULES.includes(rule)) return;
    const t = String(type || 'COLOR').toUpperCase();
    if (!this.data[tf]) this.data[tf] = {};
    if (!this.data[tf][t]) this.data[tf][t] = {};
    if (!this.data[tf][t][rule]) this.data[tf][t][rule] = { evaluated: 0, wins: 0 };
    const r = this.data[tf][t][rule];
    r.evaluated += 1;
    if (correct) r.wins += 1;
    this.save();
  }
}
