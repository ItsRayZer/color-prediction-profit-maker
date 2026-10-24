/**
 * historyRoad.js — full-history road helpers (pure, testable spec).
 * ═══════════════════════════════════════════════════════════════════
 * The owner's 2026-10-24 report: the history/sequence road showed
 * only the past ~11 roads. The caps were render caps, not store
 * caps: renderAssistantMiniRoad sliced 8, renderHeroSequentialBallRoad
 * sliced 25, and the AI bead road was fed slice(-25). This module is
 * the tested spec for the fix — the renderers in mobile.js implement
 * exactly this behaviour inline (a classic script cannot import an
 * ES module): full list, newest first, rendered in chunks so a long
 * history never janks the UI, nothing hidden behind a count cap.
 */

/** Full road list: every round, newest first, NO count cap. */
export function fullRoadList(list = []) {
  if (!Array.isArray(list)) return [];
  return [...list].reverse();
}

/** Split items into chunks of `size` (last chunk may be short). */
export function chunkList(items = [], size = 60) {
  const out = [];
  const n = Math.max(1, size | 0);
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fullRoadList, chunkList };
}
