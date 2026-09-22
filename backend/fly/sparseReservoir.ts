/**
 * Sparse Recurrent LIF Reservoir
 * Efficient Compressed Sparse Row (CSR) representation of recurrent synapses
 */

import { LifNeuronPopulation } from './lifNeuron.ts';
import type { LifConfig } from './lifNeuron.ts';

export interface CSRMatrix {
  values: Float32Array;
  colIndices: Int32Array;
  rowPointers: Int32Array;
  rows: number;
  cols: number;
  nonZeros: number;
}

export class SparseReservoir {
  public readonly neuronCount: number;
  public readonly population: LifNeuronPopulation;
  public readonly recurrentWeights: CSRMatrix;
  public readonly inputWeights: Float32Array; // (inputDim x neuronCount) flattened
  public readonly inputDim: number;

  private stateBuffer: Float32Array;

  constructor(
    neuronCount = 1000,
    inputDim = 16,
    sparsity = 0.08,
    spectralRadius = 0.95,
    lifConfig?: Partial<LifConfig>
  ) {
    this.neuronCount = neuronCount;
    this.inputDim = inputDim;
    this.population = new LifNeuronPopulation(neuronCount, lifConfig);
    this.stateBuffer = new Float32Array(neuronCount);

    // Build sparse recurrent CSR matrix
    this.recurrentWeights = this.generateSparseCSR(neuronCount, sparsity, spectralRadius);

    // Build random input projection
    this.inputWeights = new Float32Array(inputDim * neuronCount);
    for (let i = 0; i < this.inputWeights.length; i++) {
      this.inputWeights[i] = (Math.random() - 0.5) * 0.4;
    }
  }

  private generateSparseCSR(n: number, sparsity: number, spectralRadius: number): CSRMatrix {
    const rowPointers = new Int32Array(n + 1);
    const expectedNonZeros = Math.floor(n * n * sparsity);
    const colList: number[] = [];
    const valList: number[] = [];

    let currentPtr = 0;
    rowPointers[0] = 0;

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (Math.random() < sparsity) {
          colList.push(c);
          // Zero-mean Gaussian weight
          const w = (Math.random() + Math.random() - 1.0) * (spectralRadius / Math.sqrt(n * sparsity));
          valList.push(w);
          currentPtr++;
        }
      }
      rowPointers[r + 1] = currentPtr;
    }

    const values = new Float32Array(valList);
    const colIndices = new Int32Array(colList);

    return {
      values,
      colIndices,
      rowPointers,
      rows: n,
      cols: n,
      nonZeros: currentPtr
    };
  }

  public step(inputs: number[]): Float32Array {
    const n = this.neuronCount;
    const inputCurrents = new Float32Array(n);
    const recurrentCurrents = new Float32Array(n);

    // 1. Project external inputs
    for (let inIdx = 0; inIdx < Math.min(inputs.length, this.inputDim); inIdx++) {
      const u = inputs[inIdx];
      const offset = inIdx * n;
      for (let j = 0; j < n; j++) {
        inputCurrents[j] += u * this.inputWeights[offset + j];
      }
    }

    // 2. Sparse matrix-vector product: recurrentCurrents = W * spikes[t-1]
    const spk = this.population.spikes;
    const { values, colIndices, rowPointers } = this.recurrentWeights;

    for (let r = 0; r < n; r++) {
      let sum = 0;
      const start = rowPointers[r];
      const end = rowPointers[r + 1];
      for (let p = start; p < end; p++) {
        const col = colIndices[p];
        if (spk[col] === 1) {
          sum += values[p];
        }
      }
      recurrentCurrents[r] = sum;
    }

    // 3. Step LIF population
    const newSpikes = this.population.step(inputCurrents, recurrentCurrents);

    // 4. Update temporal low-pass filtered rate state
    for (let i = 0; i < n; i++) {
      this.stateBuffer[i] = this.stateBuffer[i] * 0.9 + newSpikes[i] * 0.1;
    }

    return this.stateBuffer;
  }

  public getState(): Float32Array {
    return this.stateBuffer;
  }

  public getFiringRate(): number {
    let sum = 0;
    for (let i = 0; i < this.neuronCount; i++) {
      sum += this.population.spikes[i];
    }
    return sum / this.neuronCount;
  }

  public reset(): void {
    this.population.resetState();
    this.stateBuffer.fill(0);
  }
}
