/**
 * Configurable Incharge State Machine Engine
 * ==========================================
 * Implements Sections 16, 17, 18, 19, 20, 21, 22, 36, 37:
 * Explicit Incharge State Machine:
 * - NORMAL: Highest eligible win-rate model is Incharge.
 * - STREAK_OVERRIDE: Active winning streak model temporarily takes lead.
 * - STREAK_LOST: Wrong prediction terminates streak override immediately.
 * - RETURN_TO_BASE: Returns cleanly to highest eligible win rate model.
 *
 * Fully configurable modes:
 * MODE 1: OVERALL_WIN_RATE (Server-wide all-time benchmark)
 * MODE 2: WINNING_STREAK_OVERRIDE (Base overall win rate + streak override)
 * MODE 3: SESSION_WIN_RATE (User session isolated win rate)
 * MODE 4: SESSION_STREAK_OVERRIDE (Session win rate + session streak override)
 * MODE 5: UCB_RANKING (Multi-Armed Bandit / Tournament ranking)
 *
 * v2 fixes (2026-10-23 review):
 * 1. Base ranking is by Wilson score lower bound, not raw win rate, so a
 *    3/3 model can no longer outrank a proven 580/1000 model. A model
 *    needs `minBaseEvaluated` rounds (default 200) and a win rate at or
 *    above `minWinRate` to hold the base on merit; if nobody qualifies,
 *    selection gracefully falls back to the best Wilson score.
 * 2. `minWinRate` default is the breakeven for a 0.96 payout
 *    (1 / 1.96 = 51.02%), not 0.0.
 * 3. Streak override default is now a 5-win streak (was 3 — across 101
 *    models a 3-streak is constant noise), AND the streaking model's
 *    recent form (last-100 win rate when present, else its Wilson
 *    bound) must clear the breakeven floor. Explicitly configured
 *    `minStreak` values are still respected (config stays overridable).
 * 4. UCB_RANKING now computes a real UCB1 score:
 *    winRate + sqrt(2 * ln(totalEvaluatedAll) / evaluated).
 * 5. Ranking blends an optional recent-window (last 100) win rate into
 *    the Wilson score when the model object carries it.
 * 6. Models on the blacklist (config.blacklist / options.blacklist — a
 *    Set/array of ids, or an object with isBlacklisted(id)) are
 *    excluded from selection. They keep being scored in shadow mode by
 *    the caller, just never put Incharge while blacklisted.
 */

export const INCHARGE_MODES = {
  OVERALL_WIN_RATE: 'OVERALL_WIN_RATE',
  WINNING_STREAK_OVERRIDE: 'WINNING_STREAK_OVERRIDE',
  SESSION_WIN_RATE: 'SESSION_WIN_RATE',
  SESSION_STREAK_OVERRIDE: 'SESSION_STREAK_OVERRIDE',
  UCB_RANKING: 'UCB_RANKING'
};

/** Breakeven win rate at a given payout (profit multiple on a win). */
export function breakEvenWinRate(payout = 0.96) {
  return 1 / (1 + Number(payout || 0));
}

/**
 * Wilson score lower bound for a binomial proportion.
 * The honest "win rate we can defend" — punishes small samples hard.
 */
export function wilsonLowerBound(wins, evaluated, z = 1.96) {
  const n = Number(evaluated) || 0;
  if (n <= 0) return 0;
  const w = Math.min(n, Math.max(0, Number(wins) || 0));
  const p = w / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denominator);
}

/** Real UCB1 exploration score. Unevaluated arms score Infinity (explore first). */
export function ucb1Score(winRate, evaluated, totalEvaluatedAll) {
  const n = Number(evaluated) || 0;
  if (n <= 0) return Infinity;
  const total = Math.max(n, Number(totalEvaluatedAll) || 0);
  return (Number(winRate) || 0) + Math.sqrt((2 * Math.log(Math.max(1, total))) / n);
}

export const DEFAULT_INCHARGE_CONFIG = {
  predictionSource: 'LOCAL', // 'LOCAL' (Worker Compute) or 'CLOUD' (Server Stream)
  mode: INCHARGE_MODES.WINNING_STREAK_OVERRIDE,
  minStreak: 5, // v2: was 3 — a 3-streak across 101 models is noise, not form
  minEvaluated: 10, // minimum evaluated rounds for streak-override eligibility
  minBaseEvaluated: 200, // v2: minimum evaluated rounds to hold the base on merit
  minWinRate: breakEvenWinRate(0.96), // v2: 51.02% breakeven floor at 0.96 payout (was 0.0)
  payout: 0.96,
  recencyWeight: 0.35, // blend weight for the last-100 window when present
  recencyWindow: 100,
  blacklist: null, // Set/array of ids, or { isBlacklisted(id) }
  returnToBaseOnLoss: true,
  tieBreaker: 'HIGHER_WIN_RATE' // 'HIGHER_WIN_RATE' | 'TOTAL_EVALUATED' | 'ACTIVE_STREAK' | 'NAME'
};

// ── shared stat extraction (overall vs session metric) ────────────────
function statsOf(m, metricType = 'overall') {
  const session = metricType === 'session';
  let winRate;
  if (session && m.sessionWinRate !== undefined) winRate = Number(m.sessionWinRate);
  else if (m.winRate !== undefined) winRate = Number(m.winRate);
  else if (m.winRatePct) winRate = parseFloat(m.winRatePct) / 100;
  else winRate = 0;

  let evaluated;
  if (session && m.sessionEvaluated !== undefined) evaluated = Number(m.sessionEvaluated);
  else evaluated = Number(m.totalEvaluated !== undefined ? m.totalEvaluated : (m.evaluated || 0));

  let wins;
  if (session && m.sessionWins !== undefined) wins = Number(m.sessionWins);
  else if (m.wins !== undefined) wins = Number(m.wins);
  else wins = Math.round(winRate * evaluated);

  const streak = session && m.sessionStreak !== undefined
    ? Number(m.sessionStreak)
    : Number(m.streak !== undefined ? m.streak : 0);

  return { winRate: Number.isFinite(winRate) ? winRate : 0, evaluated: evaluated || 0, wins: wins || 0, streak };
}

function recentOf(m, metricType = 'overall', windowSize = 100) {
  const session = metricType === 'session';
  const rateRaw = session
    ? (m.sessionRecentWinRate ?? m.sessionLast100WinRate)
    : (m.recentWinRate ?? m.last100WinRate ?? m.recent100WinRate);
  const winsRaw = session ? m.sessionRecentWins : m.recentWins;
  const evalRaw = session ? (m.sessionRecentEvaluated ?? m.sessionRecentSamples) : (m.recentEvaluated ?? m.recentSamples ?? m.last100Evaluated);
  if (rateRaw !== undefined && rateRaw !== null) {
    const rate = Number(rateRaw);
    const n = evalRaw !== undefined ? Number(evalRaw) : windowSize;
    if (Number.isFinite(rate)) return { rate, evaluated: n || windowSize };
  }
  if (winsRaw !== undefined && evalRaw !== undefined && Number(evalRaw) > 0) {
    return { rate: Number(winsRaw) / Number(evalRaw), evaluated: Number(evalRaw) };
  }
  return null;
}

function isBlacklistedId(blacklist, id) {
  if (!blacklist || id === undefined || id === null) return false;
  if (typeof blacklist.isBlacklisted === 'function') return blacklist.isBlacklisted(id) === true;
  if (blacklist instanceof Set) return blacklist.has(id);
  if (Array.isArray(blacklist)) return blacklist.includes(id);
  return false;
}

export class InchargeEngine {
  constructor(initialConfig = {}) {
    this.config = { ...DEFAULT_INCHARGE_CONFIG, ...initialConfig };
    this.state = 'NORMAL'; // 'NORMAL' | 'STREAK_OVERRIDE' | 'RETURN_TO_BASE'
    this.activeStreakModelId = null;
    this.activeStreakCount = 0;
  }

  updateConfig(newConfig = {}) {
    this.config = { ...this.config, ...newConfig };
  }

  getConfig() {
    return { ...this.config };
  }

  getState() {
    return {
      state: this.state,
      activeStreakModelId: this.activeStreakModelId,
      activeStreakCount: this.activeStreakCount,
      config: { ...this.config }
    };
  }

  /** Safety-adjusted ranking score for one model (Wilson, recency-blended, or UCB1 in UCB mode). */
  scoreModel(m, metricType = 'overall', totalEvaluatedAll = 0) {
    const s = statsOf(m, metricType);
    let score;
    if ((this.config.mode || '') === INCHARGE_MODES.UCB_RANKING) {
      score = ucb1Score(s.winRate, s.evaluated, totalEvaluatedAll);
    } else {
      const wilson = wilsonLowerBound(s.wins, s.evaluated);
      const recent = recentOf(m, metricType, this.config.recencyWindow || 100);
      if (recent) {
        const recentWilson = wilsonLowerBound(recent.rate * recent.evaluated, recent.evaluated);
        const w = Math.min(0.9, Math.max(0, Number(this.config.recencyWeight ?? 0.35)));
        score = (1 - w) * wilson + w * recentWilson;
      } else {
        score = wilson;
      }
    }
    // Pattern-conditioned blend: when the caller supplies this model's
    // hit rate under the CURRENTLY ACTIVE pattern (patternHitRate with
    // patternSamples >= 20 firings), blend it into the ranking score with
    // a bounded weight (never more than 0.25), so a pattern specialist can
    // rise for pattern rounds without hijacking the overall ranking.
    const patRate = m.patternHitRate;
    const patSamples = Number(m.patternSamples ?? 0);
    if (patRate !== undefined && patRate !== null && Number.isFinite(Number(patRate)) && patSamples >= 20) {
      const w = Math.min(0.25, Math.max(0, Number(this.config.patternWeight ?? 0.25)));
      score = (1 - w) * score + w * Number(patRate);
    }
    return score;
  }

  /** Recent-form value used by the streak gate: last-100 rate, else Wilson bound. */
  recentFormScore(m, metricType = 'overall') {
    const recent = recentOf(m, metricType, this.config.recencyWindow || 100);
    if (recent) return recent.rate;
    const s = statsOf(m, metricType);
    return wilsonLowerBound(s.wins, s.evaluated);
  }

  /**
   * Sorts models by the v2 score (Wilson / recency blend / UCB1),
   * then by the classic tie-breakers: evaluated, streak, wins, name.
   * options.blacklist (or config.blacklist) removes models up front.
   */
  rankModels(models, metricType = 'overall', options = {}) {
    const blacklist = options.blacklist ?? this.config.blacklist;
    const pool = (models || []).filter(m => !isBlacklistedId(blacklist, m.id));
    const totalEvaluatedAll = pool.reduce((sum, m) => sum + statsOf(m, metricType).evaluated, 0);

    return [...pool].sort((a, b) => {
      const scoreA = this.scoreModel(a, metricType, totalEvaluatedAll);
      const scoreB = this.scoreModel(b, metricType, totalEvaluatedAll);
      if (scoreB !== scoreA) {
        const diff = scoreB - scoreA;
        if (!Number.isNaN(diff)) return diff;
      }
      const evA = statsOf(a, metricType).evaluated;
      const evB = statsOf(b, metricType).evaluated;
      if (evB !== evA) return evB - evA; // Tie-breaker 1: Total evaluated rounds

      const sA = statsOf(a, metricType).streak;
      const sB = statsOf(b, metricType).streak;
      if (sB !== sA) return sB - sA; // Tie-breaker 2: Active streak

      const wA = Number(a.wins || 0);
      const wB = Number(b.wins || 0);
      if (wB !== wA) return wB - wA; // Tie-breaker 3: Total wins

      return (a.name || '').localeCompare(b.name || '');
    });
  }

  /**
   * Selects authoritative In-Charge Model based on explicit state machine
   */
  evaluateIncharge(models, options = {}) {
    if (!Array.isArray(models) || models.length === 0) return null;

    const manualId = options.manualId || null;
    const isAutoMode = options.isAutoMode !== false;

    // Manual override lock (an explicit human choice outranks the blacklist)
    if (!isAutoMode && manualId) {
      const manual = models.find(m => m.id === manualId || m.name === manualId);
      if (manual) {
        this.state = 'MANUAL_LOCK';
        this.activeStreakModelId = null;
        return {
          model: manual,
          mode: 'MANUAL_LOCK',
          state: this.state,
          reason: `Manual Override: ${manual.name}`
        };
      }
    }

    const mode = this.config.mode || INCHARGE_MODES.WINNING_STREAK_OVERRIDE;
    const isSessionMode = mode === INCHARGE_MODES.SESSION_WIN_RATE || mode === INCHARGE_MODES.SESSION_STREAK_OVERRIDE;
    const isStreakEnabled = mode === INCHARGE_MODES.WINNING_STREAK_OVERRIDE || mode === INCHARGE_MODES.SESSION_STREAK_OVERRIDE;
    const metricType = isSessionMode ? 'session' : 'overall';
    const blacklist = options.blacklist ?? this.config.blacklist;

    const ranked = this.rankModels(models, metricType, { blacklist });
    const fallbackRanked = ranked.length > 0 ? ranked : this.rankModels(models, metricType);
    const blacklistedExcluded = models.length - ranked.length;

    // Base champion: must clear BOTH the sample floor and the win-rate
    // floor to hold the base on merit. Graceful fallback: best Wilson.
    const minBaseEvaluated = Number(this.config.minBaseEvaluated ?? 200);
    const minWinRate = Number(this.config.minWinRate ?? breakEvenWinRate(this.config.payout ?? 0.96));
    const eligibleBase = fallbackRanked.filter(m => {
      const s = statsOf(m, metricType);
      return s.evaluated >= minBaseEvaluated && s.winRate >= minWinRate;
    });
    // UCB mode is an exploration ranking by design: its top score IS the
    // base (the merit filter would defeat the exploration bonus).
    const baseModel = mode === INCHARGE_MODES.UCB_RANKING
      ? (fallbackRanked[0] || models[0])
      : (eligibleBase[0] || fallbackRanked[0] || models[0]);
    const baseStats = statsOf(baseModel, metricType);
    const baseReason = `👑 Base Champion: ${baseModel.name} (${(baseStats.winRate * 100).toFixed(1)}% WR, Wilson ${(this.scoreModel(baseModel, metricType) * 100).toFixed(1)}%)`;

    // If streak override is disabled, return baseModel
    if (!isStreakEnabled) {
      this.state = 'NORMAL';
      this.activeStreakModelId = null;
      return {
        model: baseModel,
        mode,
        state: this.state,
        reason: baseReason,
        blacklistedExcluded
      };
    }

    // Evaluate Streaking Models (qualifying streak >= minStreak AND real form)
    const minStreak = Number(this.config.minStreak ?? 5);
    const minEvaluated = Number(this.config.minEvaluated ?? 10);
    const formFloor = Math.max(minWinRate, breakEvenWinRate(this.config.payout ?? 0.96));
    const passesFormGate = m => this.recentFormScore(m, metricType) >= formFloor;

    const getStreak = m => statsOf(m, metricType).streak;
    const getEvaluated = m => statsOf(m, metricType).evaluated;

    // If an active streak model is already in lead, check if it still qualifies
    if (this.state === 'STREAK_OVERRIDE' && this.activeStreakModelId) {
      const currentStreakModel = fallbackRanked.find(m => m.id === this.activeStreakModelId);
      const curStreak = currentStreakModel ? getStreak(currentStreakModel) : 0;
      if (currentStreakModel && curStreak >= minStreak && passesFormGate(currentStreakModel)) {
        // Continue active streak override
        this.activeStreakCount = curStreak;
        return {
          model: currentStreakModel,
          mode,
          state: this.state,
          reason: `🔥 Streak Rider Active: ${currentStreakModel.name} (+${curStreak}W streak)`,
          blacklistedExcluded
        };
      } else {
        // Termination: wrong prediction, broken streak, or form collapsed
        this.state = 'RETURN_TO_BASE';
        this.activeStreakModelId = null;
        this.activeStreakCount = 0;
      }
    }

    // Look for new qualifying streak model
    const eligibleStreakers = fallbackRanked.filter(m => {
      const s = getStreak(m);
      const ev = getEvaluated(m);
      return s >= minStreak && ev >= minEvaluated && m.id !== baseModel.id && passesFormGate(m);
    });

    if (eligibleStreakers.length > 0) {
      // Pick highest streaker (tie break by safety-adjusted score)
      eligibleStreakers.sort((a, b) => {
        const sDiff = getStreak(b) - getStreak(a);
        if (sDiff !== 0) return sDiff;
        return this.scoreModel(b, metricType) - this.scoreModel(a, metricType);
      });

      const streakChampion = eligibleStreakers[0];
      this.state = 'STREAK_OVERRIDE';
      this.activeStreakModelId = streakChampion.id;
      this.activeStreakCount = getStreak(streakChampion);

      return {
        model: streakChampion,
        mode,
        state: this.state,
        reason: `🚀 Streak Override: ${streakChampion.name} (+${this.activeStreakCount}W streak overtaking ${baseModel.name})`,
        blacklistedExcluded
      };
    }

    // Default to Base Model
    this.state = 'NORMAL';
    this.activeStreakModelId = null;
    this.activeStreakCount = 0;
    return {
      model: baseModel,
      mode,
      state: this.state,
      reason: baseReason,
      blacklistedExcluded
    };
  }

  /**
   * Invoked after a round settles to terminate streak override immediately on WRONG prediction
   */
  handleRoundSettlement(settledRoundResult) {
    if (this.state === 'STREAK_OVERRIDE' && this.activeStreakModelId) {
      const isWon = settledRoundResult && settledRoundResult.won === true;
      if (!isWon) {
        // Immediate termination
        this.state = 'RETURN_TO_BASE';
        this.activeStreakModelId = null;
        this.activeStreakCount = 0;
      }
    }
  }
}

export const globalInchargeEngine = new InchargeEngine();

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    INCHARGE_MODES,
    DEFAULT_INCHARGE_CONFIG,
    InchargeEngine,
    globalInchargeEngine,
    wilsonLowerBound,
    ucb1Score,
    breakEvenWinRate
  };
}

if (typeof self !== "undefined") {
  self.INCHARGE_MODES = INCHARGE_MODES;
  self.DEFAULT_INCHARGE_CONFIG = DEFAULT_INCHARGE_CONFIG;
  self.InchargeEngine = InchargeEngine;
  self.globalInchargeEngine = globalInchargeEngine;
  self.wilsonLowerBound = wilsonLowerBound;
}
