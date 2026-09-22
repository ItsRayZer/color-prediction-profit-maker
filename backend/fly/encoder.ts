/**
 * Fly Brain Input Encoder
 * Encodes multi-window sequences (20, 50, 100 rounds) into standardized feature representations
 */

import type { RoundResult } from '../prediction/predictionTypes.ts';

export class FlyInputEncoder {
  public encode(history: RoundResult[], lossStreak = 0, currentRegime = 'UNKNOWN'): number[] {
    const n = history.length;
    if (n === 0) return new Array(16).fill(0.5);

    const w20 = history.slice(-20);
    const w50 = history.slice(-50);
    const w100 = history.slice(-100);

    // 1. Size one-hot (last round)
    const lastSize = history[n - 1].size;
    const isBig = lastSize === 'BIG' ? 1.0 : 0.0;
    const isSmall = lastSize === 'SMALL' ? 1.0 : 0.0;

    // 2. Color one-hot
    const lastColor = history[n - 1].color;
    const isGreen = (lastColor === 'GREEN' || lastColor === 'GREEN_VIOLET') ? 1.0 : 0.0;
    const isRed = (lastColor === 'RED' || lastColor === 'RED_VIOLET') ? 1.0 : 0.0;
    const isViolet = (lastColor === 'VIOLET' || lastColor === 'RED_VIOLET' || lastColor === 'GREEN_VIOLET') ? 1.0 : 0.0;

    // 3. Frequencies across windows
    const f20 = w20.filter(r => r.size === 'BIG').length / w20.length;
    const f50 = w50.filter(r => r.size === 'BIG').length / w50.length;
    const f100 = w100.filter(r => r.size === 'BIG').length / w100.length;

    // 4. Streak feature
    let streak = 1;
    for (let i = n - 2; i >= 0; i--) {
      if (history[i].size === lastSize) streak++;
      else break;
    }
    const streakNorm = Math.min(1.0, streak / 8.0);

    // 5. Transition feature (stay vs flip)
    const stayed = (n >= 2 && history[n - 1].size === history[n - 2].size) ? 1.0 : 0.0;

    // 6. Shannon entropy (last 20)
    const p = f20;
    const q = 1 - p;
    const entropy = (p === 0 || q === 0) ? 0.0 : -(p * Math.log2(p) + q * Math.log2(q));

    // 7. Loss streak pressure
    const lossPressure = Math.min(1.0, lossStreak / 5.0);

    // 8. Regime indicator
    const isStreakMode = currentRegime.includes('STREAK') ? 1.0 : 0.0;
    const isChopMode = currentRegime.includes('CHOP') || currentRegime.includes('TRAP') ? 1.0 : 0.0;

    // 9. Distribution drift (f20 vs f100)
    const drift = Math.abs(f20 - f100);

    // 10. Number normalized [0, 1]
    const normNumber = history[n - 1].number / 9.0;

    return [
      isBig,
      isSmall,
      isGreen,
      isRed,
      isViolet,
      f20,
      f50,
      f100,
      streakNorm,
      stayed,
      entropy,
      lossPressure,
      isStreakMode,
      isChopMode,
      drift,
      normNumber
    ];
  }
}
