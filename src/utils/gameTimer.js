/**
 * Game Timer Engine
 * Synchronized strictly to the IST wall clock / UTC epoch without decrement drift.
 *
 * Round periods:
 * - 30s = 30 seconds
 * - 1m  = 60 seconds
 * - 3m  = 180 seconds
 * - 5m  = 300 seconds
 *
 * For each period:
 * 1. Find elapsedSeconds within the current period.
 * 2. At an exact period boundary, display 00 (or 00:00).
 * 3. Otherwise display periodSeconds - elapsedSeconds.
 * 4. Recalculate from the clock on every update; do not rely on accumulated setInterval decrements.
 */

export const PERIOD_SECONDS = {
  '30s': 30,
  '1m': 60,
  '3m': 180,
  '5m': 300
};

/**
 * Calculate remaining seconds for a given period from a timestamp.
 * At an exact boundary, returns 0. Otherwise returns periodSeconds - elapsed.
 *
 * @param {number} periodSeconds - Duration of the round in seconds (30, 60, 180, 300)
 * @param {number|Date} [now=Date.now()] - Timestamp or Date object
 * @returns {number} Remaining seconds in current round
 */
export function getRemainingSeconds(periodSeconds, now = Date.now()) {
  const ts = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : Date.now());
  const elapsed = Math.floor(ts / 1000) % periodSeconds;
  return elapsed === 0 ? 0 : periodSeconds - elapsed;
}

/**
 * Format remaining seconds for display:
 * - 30s period: displays two-digit seconds "00", "29", "28", ...
 * - 1m, 3m, 5m periods: displays "MM:SS", e.g. "00:00", "00:59", "02:59", "04:59"
 *
 * @param {number} periodSeconds - Round duration in seconds (30, 60, 180, 300)
 * @param {number} remainingSeconds - Seconds remaining (0 to periodSeconds - 1)
 * @returns {string} Formatted display string
 */
export function formatTimerDisplay(periodSeconds, remainingSeconds) {
  if (periodSeconds === 30) {
    return String(remainingSeconds).padStart(2, '0');
  }
  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Format remaining seconds strictly as MM:SS (e.g. for digit boxes)
 * @param {number} remainingSeconds
 * @returns {string} "MM:SS"
 */
export function formatTimerMMSS(remainingSeconds) {
  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Get complete timer state for a period
 * @param {number} periodSeconds
 * @param {number|Date} [now=Date.now()]
 */
export function getTimerState(periodSeconds, now = Date.now()) {
  const remaining = getRemainingSeconds(periodSeconds, now);
  const formatted = formatTimerDisplay(periodSeconds, remaining);
  return {
    periodSeconds,
    remainingSeconds: remaining,
    formattedDisplay: formatted
  };
}

// Global exposure for browser environments (index.html, terminal.html)
if (typeof globalThis !== 'undefined') {
  globalThis.PERIOD_SECONDS = PERIOD_SECONDS;
  globalThis.getRemainingSeconds = getRemainingSeconds;
  globalThis.formatTimerDisplay = formatTimerDisplay;
  globalThis.formatTimerMMSS = formatTimerMMSS;
  globalThis.getTimerState = getTimerState;
}
