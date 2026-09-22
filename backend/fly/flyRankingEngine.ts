/**
 * Fly-Only Tournament Ranking Engine
 * Implements Sections 42, 63 & 64:
 * Dedicated ranking tournament for all independent Fly models.
 * Multi-window tracking (last10, last20, last50, last100, all-time) and FlyScore computation.
 */

import type { FlyMetrics, FlyPerformanceWindow, FlyPrediction, FlyHealth } from './flyTypes.ts';
import type { RoundResult } from '../prediction/predictionTypes.ts';

export interface EvaluatedFlyRound {
  roundId: string;
  flyModelId: string;
  prediction: string;
  probabilities: Record<string, number>;
  confidence: number;
  actual: RoundResult;
  wasCorrect: boolean;
  brier: number;
  logLoss: number;
  timestamp: number;
}

export class FlyRankingEngine {
  private historyByModel: Map<string, EvaluatedFlyRound[]> = new Map();
  private cachedMetrics: Map<string, FlyMetrics> = new Map();
  private rankingVersion = 0;
  private roundsSinceRecalc = 0;

  public recordEvaluation(evaluation: EvaluatedFlyRound): void {
    let list = this.historyByModel.get(evaluation.flyModelId);
    if (!list) {
      list = [];
      this.historyByModel.set(evaluation.flyModelId, list);
    }
    list.push(evaluation);
    if (list.length > 1000) list.shift();
  }

  public notifyRoundResolved(): boolean {
    this.roundsSinceRecalc++;
    if (this.roundsSinceRecalc >= 10) {
      this.recalculateAll();
      this.roundsSinceRecalc = 0;
      return true;
    }
    return false;
  }

  public getRoundsSinceRecalc(): number {
    return this.roundsSinceRecalc;
  }

  public recalculateAll(healthMap: Map<string, FlyHealth> = new Map()): void {
    this.rankingVersion++;
    const models = Array.from(this.historyByModel.keys());
    const newMetrics: FlyMetrics[] = [];

    for (const modelId of models) {
      const hist = this.historyByModel.get(modelId) || [];
      const health = healthMap.get(modelId) || {
        status: 'HEALTHY',
        latencyMs: 1.0,
        errorRate: 0.5,
        calibration: 0.85,
        stability: 0.85,
        reservoirHealth: 1.0,
        neuromodulationHealth: 1.0,
        firingRate: 0.12,
        deadNeuronsPct: 0.05,
        saturatedNeuronsPct: 0.02
      };

      const m = this.computeMetricsForModel(modelId, hist, health);
      newMetrics.push(m);
    }

    // Sort descending by score
    newMetrics.sort((a, b) => b.score - a.score);

    for (let i = 0; i < newMetrics.length; i++) {
      const prev = this.cachedMetrics.get(newMetrics[i].flyModelId);
      newMetrics[i].previousRank = prev ? prev.rank : (i + 1);
      newMetrics[i].rank = i + 1;
      this.cachedMetrics.set(newMetrics[i].flyModelId, newMetrics[i]);
    }
  }

  private computeWindow(rounds: EvaluatedFlyRound[], windowSize: number | 'ALL'): FlyPerformanceWindow {
    const total = rounds.length;
    if (total === 0) {
      return {
        windowSize,
        totalEvaluated: 0,
        correctCount: 0,
        wrongCount: 0,
        accuracy: 0.5,
        winRate: 0.5,
        logLoss: 0.693,
        brierScore: 0.25,
        calibration: 0.8,
        currentStreak: 0,
        maxWinStreak: 0,
        maxLossStreak: 0,
        stability: 0.8
      };
    }

    let correct = 0;
    let sumLogLoss = 0;
    let sumBrier = 0;
    let curStreak = 0;
    let maxWin = 0;
    let maxLoss = 0;

    for (let i = 0; i < total; i++) {
      const r = rounds[i];
      if (r.wasCorrect) {
        correct++;
        curStreak = curStreak >= 0 ? curStreak + 1 : 1;
        if (curStreak > maxWin) maxWin = curStreak;
      } else {
        curStreak = curStreak <= 0 ? curStreak - 1 : -1;
        const absL = Math.abs(curStreak);
        if (absL > maxLoss) maxLoss = absL;
      }
      sumLogLoss += r.logLoss;
      sumBrier += r.brier;
    }

    const accuracy = correct / total;
    const brierScore = sumBrier / total;
    const logLoss = sumLogLoss / total;
    const calibration = Math.max(0.1, 1.0 - Math.min(1.0, brierScore * 2));
    const stability = Math.max(0.2, 1.0 - (maxLoss / Math.max(5, total)));

    return {
      windowSize,
      totalEvaluated: total,
      correctCount: correct,
      wrongCount: total - correct,
      accuracy: Number(accuracy.toFixed(4)),
      winRate: Number(accuracy.toFixed(4)),
      logLoss: Number(logLoss.toFixed(4)),
      brierScore: Number(brierScore.toFixed(4)),
      calibration: Number(calibration.toFixed(4)),
      currentStreak: curStreak,
      maxWinStreak: maxWin,
      maxLossStreak: maxLoss,
      stability: Number(stability.toFixed(4))
    };
  }

  private computeMetricsForModel(modelId: string, hist: EvaluatedFlyRound[], health: FlyHealth): FlyMetrics {
    const w10 = this.computeWindow(hist.slice(-10), 10);
    const w20 = this.computeWindow(hist.slice(-20), 20);
    const w50 = this.computeWindow(hist.slice(-50), 50);
    const w100 = this.computeWindow(hist.slice(-100), 100);
    const allTime = this.computeWindow(hist, 'ALL');

    const fastScore = w10.accuracy;
    const mediumScore = w20.accuracy * 0.6 + w50.accuracy * 0.4;
    const longScore = w100.accuracy * 0.5 + allTime.accuracy * 0.5;
    const calibrationScore = w50.calibration;
    const stabilityScore = w50.stability;
    const regimeScore = 1.0;
    const diversityContribution = 0.85;

    // Section 64 FlyScore formula
    const score = Number((
      fastScore * 0.25 +
      mediumScore * 0.25 +
      longScore * 0.15 +
      calibrationScore * 0.15 +
      stabilityScore * 0.10 +
      diversityContribution * 0.10
    ).toFixed(4));

    return {
      flyModelId: modelId,
      rank: 1,
      previousRank: 1,
      score,
      fastScore: Number(fastScore.toFixed(4)),
      mediumScore: Number(mediumScore.toFixed(4)),
      longScore: Number(longScore.toFixed(4)),
      calibrationScore: Number(calibrationScore.toFixed(4)),
      stabilityScore: Number(stabilityScore.toFixed(4)),
      regimeScore,
      diversityContribution,
      windows: {
        last10: w10,
        last20: w20,
        last50: w50,
        last100: w100,
        allTime
      },
      health,
      lastUpdatedTimestamp: Date.now()
    };
  }

  public getMetrics(modelId: string): FlyMetrics | undefined {
    if (this.cachedMetrics.size === 0 && this.historyByModel.size > 0) {
      this.recalculateAll();
    }
    return this.cachedMetrics.get(modelId);
  }

  public getAllMetrics(): FlyMetrics[] {
    if (this.cachedMetrics.size === 0 && this.historyByModel.size > 0) {
      this.recalculateAll();
    }
    return Array.from(this.cachedMetrics.values()).sort((a, b) => a.rank - b.rank);
  }

  public getRankingVersion(): number {
    return this.rankingVersion;
  }
}
