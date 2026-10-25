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
    //          shadow: { wins, evaluated }, lastAssessment }
    this.entries = new Map();
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
    entry.shadow.evaluated += 1;
    if (won) entry.shadow.wins += 1;
    return this._checkShadowReinstatement(entry);
  }

  _shadowWilson(entry) {
    return wilsonLowerBound(entry.baselineWins + entry.shadow.wins, entry.baselineEvaluated + entry.shadow.evaluated);
  }

  _checkShadowReinstatement(entry) {
    // Reinstate only when the shadow-inclusive Wilson bound recovers
    // above the floor — proof from background evaluation, not hope.
    if (this._shadowWilson(entry) > this.floor) {
      this.entries.delete(entry.id);
      return true;
    }
    return false;
  }

  /**
   * Re-assess a full model pool. Newly failing models are blacklisted;
   * blacklisted models whose (live, shadow-updated) stats recover are
   * reinstated. Returns { blacklisted: [...], reinstated: [ids], entries: [...] }.
   */
  update(models) {
    const blacklistedNow = [];
    const reinstated = [];
    for (const model of models || []) {
      const assessment = assessModel(model, this.config);
      const existing = this.entries.get(model.id);
      if (assessment.status === 'BLACKLISTED') {
        const entry = existing || {
          id: model.id,
          sinceSamples: assessment.samples,
          baselineWins: assessment.wins,
          baselineEvaluated: assessment.samples,
          shadow: { wins: 0, evaluated: 0 }
        };
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
    return { blacklisted: blacklistedNow, reinstated, entries: this.list() };
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
      shadow: { ...e.shadow },
      shadowWilson: this._shadowWilson(e)
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
