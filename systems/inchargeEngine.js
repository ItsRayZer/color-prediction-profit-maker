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
 * NOTE (Phase 2A): SESSION_WIN_RATE and SESSION_STREAK_OVERRIDE are
 * config-only today — no caller sets them (the runtime uses
 * WINNING_STREAK_OVERRIDE, the default). They are documented, never
 * silently wired; see the flag at evaluateIncharge.
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

    // MANUAL_LOCK — DEAD PATH in the governed runtime (Phase 2A flag,
    // never silently wired): orb-bridge always calls evaluateIncharge
    // with {} (isAutoMode defaults true, no manualId), and no caller
    // passes manualId. Kept for API compatibility only; manual model
    // selection is not part of the governed flow.
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
    // SESSION modes — DEAD CONFIG (Phase 2A flag, never silently
    // wired): no caller sets mode to SESSION_WIN_RATE or
    // SESSION_STREAK_OVERRIDE anywhere; the runtime runs
    // WINNING_STREAK_OVERRIDE. Kept as config only.
    const isSessionMode = mode === INCHARGE_MODES.SESSION_WIN_RATE || mode === INCHARGE_MODES.SESSION_STREAK_OVERRIDE;
    const isStreakEnabled = mode === INCHARGE_MODES.WINNING_STREAK_OVERRIDE || mode === INCHARGE_MODES.SESSION_STREAK_OVERRIDE;
    const metricType = isSessionMode ? 'session' : 'overall';
    const blacklist = options.blacklist ?? this.config.blacklist;

    const ranked = this.rankModels(models, metricType, { blacklist });
    const blacklistedExcluded = models.length - ranked.length;
    // AUDIT FIX (2026-10-24): the old code fell back to re-ranking WITH
    // the blacklisted models when the eligible pool was empty, which
    // crowned a blacklisted model — violating this module's own rule
    // ("never put Incharge while blacklisted"). When a blacklist is in
    // force and it excludes EVERYONE, there is no Incharge: return
    // null and let the caller SKIP. (When no blacklist is in force,
    // rankModels cannot return empty for a non-empty model list.)
    if (ranked.length === 0) {
      this.state = 'NORMAL';
      this.activeStreakModelId = null;
      this.activeStreakCount = 0;
      return null;
    }
    const fallbackRanked = ranked;

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
    // Phase 2A fix: the old label called scoreModel()'s output
    // "Wilson", which was wrong whenever recency/pattern blending
    // applied — and doubly wrong in UCB mode, where scoreModel was
    // called WITHOUT totalEvaluatedAll (so the UCB bonus was garbage).
    // Wilson bound and blended score are now SEPARATE labels, and the
    // score is computed exactly as rankModels computes it.
    const baseTotalEvaluatedAll = fallbackRanked.reduce((sum, m) => sum + statsOf(m, metricType).evaluated, 0);
    const baseWilson = wilsonLowerBound(baseStats.wins, baseStats.evaluated);
    const baseScore = this.scoreModel(baseModel, metricType, baseTotalEvaluatedAll);
    const baseScoreText = mode === INCHARGE_MODES.UCB_RANKING
      ? `UCB ${baseScore === Infinity ? '∞' : baseScore.toFixed(3)}`
      : `${(baseScore * 100).toFixed(1)}%`;
    const baseReason = `👑 Base Champion: ${baseModel.name} (${(baseStats.winRate * 100).toFixed(1)}% WR, Wilson ${(baseWilson * 100).toFixed(1)}%, score ${baseScoreText})`;

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
   *
   * DEAD PATH (Phase 2A flag, never silently wired): zero callers.
   * The governed settlement flow terminates streaks through
   * GovernedStreakGuard (signalGate.js / orb-bridge.js), not through
   * this method. Kept for API compatibility only.
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

// ── Phase 3A: the owner's Incharge rule, v2 §1–§2 ───────────────────
// Owner structure (2026-10-26, unchanged): streak first, last-10 rate
// check, session rule. v2 comparisons (owner-approved 2026-10-26
// ~22:01, superseding the raw-rate version): streaks compare by
// STREAK SURPRISE (not raw counts — a 3-win exact streak is ~16x less
// likely under chance than a 6-win colour streak), rates compare by
// WILSON MARGIN over the type's own bar (not raw rates — a 60% colour
// model and an 18.5% exact model can both be ~2pts above their bars).
// The governed gate still applies AFTER selection for any BET, and
// Incharge leadership alone never forces a bet.
//
// Base rates: colour/size win on 5 of 10 numbers (0.5); exact-ball on
// 1 of 10 digits (0.10). Breakevens: colour/size 51.02% at the
// code-pinned 0.96 payout; exact 11.34% at the PROPOSAL 7.82 profit
// multiple (standard table, NOT live-verified). The exact breakeven
// is used ONLY for leadership ranking here — exact BETs stay gated
// off (signalGate exact-gate) and no stake math uses 7.82.
//
// Windows (exact): streak = current consecutive settled wins of the
// model's own walk-forward picks; last-10 = last 10 settled rounds;
// session = rounds since the current page load (reload = new
// session); full history = all recorded rounds. All windows are RAW
// counts on the pool entries the caller passes (streak,
// last10Wins/last10Evaluated, sessionWins/sessionEvaluated,
// wins/totalEvaluated) — this function never reads the store.
//
// Ties: surprise tie → higher full-history Wilson margin → more
// evaluated samples → pool order (first wins, stable). Step-2 flip
// needs challenger M10 > leader M10 + 0.02 (2-pt hysteresis band);
// inside the band the streak leader stays. Step 3 runs on every
// selection: no session leader (session n = 0 for all) → full-history
// leader; session leader's margin < full leader's margin →
// full-history leader; else the Steps 1–2 leader stays.
// Stopped types (per-type HARD_STOP guards) are excluded from
// candidacy by the caller via options.stoppedTypes — exactly like
// blacklisted models (the caller pre-filters those too).
export const INCHARGE_BASE_RATE = { COLOR: 0.5, SIZE: 0.5, NUMBER: 0.10 };
export const INCHARGE_BREAKEVEN = {
  COLOR: breakEvenWinRate(0.96),
  SIZE: breakEvenWinRate(0.96),
  NUMBER: 1 / (1 + 7.82) // 11.34% PROPOSAL — leadership ranking only
};
export const INCHARGE_LAST10_BAND = 0.02;

export function streakSurprise(streak, type) {
  const base = INCHARGE_BASE_RATE[type] ?? 0.5;
  return (Number(streak) || 0) * Math.log10(1 / base);
}

export function wilsonMargin(wins, n, type) {
  const bar = INCHARGE_BREAKEVEN[type] ?? INCHARGE_BREAKEVEN.COLOR;
  return wilsonLowerBound(wins, n) - bar;
}

function inchargeStats(m) {
  const type = (m && m.predType) ? String(m.predType).toUpperCase() : 'COLOR';
  const t = INCHARGE_BASE_RATE[type] ? type : 'COLOR';
  const streak = Number(m.streak) || 0;
  const last10Wins = Number(m.last10Wins) || 0;
  const last10N = Number(m.last10Evaluated) || 0;
  const sessionWins = Number(m.sessionWins) || 0;
  const sessionN = Number(m.sessionEvaluated) || 0;
  const wins = Number(m.wins) || 0;
  const total = Number(m.totalEvaluated ?? m.evaluated) || 0;
  return {
    type: t,
    streak,
    surprise: streakSurprise(streak, t),
    last10Margin: wilsonMargin(last10Wins, last10N, t),
    sessionMargin: wilsonMargin(sessionWins, sessionN, t),
    fullMargin: wilsonMargin(wins, total, t),
    last10N, sessionN, total
  };
}

export function selectInchargeOwnerRule(models, options = {}) {
  const list = Array.isArray(models) ? models : [];
  const stopped = new Set(
    (options.stoppedTypes instanceof Set ? [...options.stoppedTypes] : (options.stoppedTypes || []))
      .map(t => String(t).toUpperCase())
  );
  const candidates = list
    .map(m => ({ model: m, s: inchargeStats(m) }))
    .filter(({ s }) => !stopped.has(s.type));
  if (candidates.length === 0) return null;

  // Best-by with the v2 tie order: key desc, then full margin desc,
  // then samples desc, then name (alphabetically first, matching the
  // engine's existing tie-breaker), then pool order (stable first).
  const bestBy = (keyFn) => {
    let best = null;
    for (const c of candidates) {
      if (!best) { best = c; continue; }
      const a = keyFn(c); const b = keyFn(best);
      if (a > b) { best = c; continue; }
      if (a === b) {
        if (c.s.fullMargin > best.s.fullMargin) { best = c; continue; }
        if (c.s.fullMargin === best.s.fullMargin) {
          if (c.s.total > best.s.total) { best = c; continue; }
          if (c.s.total === best.s.total) {
            const an = c.model.name || c.model.id || '';
            const bn = best.model.name || best.model.id || '';
            if (an.localeCompare(bn) < 0) best = c;
          }
        }
      }
    }
    return best;
  };

  // Step 1 — STREAK FIRST (by surprise).
  const streakLeader = bestBy(c => c.s.surprise);
  let leader = streakLeader;
  let path = 'streak';
  let reason = `Incharge: ${leader.model.name || leader.model.id} — streak surprise ${leader.s.surprise.toFixed(2)}`;

  // Step 2 — RATE CHECK (last-10 Wilson margin, 2-pt band).
  const last10Leader = bestBy(c => c.s.last10Margin);
  if (last10Leader.s.last10Margin > streakLeader.s.last10Margin + INCHARGE_LAST10_BAND) {
    leader = last10Leader;
    path = 'last10';
    reason = `Incharge: ${leader.model.name || leader.model.id} — last-10 margin ${(leader.s.last10Margin * 100).toFixed(1)}pts`;
  }

  // Step 3 — SESSION RULE (runs on every selection).
  const sessionLeader = bestBy(c => c.s.sessionMargin);
  const fullLeader = bestBy(c => c.s.fullMargin);
  const noSessionLeader = candidates.every(c => c.s.sessionN === 0);
  if (noSessionLeader) {
    leader = fullLeader;
    path = 'full';
    reason = `Incharge: ${leader.model.name || leader.model.id} — full-history margin ${(leader.s.fullMargin * 100).toFixed(1)}pts`;
  } else if (sessionLeader.s.sessionMargin < fullLeader.s.fullMargin) {
    leader = fullLeader;
    path = 'full';
    reason = `Incharge: ${leader.model.name || leader.model.id} — full-history margin ${(leader.s.fullMargin * 100).toFixed(1)}pts`;
  }

  return {
    model: leader.model,
    reason,
    detail: {
      path,
      streakLeaderId: streakLeader.model.id,
      last10LeaderId: last10Leader.model.id,
      sessionLeaderId: sessionLeader.model.id,
      fullLeaderId: fullLeader.model.id
    }
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    INCHARGE_MODES,
    DEFAULT_INCHARGE_CONFIG,
    InchargeEngine,
    globalInchargeEngine,
    wilsonLowerBound,
    ucb1Score,
    breakEvenWinRate,
    INCHARGE_BASE_RATE,
    INCHARGE_BREAKEVEN,
    INCHARGE_LAST10_BAND,
    streakSurprise,
    wilsonMargin,
    selectInchargeOwnerRule
  };
}

if (typeof self !== "undefined") {
  self.INCHARGE_MODES = INCHARGE_MODES;
  self.DEFAULT_INCHARGE_CONFIG = DEFAULT_INCHARGE_CONFIG;
  self.InchargeEngine = InchargeEngine;
  self.globalInchargeEngine = globalInchargeEngine;
  self.wilsonLowerBound = wilsonLowerBound;
}
