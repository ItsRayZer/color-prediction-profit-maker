/**
 * Prediction Autopsy System
 * Implements Section 35:
 * Performs rigorous post-round diagnostic autopsy on every resolved round.
 */

import type { PredictionAutopsy, ExpertPrediction, RoundResult } from '../prediction/predictionTypes.ts';

export class AutopsyEngine {
  private autopsies: PredictionAutopsy[] = [];
  private maxStored = 500;

  public runAutopsy(params: {
    roundId: string;
    actualResult: RoundResult;
    expertPredictions: ExpertPrediction[];
    activeChampionId: string;
    dominantRegime: string;
    poisonedPatternsFound: string[];
    dangerScore: number;
  }): PredictionAutopsy {
    const {
      roundId,
      actualResult,
      expertPredictions,
      activeChampionId,
      dominantRegime,
      poisonedPatternsFound,
      dangerScore
    } = params;

    const actualSize = actualResult.size;
    const expertResults: PredictionAutopsy['expertPredictions'] = {};

    let activeWasCorrect = false;
    let correctCount = 0;

    for (const pred of expertPredictions) {
      const isCorrect = pred.prediction === actualSize;
      if (pred.expertId === activeChampionId) {
        activeWasCorrect = isCorrect;
      }
      if (isCorrect) correctCount++;

      const pActual = pred.probabilities[actualSize] ?? 0.5;
      const brier = Number(Math.pow(1 - pActual, 2).toFixed(4));
      const logLoss = Number((-Math.log(Math.max(0.001, pActual))).toFixed(4));

      expertResults[pred.expertId] = {
        prediction: pred.prediction,
        probabilities: pred.probabilities,
        confidence: pred.confidence,
        wasCorrect: isCorrect,
        brier,
        logLoss
      };
    }

    const consensusFailed = correctCount < expertPredictions.length / 2;
    const championDegraded = !activeWasCorrect;

    // Diagnostic categorization
    let mistakeType: string | undefined;
    let cause: string | undefined;
    let repair: string | undefined;

    if (!activeWasCorrect) {
      if (poisonedPatternsFound.length > 0) {
        mistakeType = 'POISONED_PATTERN_FAILURE';
        cause = `Active champion relied on decaying pattern: ${poisonedPatternsFound.join(', ')}`;
        repair = 'Demote pattern weight and increase pattern poison score.';
      } else if (dangerScore > 0.6) {
        mistakeType = 'REGIME_INSTABILITY_SHOCK';
        cause = `God's Eye danger score was elevated (${dangerScore}). Sudden distribution shift.`;
        repair = 'Increase consensus uncertainty factor and lower champion promotion margin.';
      } else if (consensusFailed) {
        mistakeType = 'MAJORITY_CONSENSUS_FAILURE';
        cause = `Global consensus predicted contrary to outcome (${correctCount}/${expertPredictions.length} correct).`;
        repair = 'Elevate contrarian and inversion models in challenger pool.';
      } else {
        mistakeType = 'CALIBRATION_VARIANCE';
        cause = 'Normal probabilistic variance within calibrated confidence bounds.';
        repair = 'Log sample to replay buffer for walk-forward validation.';
      }
    }

    const autopsy: PredictionAutopsy = {
      predictionId: `autopsy_${roundId}_${Date.now()}`,
      roundId,
      actualResult,
      expertPredictions: expertResults,
      activeExpert: activeChampionId,
      activeWasCorrect,
      mistakeType,
      cause,
      repair,
      championDegraded,
      consensusFailed,
      regimeMismatch: dominantRegime === 'UNKNOWN_MODE',
      timestamp: Date.now()
    };

    this.autopsies.push(autopsy);
    if (this.autopsies.length > this.maxStored) {
      this.autopsies.shift();
    }

    return autopsy;
  }

  public getRecent(n = 20): PredictionAutopsy[] {
    return this.autopsies.slice(-n);
  }

  public getByRoundId(roundId: string): PredictionAutopsy | undefined {
    return this.autopsies.find(a => a.roundId === roundId);
  }
}

export const globalAutopsyEngine = new AutopsyEngine();
