/**
 * Consensus Controller & Evidence Aggregator
 * Implements Section 22:
 * effectiveWeight = baseWeight * recentAccuracyFactor * calibrationFactor * regimeCompatibility * sampleReliability * healthFactor * stabilityFactor
 */

import type { ExpertPrediction, ExpertMetrics, ExpertHealth, RoundResult } from './predictionTypes.ts';

export interface ConsensusResult {
  prediction: string;
  probabilities: Record<string, number>;
  confidence: number;
  evidence: number;
  disagreement: number; // [0, 1] 0 = complete unanimity, 1 = maximum disagreement
  contributingExpertsCount: number;
  weights: Record<string, number>;
}

export class ConsensusController {
  public calculateConsensus(
    predictions: ExpertPrediction[],
    metricsMap: Map<string, ExpertMetrics> = new Map(),
    healthMap: Map<string, ExpertHealth> = new Map(),
    currentRegime = 'UNKNOWN_MODE'
  ): ConsensusResult {
    if (predictions.length === 0) {
      return {
        prediction: 'BIG',
        probabilities: { BIG: 0.5, SMALL: 0.5, RED: 0.5, GREEN: 0.5 },
        confidence: 0.5,
        evidence: 0.0,
        disagreement: 0.5,
        contributingExpertsCount: 0,
        weights: {}
      };
    }

    const weights: Record<string, number> = {};
    let totalWeight = 0;
    let weightedBig = 0;
    let weightedSmall = 0;
    let weightedRed = 0;
    let weightedGreen = 0;

    for (const pred of predictions) {
      const metric = metricsMap.get(pred.expertId);
      const health = healthMap.get(pred.expertId);

      // Factors default to neutral (1.0)
      const baseWeight = 1.0;
      const recentAccuracy = metric ? Math.max(0.2, metric.windows.last20.accuracy || 0.5) : 0.5;
      const recentAccuracyFactor = recentAccuracy * 2; // 0.5 -> 1.0, 0.7 -> 1.4

      const calibration = metric ? Math.max(0.1, metric.calibrationScore || 0.8) : 0.8;
      const calibrationFactor = calibration;

      const regimeComp = metric ? Math.max(0.2, metric.regimeScore || 1.0) : 1.0;
      const regimeCompatibility = regimeComp;

      const sampleCount = pred.sampleSize ?? 10;
      const sampleReliability = Math.min(1.0, sampleCount / 20);

      const healthStatus = health?.status || 'HEALTHY';
      const healthFactor = healthStatus === 'HEALTHY' ? 1.0 :
                           healthStatus === 'DEGRADED' ? 0.6 :
                           healthStatus === 'RECOVERING' ? 0.4 :
                           healthStatus === 'UNTRUSTED' ? 0.1 : 0.0;

      const stabilityFactor = metric ? Math.max(0.2, metric.stabilityScore || 0.8) : 0.8;

      const effectiveWeight = Math.max(
        0.01,
        baseWeight *
        recentAccuracyFactor *
        calibrationFactor *
        regimeCompatibility *
        sampleReliability *
        healthFactor *
        stabilityFactor
      );

      weights[pred.expertId] = Number(effectiveWeight.toFixed(4));
      totalWeight += effectiveWeight;

      const pBig = pred.probabilities['BIG'] ?? 0.5;
      const pSmall = pred.probabilities['SMALL'] ?? (1 - pBig);
      const pRed = pred.probabilities['RED'] ?? 0.5;
      const pGreen = pred.probabilities['GREEN'] ?? 0.5;

      weightedBig += pBig * effectiveWeight;
      weightedSmall += pSmall * effectiveWeight;
      weightedRed += pRed * effectiveWeight;
      weightedGreen += pGreen * effectiveWeight;
    }

    const finalBig = totalWeight > 0 ? weightedBig / totalWeight : 0.5;
    const finalSmall = totalWeight > 0 ? weightedSmall / totalWeight : 0.5;
    const finalRed = totalWeight > 0 ? weightedRed / totalWeight : 0.5;
    const finalGreen = totalWeight > 0 ? weightedGreen / totalWeight : 0.5;

    // Disagreement metric: variance of predicted probabilities across experts
    let sumVariance = 0;
    for (const pred of predictions) {
      const pBig = pred.probabilities['BIG'] ?? 0.5;
      sumVariance += Math.pow(pBig - finalBig, 2);
    }
    const variance = predictions.length > 0 ? sumVariance / predictions.length : 0;
    // Maximum variance for probabilities is 0.25 (half 1.0, half 0.0) -> normalize to [0, 1]
    const disagreement = Math.min(1.0, Math.sqrt(variance) * 2);

    // Uncertainty increases with disagreement
    const rawConf = Math.max(finalBig, finalSmall);
    const confidence = Number(Math.max(0.51, rawConf * (1 - disagreement * 0.25)).toFixed(4));
    const finalPrediction = finalBig >= finalSmall ? 'BIG' : 'SMALL';

    return {
      prediction: finalPrediction,
      probabilities: {
        BIG: Number(finalBig.toFixed(4)),
        SMALL: Number(finalSmall.toFixed(4)),
        RED: Number(finalRed.toFixed(4)),
        GREEN: Number(finalGreen.toFixed(4))
      },
      confidence,
      evidence: Number(Math.min(1.0, (totalWeight / predictions.length) * (1 - disagreement * 0.5)).toFixed(4)),
      disagreement: Number(disagreement.toFixed(4)),
      contributingExpertsCount: predictions.length,
      weights
    };
  }
}

export const globalConsensusController = new ConsensusController();
