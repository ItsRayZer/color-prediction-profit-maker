/**
 * Spike-Timing-Dependent Plasticity (STDP) Engine
 * Implements biophysical synaptic plasticity:
 * Pre before Post: Long-Term Potentiation (LTP): DeltaW = A_plus * exp(-DeltaT / tau_plus)
 * Post before Pre: Long-Term Depression (LTD): DeltaW = -A_minus * exp(DeltaT / tau_minus)
 */

export interface StdpConfig {
  aPlus: number;   // Potentiation amplitude (e.g. 0.005)
  aMinus: number;  // Depression amplitude (e.g. 0.0055)
  tauPlus: number; // Time constant for LTP (e.g. 20ms)
  tauMinus: number;// Time constant for LTD (e.g. 20ms)
  wMin: number;    // Min synaptic weight
  wMax: number;    // Max synaptic weight
}

export class StdpPlasticityEngine {
  public readonly config: StdpConfig;
  private lastSpikeTime: Float32Array;

  constructor(neuronCount: number, config?: Partial<StdpConfig>) {
    this.config = {
      aPlus: config?.aPlus ?? 0.005,
      aMinus: config?.aMinus ?? 0.0055,
      tauPlus: config?.tauPlus ?? 20.0,
      tauMinus: config?.tauMinus ?? 20.0,
      wMin: config?.wMin ?? -0.5,
      wMax: config?.wMax ?? 0.5
    };
    this.lastSpikeTime = new Float32Array(neuronCount).fill(-1000);
  }

  public updateWeights(
    spikes: Uint8Array,
    currentTimeMs: number,
    colIndices: Int32Array,
    rowPointers: Int32Array,
    values: Float32Array,
    neuromodulationMultiplier = 1.0
  ): number {
    const { aPlus, aMinus, tauPlus, tauMinus, wMin, wMax } = this.config;
    const n = spikes.length;
    let totalDelta = 0;

    for (let post = 0; post < n; post++) {
      if (spikes[post] === 1) {
        const postTime = currentTimeMs;
        const start = rowPointers[post];
        const end = rowPointers[post + 1];

        for (let p = start; p < end; p++) {
          const pre = colIndices[p];
          const preTime = this.lastSpikeTime[pre];
          const deltaT = postTime - preTime;

          if (deltaT > 0 && deltaT < 50) {
            // LTP
            const dw = aPlus * Math.exp(-deltaT / tauPlus) * neuromodulationMultiplier;
            values[p] = Math.min(wMax, values[p] + dw);
            totalDelta += Math.abs(dw);
          } else if (deltaT < 0 && deltaT > -50) {
            // LTD
            const dw = -aMinus * Math.exp(deltaT / tauMinus) * neuromodulationMultiplier;
            values[p] = Math.max(wMin, values[p] + dw);
            totalDelta += Math.abs(dw);
          }
        }
        this.lastSpikeTime[post] = postTime;
      }
    }

    return totalDelta;
  }
}
