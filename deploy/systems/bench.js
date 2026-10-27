/**
 * systems/bench.js — Demotion + Bench (Phase 3E, owner-approved design
 * ~/workspace/0101-v2/analysis/model-bench-trend-design.md §§1–3, §10,
 * AS AMENDED by the owner's 2026-10-27 ~11:15 IST order: "Model back
 * to normal with just 10 rounds without 4loss streak").
 *
 * UNIFORM RESTORATION RULE (replaces the design's demotion-clear-on-
 * next-win AND bench re-entry-on-2-shadow-wins — BOTH DELETED, one
 * restoration rule, not two):
 *   Any demoted or benched model returns to NORMAL (full eligibility —
 *   can lead and bet-drive again, subject to winning Incharge) after
 *   10 CONSECUTIVE walk-forward rounds with NO 4-loss streak.
 *   A 4-streak inside the window RESTARTS the clock at 0 and
 *   (re-)benches the model (bench state, not just demotion).
 *   Manual unbench stays. Analyse shows x/10 clean rounds.
 * Honest note: restoration requires only "no 4-streak", not winning —
 * a model can restore while still losing, as long as it never loses
 * 4 straight. That is the owner's rule, implemented literally.
 *
 * DEMOTION at 2 (design §10 Layer A): a model whose consecutive-wrong
 * run reaches 2 loses Incharge leadership immediately (another model
 * leads the next round). It does NOT clear on the next win anymore —
 * it clears only via the 10-clean-round rule above.
 *
 * BENCH at 3 (design §1 Layer B, backstop): a model reaching 3
 * consecutive walk-forward wrongs is excluded from Incharge leadership
 * + bet-driving. Walk-forward scoring CONTINUES while benched (those
 * live entries ARE the shadow record). Bench's extra bite over
 * demotion is persistence (10 clean rounds to clear, vs demotion's
 * same 10 — the layers differ in trigger + visibility, not in the
 * restoration clock) and visibility (flag + benching rounds + progress
 * + manual control) — NOT a second exclusion mechanism.
 *
 * "Wrong" = the model's walk-forward pick for a LIVE round settling
 * incorrect (live branch only; backfill never counts — the caller
 * feeds only the live branch, guarded by state.pendingPicks; null pick
 * PAUSES the run: neither extends nor resets it, and the clean clock
 * neither advances nor restarts). Per model per timeframe (= per type,
 * since each catalog entry carries one predType). One run counter
 * feeds demotion + bench.
 *
 * UNIFIED LEADERSHIP FLOOR (design §10): if EVERY model of the acting
 * type is demoted or benched simultaneously, the highest-Wilson one of
 * them leads, FLAGGED (never an empty board). The floor leader
 * re-benches on its next 4th consecutive wrong (the 4-streak rule),
 * and any restoration ends the floor state.
 *
 * BLACKLIST INTERACTION (design §3, layering not duplication): one
 * feed, two readers. (1) Blacklist dominates restoration — the 10-round
 * restore NEVER clears a blacklist entry (bench state and blacklist
 * state are separate; the blacklist filter still excludes the model).
 * (2) Bench is subsumed by blacklist — a benched model that meets
 * blacklist criteria becomes blacklisted; its bench state is DROPPED
 * (caller: bench.dropState on newly blacklisted ids + the live bench
 * feed skips blacklisted ids). (3) Display shows both flags with
 * distinct reasons. (4) Pool floors stay separate (per-type pool floor
 * for blacklist, unified leadership floor for bench/demotion).
 *
 * NEVER a SKIP, never a STOP: bench/demotion rotate leadership, they
 * never block a pick. The floor guarantees a pick always exists while
 * the governed pool is non-empty.
 *
 * Persistence: o101_bench_v1 (localStorage JSON, same family as the
 * session/ledger stores). Storage null-safe: in-memory only.
 * Structure: { tf: { modelId: { run, status, clean, benchRounds,
 * timesBenched } } }. benchRounds = [{period, pick}] for the
 * consecutive-wrong run that caused the current bench state (the 3
 * benching rounds at bench time; refreshed on a 4-streak re-bench).
 * timesBenched counts entries INTO bench state (demoted->benched
 * transitions + normal->benched); a 4-streak while already benched
 * refreshes benchRounds but does not double-count.
 */

import { wilsonLowerBound } from './inchargeEngine.js';

export const BENCH_STORE_KEY = 'o101_bench_v1';
export const RESTORE_CLEAN_ROUNDS = 10;
export const DEMOTION_AT = 2;
export const BENCH_AT = 3;
export const RESTREAK = 4;

function emptyState() {
  return { run: 0, status: 'normal', clean: 0, benchRounds: [], timesBenched: 0, wrongRounds: [] };
}

function saneState(raw) {
  const s = emptyState();
  if (!raw || typeof raw !== 'object') return s;
  if (Number.isFinite(raw.run) && raw.run >= 0) s.run = Math.floor(raw.run);
  if (raw.status === 'demoted' || raw.status === 'benched') s.status = raw.status;
  if (Number.isFinite(raw.clean) && raw.clean >= 0) s.clean = Math.floor(raw.clean);
  if (Array.isArray(raw.benchRounds)) s.benchRounds = raw.benchRounds.filter(r => r && r.period !== undefined);
  if (Number.isFinite(raw.timesBenched) && raw.timesBenched >= 0) s.timesBenched = Math.floor(raw.timesBenched);
  if (Array.isArray(raw.wrongRounds)) s.wrongRounds = raw.wrongRounds.filter(r => r && r.period !== undefined);
  // Invariant repair: a normal model carries no bench baggage.
  if (s.status === 'normal') { s.clean = 0; s.benchRounds = []; }
  return s;
}

export class BenchManager {
  constructor(storage) {
    this.storage = storage || null;
    this.data = {}; // tf -> modelId -> state
    try {
      if (this.storage) {
        const raw = this.storage.getItem(BENCH_STORE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            for (const tf of Object.keys(parsed)) {
              const bucket = parsed[tf];
              if (!bucket || typeof bucket !== 'object') continue;
              this.data[tf] = {};
              for (const id of Object.keys(bucket)) this.data[tf][id] = saneState(bucket[id]);
            }
          }
        }
      }
    } catch (e) { this.data = {}; }
  }

  save() {
    try {
      if (!this.storage) return;
      const out = {};
      for (const tf of Object.keys(this.data)) {
        out[tf] = {};
        for (const id of Object.keys(this.data[tf])) {
          const s = this.data[tf][id];
          out[tf][id] = { run: s.run, status: s.status, clean: s.clean, benchRounds: s.benchRounds, timesBenched: s.timesBenched, wrongRounds: s.wrongRounds };
        }
      }
      this.storage.setItem(BENCH_STORE_KEY, JSON.stringify(out));
    } catch (e) { /* storage unavailable: bench stays in-memory only */ }
  }

  _bucket(tf) {
    if (!this.data[tf]) this.data[tf] = {};
    return this.data[tf];
  }

  getState(tf, modelId) {
    const b = this.data[tf];
    if (!b || !b[modelId]) return emptyState();
    return b[modelId];
  }

  isDemoted(tf, modelId) { return this.getState(tf, modelId).status === 'demoted'; }
  isBenched(tf, modelId) { return this.getState(tf, modelId).status === 'benched'; }
  isExcluded(tf, modelId) {
    const s = this.getState(tf, modelId).status;
    return s === 'demoted' || s === 'benched';
  }

  /**
   * Record one LIVE walk-forward round for a model. correct: true |
   * false | null/undefined. Null pauses (no change at all). The caller
   * feeds ONLY the live branch (guarded by state.pendingPicks) and
   * skips blacklisted ids (blacklist subsumes bench, design §3).
   * Returns the new state (for tests/display).
   */
  recordLive(tf, modelId, correct, period, pick) {
    if (correct === null || correct === undefined) return this.getState(tf, modelId);
    const b = this._bucket(tf);
    const s = b[modelId] || (b[modelId] = emptyState());
    const wasBenched = s.status === 'benched';
    if (correct === false) {
      s.run += 1;
      s.wrongRounds.push({ period: period === undefined ? null : period, pick: pick === undefined ? null : pick });
      if (s.wrongRounds.length > 10) s.wrongRounds.splice(0, s.wrongRounds.length - 10);
      if (s.run >= RESTREAK) {
        // 4-streak: clock restarts at 0 and the model is (re-)benched.
        s.clean = 0;
        s.status = 'benched';
        s.benchRounds = s.wrongRounds.slice();
        if (!wasBenched) s.timesBenched += 1;
      } else if (s.run >= BENCH_AT) {
        if (!wasBenched) {
          // New bench (always from demoted: run passes 2 first).
          s.status = 'benched';
          s.timesBenched += 1;
          s.benchRounds = s.wrongRounds.slice();
          s.clean = 0; // new penalty state = new 10-round probation
        } else {
          // Already benched, re-climbing below 4: NOT a new bench and
          // NOT a 4-streak, so the clock keeps counting this round.
          s.benchRounds = s.wrongRounds.slice();
          s.clean += 1;
          if (s.clean >= RESTORE_CLEAN_ROUNDS) this._restore(s);
        }
      } else if (s.run >= DEMOTION_AT) {
        if (s.status === 'normal') {
          s.status = 'demoted';
          s.clean = 0; // new penalty state = new 10-round probation
        } else {
          // Penalised model re-climbing to run 2 after wins: not a
          // new penalty and not a 4-streak, so the round counts.
          s.clean += 1;
          if (s.clean >= RESTORE_CLEAN_ROUNDS) this._restore(s);
        }
      } else {
        // run 1: a penalised model re-climbing after wins still banks
        // the round (no 4-streak); a normal model banks nothing.
        if (s.status === 'demoted' || s.status === 'benched') {
          s.clean += 1;
          if (s.clean >= RESTORE_CLEAN_ROUNDS) this._restore(s);
        } else {
          s.clean = 0;
        }
      }
    } else {
      // Win: the wrong-run resets, and a penalised model banks one
      // clean round toward the 10-round restoration.
      s.run = 0;
      s.wrongRounds = [];
      if (s.status === 'demoted' || s.status === 'benched') {
        s.clean += 1;
        if (s.clean >= RESTORE_CLEAN_ROUNDS) this._restore(s);
      } else {
        s.clean = 0;
      }
    }
    this.save();
    return s;
  }

  _restore(s) {
    s.status = 'normal';
    s.run = 0;
    s.clean = 0;
    s.benchRounds = [];
    s.wrongRounds = [];
  }

  /** Manual unbench (Analyse button): full restore, kept count. */
  unbench(tf, modelId) {
    const b = this._bucket(tf);
    const s = b[modelId];
    if (!s) return null;
    this._restore(s);
    this.save();
    return s;
  }

  /** Blacklist subsumption (design §3): drop bench state entirely. */
  dropState(tf, modelId) {
    const b = this.data[tf];
    if (b && b[modelId]) { delete b[modelId]; this.save(); }
  }

  /** Eligible models for a timeframe: governed minus demoted/benched. */
  filterEligible(tf, models) {
    if (!Array.isArray(models)) return [];
    return models.filter(m => !this.isExcluded(tf, m.id));
  }

  /** Unified leadership floor: highest-Wilson model of the given list
   *  (callers pass the blacklist-filtered pool, i.e. the pre-bench
   *  list). Null when the list is empty. Uses the same Wilson helper
   *  as the gate so the floor pick is the most-defended pick. */
  floorModel(tf, models) {
    if (!Array.isArray(models) || !models.length) return null;
    let best = null;
    let bestW = -Infinity;
    for (const m of models) {
      const wins = Number.isFinite(m.wins) ? m.wins : 0;
      const n = Number.isFinite(m.totalEvaluated) ? m.totalEvaluated : 0;
      const w = wilsonLowerBound(wins, n);
      if (w > bestW) { bestW = w; best = m; }
    }
    return best;
  }

  /** Analyse rows for a timeframe: every penalised model with flag +
   *  benching rounds + clean progress (x/10) + times benched. */
  list(tf) {
    const b = this.data[tf] || {};
    return Object.keys(b)
      .map(id => ({ id, ...b[id] }))
      .filter(s => s.status === 'demoted' || s.status === 'benched');
  }

  count(tf) {
    return this.list(tf).length;
  }
}

/** Display helpers (pure, for the Analyse bench card + tests). */
export function benchStatusLabel(status) {
  return status === 'benched' ? 'BENCHED' : status === 'demoted' ? 'DEMOTED' : 'NORMAL';
}

export function benchProgressText(state) {
  const c = Number.isFinite(state && state.clean) ? state.clean : 0;
  return `${Math.min(RESTORE_CLEAN_ROUNDS, c)}/${RESTORE_CLEAN_ROUNDS} clean`;
}

export function benchRoundsText(state) {
  const rounds = Array.isArray(state && state.benchRounds) ? state.benchRounds : [];
  if (!rounds.length) return '—';
  return rounds.map(r => `${r.period !== null && r.period !== undefined ? r.period : '?'}:${r.pick !== null && r.pick !== undefined ? r.pick : '—'}`).join(' · ');
}
