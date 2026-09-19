/**
 * ===========================================================================
 * PATTERN STATISTICS & METRICS (Rigorous Statistical Inference)
 * ===========================================================================
 * Computes occurrence counts, following-result transition probabilities,
 * confidence intervals, Brier score, log loss, and out-of-sample performance.
 */
(function(global) {
  'use strict';

  /**
   * Calculates Wilson Score 95% Confidence Interval for a proportion p
   * @param {number} successes 
   * @param {number} total 
   * @param {number} [z=1.96] 95% confidence standard score
   * @returns {{ lower: number, upper: number }}
   */
  function calcWilsonInterval(successes, total, z = 1.96) {
    if (!total || total <= 0) return { lower: 0, upper: 1 };
    const p = successes / total;
    const z2 = z * z;
    const denom = 1 + z2 / total;
    const center = (p + z2 / (2 * total)) / denom;
    const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
    return {
      lower: Math.max(0, center - margin),
      upper: Math.min(1, center + margin)
    };
  }

  /**
   * Computes Brier Score across predictions vs actual outcomes
   * @param {Array<{ predProb: number, actual: number }>} events (actual = 1 or 0)
   * @returns {number} 0 is perfect, 0.25 is random 50-50 guessing
   */
  function calcBrierScore(events) {
    if (!events || !events.length) return 0.25;
    const sum = events.reduce((acc, ev) => acc + Math.pow(ev.predProb - ev.actual, 2), 0);
    return sum / events.length;
  }

  /**
   * Computes Log Loss
   * @param {Array<{ predProb: number, actual: number }>} events
   * @returns {number}
   */
  function calcLogLoss(events) {
    if (!events || !events.length) return 0.693; // ln(2)
    const eps = 1e-15;
    const sum = events.reduce((acc, ev) => {
      const p = Math.max(eps, Math.min(1 - eps, ev.predProb));
      return acc + (ev.actual === 1 ? -Math.log(p) : -Math.log(1 - p));
    }, 0);
    return sum / events.length;
  }

  /**
   * Evaluates pattern lifecycle status
   * States: NEW, WATCH, ACTIVE, STRONG, WEAKENING, FAILED, RETIRED
   */
  function determinePatternStatus(record) {
    const { totalOccurrences, oosAccuracy, sampleSize, recentAccuracy } = record;
    if (totalOccurrences < 5) return 'NEW';
    if (totalOccurrences < 10) return 'WATCH';

    if (sampleSize >= 15 && oosAccuracy >= 0.58) {
      if (recentAccuracy !== undefined && recentAccuracy < 0.45) return 'WEAKENING';
      return 'STRONG';
    }

    if (sampleSize >= 10 && oosAccuracy >= 0.53) {
      if (recentAccuracy !== undefined && recentAccuracy < 0.45) return 'WEAKENING';
      return 'ACTIVE';
    }

    if (sampleSize >= 12 && oosAccuracy <= 0.44) {
      return 'FAILED';
    }

    if (recentAccuracy !== undefined && recentAccuracy < 0.48 && oosAccuracy < 0.50) {
      return 'WEAKENING';
    }

    return 'WATCH';
  }

  /**
   * Creates a fresh pattern statistical record
   */
  function createPatternRecord(catalogEntry) {
    return {
      code: catalogEntry.code,
      exactSequence: catalogEntry.exactSequence,
      length: catalogEntry.length,
      type: catalogEntry.type,
      structuralCode: catalogEntry.structuralCode,
      description: catalogEntry.description,

      totalOccurrences: 0,
      followingB: 0,
      followingS: 0,

      probabilityB: 0.5,
      probabilityS: 0.5,

      firstSeen: null,
      lastSeen: null,

      currentOccurrences: 0,
      historicalOccurrences: 0,

      recentAccuracy: 0.5,
      historicalAccuracy: 0.5,
      outOfSampleAccuracy: 0.5,

      sampleSize: 0,
      expectedFrequency: catalogEntry.expectedProbability || Math.pow(0.5, catalogEntry.length),
      observedFrequency: 0,
      frequencyDeviation: 0,

      confidenceInterval: { lower: 0, upper: 1 },
      brierScore: 0.25,
      logLoss: 0.693,

      status: 'NEW',
      currentSignal: null,
      predictionHistory: []
    };
  }

  const PatternStatistics = {
    calcWilsonInterval,
    calcBrierScore,
    calcLogLoss,
    determinePatternStatus,
    createPatternRecord
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PatternStatistics;
  }
  if (typeof global !== 'undefined') global.PatternStatistics = PatternStatistics;
  if (typeof window !== 'undefined') window.PatternStatistics = PatternStatistics;
  if (typeof globalThis !== 'undefined') globalThis.PatternStatistics = PatternStatistics;
})(typeof window !== 'undefined' ? window : globalThis);
