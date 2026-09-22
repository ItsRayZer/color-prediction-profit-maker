/**
 * Champion & Challenger Manager
 * Implements Section 41 & 60:
 * Maintains CURRENT_CHAMPION and CURRENT_CHALLENGER with hysteresis.
 * Logs all switches with score delta and verified audit trail.
 */

import { RankingEngine } from './rankingEngine.ts';
import type { ExpertMetrics } from '../prediction/predictionTypes.ts';

export interface ChampionSwitchRecord {
  round: string | number;
  from: string;
  to: string;
  oldScore: number;
  newScore: number;
  scoreDelta: number;
  reason: string;
  timestamp: number;
}

export class ChampionManager {
  private currentChampionId = 'BASE_PREDICTOR'; // Default starts with BASE_PREDICTOR
  private currentChallengerId = 'MARKOV_TRANSITION';
  private championActiveDuration = 0;
  private switchHistory: ChampionSwitchRecord[] = [];

  // Hysteresis constants to prevent erratic churn
  public readonly PROMOTION_MARGIN = 0.025;      // Challenger must exceed champion by at least 2.5%
  public readonly MINIMUM_CHAMPION_DURATION = 10; // Minimum 10 rounds before demotion allowed
  public readonly MINIMUM_CHALLENGER_SAMPLES = 15; // Minimum 15 evaluated samples

  public getActiveChampionId(): string {
    return this.currentChampionId;
  }

  public getActiveChallengerId(): string {
    return this.currentChallengerId;
  }

  public getSwitchHistory(): ChampionSwitchRecord[] {
    return [...this.switchHistory];
  }

  public evaluatePromotion(
    rankingEngine: RankingEngine,
    currentRoundId: string | number
  ): { switched: boolean; record?: ChampionSwitchRecord } {
    this.championActiveDuration++;

    const allMetrics = rankingEngine.getAllMetrics();
    if (allMetrics.length < 2) return { switched: false };

    const topMetric = allMetrics[0];
    const secondMetric = allMetrics[1];

    // Find champion metrics
    let championMetric = allMetrics.find(m => m.expertId === this.currentChampionId);
    if (!championMetric) championMetric = topMetric;

    // Update current challenger
    const challengerMetric = allMetrics.find(m => m.expertId !== this.currentChampionId) || secondMetric;
    this.currentChallengerId = challengerMetric.expertId;

    // Check if challenger should overtake champion
    if (challengerMetric.expertId !== this.currentChampionId) {
      const challengerScore = challengerMetric.finalScore;
      const championScore = championMetric.finalScore;
      const scoreDelta = challengerScore - championScore;

      const hasSufficientSamples = challengerMetric.windows.allTime.totalEvaluated >= this.MINIMUM_CHALLENGER_SAMPLES;
      const hasServedMinDuration = this.championActiveDuration >= this.MINIMUM_CHAMPION_DURATION;
      const hasExceededMargin = scoreDelta >= this.PROMOTION_MARGIN;
      const isHealthy = challengerMetric.windows.last20.currentStreak > -4; // Not in catastrophic loss streak

      if (hasSufficientSamples && hasServedMinDuration && hasExceededMargin && isHealthy) {
        // Execute Champion Switch
        const oldChamp = this.currentChampionId;
        const newChamp = challengerMetric.expertId;

        const record: ChampionSwitchRecord = {
          round: currentRoundId,
          from: oldChamp,
          to: newChamp,
          oldScore: championScore,
          newScore: challengerScore,
          scoreDelta: Number(scoreDelta.toFixed(4)),
          reason: `Validated challenger advantage (+${(scoreDelta * 100).toFixed(1)}% score)`,
          timestamp: Date.now()
        };

        this.currentChampionId = newChamp;
        this.championActiveDuration = 0;
        this.switchHistory.push(record);

        console.log(`[ChampionManager] 🏆 CHAMPION SWITCH at round ${currentRoundId}: ${oldChamp} -> ${newChamp} (delta: +${record.scoreDelta})`);
        return { switched: true, record };
      }
    }

    return { switched: false };
  }
}

export const globalChampionManager = new ChampionManager();
