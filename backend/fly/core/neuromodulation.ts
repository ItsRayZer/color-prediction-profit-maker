/**
 * Neuromodulation Engine for Fly Brain Models
 * Implements Sections 18–25:
 * Computational analogues for dopamine-like reward signals, aversive signals,
 * novelty, arousal, and adaptive plasticity modulation.
 */

import type { NeuromodulationState, NeuromodulationMode } from '../flyTypes.ts';

export class NeuromodulationEngine {
  private expectedReward = 0.5;
  private state: NeuromodulationState;
  private baseLearningRate: number;

  constructor(baseLearningRate = 0.02) {
    this.baseLearningRate = baseLearningRate;
    this.state = {
      rewardSignal: 0.0,
      predictionError: 0.0,
      rewardPredictionError: 0.0,
      dopamineLikeSignal: 0.0,
      aversiveSignal: 0.0,
      noveltySignal: 0.0,
      arousalSignal: 0.0,
      plasticitySignal: 1.0,
      learningRateModifier: baseLearningRate,
      state: 'NORMAL'
    };
  }

  public getState(): NeuromodulationState {
    return { ...this.state };
  }

  public update(params: {
    wasCorrect: boolean;
    predictedProb: number;
    novelty: number;
    consecutiveLosses: number;
  }): NeuromodulationState {
    const { wasCorrect, predictedProb, novelty, consecutiveLosses } = params;

    // 1. Prediction error: cross-entropy / Brier distance
    const pActual = wasCorrect ? predictedProb : (1 - predictedProb);
    const predictionError = Number((1.0 - pActual).toFixed(4));

    // 2. Immediate reward signal: [-1.0, +1.0]
    // Scaled by confidence calibration
    let rawReward = wasCorrect ? (0.5 + predictedProb * 0.5) : (-0.5 - (1 - predictedProb) * 0.5);
    rawReward = Math.max(-1.0, Math.min(1.0, rawReward));

    // 3. Reward Prediction Error (RPE): actualReward - expectedReward
    const rpe = Number((rawReward - this.expectedReward).toFixed(4));
    // Update running expected reward estimate
    this.expectedReward = Number((this.expectedReward * 0.9 + rawReward * 0.1).toFixed(4));

    // 4. Dopamine-like reinforcement signal [-1.0, +1.0]
    // High when outcome is better than expected
    const dopamineLikeSignal = Number(Math.max(-1.0, Math.min(1.0, rpe)).toFixed(4));

    // 5. Aversive signal [0.0, 1.0]
    // Increases with large prediction errors and consecutive failures
    const aversive = !wasCorrect
      ? Math.min(1.0, predictionError * 0.7 + (consecutiveLosses * 0.1))
      : Math.max(0.0, this.state.aversiveSignal * 0.7);

    // 6. Arousal signal [0.0, 1.0]
    // Attention prioritization: high novelty or high error drives arousal
    const arousal = Number(Math.min(1.0, novelty * 0.5 + predictionError * 0.5).toFixed(4));

    // 7. Plasticity signal [0.1, 2.0]
    // Dynamic multiplier for weight updates: clamped within safe bounds
    let plasticity = 1.0 + (novelty * 0.4) + (predictionError * 0.4) - (consecutiveLosses > 3 ? 0.4 : 0);
    plasticity = Number(Math.max(0.2, Math.min(1.8, plasticity)).toFixed(4));

    // 8. Determine computational mode
    let mode: NeuromodulationMode = 'NORMAL';
    if (consecutiveLosses >= 4) {
      mode = 'RECOVERING';
    } else if (novelty > 0.7) {
      mode = 'EXPLORING';
    } else if (arousal > 0.65 && !wasCorrect) {
      mode = 'CORRECTING';
    } else if (dopamineLikeSignal > 0.3) {
      mode = 'REINFORCING';
    } else if (consecutiveLosses >= 2) {
      mode = 'CAUTIOUS';
    }

    const learningRateModifier = Number((this.baseLearningRate * plasticity).toFixed(5));

    this.state = {
      rewardSignal: Number(rawReward.toFixed(4)),
      predictionError,
      rewardPredictionError: rpe,
      dopamineLikeSignal,
      aversiveSignal: Number(aversive.toFixed(4)),
      noveltySignal: Number(novelty.toFixed(4)),
      arousalSignal: arousal,
      plasticitySignal: plasticity,
      learningRateModifier,
      state: mode
    };

    return this.state;
  }
}
