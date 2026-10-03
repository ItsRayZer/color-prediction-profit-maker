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
 */

export const INCHARGE_MODES = {
  OVERALL_WIN_RATE: 'OVERALL_WIN_RATE',
  WINNING_STREAK_OVERRIDE: 'WINNING_STREAK_OVERRIDE',
  SESSION_WIN_RATE: 'SESSION_WIN_RATE',
  SESSION_STREAK_OVERRIDE: 'SESSION_STREAK_OVERRIDE',
  UCB_RANKING: 'UCB_RANKING'
};

export const DEFAULT_INCHARGE_CONFIG = {
  predictionSource: 'LOCAL', // 'LOCAL' (Worker Compute) or 'CLOUD' (Server Stream)
  mode: INCHARGE_MODES.WINNING_STREAK_OVERRIDE,
  minStreak: 3,
  minEvaluated: 10,
  minWinRate: 0.0,
  returnToBaseOnLoss: true,
  tieBreaker: 'HIGHER_WIN_RATE' // 'HIGHER_WIN_RATE' | 'TOTAL_EVALUATED' | 'ACTIVE_STREAK' | 'NAME'
};

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

  /**
   * Sorts models by chosen metric and tie-breakers
   */
  rankModels(models, metricType = 'overall') {
    const getWinRate = m => {
      if (metricType === 'session' && m.sessionWinRate !== undefined) return Number(m.sessionWinRate);
      if (m.winRate !== undefined) return Number(m.winRate);
      if (m.winRatePct) return parseFloat(m.winRatePct) / 100;
      return 0;
    };

    const getStreak = m => {
      if (metricType === 'session' && m.sessionStreak !== undefined) return Number(m.sessionStreak);
      return Number(m.streak !== undefined ? m.streak : 0);
    };

    const getEvaluated = m => {
      if (metricType === 'session' && m.sessionEvaluated !== undefined) return Number(m.sessionEvaluated);
      return Number(m.totalEvaluated !== undefined ? m.totalEvaluated : (m.evaluated || 0));
    };

    return [...models].sort((a, b) => {
      const wrA = getWinRate(a);
      const wrB = getWinRate(b);
      if (wrB !== wrA) return wrB - wrA; // Highest win rate first

      const evA = getEvaluated(a);
      const evB = getEvaluated(b);
      if (evB !== evA) return evB - evA; // Tie-breaker 1: Total evaluated rounds

      const sA = getStreak(a);
      const sB = getStreak(b);
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

    // Manual override lock
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
    const ranked = this.rankModels(models, metricType);
    const baseModel = ranked[0] || models[0];

    // If streak override is disabled, return baseModel
    if (!isStreakEnabled) {
      this.state = 'NORMAL';
      this.activeStreakModelId = null;
      return {
        model: baseModel,
        mode,
        state: this.state,
        reason: `👑 Base Champion: ${baseModel.name} (${((baseModel.winRate || 0) * 100).toFixed(1)}% WR)`
      };
    }

    // Evaluate Streaking Models (qualifying streak >= minStreak)
    const minStreak = Number(this.config.minStreak || 3);
    const minEvaluated = Number(this.config.minEvaluated || 10);

    const getStreak = m => isSessionMode && m.sessionStreak !== undefined ? Number(m.sessionStreak) : Number(m.streak || 0);
    const getEvaluated = m => isSessionMode && m.sessionEvaluated !== undefined ? Number(m.sessionEvaluated) : Number(m.totalEvaluated || 0);

    // If an active streak model is already in lead, check if it still qualifies
    if (this.state === 'STREAK_OVERRIDE' && this.activeStreakModelId) {
      const currentStreakModel = models.find(m => m.id === this.activeStreakModelId);
      const curStreak = currentStreakModel ? getStreak(currentStreakModel) : 0;
      if (currentStreakModel && curStreak >= minStreak) {
        // Continue active streak override
        this.activeStreakCount = curStreak;
        return {
          model: currentStreakModel,
          mode,
          state: this.state,
          reason: `🔥 Streak Rider Active: ${currentStreakModel.name} (+${curStreak}W streak)`
        };
      } else {
        // Termination: wrong prediction or broken streak
        this.state = 'RETURN_TO_BASE';
        this.activeStreakModelId = null;
        this.activeStreakCount = 0;
      }
    }

    // Look for new qualifying streak model
    const eligibleStreakers = models.filter(m => {
      const s = getStreak(m);
      const ev = getEvaluated(m);
      return s >= minStreak && ev >= minEvaluated && m.id !== baseModel.id;
    });

    if (eligibleStreakers.length > 0) {
      // Pick highest streaker (tie break by win rate)
      eligibleStreakers.sort((a, b) => {
        const sDiff = getStreak(b) - getStreak(a);
        if (sDiff !== 0) return sDiff;
        return (b.winRate || 0) - (a.winRate || 0);
      });

      const streakChampion = eligibleStreakers[0];
      this.state = 'STREAK_OVERRIDE';
      this.activeStreakModelId = streakChampion.id;
      this.activeStreakCount = getStreak(streakChampion);

      return {
        model: streakChampion,
        mode,
        state: this.state,
        reason: `🚀 Streak Override: ${streakChampion.name} (+${this.activeStreakCount}W streak overtaking ${baseModel.name})`
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
      reason: `👑 Base Champion: ${baseModel.name} (${((baseModel.winRate || 0) * 100).toFixed(1)}% WR)`
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
    globalInchargeEngine
  };
}

if (typeof self !== "undefined") {
  self.INCHARGE_MODES = INCHARGE_MODES;
  self.DEFAULT_INCHARGE_CONFIG = DEFAULT_INCHARGE_CONFIG;
  self.InchargeEngine = InchargeEngine;
  self.globalInchargeEngine = globalInchargeEngine;
}
