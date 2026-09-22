/**
 * Fly Brain Reservoir Health Monitor
 * Tracks: firing rate, dead neurons, saturated neurons, state variance, latency, calibration.
 */

import type { ExpertHealthStatus } from '../prediction/predictionTypes.ts';

export interface ReservoirHealthMetrics {
  status: ExpertHealthStatus;
  firingRate: number;
  deadNeuronsPct: number;
  saturatedNeuronsPct: number;
  stateVariance: number;
  entropy: number;
  latencyMs: number;
  consecutiveFailures: number;
  readoutNorm: number;
}

export class ReservoirHealthMonitor {
  private lastLatency = 1.0;
  private consecutiveFailures = 0;

  public evaluateHealth(
    firingRate: number,
    spikes: Uint8Array,
    stateBuffer: Float32Array,
    latencyMs: number,
    readoutWeights: Float32Array
  ): ReservoirHealthMetrics {
    this.lastLatency = latencyMs;
    const n = spikes.length;

    let deadCount = 0;
    let saturatedCount = 0;
    let sumVar = 0;
    let sumState = 0;

    for (let i = 0; i < n; i++) {
      const v = stateBuffer[i];
      sumState += v;
      if (v < 0.001) deadCount++;
      if (v > 0.8) saturatedCount++;
    }

    const meanState = n > 0 ? sumState / n : 0;
    for (let i = 0; i < n; i++) {
      sumVar += Math.pow(stateBuffer[i] - meanState, 2);
    }
    const stateVariance = n > 0 ? sumVar / n : 0;

    const deadNeuronsPct = n > 0 ? deadCount / n : 0;
    const saturatedNeuronsPct = n > 0 ? saturatedCount / n : 0;

    // Readout L2 norm
    let sumW2 = 0;
    for (let i = 0; i < readoutWeights.length; i++) {
      sumW2 += readoutWeights[i] * readoutWeights[i];
    }
    const readoutNorm = Math.sqrt(sumW2);

    // State entropy
    const p = Math.max(0.01, Math.min(0.99, firingRate));
    const entropy = -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));

    // Determine status
    let status: ExpertHealthStatus = 'HEALTHY';
    if (deadNeuronsPct > 0.7 || saturatedNeuronsPct > 0.5 || firingRate < 0.005 || firingRate > 0.6) {
      status = 'DEGRADED';
    }
    if (this.consecutiveFailures >= 4) {
      status = 'RECOVERING';
    }
    if (this.consecutiveFailures >= 7 || Number.isNaN(readoutNorm)) {
      status = 'UNTRUSTED';
    }

    return {
      status,
      firingRate: Number(firingRate.toFixed(4)),
      deadNeuronsPct: Number(deadNeuronsPct.toFixed(4)),
      saturatedNeuronsPct: Number(saturatedNeuronsPct.toFixed(4)),
      stateVariance: Number(stateVariance.toFixed(6)),
      entropy: Number(entropy.toFixed(4)),
      latencyMs: Number(latencyMs.toFixed(2)),
      consecutiveFailures: this.consecutiveFailures,
      readoutNorm: Number(readoutNorm.toFixed(4))
    };
  }

  public recordOutcome(wasCorrect: boolean): void {
    if (wasCorrect) {
      this.consecutiveFailures = Math.max(0, this.consecutiveFailures - 1);
    } else {
      this.consecutiveFailures++;
    }
  }
}
