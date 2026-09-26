/**
 * PREDICTION ARENA COORDINATOR
 * Implements Sections 2, 3, 44, 46, 47, 58, 61:
 * Orchestrates tournament rounds, failure isolation with Promise.allSettled(),
 * consensus, champion selection, and post-round evaluation.
 */

import type { PredictionContext, ExpertPrediction, RoundResult, ExpertHealth } from '../prediction/predictionTypes.ts';
import { ExpertRegistry, globalExpertRegistry } from './expertRegistry.ts';
import { RankingEngine, globalRankingEngine } from './rankingEngine.ts';
import type { EvaluatedRound } from './rankingEngine.ts';
import { ChampionManager, globalChampionManager } from './championManager.ts';
import type { ChampionSwitchRecord } from './championManager.ts';
import { ConsensusController, globalConsensusController } from '../prediction/consensusController.ts';
import type { ConsensusResult } from '../prediction/consensusController.ts';
import { HistoricalMemory, globalHistoricalMemory } from '../memory/historicalMemory.ts';
import { PatternDNAEngine, globalPatternDNA } from '../pattern/patternDNA.ts';
import { RegimeClassifier, globalRegimeClassifier } from '../regime/regimeClassifier.ts';
import type { RegimeType } from '../regime/regimeClassifier.ts';
import { WorldModel, globalWorldModel } from '../regime/worldModel.ts';
import type { WorldModelAssessment } from '../regime/worldModel.ts';
import { GodsEyeController, globalGodsEye } from '../godseye/godsEyeController.ts';
import type { GodsEyeState } from '../godseye/godsEyeController.ts';
import { LossStreakShield, globalLossStreakShield } from '../runs/lossShield.ts';
import type { ShieldStatus } from '../runs/lossShield.ts';
import { AutopsyEngine, globalAutopsyEngine } from '../diagnostics/predictionAutopsy.ts';
import { TimeTraveller, globalTimeTraveller } from '../replay/timeTraveller.ts';
import { FutureStateEngine, globalFutureStateEngine } from '../future/futureStateEngine.ts';
import type { SimulatedTrajectory } from '../future/futureStateEngine.ts';
import { globalStrategyLab } from '../strategy/strategyLab.ts';

// Import All Experts for automatic registration
import { BaseExpert } from '../experts/baseExpert.ts';
import {
  MarkovTransitionExpert,
  SecondOrderMarkovExpert,
  BayesianTransitionExpert,
  RecencyWeightedExpert,
  FrequencyModelExpert,
  StreakRiderExpert,
  StreakBreakerExpert,
  RunLengthModelExpert,
  SuffixPatternExpert,
  PatternTrieExpert,
  TrapDetectorExpert,
  ChangePointModelExpert,
  EntropyModelExpert,
  DistributionDriftExpert,
  InversionModelExpert
} from '../experts/classicalExperts.ts';

import {
  NGramModelExpert,
  HiddenMarkovModelExpert,
  BayesianOnlineModelExpert,
  SimilarityModelExpert,
  BootstrapModelExpert,
  StatisticalEnsembleExpert
} from '../experts/statisticalExperts.ts';

import {
  LogisticModelExpert,
  RandomForestExpert,
  GradientBoosterExpert,
  MlpExpert,
  GruExpert,
  LstmExpert,
  TcnExpert,
  PatternNeuralExpert,
  RegimeNeuralExpert,
  StreakNeuralExpert,
  InversionNeuralExpert,
  AnomalyModelExpert
} from '../neural/neuralExperts.ts';

import {
  NeuralConsensusExpert,
  ClassicalConsensusExpert,
  MultiTimeframeConsensusExpert,
  AdaptiveEnsembleExpert,
  AsiSupercomputerExpert
} from '../experts/metaExperts.ts';


import { FlyBrainReservoirExpert } from '../fly/flyExpert.ts';
import { globalFlyBrainArena, FlyBrainArena } from '../fly/flyArena.ts';

export interface ArenaActivePredictionResponse {
  prediction: string;
  probabilities: Record<string, number>;
  confidence: number;
  activeExpert: string;
  rank: number;
  score: number;
  roundsSinceRanking: number;
  nextRankingUpdate: number;
  regime: string;
  dangerScore: number;
  metadata: {
    arena: {
      activeExpert: string;
      rank: number;
      score: number;
      confidence: number;
      roundsSinceRanking: number;
      nextRankingUpdate: number;
      rankingVersion: number;
      championDuration: number;
      currentChallenger: string;
    };
    godsEye: GodsEyeState;
    consensus: ConsensusResult;
    shield: ShieldStatus;
    trajectories: SimulatedTrajectory[];
  };
}

export class PredictionArena {
  public registry: ExpertRegistry;
  public rankingEngine: RankingEngine;
  public championManager: ChampionManager;
  public consensusController: ConsensusController;
  public historicalMemory: HistoricalMemory;
  public patternDNA: PatternDNAEngine;
  public regimeClassifier: RegimeClassifier;
  public worldModel: WorldModel;
  public godsEye: GodsEyeController;
  public lossShield: LossStreakShield;
  public autopsyEngine: AutopsyEngine;
  public timeTraveller: TimeTraveller;
  public futureStateEngine: FutureStateEngine;

  private healthMap: Map<string, ExpertHealth> = new Map();
  private roundPredictionsStore: Map<string, ExpertPrediction[]> = new Map();
  private flyBrainExpertInstance: FlyBrainReservoirExpert | null = null;
  private initialized = false;

  constructor() {
    this.registry = globalExpertRegistry;
    this.rankingEngine = globalRankingEngine;
    this.championManager = globalChampionManager;
    this.consensusController = globalConsensusController;
    this.historicalMemory = globalHistoricalMemory;
    this.patternDNA = globalPatternDNA;
    this.regimeClassifier = globalRegimeClassifier;
    this.worldModel = globalWorldModel;
    this.godsEye = globalGodsEye;
    this.lossShield = globalLossStreakShield;
    this.autopsyEngine = globalAutopsyEngine;
    this.timeTraveller = globalTimeTraveller;
    this.futureStateEngine = globalFutureStateEngine;
  }

  public initialize(): void {
    if (this.initialized) return;

    // 1. Register BASE_PREDICTOR (Rule 0)
    this.registry.register(new BaseExpert());

    // 2. Register Classical Experts
    this.registry.register(new MarkovTransitionExpert());
    this.registry.register(new SecondOrderMarkovExpert());
    this.registry.register(new BayesianTransitionExpert());
    this.registry.register(new RecencyWeightedExpert());
    this.registry.register(new FrequencyModelExpert());
    this.registry.register(new StreakRiderExpert());
    this.registry.register(new StreakBreakerExpert());
    this.registry.register(new RunLengthModelExpert());
    this.registry.register(new SuffixPatternExpert());
    this.registry.register(new PatternTrieExpert());
    this.registry.register(new TrapDetectorExpert());
    this.registry.register(new ChangePointModelExpert());
    this.registry.register(new EntropyModelExpert());
    this.registry.register(new DistributionDriftExpert());
    this.registry.register(new InversionModelExpert());

    // 3. Register Statistical Experts
    this.registry.register(new NGramModelExpert());
    this.registry.register(new HiddenMarkovModelExpert());
    this.registry.register(new BayesianOnlineModelExpert());
    this.registry.register(new SimilarityModelExpert());
    this.registry.register(new BootstrapModelExpert());
    this.registry.register(new StatisticalEnsembleExpert());

    // 4. Register Neural Experts
    this.registry.register(new LogisticModelExpert());
    this.registry.register(new RandomForestExpert());
    this.registry.register(new GradientBoosterExpert());
    this.registry.register(new MlpExpert());
    this.registry.register(new GruExpert());
    this.registry.register(new LstmExpert());
    this.registry.register(new TcnExpert());
    this.registry.register(new PatternNeuralExpert());
    this.registry.register(new RegimeNeuralExpert());
    this.registry.register(new StreakNeuralExpert());
    this.registry.register(new InversionNeuralExpert());
    this.registry.register(new AnomalyModelExpert());

    // 5. Register Multi-Model Fly Brain Arena & Individual Fly Experts
    this.flyBrainExpertInstance = new FlyBrainReservoirExpert();
    this.registry.register(this.flyBrainExpertInstance);

    globalFlyBrainArena.initialize();
    for (const flyAdapter of globalFlyBrainArena.getAdapters()) {
      this.registry.register(flyAdapter);
    }
    this.registry.register(globalFlyBrainArena.consensusExpert);

    // 6. Register Meta Experts
    this.registry.register(new NeuralConsensusExpert());
    this.registry.register(new ClassicalConsensusExpert());
    this.registry.register(new MultiTimeframeConsensusExpert());
    this.registry.register(new AdaptiveEnsembleExpert());
    this.registry.register(new AsiSupercomputerExpert());


    // Initialize health records
    for (const expert of this.registry.getAll()) {
      this.healthMap.set(expert.id, {
        expertId: expert.id,
        status: 'HEALTHY',
        latencyMs: 1.0,
        consecutiveErrors: 0,
        totalCalls: 0,
        failedCalls: 0,
        calibrationScore: 0.8,
        stabilityScore: 0.8
      });
    }

    this.initialized = true;
    console.log(`[PredictionArena] Initialized with ${this.registry.getCount()} independent prediction experts.`);
  }

  /**
   * ON NEW ROUND:
   * 1. Validate round
   * 2. Build context
   * 3. Run EVERY enabled expert using Promise.allSettled()
   * 4. Run meta-analysis & God's Eye
   * 5. Store every prediction
   * 6. Select active champion
   * 7. Return active prediction
   */
  public async onNewRound(context: PredictionContext): Promise<ArenaActivePredictionResponse> {
    this.initialize();

    const roundId = context.roundId;

    // Check if predictions already computed for this round
    const existing = this.roundPredictionsStore.get(roundId);
    if (existing && existing.length > 0) {
      return this.buildActiveResponse(existing, context);
    }

    const enabledExperts = this.registry.getEnabled();

    // Run EVERY enabled expert under Promise.allSettled() for complete failure isolation
    const results = await Promise.allSettled(
      enabledExperts.map(async expert => {
        const t0 = performance.now();
        try {
          const pred = await expert.predict(context);
          const latency = performance.now() - t0;
          this.updateHealthSuccess(expert.id, latency);
          return pred;
        } catch (err) {
          this.updateHealthFailure(expert.id, String(err));
          throw err;
        }
      })
    );

    const predictions: ExpertPrediction[] = [];
    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (res.status === 'fulfilled') {
        predictions.push(res.value);
      } else {
        console.warn(`[PredictionArena] Expert ${enabledExperts[i].id} failed prediction:`, res.reason);
      }
    }

    // Cache predictions for this round
    this.roundPredictionsStore.set(roundId, predictions);

    return this.buildActiveResponse(predictions, context);
  }

  /**
   * ON ACTUAL RESULT:
   * 1. Evaluate EVERY expert
   * 2. Update metrics
   * 3. Run prediction autopsy
   * 4. Update historical memory
   * 5. Update pattern memory
   * 6. Update regime & world model
   * 7. Every 10 resolved rounds: recalculate ranking & evaluate challenger promotion!
   */
  public async processResult(roundId: string, actualResult: RoundResult): Promise<{
    autopsy: any;
    championSwitched: boolean;
    switchRecord?: ChampionSwitchRecord;
  }> {
    this.initialize();

    const predictions = this.roundPredictionsStore.get(roundId) || [];
    const actualSize = actualResult.size;

    // 1. Evaluate EVERY expert
    for (const pred of predictions) {
      const isCorrect = pred.prediction === actualSize;
      const pActual = pred.probabilities[actualSize] ?? 0.5;
      const brier = Number(Math.pow(1 - pActual, 2).toFixed(4));
      const logLoss = Number((-Math.log(Math.max(0.001, pActual))).toFixed(4));

      const evaluation: EvaluatedRound = {
        roundId,
        expertId: pred.expertId,
        predicted: pred.prediction,
        probabilities: pred.probabilities,
        confidence: pred.confidence,
        actual: actualResult,
        wasCorrect: isCorrect,
        brier,
        logLoss,
        timestamp: Date.now()
      };

      this.rankingEngine.recordEvaluation(evaluation);
    }

    // Feedback to Fly Brain
    if (this.flyBrainExpertInstance) {
      this.flyBrainExpertInstance.postRoundFeedback(roundId, actualSize);
    }
    await globalFlyBrainArena.processResult(roundId, actualResult);

    // 2. Update Historical Memory
    this.historicalMemory.addRecord({
      ...actualResult,
      roundId,
      activeExpert: this.championManager.getActiveChampionId()
    });

    // 3. Update Pattern DNA
    const hist = this.historicalMemory.getAll();
    this.patternDNA.recordSequence(hist.slice(0, -1), actualSize);

    // 4. Update World Model & Regimes
    const worldAssessment = this.worldModel.assess(hist);
    const dominantReg = this.regimeClassifier.getDominantRegime(worldAssessment.regimeDistribution);

    // 5. Run Prediction Autopsy
    const activeChamp = this.championManager.getActiveChampionId();
    const poisonedPatterns = this.patternDNA.getPoisonedPatterns().map(p => p.pattern);
    const autopsy = this.autopsyEngine.runAutopsy({
      roundId,
      actualResult,
      expertPredictions: predictions,
      activeChampionId: activeChamp,
      dominantRegime: dominantReg.regime,
      poisonedPatternsFound: poisonedPatterns,
      dangerScore: 1.0 - worldAssessment.stabilityScore
    });

    // 5b. Evaluate Strategy Lab shadow candidates
    globalStrategyLab.evaluateShadowRound(
      {
        roundId,
        period: roundId,
        actualSide: actualSize,
        actualColor: actualResult.color,
        actualNumber: actualResult.number,
        timestamp: Date.now()
      },
      new Map(predictions.map(p => [p.expertId, p])),
      actualSize
    );

    // 6. Check 10-Round Tournament Recalculation Cycle
    const recalcTriggered = this.rankingEngine.notifyRoundResolved();
    let championSwitched = false;
    let switchRecord: ChampionSwitchRecord | undefined;

    if (recalcTriggered) {
      const promoResult = this.championManager.evaluatePromotion(this.rankingEngine, roundId);
      championSwitched = promoResult.switched;
      switchRecord = promoResult.record;
    }

    return {
      autopsy,
      championSwitched,
      switchRecord
    };
  }

  private buildActiveResponse(
    predictions: ExpertPrediction[],
    context: PredictionContext
  ): ArenaActivePredictionResponse {
    const activeChampionId = this.championManager.getActiveChampionId();
    const currentChallengerId = this.championManager.getActiveChallengerId();

    // Find active prediction
    let activePred = predictions.find(p => p.expertId === activeChampionId);

    // Fallback hierarchy if champion failed
    if (!activePred) {
      activePred = predictions.find(p => p.expertId === 'BASE_PREDICTOR') ||
                   predictions[0] || {
                     expertId: 'FALLBACK_BASELINE',
                     prediction: 'BIG',
                     probabilities: { BIG: 0.5, SMALL: 0.5, RED: 0.5, GREEN: 0.5 },
                     confidence: 0.5,
                     evidence: 0.1,
                     timestamp: Date.now()
                   };
    }

    // Meta analysis
    const hist = context.history;
    const world = this.worldModel.assess(hist, context.lossStreak ?? 0);
    const dominantReg = this.regimeClassifier.getDominantRegime(world.regimeDistribution);

    // Consensus
    const consensus = this.consensusController.calculateConsensus(
      predictions,
      new Map(this.rankingEngine.getAllMetrics().map(m => [m.expertId, m])),
      this.healthMap,
      dominantReg.regime
    );

    // God's Eye
    const champMetric = this.rankingEngine.getMetrics(activeChampionId);
    const challengerMetric = this.rankingEngine.getMetrics(currentChallengerId);
    const flyHealth = this.healthMap.get('FLY_BRAIN_RESERVOIR')?.status || 'HEALTHY';

    const godsEye = this.godsEye.evaluateState({
      disagreement: consensus.disagreement,
      regimeStability: world.stabilityScore,
      distributionShift: world.distributionDrift,
      baseFailureStreak: context.lossStreak ?? 0,
      championScore: champMetric?.finalScore ?? 0.60,
      challengerScore: challengerMetric?.finalScore ?? 0.58,
      flyHealthStatus: flyHealth,
      recentAccuracy: champMetric?.windows.last20.accuracy ?? 0.55
    });

    // Shield
    const shield = this.lossShield.evaluate(context.lossStreak ?? 0);

    // Future-state trajectory simulation
    const trajectories = this.futureStateEngine.simulate(
      hist,
      dominantReg.regime,
      activePred.probabilities['BIG'] ?? 0.5
    );

    const roundsSinceRanking = this.rankingEngine.getRoundsSinceRecalc();
    const nextRankingUpdate = 10 - roundsSinceRanking;

    return {
      prediction: activePred.prediction,
      probabilities: activePred.probabilities,
      confidence: activePred.confidence,
      activeExpert: activePred.expertId,
      rank: champMetric?.rank ?? 1,
      score: champMetric?.finalScore ?? 0.62,
      roundsSinceRanking,
      nextRankingUpdate,
      regime: dominantReg.regime,
      dangerScore: godsEye.masterDangerScore,
      metadata: {
        arena: {
          activeExpert: activePred.expertId,
          rank: champMetric?.rank ?? 1,
          score: champMetric?.finalScore ?? 0.62,
          confidence: activePred.confidence,
          roundsSinceRanking,
          nextRankingUpdate,
          rankingVersion: this.rankingEngine.getRankingVersion(),
          championDuration: 10,
          currentChallenger: currentChallengerId
        },
        godsEye,
        consensus,
        shield,
        trajectories
      }
    };
  }

  private updateHealthSuccess(expertId: string, latencyMs: number): void {
    const h = this.healthMap.get(expertId);
    if (!h) return;
    h.totalCalls++;
    h.latencyMs = Number((h.latencyMs * 0.8 + latencyMs * 0.2).toFixed(2));
    h.consecutiveErrors = 0;
    if (h.status === 'DEGRADED' || h.status === 'RECOVERING') {
      h.status = 'HEALTHY';
    }
  }

  private updateHealthFailure(expertId: string, reason: string): void {
    const h = this.healthMap.get(expertId);
    if (!h) return;
    h.totalCalls++;
    h.failedCalls++;
    h.consecutiveErrors++;
    h.lastFailureTime = Date.now();
    h.lastFailureReason = reason;
    if (h.consecutiveErrors >= 3) {
      h.status = 'DEGRADED';
    }
    if (h.consecutiveErrors >= 6) {
      h.status = 'UNTRUSTED';
    }
  }

  public getHealthMap(): Map<string, ExpertHealth> {
    return this.healthMap;
  }
}

export const globalPredictionArena = new PredictionArena();
