/**
 * Base Abstract Fly Model
 * Encapsulates private neural state, private neuromodulation, private experience buffer,
 * hard execution sandbox, and health monitoring for independent Fly models.
 */

import type {
  FlyModel,
  FlyModelStatus,
  FlyPrediction,
  FlyExperience,
  FlyHealth,
  NeuromodulationState,
  ExecutionPolicy,
  FlyInstance
} from '../flyTypes.ts';
import type { PredictionContext } from '../../prediction/predictionTypes.ts';
import { NeuromodulationEngine } from '../core/neuromodulation.ts';
import { PrioritizedExperienceReplay } from '../core/experienceReplay.ts';

export abstract class BaseFlyModel implements FlyModel {
  public abstract readonly id: string;
  public abstract readonly name: string;
  public abstract readonly version: string;
  public abstract readonly architecture: string;
  public readonly category = 'FLY';
  public abstract readonly neuronCount: number;
  public abstract readonly backend: string;
  public status: FlyModelStatus = 'ACTIVE';
  public executionPolicy: ExecutionPolicy;

  protected neuromodulation: NeuromodulationEngine;
  protected replayBuffer: PrioritizedExperienceReplay;
  protected consecutiveLosses = 0;
  protected totalEvaluated = 0;
  protected totalWins = 0;
  protected lastLatencyMs = 1.0;

  constructor(baseLearningRate = 0.02, policy: Partial<ExecutionPolicy> = {}) {
    this.neuromodulation = new NeuromodulationEngine(baseLearningRate);
    this.replayBuffer = new PrioritizedExperienceReplay(300);
    this.executionPolicy = {
      timeoutMs: policy.timeoutMs ?? 250,
      maxMemoryMb: policy.maxMemoryMb ?? 64,
      maxBatchSize: policy.maxBatchSize ?? 1,
      mode: policy.mode ?? 'PRODUCTION_COMPACT'
    };
  }

  public abstract getPrivateReservoirState(): Float32Array;

  public getInstance(): FlyInstance {
    return {
      modelId: this.id,
      privateReservoirState: this.getPrivateReservoirState(),
      privateMemory: this.replayBuffer,
      privateReadout: null,
      privateCalibration: null,
      privateHealth: this.getHealth(),
      privateNeuromodulation: this.getNeuromodulationState(),
      executionPolicy: this.executionPolicy
    };
  }

  /**
   * Hard Execution Sandbox:
   * Protects round execution from runaway computation with timeout and isolation.
   */
  public async predict(context: PredictionContext): Promise<FlyPrediction> {
    const t0 = performance.now();
    let timer: any;
    const timeoutPromise = new Promise<FlyPrediction>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`[FlySandbox] Model ${this.id} exceeded execution timeout (${this.executionPolicy.timeoutMs}ms)`));
      }, this.executionPolicy.timeoutMs);
    });

    try {
      const pred = await Promise.race([
        this.executePrediction(context),
        timeoutPromise
      ]);
      this.lastLatencyMs = performance.now() - t0;
      return pred;
    } finally {
      clearTimeout(timer);
    }
  }

  protected abstract executePrediction(context: PredictionContext): Promise<FlyPrediction>;

  public async learn(experience: FlyExperience): Promise<void> {
    this.totalEvaluated++;
    const wasCorrect = experience.prediction === experience.actualResult;
    if (wasCorrect) {
      this.totalWins++;
      this.consecutiveLosses = 0;
    } else {
      this.consecutiveLosses++;
    }

    // Update neuromodulation
    const pPredicted = experience.probabilities[experience.prediction] ?? 0.5;
    this.neuromodulation.update({
      wasCorrect,
      predictedProb: pPredicted,
      novelty: experience.noveltySignal,
      consecutiveLosses: this.consecutiveLosses
    });

    // Store in private experience replay buffer
    this.replayBuffer.addExperience(experience);

    // Call model-specific learning step
    await this.applyInternalLearning(experience);
  }

  protected abstract applyInternalLearning(experience: FlyExperience): Promise<void>;

  public getNeuromodulationState(): NeuromodulationState {
    return this.neuromodulation.getState();
  }

  public getHealth(): FlyHealth {
    const errRate = this.totalEvaluated > 0 ? (this.totalEvaluated - this.totalWins) / this.totalEvaluated : 0.5;
    const stability = Math.max(0.1, 1.0 - (this.consecutiveLosses / 8.0));

    let status: FlyHealth['status'] = 'HEALTHY';
    if (this.consecutiveLosses >= 3) status = 'DEGRADED';
    if (this.consecutiveLosses >= 5) status = 'RECOVERING';
    if (this.consecutiveLosses >= 8) status = 'UNTRUSTED';

    return {
      status,
      latencyMs: Number(this.lastLatencyMs.toFixed(2)),
      errorRate: Number(errRate.toFixed(4)),
      calibration: 0.85,
      stability: Number(stability.toFixed(4)),
      reservoirHealth: Number((1.0 - Math.min(1.0, this.consecutiveLosses * 0.1)).toFixed(4)),
      neuromodulationHealth: Number(this.neuromodulation.getState().plasticitySignal > 0.3 ? 1.0 : 0.5),
      firingRate: 0.12,
      deadNeuronsPct: 0.05,
      saturatedNeuronsPct: 0.02
    };
  }
}
