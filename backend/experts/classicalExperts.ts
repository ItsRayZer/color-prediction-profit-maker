/**
 * Classical Prediction Experts
 * Implements:
 * - MARKOV_TRANSITION (1st order)
 * - SECOND_ORDER_MARKOV
 * - BAYESIAN_TRANSITION
 * - RECENCY_WEIGHTED
 * - FREQUENCY_MODEL
 * - STREAK_RIDER
 * - STREAK_BREAKER
 * - RUN_LENGTH_MODEL
 * - SUFFIX_PATTERN
 * - PATTERN_TRIE
 * - TRAP_DETECTOR
 * - CHANGE_POINT_MODEL
 * - ENTROPY_MODEL
 * - DISTRIBUTION_DRIFT
 * - INVERSION_MODEL
 */

import type { PredictionExpert, PredictionContext, ExpertPrediction, RoundResult } from '../prediction/predictionTypes.ts';

function normalizeProb(p: number): { BIG: number; SMALL: number; RED: number; GREEN: number } {
  const bigP = Math.max(0.01, Math.min(0.99, Number(p.toFixed(4))));
  const smallP = Number((1.0 - bigP).toFixed(4));
  return {
    BIG: bigP,
    SMALL: smallP,
    RED: 0.5,
    GREEN: 0.5
  };
}

export class MarkovTransitionExpert implements PredictionExpert {
  public readonly id = 'MARKOV_TRANSITION';
  public readonly name = '1st Order Markov Transition';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    if (hist.length < 3) {
      return {
        expertId: this.id,
        prediction: 'BIG',
        probabilities: normalizeProb(0.5),
        confidence: 0.5,
        evidence: 0.1,
        timestamp,
        modelVersion: this.version
      };
    }

    const last = hist[hist.length - 1].size;
    let totalTransitions = 0;
    let toBig = 0;

    for (let i = 0; i < hist.length - 1; i++) {
      if (hist[i].size === last) {
        totalTransitions++;
        if (hist[i + 1].size === 'BIG') toBig++;
      }
    }

    // Laplace smoothing
    const probBig = (toBig + 1) / (totalTransitions + 2);
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';
    const conf = Math.max(probBig, 1 - probBig);

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: conf,
      evidence: Math.min(1.0, totalTransitions / 30),
      sampleSize: totalTransitions,
      timestamp,
      modelVersion: this.version,
      metadata: { lastState: last, transitionsSampled: totalTransitions }
    };
  }
}

export class SecondOrderMarkovExpert implements PredictionExpert {
  public readonly id = 'SECOND_ORDER_MARKOV';
  public readonly name = '2nd Order Markov Transition';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    if (hist.length < 5) {
      return {
        expertId: this.id,
        prediction: 'BIG',
        probabilities: normalizeProb(0.5),
        confidence: 0.5,
        evidence: 0.1,
        timestamp,
        modelVersion: this.version
      };
    }

    const s1 = hist[hist.length - 2].size;
    const s2 = hist[hist.length - 1].size;
    let count = 0;
    let bigCount = 0;

    for (let i = 0; i < hist.length - 2; i++) {
      if (hist[i].size === s1 && hist[i + 1].size === s2) {
        count++;
        if (hist[i + 2].size === 'BIG') bigCount++;
      }
    }

    const probBig = (bigCount + 1) / (count + 2);
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, count / 20),
      sampleSize: count,
      timestamp,
      modelVersion: this.version,
      metadata: { pattern: `${s1}->${s2}`, matches: count }
    };
  }
}

export class BayesianTransitionExpert implements PredictionExpert {
  public readonly id = 'BAYESIAN_TRANSITION';
  public readonly name = 'Bayesian Transition Estimator';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    // Prior Beta(2, 2)
    let alpha = 2.0;
    let beta = 2.0;

    const last = hist.length > 0 ? hist[hist.length - 1].size : 'BIG';
    for (let i = 0; i < hist.length - 1; i++) {
      if (hist[i].size === last) {
        if (hist[i + 1].size === 'BIG') alpha += 1.0;
        else beta += 1.0;
      }
    }

    const expectedProbBig = alpha / (alpha + beta);
    const pred = expectedProbBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(expectedProbBig),
      confidence: Math.max(expectedProbBig, 1 - expectedProbBig),
      evidence: Math.min(1.0, (alpha + beta - 4) / 40),
      sampleSize: Math.round(alpha + beta - 4),
      timestamp,
      modelVersion: this.version,
      metadata: { alpha, beta }
    };
  }
}

export class RecencyWeightedExpert implements PredictionExpert {
  public readonly id = 'RECENCY_WEIGHTED';
  public readonly name = 'Exponential Recency Weighted Model';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history.slice(-30);
    const timestamp = Date.now();
    const decay = 0.92;
    let weightSum = 0;
    let bigWeighted = 0;

    for (let i = 0; i < hist.length; i++) {
      const idxFromEnd = hist.length - 1 - i;
      const w = Math.pow(decay, idxFromEnd);
      weightSum += w;
      if (hist[i].size === 'BIG') bigWeighted += w;
    }

    const probBig = weightSum > 0 ? bigWeighted / weightSum : 0.5;
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, hist.length / 25),
      sampleSize: hist.length,
      timestamp,
      modelVersion: this.version
    };
  }
}

export class FrequencyModelExpert implements PredictionExpert {
  public readonly id = 'FREQUENCY_MODEL';
  public readonly name = 'Global Outcome Frequency Model';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    const total = hist.length;
    const bigs = hist.filter(h => h.size === 'BIG').length;
    const probBig = total > 0 ? (bigs + 1) / (total + 2) : 0.5;
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, total / 100),
      sampleSize: total,
      timestamp,
      modelVersion: this.version
    };
  }
}

export class StreakRiderExpert implements PredictionExpert {
  public readonly id = 'STREAK_RIDER';
  public readonly name = 'Streak Continuation Rider';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    if (hist.length === 0) {
      return {
        expertId: this.id,
        prediction: 'BIG',
        probabilities: normalizeProb(0.5),
        confidence: 0.5,
        evidence: 0.1,
        timestamp,
        modelVersion: this.version
      };
    }

    const currentStreakOutcome = hist[hist.length - 1].size;
    let streakLen = 1;
    for (let i = hist.length - 2; i >= 0; i--) {
      if (hist[i].size === currentStreakOutcome) streakLen++;
      else break;
    }

    // Ride the streak with smoothed continuation probability
    const continuationProb = Math.min(0.78, 0.52 + streakLen * 0.04);
    const probBig = currentStreakOutcome === 'BIG' ? continuationProb : 1 - continuationProb;

    return {
      expertId: this.id,
      prediction: currentStreakOutcome,
      probabilities: normalizeProb(probBig),
      confidence: continuationProb,
      evidence: Math.min(1.0, streakLen / 5),
      sampleSize: streakLen,
      timestamp,
      modelVersion: this.version,
      metadata: { streakLength: streakLen, outcome: currentStreakOutcome }
    };
  }
}

export class StreakBreakerExpert implements PredictionExpert {
  public readonly id = 'STREAK_BREAKER';
  public readonly name = 'Mean-Reversion Streak Breaker';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    if (hist.length === 0) {
      return {
        expertId: this.id,
        prediction: 'SMALL',
        probabilities: normalizeProb(0.5),
        confidence: 0.5,
        evidence: 0.1,
        timestamp,
        modelVersion: this.version
      };
    }

    const currentStreakOutcome = hist[hist.length - 1].size;
    let streakLen = 1;
    for (let i = hist.length - 2; i >= 0; i--) {
      if (hist[i].size === currentStreakOutcome) streakLen++;
      else break;
    }

    const breakOutcome = currentStreakOutcome === 'BIG' ? 'SMALL' : 'BIG';
    // Only strong signal if streak >= 3
    const breakProb = streakLen >= 3 ? Math.min(0.75, 0.50 + (streakLen - 2) * 0.05) : 0.51;
    const probBig = breakOutcome === 'BIG' ? breakProb : 1 - breakProb;

    return {
      expertId: this.id,
      prediction: breakOutcome,
      probabilities: normalizeProb(probBig),
      confidence: breakProb,
      evidence: Math.min(1.0, streakLen / 6),
      sampleSize: streakLen,
      timestamp,
      modelVersion: this.version,
      metadata: { streakLength: streakLen, targetReversal: breakOutcome }
    };
  }
}

export class RunLengthModelExpert implements PredictionExpert {
  public readonly id = 'RUN_LENGTH_MODEL';
  public readonly name = 'Geometric Run-Length Distribution';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    if (hist.length < 10) {
      return {
        expertId: this.id,
        prediction: 'BIG',
        probabilities: normalizeProb(0.5),
        confidence: 0.5,
        evidence: 0.1,
        timestamp,
        modelVersion: this.version
      };
    }

    // Measure average run length
    const runs: number[] = [];
    let currentLen = 1;
    for (let i = 1; i < hist.length; i++) {
      if (hist[i].size === hist[i - 1].size) {
        currentLen++;
      } else {
        runs.push(currentLen);
        currentLen = 1;
      }
    }
    const currentRun = currentLen;
    const avgRun = runs.length > 0 ? runs.reduce((a, b) => a + b, 0) / runs.length : 2.0;

    const currentOutcome = hist[hist.length - 1].size;
    const willContinue = currentRun < avgRun;
    const pred = willContinue ? currentOutcome : (currentOutcome === 'BIG' ? 'SMALL' : 'BIG');
    const conf = Math.min(0.68, 0.52 + Math.abs(currentRun - avgRun) * 0.04);
    const probBig = pred === 'BIG' ? conf : 1 - conf;

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: conf,
      evidence: Math.min(1.0, runs.length / 20),
      sampleSize: runs.length,
      timestamp,
      modelVersion: this.version,
      metadata: { avgRunLength: avgRun, currentRun }
    };
  }
}

export class SuffixPatternExpert implements PredictionExpert {
  public readonly id = 'SUFFIX_PATTERN';
  public readonly name = 'Variable-Length Suffix Matcher';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    const sizes = hist.map(h => h.size);

    // Try suffixes of length 5, 4, 3, 2
    for (let len = 5; len >= 2; len--) {
      if (sizes.length <= len + 1) continue;
      const targetSuffix = sizes.slice(-len).join('_');
      let matches = 0;
      let bigFollows = 0;

      for (let i = 0; i <= sizes.length - len - 1; i++) {
        const candidate = sizes.slice(i, i + len).join('_');
        if (candidate === targetSuffix) {
          matches++;
          if (sizes[i + len] === 'BIG') bigFollows++;
        }
      }

      if (matches >= 2) {
        const probBig = (bigFollows + 1) / (matches + 2);
        const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';
        return {
          expertId: this.id,
          prediction: pred,
          probabilities: normalizeProb(probBig),
          confidence: Math.max(probBig, 1 - probBig),
          evidence: Math.min(1.0, matches / 10),
          sampleSize: matches,
          timestamp,
          modelVersion: this.version,
          metadata: { matchedSuffixLength: len, matches }
        };
      }
    }

    return {
      expertId: this.id,
      prediction: 'BIG',
      probabilities: normalizeProb(0.5),
      confidence: 0.5,
      evidence: 0.1,
      timestamp,
      modelVersion: this.version
    };
  }
}

export class PatternTrieExpert implements PredictionExpert {
  public readonly id = 'PATTERN_TRIE';
  public readonly name = 'Prefix/Suffix Search Trie';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    if (hist.length < 8) {
      return {
        expertId: this.id,
        prediction: 'BIG',
        probabilities: normalizeProb(0.5),
        confidence: 0.5,
        evidence: 0.1,
        timestamp,
        modelVersion: this.version
      };
    }

    // Build context pattern: size + parity
    const patternSeq = hist.map(h => `${h.size}_${h.number % 2 === 0 ? 'E' : 'O'}`);
    const key = patternSeq.slice(-2).join('|');

    let matches = 0;
    let bigNext = 0;

    for (let i = 0; i < patternSeq.length - 2; i++) {
      if (patternSeq[i] + '|' + patternSeq[i + 1] === key) {
        matches++;
        if (hist[i + 2].size === 'BIG') bigNext++;
      }
    }

    const probBig = (bigNext + 1) / (matches + 2);
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, matches / 8),
      sampleSize: matches,
      timestamp,
      modelVersion: this.version,
      metadata: { key, matches }
    };
  }
}

export class TrapDetectorExpert implements PredictionExpert {
  public readonly id = 'TRAP_DETECTOR';
  public readonly name = 'Consensus Trap / Adversary Detector';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    if (hist.length < 6) {
      return {
        expertId: this.id,
        prediction: 'BIG',
        probabilities: normalizeProb(0.5),
        confidence: 0.5,
        evidence: 0.1,
        timestamp,
        modelVersion: this.version
      };
    }

    // Detect alternating chop trap: B-S-B-S or S-B-S-B
    const recent = hist.slice(-6).map(h => h.size);
    let alternating = true;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] === recent[i - 1]) {
        alternating = false;
        break;
      }
    }

    const last = recent[recent.length - 1];
    if (alternating) {
      // In a strict trap alternating pattern, expect the alternation to either continue or trap breaker
      const trapContinuation = last === 'BIG' ? 'SMALL' : 'BIG';
      return {
        expertId: this.id,
        prediction: trapContinuation,
        probabilities: normalizeProb(trapContinuation === 'BIG' ? 0.65 : 0.35),
        confidence: 0.65,
        evidence: 0.7,
        sampleSize: 6,
        timestamp,
        modelVersion: this.version,
        metadata: { trapMode: 'CHOP_ALTERNATION' }
      };
    }

    return {
      expertId: this.id,
      prediction: last === 'BIG' ? 'SMALL' : 'BIG',
      probabilities: normalizeProb(last === 'BIG' ? 0.48 : 0.52),
      confidence: 0.52,
      evidence: 0.3,
      sampleSize: hist.length,
      timestamp,
      modelVersion: this.version
    };
  }
}

export class ChangePointModelExpert implements PredictionExpert {
  public readonly id = 'CHANGE_POINT_MODEL';
  public readonly name = 'CUSUM Change-Point Detector';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history.slice(-40);
    const timestamp = Date.now();
    if (hist.length < 15) {
      return {
        expertId: this.id,
        prediction: 'BIG',
        probabilities: normalizeProb(0.5),
        confidence: 0.5,
        evidence: 0.1,
        timestamp,
        modelVersion: this.version
      };
    }

    // CUSUM of sizes
    const targetMean = 0.5;
    let sPos = 0;
    let sNeg = 0;
    let detectedShift: 'SHIFT_BIG' | 'SHIFT_SMALL' | 'NONE' = 'NONE';

    for (const h of hist) {
      const val = h.size === 'BIG' ? 1 : 0;
      sPos = Math.max(0, sPos + val - targetMean - 0.1);
      sNeg = Math.max(0, sNeg + targetMean - val - 0.1);
      if (sPos > 3.0) detectedShift = 'SHIFT_BIG';
      if (sNeg > 3.0) detectedShift = 'SHIFT_SMALL';
    }

    const probBig = detectedShift === 'SHIFT_BIG' ? 0.64 : detectedShift === 'SHIFT_SMALL' ? 0.36 : 0.50;
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: detectedShift !== 'NONE' ? 0.75 : 0.25,
      sampleSize: hist.length,
      timestamp,
      modelVersion: this.version,
      metadata: { detectedShift, sPos, sNeg }
    };
  }
}

export class EntropyModelExpert implements PredictionExpert {
  public readonly id = 'ENTROPY_MODEL';
  public readonly name = 'Shannon Entropy State Detector';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history.slice(-20);
    const timestamp = Date.now();
    if (hist.length < 5) {
      return {
        expertId: this.id,
        prediction: 'BIG',
        probabilities: normalizeProb(0.5),
        confidence: 0.5,
        evidence: 0.1,
        timestamp,
        modelVersion: this.version
      };
    }

    const bigCount = hist.filter(h => h.size === 'BIG').length;
    const p = bigCount / hist.length;
    const q = 1 - p;
    const entropy = (p === 0 || q === 0) ? 0 : -(p * Math.log2(p) + q * Math.log2(q));

    // Low entropy implies structured bias: follow majority
    const majority = p >= 0.5 ? 'BIG' : 'SMALL';
    const conf = entropy < 0.85 ? Math.min(0.75, 0.55 + (1 - entropy) * 0.3) : 0.51;
    const probBig = majority === 'BIG' ? conf : 1 - conf;

    return {
      expertId: this.id,
      prediction: majority,
      probabilities: normalizeProb(probBig),
      confidence: conf,
      evidence: Math.max(0.1, 1 - entropy),
      sampleSize: hist.length,
      timestamp,
      modelVersion: this.version,
      metadata: { shannonEntropy: Number(entropy.toFixed(4)), probMajority: p }
    };
  }
}

export class DistributionDriftExpert implements PredictionExpert {
  public readonly id = 'DISTRIBUTION_DRIFT';
  public readonly name = 'Distribution Drift / KL Divergence';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    if (hist.length < 30) {
      return {
        expertId: this.id,
        prediction: 'BIG',
        probabilities: normalizeProb(0.5),
        confidence: 0.5,
        evidence: 0.1,
        timestamp,
        modelVersion: this.version
      };
    }

    // Baseline window (all except last 15) vs Local window (last 15)
    const baseline = hist.slice(0, -15);
    const local = hist.slice(-15);

    const baseBigP = Math.max(0.05, Math.min(0.95, baseline.filter(h => h.size === 'BIG').length / baseline.length));
    const localBigP = Math.max(0.05, Math.min(0.95, local.filter(h => h.size === 'BIG').length / local.length));

    // Drift direction
    const driftDirection = localBigP > baseBigP ? 'BIG' : 'SMALL';
    const driftMag = Math.abs(localBigP - baseBigP);
    const conf = Math.min(0.70, 0.50 + driftMag * 0.5);
    const probBig = driftDirection === 'BIG' ? conf : 1 - conf;

    return {
      expertId: this.id,
      prediction: driftDirection,
      probabilities: normalizeProb(probBig),
      confidence: conf,
      evidence: Math.min(1.0, driftMag * 2),
      sampleSize: hist.length,
      timestamp,
      modelVersion: this.version,
      metadata: { baseBigP, localBigP, driftMag }
    };
  }
}

export class InversionModelExpert implements PredictionExpert {
  public readonly id = 'INVERSION_MODEL';
  public readonly name = 'Phase Wave Inversion Model';
  public readonly version = '1.0.0';
  public readonly category = 'CLASSICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    if (hist.length < 6) {
      return {
        expertId: this.id,
        prediction: 'SMALL',
        probabilities: normalizeProb(0.5),
        confidence: 0.5,
        evidence: 0.1,
        timestamp,
        modelVersion: this.version
      };
    }

    // Invert the recent majority if loss pressure is high
    const lossStreak = context.lossStreak ?? 0;
    const recent = hist.slice(-8);
    const bigs = recent.filter(h => h.size === 'BIG').length;
    const majority = bigs >= recent.length / 2 ? 'BIG' : 'SMALL';
    const inverted = majority === 'BIG' ? 'SMALL' : 'BIG';

    const conf = lossStreak >= 2 ? Math.min(0.72, 0.53 + lossStreak * 0.05) : 0.52;
    const probBig = inverted === 'BIG' ? conf : 1 - conf;

    return {
      expertId: this.id,
      prediction: inverted,
      probabilities: normalizeProb(probBig),
      confidence: conf,
      evidence: Math.min(1.0, lossStreak / 4),
      sampleSize: recent.length,
      timestamp,
      modelVersion: this.version,
      metadata: { invertedTarget: inverted, lossStreakTrigger: lossStreak }
    };
  }
}
