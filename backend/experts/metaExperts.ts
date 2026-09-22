/**
 * Meta Consensus Experts
 * Implements:
 * - NEURAL_CONSENSUS
 * - CLASSICAL_CONSENSUS
 * - MULTI_TIMEFRAME_CONSENSUS
 * - ADAPTIVE_ENSEMBLE
 */

import type { PredictionExpert, PredictionContext, ExpertPrediction } from '../prediction/predictionTypes.ts';
import { globalConsensusController } from '../prediction/consensusController.ts';
import { globalExpertRegistry } from '../arena/expertRegistry.ts';

function normalizeProb(p: number): { BIG: number; SMALL: number; RED: number; GREEN: number } {
  const bigP = Math.max(0.01, Math.min(0.99, Number(p.toFixed(4))));
  const smallP = Number((1.0 - bigP).toFixed(4));
  return { BIG: bigP, SMALL: smallP, RED: 0.5, GREEN: 0.5 };
}

export class NeuralConsensusExpert implements PredictionExpert {
  public readonly id = 'NEURAL_CONSENSUS';
  public readonly name = 'Neural Sub-Ensemble Consensus';
  public readonly version = '1.0.0';
  public readonly category = 'META' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const neuralExperts = globalExpertRegistry.getAll().filter(
      e => (e.category === 'NEURAL' || e.category === 'SPECIALIZED') && e.id !== this.id && e.enabled
    );

    const predictions: ExpertPrediction[] = [];
    const results = await Promise.allSettled(neuralExperts.map(e => e.predict(context)));
    for (const r of results) {
      if (r.status === 'fulfilled') predictions.push(r.value);
    }

    const consensus = globalConsensusController.calculateConsensus(predictions);
    return {
      expertId: this.id,
      prediction: consensus.prediction,
      probabilities: consensus.probabilities,
      confidence: consensus.confidence,
      evidence: consensus.evidence,
      sampleSize: predictions.length,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: { contributingModels: predictions.map(p => p.expertId), disagreement: consensus.disagreement }
    };
  }
}

export class ClassicalConsensusExpert implements PredictionExpert {
  public readonly id = 'CLASSICAL_CONSENSUS';
  public readonly name = 'Classical/Statistical Sub-Ensemble Consensus';
  public readonly version = '1.0.0';
  public readonly category = 'META' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const classicalExperts = globalExpertRegistry.getAll().filter(
      e => (e.category === 'CLASSICAL' || e.category === 'STATISTICAL') && e.id !== this.id && e.enabled
    );

    const predictions: ExpertPrediction[] = [];
    const results = await Promise.allSettled(classicalExperts.map(e => e.predict(context)));
    for (const r of results) {
      if (r.status === 'fulfilled') predictions.push(r.value);
    }

    const consensus = globalConsensusController.calculateConsensus(predictions);
    return {
      expertId: this.id,
      prediction: consensus.prediction,
      probabilities: consensus.probabilities,
      confidence: consensus.confidence,
      evidence: consensus.evidence,
      sampleSize: predictions.length,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: { contributingModels: predictions.map(p => p.expertId), disagreement: consensus.disagreement }
    };
  }
}

export class MultiTimeframeConsensusExpert implements PredictionExpert {
  public readonly id = 'MULTI_TIMEFRAME_CONSENSUS';
  public readonly name = 'Multi-Horizon Timeframe Consensus';
  public readonly version = '1.0.0';
  public readonly category = 'META' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const wMicro = hist.slice(-10);
    const wLocal = hist.slice(-30);
    const wMedium = hist.slice(-60);

    const fMicro = wMicro.length > 0 ? wMicro.filter(h => h.size === 'BIG').length / wMicro.length : 0.5;
    const fLocal = wLocal.length > 0 ? wLocal.filter(h => h.size === 'BIG').length / wLocal.length : 0.5;
    const fMedium = wMedium.length > 0 ? wMedium.filter(h => h.size === 'BIG').length / wMedium.length : 0.5;

    // Multi-timeframe agreement
    const weightedProb = fMicro * 0.5 + fLocal * 0.3 + fMedium * 0.2;
    const agreement = Math.abs(fMicro - fLocal) < 0.15 && Math.abs(fLocal - fMedium) < 0.15;

    const conf = agreement ? Math.max(weightedProb, 1 - weightedProb) + 0.05 : Math.max(weightedProb, 1 - weightedProb);
    const pred = weightedProb >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(weightedProb),
      confidence: Math.min(0.75, Math.max(0.51, conf)),
      evidence: agreement ? 0.8 : 0.4,
      sampleSize: hist.length,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: { fMicro, fLocal, fMedium, agreement }
    };
  }
}

export class AdaptiveEnsembleExpert implements PredictionExpert {
  public readonly id = 'ADAPTIVE_ENSEMBLE';
  public readonly name = 'Full Tournament Adaptive Ensemble';
  public readonly version = '1.0.0';
  public readonly category = 'META' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    // Run across all enabled non-meta experts
    const experts = globalExpertRegistry.getAll().filter(
      e => e.category !== 'META' && e.id !== this.id && e.enabled
    );

    const predictions: ExpertPrediction[] = [];
    const results = await Promise.allSettled(experts.map(e => e.predict(context)));
    for (const r of results) {
      if (r.status === 'fulfilled') predictions.push(r.value);
    }

    const consensus = globalConsensusController.calculateConsensus(predictions);
    return {
      expertId: this.id,
      prediction: consensus.prediction,
      probabilities: consensus.probabilities,
      confidence: consensus.confidence,
      evidence: consensus.evidence,
      sampleSize: predictions.length,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: { disagreement: consensus.disagreement, totalEvaluated: predictions.length }
    };
  }
}
