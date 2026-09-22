/**
 * Prioritized Experience Replay Buffer for Fly Brain Models
 * Implements Section 34:
 * Priority based on |predictionError| + novelty + |RPE|.
 */

import type { FlyExperience } from '../flyTypes.ts';

export class PrioritizedExperienceReplay {
  private buffer: FlyExperience[] = [];
  private priorities: number[] = [];
  private maxCapacity: number;

  constructor(maxCapacity = 300) {
    this.maxCapacity = maxCapacity;
  }

  public addExperience(exp: FlyExperience): void {
    // Priority = |error| + novelty*0.5 + |rpe|*0.5
    const priority = Math.abs(exp.predictionError) + exp.noveltySignal * 0.5 + Math.abs(exp.rewardPredictionError) * 0.5 + 0.05;

    this.buffer.push(exp);
    this.priorities.push(priority);

    if (this.buffer.length > this.maxCapacity) {
      this.buffer.shift();
      this.priorities.shift();
    }
  }

  public sampleBatch(batchSize = 12): FlyExperience[] {
    if (this.buffer.length <= batchSize) {
      return [...this.buffer];
    }

    // Weighted random sampling
    const sumPriority = this.priorities.reduce((a, b) => a + b, 0);
    const selected: FlyExperience[] = [];

    for (let b = 0; b < batchSize; b++) {
      let r = Math.random() * sumPriority;
      for (let i = 0; i < this.buffer.length; i++) {
        r -= this.priorities[i];
        if (r <= 0) {
          selected.push(this.buffer[i]);
          break;
        }
      }
    }

    return selected;
  }

  public size(): number {
    return this.buffer.length;
  }

  public getAll(): FlyExperience[] {
    return [...this.buffer];
  }
}
