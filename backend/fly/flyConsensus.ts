/**
 * FLY_CONSENSUS Prediction Expert
 * Implements Section 47:
 * Combines independent Fly probabilities into an ensemble distribution.
 * Registered as an independent expert in the Global Arena.
 */

import type { PredictionExpert, PredictionContext, ExpertPrediction } from '../prediction/predictionTypes.ts';
import type { FlyPrediction, FlyMetrics } from './flyTypes.ts';

export class FlyConsensusExpert implements PredictionExpert {
  public readonly id = 'FLY_CONSENSUS';
  public readonly name = 'Fly Brain Multi-Model Consensus';
  public readonly version = '1.0.0';
  public readonly category = 'FLY' as const;
  public enabled = true;

  private lastFlyPredictions: FlyPrediction[] = [];

  public updateFlyPredictions(predictions: FlyPrediction[]): void {
    this.lastFlyPredictions = predictions;
  }

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const timestamp = Date.now();
    const preds = this.lastFlyPredictions;

    if (preds.length === 0) {
      return {
        expertId: this.id,
        prediction: 'BIG',
        probabilities: { BIG: 0.5, SMALL: 0.5, RED: 0.5, GREEN: 0.5 },
        confidence: 0.5,
        evidence: 0.1,
        sampleSize: 0,
        timestamp,
        modelVersion: this.version
      };
    }

    let weightedBig = 0;
    let totalWeight = 0;

    for (const p of preds) {
      const w = Math.max(0.1, p.confidence * p.evidence);
      const pBig = p.probabilities['BIG'] ?? 0.5;
      weightedBig += pBig * w;
      totalWeight += w;
    }

    const probBig = totalWeight > 0 ? weightedBig / totalWeight : 0.5;
    const probSmall = Number((1.0 - probBig).toFixed(4));
    const conf = Math.max(probBig, probSmall);
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: {
        BIG: Number(probBig.toFixed(4)),
        SMALL: probSmall,
        RED: 0.5,
        GREEN: 0.5
      },
      confidence: Number(conf.toFixed(4)),
      evidence: Number(Math.min(1.0, totalWeight / preds.length).toFixed(4)),
      sampleSize: preds.length,
      timestamp,
      modelVersion: this.version,
      metadata: { contributingFlyCount: preds.length }
    };
  }
}
