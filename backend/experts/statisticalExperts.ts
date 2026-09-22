/**
 * Statistical Prediction Experts
 * Implements:
 * - N_GRAM_MODEL
 * - HIDDEN_MARKOV_MODEL
 * - BAYESIAN_ONLINE_MODEL
 * - SIMILARITY_MODEL
 * - BOOTSTRAP_MODEL
 * - STATISTICAL_ENSEMBLE
 */

import type { PredictionExpert, PredictionContext, ExpertPrediction } from '../prediction/predictionTypes.ts';

function normalizeProb(p: number): { BIG: number; SMALL: number; RED: number; GREEN: number } {
  const bigP = Math.max(0.01, Math.min(0.99, Number(p.toFixed(4))));
  const smallP = Number((1.0 - bigP).toFixed(4));
  return { BIG: bigP, SMALL: smallP, RED: 0.5, GREEN: 0.5 };
}

export class NGramModelExpert implements PredictionExpert {
  public readonly id = 'N_GRAM_MODEL';
  public readonly name = 'N-Gram Sequence Model';
  public readonly version = '1.0.0';
  public readonly category = 'STATISTICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    const sizes = hist.map(h => h.size);
    const N = 3;

    if (sizes.length <= N) {
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

    const gram = sizes.slice(-N).join('-');
    let matches = 0;
    let bigNext = 0;

    for (let i = 0; i <= sizes.length - N - 1; i++) {
      if (sizes.slice(i, i + N).join('-') === gram) {
        matches++;
        if (sizes[i + N] === 'BIG') bigNext++;
      }
    }

    const probBig = (bigNext + 1) / (matches + 2);
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
      metadata: { nGram: gram, matches }
    };
  }
}

export class HiddenMarkovModelExpert implements PredictionExpert {
  public readonly id = 'HIDDEN_MARKOV_MODEL';
  public readonly name = 'Hidden Markov State Estimator';
  public readonly version = '1.0.0';
  public readonly category = 'STATISTICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history.slice(-30);
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

    // 2 latent states: State 0 (Big-biased), State 1 (Small-biased)
    // Estimate emission frequency given current streak
    const last = hist[hist.length - 1].size;
    let switchCount = 0;
    for (let i = 1; i < hist.length; i++) {
      if (hist[i].size !== hist[i - 1].size) switchCount++;
    }
    const persistenceRate = 1 - (switchCount / (hist.length - 1));

    const probBig = last === 'BIG' ? persistenceRate : 1 - persistenceRate;
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, hist.length / 25),
      sampleSize: hist.length,
      timestamp,
      modelVersion: this.version,
      metadata: { persistenceRate }
    };
  }
}

export class BayesianOnlineModelExpert implements PredictionExpert {
  public readonly id = 'BAYESIAN_ONLINE_MODEL';
  public readonly name = 'Online Bayesian Updating Model';
  public readonly version = '1.0.0';
  public readonly category = 'STATISTICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    // Prior with gentle forgetting
    let a = 1.0;
    let b = 1.0;
    const decay = 0.98;

    for (const h of hist) {
      a *= decay;
      b *= decay;
      if (h.size === 'BIG') a += 1.0;
      else b += 1.0;
    }

    const probBig = a / (a + b);
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, (a + b) / 30),
      sampleSize: hist.length,
      timestamp,
      modelVersion: this.version,
      metadata: { effectiveAlpha: a, effectiveBeta: b }
    };
  }
}

export class SimilarityModelExpert implements PredictionExpert {
  public readonly id = 'SIMILARITY_MODEL';
  public readonly name = 'K-Nearest Historical Trajectory Matcher';
  public readonly version = '1.0.0';
  public readonly category = 'STATISTICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    const timestamp = Date.now();
    const K = 4; // Subsequence length to match
    if (hist.length < 20) {
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

    const query = hist.slice(-K).map(h => h.number);
    let bestDist = Infinity;
    let matchedNextSize: 'BIG' | 'SMALL' = 'BIG';
    let matchCount = 0;
    let matchBigs = 0;

    for (let i = 0; i <= hist.length - K - 2; i++) {
      let dist = 0;
      for (let j = 0; j < K; j++) {
        dist += Math.abs(hist[i + j].number - query[j]);
      }
      if (dist < 10) {
        matchCount++;
        if (hist[i + K].size === 'BIG') matchBigs++;
      }
    }

    const probBig = matchCount > 0 ? (matchBigs + 1) / (matchCount + 2) : 0.5;
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, matchCount / 5),
      sampleSize: matchCount,
      timestamp,
      modelVersion: this.version,
      metadata: { matchesFound: matchCount, queryVector: query }
    };
  }
}

export class BootstrapModelExpert implements PredictionExpert {
  public readonly id = 'BOOTSTRAP_MODEL';
  public readonly name = 'Non-Parametric Bootstrap Resampling';
  public readonly version = '1.0.0';
  public readonly category = 'STATISTICAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history.slice(-50);
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

    const B = 100; // 100 bootstrap replicates
    let bigWinCount = 0;

    for (let b = 0; b < B; b++) {
      let sampleBigs = 0;
      for (let i = 0; i < hist.length; i++) {
        const randIdx = Math.floor(Math.random() * hist.length);
        if (hist[randIdx].size === 'BIG') sampleBigs++;
      }
      if (sampleBigs >= hist.length / 2) bigWinCount++;
    }

    const probBig = bigWinCount / B;
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, hist.length / 40),
      sampleSize: hist.length,
      timestamp,
      modelVersion: this.version,
      metadata: { bootstrapReplicates: B, bigReplicationRate: probBig }
    };
  }
}

export class StatisticalEnsembleExpert implements PredictionExpert {
  public readonly id = 'STATISTICAL_ENSEMBLE';
  public readonly name = 'Statistical Model Mixture Ensemble';
  public readonly version = '1.0.0';
  public readonly category = 'STATISTICAL' as const;
  public enabled = true;

  private subExperts = [
    new NGramModelExpert(),
    new HiddenMarkovModelExpert(),
    new BayesianOnlineModelExpert(),
    new SimilarityModelExpert(),
    new BootstrapModelExpert()
  ];

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const timestamp = Date.now();
    const preds = await Promise.allSettled(this.subExperts.map(e => e.predict(context)));

    let bigWeightSum = 0;
    let totalWeight = 0;

    for (const r of preds) {
      if (r.status === 'fulfilled') {
        const p = r.value;
        const w = Math.max(0.1, p.evidence * p.confidence);
        bigWeightSum += (p.probabilities['BIG'] ?? 0.5) * w;
        totalWeight += w;
      }
    }

    const probBig = totalWeight > 0 ? bigWeightSum / totalWeight : 0.5;
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: 0.85,
      sampleSize: context.history.length,
      timestamp,
      modelVersion: this.version,
      metadata: { subExpertCount: this.subExperts.length }
    };
  }
}
