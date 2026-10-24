/**
 * PatternStore — persisted record of REAL pattern firings (01.01 v2).
 * ================================================================
 * The headless pattern engine (orb-bridge) evaluates the catalog
 * patterns (src/algorithm/analysis) against the real history on every
 * settled round, BEFORE that round is appended — strictly walk-forward,
 * the same honesty rule as the per-model history. Every pattern that
 * fires for a round is recorded here with the prediction it made and
 * whether it hit, so the Analyse numbers and the Incharge pattern
 * blend are computed from rounds that actually happened — never from
 * a back-computed full-history scan presented as foresight.
 *
 * Backfill (rounds already in the stored history when the engine
 * first attaches) is processed chronologically through the same
 * walk-forward path and labelled source 'backfill' in code; live
 * rounds are labelled 'live'. Records are capped per pattern +
 * timeframe (default last 500) while the aggregate counters keep the
 * FULL totals, so pruning a record list never rewrites the numbers.
 */

export const PATTERN_STORE_KEY = 'o101_pattern_history_v1';
export const PATTERN_RECORD_CAP = 500;

export class PatternStore {
  constructor(storage = null, key = PATTERN_STORE_KEY, { recordCap = PATTERN_RECORD_CAP } = {}) {
    this.storage = storage;
    this.key = key;
    this.recordCap = recordCap;
    this.data = { v: 1, records: {}, counters: {} };
    this.load();
  }

  load() {
    try {
      const raw = this.storage ? this.storage.getItem(this.key) : null;
      if (raw) {
        const d = JSON.parse(raw);
        if (d && d.v === 1 && d.records && d.counters) this.data = d;
      }
    } catch (e) { /* corrupted storage must never break the app */ }
  }

  save() {
    try {
      if (this.storage) this.storage.setItem(this.key, JSON.stringify(this.data));
    } catch (e) { /* quota: in-memory counters still power this session */ }
    this._dirty = false;
  }

  /** Persist once if any deferred firings were recorded since the last save. */
  flush() {
    if (this._dirty) this.save();
  }

  _key(patternId, timeframe) {
    return String(patternId) + '|' + String(timeframe);
  }

  /**
   * Record one pattern firing for one settled round. Idempotent per
   * (patternId, timeframe, period): a round is never double-counted.
   * Returns true when the firing was recorded.
   * Pass { deferSave: true } when recording in a batch (the settlement
   * feed records many firings per cycle); the caller must flush()
   * afterwards — one store write per batch instead of one per firing.
   */
  recordFiring({ patternId, patternName = null, timeframe, period, prediction, hit, source = 'live', deferSave = false } = {}) {
    if (!patternId || !timeframe || period === null || period === undefined) return false;
    if (prediction !== 'BIG' && prediction !== 'SMALL') return false;
    const k = this._key(patternId, timeframe);
    const list = this.data.records[k] || (this.data.records[k] = []);
    const p = String(period);
    if (list.some(r => r.period === p)) return false;
    list.push({ period: p, prediction, hit: hit === true, source });
    if (list.length > this.recordCap) list.splice(0, list.length - this.recordCap);
    const c = this.data.counters[k] || (this.data.counters[k] = { patternId: String(patternId), name: patternName || String(patternId), timeframe: String(timeframe), fired: 0, hits: 0, lastPeriod: null });
    if (patternName) c.name = patternName;
    c.fired += 1;
    if (hit === true) c.hits += 1;
    c.lastPeriod = p;
    if (deferSave) this._dirty = true; else this.save();
    return true;
  }

  hasFiring(patternId, timeframe, period) {
    const list = this.data.records[this._key(patternId, timeframe)];
    return !!list && list.some(r => r.period === String(period));
  }

  /** Aggregate stats for one pattern + timeframe (null when never fired). */
  stats(patternId, timeframe) {
    const c = this.data.counters[this._key(patternId, timeframe)];
    if (!c) return null;
    return {
      patternId: c.patternId, name: c.name, timeframe: c.timeframe,
      fired: c.fired, hits: c.hits,
      hitRate: c.fired ? c.hits / c.fired : 0,
      lastPeriod: c.lastPeriod
    };
  }

  /** Aggregate stats for one pattern merged across ALL timeframes. */
  mergedStats(patternId) {
    let fired = 0, hits = 0, lastPeriod = null, name = String(patternId);
    for (const c of Object.values(this.data.counters)) {
      if (c.patternId !== String(patternId)) continue;
      fired += c.fired; hits += c.hits; name = c.name;
      if (c.lastPeriod !== null && (lastPeriod === null || String(c.lastPeriod) > String(lastPeriod))) lastPeriod = c.lastPeriod;
    }
    if (!fired) return null;
    return { patternId: String(patternId), name, timeframe: 'ALL', fired, hits, hitRate: hits / fired, lastPeriod };
  }

  /**
   * Every counter row, optionally restricted to one timeframe.
   * Sorted by firings desc, then hit-rate desc — the Analyse order.
   */
  allStats(timeframe = null) {
    return Object.values(this.data.counters)
      .filter(c => timeframe === null || c.timeframe === timeframe)
      .map(c => ({
        patternId: c.patternId, name: c.name, timeframe: c.timeframe,
        fired: c.fired, hits: c.hits,
        hitRate: c.fired ? c.hits / c.fired : 0,
        lastPeriod: c.lastPeriod
      }))
      .sort((a, b) => (b.fired - a.fired) || (b.hitRate - a.hitRate));
  }

  /** Distinct timeframes that hold at least one firing. */
  timeframes() {
    return [...new Set(Object.values(this.data.counters).map(c => c.timeframe))];
  }

  /** Raw records for one pattern + timeframe (oldest → newest). */
  records(patternId, timeframe) {
    return [...(this.data.records[this._key(patternId, timeframe)] || [])];
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PatternStore, PATTERN_STORE_KEY, PATTERN_RECORD_CAP };
}

if (typeof self !== 'undefined') {
  self.PatternStore = PatternStore;
}
