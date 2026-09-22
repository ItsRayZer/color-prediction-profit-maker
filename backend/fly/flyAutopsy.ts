/**
 * Independent Fly Autopsy Engine
 * Implements Section 70:
 * Evaluates individual Fly model predictions, feature contributions, neuromodulatory responses,
 * and prescribes model repairs.
 */

import type { FlyAutopsy, FlyPrediction, FlyExperience } from './flyTypes.ts';

export class FlyAutopsyEngine {
  private autopsies: FlyAutopsy[] = [];
  private maxCapacity = 500;

  public runAutopsy(
    roundId: string,
    prediction: FlyPrediction,
    actualResult: string,
    novelty: number
  ): FlyAutopsy {
    const isCorrect = prediction.prediction === actualResult;
    const pPredicted = prediction.probabilities[actualResult] ?? 0.5;
    const predictionError = Number((1.0 - pPredicted).toFixed(4));
    const wasOverconfident = !isCorrect && prediction.confidence > 0.70;

    const nState = prediction.neuromodulationState;
    let repair: string | undefined;

    if (!isCorrect) {
      if (wasOverconfident) {
        repair = 'DAMPEN_READOUT_CONFIDENCE: Recalibrate temperature scaling and lower learning rate.';
      } else if (novelty > 0.7) {
        repair = 'EXPLORATION_ADAPTATION: Update prioritized replay buffer with high-novelty sample.';
      } else if (nState.aversiveSignal > 0.6) {
        repair = 'STABILIZE_RESERVOIR: Transient negative reinforcement active. Clamp plasticity.';
      } else {
        repair = 'ROUTINE_ONLINE_CORRECTION: Standard stochastic gradient step applied.';
      }
    }

    const autopsy: FlyAutopsy = {
      autopsyId: `fly_autopsy_${roundId}_${prediction.flyModelId}_${Date.now()}`,
      roundId,
      flyModelId: prediction.flyModelId,
      predicted: prediction.prediction,
      actual: actualResult,
      predictionError,
      rewardPredictionError: nState.rewardPredictionError,
      dopamineSignal: nState.dopamineLikeSignal,
      aversiveSignal: nState.aversiveSignal,
      dominantFeatureGroup: 'TEMPORAL_SEQUENCE',
      stateNovelty: novelty,
      wasOverconfident,
      recommendedRepair: repair,
      timestamp: Date.now()
    };

    this.autopsies.push(autopsy);
    if (this.autopsies.length > this.maxCapacity) {
      this.autopsies.shift();
    }

    return autopsy;
  }

  public getRecent(n = 30): FlyAutopsy[] {
    return this.autopsies.slice(-n);
  }

  public getByModelId(modelId: string, n = 20): FlyAutopsy[] {
    return this.autopsies.filter(a => a.flyModelId === modelId).slice(-n);
  }
}

export const globalFlyAutopsyEngine = new FlyAutopsyEngine();
