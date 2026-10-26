/**
 * Model Blacklist (automatic, shadow-evaluated, self-healing)
 * ===========================================================
 * A model is auto-blacklisted when the evidence says it has no edge:
 *  1. FLOOR BREACH: after at least `minSamples` evaluated rounds
 *     (default 200), its Wilson lower bound sits BELOW the breakeven
 *     floor — 51.02% at a 0.96 payout. The Wilson bound is the win rate
 *     we can defend, so this means "even being generous, this model
 *     does not clear breakeven".
 *  2. RECENT-FORM COLLAPSE: its last-100 win rate drops below 45%
 *     with at least 100 recent samples — a model that used to work
 *     can stop working, and the overall record reacts too slowly.
 *
 * Blacklisted models are excluded from Incharge selection and from
 * the signal gate's model-agreement check (the engine and the front
 * consume the manager / id set), BUT they keep being evaluated in
 * SHADOW mode in the background: their picks are still settled against
 * real outcomes. When a blacklisted model's shadow Wilson bound
 * recovers above the floor (and its recent form is no longer
 * collapsed), it is automatically reinstated. No human list-keeping.
 *
 * Phase 2A (2026-10-26) — two correctness additions, no threshold
 * changes:
 *  1. SHADOW RECENT WINDOW: the shadow record now tracks a rolling
 *     recent window (last 100 shadow rounds) alongside the totals, so
 *     reinstatement can require recent-form recovery, not just a
 *     Wilson bound that the frozen baseline props up. The shadow path
 *     is still NOT wired to any live decision (zero live callers) and
 *     is NOT deleted — the owner decides wire-vs-delete later.
 *  2. POOL FLOOR (owner correction 3): the blacklist must never
 *     exclude the last eligible model. After every update, if every
 *     pool model is blacklisted, the highest-Wilson model (ties by
 *     rank, then samples) is exempted and stays eligible. This is
 *     PREVENTION inside the blacklist, not a fallback that bypasses
 *     it: no bar is lowered and no separate best-Wilson fallback
 *     exists. The exemption is reported on the update result and on
 *     `manager.floorExemption` for display.
 */

import { wilsonLowerBound, breakEvenWinRate } from './inchargeEngine.js';

export const DEFAULT_BLACKLIST_CONFIG = {
  payout: 0.96,
  floor: null, // null -> breakeven for the payout (51.02% at 0.96)
  minSamples: 200,
  recentCollapseRate: 0.45,
  recentMinSamples: 100
};

function floorOf(cfg) {
  return cfg.floor !== null && cfg.floor !== undefined ? Number(cfg.floor) : breakEvenWinRate(cfg.payout ?? 0.96);
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
 * Pure assessment of one model object.
 * @returns {{id, status: 'ACTIVE'|'BLACKLISTED', reasons: string[],
 *   wilson, floor, samples, winRate, recentWinRate, recentSamples}}
 */
export function assessModel(model, config = {}) {
  const cfg = { ...DEFAULT_BLACKLIST_CONFIG, ...config };
  const floor = floorOf(cfg);
  const evaluated = Number(model.totalEvaluated !== undefined ? model.totalEvaluated : (model.evaluated || 0)) || 0;
  const winRate = model.winRate !== undefined ? Number(model.winRate) : (evaluated > 0 ? (Number(model.wins) || 0) / evaluated : 0);
  const wins = model.wins !== undefined ? Number(model.wins) : Math.round(winRate * evaluated);
  const wilson = wilsonLowerBound(wins, evaluated);
  const recent = recentOf(model);
  const reasons = [];

  if (evaluated >= cfg.minSamples && wilson < floor) {
    reasons.push(`Wilson bound ${(wilson * 100).toFixed(1)}% is below the ${(floor * 100).toFixed(2)}% breakeven floor after ${evaluated} rounds`);
  }
  if (recent && recent.evaluated >= cfg.recentMinSamples && recent.rate < cfg.recentCollapseRate) {
    reasons.push(`Recent-form collapse: last-${recent.evaluated} win rate ${(recent.rate * 100).toFixed(1)}% is below ${(cfg.recentCollapseRate * 100).toFixed(0)}%`);
  }

  return {
    id: model.id,
    name: model.name || model.id,
    status: reasons.length > 0 ? 'BLACKLISTED' : 'ACTIVE',
    reasons,
    wilson,
    floor,
    samples: evaluated,
    wins,
    winRate,
    recentWinRate: recent ? recent.rate : null,
    recentSamples: recent ? recent.evaluated : 0
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
    if (this._shadowWilson(entry) > this.floor
      && recent.evaluated >= 20
      && recent.rate >= this.config.recentCollapseRate) {
      this.entries.delete(entry.id);
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
    for (const model of pool) {
      const assessment = assessModel(model, this.config);
      const existing = this.entries.get(model.id);
      if (assessment.status === 'BLACKLISTED') {
        const entry = existing || {
          id: model.id,
          sinceSamples: assessment.samples,
          baselineWins: assessment.wins,
          baselineEvaluated: assessment.samples,
          shadow: { wins: 0, evaluated: 0, recent: [] }
        };
        if (!Array.isArray(entry.shadow.recent)) entry.shadow.recent = [];
        entry.name = assessment.name;
        entry.reasons = assessment.reasons;
        entry.lastAssessment = assessment;
        entry.shadowStatus = `Shadow mode: still evaluated in the background (${entry.shadow.evaluated} shadow rounds settled)`;
        if (!existing) {
          this.entries.set(model.id, entry);
          blacklistedNow.push(entry);
        }
      } else if (existing) {
        // Live stats recovered (models keep updating in shadow mode).
        this.entries.delete(model.id);
        reinstated.push(model.id);
      }
    }
    // Also honour shadow-only reinstatement for tracked entries.
    for (const entry of [...this.entries.values()]) {
      if (entry.shadow.evaluated > 0 && this._checkShadowReinstatement(entry)) {
        reinstated.push(entry.id);
      }
    }
    // POOL FLOOR (Phase 2A, owner correction 3): the blacklist must
    // never exclude the last eligible model. If every pool model is
    // blacklisted, exempt the highest-Wilson model (ties: rank order
    // first, then samples, then pool order) and keep it eligible.
    // This is prevention inside the blacklist, not a fallback that
    // bypasses it — no bar is lowered. The exemption is reported, not
    // counted as an ordinary reinstatement, unless the model already
    // had a pre-existing entry (then it is a genuine reinstatement).
    let floorExemption = null;
    if (pool.length > 0 && pool.every(m => this.entries.has(m.id))) {
      let best = null;
      let bestWilson = -1;
      let bestRank = Number.POSITIVE_INFINITY;
      let bestSamples = -1;
      for (const model of pool) {
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
        floorExemption = {
          id: best.id,
          name: best.name || best.id,
          wilson: bestWilson,
          samples: bestSamples,
          reason: 'Pool floor: kept eligible — the pool would otherwise be empty'
        };
        this.floorExemption = floorExemption;
      }
    }
    return { blacklisted: blacklistedNow, reinstated, floorExemption, entries: this.list() };
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
  module.exports = { DEFAULT_BLACKLIST_CONFIG, assessModel, BlacklistManager, createBlacklistManager };
}

if (typeof self !== "undefined") {
  self.BlacklistManager = BlacklistManager;
  self.assessModel = assessModel;
}
