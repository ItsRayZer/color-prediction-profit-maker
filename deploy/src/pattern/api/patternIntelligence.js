/**
 * Pattern Intelligence API — Mandatory Read-Only Historical Knowledge Layer
 * Accessible by every AI model in the application.
 * Models receive strictly read-only deep historical context.
 */

import { patternStorage } from '../storage/patternDb.js';
import { generateFingerprint, generatePatternId } from '../engine/fingerprint.js';
import { extractNormalizedSequence } from '../engine/normalization.js';
import { calculateSimilarity } from '../engine/matching.js';
import { getAllAnalyzers } from '../engine/analyzers.js';

export class PatternIntelligenceAPI {
  constructor(storage = patternStorage) {
    this.storage = storage;
  }

  /**
   * Find exact pattern by type, interval, length, and normalized sequence
   */
  async findPattern({ type, interval, length, normalizedSequence }) {
    const patternId = generatePatternId(type, interval, length, normalizedSequence);
    const pat = await this.storage.getPattern(patternId);
    if (!pat) return null;
    return Object.freeze({ ...pat });
  }

  /**
   * Find near-matching patterns (for SIZE, COLOR, PARITY, STRUCTURAL)
   */
  async findNearPatterns({ type, interval, length, sequence, threshold = 0.85 }) {
    const all = await this.storage.getAllPatterns();
    const matches = [];

    for (const pat of all) {
      if (pat.interval !== interval || pat.type !== type || pat.length !== length) continue;
      const sim = calculateSimilarity(type, sequence, pat.normalizedSequence);
      if (sim !== null && sim >= threshold) {
        matches.push(Object.freeze({
          ...pat,
          similarity: sim
        }));
      }
    }

    return matches.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Get paginated occurrences for a pattern
   */
  async getPatternOccurrences({ patternId, page = 1, pageSize = 20 }) {
    const res = await this.storage.getOccurrencesByPattern(patternId, page, pageSize);
    return Object.freeze({
      ...res,
      occurrences: res.occurrences.map(o => Object.freeze({ ...o }))
    });
  }

  /**
   * Get continuation statistics for a pattern
   */
  async getContinuationStats({ patternId }) {
    const pat = await this.storage.getPattern(patternId);
    if (!pat || !pat.continuation) {
      return Object.freeze({ next: {}, n: 0, percentages: {}, isLowSample: true });
    }
    return Object.freeze({ ...pat.continuation });
  }

  /**
   * Get historical results query
   */
  async getHistoricalResults({ interval, from = 0, to = null, limit = 100 } = {}) {
    // Queries from available in-memory or stored history
    const allOccurrences = await this.storage.driver.stores.occurrences.getAll();
    const intervalOccs = allOccurrences.filter(o => o.interval === interval);
    const end = to !== null ? to : Math.min(intervalOccs.length, from + limit);
    return Object.freeze(intervalOccs.slice(from, end).map(o => Object.freeze({ ...o })));
  }

  /**
   * Get historical performance association between a model and a pattern
   */
  async getModelPatternHistory({ patternId, modelId = null }) {
    const snapshots = await this.storage.getModelSnapshots(patternId, modelId);
    const summary = {};

    for (const snap of snapshots) {
      const mId = snap.modelId;
      if (!summary[mId]) {
        summary[mId] = { occurrences: 0, correct: 0, incorrect: 0, winRate: 0 };
      }
      summary[mId].occurrences++;
      if (snap.correct === true) summary[mId].correct++;
      else if (snap.correct === false) summary[mId].incorrect++;
      summary[mId].winRate = summary[mId].occurrences > 0
        ? Number(((summary[mId].correct / summary[mId].occurrences) * 100).toFixed(1))
        : 0;
    }

    return Object.freeze(summary);
  }

  /**
   * Master read-only context method for AI models
   */
  async getPatternContext({
    interval = '30s',
    currentSequence = [],
    maxLength = 101,
    types = null,
    modelId = null
  }) {
    const allPatterns = await this.storage.getAllPatterns(500);
    const intervalPatterns = allPatterns.filter(p => p.interval === interval);

    const matches = [];
    const frequency = {};
    const continuation = {};

    // Analyze current sequence tail against registered patterns
    for (const pat of intervalPatterns) {
      if (types && !types.includes(pat.type)) continue;
      if (pat.length > maxLength) continue;

      frequency[pat.patternId] = pat.occurrenceCount || 1;
      continuation[pat.patternId] = pat.continuation || { next: {}, n: 0 };

      // Exact match check on sequence tail
      if (currentSequence.length >= pat.length) {
        const slice = currentSequence.slice(currentSequence.length - pat.length);
        const norm = extractNormalizedSequence(pat.type, slice);
        if (norm === pat.normalizedSequence) {
          matches.push(Object.freeze({
            patternId: pat.patternId,
            type: pat.type,
            length: pat.length,
            matchPct: 100,
            occurrenceCount: pat.occurrenceCount || 1
          }));
        } else {
          // Near match check if allowed
          const sim = calculateSimilarity(pat.type, norm, pat.normalizedSequence);
          if (sim !== null && sim >= 0.85) {
            matches.push(Object.freeze({
              patternId: pat.patternId,
              type: pat.type,
              length: pat.length,
              matchPct: Number((sim * 100).toFixed(1)),
              occurrenceCount: pat.occurrenceCount || 1
            }));
          }
        }
      }
    }

    const modelHistory = modelId ? await this.getModelPatternHistory({ patternId: matches[0]?.patternId, modelId }) : {};

    return Object.freeze({
      interval,
      matches: matches.slice(0, 50),
      frequency,
      continuation,
      modelHistory,
      global: {
        totalKnownPatterns: intervalPatterns.length,
        analyzersAvailable: getAllAnalyzers().map(a => a.type)
      }
    });
  }
}

export const patternApi = new PatternIntelligenceAPI();

if (typeof globalThis !== 'undefined') {
  globalThis.PatternIntelligenceAPI = {
    PatternIntelligenceAPI,
    patternApi
  };
}
