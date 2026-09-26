/**
 * Game Timer Engine
 * Synchronized strictly to real Indian Standard Time (IST) and UTC epoch via server time.
 *
 * Round periods:
 * - 30s = 30 seconds
 * - 1m  = 60 seconds
 * - 3m  = 180 seconds
 * - 5m  = 300 seconds
 */

export const PERIOD_SECONDS = {
  '30s': 30,
  '1m': 60,
  '3m': 180,
  '5m': 300
};

// Internal Time Sync State
let _serverMinusPerfOffsetMs = null;
let _isSyncing = false;
let _syncStatus = 'uninitialized'; // 'synced' | 'syncing' | 'unavailable'
let _lastSyncTimestamp = null;
let _minRoundTripMs = Infinity;
let _detectedDriftMs = 0;
let _consecutiveFailures = 0;
let _resyncTimer = null;
let _listenersInitialized = false;

// Fallback offset: device epoch minus performance.now()
function getDevicePerfOffsetMs() {
  return Date.now() - (typeof performance !== 'undefined' ? performance.now() : 0);
}

/**
 * Returns the current synchronized UTC epoch timestamp in milliseconds.
 * Derived continuously from performance.now() + serverMinusPerfOffsetMs.
 * Never advances by incrementing a counter once per tick.
 *
 * @returns {number} Synced epoch timestamp in ms
 */
export function getSyncedNowMs() {
  if (typeof performance === 'undefined') {
    return Date.now();
  }
  if (_serverMinusPerfOffsetMs !== null) {
    return performance.now() + _serverMinusPerfOffsetMs;
  }
  // Fallback while waiting for initial server sync
  return performance.now() + getDevicePerfOffsetMs();
}

/**
 * Single request sample to calculate serverMinusPerfOffsetMs and round-trip time (RTT).
 * Does not mix Date.now() with performance.now().
 *
 * @param {string} endpoint
 */
async function sampleServerTime(endpoint = '/api/time') {
  const start = performance.now();
  const resp = await fetch(endpoint, {
    cache: 'no-store',
    headers: { 'Accept': 'application/json' }
  });
  if (!resp.ok) {
    throw new Error(`Time server responded with HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const end = performance.now();

  const serverTimeMs = Number(data.serverTimeMs);
  if (!Number.isFinite(serverTimeMs)) {
    throw new Error('Invalid serverTimeMs returned from /api/time');
  }

  const rtt = end - start;
  const midpoint = (start + end) / 2;
  const offset = serverTimeMs - midpoint;

  return { rtt, offset, serverTimeMs };
}

/**
 * Perform server time synchronization by collecting multiple samples
 * and adopting the sample with the lowest round-trip latency.
 *
 * @param {string} [endpoint='/api/time']
 * @param {number} [sampleCount=4]
 * @returns {Promise<number>} serverMinusPerfOffsetMs
 */
export async function syncServerTime(endpoint = '/api/time', sampleCount = 4) {
  if (_isSyncing) return _serverMinusPerfOffsetMs;
  _isSyncing = true;
  _syncStatus = _serverMinusPerfOffsetMs !== null ? 'syncing' : 'uninitialized';

  try {
    const samples = [];
    for (let i = 0; i < sampleCount; i++) {
      try {
        const s = await sampleServerTime(endpoint);
        samples.push(s);
      } catch (e) {
        // Individual sample failure
      }
    }

    if (samples.length === 0) {
      throw new Error('All time sync samples failed');
    }

    // Sort by lowest round-trip time (RTT)
    samples.sort((a, b) => a.rtt - b.rtt);
    const best = samples[0];

    if (_serverMinusPerfOffsetMs !== null) {
      _detectedDriftMs = Math.abs(best.offset - _serverMinusPerfOffsetMs);
    } else {
      _detectedDriftMs = 0;
    }

    _serverMinusPerfOffsetMs = best.offset;
    _minRoundTripMs = best.rtt;
    _lastSyncTimestamp = Date.now();
    _syncStatus = 'synced';
    _consecutiveFailures = 0;

    return _serverMinusPerfOffsetMs;
  } catch (err) {
    _consecutiveFailures++;
    _syncStatus = 'unavailable';
    // Fall back to device clock temporarily
    if (_serverMinusPerfOffsetMs === null) {
      _serverMinusPerfOffsetMs = getDevicePerfOffsetMs();
    }
    return _serverMinusPerfOffsetMs;
  } finally {
    _isSyncing = false;
  }
}

/**
 * Manually set the offset (primarily for unit testing with simulated clocks)
 */
export function setTimeSyncOffsetMs(offsetMs, status = 'synced') {
  _serverMinusPerfOffsetMs = offsetMs;
  _syncStatus = status;
  _lastSyncTimestamp = Date.now();
}

/**
 * Reset time sync state (for unit testing)
 */
export function resetTimeSyncState() {
  _serverMinusPerfOffsetMs = null;
  _isSyncing = false;
  _syncStatus = 'uninitialized';
  _lastSyncTimestamp = null;
  _minRoundTripMs = Infinity;
  _detectedDriftMs = 0;
  _consecutiveFailures = 0;
  if (_resyncTimer) {
    clearInterval(_resyncTimer);
    _resyncTimer = null;
  }
  _listenersInitialized = false;
}

/**
 * Get internal diagnostics for monitoring synchronization health
 */
export function getTimeSyncDiagnostics() {
  return {
    status: _syncStatus,
    estimatedOffsetMs: _serverMinusPerfOffsetMs,
    lastSyncTimestamp: _lastSyncTimestamp,
    roundTripLatencyMs: _minRoundTripMs === Infinity ? 0 : _minRoundTripMs,
    detectedDriftMs: _detectedDriftMs,
    consecutiveFailures: _consecutiveFailures,
    isAuthoritative: _syncStatus === 'synced'
  };
}

/**
 * Formatter for Indian Standard Time (IST, UTC+05:30) using Intl.DateTimeFormat.
 * Does not manually add 5:30 or rely on device local timezone.
 */
const istDateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

/**
 * Format timestamp into IST wall clock string ("HH:MM:SS IST")
 *
 * @param {number|Date} [timestamp]
 * @returns {string} e.g. "12:00:00 IST"
 */
export function formatISTClock(timestamp = getSyncedNowMs()) {
  const ts = typeof timestamp === 'number' ? timestamp : (timestamp instanceof Date ? timestamp.getTime() : getSyncedNowMs());
  const dateObj = new Date(ts);
  return `${istDateTimeFormatter.format(dateObj)} IST`;
}

/**
 * Calculate remaining seconds for a given period from absolute synchronized time.
 * At an exact boundary, returns 0. Otherwise returns periodSeconds - elapsed.
 *
 * @param {number} periodSeconds - Duration in seconds (30, 60, 180, 300)
 * @param {number|Date} [now] - Defaults to getSyncedNowMs()
 * @returns {number}
 */
export function getRemainingSeconds(periodSeconds, now = getSyncedNowMs()) {
  const ts = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : getSyncedNowMs());
  const elapsed = Math.floor(ts / 1000) % periodSeconds;
  return elapsed === 0 ? 0 : periodSeconds - elapsed;
}

/**
 * Format remaining seconds for display:
 * - 30s period: displays two-digit seconds "00", "29", "28", ...
 * - 1m, 3m, 5m periods: displays "MM:SS", e.g. "00:00", "00:59", "02:59", "04:59"
 *
 * @param {number} periodSeconds
 * @param {number} remainingSeconds
 * @returns {string}
 */
export function formatTimerDisplay(periodSeconds, remainingSeconds) {
  if (periodSeconds === 30) {
    return String(remainingSeconds).padStart(2, '0');
  }
  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatTimerMMSS(remainingSeconds) {
  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function getTimerState(periodSeconds, now = getSyncedNowMs()) {
  const remaining = getRemainingSeconds(periodSeconds, now);
  const formatted = formatTimerDisplay(periodSeconds, remaining);
  return {
    periodSeconds,
    remainingSeconds: remaining,
    formattedDisplay: formatted
  };
}

/**
 * Initialize time sync background scheduler and lifecycle hooks.
 * Re-syncs every 60s, on visibilitychange (tab resume), window focus, and online.
 */
export function initTimeSyncScheduler(endpoint = '/api/time') {
  if (typeof window === 'undefined') return;

  syncServerTime(endpoint).catch(() => {});

  if (!_listenersInitialized) {
    _listenersInitialized = true;

    if (_resyncTimer) clearInterval(_resyncTimer);
    _resyncTimer = setInterval(() => {
      syncServerTime(endpoint).catch(() => {});
    }, 60000);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        syncServerTime(endpoint).catch(() => {});
      }
    });

    window.addEventListener('focus', () => {
      syncServerTime(endpoint).catch(() => {});
    });

    window.addEventListener('online', () => {
      syncServerTime(endpoint).catch(() => {});
    });
  }
}

// Global exposure for browser environments (index.html, terminal.html)
if (typeof globalThis !== 'undefined') {
  globalThis.PERIOD_SECONDS = PERIOD_SECONDS;
  globalThis.getSyncedNowMs = getSyncedNowMs;
  globalThis.syncServerTime = syncServerTime;
  globalThis.setTimeSyncOffsetMs = setTimeSyncOffsetMs;
  globalThis.resetTimeSyncState = resetTimeSyncState;
  globalThis.getTimeSyncDiagnostics = getTimeSyncDiagnostics;
  globalThis.formatISTClock = formatISTClock;
  globalThis.getRemainingSeconds = getRemainingSeconds;
  globalThis.formatTimerDisplay = formatTimerDisplay;
  globalThis.formatTimerMMSS = formatTimerMMSS;
  globalThis.getTimerState = getTimerState;
  globalThis.initTimeSyncScheduler = initTimeSyncScheduler;
}
