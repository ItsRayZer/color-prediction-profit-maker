/**
 * Strategy Lab: Challenger Mutation, Shadow Testing & Promotion Validation
 * Enables autonomous candidate generation, shadow performance evaluation,
 * and evidence-based qualification for the Prediction Arena.
 */

import type { PredictionExpert, ExpertPrediction, ProcessedRound } from '../prediction/predictionTypes.ts';

export interface ShadowCandidate {
  id: string;
  name: string;
  parentExpertId: string;
  mutationType: 'WINDOW_TUNING' | 'THRESHOLD_SHIFT' | 'DECAY_MODULATION' | 'HYBRID_ENSEMBLE';
  parameters: Record<string, number | string>;
  roundsObserved: number;
  correctCount: number;
  accuracy: number;
  brierScore: number;
  activeStatus: 'INCUBATING' | 'QUALIFIED' | 'REJECTED' | 'PROMOTED';
  predictions: Array<{ roundId: string; predictedSide: 'BIG' | 'SMALL'; confidence: number; correct: boolean }>;
}

export class StrategyLab {
  private candidates: Map<string, ShadowCandidate> = new Map();
  private readonly MIN_OBSERVATION_ROUNDS = 25;
  private readonly PROMOTION_MARGIN = 0.04; // 4% performance margin over baseline

  constructor() {
    this.initializeDefaultCandidates();
  }

  private initializeDefaultCandidates(): void {
    // Seed 4 initial shadow variants
    this.registerCandidate({
      id: 'SHADOW_MARKOV_FAST',
      name: 'Shadow Markov (Fast Decay)',
      parentExpertId: 'MARKOV_TRANSITION',
      mutationType: 'DECAY_MODULATION',
      parameters: { decayRate: 0.85, windowSize: 15 },
      roundsObserved: 0,
      correctCount: 0,
      accuracy: 0.5,
      brierScore: 0.25,
      activeStatus: 'INCUBATING',
      predictions: []
    });

    this.registerCandidate({
      id: 'SHADOW_STREAK_SENSITIVE',
      name: 'Shadow Streak (Low Threshold)',
      parentExpertId: 'STREAK_RIDER',
      mutationType: 'THRESHOLD_SHIFT',
      parameters: { streakThreshold: 2, confidenceMultiplier: 1.2 },
      roundsObserved: 0,
      correctCount: 0,
      accuracy: 0.5,
      brierScore: 0.25,
      activeStatus: 'INCUBATING',
      predictions: []
    });

    this.registerCandidate({
      id: 'SHADOW_PATTERN_DEEP',
      name: 'Shadow Pattern DNA (Deep Memory)',
      parentExpertId: 'SUFFIX_PATTERN',
      mutationType: 'WINDOW_TUNING',
      parameters: { maxPatternLength: 8, minOccurrences: 3 },
      roundsObserved: 0,
      correctCount: 0,
      accuracy: 0.5,
      brierScore: 0.25,
      activeStatus: 'INCUBATING',
      predictions: []
    });

    this.registerCandidate({
      id: 'SHADOW_NEURAL_FAST_ADAPT',
      name: 'Shadow GRU (High Plasticity)',
      parentExpertId: 'GRU',
      mutationType: 'HYBRID_ENSEMBLE',
      parameters: { learningRate: 0.05, regularization: 0.001 },
      roundsObserved: 0,
      correctCount: 0,
      accuracy: 0.5,
      brierScore: 0.25,
      activeStatus: 'INCUBATING',
      predictions: []
    });
  }

  public registerCandidate(candidate: ShadowCandidate): void {
    this.candidates.set(candidate.id, candidate);
  }

  public getCandidate(id: string): ShadowCandidate | undefined {
    return this.candidates.get(id);
  }

  public getAllCandidates(): ShadowCandidate[] {
    return Array.from(this.candidates.values());
  }

  /**
   * Process a shadow round for all incubating candidates
   */
  public evaluateShadowRound(
    round: ProcessedRound,
    expertPredictions: Map<string, ExpertPrediction>,
    actualSide: 'BIG' | 'SMALL'
  ): void {
    for (const candidate of this.candidates.values()) {
      if (candidate.activeStatus === 'REJECTED') continue;

      // Generate shadow prediction based on parent or mutation
      const parentPred = expertPredictions.get(candidate.parentExpertId);
      let predictedSide: 'BIG' | 'SMALL' = 'BIG';
      let confidence = 0.55;

      if (parentPred) {
        predictedSide = parentPred.predictedSide;
        confidence = parentPred.confidence;

        // Apply mutation adjustments
        if (candidate.mutationType === 'THRESHOLD_SHIFT') {
          confidence = Math.min(0.95, Math.max(0.5, confidence * 1.05));
        } else if (candidate.mutationType === 'DECAY_MODULATION') {
          // Adjust prediction slightly toward recency
          const lastResult = round.actualSide;
          if (lastResult && Math.random() < 0.2) {
            predictedSide = lastResult;
          }
        }
      }

      const isCorrect = (predictedSide === actualSide);
      candidate.roundsObserved += 1;
      if (isCorrect) candidate.correctCount += 1;

      candidate.accuracy = candidate.correctCount / candidate.roundsObserved;

      // Compute Brier score
      const p = predictedSide === 'BIG' ? confidence : (1 - confidence);
      const actualVal = actualSide === 'BIG' ? 1 : 0;
      const brierInst = Math.pow(p - actualVal, 2);
      candidate.brierScore = (candidate.brierScore * (candidate.roundsObserved - 1) + brierInst) / candidate.roundsObserved;

      candidate.predictions.push({
        roundId: round.roundId,
        predictedSide,
        confidence,
        correct: isCorrect
      });

      if (candidate.predictions.length > 50) {
        candidate.predictions.shift();
      }

      // Check qualification status
      if (candidate.roundsObserved >= this.MIN_OBSERVATION_ROUNDS) {
        if (candidate.accuracy >= 0.55 && candidate.brierScore < 0.24) {
          candidate.activeStatus = 'QUALIFIED';
        } else if (candidate.accuracy < 0.42 && candidate.roundsObserved >= 40) {
          candidate.activeStatus = 'REJECTED';
        }
      }
    }
  }

  /**
   * Return candidates that have met qualification criteria
   */
  public getQualifiedCandidates(): ShadowCandidate[] {
    return Array.from(this.candidates.values()).filter(c => c.activeStatus === 'QUALIFIED');
  }

  /**
   * Mutate and create a child candidate from an existing top-performing expert
   */
  public spawnMutation(parentExpertId: string, parentName: string): ShadowCandidate {
    const timestamp = Date.now().toString(36);
    const id = `SHADOW_${parentExpertId}_MUT_${timestamp}`;
    const newCandidate: ShadowCandidate = {
      id,
      name: `Shadow ${parentName} Variant`,
      parentExpertId,
      mutationType: 'WINDOW_TUNING',
      parameters: {
        windowSize: Math.floor(10 + Math.random() * 30),
        decayFactor: Number((0.8 + Math.random() * 0.18).toFixed(2))
      },
      roundsObserved: 0,
      correctCount: 0,
      accuracy: 0.5,
      brierScore: 0.25,
      activeStatus: 'INCUBATING',
      predictions: []
    };

    this.registerCandidate(newCandidate);
    return newCandidate;
  }
}

export const globalStrategyLab = new StrategyLab();
