/**
 * Fly Brain API Route Handlers
 * Implements Section 69:
 * GET /api/prediction/arena/fly
 * GET /api/prediction/arena/fly/ranking
 * GET /api/prediction/arena/fly/:flyId
 * GET /api/prediction/arena/fly/:flyId/history
 * GET /api/prediction/arena/fly/:flyId/health
 * GET /api/prediction/arena/fly/champion
 * GET /api/prediction/arena/fly/consensus
 * GET /api/prediction/arena/fly/diversity
 * GET /api/prediction/arena/fly/autopsy
 */

import { globalFlyBrainArena } from '../fly/flyArena.ts';

export class FlyRouteHandler {
  public static getFlyOverview(): any {
    const arena = globalFlyBrainArena;
    arena.initialize();

    const ranking = arena.rankingEngine.getAllMetrics();
    const champ = arena.getFlyChampionId();
    const challenger = arena.getFlyChallengerId();
    const diversity = arena.diversityEngine.computeDiversityMetrics(Array.from(arena.models.keys()));

    return {
      subArena: 'FLY_BRAIN_ECOSYSTEM',
      status: 'ACTIVE',
      totalFlyModels: arena.models.size,
      activeChampion: champ,
      currentChallenger: challenger,
      roundsSinceRanking: arena.rankingEngine.getRoundsSinceRecalc(),
      nextRankingUpdate: 10 - arena.rankingEngine.getRoundsSinceRecalc(),
      effectiveDiversityScore: diversity.effectiveDiversityScore,
      topRankings: ranking.slice(0, 5).map(m => ({
        rank: m.rank,
        flyModelId: m.flyModelId,
        score: m.score,
        accuracy20: m.windows.last20.accuracy,
        accuracyAll: m.windows.allTime.accuracy,
        health: m.health.status
      }))
    };
  }

  public static getFlyRanking(): any {
    const arena = globalFlyBrainArena;
    arena.initialize();
    return {
      rankingVersion: arena.rankingEngine.getRankingVersion(),
      rankings: arena.rankingEngine.getAllMetrics()
    };
  }

  public static getFlyModelDetails(flyId: string): any {
    const arena = globalFlyBrainArena;
    arena.initialize();
    const model = arena.getModel(flyId);
    if (!model) return { error: `Fly model ${flyId} not found` };

    const metrics = arena.rankingEngine.getMetrics(flyId);
    const health = model.getHealth();
    const neuromodulation = model.getNeuromodulationState();

    return {
      model: {
        id: model.id,
        name: model.name,
        version: model.version,
        architecture: model.architecture,
        neuronCount: model.neuronCount,
        backend: model.backend,
        status: model.status
      },
      metrics: metrics || null,
      health,
      neuromodulation
    };
  }

  public static getFlyHistory(flyId: string): any {
    const arena = globalFlyBrainArena;
    const autopsies = arena.autopsyEngine.getByModelId(flyId, 30);
    const metrics = arena.rankingEngine.getMetrics(flyId);
    return {
      flyModelId: flyId,
      allTimeStats: metrics?.windows.allTime || null,
      recentAutopsies: autopsies
    };
  }

  public static getFlyHealth(flyId: string): any {
    const arena = globalFlyBrainArena;
    const model = arena.getModel(flyId);
    if (!model) return { error: `Fly model ${flyId} not found` };
    return {
      flyModelId: flyId,
      health: model.getHealth(),
      neuromodulation: model.getNeuromodulationState()
    };
  }

  public static getFlyChampion(): any {
    const arena = globalFlyBrainArena;
    arena.initialize();
    const champId = arena.getFlyChampionId();
    const challengerId = arena.getFlyChallengerId();
    const champMetric = arena.rankingEngine.getMetrics(champId);
    const challengerMetric = arena.rankingEngine.getMetrics(challengerId);

    return {
      flyChampion: {
        modelId: champId,
        metrics: champMetric || null
      },
      flyChallenger: {
        modelId: challengerId,
        metrics: challengerMetric || null
      },
      promotionMargin: arena.championManager.PROMOTION_MARGIN,
      switchHistory: arena.championManager.getSwitchHistory()
    };
  }

  public static getFlyConsensus(): any {
    const arena = globalFlyBrainArena;
    arena.initialize();
    return {
      consensusExpertId: arena.consensusExpert.id,
      consensusName: arena.consensusExpert.name,
      activeFlyCount: arena.models.size
    };
  }

  public static getFlyDiversity(): any {
    const arena = globalFlyBrainArena;
    arena.initialize();
    return arena.diversityEngine.computeDiversityMetrics(Array.from(arena.models.keys()));
  }

  public static getFlyAutopsies(flyId?: string): any {
    const arena = globalFlyBrainArena;
    if (flyId) {
      return { autopsies: arena.autopsyEngine.getByModelId(flyId, 25) };
    }
    return { autopsies: arena.autopsyEngine.getRecent(30) };
  }
}
