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
 *
 * KNOWN CAVEAT (documented Phase 2A — behavior unchanged): the pooled
 * tracker records whatever probability the caller passes, and the
 * governed bridge currently records the Platt-scaled (calibrated)
 * probability, so pooled ECE measures the scaled outputs against
 * outcomes — it cannot validate the scaling itself ("ECE measures
 * itself"). Per-model tracking (PerModelCalibrationTracker below)
 * avoids this by recording each model's RAW stated confidence at
 * settlement. Pooled figures are always labelled "pooled" wherever
 * they are shown, and are never presented as per-model evidence.
 */

const EPS = 1e-6;

const clampProb = p => Math.min(1 - EPS, Math.max(EPS, Number(p) || 0.5));
const logit = p => Math.log(clampProb(p) / (1 - clampProb(p)));
const sigmoid = x => 1 / (1 + Math.exp(-x));

export const CALIBRATION_KEY = 'o101_calibration_v1';
export const CALIBRATION_MAX_RECORDS = 500;

export class CalibrationTracker {
  constructor({ bucketCount = 10, minSamplesForCalibration = 50, maxEceForCalibration = 0.08,
    storage = null, key = CALIBRATION_KEY, maxRecords = CALIBRATION_MAX_RECORDS } = {}) {
    this.bucketCount = bucketCount;
    this.minSamplesForCalibration = minSamplesForCalibration;
    this.maxEceForCalibration = maxEceForCalibration;
    this.storage = storage;
    this.key = key;
    this.maxRecords = maxRecords;
    this.records = []; // { prob, won }
    this._platt = null; // { a, b } fitted lazily
    this.load();
  }

  /** Hydrate from storage (no-op without storage). Records are recent-only
   *  by construction: save() always keeps at most maxRecords, so a stale
   *  calibration from days ago cannot survive — and the ECE gate (<=0.08)
   *  still refuses a wrong calibration, hydrated or not. Without this,
   *  every page load reset calibration to zero and the signal gate
   *  skipped every round until 50 fresh in-session settlements accrued. */
  load() {
    if (!this.storage) return this;
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return this;
      const d = JSON.parse(raw);
      const recs = Array.isArray(d) ? d : (d && Array.isArray(d.records) ? d.records : null);
      if (!recs) return this;
      this.records = recs
        .filter(r => r && Number.isFinite(Number(r.prob)))
        .map(r => ({ prob: clampProb(r.prob), won: r.won === true }))
        .slice(-this.maxRecords);
      this._platt = null;
    } catch (e) { /* corrupt snapshot: start fresh, gate stays honest */ }
    return this;
  }

  save() {
    if (!this.storage) return this;
    try { this.storage.setItem(this.key, JSON.stringify(this.records)); } catch (e) {}
    return this;
  }

  /** Record one settled prediction. prob = probability given to the pick. */
  record(prob, won) {
    const p = clampProb(prob);
    this.records.push({ prob: p, won: won === true });
    if (this.records.length > this.maxRecords) this.records = this.records.slice(-this.maxRecords);
    this._platt = null; // refit on demand
    this.save();
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

/** Display label for one calibration measurement (Phase 2A). */
export function calibrationLabel({ count, ece, minSamplesForCalibration = 50, maxEceForCalibration = 0.08 } = {}) {
  if (!count || count < minSamplesForCalibration || ece === null || ece === undefined || ece > maxEceForCalibration) {
    return `uncalibrated (n=${count || 0})`;
  }
  return `ECE ${ece.toFixed(3)} · n=${count}`;
}

export const PER_MODEL_CALIBRATION_MAX_RECORDS = 200;

/**
 * Per-model calibration tracking — OBSERVABILITY ONLY (Phase 2A).
 * The pooled CalibrationTracker above cannot answer "is THIS model
 * calibrated?", because its records carry no model id. This tracker
 * keeps one bounded record list per model id, reuses the standalone
 * expectedCalibrationError for ECE (no duplicated bucket logic), and
 * never feeds a verdict, stake, or gate — it only feeds display.
 *
 * Discipline, by construction:
 *  - records are { modelId, prob, won, period } — the model id the
 *    pooled tracker lacks, plus the period for walk-forward checks;
 *  - callers record the model's RAW stated confidence (never a Platt
 *    output), so ECE measures the model, not the scaler;
 *  - a record is appended only at settlement for a pick that was
 *    computed from strictly-prior history (walk-forward: no
 *    self-measurement);
 *  - bounded: at most maxRecordsPerModel (200, mirroring the store's
 *    RAW_CAP) per model, so state cannot grow unboundedly;
 *  - session-scoped: no storage, nothing persisted. A fresh launch
 *    starts empty — honest, and visible as "uncalibrated (n=0)".
 *  - "calibrated" means count >= 50 AND ECE <= 0.08, mirroring the
 *    pooled gate's constants; anything else displays "uncalibrated".
 */
export class PerModelCalibrationTracker {
  constructor({ bucketCount = 10, minSamplesForCalibration = 50, maxEceForCalibration = 0.08,
    maxRecordsPerModel = PER_MODEL_CALIBRATION_MAX_RECORDS } = {}) {
    this.bucketCount = bucketCount;
    this.minSamplesForCalibration = minSamplesForCalibration;
    this.maxEceForCalibration = maxEceForCalibration;
    this.maxRecordsPerModel = maxRecordsPerModel;
    this.byModel = new Map(); // modelId -> [{ prob, won, period }]
  }

  /** Record one settled pick. Non-finite probs are skipped, not stored.
   *  (Number(null) is 0, so null/undefined/empty must be rejected
   *  explicitly — otherwise a missing confidence would be stored as
   *  a ~0 probability.) */
  record(modelId, prob, won, period) {
    if (!modelId || prob === null || prob === undefined || prob === '' || !Number.isFinite(Number(prob))) return this;
    const recs = this.byModel.get(modelId) || [];
    recs.push({ prob: clampProb(prob), won: won === true, period: period === undefined ? null : period });
    if (recs.length > this.maxRecordsPerModel) recs.splice(0, recs.length - this.maxRecordsPerModel);
    this.byModel.set(modelId, recs);
    return this;
  }

  recordsFor(modelId) {
    return [...(this.byModel.get(modelId) || [])];
  }

  get modelIds() {
    return [...this.byModel.keys()];
  }

  /** { count, ece, calibrated, label } for one model id. */
  stats(modelId) {
    const recs = this.byModel.get(modelId) || [];
    const count = recs.length;
    const ece = count > 0 ? expectedCalibrationError(recs, this.bucketCount) : null;
    const calibrated = count >= this.minSamplesForCalibration && ece !== null && ece <= this.maxEceForCalibration;
    return {
      count,
      ece,
      calibrated,
      label: calibrationLabel({ count, ece, minSamplesForCalibration: this.minSamplesForCalibration, maxEceForCalibration: this.maxEceForCalibration })
    };
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { CalibrationTracker, createCalibrationTracker, expectedCalibrationError, plattScale,
    calibrationLabel, PER_MODEL_CALIBRATION_MAX_RECORDS, PerModelCalibrationTracker };
}

if (typeof self !== "undefined") {
  self.CalibrationTracker = CalibrationTracker;
  self.createCalibrationTracker = createCalibrationTracker;
  self.PerModelCalibrationTracker = PerModelCalibrationTracker;
  self.calibrationLabel = calibrationLabel;
}
