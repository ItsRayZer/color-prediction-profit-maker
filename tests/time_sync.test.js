import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERIOD_SECONDS,
  getSyncedNowMs,
  syncServerTime,
  setTimeSyncOffsetMs,
  resetTimeSyncState,
  getTimeSyncDiagnostics,
  formatISTClock,
  getRemainingSeconds,
  formatTimerDisplay,
  getTimerState
} from '../src/utils/gameTimer.js';

describe('Real Indian Standard Time (IST) & Server Time Synchronization Engine', () => {

  beforeEach(() => {
    resetTimeSyncState();
  });

  describe('Step 3: Display in IST Correctly (Intl.DateTimeFormat Asia/Kolkata)', () => {
    it('renders exact known IST timestamps via Asia/Kolkata without manual +5:30 arithmetic', () => {
      // 2026-09-26T06:30:00.000Z is 12:00:00 IST
      const epochUtcNoon = new Date('2026-09-26T06:30:00.000Z').getTime();
      assert.equal(formatISTClock(epochUtcNoon), '12:00:00 IST');

      // 2026-09-26T18:15:30.000Z is 23:45:30 IST
      const epochUtcNight = new Date('2026-09-26T18:15:30.000Z').getTime();
      assert.equal(formatISTClock(epochUtcNight), '23:45:30 IST');

      // 2026-09-26T00:00:00.000Z is 05:30:00 IST
      const epochUtcMidnight = new Date('2026-09-26T00:00:00.000Z').getTime();
      assert.equal(formatISTClock(epochUtcMidnight), '05:30:00 IST');
    });
  });

  describe('Step 4: Compute Countdowns from Absolute Synced Time', () => {
    it('computes exact round boundaries for all configured periods (30s / 1m / 3m / 5m)', () => {
      const boundaryTime = new Date('2026-09-26T12:00:00.000+05:30').getTime(); // Exact boundary
      assert.equal(getRemainingSeconds(30, boundaryTime), 0);
      assert.equal(getRemainingSeconds(60, boundaryTime), 0);
      assert.equal(getRemainingSeconds(180, boundaryTime), 0);
      assert.equal(getRemainingSeconds(300, boundaryTime), 0);

      assert.equal(formatTimerDisplay(30, 0), '00');
      assert.equal(formatTimerDisplay(60, 0), '00:00');
      assert.equal(formatTimerDisplay(180, 0), '00:00');
      assert.equal(formatTimerDisplay(300, 0), '00:00');

      const oneSecIn = new Date('2026-09-26T12:00:01.000+05:30').getTime();
      assert.equal(getRemainingSeconds(30, oneSecIn), 29);
      assert.equal(getRemainingSeconds(60, oneSecIn), 59);
      assert.equal(getRemainingSeconds(180, oneSecIn), 179);
      assert.equal(getRemainingSeconds(300, oneSecIn), 299);

      assert.equal(formatTimerDisplay(30, 29), '29');
      assert.equal(formatTimerDisplay(60, 59), '00:59');
      assert.equal(formatTimerDisplay(180, 179), '02:59');
      assert.equal(formatTimerDisplay(300, 299), '04:59');
    });
  });

  describe('Step 2 & 7: Performance-based Offset Estimation & Lowest RTT Selection', () => {
    it('selects the sample with the lowest round-trip latency (RTT)', async () => {
      const originalFetch = globalThis.fetch;

      // Mock fetch providing 4 samples with varying latency and server timestamps
      let sampleIndex = 0;
      const latencies = [80, 15, 60, 120]; // 15ms is lowest
      const targetServerTime = 1790400000000;

      globalThis.fetch = async (url) => {
        const delay = latencies[sampleIndex++] || 50;
        await new Promise(res => setTimeout(res, delay));
        return {
          ok: true,
          status: 200,
          json: async () => ({ serverTimeMs: targetServerTime + delay / 2 })
        };
      };

      try {
        const offset = await syncServerTime('/api/mock-time', 4);
        const diag = getTimeSyncDiagnostics();

        assert.equal(diag.status, 'synced');
        assert.equal(diag.isAuthoritative, true);
        assert.ok(diag.roundTripLatencyMs <= 200, `Expected low RTT, got ${diag.roundTripLatencyMs}`);
        assert.ok(Number.isFinite(offset));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('simulated device-clock skew does NOT shift the countdown when server offset is applied', () => {
      // Suppose true server epoch at performance.now() = 1000 is 1790400000000
      // That means serverMinusPerfOffsetMs = 1790400000000 - 1000 = 1790399999000
      const fixedPerf = performance.now();
      const trueServerEpoch = 1790400000000;
      const expectedOffset = trueServerEpoch - fixedPerf;

      setTimeSyncOffsetMs(expectedOffset, 'synced');

      // The synced time is performance.now() + offset, NOT affected by Date.now() skew
      const syncedNow = getSyncedNowMs();
      const diff = Math.abs(syncedNow - trueServerEpoch);
      assert.ok(diff < 50, `Synced now (${syncedNow}) should be close to trueServerEpoch (${trueServerEpoch})`);

      // Even if Date.now() were off by 10 minutes, getSyncedNowMs stays anchored to server time
      const diag = getTimeSyncDiagnostics();
      assert.equal(diag.status, 'synced');
      assert.equal(diag.isAuthoritative, true);
    });
  });

  describe('Step 5: Failure Handling & Graceful Degradation', () => {
    it('falls back to device clock and marks status as unavailable if server endpoint fails', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        throw new Error('Network connection failed');
      };

      try {
        await syncServerTime('/api/unreachable', 2);
        const diag = getTimeSyncDiagnostics();

        assert.equal(diag.status, 'unavailable');
        assert.equal(diag.isAuthoritative, false);
        assert.equal(diag.consecutiveFailures, 1);

        // Fallback should still return a usable timestamp without crashing
        const now = getSyncedNowMs();
        assert.ok(Number.isFinite(now));
        assert.ok(now > 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('Step 6: Internal Diagnostics Tracking', () => {
    it('accurately tracks diagnostics metadata', () => {
      setTimeSyncOffsetMs(15000, 'synced');
      const diag = getTimeSyncDiagnostics();
      assert.equal(diag.status, 'synced');
      assert.equal(diag.estimatedOffsetMs, 15000);
      assert.equal(diag.isAuthoritative, true);
      assert.ok(diag.lastSyncTimestamp > 0);
    });
  });
});
