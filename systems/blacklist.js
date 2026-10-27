/**
 * Model Blacklist (automatic, shadow-evaluated, self-healing)
 * ===========================================================
 * Phase 3A policy (owner order 2026-10-26, add-on C — replaces the
 * Phase 2A rules; the old single 200-sample floor and the
 * recent-collapse trigger are retired, see below):
 *  1. EVIDENCE ONLY: a model is blacklisted ONLY when its Wilson
 *     lower bound sits below its TYPE bar over a MINIMUM sample —
 *     colour/size n≥20, exact-ball n≥50 (the v1 floors) — AND the
 *     failure is SUSTAINED: below bar in 2 consecutive evaluation
 *     windows (a window = one update() assessment after new rounds
 *     settled, i.e. at a higher sample count). Never on one bad
 *     window, never on a single dip.
 *  2. THIN ≠ BLACKLISTED: below its type floor a model is
 *     "learning/unranked" — it is never blacklisted, however bad its
 *     few rounds look. Blacklist ≠ unproven.
 *  3. TEMPORARY + REVIEWABLE: blacklisted models keep shadow-scoring
 *     (the live settlement feeds shadow results — wired in Phase 3A,
 *     previously unwired). Reinstatement needs BOTH: shadow Wilson
 *     above the type floor AND a recent shadow window ≥20 rounds at
 *     ≥45% (the Wave 0+1 rule). The owner can also unblacklist
 *     manually (unblacklist(id)).
 *  4. PER TYPE: one type's failures never touch another type's pool.
 *     The pool floor runs per type: a type's pool can never empty
 *     (its highest-Wilson model is exempted when the type is fully
 *     blacklisted). No bar is lowered by any exemption.
 *  5. REASONS SHOWN: every entry carries which metric, which window,
 *     and which sample count (Analyse renders them verbatim).
 *
 * Type bars: colour/size 51.02% (breakeven at the code-pinned 0.96
 * payout); exact-ball 11.34% (breakeven at the PROPOSAL 7.82 profit
 * multiple — standard table, NOT live-verified). The exact bar is
 * used ONLY for blacklist ranking while exact bets stay gated off;
 * without a per-type bar every exact model would blacklist instantly
 * under the colour bar (a 15% exact record can never clear 51%).
 *
 * Honest caveat (see the build report): at n=20 Wilson is noisy, so
 * a young true-55% colour model can still be blacklisted once it
 * posts 2 below-bar windows; the sustained rule helps only if it
 * recovers quickly. Raising the colour/size floor back toward 200
 * is the owner's lever if young-model protection matters more.
 */

import { wilsonLowerBound, breakEvenWinRate } from './inchargeEngine.js';

export const DEFAULT_BLACKLIST_CONFIG = {
  payout: 0.96,
  floor: null, // null -> per-type breakeven (51.02% colour/size, 11.34% exact)
  minSamplesByType: { COLOR: 20, SIZE: 20, NUMBER: 50 },
  recentCollapseRate: 0.45, // shadow-reinstatement recent window bar (Wave 0+1)
  sustainedWindows: 2 // consecutive below-bar windows required to blacklist
};

/** Breakeven bar for a bet type (exact = proposal, flagged above). */
export function floorFor(type) {
  const t = String(type || 'COLOR').toUpperCase();
  if (t === 'NUMBER') return 1 / (1 + 7.82);
  return breakEvenWinRate(0.96);
}

/** Minimum samples before a type's model can be blacklisted. */
export function minSamplesFor(type) {
  const t = String(type || 'COLOR').toUpperCase();
  if (t === 'NUMBER') return 50;
  return 20;
}

function floorOf(cfg, type) {
  if (cfg.floor !== null && cfg.floor !== undefined) return Number(cfg.floor);
  return floorFor(type);
}

function typeOf(m) {
  const t = m && m.predType ? String(m.predType).toUpperCase() : 'COLOR';
  return (t === 'COLOR' || t === 'SIZE' || t === 'NUMBER') ? t : 'COLOR';
}

function recentOf(m) {
  const rateRaw = m.recentWinRate ?? m.last100WinRate ?? m.recent100WinRate;
  const winsRaw = m.recentWins;
  const evalRaw = m.recentEvaluated ?? m.recentSamples ?? m.last100Evaluated;
  if (rateRaw !== undefined && rateRaw !== null) {
    return { rate: Number(rateRaw), evaluated: evalRaw !== undefined ? Number(evalRaw) : 100 };
  }
  if (winsRaw !== undefined && evalRaw !== undefined && Number(evalRaw) > 0) {
    return { rate: Number(winsRaw) / Number(evalRaw), evaluated: Number(evalRaw) };
  }
  return null;
}

/**
 * Pure assessment of one model object (Phase 3A policy).
 * Status is EVIDENCE, not a blacklist: 'BELOW_BAR' means this single
 * window sits below the type bar (update() still requires a second
 * consecutive below-bar window before blacklisting); 'ACTIVE' means
 * at/above bar, or thin (below the type floor — learning, never
 * blacklisted). The recent-collapse trigger is RETIRED as an
 * independent blacklist cause (policy: ONLY Wilson + sustained);
 * recent form is still reported for display and still gates shadow
 * reinstatement (Wave 0+1 rule).
 * @returns {{id, status: 'ACTIVE'|'BELOW_BAR', reasons: string[],
 *   wilson, floor, samples, winRate, recentWinRate, recentSamples,
 *   type, thin}}
 */
export function assessModel(model, config = {}) {
  const cfg = { ...DEFAULT_BLACKLIST_CONFIG, ...config };
  const type = typeOf(model);
  const floor = floorOf(cfg, type);
  const minSamples = (cfg.minSamplesByType && cfg.minSamplesByType[type]) || minSamplesFor(type);
  const evaluated = Number(model.totalEvaluated !== undefined ? model.totalEvaluated : (model.evaluated || 0)) || 0;
  const winRate = model.winRate !== undefined ? Number(model.winRate) : (evaluated > 0 ? (Number(model.wins) || 0) / evaluated : 0);
  const wins = model.wins !== undefined ? Number(model.wins) : Math.round(winRate * evaluated);
  const wilson = wilsonLowerBound(wins, evaluated);
  const recent = recentOf(model);
  const thin = evaluated < minSamples;
  const belowBar = !thin && wilson < floor;
  const reasons = [];
  if (belowBar) {
    reasons.push(`Wilson bound ${(wilson * 100).toFixed(1)}% is below the ${type} bar ${(floor * 100).toFixed(2)}% after ${evaluated} rounds`);
  } else if (thin) {
    reasons.push(`Learning: only ${evaluated}/${minSamples} ${type} rounds — too thin to judge, never blacklisted`);
  }

  return {
    id: model.id,
    name: model.name || model.id,
    status: belowBar ? 'BELOW_BAR' : 'ACTIVE',
    reasons,
    wilson,
    floor,
    samples: evaluated,
    wins,
    winRate,
    recentWinRate: recent ? recent.rate : null,
    recentSamples: recent ? recent.evaluated : 0,
    type,
    thin
  };
}

export class BlacklistManager {
  constructor(config = {}) {
    this.config = { ...DEFAULT_BLACKLIST_CONFIG, ...config };
    // id -> { id, name, reasons, sinceSamples, baselineWins, baselineEvaluated,
    //          shadow: { wins, evaluated, recent: [bool] }, lastAssessment }
    // `shadow.recent` is a rolling window of the last 100 shadow
    // outcomes (true = win), capped at 100 so state stays bounded.
    this.entries = new Map();
    // Last pool-floor exemption from the most recent update() (or
    // null when the floor did not fire). Display only.
    this.floorExemption = null;
    // Per-type pool-floor exemptions (array, same objects as the
    // singular floorExemption's first entry for compat).
    this.floorExemptions = [];
    // Sustained-failure windows per model: id -> last ≤2 assessments
    // [{wilson, samples}] pushed only when samples increased (new
    // evidence) and the model was at/above its type floor. A model
    // needs 2 consecutive below-bar windows to blacklist.
    this.assessments = new Map();
  }

  get floor() {
    return floorOf(this.config);
  }

  isBlacklisted(id) {
    return this.entries.has(id);
  }

  excludedIds() {
    return new Set(this.entries.keys());
  }

  /** Drop blacklisted models from a pool (for Incharge / gate agreement). */
  filterEligible(models) {
    return (models || []).filter(m => !this.isBlacklisted(m.id));
  }

  /**
   * Record a settled SHADOW result for a blacklisted model: its pick
   * was still evaluated in the background even though it was excluded.
   */
  recordShadowResult(id, won) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (!Array.isArray(entry.shadow.recent)) entry.shadow.recent = [];
    entry.shadow.evaluated += 1;
    if (won) entry.shadow.wins += 1;
    entry.shadow.recent.push(!!won);
    if (entry.shadow.recent.length > 100) entry.shadow.recent.splice(0, entry.shadow.recent.length - 100);
    return this._checkShadowReinstatement(entry);
  }

  _shadowWilson(entry) {
    return wilsonLowerBound(entry.baselineWins + entry.shadow.wins, entry.baselineEvaluated + entry.shadow.evaluated);
  }

  /** Rolling recent-form stats of the shadow window (Phase 2A). */
  shadowRecent(entry) {
    const recent = Array.isArray(entry.shadow.recent) ? entry.shadow.recent : [];
    const evaluated = recent.length;
    const wins = recent.reduce((n, w) => n + (w ? 1 : 0), 0);
    return { wins, evaluated, rate: evaluated > 0 ? wins / evaluated : 0 };
  }

  _checkShadowReinstatement(entry) {
    // Reinstate only on BOTH proofs (Phase 2A fix — the old code
    // checked the Wilson bound alone, and the shadow record carried
    // no recent window at all, so "recent-form recovery" could never
    // be tested):
    //  1. the shadow-inclusive Wilson bound recovers above the floor;
    //  2. the shadow RECENT window recovered too: at least 20 shadow
    //     rounds (mirrors the governed 20-round floor) at a rate at or
    //     above the collapse threshold (recentCollapseRate, 45%).
    // Known limitation, unchanged: the Wilson bound mixes the frozen
    // baseline (stats at blacklisting time) with shadow counters and
    // ignores live rounds since blacklisting.
    const recent = this.shadowRecent(entry);
    // Type-aware floor (Phase 3A): an exact entry reinstates against
    // the exact bar (11.34%), not the colour bar — under the colour
    // bar an exact model could never reinstate (15% < 51%).
    const entryType = entry.lastAssessment && entry.lastAssessment.type ? entry.lastAssessment.type : 'COLOR';
    const entryFloor = this.config.floor !== null && this.config.floor !== undefined ? Number(this.config.floor) : floorFor(entryType);
    if (this._shadowWilson(entry) > entryFloor
      && recent.evaluated >= 20
      && recent.rate >= this.config.recentCollapseRate) {
      this.entries.delete(entry.id);
      this.assessments.delete(entry.id);
      return true;
    }
    return false;
  }

  /**
   * Re-assess a full model pool. Newly failing models are blacklisted;
   * blacklisted models whose (live, shadow-updated) stats recover are
   * reinstated. `options.rankOrder` (optional, array of model ids in
   * rank order) breaks pool-floor ties by rank. Returns
   * { blacklisted: [...], reinstated: [ids], floorExemption: {...}|null,
   *   entries: [...] }.
   */
  update(models, options = {}) {
    const blacklistedNow = [];
    const reinstated = [];
    const pool = Array.isArray(models) ? models : [];
    const rankIndex = new Map();
    if (Array.isArray(options.rankOrder)) {
      options.rankOrder.forEach((id, i) => { if (!rankIndex.has(id)) rankIndex.set(id, i); });
    }
    this.floorExemption = null;
    this.floorExemptions = [];
    const sustainedNeeded = Number(this.config.sustainedWindows) || 2;
    for (const model of pool) {
      const assessment = assessModel(model, this.config);
      const existing = this.entries.get(model.id);
      // Sustained-failure windows: push only on new evidence (samples
      // increased) at/above the type floor; thin assessments never
      // start a window. Blacklist needs `sustainedNeeded` consecutive
      // below-bar windows — never one bad window.
      let sustained = false;
      let sustainedNote = null;
      if (!assessment.thin) {
        const hist = this.assessments.get(model.id) || [];
        const last = hist[hist.length - 1];
        if (!last || assessment.samples > last.samples) {
          hist.push({ wilson: assessment.wilson, samples: assessment.samples });
          if (hist.length > sustainedNeeded) hist.splice(0, hist.length - sustainedNeeded);
          this.assessments.set(model.id, hist);
        }
        const h = this.assessments.get(model.id) || [];
        sustained = h.length >= sustainedNeeded && h.every(a => a.wilson < assessment.floor);
        if (sustained && h.length >= 2) {
          sustainedNote = `Sustained: below the ${assessment.type} bar ${(assessment.floor * 100).toFixed(2)}% in ${h.length} consecutive windows (n=${h[0].samples}→${h[h.length - 1].samples})`;
        }
      }
      if (assessment.status === 'BELOW_BAR' && sustained) {
        const entry = existing || {
          id: model.id,
          sinceSamples: assessment.samples,
          baselineWins: assessment.wins,
          baselineEvaluated: assessment.samples,
          shadow: { wins: 0, evaluated: 0, recent: [] }
        };
        if (!Array.isArray(entry.shadow.recent)) entry.shadow.recent = [];
        entry.name = assessment.name;
        entry.reasons = sustainedNote ? [...assessment.reasons, sustainedNote] : assessment.reasons;
        entry.lastAssessment = assessment;
        entry.shadowStatus = `Shadow mode: still evaluated in the background (${entry.shadow.evaluated} shadow rounds settled)`;
        if (!existing) {
          this.entries.set(model.id, entry);
          blacklistedNow.push(entry);
        }
      } else if (existing) {
        // Live stats recovered (models keep updating in shadow mode).
        this.entries.delete(model.id);
        this.assessments.delete(model.id);
        reinstated.push(model.id);
      }
    }
    // Also honour shadow-only reinstatement for tracked entries.
    for (const entry of [...this.entries.values()]) {
      if (entry.shadow.evaluated > 0 && this._checkShadowReinstatement(entry)) {
        reinstated.push(entry.id);
      }
    }
    // POOL FLOOR, PER TYPE (Phase 3A, v2 §4.2 — replaces the Phase 2A
    // global floor): a type's pool can never empty. If every model
    // OF A TYPE is blacklisted, exempt that type's highest-Wilson
    // model (ties: rank order first, then samples, then pool order)
    // and keep it eligible. One type's exemption never touches
    // another type's pool. This is prevention inside the blacklist,
    // not a fallback that bypasses it — no bar is lowered. Each
    // exemption is reported (floorExemptions array); the singular
    // floorExemption keeps the first for display compat, and a
    // single-type pool behaves exactly like the old global floor.
    let floorExemption = null;
    const floorExemptions = [];
    const typesInPool = [...new Set(pool.map(m => typeOf(m)))];
    for (const type of typesInPool) {
      const typePool = pool.filter(m => typeOf(m) === type);
      if (typePool.length === 0 || !typePool.every(m => this.entries.has(m.id))) continue;
      let best = null;
      let bestWilson = -1;
      let bestRank = Number.POSITIVE_INFINITY;
      let bestSamples = -1;
      for (const model of typePool) {
        const entry = this.entries.get(model.id);
        const wilson = entry && entry.lastAssessment ? entry.lastAssessment.wilson : 0;
        const samples = entry && entry.lastAssessment ? entry.lastAssessment.samples : 0;
        const rank = rankIndex.has(model.id) ? rankIndex.get(model.id) : Number.POSITIVE_INFINITY;
        if (wilson > bestWilson
          || (wilson === bestWilson && rank < bestRank)
          || (wilson === bestWilson && rank === bestRank && samples > bestSamples)) {
          best = model;
          bestWilson = wilson;
          bestRank = rank;
          bestSamples = samples;
        }
      }
      if (best) {
        const wasNewlyBlacklisted = blacklistedNow.some(e => e.id === best.id);
        this.entries.delete(best.id);
        if (wasNewlyBlacklisted) {
          const idx = blacklistedNow.findIndex(e => e.id === best.id);
          if (idx >= 0) blacklistedNow.splice(idx, 1);
        } else {
          reinstated.push(best.id);
        }
        const exemption = {
          id: best.id,
          name: best.name || best.id,
          wilson: bestWilson,
          samples: bestSamples,
          type,
          reason: `Pool floor: kept eligible — the ${type} pool would otherwise be empty`
        };
        floorExemptions.push(exemption);
        if (!floorExemption) {
          floorExemption = exemption;
          this.floorExemption = floorExemption;
        }
      }
    }
    this.floorExemptions = floorExemptions;
    return { blacklisted: blacklistedNow, reinstated, floorExemption, floorExemptions, entries: this.list() };
  }

  /**
   * Manual unblacklist (owner control, add-on C): removes the entry
   * immediately and clears its sustained-failure history, so the
   * model restarts its windows from scratch if it fails again.
   * Returns true when an entry existed.
   */
  unblacklist(id) {
    const had = this.entries.delete(id);
    this.assessments.delete(id);
    return had;
  }

  /** Current blacklist for display: reason, samples, win rate, shadow status. */
  list() {
    return [...this.entries.values()].map(e => ({
      id: e.id,
      name: e.name,
      reasons: e.reasons,
      reason: e.reasons.join('; '),
      samples: e.lastAssessment ? e.lastAssessment.samples : e.baselineEvaluated,
      winRate: e.lastAssessment ? e.lastAssessment.winRate : 0,
      wilson: e.lastAssessment ? e.lastAssessment.wilson : 0,
      recentWinRate: e.lastAssessment ? e.lastAssessment.recentWinRate : null,
      shadowStatus: e.shadowStatus || 'Shadow mode: still evaluated in the background',
      shadow: { ...e.shadow, recent: [...(Array.isArray(e.shadow.recent) ? e.shadow.recent : [])] },
      shadowWilson: this._shadowWilson(e),
      // Phase 2A: the shadow recent window, so reinstatement gating
      // is visible in display instead of hidden inside the manager.
      shadowRecent: this.shadowRecent(e)
    }));
  }
}

export function createBlacklistManager(config) {
  return new BlacklistManager(config);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { DEFAULT_BLACKLIST_CONFIG, assessModel, BlacklistManager, createBlacklistManager, floorFor, minSamplesFor };
}

if (typeof self !== "undefined") {
  self.BlacklistManager = BlacklistManager;
  self.assessModel = assessModel;
}
