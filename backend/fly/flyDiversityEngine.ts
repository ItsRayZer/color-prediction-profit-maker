/**
 * Fly Diversity Engine & Correlated Failure Detector
 * Implements Sections 48 & 49:
 * Measures pairwise prediction agreement, ensemble diversity, and detects correlated failure pairs.
 */

import type { FlyDiversityMetrics, FlyPrediction } from './flyTypes.ts';

export class FlyDiversityEngine {
  private historyOfPredictions: Array<{ roundId: string; preds: Record<string, string>; actual?: string }> = [];

  public recordRound(roundId: string, predictions: FlyPrediction[]): void {
    const map: Record<string, string> = {};
    for (const p of predictions) {
      map[p.flyModelId] = p.prediction;
    }
    this.historyOfPredictions.push({ roundId, preds: map });
    if (this.historyOfPredictions.length > 200) {
      this.historyOfPredictions.shift();
    }
  }

  public recordActual(roundId: string, actualResult: string): void {
    const item = this.historyOfPredictions.find(h => h.roundId === roundId);
    if (item) item.actual = actualResult;
  }

  public computeDiversityMetrics(modelIds: string[]): FlyDiversityMetrics {
    const matrix: Record<string, Record<string, number>> = {};
    const correlatedFailures: FlyDiversityMetrics['correlatedFailurePairs'] = [];
    const n = this.historyOfPredictions.length;

    for (const a of modelIds) {
      matrix[a] = {};
      for (const b of modelIds) {
        if (a === b) {
          matrix[a][b] = 1.0;
          continue;
        }

        let agreements = 0;
        let pairwiseFailures = 0;
        let totalSettled = 0;

        for (const rec of this.historyOfPredictions) {
          const predA = rec.preds[a];
          const predB = rec.preds[b];
          if (!predA || !predB) continue;

          if (predA === predB) agreements++;

          if (rec.actual) {
            totalSettled++;
            if (predA !== rec.actual && predB !== rec.actual) {
              pairwiseFailures++;
            }
          }
        }

        const agreeRate = n > 0 ? agreements / n : 0.5;
        matrix[a][b] = Number(agreeRate.toFixed(3));

        if (a < b && totalSettled >= 10) {
          const failureRate = pairwiseFailures / totalSettled;
          if (failureRate > 0.3) {
            correlatedFailures.push({
              modelA: a,
              modelB: b,
              correlatedFailureCount: pairwiseFailures,
              correlationCoefficient: Number(failureRate.toFixed(3))
            });
          }
        }
      }
    }

    // Average agreement across all distinct pairs
    let sumAgree = 0;
    let pairCount = 0;
    for (let i = 0; i < modelIds.length; i++) {
      for (let j = i + 1; j < modelIds.length; j++) {
        sumAgree += matrix[modelIds[i]][modelIds[j]] ?? 0.5;
        pairCount++;
      }
    }

    const avgAgreement = pairCount > 0 ? sumAgree / pairCount : 0.5;
    const diversityScore = Number((1.0 - Math.min(1.0, avgAgreement * 0.9)).toFixed(3));

    return {
      timestamp: Date.now(),
      pairwiseAgreementMatrix: matrix,
      averagePairwiseAgreement: Number(avgAgreement.toFixed(3)),
      effectiveDiversityScore: diversityScore,
      correlatedFailurePairs: correlatedFailures
    };
  }
}

export const globalFlyDiversityEngine = new FlyDiversityEngine();
