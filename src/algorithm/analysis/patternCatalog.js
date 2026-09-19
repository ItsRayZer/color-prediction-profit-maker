/**
 * ===========================================================================
 * PATTERN CATALOG (Permanent Sequence Enumeration & Structural Taxonomy)
 * ===========================================================================
 * Generates all combinatorial B/S sequences from length 1 to 8+ and assigns
 * permanent code identifiers (P01_01, P02_01, etc.) and structural classes.
 */
(function(global) {
  'use strict';

  const MAX_CATALOG_LENGTH = 8;

  // Structural pattern taxonomy definitions
  const STRUCTURAL_PATTERNS = [
    { code: 'DYN-RUN-001', type: 'RUN', name: 'Consecutive Streak', minLen: 3, description: 'Consecutive identical results (Dragon Run)' },
    { code: 'DYN-ALT-001', type: 'CHOP', name: 'Alternation Chop', minLen: 4, description: 'Strict alternating sequence (B-S-B-S or S-B-S-B)' },
    { code: 'DYN-BLOCK-001', type: 'DOUBLE_BLOCK', name: '2-2 Block Cycle', minLen: 4, description: 'Pairs of identical symbols alternating (BBSSBB or SSBBSS)' },
    { code: 'DYN-CYCLE-001', type: 'CYCLE', name: 'Periodic Cycle', minLen: 6, description: 'Fixed recurring block repeating with period k (3-8)' },
    { code: 'DYN-MIRROR-001', type: 'MIRROR', name: 'Palindrome Mirror', minLen: 4, description: 'Symmetric sequence identical forwards and backwards' },
    { code: 'DYN-DRIFT-001', type: 'DRIFT', name: 'Statistical Drift', minLen: 10, description: 'Momentum shift / statistical bias deviation across windows' }
  ];

  /**
   * Generates all binary combinations of 'B' and 'S' of a given length
   * @param {number} length 
   * @returns {Array<string>}
   */
  function generateSequencesOfLength(length) {
    if (length <= 0) return [];
    let list = ['B', 'S'];
    for (let i = 2; i <= length; i++) {
      const next = [];
      for (const s of list) {
        next.push(s + 'B');
        next.push(s + 'S');
      }
      list = next;
    }
    return list;
  }

  /**
   * Builds the complete permanent catalog table
   */
  function buildCatalog(maxLen = MAX_CATALOG_LENGTH) {
    const catalog = {};
    const list = [];

    for (let len = 1; len <= maxLen; len++) {
      const seqs = generateSequencesOfLength(len);
      seqs.forEach((seq, idx) => {
        const lenCode = String(len).padStart(2, '0');
        const idxCode = String(idx + 1).padStart(2, '0');
        const code = `P${lenCode}_${idxCode}`;

        // Classify structural properties
        let structuralType = 'STANDARD';
        let structuralCode = null;
        let structuralDesc = `${len}-round sequence ${seq}`;

        if (len >= 3 && /^B+$|^S+$/.test(seq)) {
          structuralType = 'RUN';
          structuralCode = 'DYN-RUN-001';
          structuralDesc = `${len}-${seq[0]} streak`;
        } else if (len >= 4 && (seq === 'BSBSBSBS'.slice(0, len) || seq === 'SBSBSBSB'.slice(0, len))) {
          structuralType = 'CHOP';
          structuralCode = 'DYN-ALT-001';
          structuralDesc = `${len}-step alternation chop`;
        } else if (len >= 4 && (seq === 'BBSSBBSS'.slice(0, len) || seq === 'SSBBSSBB'.slice(0, len))) {
          structuralType = 'DOUBLE_BLOCK';
          structuralCode = 'DYN-BLOCK-001';
          structuralDesc = `${len}-step 2-2 double cycle`;
        } else if (len >= 4 && seq === seq.split('').reverse().join('')) {
          structuralType = 'MIRROR';
          structuralCode = 'DYN-MIRROR-001';
          structuralDesc = `${len}-step palindrome mirror`;
        }

        const entry = {
          code,
          exactSequence: seq,
          length: len,
          type: structuralType,
          structuralCode,
          description: structuralDesc,
          expectedProbability: Math.pow(0.5, len)
        };

        catalog[seq] = entry;
        list.push(entry);
      });
    }

    return { catalog, list };
  }

  const { catalog: CATALOG_MAP, list: CATALOG_LIST } = buildCatalog(MAX_CATALOG_LENGTH);

  function getPatternBySequence(seq) {
    if (!seq) return null;
    const clean = String(seq).toUpperCase().trim();
    if (CATALOG_MAP[clean]) return CATALOG_MAP[clean];
    
    // Dynamic fallback for length > 8
    const len = clean.length;
    const lenCode = String(len).padStart(2, '0');
    return {
      code: `P${lenCode}_DYN`,
      exactSequence: clean,
      length: len,
      type: 'EXTENDED',
      structuralCode: null,
      description: `${len}-round extended pattern`,
      expectedProbability: Math.pow(0.5, len)
    };
  }

  const PatternCatalog = {
    MAX_CATALOG_LENGTH,
    STRUCTURAL_PATTERNS,
    CATALOG_MAP,
    CATALOG_LIST,
    ALL_PATTERNS: CATALOG_LIST,
    generateSequencesOfLength,
    buildCatalog,
    getPatternBySequence
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PatternCatalog;
  }
  if (typeof global !== 'undefined') global.PatternCatalog = PatternCatalog;
  if (typeof window !== 'undefined') window.PatternCatalog = PatternCatalog;
  if (typeof globalThis !== 'undefined') globalThis.PatternCatalog = PatternCatalog;
})(typeof window !== 'undefined' ? window : globalThis);
