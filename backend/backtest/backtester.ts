/**
 * Walk-Forward Backtester Engine
 * Evaluates prediction models with zero future leakage, benchmark baselines,
 * calibration (ECE), and Fisher-Yates shuffled-history statistical controls.
 */

import type { PredictionExpert, ProcessedRound, ExpertPrediction, PredictionContext } from '../prediction/predictionTypes.ts';

export interface BacktestMetrics {
  totalRounds: number;
  correctRounds: number;
  accuracy: number;
  logLoss: number;
  brierScore: number;
  expectedCalibrationError: number;
  maxWinStreak: number;
  maxLossStreak: number;
  streakTransitions: number;
}

export interface BacktestResult {
  expertId: string;
  name: string;
  metrics: BacktestMetrics;
  baselineComparison: {
    alwaysBigAccuracy: number;
    alwaysSmallAccuracy: number;
    randomAccuracy: number;
    shuffledControlAccuracy: number;
    outperformedShuffled: boolean;
  };
}

export class WalkForwardBacktester {
  /**
   * Run backtest on an expert over historical rounds with strict walk-forward discipline.
   */
  public static async evaluateExpert(
    expert: PredictionExpert,
    historicalRounds: ProcessedRound[],
    warmupRounds: number = 30
  ): Promise<BacktestResult> {
    if (historicalRounds.length <= warmupRounds) {
      throw new Error(`Insufficient historical rounds (${historicalRounds.length}) for warmup ${warmupRounds}`);
    }

    const testRounds = historicalRounds.slice(warmupRounds);
    const predictions: Array<{ pred: ExpertPrediction; actual: 'BIG' | 'SMALL' }> = [];

    let currentWinStreak = 0;
    let maxWinStreak = 0;
    let currentLossStreak = 0;
    let maxLossStreak = 0;
    let streakTransitions = 0;
    let lastCorrect: boolean | null = null;

    let alwaysBigCorrect = 0;
    let alwaysSmallCorrect = 0;

    for (let i = warmupRounds; i < historicalRounds.length; i++) {
      const pastContext = historicalRounds.slice(0, i);
      const targetRound = historicalRounds[i];
      const actualSide = targetRound.actualSide;

      if (!actualSide) continue;

      // Baselines
      if (actualSide === 'BIG') alwaysBigCorrect++;
      if (actualSide === 'SMALL') alwaysSmallCorrect++;

      // Strict Zero-Leakage: expert receives ONLY pastContext via PredictionContext
      const predContext: PredictionContext = {
        roundId: targetRound.roundId,
        period: targetRound.period || targetRound.roundId,
        history: pastContext.map(r => ({
          size: r.actualSide || 'BIG',
          color: r.actualColor || 'GREEN',
          number: r.actualNumber || 5
        })),
        timestamp: targetRound.timestamp || Date.now()
      };

      const pred = await expert.predict(predContext);
      predictions.push({ pred, actual: actualSide });

      const isCorrect = pred.prediction === actualSide;

      // Update streaks
      if (isCorrect) {
        currentWinStreak++;
        if (currentWinStreak > maxWinStreak) maxWinStreak = currentWinStreak;
        if (currentLossStreak > 0) {
          streakTransitions++;
          currentLossStreak = 0;
        }
      } else {
        currentLossStreak++;
        if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
        if (currentWinStreak > 0) {
          streakTransitions++;
          currentWinStreak = 0;
        }
      }

      lastCorrect = isCorrect;
    }

    const totalRounds = predictions.length;
    const correctRounds = predictions.filter(p => p.pred.prediction === p.actual).length;
    const accuracy = totalRounds > 0 ? correctRounds / totalRounds : 0;

    // Log loss and Brier score
    let totalLogLoss = 0;
    let totalBrier = 0;
    const bins: Array<{ sumConfidence: number; correctCount: number; total: number }> = Array.from(
      { length: 10 },
      () => ({ sumConfidence: 0, correctCount: 0, total: 0 })
    );

    for (const item of predictions) {
      const pBig = Math.min(0.99, Math.max(0.01, item.pred.probabilities.BIG));
      const yBig = item.actual === 'BIG' ? 1 : 0;

      // Log Loss
      const loss = -(yBig * Math.log(pBig) + (1 - yBig) * Math.log(1 - pBig));
      totalLogLoss += loss;

      // Brier Score
      totalBrier += Math.pow(pBig - yBig, 2);

      // Calibration Binning (by assigned probability)
      const binIdx = Math.min(9, Math.floor(item.pred.confidence * 10));
      bins[binIdx].sumConfidence += item.pred.confidence;
      bins[binIdx].total += 1;
      if (item.pred.prediction === item.actual) {
        bins[binIdx].correctCount += 1;
      }
    }

    const logLoss = totalRounds > 0 ? totalLogLoss / totalRounds : 0;
    const brierScore = totalRounds > 0 ? totalBrier / totalRounds : 0;

    // Expected Calibration Error (ECE)
    let ece = 0;
    for (const bin of bins) {
      if (bin.total > 0) {
        const avgConfidence = bin.sumConfidence / bin.total;
        const avgAccuracy = bin.correctCount / bin.total;
        ece += (bin.total / totalRounds) * Math.abs(avgAccuracy - avgConfidence);
      }
    }

    // Shuffled-history null hypothesis control
    const shuffledControlAccuracy = this.runShuffledControl(predictions);

    return {
      expertId: expert.id,
      name: expert.name,
      metrics: {
        totalRounds,
        correctRounds,
        accuracy,
        logLoss,
        brierScore,
        expectedCalibrationError: ece,
        maxWinStreak,
        maxLossStreak,
        streakTransitions
      },
      baselineComparison: {
        alwaysBigAccuracy: totalRounds > 0 ? alwaysBigCorrect / totalRounds : 0,
        alwaysSmallAccuracy: totalRounds > 0 ? alwaysSmallCorrect / totalRounds : 0,
        randomAccuracy: 0.5,
        shuffledControlAccuracy,
        outperformedShuffled: accuracy > shuffledControlAccuracy
      }
    };
  }

  /**
   * Run Fisher-Yates shuffled control to test significance against random sequence permutation
   */
  private static runShuffledControl(
    originalPredictions: Array<{ pred: ExpertPrediction; actual: 'BIG' | 'SMALL' }>
  ): number {
    const shuffledActuals = originalPredictions.map(p => p.actual);
    for (let i = shuffledActuals.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = shuffledActuals[i];
      shuffledActuals[i] = shuffledActuals[j];
      shuffledActuals[j] = temp;
    }

    let correct = 0;
    for (let i = 0; i < originalPredictions.length; i++) {
      if (originalPredictions[i].pred.prediction === shuffledActuals[i]) {
        correct++;
      }
    }

    return originalPredictions.length > 0 ? correct / originalPredictions.length : 0;
  }
}
