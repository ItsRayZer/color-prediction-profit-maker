/**
 * Probabilistic Regime Classifier & Radar
 * Implements Section 21:
 * Probabilistic output across 9 regimes:
 * - CHOPPY_MODE
 * - STREAK_MODE
 * - TRAP_MODE
 * - VIOLET_INTERRUPT_MODE
 * - CORRECTION_MODE
 * - BASE_FAILURE_MODE
 * - SILENT_RANDOM_MODE
 * - TRANSITION_MODE
 * - UNKNOWN_MODE
 */

import type { RoundResult } from '../prediction/predictionTypes.ts';

export type RegimeType =
  | 'CHOPPY_MODE'
  | 'STREAK_MODE'
  | 'TRAP_MODE'
  | 'VIOLET_INTERRUPT_MODE'
  | 'CORRECTION_MODE'
  | 'BASE_FAILURE_MODE'
  | 'SILENT_RANDOM_MODE'
  | 'TRANSITION_MODE'
  | 'UNKNOWN_MODE';

export class RegimeClassifier {
  public classify(history: RoundResult[], baseFailureStreak = 0): Record<RegimeType, number> {
    const defaultDistribution: Record<RegimeType, number> = {
      CHOPPY_MODE: 0.1,
      STREAK_MODE: 0.1,
      TRAP_MODE: 0.1,
      VIOLET_INTERRUPT_MODE: 0.1,
      CORRECTION_MODE: 0.1,
      BASE_FAILURE_MODE: 0.05,
      SILENT_RANDOM_MODE: 0.15,
      TRANSITION_MODE: 0.1,
      UNKNOWN_MODE: 0.2
    };

    if (history.length < 5) return defaultDistribution;

    const last15 = history.slice(-15);
    const n = last15.length;

    // 1. Alternation / Chop detection
    let flips = 0;
    for (let i = 1; i < n; i++) {
      if (last15[i].size !== last15[i - 1].size) flips++;
    }
    const flipRate = flips / (n - 1);

    // 2. Current streak detection
    const lastSize = last15[n - 1].size;
    let streakLen = 1;
    for (let i = n - 2; i >= 0; i--) {
      if (last15[i].size === lastSize) streakLen++;
      else break;
    }

    // 3. Violet frequency
    const violetCount = last15.filter(r => r.color === 'VIOLET' || r.color === 'RED_VIOLET' || r.color === 'GREEN_VIOLET').length;
    const violetRate = violetCount / n;

    // 4. Raw scores
    let sStreak = streakLen >= 3 ? Math.min(1.0, 0.4 + streakLen * 0.15) : 0.05;
    let sChop = flipRate >= 0.65 ? Math.min(1.0, flipRate * 1.2) : 0.05;
    let sTrap = flipRate > 0.8 ? 0.7 : 0.05;
    let sViolet = violetRate > 0.2 ? Math.min(1.0, violetRate * 3) : 0.05;
    let sBaseFail = baseFailureStreak >= 3 ? Math.min(1.0, baseFailureStreak * 0.25) : 0.02;
    let sRandom = Math.abs(flipRate - 0.5) < 0.15 && streakLen <= 2 ? 0.4 : 0.1;
    let sCorrection = Math.abs(last15.filter(r => r.size === 'BIG').length / n - 0.5) > 0.3 ? 0.35 : 0.05;
    let sTransition = Math.abs(flipRate - 0.5) > 0.25 ? 0.2 : 0.05;
    let sUnknown = 0.05;

    const sum = sStreak + sChop + sTrap + sViolet + sBaseFail + sRandom + sCorrection + sTransition + sUnknown;

    return {
      STREAK_MODE: Number((sStreak / sum).toFixed(4)),
      CHOPPY_MODE: Number((sChop / sum).toFixed(4)),
      TRAP_MODE: Number((sTrap / sum).toFixed(4)),
      VIOLET_INTERRUPT_MODE: Number((sViolet / sum).toFixed(4)),
      CORRECTION_MODE: Number((sCorrection / sum).toFixed(4)),
      BASE_FAILURE_MODE: Number((sBaseFail / sum).toFixed(4)),
      SILENT_RANDOM_MODE: Number((sRandom / sum).toFixed(4)),
      TRANSITION_MODE: Number((sTransition / sum).toFixed(4)),
      UNKNOWN_MODE: Number((sUnknown / sum).toFixed(4))
    };
  }

  public getDominantRegime(distribution: Record<RegimeType, number>): { regime: RegimeType; probability: number } {
    let dominant: RegimeType = 'UNKNOWN_MODE';
    let maxProb = -1;
    for (const [k, v] of Object.entries(distribution)) {
      if (v > maxProb) {
        maxProb = v;
        dominant = k as RegimeType;
      }
    }
    return { regime: dominant, probability: maxProb };
  }
}

export const globalRegimeClassifier = new RegimeClassifier();
