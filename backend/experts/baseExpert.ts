/**
 * BASE_PREDICTOR: Wraps existing production QuantAlgorithm without modifying
 * any of its internal algorithms or prediction logic.
 */

import type { PredictionExpert, PredictionContext, ExpertPrediction } from '../prediction/predictionTypes.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Ensure QuantAlgorithm is loaded in Node environment
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const quantAlgoPath = path.resolve(__dirname, '../../algorithms/quant_algorithm.js');

let quantAlgorithmLoaded = false;

async function ensureQuantAlgorithmLoaded() {
  if (quantAlgorithmLoaded && (globalThis as any).QuantAlgorithm) {
    return (globalThis as any).QuantAlgorithm;
  }
  try {
    await import(`file://${quantAlgoPath}`);
    quantAlgorithmLoaded = true;
  } catch (err) {
    console.warn('[BaseExpert] Warning importing quant_algorithm.js:', err);
  }
  return (globalThis as any).QuantAlgorithm;
}

export class BaseExpert implements PredictionExpert {
  public readonly id = 'BASE_PREDICTOR';
  public readonly name = 'Production Quant Engine (Base)';
  public readonly version = '1.0.0-legacy-wrapped';
  public readonly category = 'BASE' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const quantAlgo = await ensureQuantAlgorithmLoaded();
    const timestamp = Date.now();

    if (!quantAlgo || typeof quantAlgo.predictNextBet !== 'function') {
      // Graceful fallback if QuantAlgorithm is unavailable
      const last = context.history.length > 0 ? context.history[context.history.length - 1] : null;
      const pred = last ? (last.size === 'BIG' ? 'SMALL' : 'BIG') : 'BIG';
      return {
        expertId: this.id,
        prediction: pred,
        probabilities: {
          BIG: pred === 'BIG' ? 0.55 : 0.45,
          SMALL: pred === 'SMALL' ? 0.55 : 0.45,
          RED: 0.5,
          GREEN: 0.5
        },
        confidence: 0.55,
        evidence: 0.3,
        sampleSize: context.history.length,
        timestamp,
        modelVersion: this.version,
        metadata: { reason: 'Fallback BasePredictor' }
      };
    }

    try {
      const outcome = quantAlgo.predictNextBet({
        history: context.history,
        balance: context.balance ?? 1000,
        lossStreak: context.lossStreak ?? 0,
        winStreak: context.winStreak ?? 0,
        timeframe: context.timeframe || '30s'
      });

      const target = outcome.target || 'BIG';
      const prob = typeof outcome.prob === 'number' ? Math.max(0.01, Math.min(0.99, outcome.prob)) : 0.55;

      let probabilities: Record<string, number> = {};
      if (['BIG', 'SMALL'].includes(target)) {
        probabilities = {
          BIG: target === 'BIG' ? prob : Number((1 - prob).toFixed(4)),
          SMALL: target === 'SMALL' ? prob : Number((1 - prob).toFixed(4)),
          RED: 0.5,
          GREEN: 0.5
        };
      } else if (['RED', 'GREEN'].includes(target)) {
        probabilities = {
          RED: target === 'RED' ? prob : Number((1 - prob).toFixed(4)),
          GREEN: target === 'GREEN' ? prob : Number((1 - prob).toFixed(4)),
          BIG: 0.5,
          SMALL: 0.5
        };
      } else {
        probabilities = { BIG: 0.5, SMALL: 0.5, RED: 0.5, GREEN: 0.5 };
      }

      return {
        expertId: this.id,
        prediction: target,
        probabilities,
        confidence: prob,
        evidence: Math.min(1.0, (((context?.history?.length ?? 0) / 50) * prob)),
        sampleSize: context?.history?.length ?? 0,
        regime: outcome.regime || 'UNKNOWN',
        timestamp,
        modelVersion: this.version,
        metadata: {
          decision: outcome.decision || 'BET',
          engines: outcome.engines || [],
          reason: outcome.reason,
          scores: outcome.scores,
          rawOutcome: outcome
        }
      };
    } catch (err: any) {
      console.warn('[BaseExpert] Error in QuantAlgorithm execution:', err);
      const fallbackPred = 'BIG';
      return {
        expertId: this.id,
        prediction: fallbackPred,
        probabilities: { BIG: 0.51, SMALL: 0.49 },
        confidence: 0.51,
        evidence: 0.2,
        sampleSize: context?.history?.length ?? 0,
        timestamp,
        modelVersion: this.version,
        metadata: { error: err?.message || String(err) }
      };
    }
  }
}
