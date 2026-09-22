/**
 * Fly Brain Reservoir Readout Trainer
 * Replay buffer & regularized mini-batch updates
 */

import { ReadoutLayer } from './readout.ts';

export interface ReplayItem {
  reservoirState: Float32Array;
  target: 1 | 0; // 1 = BIG, 0 = SMALL
  roundId: string;
  timestamp: number;
}

export class FlyReservoirTrainer {
  private buffer: ReplayItem[] = [];
  private maxBufferSize = 500;

  public recordExperience(reservoirState: Float32Array, target: 1 | 0, roundId: string): void {
    // Clone state
    const copyState = new Float32Array(reservoirState);
    this.buffer.push({
      reservoirState: copyState,
      target,
      roundId,
      timestamp: Date.now()
    });

    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }
  }

  public trainStep(readout: ReadoutLayer, batchSize = 16): number {
    if (this.buffer.length < 8) return 0.0;

    const actualBatch = Math.min(batchSize, this.buffer.length);
    let totalError = 0;

    // Sample mini-batch randomly
    for (let b = 0; b < actualBatch; b++) {
      const idx = Math.floor(Math.random() * this.buffer.length);
      const item = this.buffer[idx];
      const err = readout.update(item.reservoirState, item.target);
      totalError += err;
    }

    return totalError / actualBatch;
  }

  public getBufferSize(): number {
    return this.buffer.length;
  }
}
