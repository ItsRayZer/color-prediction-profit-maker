/**
 * Pattern Sync Client & Offline Queue Handler (ESM)
 * Delivers offline-first pattern delta synchronization to Cloudflare / Firebase.
 */

import { patternStorage } from '../storage/patternDb.js';

export class PatternSyncClient {
  constructor(storage = patternStorage, apiEndpoint = '/api/pattern/sync') {
    this.storage = storage;
    this.apiEndpoint = apiEndpoint;
    this.isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    this.isSyncing = false;
    this.syncIntervalId = null;
    this.statusListeners = new Set();
    this.stats = {
      queued: 0,
      synced: 0,
      failed: 0,
      lastSyncTime: null
    };

    this.initNetworkListeners();
  }

  initNetworkListeners() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.isOnline = true;
        this.notifyStatus('ONLINE');
        this.flushQueue();
      });

      window.addEventListener('offline', () => {
        this.isOnline = false;
        this.notifyStatus('OFFLINE');
      });
    }
  }

  onStatusChange(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  notifyStatus(status) {
    for (const listener of this.statusListeners) {
      try {
        listener(status, { ...this.stats });
      } catch (e) {}
    }
  }

  startPeriodicSync(intervalMs = 30000) {
    if (this.syncIntervalId) clearInterval(this.syncIntervalId);
    this.syncIntervalId = setInterval(() => {
      if (this.isOnline) this.flushQueue();
    }, intervalMs);
  }

  stopPeriodicSync() {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  async queuePatternDelta(pattern, occurrence) {
    const delta = {
      patternId: pattern.patternId,
      fingerprint: pattern.fingerprint,
      type: pattern.type,
      interval: pattern.interval,
      length: pattern.length,
      normalizedSequence: pattern.normalizedSequence,
      occurrenceDelta: 1,
      period: occurrence?.period,
      nextResult: occurrence?.nextResult || null
    };

    await this.storage.enqueueSyncDelta(delta);
    this.stats.queued++;
    this.notifyStatus('DELTA_QUEUED');

    if (this.isOnline && !this.isSyncing) {
      this.flushQueue();
    }
  }

  async flushQueue() {
    if (this.isSyncing) return;
    this.isSyncing = true;
    this.notifyStatus('SYNCING');

    try {
      const items = await this.storage.getQueuedSyncItems();
      this.stats.queued = items.length;

      if (items.length === 0) {
        this.notifyStatus('IDLE');
        this.isSyncing = false;
        return;
      }

      // Batch send
      const batch = items.slice(0, 50);

      try {
        const resp = await fetch(this.apiEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batch })
        });

        if (resp.ok) {
          // Mark items as synced
          for (const item of batch) {
            item.status = 'SYNCED';
            item.syncedAt = Date.now();
            if (this.storage.driver.stores?.syncQueue) {
              await this.storage.driver.stores.syncQueue.put(item);
            }
          }
          this.stats.synced += batch.length;
          this.stats.queued = Math.max(0, this.stats.queued - batch.length);
          this.stats.lastSyncTime = new Date().toISOString();
          this.notifyStatus('SYNC_SUCCESS');
        } else {
          this.stats.failed += batch.length;
          this.notifyStatus('SYNC_FAILED');
        }
      } catch (networkErr) {
        // Network error / offline
        this.stats.failed++;
        this.notifyStatus('OFFLINE');
      }
    } finally {
      this.isSyncing = false;
    }
  }
}

export const patternSync = new PatternSyncClient();

if (typeof globalThis !== 'undefined') {
  globalThis.PatternSync = {
    PatternSyncClient,
    patternSync
  };
}
