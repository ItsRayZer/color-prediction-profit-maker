/**
 * LOSS-STREAK SHIELD (Diagnostic System)
 * Implements Section 32:
 * Strictly diagnostic; NEVER increases stake size, NEVER chases losses, NEVER claims guaranteed wins.
 * Levels:
 * LEVEL 0: Normal
 * LEVEL 1: Increased monitoring (1 loss)
 * LEVEL 2: Historical replay + inversion comparison (2 losses)
 * LEVEL 3: Full regime / model diagnostics (3 losses)
 * LEVEL 4: Full autopsy + pattern review + challenger pressure (4+ losses)
 */

export type ShieldLevel = 0 | 1 | 2 | 3 | 4;

export interface ShieldStatus {
  level: ShieldLevel;
  description: string;
  recommendedDiagnostics: string[];
  inversionCheckActive: boolean;
  challengerPressureActive: boolean;
}

export class LossStreakShield {
  public evaluate(currentLossStreak: number): ShieldStatus {
    const s = Math.max(0, currentLossStreak);

    if (s === 0) {
      return {
        level: 0,
        description: 'LEVEL 0: Normal steady-state operation.',
        recommendedDiagnostics: [],
        inversionCheckActive: false,
        challengerPressureActive: false
      };
    }

    if (s === 1) {
      return {
        level: 1,
        description: 'LEVEL 1: Increased monitoring and feature credit inspection.',
        recommendedDiagnostics: ['Check feature drift', 'Verify transition matrix consistency'],
        inversionCheckActive: false,
        challengerPressureActive: false
      };
    }

    if (s === 2) {
      return {
        level: 2,
        description: 'LEVEL 2: Historical replay and phase-wave inversion comparison active.',
        recommendedDiagnostics: ['Time-traveller trajectory check', 'Inversion model comparative test'],
        inversionCheckActive: true,
        challengerPressureActive: false
      };
    }

    if (s === 3) {
      return {
        level: 3,
        description: 'LEVEL 3: Full regime and model health diagnostics triggered.',
        recommendedDiagnostics: ['Regime radar scan', 'Model calibration review', 'Entropy drift check'],
        inversionCheckActive: true,
        challengerPressureActive: true
      };
    }

    return {
      level: 4,
      description: 'LEVEL 4: Full prediction autopsy, poisoned pattern purge review, and challenger promotion evaluation.',
      recommendedDiagnostics: ['Full expert autopsy', 'Poisoned pattern review', 'Forced champion recalculation review'],
      inversionCheckActive: true,
      challengerPressureActive: true
    };
  }
}

export const globalLossStreakShield = new LossStreakShield();
