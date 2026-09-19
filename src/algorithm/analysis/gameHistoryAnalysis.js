/**
 * ===========================================================================
 * GAME HISTORY ANALYSIS ENGINE (Primary Module)
 * ===========================================================================
 * Dedicated persistent analysis layer. Responsible for complete historical
 * analysis, continuous pattern discovery, next-result empirical statistics,
 * and out-of-sample validation.
 *
 * NOTE: This module is strictly analytical. It is NOT responsible for
 * placing bets or changing bankroll.
 */
(function(global) {
  'use strict';

  const Catalog  = (typeof global !== 'undefined' && global.PatternCatalog) ? global.PatternCatalog :
                   (typeof window !== 'undefined' && window.PatternCatalog) ? window.PatternCatalog :
                   (typeof require !== 'undefined') ? (typeof __dirname !== 'undefined' ? require(__dirname + '/patternCatalog.js') : require('./patternCatalog.js')) : null;

  const Stats    = (typeof global !== 'undefined' && global.PatternStatistics) ? global.PatternStatistics :
                   (typeof window !== 'undefined' && window.PatternStatistics) ? window.PatternStatistics :
                   (typeof require !== 'undefined') ? (typeof __dirname !== 'undefined' ? require(__dirname + '/patternStatistics.js') : require('./patternStatistics.js')) : null;

  const Matcher  = (typeof global !== 'undefined' && global.SequenceMatcher) ? global.SequenceMatcher :
                   (typeof window !== 'undefined' && window.SequenceMatcher) ? window.SequenceMatcher :
                   (typeof require !== 'undefined') ? (typeof __dirname !== 'undefined' ? require(__dirname + '/sequenceMatcher.js') : require('./sequenceMatcher.js')) : null;

  const Analyzer = (typeof global !== 'undefined' && global.PatternAnalyzer) ? global.PatternAnalyzer :
                   (typeof window !== 'undefined' && window.PatternAnalyzer) ? window.PatternAnalyzer :
                   (typeof require !== 'undefined') ? (typeof __dirname !== 'undefined' ? require(__dirname + '/patternAnalyzer.js') : require('./patternAnalyzer.js')) : null;

  const State    = (typeof global !== 'undefined' && global.AnalysisState) ? global.AnalysisState :
                   (typeof window !== 'undefined' && window.AnalysisState) ? window.AnalysisState :
                   (typeof require !== 'undefined') ? (typeof __dirname !== 'undefined' ? require(__dirname + '/analysisState.js') : require('./analysisState.js')) : null;

  /**
   * Main lifecycle hook triggered whenever a new round result arrives.
   * Performs:
   * RESULT ARRIVES
   *   ↓
   * SAVE RESULT (to timeframe isolated history)
   *   ↓
   * UPDATE COMPLETE GAME HISTORY
   *   ↓
   * DISCOVER ALL RELEVANT PATTERNS & RECOUNT
   *   ↓
   * UPDATE NEXT-RESULT COUNTS & PROBABILITIES
   *   ↓
   * UPDATE PATTERN RANKINGS
   *   ↓
   * OUT-OF-SAMPLE VALIDATION
   */
  function recordRoundResult(timeframe = '1m', result) {
    if (!result || !result.period) return null;

    // 1. Save result to timeframe isolated history
    State.appendResult(timeframe, result);
    const fullHistory = State.getHistory(timeframe);

    // 2. Scan and recount all patterns across complete history
    const currentDb = State.getPatternDb(timeframe);
    const updatedDb = Analyzer.analyzeCompleteHistory(fullHistory, currentDb);
    State.setPatternDb(timeframe, updatedDb);

    // 3. Update ranking tables
    const rankings = Analyzer.generateRankings(updatedDb);
    State.setRankings(timeframe, rankings);

    // 4. Return summary & active candidate patterns
    const summary = State.getSummary(timeframe);
    const candidates = getCandidatePatterns(timeframe, fullHistory);

    return {
      summary,
      rankings,
      candidates
    };
  }

  /**
   * Evaluates current trailing history and extracts candidate patterns for prediction
   * @param {string} timeframe e.g. '1m'
   * @param {Array<Object>} [historyOverride] Optional slice
   * @returns {Object} Candidate patterns package consumed by the ensemble prediction engine
   */
  function getCandidatePatterns(timeframe = '1m', historyOverride = null) {
    const history = historyOverride || State.getHistory(timeframe);
    const patternDb = State.getPatternDb(timeframe);
    const trailingSeq = Matcher.getTrailingSequence(history, Catalog.MAX_CATALOG_LENGTH);

    // 1. Find exact catalog matches for trailing sequence
    const exactMatches = Matcher.findMatchingTrailingPatterns(trailingSeq, patternDb);

    // 2. Find structural matches (Dragon streak, Chop alternation, Double block, Cycle, Mirror)
    const structuralMatches = Matcher.detectStructuralPatterns(trailingSeq);

    // 3. Filter candidates by statistical validity
    const validatedCandidates = exactMatches.filter(p => {
      // Must have at least 5 historical occurrences and not be marked FAILED
      return p.totalOccurrences >= 5 && p.status !== 'FAILED';
    });

    // Best candidate based on highest sample size + out-of-sample edge
    let bestCandidate = null;
    if (validatedCandidates.length > 0) {
      bestCandidate = [...validatedCandidates].sort((a, b) => {
        // Prioritize ACTIVE/STRONG status first
        const scoreA = (a.status === 'STRONG' ? 3 : (a.status === 'ACTIVE' ? 2 : 1)) + a.outOfSampleAccuracy * 2;
        const scoreB = (b.status === 'STRONG' ? 3 : (b.status === 'ACTIVE' ? 2 : 1)) + b.outOfSampleAccuracy * 2;
        return scoreB - scoreA;
      })[0];
    }

    return {
      trailingSequence: trailingSeq,
      matchingPatterns: exactMatches,
      validatedCandidates,
      bestCandidate,
      structuralMatches
    };
  }

  /**
   * Compiles complete dashboard dataset for UI rendering
   */
  function getDashboardData(timeframe = '1m') {
    const history = State.getHistory(timeframe);
    const summary = State.getSummary(timeframe);
    let rankings  = State.getRankings(timeframe);

    if (!rankings) {
      const db = State.getPatternDb(timeframe);
      rankings = Analyzer.generateRankings(db);
      State.setRankings(timeframe, rankings);
    }

    const candidates = getCandidatePatterns(timeframe, history);

    return {
      timeframe,
      summary,
      rankings,
      candidates
    };
  }

  const GameHistoryAnalysis = {
    recordRoundResult,
    getCandidatePatterns,
    getDashboardData,
    // Sub-module exposure
    Catalog,
    Stats,
    Matcher,
    Analyzer,
    State
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GameHistoryAnalysis;
  }
  if (typeof global !== 'undefined') global.GameHistoryAnalysis = GameHistoryAnalysis;
  if (typeof window !== 'undefined') window.GameHistoryAnalysis = GameHistoryAnalysis;
  if (typeof globalThis !== 'undefined') globalThis.GameHistoryAnalysis = GameHistoryAnalysis;
})(typeof window !== 'undefined' ? window : globalThis);
