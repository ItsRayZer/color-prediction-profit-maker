/**
 * Unified Prediction Types for Adaptive Prediction Arena v3.0
 */

export type OutcomeSize = 'BIG' | 'SMALL';
export type OutcomeColor = 'RED' | 'GREEN' | 'VIOLET' | 'RED_VIOLET' | 'GREEN_VIOLET';
export type PredictionTarget = OutcomeSize | 'RED' | 'GREEN';
export type PredictionDimension = 'SIZE' | 'COLOR';

export interface RoundResult {
  period: string;
  number: number;
  size: OutcomeSize;
  color: OutcomeColor;
  timestamp?: number;
}

export interface PredictionContext {
  roundId: string;
  timeframe: string;
  history: RoundResult[];
  balance?: number;
  lossStreak?: number;
  winStreak?: number;
  currentRegime?: string;
  metadata?: Record<string, unknown>;
}

export interface ExpertPrediction {
  expertId: string;
  prediction: string; // e.g. 'BIG' or 'SMALL' (or 'RED'/'GREEN')
  probabilities: Record<string, number>; // Must be a complete distribution e.g. { BIG: 0.61, SMALL: 0.39 }
  confidence: number; // [0.0, 1.0]
  evidence: number; // [0.0, 1.0] quantitative weight of supporting evidence
  sampleSize?: number;
  regime?: string;
  timestamp: number;
  modelVersion?: string;
  metadata?: Record<string, unknown>;
}

export interface PredictionExpert {
  id: string;
  name: string;
  version: string;
  category: 'BASE' | 'CLASSICAL' | 'STATISTICAL' | 'NEURAL' | 'FLY' | 'META' | 'SPECIALIZED';
  enabled: boolean;

  predict(context: PredictionContext): Promise<ExpertPrediction>;
}

export type ExpertHealthStatus = 'HEALTHY' | 'DEGRADED' | 'RECOVERING' | 'UNTRUSTED' | 'DISABLED';

export interface ExpertHealth {
  expertId: string;
  status: ExpertHealthStatus;
  latencyMs: number;
  consecutiveErrors: number;
  totalCalls: number;
  failedCalls: number;
  lastFailureTime?: number;
  lastFailureReason?: string;
  calibrationScore: number;
  stabilityScore: number;
}

export interface ExpertPerformanceWindow {
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
  avgLossCluster: number;
  stability: number;
  regimeCompatibility: number;
}

export interface ExpertMetrics {
  expertId: string;
  lastUpdatedRound?: string;
  lastUpdatedTimestamp: number;
  windows: {
    last10: ExpertPerformanceWindow;
    last20: ExpertPerformanceWindow;
    last50: ExpertPerformanceWindow;
    last100: ExpertPerformanceWindow;
    last200: ExpertPerformanceWindow;
    last500: ExpertPerformanceWindow;
    last1000: ExpertPerformanceWindow;
    allTime: ExpertPerformanceWindow;
  };
  fastScore: number;
  mediumScore: number;
  longScore: number;
  calibrationScore: number;
  stabilityScore: number;
  regimeScore: number;
  reliabilityScore: number;
  finalScore: number;
  rank: number;
  previousRank: number;
}

export interface PredictionAutopsy {
  predictionId: string;
  roundId: string;
  actualResult: RoundResult;
  expertPredictions: Record<string, {
    prediction: string;
    probabilities: Record<string, number>;
    confidence: number;
    wasCorrect: boolean;
    brier: number;
    logLoss: number;
  }>;
  activeExpert: string;
  activeWasCorrect: boolean;
  mistakeType?: string;
  cause?: string;
  evidence?: string;
  repair?: string;
  championDegraded: boolean;
  consensusFailed: boolean;
  regimeMismatch: boolean;
  timestamp: number;
}
