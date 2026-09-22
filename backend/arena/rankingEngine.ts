/**
 * Tournament Ranking Engine
 * Implements Sections 39 & 40:
 * Multi-window tracking (last10, last20, last50, last100, last200, last500, last1000, allTime)
 * Metrics: accuracy, logLoss, Brier score, calibration, streak, stability
 * Recalculate every 10 resolved rounds.
 */

import type { ExpertMetrics, ExpertPerformanceWindow, ExpertHealth, RoundResult } from '../prediction/predictionTypes.ts';

export interface EvaluatedRound {
  roundId: string;
  expertId: string;
  predicted: string;
  probabilities: Record<string, number>;
  confidence: number;
  actual: RoundResult;
  wasCorrect: boolean;
  brier: number;
  logLoss: number;
  timestamp: number;
}

export class RankingEngine {
  private historyByExpert: Map<string, EvaluatedRound[]> = new Map();
  private cachedMetrics: Map<string, ExpertMetrics> = new Map();
  private rankingVersion = 0;
  private roundsSinceRecalc = 0;

  public recordEvaluation(evaluation: EvaluatedRound): void {
    let list = this.historyByExpert.get(evaluation.expertId);
    if (!list) {
      list = [];
      this.historyByExpert.set(evaluation.expertId, list);
    }
    list.push(evaluation);
    if (list.length > 2000) {
      list.shift();
    }
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

  public recalculateAll(): void {
    this.rankingVersion++;
    const experts = Array.from(this.historyByExpert.keys());
    const newMetrics: ExpertMetrics[] = [];

    for (const expertId of experts) {
      const history = this.historyByExpert.get(expertId) || [];
      const m = this.calculateMetricsForExpert(expertId, history);
      newMetrics.push(m);
    }

    // Sort descending by finalScore to determine tournament ranks
    newMetrics.sort((a, b) => b.finalScore - a.finalScore);

    for (let i = 0; i < newMetrics.length; i++) {
      const prevMetric = this.cachedMetrics.get(newMetrics[i].expertId);
      newMetrics[i].previousRank = prevMetric ? prevMetric.rank : (i + 1);
      newMetrics[i].rank = i + 1;
      this.cachedMetrics.set(newMetrics[i].expertId, newMetrics[i]);
    }
  }

  private calculateWindow(rounds: EvaluatedRound[], windowSize: number | 'ALL'): ExpertPerformanceWindow {
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
        avgLossCluster: 1.0,
        stability: 0.8,
        regimeCompatibility: 1.0
      };
    }

    let correct = 0;
    let sumLogLoss = 0;
    let sumBrier = 0;
    let curStreak = 0;
    let maxWin = 0;
    let maxLoss = 0;
    const lossClusters: number[] = [];
    let currentLossCluster = 0;

    for (let i = 0; i < total; i++) {
      const r = rounds[i];
      if (r.wasCorrect) {
        correct++;
        curStreak = curStreak >= 0 ? curStreak + 1 : 1;
        if (curStreak > maxWin) maxWin = curStreak;
        if (currentLossCluster > 0) {
          lossClusters.push(currentLossCluster);
          currentLossCluster = 0;
        }
      } else {
        curStreak = curStreak <= 0 ? curStreak - 1 : -1;
        const absL = Math.abs(curStreak);
        if (absL > maxLoss) maxLoss = absL;
        currentLossCluster++;
      }

      sumLogLoss += r.logLoss;
      sumBrier += r.brier;
    }
    if (currentLossCluster > 0) lossClusters.push(currentLossCluster);

    const avgLoss = lossClusters.length > 0 ? lossClusters.reduce((a, b) => a + b, 0) / lossClusters.length : 1.0;
    const accuracy = correct / total;
    const brierScore = sumBrier / total;
    const logLoss = sumLogLoss / total;
    const calibration = Math.max(0.1, 1.0 - Math.min(1.0, brierScore * 2));

    // Stability: lower variance in correctness across chunks
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
      avgLossCluster: Number(avgLoss.toFixed(2)),
      stability: Number(stability.toFixed(4)),
      regimeCompatibility: 1.0
    };
  }

  private calculateMetricsForExpert(expertId: string, history: EvaluatedRound[]): ExpertMetrics {
    const w10 = this.calculateWindow(history.slice(-10), 10);
    const w20 = this.calculateWindow(history.slice(-20), 20);
    const w50 = this.calculateWindow(history.slice(-50), 50);
    const w100 = this.calculateWindow(history.slice(-100), 100);
    const w200 = this.calculateWindow(history.slice(-200), 200);
    const w500 = this.calculateWindow(history.slice(-500), 500);
    const w1000 = this.calculateWindow(history.slice(-1000), 1000);
    const allTime = this.calculateWindow(history, 'ALL');

    // Scores [0.0, 1.0]
    const fastScore = w10.accuracy;
    const mediumScore = (w20.accuracy * 0.6 + w50.accuracy * 0.4);
    const longScore = (w100.accuracy * 0.5 + allTime.accuracy * 0.5);
    const calibrationScore = w50.calibration;
    const stabilityScore = w50.stability;
    const regimeScore = 1.0;
    const reliabilityScore = Math.min(1.0, history.length / 30);

    // Section 39 Final Score:
    // finalScore = recentPerformance + mediumTermPerformance + longTermPerformance + calibration + regime + stability + reliability - uncertainty - instability
    const finalScore = Number((
      fastScore * 0.25 +
      mediumScore * 0.30 +
      longScore * 0.15 +
      calibrationScore * 0.15 +
      stabilityScore * 0.10 +
      reliabilityScore * 0.05
    ).toFixed(4));

    return {
      expertId,
      lastUpdatedTimestamp: Date.now(),
      windows: {
        last10: w10,
        last20: w20,
        last50: w50,
        last100: w100,
        last200: w200,
        last500: w500,
        last1000: w1000,
        allTime
      },
      fastScore: Number(fastScore.toFixed(4)),
      mediumScore: Number(mediumScore.toFixed(4)),
      longScore: Number(longScore.toFixed(4)),
      calibrationScore: Number(calibrationScore.toFixed(4)),
      stabilityScore: Number(stabilityScore.toFixed(4)),
      regimeScore: Number(regimeScore.toFixed(4)),
      reliabilityScore: Number(reliabilityScore.toFixed(4)),
      finalScore,
      rank: 1,
      previousRank: 1
    };
  }

  public getMetrics(expertId: string): ExpertMetrics | undefined {
    return this.cachedMetrics.get(expertId);
  }

  public getAllMetrics(): ExpertMetrics[] {
    return Array.from(this.cachedMetrics.values()).sort((a, b) => a.rank - b.rank);
  }

  public getRankingVersion(): number {
    return this.rankingVersion;
  }
}

export const globalRankingEngine = new RankingEngine();
