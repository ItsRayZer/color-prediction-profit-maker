/**
 * Extensible Pattern Analyzers Registry (ESM)
 */

import {
  PATTERN_TYPES,
  RAW_MAX_LEN,
  MAX_SEQUENCE_LEN,
  extractNormalizedSequence
} from './normalization.js';

import {
  generateFingerprint,
  generatePatternId
} from './fingerprint.js';

import {
  calculateSimilarity
} from './matching.js';

export class BaseAnalyzer {
  constructor({ type, minLen = 3, maxLen = 101, allowsNearMatch = false }) {
    this.type = type;
    this.minLen = minLen;
    this.maxLen = maxLen;
    this.allowsNearMatch = allowsNearMatch;
  }

  isLengthSupported(len) {
    return len >= this.minLen && len <= this.maxLen;
  }

  extractSequence(roundsSlice) {
    return extractNormalizedSequence(this.type, roundsSlice);
  }

  createIdentity(interval, length, normalizedSequence) {
    const fingerprint = generateFingerprint(this.type, interval, length, normalizedSequence);
    const patternId = generatePatternId(this.type, interval, length, normalizedSequence);
    return {
      type: this.type,
      interval,
      length,
      normalizedSequence,
      fingerprint,
      patternId
    };
  }

  compareSimilarity(seqA, seqB) {
    if (!this.allowsNearMatch) return null;
    return calculateSimilarity(this.type, seqA, seqB);
  }
}

export const ANALYZER_REGISTRY = [
  new BaseAnalyzer({
    type: PATTERN_TYPES.RAW_NUMBER,
    minLen: 3,
    maxLen: RAW_MAX_LEN,
    allowsNearMatch: false
  }),
  new BaseAnalyzer({
    type: PATTERN_TYPES.SIZE,
    minLen: 3,
    maxLen: MAX_SEQUENCE_LEN,
    allowsNearMatch: true
  }),
  new BaseAnalyzer({
    type: PATTERN_TYPES.COLOR,
    minLen: 3,
    maxLen: MAX_SEQUENCE_LEN,
    allowsNearMatch: true
  }),
  new BaseAnalyzer({
    type: PATTERN_TYPES.PARITY,
    minLen: 3,
    maxLen: MAX_SEQUENCE_LEN,
    allowsNearMatch: true
  }),
  new BaseAnalyzer({
    type: PATTERN_TYPES.NUMBER_DIFFERENCE,
    minLen: 3,
    maxLen: RAW_MAX_LEN,
    allowsNearMatch: false
  }),
  new BaseAnalyzer({
    type: PATTERN_TYPES.ABSOLUTE_DIFFERENCE,
    minLen: 3,
    maxLen: RAW_MAX_LEN,
    allowsNearMatch: false
  }),
  new BaseAnalyzer({
    type: PATTERN_TYPES.TRANSITION,
    minLen: 3,
    maxLen: MAX_SEQUENCE_LEN,
    allowsNearMatch: false
  }),
  new BaseAnalyzer({
    type: PATTERN_TYPES.STREAK,
    minLen: 3,
    maxLen: MAX_SEQUENCE_LEN,
    allowsNearMatch: false
  }),
  new BaseAnalyzer({
    type: PATTERN_TYPES.STRUCTURAL,
    minLen: 3,
    maxLen: MAX_SEQUENCE_LEN,
    allowsNearMatch: true
  })
];

export function getAnalyzer(type) {
  return ANALYZER_REGISTRY.find(a => a.type === type) || null;
}

export function getAllAnalyzers() {
  return [...ANALYZER_REGISTRY];
}

if (typeof globalThis !== 'undefined') {
  globalThis.PatternAnalyzers = {
    BaseAnalyzer,
    ANALYZER_REGISTRY,
    getAnalyzer,
    getAllAnalyzers
  };
}
