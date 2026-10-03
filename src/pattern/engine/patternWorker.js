import * as PatternIncremental from './incremental.js';
import * as PatternFingerprint from './fingerprint.js';

// In-worker per-interval buffers and state
const workerTfBuffers = {
  '30s': [],
  '1m': [],
  '3m': [],
  '5m': []
};

const workerTfCheckpoints = {
  '30s': 0,
  '1m': 0,
  '3m': 0,
  '5m': 0
};

// In-memory pattern cache inside worker
const localWorkerPatternRegistry = new Map(); // fingerprint -> patternRecord
const localWorkerOccurrences = []; // list of detailed occurrences

/**
 * Chunked Historical Backfill
 * Processes in chunks of e.g. 50 rounds, reporting percentage progress.
 * Resumable from checkpoint.
 */
async function runChunkedBackfill(interval, fullHistory, startCheckpoint = 0) {
  if (!Array.isArray(fullHistory) || fullHistory.length === 0) {
    postMessage({
      type: 'BACKFILL_COMPLETE',
      interval,
      totalProcessed: 0,
      patternsDiscovered: localWorkerPatternRegistry.size
    });
    return;
  }

  const sortedHistory = [...fullHistory].sort((a, b) => String(a.period).localeCompare(String(b.period)));
  workerTfBuffers[interval] = sortedHistory;

  const total = sortedHistory.length;
  let currentIdx = Math.max(3, startCheckpoint);
  const chunkSize = 25; // Responsive chunk size

  let patternsCount = localWorkerPatternRegistry.size;
  let occurrencesCount = localWorkerOccurrences.length;

  while (currentIdx < total) {
    const endIdx = Math.min(total, currentIdx + chunkSize);

    for (let i = currentIdx; i < endIdx; i++) {
      const subHistory = sortedHistory.slice(0, i + 1);
      const newPatterns = PatternIncremental.extractNewlyCompletedPatterns(interval, subHistory, { maxLen: 30 });

      for (const pat of newPatterns) {
        let record = localWorkerPatternRegistry.get(pat.fingerprint);
        if (!record) {
          record = {
            patternId: pat.patternId,
            fingerprint: pat.fingerprint,
            type: pat.type,
            interval: pat.interval,
            length: pat.length,
            normalizedSequence: pat.normalizedSequence,
            status: 'CANDIDATE',
            occurrenceCount: 0,
            continuation: { next: {}, n: 0, percentages: {}, isLowSample: true },
            recurrence: null
          };
          localWorkerPatternRegistry.set(pat.fingerprint, record);
          patternsCount++;
        }

        record.occurrenceCount++;
        record.status = PatternIncremental.resolveLifecycleStatus(record.occurrenceCount);
        record.recurrence = PatternIncremental.updateRecurrenceInfo(record.recurrence, pat.period, pat.timestamp);

        // Attach continuation if subsequent round exists
        if (i + 1 < total) {
          const nextR = sortedHistory[i + 1];
          const nextNum = nextR.number ?? nextR.openNumber ?? 0;
          const nextSize = nextR.size || (nextNum >= 5 ? 'BIG' : 'SMALL');
          pat.nextResult = nextSize;
          record.continuation = PatternIncremental.updateContinuationStatistics(record.continuation, nextSize);
        }

        localWorkerOccurrences.push(pat);
        occurrencesCount++;
      }
    }

    currentIdx = endIdx;
    workerTfCheckpoints[interval] = currentIdx;

    const progressPct = Number(((currentIdx / total) * 100).toFixed(1));

    postMessage({
      type: 'BACKFILL_PROGRESS',
      interval,
      processed: currentIdx,
      total,
      progressPct,
      patternsDiscovered: patternsCount,
      occurrencesIndexed: occurrencesCount
    });

    // Yield back to allow worker event loop to breathe
    await new Promise(r => setTimeout(r, 0));
  }

  postMessage({
    type: 'BACKFILL_COMPLETE',
    interval,
    totalProcessed: total,
    patternsDiscovered: localWorkerPatternRegistry.size,
    occurrencesIndexed: occurrencesCount
  });
}

/**
 * Process a single new round incrementally
 */
function handleIncrementalNewRound(interval, round) {
  if (!round || !round.period) return;

  const buffer = workerTfBuffers[interval] || (workerTfBuffers[interval] = []);
  const existingIdx = buffer.findIndex(r => String(r.period) === String(round.period));

  if (existingIdx >= 0) {
    buffer[existingIdx] = { ...buffer[existingIdx], ...round };
  } else {
    buffer.push(round);
    if (buffer.length > 2880) buffer.shift();
  }

  // 1. Update continuation of preceding pending patterns with this new round's outcome
  const newNum = round.number ?? round.openNumber ?? 0;
  const newSize = round.size || (newNum >= 5 ? 'BIG' : 'SMALL');

  for (let i = localWorkerOccurrences.length - 1; i >= Math.max(0, localWorkerOccurrences.length - 50); i--) {
    const occ = localWorkerOccurrences[i];
    if (occ.interval === interval && !occ.nextResult) {
      occ.nextResult = newSize;
      const rec = localWorkerPatternRegistry.get(occ.fingerprint);
      if (rec) {
        rec.continuation = PatternIncremental.updateContinuationStatistics(rec.continuation, newSize);
      }
    }
  }

  // 2. Extract newly completed pattern windows
  const newPatterns = PatternIncremental.extractNewlyCompletedPatterns(interval, buffer, { maxLen: 30 });
  const detectedEvents = [];

  for (const pat of newPatterns) {
    let record = localWorkerPatternRegistry.get(pat.fingerprint);
    const isBrandNew = !record;

    if (isBrandNew) {
      record = {
        patternId: pat.patternId,
        fingerprint: pat.fingerprint,
        type: pat.type,
        interval: pat.interval,
        length: pat.length,
        normalizedSequence: pat.normalizedSequence,
        status: 'CANDIDATE',
        occurrenceCount: 0,
        continuation: { next: {}, n: 0, percentages: {}, isLowSample: true },
        recurrence: null
      };
      localWorkerPatternRegistry.set(pat.fingerprint, record);
    }

    record.occurrenceCount++;
    record.status = PatternIncremental.resolveLifecycleStatus(record.occurrenceCount);
    record.recurrence = PatternIncremental.updateRecurrenceInfo(record.recurrence, pat.period, pat.timestamp);

    localWorkerOccurrences.push(pat);
    if (localWorkerOccurrences.length > 5000) localWorkerOccurrences.shift(); // In-memory safety cap

    detectedEvents.push({
      event: isBrandNew ? 'NEW_PATTERN' : 'KNOWN_PATTERN',
      pattern: record,
      occurrence: pat
    });
  }

  // 3. Emit detected events and updated aggregates to main thread
  postMessage({
    type: 'INCREMENTAL_RESULTS',
    interval,
    period: round.period,
    detectedEvents,
    totalPatterns: localWorkerPatternRegistry.size,
    totalOccurrences: localWorkerOccurrences.length
  });
}

self.onmessage = function (e) {
  const { type, data } = e.data || {};

  switch (type) {
    case 'START_BACKFILL': {
      const { interval, history, checkpoint } = data || {};
      runChunkedBackfill(interval || '30s', history || [], checkpoint || 0);
      break;
    }

    case 'NEW_ROUND': {
      const { interval, round } = data || {};
      handleIncrementalNewRound(interval || '30s', round);
      break;
    }

    case 'QUERY_PATTERNS': {
      // Return list of patterns matching filters
      const { filterType, minLength, maxLength } = data || {};
      let list = Array.from(localWorkerPatternRegistry.values());
      if (filterType) list = list.filter(p => p.type === filterType);
      if (minLength) list = list.filter(p => p.length >= minLength);
      if (maxLength) list = list.filter(p => p.length <= maxLength);

      postMessage({
        type: 'QUERY_PATTERNS_RESULT',
        patterns: list.slice(0, 200),
        total: list.length
      });
      break;
    }
  }
};
