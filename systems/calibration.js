/**
 * Probability Calibration Tracker
 * =================================
 * Raw model confidence is NOT a probability until it is measured against
 * real outcomes. This tracker buckets predictions by their stated
 * probability and compares them with what actually happened, so the app
 * can (a) report an honest Expected Calibration Error (ECE), (b) correct
 * stated probabilities with a simple Platt-style (logistic) fit, and
 * (c) refuse to present a confidence as "calibrated" until there is
 * enough evidence and the error is small.
 *
 * A probability is only meaningful for the side that was picked, so every
 * record is: probability assigned to the picked outcome + whether it won.
 */

const EPS = 1e-6;

const clampProb = p => Math.min(1 - EPS, Math.max(EPS, Number(p) || 0.5));
const logit = p => Math.log(clampProb(p) / (1 - clampProb(p)));
const sigmoid = x => 1 / (1 + Math.exp(-x));

export class CalibrationTracker {
  constructor({ bucketCount = 10, minSamplesForCalibration = 50, maxEceForCalibration = 0.08 } = {}) {
    this.bucketCount = bucketCount;
    this.minSamplesForCalibration = minSamplesForCalibration;
    this.maxEceForCalibration = maxEceForCalibration;
    this.records = []; // { prob, won }
    this._platt = null; // { a, b } fitted lazily
  }

  /** Record one settled prediction. prob = probability given to the pick. */
  record(prob, won) {
    const p = clampProb(prob);
    this.records.push({ prob: p, won: won === true });
    this._platt = null; // refit on demand
    return this;
  }

  /** Alias matching prediction-oriented call sites. */
  recordPrediction(prob, won) {
    return this.record(prob, won);
  }

  get count() {
    return this.records.length;
  }

  /** Bucket table: stated probability vs observed win frequency. */
  getBuckets() {
    const buckets = Array.from({ length: this.bucketCount }, (_, i) => ({
      bucket: i,
      lower: i / this.bucketCount,
      upper: (i + 1) / this.bucketCount,
      count: 0,
      wins: 0,
      predictedSum: 0,
      meanPredicted: 0,
      observedRate: 0,
      gap: 0
    }));
    for (const r of this.records) {
      const idx = Math.min(this.bucketCount - 1, Math.floor(r.prob * this.bucketCount));
      const b = buckets[idx];
      b.count += 1;
      b.wins += r.won ? 1 : 0;
      b.predictedSum += r.prob;
    }
    for (const b of buckets) {
      if (b.count > 0) {
        b.meanPredicted = b.predictedSum / b.count;
        b.observedRate = b.wins / b.count;
        b.gap = Math.abs(b.observedRate - b.meanPredicted);
      }
      delete b.predictedSum;
      delete b.wins;
    }
    return buckets;
  }

  /** Expected Calibration Error: sample-weighted mean bucket gap. */
  expectedCalibrationError() {
    if (this.records.length === 0) return 0;
    const buckets = this.getBuckets();
    let ece = 0;
    for (const b of buckets) {
      if (b.count > 0) ece += (b.count / this.records.length) * b.gap;
    }
    return ece;
  }

  ece() {
    return this.expectedCalibrationError();
  }

  /**
   * Simple Platt-style correction: fit sigmoid(a * logit(p) + b) to the
   * recorded outcomes by gradient descent on log-loss. With too little
   * data the identity mapping is returned (no fake correction).
   */
  fitPlatt() {
    if (this._platt) return this._platt;
    if (this.records.length < 20) {
      this._platt = { a: 1, b: 0, fitted: false };
      return this._platt;
    }
    let a = 1;
    let b = 0;
    const lr = 0.05;
    const iterations = 300;
    const xs = this.records.map(r => logit(r.prob));
    const ys = this.records.map(r => (r.won ? 1 : 0));
    for (let iter = 0; iter < iterations; iter++) {
      let gradA = 0;
      let gradB = 0;
      for (let i = 0; i < xs.length; i++) {
        const err = sigmoid(a * xs[i] + b) - ys[i];
        gradA += err * xs[i];
        gradB += err;
      }
      a -= (lr * gradA) / xs.length;
      b -= (lr * gradB) / xs.length;
    }
    this._platt = { a, b, fitted: true };
    return this._platt;
  }

  /** Apply the Platt-style correction to a stated probability. */
  calibrate(prob) {
    const { a, b } = this.fitPlatt();
    return sigmoid(a * logit(prob) + b);
  }

  /**
   * A confidence may be shown as calibrated only when there is enough
   * evidence AND the measured error is small. Otherwise it must be
   * labelled uncalibrated (and the signal gate will skip on it).
   */
  isCalibrated({ minSamples = this.minSamplesForCalibration, maxEce = this.maxEceForCalibration } = {}) {
    if (this.records.length < minSamples) return false;
    return this.expectedCalibrationError() <= maxEce;
  }

  summary() {
    return {
      count: this.count,
      ece: this.expectedCalibrationError(),
      isCalibrated: this.isCalibrated(),
      platt: this.fitPlatt(),
      buckets: this.getBuckets()
    };
  }
}

export function createCalibrationTracker(options) {
  return new CalibrationTracker(options);
}

/** Standalone ECE over a plain [{prob, won}] list. */
export function expectedCalibrationError(records, bucketCount = 10) {
  const t = new CalibrationTracker({ bucketCount });
  for (const r of records || []) t.record(r.prob, r.won);
  return t.expectedCalibrationError();
}

/** Standalone Platt mapping with explicit parameters. */
export function plattScale(prob, a = 1, b = 0) {
  return sigmoid(a * logit(prob) + b);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { CalibrationTracker, createCalibrationTracker, expectedCalibrationError, plattScale };
}

if (typeof self !== "undefined") {
  self.CalibrationTracker = CalibrationTracker;
  self.createCalibrationTracker = createCalibrationTracker;
}
