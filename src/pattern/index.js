/**
 * Master Entry Point: Pattern Intelligence Module
 * Coordinates Engine, Storage, Sync, API, and UI.
 */

import { patternStorage } from './storage/patternDb.js';
import { patternApi } from './api/patternIntelligence.js';
import { patternSync } from './sync/syncClient.js';
import { PatternView } from './ui/patternView.js';
import * as PatternIncremental from './engine/incremental.js';

class PatternIntelligenceCoordinator {
  constructor() {
    this.storage = patternStorage;
    this.api = patternApi;
    this.sync = patternSync;
    this.view = null;
    this.worker = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    this.initialized = true;

    // 1. Initialize IndexedDB storage
    await this.storage.init();

    // 2. Initialize UI View
    this.view = new PatternView('tab-pattern');
    if (typeof window !== 'undefined') {
      window.patternViewInstance = this.view;
      const patternSec = document.getElementById('tab-pattern');
      if (patternSec && patternSec.style.display !== 'none') {
        this.view.mount();
      }
    }

    // 3. Initialize Web Worker
    this.initWorker();

    // 4. Start periodic background delta sync
    this.sync.startPeriodicSync(20000);

    console.log('[Pattern Intelligence] Initialized isolated layer successfully.');
  }

  initWorker() {
    if (typeof Worker === 'undefined') return;

    try {
      this.worker = new Worker('src/pattern/engine/patternWorker.js', { type: 'module' });
      this.worker.onerror = (err) => {
        console.warn('[PatternWorker] Worker error, switching to inline pattern processor:', err.message || err);
        this.worker = null;
      };
    } catch (e) {
      this.worker = null;
      console.warn('[PatternWorker] Inline pattern engine active');
      return;
    }

    this.worker.onmessage = async (e) => {
      const { type, ...data } = e.data || {};

      switch (type) {
        case 'BACKFILL_PROGRESS': {
          if (this.view) {
            this.view.updateBackfillProgress({
              interval: data.interval,
              processed: data.processed,
              total: data.total,
              pct: data.progressPct,
              patternsDiscovered: data.patternsDiscovered
            });
          }
          break;
        }

        case 'BACKFILL_COMPLETE': {
          if (this.view) {
            this.view.updateBackfillProgress({ pct: 100 });
            this.view.refreshStats();
            this.view.refreshPatternList();
          }
          break;
        }

        case 'INCREMENTAL_RESULTS': {
          const { interval, detectedEvents } = data;
          if (Array.isArray(detectedEvents)) {
            for (const item of detectedEvents) {
              // Persist locally in IndexedDB
              await this.storage.savePattern(item.pattern);
              await this.storage.saveOccurrence(item.occurrence);

              // Queue for cloud delta sync
              await this.sync.queuePatternDelta(item.pattern, item.occurrence);

              // Add to live feed UI
              if (this.view) {
                this.view.addFeedItem(item);
              }
            }
          }
          if (this.view) {
            this.view.refreshStats();
            this.view.refreshPatternList();
          }
          break;
        }
      }
    };
  }

  /**
   * Safe read-only hook: called when a new round is received.
   * Falls back to inline extraction if worker unavailable.
   */
  onNewRound(interval, round) {
    if (!round || !round.period) return;
    if (this.worker) {
      this.worker.postMessage({
        type: 'NEW_ROUND',
        data: { interval: interval || '30s', round }
      });
    } else {
      // Inline fallback: extract incrementally without worker
      try {
        this._inlineBuf = this._inlineBuf || {};
        if (!this._inlineBuf[interval]) this._inlineBuf[interval] = [];
        const arr = this._inlineBuf[interval];
        if (!arr.find(r => String(r.period) === String(round.period))) {
          arr.push(round);
          if (arr.length > 2880) arr.shift();
        }
        const detected = PatternIncremental.extractNewlyCompletedPatterns(interval, arr, { maxLen: 30 });
        for (const pat of detected) {
          this.storage.savePattern(pat).catch(() => {});
          if (this.view) this.view.refreshPatternList();
        }
      } catch (e) {}
    }
  }

  /**
   * Safe read-only hook: snapshot model prediction output when generated
   */
  async onModelPrediction(interval, period, modelId, target, confidence = null) {
    if (!modelId || !period || !target) return;
    try {
      await this.storage.saveModelSnapshot({
        interval,
        period,
        modelId,
        target,
        confidence,
        timestamp: new Date().toISOString(),
        correct: null // Evaluated when actual outcome becomes known
      });
    } catch (e) {}
  }

  /**
   * Safe read-only hook: update model snapshot correctness on settlement
   */
  async onRoundSettlement(interval, period, actualNumber, actualSize, actualColor) {
    // Read-only snapshot settlement update
  }

  /**
   * Trigger historical backfill via worker or inline fallback.
   */
  startBackfill(interval, history) {
    if (!Array.isArray(history) || history.length === 0) return;
    if (this.worker) {
      this.worker.postMessage({
        type: 'START_BACKFILL',
        data: { interval, history, checkpoint: 0 }
      });
    } else {
      // Inline fallback: chunked extraction without worker
      const sorted = [...history].sort((a, b) => String(a.period).localeCompare(String(b.period)));
      this._inlineBuf = this._inlineBuf || {};
      this._inlineBuf[interval] = sorted;
      const CHUNK = 20;
      let idx = 3;
      const processChunk = () => {
        const end = Math.min(sorted.length, idx + CHUNK);
        for (let i = idx; i < end; i++) {
          try {
            const sub = sorted.slice(0, i + 1);
            const pats = PatternIncremental.extractNewlyCompletedPatterns(interval, sub, { maxLen: 30 });
            for (const p of pats) { this.storage.savePattern(p).catch(() => {}); }
          } catch (e) {}
        }
        idx = end;
        if (idx < sorted.length) {
          setTimeout(processChunk, 0);
        } else {
          if (this.view) { this.view.refreshStats(); this.view.refreshPatternList(); }
        }
      };
      setTimeout(processChunk, 0);
    }
  }
}

export const patternCoordinator = new PatternIntelligenceCoordinator();

if (typeof window !== 'undefined') {
  window.PatternIntelligence = patternCoordinator;
  // Auto-init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => patternCoordinator.init());
  } else {
    patternCoordinator.init();
  }
}
