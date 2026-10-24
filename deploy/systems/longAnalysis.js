/**
 * longAnalysis.js — background long-sequence analysis (DISPLAY ONLY).
 * ═══════════════════════════════════════════════════════════════════
 * Finds the long structure inside the FULL settled history: size
 * streaks, alternating runs, same-number repeats, and repeated
 * short sequences. It reads history and returns findings — it never
 * touches a verdict, a stake, a gate, or any engine state, and its
 * output is observed history only, never a guarantee or a prediction.
 * Pure + side-effect free: the same input always yields the same
 * findings, and the input array is never mutated (safe to call on a
 * frozen array). The chunked runner keeps long histories off the UI
 * thread's critical path: it slices the work into idle-time chunks
 * and reports once, instead of blocking a render.
 */

const sizeWord = r => {
  if (r === 'BIG' || r === 'SMALL') return r;
  const n = Number(r);
  return Number.isFinite(n) ? (n >= 5 ? 'BIG' : 'SMALL') : null;
};

/** Settled rounds only, in chronological order (old → new). */
export function cleanHistory(history = []) {
  return (history || []).filter(r => r && !r.gap && r.number !== null && r.number !== undefined);
}

function periodOf(r) { return r && r.period !== null && r.period !== undefined ? String(r.period) : null; }

/**
 * Maximal runs of one size (BIG/SMALL) — the "dragon" streaks.
 * A run is reported once, at its full length, with its period range.
 */
export function findSizeRuns(history = []) {
  const rows = cleanHistory(history);
  const runs = [];
  let start = 0;
  for (let i = 1; i <= rows.length; i++) {
    const prev = sizeWord(rows[i - 1].size !== undefined && rows[i - 1].size !== null ? rows[i - 1].size : rows[i - 1].number);
    const cur = i < rows.length ? sizeWord(rows[i].size !== undefined && rows[i].size !== null ? rows[i].size : rows[i].number) : null;
    if (cur !== prev) {
      const len = i - start;
      if (len >= 2) {
        runs.push({
          kind: 'size-run', size: prev, length: len,
          startIdx: start, endIdx: i - 1,
          startPeriod: periodOf(rows[start]), endPeriod: periodOf(rows[i - 1]),
          label: `${prev} × ${len}`
        });
      }
      start = i;
    }
  }
  return runs;
}

/**
 * Maximal strictly alternating runs (BIG, SMALL, BIG, SMALL …),
 * length >= minLen. Reported once at full length.
 */
export function findAlternatingRuns(history = [], minLen = 6) {
  const rows = cleanHistory(history);
  const sizes = rows.map(r => sizeWord(r.size !== undefined && r.size !== null ? r.size : r.number));
  const runs = [];
  let start = 0;
  for (let i = 1; i <= rows.length; i++) {
    const continues = i < rows.length && sizes[i] !== sizes[i - 1] && (i - start < 2 || sizes[i] === sizes[i - 2]);
    if (!continues) {
      const len = i - start;
      if (len >= minLen) {
        runs.push({
          kind: 'alternating', size: null, length: len,
          startIdx: start, endIdx: i - 1,
          startPeriod: periodOf(rows[start]), endPeriod: periodOf(rows[i - 1]),
          label: `Alternating × ${len}`
        });
      }
      start = i;
    }
  }
  return runs;
}

/** Maximal runs of the SAME number consecutively (length >= 2). */
export function findSameNumberRuns(history = []) {
  const rows = cleanHistory(history);
  const runs = [];
  let start = 0;
  for (let i = 1; i <= rows.length; i++) {
    if (i >= rows.length || Number(rows[i].number) !== Number(rows[start].number)) {
      const len = i - start;
      if (len >= 2) {
        runs.push({
          kind: 'same-number', size: null, length: len,
          startIdx: start, endIdx: i - 1,
          startPeriod: periodOf(rows[start]), endPeriod: periodOf(rows[i - 1]),
          label: `Number ${rows[start].number} × ${len}`
        });
      }
      start = i;
    }
  }
  return runs;
}

/**
 * Repeated short size sequences (n-grams over B/S, lengths minLen..
 * maxLen) occurring at least minCount times (non-overlapping
 * occurrences counted). Each finding lists its occurrence periods.
 * Bounded: n-grams are short and the history is scanned once per
 * length, so cost stays linear in history size.
 */
export function findRepeatedSequences(history = [], { minLen = 2, maxLen = 4, minCount = 2 } = {}) {
  const rows = cleanHistory(history);
  const letters = rows.map(r => (sizeWord(r.size !== undefined && r.size !== null ? r.size : r.number) === 'BIG' ? 'B' : 'S'));
  const out = [];
  for (let n = minLen; n <= maxLen; n++) {
    const seen = new Map();
    for (let i = 0; i + n <= letters.length; i++) {
      const key = letters.slice(i, i + n).join('');
      const entry = seen.get(key) || { key, positions: [] };
      // Non-overlapping occurrences only: a repeat must start at or
      // after the previous occurrence's end.
      const last = entry.positions[entry.positions.length - 1];
      if (last === undefined || i >= last + n) entry.positions.push(i);
      seen.set(key, entry);
    }
    for (const entry of seen.values()) {
      if (entry.positions.length >= minCount) {
        out.push({
          kind: 'repeat', size: null, length: n, count: entry.positions.length,
          startIdx: entry.positions[0], endIdx: entry.positions[entry.positions.length - 1] + n - 1,
          startPeriod: periodOf(rows[entry.positions[0]]),
          endPeriod: periodOf(rows[entry.positions[entry.positions.length - 1] + n - 1]),
          label: `${entry.key.split('').join('·')} × ${entry.positions.length}`,
          periods: entry.positions.map(p => periodOf(rows[p]))
        });
      }
    }
  }
  return out;
}

/**
 * The full analysis: every finding class merged, longest first
 * (ties: earliest first). Findings carry ONLY observed-history
 * fields — kind, label, length, count, period range. No verdict,
 * no stake, no gate field exists on any finding by construction.
 */
export function analyseHistory(history = []) {
  const rows = cleanHistory(history);
  if (!rows.length) return { rounds: 0, findings: [] };
  const findings = [
    ...findSizeRuns(rows),
    ...findAlternatingRuns(rows),
    ...findSameNumberRuns(rows),
    ...findRepeatedSequences(rows)
  ];
  findings.sort((a, b) => (b.length - a.length) || (a.startIdx - b.startIdx));
  return { rounds: rows.length, findings };
}

/**
 * Chunked runner: analyses a long history in idle-time slices so
 * the UI thread never blocks on it. onDone receives the same object
 * analyseHistory() returns. Returns a cancel function. Node-safe:
 * requestIdleCallback is used when present, setTimeout otherwise.
 */
export function analyseHistoryChunked(history = [], { onDone = null, chunkSize = 400 } = {}) {
  const rows = cleanHistory(history);
  let cancelled = false;
  let i = 0;
  const schedule = fn => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 200 });
    else setTimeout(fn, 0);
  };
  // The finders are linear scans; chunking here means: yield between
  // the four finder passes on long histories, then report once. For
  // short histories this still completes in a single turn.
  const passes = [
    () => findSizeRuns(rows),
    () => findAlternatingRuns(rows),
    () => findSameNumberRuns(rows),
    () => findRepeatedSequences(rows)
  ];
  const collected = [];
  const step = () => {
    if (cancelled) return;
    const end = Math.min(passes.length, i + 1);
    while (i < end) { collected.push(...passes[i]()); i++; }
    if (i < passes.length) {
      // Yield only when the history is long enough to matter.
      if (rows.length >= chunkSize) schedule(step);
      else step();
    } else if (typeof onDone === 'function') {
      collected.sort((a, b) => (b.length - a.length) || (a.startIdx - b.startIdx));
      onDone({ rounds: rows.length, findings: collected });
    }
  };
  schedule(step);
  return () => { cancelled = true; };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    cleanHistory, findSizeRuns, findAlternatingRuns, findSameNumberRuns,
    findRepeatedSequences, analyseHistory, analyseHistoryChunked
  };
}
