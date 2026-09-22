/**
 * Leaky Integrate-and-Fire (LIF) Neuron Model
 * Implements Drosophila-inspired membrane dynamics:
 * V[t+1] = leak * V[t] + input[t] + recurrent[t]
 * If V >= threshold: spike = 1, V = reset, refractory counter set.
 */

export interface LifConfig {
  leak: number;           // e.g. 0.88
  threshold: number;      // e.g. 1.0 (normalized)
  reset: number;          // e.g. 0.0 (normalized)
  refractorySteps: number;// e.g. 2
}

export class LifNeuronPopulation {
  public readonly count: number;
  public readonly config: LifConfig;

  public membranePotentials: Float32Array;
  public refractoryCounters: Int16Array;
  public spikes: Uint8Array;

  constructor(count: number, config?: Partial<LifConfig>) {
    this.count = count;
    this.config = {
      leak: config?.leak ?? 0.88,
      threshold: config?.threshold ?? 1.0,
      reset: config?.reset ?? 0.0,
      refractorySteps: config?.refractorySteps ?? 2
    };

    this.membranePotentials = new Float32Array(count);
    this.refractoryCounters = new Int16Array(count);
    this.spikes = new Uint8Array(count);
  }

  public step(inputs: Float32Array, recurrent: Float32Array): Uint8Array {
    const { leak, threshold, reset, refractorySteps } = this.config;
    const v = this.membranePotentials;
    const refr = this.refractoryCounters;
    const spk = this.spikes;

    for (let i = 0; i < this.count; i++) {
      if (refr[i] > 0) {
        refr[i]--;
        v[i] = reset;
        spk[i] = 0;
        continue;
      }

      // V[t+1] = leak * V[t] + input[t] + recurrent[t]
      const nextV = leak * v[i] + inputs[i] + recurrent[i];

      if (nextV >= threshold) {
        spk[i] = 1;
        v[i] = reset;
        refr[i] = refractorySteps;
      } else {
        spk[i] = 0;
        v[i] = Math.max(-0.5, nextV); // Lower bound
      }
    }

    return spk;
  }

  public resetState(): void {
    this.membranePotentials.fill(this.config.reset);
    this.refractoryCounters.fill(0);
    this.spikes.fill(0);
  }
}
