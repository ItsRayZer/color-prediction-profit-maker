/**
 * FLY_BRAIN_RESERVOIR Prediction Expert
 * Compact 1000-neuron Drosophila-inspired Leaky Integrate-and-Fire reservoir
 */

import type { PredictionExpert, PredictionContext, ExpertPrediction } from '../prediction/predictionTypes.ts';
import { SparseReservoir } from './sparseReservoir.ts';
import { FlyInputEncoder } from './encoder.ts';
import { ReadoutLayer } from './readout.ts';
import { ProbabilityCalibrator } from './calibration.ts';
import { ReservoirHealthMonitor } from './health.ts';
import type { ReservoirHealthMetrics } from './health.ts';
import { FlyReservoirTrainer } from './trainer.ts';

export class FlyBrainReservoirExpert implements PredictionExpert {
  public readonly id = 'FLY_BRAIN_RESERVOIR';
  public readonly name = 'Drosophila LIF Spiking Reservoir (1000 Neurons)';
  public readonly version = '1.0.0-compact';
  public readonly category = 'FLY' as const;
  public enabled = true;

  private reservoir: SparseReservoir;
  private encoder: FlyInputEncoder;
  private readout: ReadoutLayer;
  private calibrator: ProbabilityCalibrator;
  private healthMonitor: ReservoirHealthMonitor;
  private trainer: FlyReservoirTrainer;

  private lastState: Float32Array | null = null;
  private lastHealth: ReservoirHealthMetrics | null = null;

  constructor() {
    // 1000 LIF neurons, 16 input features, 8% sparse recurrent CSR connectivity
    this.reservoir = new SparseReservoir(1000, 16, 0.08, 0.95, {
      leak: 0.88,
      threshold: 1.0,
      reset: 0.0,
      refractorySteps: 2
    });
    this.encoder = new FlyInputEncoder();
    this.readout = new ReadoutLayer(1000, 0.02, 0.01);
    this.calibrator = new ProbabilityCalibrator();
    this.healthMonitor = new ReservoirHealthMonitor();
    this.trainer = new FlyReservoirTrainer();
  }

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const t0 = performance.now();
    const hist = context.history;

    // 1. Encode context features
    const features = this.encoder.encode(hist, context.lossStreak, context.currentRegime);

    // 2. Reservoir step
    const state = this.reservoir.step(features);
    this.lastState = new Float32Array(state);

    // 3. Readout raw probability for 'BIG'
    const rawProb = this.readout.predictProbability(state);

    // 4. Calibration
    const calProbBig = this.calibrator.calibrate(rawProb);
    const calProbSmall = Number((1.0 - calProbBig).toFixed(4));
    const pred = calProbBig >= 0.5 ? 'BIG' : 'SMALL';
    const conf = Math.max(calProbBig, calProbSmall);

    const latency = performance.now() - t0;

    // 5. Evaluate health
    this.lastHealth = this.healthMonitor.evaluateHealth(
      this.reservoir.getFiringRate(),
      this.reservoir.population.spikes,
      state,
      latency,
      this.readout.weights
    );

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: {
        BIG: calProbBig,
        SMALL: calProbSmall,
        RED: 0.5,
        GREEN: 0.5
      },
      confidence: conf,
      evidence: Number((1.0 - this.lastHealth.deadNeuronsPct).toFixed(4)),
      sampleSize: hist.length,
      regime: context.currentRegime,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: {
        rawProbBig: Number(rawProb.toFixed(4)),
        firingRate: this.lastHealth.firingRate,
        healthStatus: this.lastHealth.status,
        latencyMs: this.lastHealth.latencyMs,
        activeNeurons: 1000 - Math.round(this.lastHealth.deadNeuronsPct * 1000)
      }
    };
  }

  public postRoundFeedback(roundId: string, actualResult: 'BIG' | 'SMALL'): void {
    if (!this.lastState) return;

    const targetVal: 1 | 0 = actualResult === 'BIG' ? 1 : 0;
    this.trainer.recordExperience(this.lastState, targetVal, roundId);
    this.trainer.trainStep(this.readout, 16);

    const wasCorrect = (this.lastHealth?.status !== 'UNTRUSTED') &&
      ((this.readout.predictProbability(this.lastState) >= 0.5 ? 'BIG' : 'SMALL') === actualResult);

    this.healthMonitor.recordOutcome(wasCorrect);
  }

  public getHealth(): ReservoirHealthMetrics | null {
    return this.lastHealth;
  }
}
