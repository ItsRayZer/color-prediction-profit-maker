/**
 * Fly Brain Master System Types & Interfaces
 * Implements Sections 8, 15, 18, 33, 42, 48, 52 of Fly Master System Prompt.
 */

import type { PredictionContext } from '../prediction/predictionTypes.ts';

export type FlyModelStatus = 'ACTIVE' | 'SHADOW' | 'RESEARCH' | 'DISABLED';

export type ExecutionMode = 'PRODUCTION_COMPACT' | 'SHADOW' | 'RESEARCH';

export interface ExecutionPolicy {
  timeoutMs: number;
  maxMemoryMb: number;
  maxBatchSize: number;
  mode: ExecutionMode;
}

export interface FlyInstance {
  modelId: string;
  privateReservoirState: Float32Array;
  privateMemory: any;
  privateReadout: any;
  privateCalibration: any;
  privateHealth: FlyHealth;
  privateNeuromodulation: NeuromodulationState;
  executionPolicy: ExecutionPolicy;
}

export type NeuromodulationMode =
  | 'NORMAL'
  | 'REINFORCING'
  | 'CORRECTING'
  | 'EXPLORING'
  | 'RECOVERING'
  | 'CAUTIOUS';

export interface NeuromodulationState {
  rewardSignal: number;              // [-1.0, +1.0]
  predictionError: number;           // [0.0, 1.0] (cross-entropy/Brier based)
  rewardPredictionError: number;     // [-1.0, +1.0] (actualReward - expectedReward)
  dopamineLikeSignal: number;        // [-1.0, +1.0] (computational reinforcement)
  aversiveSignal: number;            // [0.0, 1.0] (calibration penalty)
  noveltySignal: number;             // [0.0, 1.0] (state divergence)
  arousalSignal: number;             // [0.0, 1.0] (computational attention/priority)
  plasticitySignal: number;          // [0.1, 2.0] (learning rate multiplier)
  learningRateModifier: number;      // Scaled effective learning rate
  state: NeuromodulationMode;
}

export type FlyHealthStatus = 'HEALTHY' | 'DEGRADED' | 'RECOVERING' | 'UNTRUSTED' | 'DISABLED';

export interface FlyHealth {
  status: FlyHealthStatus;
  latencyMs: number;
  errorRate: number;
  calibration: number;
  stability: number;
  reservoirHealth: number;          // [0.0, 1.0]
  neuromodulationHealth: number;    // [0.0, 1.0]
  firingRate: number;
  deadNeuronsPct: number;
  saturatedNeuronsPct: number;
}

export interface FlyPrediction {
  flyModelId: string;
  prediction: string;                // e.g. 'BIG' or 'SMALL'
  probabilities: Record<string, number>; // Complete distribution: { BIG: 0.63, SMALL: 0.37, RED: 0.5, GREEN: 0.5 }
  confidence: number;
  evidence: number;
  novelty: number;
  regime?: string;
  neuromodulationState: NeuromodulationState;
  timestamp: number;
  modelVersion: string;
  metadata?: Record<string, unknown>;
}

export interface FlyExperience {
  stateHash: string;
  inputFeatures: Record<string, number>;
  reservoirStateHash: string;
  prediction: string;
  probabilities: Record<string, number>;
  actualResult: string;
  predictionError: number;
  rewardSignal: number;
  rewardPredictionError: number;
  aversiveSignal: number;
  noveltySignal: number;
  arousalSignal: number;
  regime: string;
  timestamp: number;
}

export interface FlyPerformanceWindow {
  windowSize: number | 'ALL';
  totalEvaluated: number;
  correctCount: number;
  wrongCount: number;
  accuracy: number;
  winRate: number;
  logLoss: number;
  brierScore: number;
  calibration: number;
  currentStreak: number;
  maxWinStreak: number;
  maxLossStreak: number;
  stability: number;
}

export interface FlyMetrics {
  flyModelId: string;
  rank: number;
  previousRank: number;
  score: number;
  fastScore: number;
  mediumScore: number;
  longScore: number;
  calibrationScore: number;
  stabilityScore: number;
  regimeScore: number;
  diversityContribution: number;
  windows: {
    last10: FlyPerformanceWindow;
    last20: FlyPerformanceWindow;
    last50: FlyPerformanceWindow;
    last100: FlyPerformanceWindow;
    allTime: FlyPerformanceWindow;
  };
  health: FlyHealth;
  lastUpdatedTimestamp: number;
}

export interface FlyModel {
  id: string;
  name: string;
  version: string;
  architecture: string;
  category: string;
  sourceRepository?: string;
  sourceCommit?: string;
  license?: string;
  neuronCount: number;
  synapseCount?: number;
  backend: string;
  status: FlyModelStatus;
  executionPolicy: ExecutionPolicy;

  predict(context: PredictionContext): Promise<FlyPrediction>;
  learn(experience: FlyExperience): Promise<void>;
  getHealth(): FlyHealth;
  getNeuromodulationState(): NeuromodulationState;
  getInstance?(): FlyInstance;
  resetState?(): void;
}

export interface FlyDiversityMetrics {
  timestamp: number;
  pairwiseAgreementMatrix: Record<string, Record<string, number>>; // modelA -> modelB -> agreementRate
  averagePairwiseAgreement: number;
  effectiveDiversityScore: number; // [0.0, 1.0] (higher = more complementary)
  correlatedFailurePairs: Array<{
    modelA: string;
    modelB: string;
    correlatedFailureCount: number;
    correlationCoefficient: number;
  }>;
}

export interface FlyAutopsy {
  autopsyId: string;
  roundId: string;
  flyModelId: string;
  predicted: string;
  actual: string;
  predictionError: number;
  rewardPredictionError: number;
  dopamineSignal: number;
  aversiveSignal: number;
  dominantFeatureGroup: string;
  stateNovelty: number;
  wasOverconfident: boolean;
  recommendedRepair?: string;
  timestamp: number;
}
