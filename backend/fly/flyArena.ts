/**
 * FLY BRAIN SUB-ARENA COORDINATOR
 * Implements Sections 2, 3, 16, 42–47 of the Fly Master System.
 * Orchestrates 12 independent Fly models, Fly-only ranking tournament,
 * Fly Champion/Challenger tracking, Fly consensus, and diversity monitoring.
 */

import type { FlyModel, FlyPrediction, FlyExperience, FlyHealth } from './flyTypes.ts';
import type { PredictionContext, RoundResult, PredictionExpert, ExpertPrediction } from '../prediction/predictionTypes.ts';
import { FlyRankingEngine } from './flyRankingEngine.ts';
import { FlyChampionManager } from './flyChampionManager.ts';
import { FlyConsensusExpert } from './flyConsensus.ts';
import { FlyDiversityEngine } from './flyDiversityEngine.ts';
import { FlyAutopsyEngine } from './flyAutopsy.ts';

// Import all 12 Independent Fly Models
import {
  FlyLifClassicModel,
  FlyLifConnectomeModel,
  FlySparseReservoirModel,
  FlyNeuromodulatedReservoirModel,
  FlyStdpReservoirModel,
  FlyRewardGatedModel,
  FlyMushroomBodyModel,
  FlyVisualLifModel,
  FlyTemporalSpikingModel,
  FlyConnectomeReservoirModel,
  FlyHybridSnnModel,
  FlyGruSnnHybridModel
} from './models/flyModelsPool.ts';

/**
 * Adapter wrapping a FlyModel into a PredictionExpert so it can compete
 * directly in the Global Arena alongside classical/neural models.
 */
export class FlyModelExpertAdapter implements PredictionExpert {
  public readonly id: string;
  public readonly name: string;
  public readonly version: string;
  public readonly category = 'FLY' as const;
  private flyModel: FlyModel;
  private arenaRef: FlyBrainArena | null = null;

  public get enabled(): boolean {
    return this.flyModel.status === 'ACTIVE';
  }

  constructor(flyModel: FlyModel, arena?: FlyBrainArena) {
    this.flyModel = flyModel;
    this.arenaRef = arena || null;
    this.id = flyModel.id;
    this.name = flyModel.name;
    this.version = flyModel.version;
  }

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const flyPred = await this.flyModel.predict(context);
    if (this.arenaRef) {
      this.arenaRef.recordPrediction(context.roundId, flyPred);
    }
    return {
      expertId: this.id,
      prediction: flyPred.prediction,
      probabilities: flyPred.probabilities,
      confidence: flyPred.confidence,
      evidence: flyPred.evidence,
      regime: flyPred.regime,
      timestamp: flyPred.timestamp,
      modelVersion: flyPred.modelVersion,
      metadata: {
        neuromodulation: flyPred.neuromodulationState,
        novelty: flyPred.novelty
      }
    };
  }

  public getFlyModel(): FlyModel {
    return this.flyModel;
  }
}

export class FlyBrainArena {
  public models: Map<string, FlyModel> = new Map();
  public rankingEngine: FlyRankingEngine;
  public championManager: FlyChampionManager;
  public consensusExpert: FlyConsensusExpert;
  public diversityEngine: FlyDiversityEngine;
  public autopsyEngine: FlyAutopsyEngine;

  private lastRoundPredictions: Map<string, FlyPrediction[]> = new Map();
  private initialized = false;

  constructor() {
    this.rankingEngine = new FlyRankingEngine();
    this.championManager = new FlyChampionManager();
    this.consensusExpert = new FlyConsensusExpert();
    this.diversityEngine = new FlyDiversityEngine();
    this.autopsyEngine = new FlyAutopsyEngine();
  }

  public initialize(): void {
    if (this.initialized) return;

    // Register all 12 genuinely distinct Fly models
    this.registerModel(new FlyLifClassicModel());
    this.registerModel(new FlyLifConnectomeModel());
    this.registerModel(new FlySparseReservoirModel());
    this.registerModel(new FlyNeuromodulatedReservoirModel());
    this.registerModel(new FlyStdpReservoirModel());
    this.registerModel(new FlyRewardGatedModel());
    this.registerModel(new FlyMushroomBodyModel());
    this.registerModel(new FlyVisualLifModel());
    this.registerModel(new FlyTemporalSpikingModel());
    this.registerModel(new FlyConnectomeReservoirModel());
    this.registerModel(new FlyHybridSnnModel());
    this.registerModel(new FlyGruSnnHybridModel());

    this.initialized = true;
    console.log(`[FlyBrainArena] Initialized with ${this.models.size} independent Fly brain models.`);
  }

  public registerModel(model: FlyModel): void {
    this.models.set(model.id, model);
  }

  public getModel(id: string): FlyModel | undefined {
    return this.models.get(id);
  }

  public getAllModels(): FlyModel[] {
    return Array.from(this.models.values());
  }

  public getAdapters(): FlyModelExpertAdapter[] {
    this.initialize();
    return Array.from(this.models.values()).map(m => new FlyModelExpertAdapter(m, this));
  }

  public recordPrediction(roundId: string, prediction: FlyPrediction): void {
    let list = this.lastRoundPredictions.get(roundId);
    if (!list) {
      list = [];
      this.lastRoundPredictions.set(roundId, list);
    }
    const existingIdx = list.findIndex(p => p.flyModelId === prediction.flyModelId);
    if (existingIdx >= 0) {
      list[existingIdx] = prediction;
    } else {
      list.push(prediction);
    }
    this.consensusExpert.updateFlyPredictions(list);
    this.diversityEngine.recordRound(roundId, list);
  }

  /**
   * ON NEW ROUND:
   * Runs EVERY active Fly model independently using Promise.allSettled()
   */
  public async onNewRound(context: PredictionContext): Promise<FlyPrediction[]> {
    this.initialize();

    const roundId = context.roundId;
    const runningModels = Array.from(this.models.values()).filter(m => m.status === 'ACTIVE' || m.status === 'SHADOW');

    const results = await Promise.allSettled(runningModels.map(m => m.predict(context)));
    const predictions: FlyPrediction[] = [];

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (res.status === 'fulfilled') {
        predictions.push(res.value);
      } else {
        console.warn(`[FlyBrainArena] Fly model ${runningModels[i].id} prediction failed:`, res.reason);
      }
    }

    this.lastRoundPredictions.set(roundId, predictions);

    // Feed to Fly Consensus expert
    this.consensusExpert.updateFlyPredictions(predictions);

    // Feed to Diversity engine
    this.diversityEngine.recordRound(roundId, predictions);

    return predictions;
  }

  /**
   * ON ACTUAL RESULT:
   * Evaluates each Fly model independently, updates neuromodulation, experience buffers,
   * rankings, and evaluates Fly Champion/Challenger promotion.
   */
  public async processResult(roundId: string, actualResult: RoundResult): Promise<void> {
    this.initialize();

    const predictions = this.lastRoundPredictions.get(roundId) || [];
    const actualSize = actualResult.size;

    this.diversityEngine.recordActual(roundId, actualSize);

    for (const pred of predictions) {
      const model = this.models.get(pred.flyModelId);
      if (!model) continue;

      const wasCorrect = pred.prediction === actualSize;
      const pActual = pred.probabilities[actualSize] ?? 0.5;
      const brier = Number(Math.pow(1 - pActual, 2).toFixed(4));
      const logLoss = Number((-Math.log(Math.max(0.001, pActual))).toFixed(4));

      // Record in Fly ranking engine
      this.rankingEngine.recordEvaluation({
        roundId,
        flyModelId: pred.flyModelId,
        predicted: pred.prediction,
        probabilities: pred.probabilities,
        confidence: pred.confidence,
        actual: actualResult,
        wasCorrect,
        brier,
        logLoss,
        timestamp: Date.now()
      });

      // Run independent Fly autopsy
      this.autopsyEngine.runAutopsy(roundId, pred, actualSize, pred.novelty);

      // Create private experience record for model learning
      const exp: FlyExperience = {
        stateHash: `state_${roundId}`,
        inputFeatures: {},
        reservoirStateHash: `res_${roundId}`,
        prediction: pred.prediction,
        probabilities: pred.probabilities,
        actualResult: actualSize,
        predictionError: Number((1.0 - pActual).toFixed(4)),
        rewardSignal: wasCorrect ? 1.0 : -1.0,
        rewardPredictionError: Number(((wasCorrect ? 1.0 : -1.0) - 0.5).toFixed(4)),
        aversiveSignal: wasCorrect ? 0.0 : 0.6,
        noveltySignal: pred.novelty,
        arousalSignal: Math.min(1.0, pred.novelty * 0.5 + (1 - pActual) * 0.5),
        regime: actualResult.size,
        timestamp: Date.now()
      };

      // Model learns independently
      await model.learn(exp);
    }

    // Check 10-round Fly tournament recalculation
    const recalcTriggered = this.rankingEngine.notifyRoundResolved();
    if (recalcTriggered) {
      const healthMap = new Map<string, FlyHealth>();
      for (const [id, m] of this.models.entries()) {
        healthMap.set(id, m.getHealth());
      }
      this.rankingEngine.recalculateAll(healthMap);
      const promoResult = this.championManager.evaluatePromotion(this.rankingEngine, roundId);
      if (promoResult.switched && promoResult.record) {
        const newChamp = this.models.get(promoResult.record.to);
        if (newChamp && newChamp.status === 'SHADOW') {
          newChamp.status = 'ACTIVE';
          newChamp.executionPolicy.mode = 'PRODUCTION_COMPACT';
          console.log(`[FlyBrainArena] Shadow model ${newChamp.id} earned promotion to ACTIVE status based on validated out-of-sample evidence!`);
        }
      }
    }
  }

  public getFlyChampionId(): string {
    return this.championManager.getActiveChampionId();
  }

  public getFlyChallengerId(): string {
    return this.championManager.getActiveChallengerId();
  }
}

export const globalFlyBrainArena = new FlyBrainArena();
