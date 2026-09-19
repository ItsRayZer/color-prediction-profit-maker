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

    const maxScanLen = Math.min(Catalog.MAX_CATALOG_LENGTH, Math.floor(n / 2));

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
   */
  function simulateWalkForwardTesting(fullSeq, db) {
    const n = fullSeq.length;
    if (n < 30) return;

    const trainEnd = Math.floor(n * 0.40); // Initial burn-in training split
    const oosStats = {};

    Object.keys(db).forEach(k => {
      oosStats[k] = { correct: 0, total: 0, events: [], recentCorrect: 0, recentTotal: 0 };
    });

    // Online counts during walk-forward
    const onlineB = {};
    const onlineS = {};

    for (let i = 0; i < n - 1; i++) {
      for (let len = 1; len <= Catalog.MAX_CATALOG_LENGTH && (i + len) < n; len++) {
        const sub = fullSeq.slice(i, i + len);
        const nextActual = fullSeq[i + len];

        if (!onlineB[sub]) { onlineB[sub] = 0; onlineS[sub] = 0; }

        // If in out-of-sample evaluation phase, test prior belief
        if (i >= trainEnd && oosStats[sub]) {
          const priorB = onlineB[sub];
          const priorS = onlineS[sub];
          const priorTotal = priorB + priorS;

          if (priorTotal >= 3) {
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

    const mostPredictive = [...list]
      .filter(r => r.sampleSize >= 5 && r.outOfSampleAccuracy >= 0.52)
      .sort((a, b) => {
        if (b.outOfSampleAccuracy !== a.outOfSampleAccuracy) {
          return b.outOfSampleAccuracy - a.outOfSampleAccuracy;
        }
        return b.sampleSize - a.sampleSize;
      })
      .slice(0, 30);

    const mostRecent = [...list]
      .filter(r => r.lastSeen)
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
      .slice(0, 30);

    const activeList = [...list]
      .filter(r => r.status === 'ACTIVE' || r.status === 'STRONG')
      .sort((a, b) => b.outOfSampleAccuracy - a.outOfSampleAccuracy);

    const failedList = [...list]
      .filter(r => r.status === 'FAILED' || r.status === 'WEAKENING')
      .sort((a, b) => a.outOfSampleAccuracy - b.outOfSampleAccuracy);

    return {
      mostRepeated,
      mostPredictive,
      mostRecent,
      activeList,
      failedList
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
