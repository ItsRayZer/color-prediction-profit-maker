/**
 * Arena API Route Handlers
 * Implements Section 55:
 * GET /api/prediction/arena
 * GET /api/prediction/arena/:expertId
 * GET /api/prediction/arena/ranking
 * GET /api/prediction/arena/history
 * GET /api/prediction/arena/health
 * GET /api/prediction/arena/champion
 * GET /api/prediction/arena/regime
 * GET /api/prediction/arena/autopsy
 */

import { globalPredictionArena } from '../arena/predictionArena.ts';

export class ArenaRouteHandler {
  public static getArenaOverview(): any {
    const arena = globalPredictionArena;
    arena.initialize();

    const ranking = arena.rankingEngine.getAllMetrics();
    const activeChamp = arena.championManager.getActiveChampionId();
    const challenger = arena.championManager.getActiveChallengerId();
    const historyCount = arena.historicalMemory.getCount();
    const dominantReg = arena.regimeClassifier.getDominantRegime(
      arena.worldModel.assess(arena.historicalMemory.getAll()).regimeDistribution
    );

    return {
      status: 'ONLINE',
      activeExpert: activeChamp,
      currentChallenger: challenger,
      totalRegisteredExperts: arena.registry.getCount(),
      totalHistoricalRounds: historyCount,
      currentRegime: dominantReg.regime,
      regimeProbability: dominantReg.probability,
      rankingVersion: arena.rankingEngine.getRankingVersion(),
      roundsSinceRanking: arena.rankingEngine.getRoundsSinceRecalc(),
      nextRankingUpdate: 10 - arena.rankingEngine.getRoundsSinceRecalc(),
      topRankings: ranking.slice(0, 5).map(m => ({
        rank: m.rank,
        expertId: m.expertId,
        score: m.finalScore,
        accuracy20: m.windows.last20.accuracy,
        accuracyAll: m.windows.allTime.accuracy,
        calibration: m.calibrationScore
      }))
    };
  }

  public static getRanking(): any {
    const arena = globalPredictionArena;
    arena.initialize();
    return {
      rankingVersion: arena.rankingEngine.getRankingVersion(),
      rankings: arena.rankingEngine.getAllMetrics()
    };
  }

  public static getExpertDetails(expertId: string): any {
    const arena = globalPredictionArena;
    arena.initialize();
    const expert = arena.registry.get(expertId);
    if (!expert) return { error: `Expert ${expertId} not found` };

    const metrics = arena.rankingEngine.getMetrics(expertId);
    const health = arena.getHealthMap().get(expertId);

    return {
      expert: {
        id: expert.id,
        name: expert.name,
        version: expert.version,
        category: expert.category,
        enabled: expert.enabled
      },
      metrics: metrics || null,
      health: health || null
    };
  }

  public static getHistory(): any {
    const arena = globalPredictionArena;
    return {
      total: arena.historicalMemory.getCount(),
      recent: arena.historicalMemory.getRecent(50)
    };
  }

  public static getHealth(): any {
    const arena = globalPredictionArena;
    arena.initialize();
    const healthList = Array.from(arena.getHealthMap().values());
    return {
      totalMonitored: healthList.length,
      healthyCount: healthList.filter(h => h.status === 'HEALTHY').length,
      degradedCount: healthList.filter(h => h.status === 'DEGRADED').length,
      recoveringCount: healthList.filter(h => h.status === 'RECOVERING').length,
      untrustedCount: healthList.filter(h => h.status === 'UNTRUSTED').length,
      experts: healthList
    };
  }

  public static getChampion(): any {
    const arena = globalPredictionArena;
    arena.initialize();
    const champId = arena.championManager.getActiveChampionId();
    const challengerId = arena.championManager.getActiveChallengerId();
    const champMetric = arena.rankingEngine.getMetrics(champId);
    const challengerMetric = arena.rankingEngine.getMetrics(challengerId);

    return {
      activeChampion: {
        expertId: champId,
        metrics: champMetric || null
      },
      currentChallenger: {
        expertId: challengerId,
        metrics: challengerMetric || null
      },
      promotionMargin: arena.championManager.PROMOTION_MARGIN,
      switchHistory: arena.championManager.getSwitchHistory()
    };
  }

  public static getRegime(): any {
    const arena = globalPredictionArena;
    arena.initialize();
    const hist = arena.historicalMemory.getAll();
    const world = arena.worldModel.assess(hist);
    return {
      worldState: world.state,
      stabilityScore: world.stabilityScore,
      distributionDrift: world.distributionDrift,
      entropy: world.entropy,
      regimeDistribution: world.regimeDistribution
    };
  }

  public static getAutopsy(roundId?: string): any {
    const arena = globalPredictionArena;
    if (roundId) {
      const single = arena.autopsyEngine.getByRoundId(roundId);
      if (!single) return { error: `Autopsy not found for round ${roundId}` };
      return single;
    }
    return {
      recentAutopsies: arena.autopsyEngine.getRecent(20)
    };
  }
}
