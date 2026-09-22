/**
 * World Model: Global State Synthesizer
 * Implements Section 20:
 * States:
 * - WORLD_STABLE
 * - WORLD_SHIFTING
 * - WORLD_TRAP_HEAVY
 * - WORLD_STREAK_HEAVY
 * - WORLD_VIOLET_HEAVY
 * - WORLD_BASE_LOGIC_BROKEN
 * - WORLD_UNKNOWN
 */

import { RegimeClassifier } from './regimeClassifier.ts';
import type { RegimeType } from './regimeClassifier.ts';
import type { RoundResult } from '../prediction/predictionTypes.ts';

export type WorldState =
  | 'WORLD_STABLE'
  | 'WORLD_SHIFTING'
  | 'WORLD_TRAP_HEAVY'
  | 'WORLD_STREAK_HEAVY'
  | 'WORLD_VIOLET_HEAVY'
  | 'WORLD_BASE_LOGIC_BROKEN'
  | 'WORLD_UNKNOWN';

export interface WorldModelAssessment {
  state: WorldState;
  confidence: number;
  regimeDistribution: Record<RegimeType, number>;
  stabilityScore: number;
  distributionDrift: number;
  entropy: number;
  baseFailureStreak: number;
}

export class WorldModel {
  private regimeClassifier = new RegimeClassifier();

  public assess(history: RoundResult[], baseFailureStreak = 0): WorldModelAssessment {
    if (history.length < 10) {
      return {
        state: 'WORLD_UNKNOWN',
        confidence: 0.5,
        regimeDistribution: this.regimeClassifier.classify(history, baseFailureStreak),
        stabilityScore: 0.5,
        distributionDrift: 0.0,
        entropy: 1.0,
        baseFailureStreak
      };
    }

    const regDist = this.regimeClassifier.classify(history, baseFailureStreak);
    const last20 = history.slice(-20);
    const bigs = last20.filter(r => r.size === 'BIG').length;
    const p = bigs / last20.length;
    const q = 1 - p;
    const entropy = (p === 0 || q === 0) ? 0 : -(p * Math.log2(p) + q * Math.log2(q));

    // Measure drift: compare last 10 with prior 10
    const last10 = history.slice(-10);
    const prior10 = history.slice(-20, -10);
    const pLast10 = last10.filter(r => r.size === 'BIG').length / 10;
    const pPrior10 = prior10.length > 0 ? prior10.filter(r => r.size === 'BIG').length / prior10.length : 0.5;
    const drift = Math.abs(pLast10 - pPrior10);

    let state: WorldState = 'WORLD_STABLE';
    let conf = 0.65;

    if (baseFailureStreak >= 4) {
      state = 'WORLD_BASE_LOGIC_BROKEN';
      conf = 0.85;
    } else if (regDist.TRAP_MODE > 0.35) {
      state = 'WORLD_TRAP_HEAVY';
      conf = regDist.TRAP_MODE * 1.5;
    } else if (regDist.STREAK_MODE > 0.4) {
      state = 'WORLD_STREAK_HEAVY';
      conf = regDist.STREAK_MODE * 1.4;
    } else if (regDist.VIOLET_INTERRUPT_MODE > 0.35) {
      state = 'WORLD_VIOLET_HEAVY';
      conf = regDist.VIOLET_INTERRUPT_MODE * 1.6;
    } else if (drift > 0.3 || regDist.TRANSITION_MODE > 0.25) {
      state = 'WORLD_SHIFTING';
      conf = Math.min(0.85, drift * 2);
    } else {
      state = 'WORLD_STABLE';
      conf = Math.max(0.6, 1 - drift);
    }

    const stabilityScore = Number(Math.max(0.1, Math.min(1.0, 1.0 - drift - regDist.UNKNOWN_MODE)).toFixed(4));

    return {
      state,
      confidence: Number(Math.min(0.99, conf).toFixed(4)),
      regimeDistribution: regDist,
      stabilityScore,
      distributionDrift: Number(drift.toFixed(4)),
      entropy: Number(entropy.toFixed(4)),
      baseFailureStreak
    };
  }
}

export const globalWorldModel = new WorldModel();
