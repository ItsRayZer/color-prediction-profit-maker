/**
 * FUTURE_STATE_ENGINE: Probabilistic Next-State Simulator
 * Implements Section 24:
 * Generates candidate multi-step trajectories (A, B, C, D) with Markov, sequence, and regime probabilities.
 */

import type { RoundResult } from '../prediction/predictionTypes.ts';

export interface SimulatedTrajectory {
  id: 'TRAJECTORY_A' | 'TRAJECTORY_B' | 'TRAJECTORY_C' | 'TRAJECTORY_D';
  description: string;
  stepSequence: Array<{ size: 'BIG' | 'SMALL'; prob: number }>;
  pathProbability: number;
  expectedRegime: string;
}

export class FutureStateEngine {
  public simulate(
    history: RoundResult[],
    dominantRegime = 'UNKNOWN_MODE',
    currentMarkovProbBig = 0.5
  ): SimulatedTrajectory[] {
    const pBig = Math.max(0.1, Math.min(0.9, currentMarkovProbBig));
    const pSmall = 1 - pBig;

    // Trajectory A: Immediate continuation of dominant trend for 3 rounds
    const isBigFavored = pBig >= 0.5;
    const trajA: SimulatedTrajectory = {
      id: 'TRAJECTORY_A',
      description: isBigFavored ? 'Persistent Big Sequence (3R)' : 'Persistent Small Sequence (3R)',
      stepSequence: [
        { size: isBigFavored ? 'BIG' : 'SMALL', prob: Math.max(pBig, pSmall) },
        { size: isBigFavored ? 'BIG' : 'SMALL', prob: 0.58 },
        { size: isBigFavored ? 'BIG' : 'SMALL', prob: 0.54 }
      ],
      pathProbability: Number((Math.max(pBig, pSmall) * 0.58 * 0.54).toFixed(4)),
      expectedRegime: 'STREAK_MODE'
    };

    // Trajectory B: Immediate reversal followed by chop
    const trajB: SimulatedTrajectory = {
      id: 'TRAJECTORY_B',
      description: 'Immediate Reversal into Alternating Chop',
      stepSequence: [
        { size: isBigFavored ? 'SMALL' : 'BIG', prob: Math.min(pBig, pSmall) },
        { size: isBigFavored ? 'BIG' : 'SMALL', prob: 0.62 },
        { size: isBigFavored ? 'SMALL' : 'BIG', prob: 0.60 }
      ],
      pathProbability: Number((Math.min(pBig, pSmall) * 0.62 * 0.60).toFixed(4)),
      expectedRegime: 'CHOPPY_MODE'
    };

    // Trajectory C: 2-2 Double Pattern (B-B-S-S or S-S-B-B)
    const trajC: SimulatedTrajectory = {
      id: 'TRAJECTORY_C',
      description: 'Two-Two Pattern Bridge',
      stepSequence: [
        { size: isBigFavored ? 'BIG' : 'SMALL', prob: Math.max(pBig, pSmall) },
        { size: isBigFavored ? 'SMALL' : 'BIG', prob: 0.52 },
        { size: isBigFavored ? 'SMALL' : 'BIG', prob: 0.56 }
      ],
      pathProbability: Number((Math.max(pBig, pSmall) * 0.52 * 0.56).toFixed(4)),
      expectedRegime: 'TRANSITION_MODE'
    };

    // Trajectory D: Mean-reverting collapse to baseline
    const trajD: SimulatedTrajectory = {
      id: 'TRAJECTORY_D',
      description: 'Noise / Pure Equilibrium Drift',
      stepSequence: [
        { size: 'BIG', prob: 0.5 },
        { size: 'SMALL', prob: 0.5 },
        { size: 'BIG', prob: 0.5 }
      ],
      pathProbability: 0.125,
      expectedRegime: 'SILENT_RANDOM_MODE'
    };

    return [trajA, trajB, trajC, trajD];
  }
}

export const globalFutureStateEngine = new FutureStateEngine();
