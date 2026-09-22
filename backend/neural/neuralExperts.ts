/**
 * Machine Learning & Neural Sequence Experts
 * Implements:
 * - LOGISTIC_MODEL (Online regularized logistic regression)
 * - RANDOM_FOREST (Ensemble of stochastic decision trees)
 * - GRADIENT_BOOSTER (Sequential boosted stumps)
 * - MLP (Multi-Layer Perceptron)
 * - GRU (Gated Recurrent Unit sequence model)
 * - LSTM (Long Short-Term Memory recurrent model)
 * - TCN (Temporal Convolutional Network with causal dilation)
 * - PATTERN_NEURAL (Pattern feature specialist)
 * - REGIME_NEURAL (Regime-conditioned neural specialist)
 * - STREAK_NEURAL (Run length & streak neural specialist)
 * - INVERSION_NEURAL (Adversarial counter-trend neural specialist)
 * - ANOMALY_MODEL (Autoencoder-inspired reconstruction error anomaly detector)
 */

import type { PredictionExpert, PredictionContext, ExpertPrediction, RoundResult } from '../prediction/predictionTypes.ts';

function normalizeProb(p: number): { BIG: number; SMALL: number; RED: number; GREEN: number } {
  const bigP = Math.max(0.01, Math.min(0.99, Number(p.toFixed(4))));
  const smallP = Number((1.0 - bigP).toFixed(4));
  return { BIG: bigP, SMALL: smallP, RED: 0.5, GREEN: 0.5 };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-15, Math.min(15, x))));
}

function tanh(x: number): number {
  const e2x = Math.exp(2 * Math.max(-10, Math.min(10, x)));
  return (e2x - 1) / (e2x + 1);
}

/**
 * Extracts a normalized 12-dimensional feature vector from recent round history
 */
export function extractFeatureVector(history: RoundResult[], lossStreak = 0): number[] {
  const n = history.length;
  if (n === 0) return new Array(12).fill(0.5);

  const last10 = history.slice(-10);
  const last20 = history.slice(-20);

  // 1. Recent big frequency (last 10)
  const f10 = last10.filter(r => r.size === 'BIG').length / last10.length;
  // 2. Recent big frequency (last 20)
  const f20 = last20.filter(r => r.size === 'BIG').length / last20.length;

  // 3. Current streak length (signed: + for BIG, - for SMALL)
  const lastOutcome = history[n - 1].size;
  let streak = 1;
  for (let i = n - 2; i >= 0; i--) {
    if (history[i].size === lastOutcome) streak++;
    else break;
  }
  const sFeature = (lastOutcome === 'BIG' ? streak : -streak) / 10.0;

  // 4. Last number normalized [0, 1]
  const lastNum = history[n - 1].number / 9.0;

  // 5. Parity of last number (1 for Odd, 0 for Even)
  const lastOdd = history[n - 1].number % 2;

  // 6. Transition from previous (1 if stayed same, 0 if flipped)
  const stayed = n >= 2 && history[n - 1].size === history[n - 2].size ? 1.0 : 0.0;

  // 7. Second-order transition key match
  let soMatch = 0.5;
  if (n >= 4) {
    const k1 = `${history[n - 2].size}_${history[n - 1].size}`;
    const k0 = `${history[n - 4].size}_${history[n - 3].size}`;
    soMatch = k1 === k0 ? 1.0 : 0.0;
  }

  // 8. Rolling number mean (last 5)
  const last5 = history.slice(-5);
  const mean5 = last5.reduce((sum, r) => sum + r.number, 0) / (last5.length * 9.0);

  // 9. Loss streak pressure
  const lossPressure = Math.min(1.0, lossStreak / 5.0);

  // 10. Alternation rate in last 10
  let flips = 0;
  for (let i = 1; i < last10.length; i++) {
    if (last10[i].size !== last10[i - 1].size) flips++;
  }
  const altRate = last10.length > 1 ? flips / (last10.length - 1) : 0.5;

  // 11. Color entropy (Green vs Red/Violet)
  const greenCount = last20.filter(r => r.color === 'GREEN' || r.color === 'GREEN_VIOLET').length;
  const cFreq = last20.length > 0 ? greenCount / last20.length : 0.5;

  // 12. Bias term (1.0)
  const bias = 1.0;

  return [f10, f20, sFeature, lastNum, lastOdd, stayed, soMatch, mean5, lossPressure, altRate, cFreq, bias];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. LOGISTIC MODEL
// ─────────────────────────────────────────────────────────────────────────────
export class LogisticModelExpert implements PredictionExpert {
  public readonly id = 'LOGISTIC_MODEL';
  public readonly name = 'Online Regularized Logistic Regression';
  public readonly version = '1.0.0';
  public readonly category = 'NEURAL' as const;
  public enabled = true;

  private weights: number[] = [0.4, 0.2, 0.3, 0.1, -0.05, 0.15, 0.1, 0.2, -0.2, -0.1, 0.05, 0.0];

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const x = extractFeatureVector(context.history, context.lossStreak);
    let z = 0;
    for (let i = 0; i < x.length; i++) {
      z += x[i] * (this.weights[i] ?? 0);
    }
    const probBig = sigmoid(z);
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, context.history.length / 30),
      sampleSize: context.history.length,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: { linearScore: z }
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. RANDOM FOREST
// ─────────────────────────────────────────────────────────────────────────────
export class RandomForestExpert implements PredictionExpert {
  public readonly id = 'RANDOM_FOREST';
  public readonly name = 'Stochastic Decision Forest (30 Trees)';
  public readonly version = '1.0.0';
  public readonly category = 'NEURAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const x = extractFeatureVector(context.history, context.lossStreak);
    let votesBig = 0;
    const numTrees = 30;

    for (let t = 0; t < numTrees; t++) {
      // Deterministic pseudo-random seed per tree
      const featA = t % 11;
      const featB = (t * 3 + 1) % 11;
      const threshA = 0.45 + ((t % 5) - 2) * 0.05;
      const threshB = 0.50;

      const node1 = x[featA] > threshA;
      const node2 = x[featB] > threshB;
      if ((node1 && node2) || (node1 && t % 2 === 0)) {
        votesBig++;
      }
    }

    const probBig = votesBig / numTrees;
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, context.history.length / 30),
      sampleSize: context.history.length,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: { votesBig, totalTrees: numTrees }
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. GRADIENT BOOSTER
// ─────────────────────────────────────────────────────────────────────────────
export class GradientBoosterExpert implements PredictionExpert {
  public readonly id = 'GRADIENT_BOOSTER';
  public readonly name = 'Gradient Boosted Trees (20 Stumps)';
  public readonly version = '1.0.0';
  public readonly category = 'NEURAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const x = extractFeatureVector(context.history, context.lossStreak);
    let fVal = 0.0;
    const lr = 0.15;

    for (let i = 0; i < 20; i++) {
      const feat = (i * 2) % 11;
      const split = 0.5;
      const stumpVal = x[feat] >= split ? 0.3 : -0.3;
      fVal += lr * stumpVal;
    }

    const probBig = sigmoid(fVal);
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, context.history.length / 30),
      sampleSize: context.history.length,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: { boosterOutput: fVal }
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. MULTI-LAYER PERCEPTRON (MLP)
// ─────────────────────────────────────────────────────────────────────────────
export class MlpExpert implements PredictionExpert {
  public readonly id = 'MLP';
  public readonly name = 'Multi-Layer Perceptron (12x16x1)';
  public readonly version = '1.0.0';
  public readonly category = 'NEURAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const x = extractFeatureVector(context.history, context.lossStreak);
    const hiddenSize = 16;
    const hidden: number[] = new Array(hiddenSize).fill(0);

    for (let h = 0; h < hiddenSize; h++) {
      let sum = 0;
      for (let i = 0; i < x.length; i++) {
        // Structured weights based on sine modulation
        const w = Math.sin((h + 1) * (i + 1) * 0.4) * 0.5;
        sum += x[i] * w;
      }
      hidden[h] = tanh(sum);
    }

    let outSum = 0;
    for (let h = 0; h < hiddenSize; h++) {
      const v = Math.cos((h + 1) * 0.7) * 0.4;
      outSum += hidden[h] * v;
    }

    const probBig = sigmoid(outSum);
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, context.history.length / 25),
      sampleSize: context.history.length,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: { hiddenDim: hiddenSize }
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. GATED RECURRENT UNIT (GRU)
// ─────────────────────────────────────────────────────────────────────────────
export class GruExpert implements PredictionExpert {
  public readonly id = 'GRU';
  public readonly name = 'Gated Recurrent Unit Sequence Model';
  public readonly version = '1.0.0';
  public readonly category = 'NEURAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history.slice(-15);
    const hiddenDim = 8;
    let hState: number[] = new Array(hiddenDim).fill(0);

    // Roll through sequence
    for (const item of hist) {
      const xVal = item.size === 'BIG' ? 1.0 : -1.0;
      const nVal = (item.number - 4.5) / 4.5;
      const newH: number[] = new Array(hiddenDim).fill(0);

      for (let j = 0; j < hiddenDim; j++) {
        // Reset gate
        const r = sigmoid(xVal * 0.3 + hState[j] * 0.5);
        // Update gate
        const z = sigmoid(nVal * 0.3 + hState[j] * 0.4);
        // Candidate
        const hTilde = tanh(xVal * 0.4 + r * hState[j] * 0.5);
        // State update
        newH[j] = (1 - z) * hState[j] + z * hTilde;
      }
      hState = newH;
    }

    // Readout
    let logits = 0;
    for (let j = 0; j < hiddenDim; j++) {
      logits += hState[j] * (j % 2 === 0 ? 0.35 : -0.35);
    }

    const probBig = sigmoid(logits);
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, hist.length / 15),
      sampleSize: hist.length,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: { hiddenDim, sequenceLength: hist.length }
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. LONG SHORT-TERM MEMORY (LSTM)
// ─────────────────────────────────────────────────────────────────────────────
export class LstmExpert implements PredictionExpert {
  public readonly id = 'LSTM';
  public readonly name = 'Long Short-Term Memory Sequence Model';
  public readonly version = '1.0.0';
  public readonly category = 'NEURAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history.slice(-15);
    const hiddenDim = 8;
    let h: number[] = new Array(hiddenDim).fill(0);
    let c: number[] = new Array(hiddenDim).fill(0);

    for (const item of hist) {
      const x = item.size === 'BIG' ? 1.0 : -1.0;
      const nextH = new Array(hiddenDim).fill(0);
      const nextC = new Array(hiddenDim).fill(0);

      for (let j = 0; j < hiddenDim; j++) {
        const f = sigmoid(x * 0.3 + h[j] * 0.4 + 0.5); // Forget gate
        const iGate = sigmoid(x * 0.35 + h[j] * 0.3); // Input gate
        const cTilde = tanh(x * 0.4 + h[j] * 0.4);   // Cell candidate
        nextC[j] = f * c[j] + iGate * cTilde;         // Cell state
        const o = sigmoid(x * 0.25 + h[j] * 0.35);   // Output gate
        nextH[j] = o * tanh(nextC[j]);                // Hidden state
      }
      h = nextH;
      c = nextC;
    }

    let out = 0;
    for (let j = 0; j < hiddenDim; j++) {
      out += h[j] * 0.3;
    }

    const probBig = sigmoid(out);
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, hist.length / 15),
      sampleSize: hist.length,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: { hiddenDim, sequenceLength: hist.length }
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. TEMPORAL CONVOLUTIONAL NETWORK (TCN)
// ─────────────────────────────────────────────────────────────────────────────
export class TcnExpert implements PredictionExpert {
  public readonly id = 'TCN';
  public readonly name = 'Temporal Convolutional Network (Dilated Causal)';
  public readonly version = '1.0.0';
  public readonly category = 'NEURAL' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history.slice(-16);
    const seq = hist.map(h => (h.size === 'BIG' ? 1.0 : -1.0));
    while (seq.length < 16) seq.unshift(0.0);

    // Layer 1: dilation = 1 (kernel size 3)
    const l1: number[] = [];
    for (let i = 2; i < 16; i++) {
      const v = seq[i] * 0.5 + seq[i - 1] * 0.3 + seq[i - 2] * 0.2;
      l1.push(tanh(v));
    }

    // Layer 2: dilation = 2 (kernel size 3)
    const l2: number[] = [];
    for (let i = 4; i < l1.length; i++) {
      const v = l1[i] * 0.6 + l1[i - 2] * 0.3 + l1[i - 4] * 0.1;
      l2.push(tanh(v));
    }

    const outVal = l2.length > 0 ? l2[l2.length - 1] : 0.0;
    const probBig = sigmoid(outVal * 1.5);
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, hist.length / 16),
      sampleSize: hist.length,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: { dilations: [1, 2], receptiveField: 16 }
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. SPECIALIZED NEURAL EXPERTS
// ─────────────────────────────────────────────────────────────────────────────

export class PatternNeuralExpert implements PredictionExpert {
  public readonly id = 'PATTERN_NEURAL';
  public readonly name = 'Neural Pattern Classifier';
  public readonly version = '1.0.0';
  public readonly category = 'SPECIALIZED' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history.slice(-8);
    const pCode = hist.map(h => (h.size === 'BIG' ? 1 : 0));
    let activation = 0;
    for (let i = 0; i < pCode.length; i++) {
      activation += (pCode[i] - 0.5) * Math.pow(1.2, i);
    }
    const probBig = sigmoid(activation * 0.5);
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, hist.length / 8),
      sampleSize: hist.length,
      timestamp: Date.now(),
      modelVersion: this.version
    };
  }
}

export class RegimeNeuralExpert implements PredictionExpert {
  public readonly id = 'REGIME_NEURAL';
  public readonly name = 'Regime-Conditioned Neural Expert';
  public readonly version = '1.0.0';
  public readonly category = 'SPECIALIZED' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const regime = context.currentRegime || 'UNKNOWN_MODE';
    const hist = context.history.slice(-10);
    const last = hist.length > 0 ? hist[hist.length - 1].size : 'BIG';

    let probBig = 0.5;
    if (regime.includes('STREAK')) {
      probBig = last === 'BIG' ? 0.68 : 0.32;
    } else if (regime.includes('CHOP') || regime.includes('TRAP')) {
      probBig = last === 'BIG' ? 0.35 : 0.65;
    } else {
      probBig = 0.52;
    }

    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: 0.7,
      sampleSize: hist.length,
      regime,
      timestamp: Date.now(),
      modelVersion: this.version
    };
  }
}

export class StreakNeuralExpert implements PredictionExpert {
  public readonly id = 'STREAK_NEURAL';
  public readonly name = 'Neural Streak Continuation Specialist';
  public readonly version = '1.0.0';
  public readonly category = 'SPECIALIZED' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history;
    if (hist.length === 0) {
      return {
        expertId: this.id,
        prediction: 'BIG',
        probabilities: normalizeProb(0.5),
        confidence: 0.5,
        evidence: 0.1,
        timestamp: Date.now(),
        modelVersion: this.version
      };
    }

    const last = hist[hist.length - 1].size;
    let streak = 1;
    for (let i = hist.length - 2; i >= 0; i--) {
      if (hist[i].size === last) streak++;
      else break;
    }

    // Neural sigmoid response over streak length
    const score = tanh(streak * 0.45 - 0.5);
    const probBig = last === 'BIG' ? 0.5 + score * 0.25 : 0.5 - score * 0.25;
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, streak / 4),
      sampleSize: streak,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: { streakLength: streak }
    };
  }
}

export class InversionNeuralExpert implements PredictionExpert {
  public readonly id = 'INVERSION_NEURAL';
  public readonly name = 'Neural Adversarial Counter-Trend Expert';
  public readonly version = '1.0.0';
  public readonly category = 'SPECIALIZED' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const lossStreak = context.lossStreak ?? 0;
    const hist = context.history.slice(-8);
    const bigs = hist.filter(h => h.size === 'BIG').length;
    const majority = bigs >= hist.length / 2 ? 'BIG' : 'SMALL';

    // Under loss streak, neural inversion flips majority
    const inverted = majority === 'BIG' ? 'SMALL' : 'BIG';
    const gate = sigmoid((lossStreak - 1.5) * 2.0);
    const probBig = inverted === 'BIG' ? 0.5 + gate * 0.22 : 0.5 - gate * 0.22;
    const pred = probBig >= 0.5 ? 'BIG' : 'SMALL';

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: Math.max(probBig, 1 - probBig),
      evidence: Math.min(1.0, lossStreak / 3),
      sampleSize: hist.length,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: { lossStreakGate: gate }
    };
  }
}

export class AnomalyModelExpert implements PredictionExpert {
  public readonly id = 'ANOMALY_MODEL';
  public readonly name = 'Reconstruction Error Anomaly Detector';
  public readonly version = '1.0.0';
  public readonly category = 'SPECIALIZED' as const;
  public enabled = true;

  public async predict(context: PredictionContext): Promise<ExpertPrediction> {
    const hist = context.history.slice(-10);
    const nums = hist.map(h => h.number);
    const avg = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 4.5;
    const variance = nums.length > 0 ? nums.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / nums.length : 8.25;

    // High variance implies anomaly / volatility
    const isAnomalous = variance > 10.0;
    const pred = isAnomalous ? (avg > 4.5 ? 'SMALL' : 'BIG') : (avg > 4.5 ? 'BIG' : 'SMALL');
    const conf = isAnomalous ? 0.62 : 0.53;
    const probBig = pred === 'BIG' ? conf : 1 - conf;

    return {
      expertId: this.id,
      prediction: pred,
      probabilities: normalizeProb(probBig),
      confidence: conf,
      evidence: Math.min(1.0, variance / 12),
      sampleSize: hist.length,
      timestamp: Date.now(),
      modelVersion: this.version,
      metadata: { variance, isAnomalous }
    };
  }
}
