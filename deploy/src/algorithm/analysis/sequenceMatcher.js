/**
 * ===========================================================================
 * SEQUENCE MATCHER & WINDOWED REGIME SCANNER
 * ===========================================================================
 * Scans trailing sequences across lookback horizons (All-time, 500, 200, 100, 50, 20, 10)
 * and detects structural dynamics (streaks, chop, cycles, palindromes, drift).
 */
(function(global) {
  'use strict';

  const WINDOWS = [10, 20, 50, 100, 200, 500];

  /**
   * Extracts the current trailing B/S sequence from history
   * @param {Array<{ size: string }>} history 
   * @param {number} maxLen 
   * @returns {string} e.g. "BBSSB"
   */
  function getTrailingSequence(history, maxLen = 8) {
    if (!history || !history.length) return '';
    const clean = history.filter(r => !r.gap && r.size).slice(-maxLen);
    return clean.map(r => (r.size === 'BIG' ? 'B' : (r.size === 'SMALL' ? 'S' : r.size))).join('');
  }

  /**
   * Finds all candidate catalog patterns matching the trailing history
   * @param {string} trailingSeq Full trailing string (e.g. "BBBS")
   * @param {Object} patternDb Map of sequence -> patternRecord
   * @returns {Array<Object>} List of matched pattern records sorted by length descending
   */
  function findMatchingTrailingPatterns(trailingSeq, patternDb) {
    if (!trailingSeq || !patternDb) return [];
    const matched = [];
    const len = trailingSeq.length;

    // Candidate patterns start at minimum length 3 (excluding 1-2 digit sequences)
    for (let k = 3; k <= len; k++) {
      const sub = trailingSeq.slice(-k);
      const record = patternDb[sub];
      if (record && (record.length >= 3 || (record.exactSequence && record.exactSequence.length >= 3))) {
        matched.push(record);
      }
    }

    return matched.sort((a, b) => b.length - a.length);
  }

  /**
   * Structural Pattern Detectors (from Python v5 engine & specifications)
   */
  function detectStructuralPatterns(seq) {
    if (!seq || seq.length < 3) return [];
    const matches = [];
    const n = seq.length;

    // 1. Streak / Dragon (P1-STREAK / DYN-RUN-001)
    const last = seq[n - 1];
    let streak = 1;
    for (let i = n - 2; i >= 0; i--) {
      if (seq[i] === last) streak++;
      else break;
    }
    if (streak >= 3) {
      const conf = Math.min(0.95, 0.60 + 0.08 * streak);
      matches.push({
        code: 'DYN-RUN-001',
        type: 'RUN',
        name: `Streak of ${streak}x '${last}'`,
        confidence: conf,
        predictedNext: last,
        length: streak,
        status: streak >= 4 ? 'STRONG' : 'ACTIVE'
      });
    }

    // 2. Alternation / Chop (P2-ALT / DYN-ALT-001)
    let alt = 1;
    for (let i = n - 1; i >= 1; i--) {
      if (seq[i] !== seq[i - 1]) alt++;
      else break;
    }
    if (alt >= 4) {
      const conf = Math.min(0.95, 0.65 + 0.06 * alt);
      const opp = last === 'B' ? 'S' : 'B';
      matches.push({
        code: 'DYN-ALT-001',
        type: 'CHOP',
        name: `Alternating Chop x${alt}`,
        confidence: conf,
        predictedNext: opp,
        length: alt,
        status: alt >= 5 ? 'STRONG' : 'ACTIVE'
      });
    }

    // 3. Double-Block Cycle (P4-DOUBLE / DYN-BLOCK-001)
    if (n >= 6) {
      const last4 = seq.slice(-4);
      if (last4[0] === last4[1] && last4[2] === last4[3] && last4[0] !== last4[2]) {
        matches.push({
          code: 'DYN-BLOCK-001',
          type: 'DOUBLE_BLOCK',
          name: `2-2 Double Block '${last4}'`,
          confidence: 0.78,
          predictedNext: last4[0], // next repeats cycle
          length: 4,
          status: 'ACTIVE'
        });
      }
    }

    // 4. Periodic Cycles (3 to 8)
    for (let period = 3; period <= 8; period++) {
      if (n >= period * 2) {
        let matchesCount = 0;
        let total = 0;
        for (let i = n - 1; i >= period; i--) {
          total++;
          if (seq[i] === seq[i - period]) matchesCount++;
        }
        const conf = total > 0 ? matchesCount / total : 0;
        if (conf >= 0.80 && total >= period * 2) {
          const block = seq.slice(-period);
          matches.push({
            code: `DYN-CYCLE-${String(period).padStart(2, '0')}`,
            type: 'CYCLE',
            name: `Repeating block '${block}' (len ${period})`,
            confidence: conf,
            predictedNext: seq[n - period],
            length: period,
            status: 'ACTIVE'
          });
        }
      }
    }

    // 5. Palindrome Mirror (DYN-MIRROR-001)
    for (let k = 4; k <= Math.min(n, 8); k++) {
      const window = seq.slice(-k);
      if (window === window.split('').reverse().join('')) {
        matches.push({
          code: 'DYN-MIRROR-001',
          type: 'MIRROR',
          name: `Palindrome Mirror '${window}'`,
          confidence: Math.min(0.90, 0.60 + 0.05 * k),
          predictedNext: window[1] || last,
          length: k,
          status: 'WATCH'
        });
      }
    }

    return matches;
  }

  /**
   * Evaluates pattern across multiple historical windows
   * Compares all-time vs 500, 200, 100, 50, 20, 10 to detect stability/regime
   */
  function scanWindowedBehavior(patternSeq, history) {
    if (!patternSeq || !history || history.length < 20) return null;
    const clean = history.filter(r => !r.gap && r.size);
    const totalLen = clean.length;
    const windowResults = {};

    const fullStr = clean.map(r => (r.size === 'BIG' ? 'B' : 'S')).join('');

    WINDOWS.forEach(w => {
      if (totalLen >= w) {
        const slice = fullStr.slice(-w);
        let bNext = 0, sNext = 0, count = 0;
        let pos = 0;
        while ((pos = slice.indexOf(patternSeq, pos)) !== -1) {
          if (pos + patternSeq.length < slice.length) {
            const nextChar = slice[pos + patternSeq.length];
            if (nextChar === 'B') bNext++;
            else if (nextChar === 'S') sNext++;
            count++;
          }
          pos++;
        }
        const total = bNext + sNext;
        windowResults[w] = {
          occurrences: count,
          bCount: bNext,
          sCount: sNext,
          probB: total > 0 ? bNext / total : 0.5,
          probS: total > 0 ? sNext / total : 0.5
        };
      }
    });

    // Detect momentum regime
    let regime = 'STABLE';
    if (windowResults[20] && windowResults[100]) {
      const diff = windowResults[20].probB - windowResults[100].probB;
      if (diff > 0.12) regime = 'STRENGTHENING_B';
      else if (diff < -0.12) regime = 'STRENGTHENING_S';
      else if (Math.abs(diff) < 0.05) regime = 'HIGHLY_STABLE';
    }

    return { windowResults, regime };
  }

  const SequenceMatcher = {
    WINDOWS,
    getTrailingSequence,
    findMatchingTrailingPatterns,
    detectStructuralPatterns,
    scanWindowedBehavior
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SequenceMatcher;
  }
  if (typeof global !== 'undefined') global.SequenceMatcher = SequenceMatcher;
  if (typeof window !== 'undefined') window.SequenceMatcher = SequenceMatcher;
  if (typeof globalThis !== 'undefined') globalThis.SequenceMatcher = SequenceMatcher;
})(typeof window !== 'undefined' ? window : globalThis);
