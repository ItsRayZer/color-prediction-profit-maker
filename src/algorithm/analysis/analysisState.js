/**
 * ===========================================================================
 * ANALYSIS STATE STORE (Isolated Multi-Timeframe Analytical DB)
 * ===========================================================================
 * Maintains complete, unmixed historical databases for 30s, 1m, 3m, and 5m.
 * Never mixes histories between timeframes. Persists to storage.
 */
(function(global) {
  'use strict';

  const TIMEFRAMES = ['30s', '1m', '3m', '5m'];

  const STATE = {
    '30s': { history: [], patternDb: {}, rankings: null, summary: null },
    '1m':  { history: [], patternDb: {}, rankings: null, summary: null },
    '3m':  { history: [], patternDb: {}, rankings: null, summary: null },
    '5m':  { history: [], patternDb: {}, rankings: null, summary: null }
  };

  /**
   * Loads persisted analysis database from localStorage
   */
  function loadPersistedState() {
    if (typeof localStorage === 'undefined') return;
    TIMEFRAMES.forEach(tf => {
      try {
        const histKey = `wingo_analysis_history_${tf}`;
        const rawHist = localStorage.getItem(histKey);
        if (rawHist) {
          STATE[tf].history = JSON.parse(rawHist);
        }

        const dbKey = `wingo_analysis_db_${tf}`;
        const rawDb = localStorage.getItem(dbKey);
        if (rawDb) {
          const parsed = JSON.parse(rawDb);
          const cleanDb = {};
          Object.keys(parsed || {}).forEach(k => {
            if (k.length >= 3 && (!parsed[k].length || parsed[k].length >= 3)) {
              cleanDb[k] = parsed[k];
            }
          });
          STATE[tf].patternDb = cleanDb;
        }
      } catch (err) {
        console.warn(`Could not load persisted analysis state for ${tf}:`, err);
      }
    });
  }

  /**
   * Persists analysis state for a given timeframe
   */
  function persistTimeframeState(tf) {
    if (typeof localStorage === 'undefined' || !STATE[tf]) return;
    try {
      localStorage.setItem(`wingo_analysis_history_${tf}`, JSON.stringify(STATE[tf].history));
      // Persist trimmed pattern db to save storage quota (excluding any length < 3)
      const trimmedDb = {};
      Object.keys(STATE[tf].patternDb || {}).forEach(k => {
        const r = STATE[tf].patternDb[k];
        if (k.length >= 3 && r.totalOccurrences > 0) {
          trimmedDb[k] = r;
        }
      });
      localStorage.setItem(`wingo_analysis_db_${tf}`, JSON.stringify(trimmedDb));
    } catch (err) {
      console.warn(`Storage quota exceeded or error persisting ${tf}:`, err);
    }
  }

  function getHistory(tf = '1m') {
    return (STATE[tf] && STATE[tf].history) ? STATE[tf].history : [];
  }

  function setHistory(tf = '1m', hist = []) {
    if (!STATE[tf]) return;
    // Strictly isolate by timeframe
    STATE[tf].history = [...hist];
    computeSummary(tf);
    persistTimeframeState(tf);
  }

  function appendResult(tf = '1m', resultItem) {
    if (!STATE[tf] || !resultItem || !resultItem.period) return;
    const pStr = String(resultItem.period).trim();
    const pLast5 = pStr.slice(-5);

    // Prevent duplicate entries
    STATE[tf].history = STATE[tf].history.filter(
      r => String(r.period) !== pStr && String(r.period).slice(-5) !== pLast5
    );

    const size = resultItem.size || (resultItem.number <= 4 ? 'SMALL' : 'BIG');
    const color = resultItem.color || ([1,3,7,9,5].includes(resultItem.number) ? 'GREEN' : 'RED');

    STATE[tf].history.push({
      period: pStr,
      number: resultItem.number,
      size,
      color,
      timestamp: resultItem.timestamp || Date.now(),
      timeframe: tf
    });

    STATE[tf].history.sort((a, b) => String(a.period).localeCompare(String(b.period)));
    computeSummary(tf);
    persistTimeframeState(tf);
  }

  function getPatternDb(tf = '1m') {
    return (STATE[tf] && STATE[tf].patternDb) ? STATE[tf].patternDb : {};
  }

  function setPatternDb(tf = '1m', db = {}) {
    if (!STATE[tf]) return;
    STATE[tf].patternDb = db;
    persistTimeframeState(tf);
  }

  function getRankings(tf = '1m') {
    return (STATE[tf] && STATE[tf].rankings) ? STATE[tf].rankings : null;
  }

  function setRankings(tf = '1m', rankings) {
    if (!STATE[tf]) return;
    STATE[tf].rankings = rankings;
  }

  /**
   * Computes streak, total rounds, B/S counts, and percentages
   */
  function computeSummary(tf = '1m') {
    const hist = getHistory(tf).filter(r => !r.gap && r.size);
    const n = hist.length;

    let bCount = 0, sCount = 0;
    let maxBStreak = 0, maxSStreak = 0;
    let curStreakType = null, curStreakLen = 0;

    let runningType = null, runningLen = 0;

    hist.forEach(r => {
      const sym = (r.size === 'BIG' ? 'B' : 'S');
      if (sym === 'B') bCount++;
      else sCount++;

      if (sym === runningType) {
        runningLen++;
      } else {
        runningType = sym;
        runningLen = 1;
      }

      if (runningType === 'B' && runningLen > maxBStreak) maxBStreak = runningLen;
      if (runningType === 'S' && runningLen > maxSStreak) maxSStreak = runningLen;
    });

    curStreakType = runningType;
    curStreakLen = runningLen;

    const summary = {
      timeframe: tf,
      totalResults: n,
      bCount,
      sCount,
      bPct: n > 0 ? (bCount / n * 100).toFixed(1) : '50.0',
      sPct: n > 0 ? (sCount / n * 100).toFixed(1) : '50.0',
      currentStreak: { type: curStreakType, length: curStreakLen },
      longestBStreak: maxBStreak,
      longestSStreak: maxSStreak
    };

    STATE[tf].summary = summary;
    return summary;
  }

  function getSummary(tf = '1m') {
    return (STATE[tf] && STATE[tf].summary) ? STATE[tf].summary : computeSummary(tf);
  }

  // Initialize on load
  loadPersistedState();

  const AnalysisState = {
    TIMEFRAMES,
    getHistory,
    setHistory,
    appendResult,
    getPatternDb,
    setPatternDb,
    getRankings,
    setRankings,
    computeSummary,
    getSummary,
    persistTimeframeState
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AnalysisState;
  }
  if (typeof global !== 'undefined') global.AnalysisState = AnalysisState;
  if (typeof window !== 'undefined') window.AnalysisState = AnalysisState;
  if (typeof globalThis !== 'undefined') globalThis.AnalysisState = AnalysisState;
})(typeof window !== 'undefined' ? window : globalThis);
