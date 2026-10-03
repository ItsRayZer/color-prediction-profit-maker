/**
 * Incremental Pattern Engine & Continuation Statistics Calculator (ESM)
 */

import {
  PATTERN_TYPES,
  RAW_MAX_LEN,
  MAX_SEQUENCE_LEN
} from './normalization.js';

import {
  generateFingerprint,
  generatePatternId
} from './fingerprint.js';

import {
  getAllAnalyzers
} from './analyzers.js';

export const PATTERN_LIFECYCLE = {
  CANDIDATE: 'CANDIDATE',
  REPEATED: 'REPEATED',
  KNOWN: 'KNOWN'
};

export function resolveLifecycleStatus(occurrenceCount) {
  if (occurrenceCount <= 1) return PATTERN_LIFECYCLE.CANDIDATE;
  if (occurrenceCount === 2) return PATTERN_LIFECYCLE.REPEATED;
  return PATTERN_LIFECYCLE.KNOWN;
}

/**
 * Extracts all newly completed pattern windows ending strictly at the latest round index.
 * Does not re-scan the entire history.
 */
export function extractNewlyCompletedPatterns(interval, roundsHistory, options = {}) {
  if (!Array.isArray(roundsHistory) || roundsHistory.length < 3) return [];

  const analyzers = getAllAnalyzers();
  const latestIdx = roundsHistory.length - 1;
  const latestRound = roundsHistory[latestIdx];
  const maxSearchLen = options.maxLen || MAX_SEQUENCE_LEN;

  const completedPatterns = [];

  for (const analyzer of analyzers) {
    const minL = analyzer.minLen;
    const maxL = Math.min(analyzer.maxLen, maxSearchLen);

    for (let len = minL; len <= maxL; len++) {
      if (roundsHistory.length < len) continue;

      const windowStart = roundsHistory.length - len;
      const windowSlice = roundsHistory.slice(windowStart);
      const normalizedSeq = analyzer.extractSequence(windowSlice);
      if (!normalizedSeq) continue;

      const identity = analyzer.createIdentity(interval, len, normalizedSeq);

      // Preceding context: up to 5 preceding rounds before this window
      const precedingStart = Math.max(0, windowStart - 5);
      const precedingResults = roundsHistory.slice(precedingStart, windowStart).map(r => ({
        period: r.period,
        number: r.number ?? r.openNumber ?? 0,
        size: r.size || ((r.number ?? 0) >= 5 ? 'BIG' : 'SMALL')
      }));

      completedPatterns.push({
        patternId: identity.patternId,
        fingerprint: identity.fingerprint,
        type: analyzer.type,
        interval,
        length: len,
        normalizedSequence: normalizedSeq,
        exactSequence: windowSlice.map(r => r.number ?? r.openNumber ?? 0).join(','),
        period: latestRound.period,
        timestamp: latestRound.timestamp || new Date().toISOString(),
        precedingResults,
        nextResult: null,
        similarity: 1.0,
        modelSnapshots: []
      });
    }
  }

  return completedPatterns;
}

/**
 * Updates continuation statistics for a pattern given the next observed result.
 * Produces { next: { BIG: 42, SMALL: 31 }, n: 73, percentages: { BIG: 57.53, SMALL: 42.47 }, isLowSample: false }
 */
export function updateContinuationStatistics(existingStats, nextResultOutcome) {
  const stats = existingStats ? JSON.parse(JSON.stringify(existingStats)) : { next: {}, n: 0 };
  if (!stats.next) stats.next = {};

  const outcomeKey = String(nextResultOutcome || 'UNKNOWN').toUpperCase();
  stats.next[outcomeKey] = (stats.next[outcomeKey] || 0) + 1;
  stats.n = (stats.n || 0) + 1;

  const percentages = {};
  for (const [key, count] of Object.entries(stats.next)) {
    percentages[key] = stats.n > 0 ? Number(((count / stats.n) * 100).toFixed(2)) : 0;
  }
  stats.percentages = percentages;
  stats.isLowSample = stats.n < 5;

  return stats;
}

/**
 * Calculates recurrence statistics between occurrences
 */
export function updateRecurrenceInfo(existingRecurrence, newPeriod, newTimestamp) {
  const rec = existingRecurrence ? { ...existingRecurrence } : {
    totalOccurrences: 0,
    firstSeen: { period: newPeriod, timestamp: newTimestamp },
    lastSeen: { period: newPeriod, timestamp: newTimestamp },
    periodsBetween: [],
    avgRecurrenceInterval: null
  };

  rec.totalOccurrences = (rec.totalOccurrences || 0) + 1;

  if (rec.lastSeen && rec.lastSeen.period && rec.lastSeen.period !== newPeriod) {
    const prevPeriodNum = parseInt(rec.lastSeen.period, 10);
    const curPeriodNum = parseInt(newPeriod, 10);
    if (!isNaN(prevPeriodNum) && !isNaN(curPeriodNum)) {
      const distance = Math.abs(curPeriodNum - prevPeriodNum);
      if (!rec.periodsBetween) rec.periodsBetween = [];
      rec.periodsBetween.push(distance);
      if (rec.periodsBetween.length > 50) rec.periodsBetween.shift();

      const sum = rec.periodsBetween.reduce((a, b) => a + b, 0);
      rec.avgRecurrenceInterval = Number((sum / rec.periodsBetween.length).toFixed(1));
    }
  }

  rec.lastSeen = { period: newPeriod, timestamp: newTimestamp };
  return rec;
}

if (typeof globalThis !== 'undefined') {
  globalThis.PatternIncremental = {
    PATTERN_LIFECYCLE,
    resolveLifecycleStatus,
    extractNewlyCompletedPatterns,
    updateContinuationStatistics,
    updateRecurrenceInfo
  };
}
