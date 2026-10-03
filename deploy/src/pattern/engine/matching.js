/**
 * Pattern Matching and Similarity Engine (ESM)
 */

export const NEAR_MATCH_ALLOWED_TYPES = new Set([
  'SIZE',
  'COLOR',
  'PARITY',
  'STRUCTURAL'
]);

export const NEAR_MATCH_THRESHOLD = 0.85;

export function calculateHammingDistance(seqA, seqB) {
  if (seqA.length !== seqB.length) return -1;
  let dist = 0;
  for (let i = 0; i < seqA.length; i++) {
    if (seqA[i] !== seqB[i]) {
      dist++;
    }
  }
  return dist;
}

export function calculateSimilarity(type, seqA, seqB) {
  if (!NEAR_MATCH_ALLOWED_TYPES.has(type)) return null;
  if (!seqA || !seqB || seqA.length !== seqB.length) return null;

  const dist = calculateHammingDistance(seqA, seqB);
  if (dist < 0) return null;

  const sim = 1 - (dist / seqA.length);
  return Number(sim.toFixed(4));
}

export function isNearMatch(type, seqA, seqB, threshold = NEAR_MATCH_THRESHOLD) {
  const sim = calculateSimilarity(type, seqA, seqB);
  if (sim === null) return false;
  return sim >= threshold;
}

if (typeof globalThis !== 'undefined') {
  globalThis.PatternMatching = {
    NEAR_MATCH_ALLOWED_TYPES,
    NEAR_MATCH_THRESHOLD,
    calculateHammingDistance,
    calculateSimilarity,
    isNearMatch
  };
}
