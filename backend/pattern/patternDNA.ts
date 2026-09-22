/**
 * Pattern DNA & Poison Detection System
 * Implements Sections 26 & 27:
 * Suffix pattern lengths 2 to 12.
 * Lifecycle: BORN -> TESTED -> CONFIRMED -> PEAK -> DECAYING -> DEAD
 * Poison tracking and recovery.
 */

export type PatternLifecycle = 'BORN' | 'TESTED' | 'CONFIRMED' | 'PEAK' | 'DECAYING' | 'DEAD';

export interface PatternRecord {
  pattern: string;
  length: number;
  occurrences: number;
  nextBigCount: number;
  nextSmallCount: number;
  recentSuccessCount: number;
  recentFailureCount: number;
  lifetimeAccuracy: number;
  poisonScore: number; // [0, 1] 0 = healthy, 1 = heavily poisoned
  lifecycle: PatternLifecycle;
  firstSeen: number;
  lastSeen: number;
}

export class PatternDNAEngine {
  private patterns: Map<string, PatternRecord> = new Map();

  public recordSequence(history: Array<{ size: 'BIG' | 'SMALL' }>, actualNext: 'BIG' | 'SMALL'): void {
    const now = Date.now();
    const sizes = history.map(h => h.size);

    for (let len = 2; len <= Math.min(12, sizes.length); len++) {
      const sub = sizes.slice(-len).join('_');
      let rec = this.patterns.get(sub);

      if (!rec) {
        rec = {
          pattern: sub,
          length: len,
          occurrences: 0,
          nextBigCount: 0,
          nextSmallCount: 0,
          recentSuccessCount: 0,
          recentFailureCount: 0,
          lifetimeAccuracy: 0.5,
          poisonScore: 0.0,
          lifecycle: 'BORN',
          firstSeen: now,
          lastSeen: now
        };
        this.patterns.set(sub, rec);
      }

      rec.occurrences++;
      rec.lastSeen = now;
      if (actualNext === 'BIG') rec.nextBigCount++;
      else rec.nextSmallCount++;

      // Majority prediction
      const majority = rec.nextBigCount >= rec.nextSmallCount ? 'BIG' : 'SMALL';
      const wasCorrect = majority === actualNext;

      if (wasCorrect) {
        rec.recentSuccessCount++;
        rec.poisonScore = Math.max(0.0, rec.poisonScore - 0.1);
      } else {
        rec.recentFailureCount++;
        rec.poisonScore = Math.min(1.0, rec.poisonScore + 0.15);
      }

      const totalPredictions = rec.recentSuccessCount + rec.recentFailureCount;
      rec.lifetimeAccuracy = totalPredictions > 0 ? rec.recentSuccessCount / totalPredictions : 0.5;

      // Update lifecycle
      if (rec.occurrences < 5) {
        rec.lifecycle = 'BORN';
      } else if (rec.occurrences < 15) {
        rec.lifecycle = 'TESTED';
      } else if (rec.poisonScore > 0.6) {
        rec.lifecycle = rec.poisonScore > 0.85 ? 'DEAD' : 'DECAYING';
      } else if (rec.lifetimeAccuracy > 0.62) {
        rec.lifecycle = 'PEAK';
      } else {
        rec.lifecycle = 'CONFIRMED';
      }
    }
  }

  public getPattern(key: string): PatternRecord | undefined {
    return this.patterns.get(key);
  }

  public getEffectivePatterns(): PatternRecord[] {
    return Array.from(this.patterns.values()).filter(
      p => p.lifecycle === 'CONFIRMED' || p.lifecycle === 'PEAK'
    );
  }

  public getPoisonedPatterns(): PatternRecord[] {
    return Array.from(this.patterns.values()).filter(p => p.poisonScore > 0.5);
  }
}

export const globalPatternDNA = new PatternDNAEngine();
