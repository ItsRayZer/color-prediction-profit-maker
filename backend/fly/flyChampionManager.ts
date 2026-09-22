/**
 * Fly Champion & Challenger Manager
 * Implements Sections 44, 45 & 65:
 * Maintains FLY_CHAMPION and FLY_CHALLENGER separately from Global Champion.
 */

import { FlyRankingEngine } from './flyRankingEngine.ts';
import type { ChampionSwitchRecord } from '../arena/championManager.ts';

export class FlyChampionManager {
  private currentChampionId = 'FLY_LIF_CLASSIC';
  private currentChallengerId = 'FLY_REWARD_GATED';
  private championDuration = 0;
  private switchHistory: ChampionSwitchRecord[] = [];

  public readonly PROMOTION_MARGIN = 0.025;
  public readonly MINIMUM_CHAMPION_DURATION = 10;
  public readonly MINIMUM_CHALLENGER_SAMPLES = 15;

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
    rankingEngine: FlyRankingEngine,
    currentRoundId: string | number
  ): { switched: boolean; record?: ChampionSwitchRecord } {
    this.championDuration++;
    const allMetrics = rankingEngine.getAllMetrics();
    if (allMetrics.length < 2) return { switched: false };

    let champMetric = allMetrics.find(m => m.flyModelId === this.currentChampionId) || allMetrics[0];
    const challengerMetric = allMetrics.find(m => m.flyModelId !== this.currentChampionId) || allMetrics[1];
    this.currentChallengerId = challengerMetric.flyModelId;

    if (challengerMetric.flyModelId !== this.currentChampionId) {
      const scoreDelta = challengerMetric.score - champMetric.score;
      const hasSamples = challengerMetric.windows.allTime.totalEvaluated >= this.MINIMUM_CHALLENGER_SAMPLES;
      const hasDuration = this.championDuration >= this.MINIMUM_CHAMPION_DURATION;
      const exceedsMargin = scoreDelta >= this.PROMOTION_MARGIN;

      if (hasSamples && hasDuration && exceedsMargin) {
        const oldChamp = this.currentChampionId;
        const newChamp = challengerMetric.flyModelId;

        const record: ChampionSwitchRecord = {
          round: currentRoundId,
          from: oldChamp,
          to: newChamp,
          oldScore: champMetric.score,
          newScore: challengerMetric.score,
          scoreDelta: Number(scoreDelta.toFixed(4)),
          reason: `Fly Challenger advantage (+${(scoreDelta * 100).toFixed(1)}% score)`,
          timestamp: Date.now()
        };

        this.currentChampionId = newChamp;
        this.championDuration = 0;
        this.switchHistory.push(record);

        console.log(`[FlyChampionManager] 🏆 FLY CHAMPION SWITCH at round ${currentRoundId}: ${oldChamp} -> ${newChamp}`);
        return { switched: true, record };
      }
    }

    return { switched: false };
  }
}
