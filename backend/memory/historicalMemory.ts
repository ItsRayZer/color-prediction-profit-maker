/**
 * Multi-Window Historical Memory
 * Implements Section 25:
 * Windows: 20, 50, 100, 200, 500, 1000, 5000, ALL
 */

import type { RoundResult } from '../prediction/predictionTypes.ts';

export interface HistoricalRecord extends RoundResult {
  roundId: string;
  regime?: string;
  activeExpert?: string;
  predictedTarget?: string;
  wasCorrect?: boolean;
}

export class HistoricalMemory {
  private records: HistoricalRecord[] = [];
  private maxRecords = 10000;

  public addRecord(record: HistoricalRecord): void {
    // Avoid duplicate roundIds
    const existingIdx = this.records.findIndex(r => r.roundId === record.roundId);
    if (existingIdx >= 0) {
      this.records[existingIdx] = Object.assign(this.records[existingIdx], record);
    } else {
      this.records.push(record);
      if (this.records.length > this.maxRecords) {
        this.records.shift();
      }
    }
  }

  public getWindow(size: number | 'ALL'): HistoricalRecord[] {
    if (size === 'ALL') return [...this.records];
    return this.records.slice(-size);
  }

  public getCount(): number {
    return this.records.length;
  }

  public getAll(): HistoricalRecord[] {
    return [...this.records];
  }

  public getRecent(n = 20): HistoricalRecord[] {
    return this.records.slice(-n);
  }
}

export const globalHistoricalMemory = new HistoricalMemory();
