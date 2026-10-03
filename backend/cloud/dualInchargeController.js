/**
 * Dual Incharge System (Incharge A vs Incharge B)
 * ===============================================
 * INCHARGE B: Server Service Incharge (authoritative, cloud-wide, 24/7, based on all-time history & stats)
 * INCHARGE A: User Session Incharge (isolated per user session, based on session-reset statistics)
 *
 * Strict Isolation Rule:
 * User Reset ONLY resets Incharge A and user session statistics.
 * Incharge B, full history, UCB, global rankings, and server model stats remain 100% UNCHANGED.
 */

import { determineOptimalArenaInChargeModel } from './modelRegistry.js';
import { InchargeEngine, INCHARGE_MODES } from '../../systems/inchargeEngine.js';

export class DualInchargeController {
  constructor(db) {
    this.db = db;
    this.serviceEngine = new InchargeEngine({ mode: INCHARGE_MODES.WINNING_STREAK_OVERRIDE });
    this.sessionEngines = new Map();
  }

  // ── INCHARGE B: Server Service Controller ──
  evaluateServiceIncharge(interval, models, manualId = null, isAutoMode = true) {
    if (!Array.isArray(models) || models.length === 0) return null;

    // Run configurable Incharge state machine with winning streak override
    const selection = this.serviceEngine.evaluateIncharge(models, { manualId, isAutoMode });
    return selection;
  }

  // ── INCHARGE A: User Session Controller ──
  evaluateSessionIncharge(sessionId, interval, models, manualId = null, isAutoMode = true, config = {}) {
    if (!Array.isArray(models) || models.length === 0) return null;

    if (!this.sessionEngines.has(sessionId)) {
      this.sessionEngines.set(sessionId, new InchargeEngine({ mode: INCHARGE_MODES.SESSION_STREAK_OVERRIDE, ...config }));
    }
    const sessionEngine = this.sessionEngines.get(sessionId);
    if (config && Object.keys(config).length > 0) {
      sessionEngine.updateConfig(config);
    }

    // Load session-specific stats for this user
    const sessionStats = this.db.getUserSessionStats(sessionId, interval);
    const statsMap = new Map();
    sessionStats.forEach(s => statsMap.set(s.model_id, s));

    // Map models to their session win rates and streaks
    const sessionModels = models.map(m => {
      const s = statsMap.get(m.id);
      return {
        ...m,
        wins: s ? s.wins : 0,
        losses: s ? s.losses : 0,
        totalEvaluated: s ? s.total_evaluated : 0,
        winRate: s ? s.win_rate : 0.0,
        winRatePct: s ? (s.win_rate * 100).toFixed(1) + '%' : '0.0%',
        streak: s ? s.streak : 0,
        bestStreak: s ? s.best_streak : 0,
        sessionWinRate: s ? s.win_rate : 0.0,
        sessionStreak: s ? s.streak : 0,
        sessionEvaluated: s ? s.total_evaluated : 0
      };
    });

    // Run configurable Incharge state machine with session statistics
    const selection = sessionEngine.evaluateIncharge(sessionModels, { manualId, isAutoMode });
    return selection;
  }

  // Record settled round outcome for a user session
  updateUserSessionRound(sessionId, interval, models, settledRound) {
    const numVal = parseInt(settledRound.number, 10);
    const actualColor = [1, 3, 5, 7, 9].includes(numVal) ? 'GREEN' : 'RED';
    const actualSize = settledRound.size || (numVal >= 5 ? 'BIG' : 'SMALL');

    const sessionStats = this.db.getUserSessionStats(sessionId, interval);
    const statsMap = new Map();
    sessionStats.forEach(s => statsMap.set(s.model_id, s));

    models.forEach(m => {
      const current = statsMap.get(m.id) || {
        total_evaluated: 0,
        wins: 0,
        losses: 0,
        win_rate: 0.0,
        streak: 0,
        best_streak: 0
      };

      const won = m.predType === 'COLOR'
        ? (m.predTarget === 'GREEN' ? actualColor === 'GREEN' : actualColor === 'RED')
        : (m.predTarget === 'BIG' ? actualSize === 'BIG' : actualSize === 'SMALL');

      const totalEvaluated = current.total_evaluated + 1;
      const wins = current.wins + (won ? 1 : 0);
      const losses = current.losses + (won ? 0 : 1);
      const winRate = Number((wins / totalEvaluated).toFixed(3));
      const streak = won ? (current.streak >= 0 ? current.streak + 1 : 1) : (current.streak <= 0 ? current.streak - 1 : -1);
      const bestStreak = Math.max(current.best_streak || 0, streak);

      this.db.saveUserSessionStat(sessionId, interval, m.id, {
        totalEvaluated,
        wins,
        losses,
        winRate,
        streak,
        bestStreak
      });
    });
  }

  // Handle Client Reset Action
  resetUserSession(sessionId) {
    if (this.sessionEngines.has(sessionId)) {
      this.sessionEngines.delete(sessionId);
    }
    return this.db.resetUserSession(sessionId);
  }
}

