/**
 * ===========================================================================
 * PATTERN ANALYZER & OUT-OF-SAMPLE WALK-FORWARD ENGINE
 * ===========================================================================
 * Continuously counts pattern occurrences, calculates following B/S transition
 * evidence, simulates walk-forward out-of-sample performance, and ranks patterns.
 */
(function(global) {
  'use strict';

  const Catalog = (typeof global !== 'undefined' && global.PatternCatalog) ? global.PatternCatalog :
                  (typeof window !== 'undefined' && window.PatternCatalog) ? window.PatternCatalog :
                  (typeof require !== 'undefined') ? (typeof __dirname !== 'undefined' ? require(__dirname + '/patternCatalog.js') : require('./patternCatalog.js')) : null;

  const Stats = (typeof global !== 'undefined' && global.PatternStatistics) ? global.PatternStatistics :
                (typeof window !== 'undefined' && window.PatternStatistics) ? window.PatternStatistics :
                (typeof require !== 'undefined') ? (typeof __dirname !== 'undefined' ? require(__dirname + '/patternStatistics.js') : require('./patternStatistics.js')) : null;

  /**
   * Scans complete chronological history and updates all pattern statistics
   * @param {Array<{ period: string, number: number, size: string }>} history 
   * @param {Object} [existingDb] Optional current pattern database to update
   * @returns {Object} Updated database of pattern records keyed by exact sequence
   */
  function analyzeCompleteHistory(history, existingDb = {}) {
    const cleanHist = (history || []).filter(r => !r.gap && r.size);
    const n = cleanHist.length;
    const db = Object.assign({}, existingDb);

    if (n < 2) return db;

    const fullSeq = cleanHist.map(r => (r.size === 'BIG' ? 'B' : (r.size === 'SMALL' ? 'S' : r.size))).join('');
    const periods = cleanHist.map(r => r.period);

    // Ensure catalog base entries exist in db
    Catalog.CATALOG_LIST.forEach(entry => {
      if (!db[entry.exactSequence]) {
        db[entry.exactSequence] = Stats.createPatternRecord(entry);
      }
    });

    // Reset counters before full recalculation
    Object.keys(db).forEach(k => {
      const rec = db[k];
      rec.totalOccurrences = 0;
      rec.followingB = 0;
      rec.followingS = 0;
      rec.predictionHistory = [];
    });

    const maxScanLen = Math.min(Catalog.MAX_CATALOG_LENGTH, Math.max(1, n - 1));

    // 1. Scan and count all occurrences and following results
    for (let len = 1; len <= maxScanLen; len++) {
      for (let i = 0; i <= n - len; i++) {
        const subSeq = fullSeq.slice(i, i + len);
        if (!db[subSeq]) {
          const entry = Catalog.getPatternBySequence(subSeq);
          db[subSeq] = Stats.createPatternRecord(entry);
        }

        const rec = db[subSeq];
        rec.totalOccurrences++;
        if (!rec.firstSeen) rec.firstSeen = periods[i];
        rec.lastSeen = periods[i + len - 1];

        // Next-result analysis (if subsequent draw exists)
        if (i + len < n) {
          const nextVal = fullSeq[i + len];
          if (nextVal === 'B') rec.followingB++;
          else if (nextVal === 'S') rec.followingS++;
        }
      }
    }

    // 2. Compute probabilities, frequencies, and deviations
    const totalTransitions = Math.max(1, n - 1);
    Object.keys(db).forEach(k => {
      const rec = db[k];
      const validNext = rec.followingB + rec.followingS;
      rec.sampleSize = validNext;
      rec.nextResultCounts = { BIG: rec.followingB, SMALL: rec.followingS };
      rec.sequence = (rec.exactSequence || k).split('');

      if (validNext > 0) {
        rec.probabilityB = rec.followingB / validNext;
        rec.probabilityS = rec.followingS / validNext;
        rec.currentSignal = rec.probabilityB >= rec.probabilityS ? 'B' : 'S';
      } else {
        rec.probabilityB = 0.5;
        rec.probabilityS = 0.5;
        rec.currentSignal = null;
      }

      rec.observedFrequency = rec.totalOccurrences / Math.max(1, n - rec.length + 1);
      rec.expectedFrequency = Math.pow(0.5, rec.length);
      rec.frequencyDeviation = rec.expectedFrequency > 0
        ? (rec.observedFrequency - rec.expectedFrequency) / rec.expectedFrequency
        : 0;

      rec.confidenceInterval = Stats.calcWilsonInterval(rec.followingB, validNext);
      rec.wilsonScoreInterval = rec.confidenceInterval;
    });

    // 3. Walk-forward Out-Of-Sample (OOS) Simulation (strictly prior-only data)
    simulateWalkForwardTesting(fullSeq, db);

    // 4. Update lifecycle statuses
    Object.keys(db).forEach(k => {
      db[k].status = Stats.determinePatternStatus(db[k]);
    });

    return db;
  }

  /**
   * Walk-forward testing (OOS)
   * Evaluates each pattern's historical predictive performance without hindsight.
   * Rolling origin: only patterns that appeared in training portion make predictions.
   */
  function simulateWalkForwardTesting(fullSeq, db) {
    const n = fullSeq.length;
    if (n < 4) return;

    // Train on first 40%, test on remaining 60%
    const trainEnd = Math.max(2, Math.floor(n * 0.40));
    const oosStats = {};

    Object.keys(db).forEach(k => {
      oosStats[k] = {
        correct: 0,
        total: 0,
        recentCorrect: 0,
        recentTotal: 0,
        events: []
      };
    });

    // Running tally during walk-forward
    const onlineB = {};
    const onlineS = {};
    Object.keys(db).forEach(k => {
      onlineB[k] = 0;
      onlineS[k] = 0;
    });

    // Iterate through sequence
    for (let i = 0; i < n - 1; i++) {
      const nextActual = fullSeq[i + 1];

      // Test all pattern lengths matching ending at index i
      for (let len = 1; len <= Math.min(Catalog.MAX_CATALOG_LENGTH, i + 1); len++) {
        const sub = fullSeq.slice(i - len + 1, i + 1);
        if (!db[sub]) continue;

        // If in out-of-sample period, evaluate prediction made from prior knowledge
        if (i >= trainEnd && oosStats[sub]) {
          const priorB = onlineB[sub];
          const priorS = onlineS[sub];
          const priorTotal = priorB + priorS;

          if (priorTotal >= 1) {
            const predProbB = priorB / priorTotal;
            const predChoice = predProbB >= 0.5 ? 'B' : 'S';
            const wasCorrect = (predChoice === nextActual);

            oosStats[sub].total++;
            if (wasCorrect) oosStats[sub].correct++;

            if (i >= n - 25) {
              oosStats[sub].recentTotal++;
              if (wasCorrect) oosStats[sub].recentCorrect++;
            }

            oosStats[sub].events.push({
              predProb: predProbB,
              actual: nextActual === 'B' ? 1 : 0
            });
          }
        }

        // Online learning: update after evaluating
        if (nextActual === 'B') onlineB[sub]++;
        else if (nextActual === 'S') onlineS[sub]++;
      }
    }

    // Assign final computed performance back to database
    Object.keys(db).forEach(k => {
      const rec = db[k];
      const oos = oosStats[k];
      if (oos && oos.total > 0) {
        rec.outOfSampleAccuracy = oos.correct / oos.total;
        rec.historicalAccuracy = oos.correct / oos.total;
        rec.recentAccuracy = oos.recentTotal > 0 ? oos.recentCorrect / oos.recentTotal : rec.outOfSampleAccuracy;
        rec.brierScore = Stats.calcBrierScore(oos.events);
        rec.logLoss = Stats.calcLogLoss(oos.events);
      } else {
        rec.outOfSampleAccuracy = 0.50;
        rec.historicalAccuracy = 0.50;
        rec.recentAccuracy = 0.50;
        rec.brierScore = 0.25;
        rec.logLoss = 0.693;
      }
      // Refresh status based on OOS metrics
      rec.status = Stats.determinePatternStatus(rec);
    });
  }

  /**
   * Generates rankings for the UI and ensemble
   */
  function generateRankings(db) {
    const list = Object.values(db || {}).filter(r => r.totalOccurrences > 0);

    const mostRepeated = [...list]
      .sort((a, b) => b.totalOccurrences - a.totalOccurrences)
      .slice(0, 30);

    let mostPredictive = [...list]
      .filter(r => r.sampleSize >= 3 && r.outOfSampleAccuracy >= 0.50)
      .sort((a, b) => {
        if (b.outOfSampleAccuracy !== a.outOfSampleAccuracy) {
          return b.outOfSampleAccuracy - a.outOfSampleAccuracy;
        }
        return b.sampleSize - a.sampleSize;
      })
      .slice(0, 30);

    // Adaptive fallback if strict condition returns 0
    if (mostPredictive.length === 0 && list.length > 0) {
      mostPredictive = [...list]
        .filter(r => r.sampleSize >= 1)
        .sort((a, b) => Math.abs(b.probabilityB - 0.5) - Math.abs(a.probabilityB - 0.5))
        .slice(0, 30);
    }

    const mostRecent = [...list]
      .filter(r => r.lastSeen)
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
      .slice(0, 30);

    const activeList = [...list]
      .filter(r => r.status === 'ACTIVE' || r.status === 'STRONG')
      .sort((a, b) => (b.outOfSampleAccuracy || 0.5) - (a.outOfSampleAccuracy || 0.5));

    let failedList = [...list]
      .filter(r => r.status === 'FAILED' || r.status === 'WEAKENING' || (r.sampleSize >= 2 && r.outOfSampleAccuracy < 0.50))
      .sort((a, b) => (a.outOfSampleAccuracy || 0.5) - (b.outOfSampleAccuracy || 0.5))
      .slice(0, 30);

    return {
      mostRepeated,
      mostPredictive,
      mostRecent,
      recentActive: mostRecent,
      activeList,
      failedList,
      failedWeakening: failedList
    };
  }

  const PatternAnalyzer = {
    analyzeCompleteHistory,
    simulateWalkForwardTesting,
    generateRankings
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PatternAnalyzer;
  }
  if (typeof global !== 'undefined') global.PatternAnalyzer = PatternAnalyzer;
  if (typeof window !== 'undefined') window.PatternAnalyzer = PatternAnalyzer;
  if (typeof globalThis !== 'undefined') globalThis.PatternAnalyzer = PatternAnalyzer;
})(typeof window !== 'undefined' ? window : globalThis);
