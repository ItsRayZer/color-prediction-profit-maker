/**
 * Plugin Architecture Expert Registry for Adaptive Prediction Arena
 */

import type { PredictionExpert } from '../prediction/predictionTypes.ts';

export class ExpertRegistry {
  private experts: Map<string, PredictionExpert> = new Map();

  public register(expert: PredictionExpert): void {
    if (this.experts.has(expert.id)) {
      console.warn(`[ExpertRegistry] Overwriting existing expert registration: ${expert.id}`);
    }
    this.experts.set(expert.id, expert);
  }

  public unregister(expertId: string): boolean {
    return this.experts.delete(expertId);
  }

  public get(expertId: string): PredictionExpert | undefined {
    return this.experts.get(expertId);
  }

  public has(expertId: string): boolean {
    return this.experts.has(expertId);
  }

  public getAll(): PredictionExpert[] {
    return Array.from(this.experts.values());
  }

  public getEnabled(): PredictionExpert[] {
    return Array.from(this.experts.values()).filter(e => e.enabled);
  }

  public setEnabled(expertId: string, enabled: boolean): boolean {
    const expert = this.experts.get(expertId);
    if (!expert) return false;
    expert.enabled = enabled;
    return true;
  }

  public getByCategory(category: string): PredictionExpert[] {
    return Array.from(this.experts.values()).filter(e => e.category === category);
  }

  public getCount(): number {
    return this.experts.size;
  }
}

export const globalExpertRegistry = new ExpertRegistry();
