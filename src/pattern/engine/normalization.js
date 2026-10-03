/**
 * Pattern Normalization Engine (ESM)
 * Covers all 9 categories:
 * RAW_NUMBER, SIZE, COLOR, PARITY, NUMBER_DIFFERENCE,
 * ABSOLUTE_DIFFERENCE, TRANSITION, STREAK, STRUCTURAL
 */

export const PATTERN_TYPES = {
  RAW_NUMBER: 'RAW_NUMBER',
  SIZE: 'SIZE',
  COLOR: 'COLOR',
  PARITY: 'PARITY',
  NUMBER_DIFFERENCE: 'NUMBER_DIFFERENCE',
  ABSOLUTE_DIFFERENCE: 'ABSOLUTE_DIFFERENCE',
  TRANSITION: 'TRANSITION',
  STREAK: 'STREAK',
  STRUCTURAL: 'STRUCTURAL'
};

export const RAW_MAX_LEN = 12;
export const MAX_SEQUENCE_LEN = 101;

export function normalizeSize(val) {
  if (typeof val === 'number') return val >= 5 ? 'B' : 'S';
  const str = String(val || '').trim().toUpperCase();
  if (str === 'BIG' || str === 'B') return 'B';
  return 'S';
}

export function normalizeColor(val, num) {
  if (num === 0) return 'V';
  if (num === 5) return 'V';
  if (typeof num === 'number') return [1, 3, 7, 9].includes(num) ? 'G' : 'R';
  const str = String(val || '').trim().toUpperCase();
  if (str.includes('VIOLET') || str === 'V') return 'V';
  if (str.includes('GREEN') || str === 'G') return 'G';
  return 'R';
}

export function normalizeParity(val, num) {
  if (typeof num === 'number') return (num % 2 !== 0) ? 'O' : 'E';
  const str = String(val || '').trim().toUpperCase();
  if (str === 'ODD' || str === 'O') return 'O';
  return 'E';
}

export function normalizeStructural(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return '';
  const seenMap = new Map();
  let nextCharCode = 65; // 'A'
  let result = '';

  for (const token of tokens) {
    const key = String(token);
    if (!seenMap.has(key)) {
      seenMap.set(key, String.fromCharCode(nextCharCode));
      nextCharCode++;
    }
    result += seenMap.get(key);
  }
  return result;
}

export function extractNormalizedSequence(type, roundsSlice) {
  if (!Array.isArray(roundsSlice) || roundsSlice.length === 0) return '';

  const numbers = roundsSlice.map(r => parseInt(r.number ?? r.openNumber ?? 0, 10));
  const sizes = roundsSlice.map((r, i) => normalizeSize(r.size !== undefined ? r.size : numbers[i]));
  const colors = roundsSlice.map((r, i) => normalizeColor(r.color, numbers[i]));
  const parities = roundsSlice.map((r, i) => normalizeParity(r.parity, numbers[i]));

  switch (type) {
    case PATTERN_TYPES.RAW_NUMBER:
      return numbers.join(',');

    case PATTERN_TYPES.SIZE:
      return sizes.join('');

    case PATTERN_TYPES.COLOR:
      return colors.join('');

    case PATTERN_TYPES.PARITY:
      return parities.join('');

    case PATTERN_TYPES.NUMBER_DIFFERENCE: {
      const diffs = [];
      for (let i = 1; i < numbers.length; i++) {
        const d = numbers[i] - numbers[i - 1];
        diffs.push(d > 0 ? `+${d}` : `${d}`);
      }
      return diffs.join(',');
    }

    case PATTERN_TYPES.ABSOLUTE_DIFFERENCE: {
      const absDiffs = [];
      for (let i = 1; i < numbers.length; i++) {
        absDiffs.push(Math.abs(numbers[i] - numbers[i - 1]));
      }
      return absDiffs.join(',');
    }

    case PATTERN_TYPES.TRANSITION: {
      const transitions = [];
      for (let i = 1; i < sizes.length; i++) {
        transitions.push(`${sizes[i - 1]}->${sizes[i]}`);
      }
      return transitions.join(',');
    }

    case PATTERN_TYPES.STREAK: {
      const runs = [];
      let currentVal = sizes[0];
      let currentCount = 1;
      for (let i = 1; i < sizes.length; i++) {
        if (sizes[i] === currentVal) {
          currentCount++;
        } else {
          runs.push(`${currentVal}x${currentCount}`);
          currentVal = sizes[i];
          currentCount = 1;
        }
      }
      runs.push(`${currentVal}x${currentCount}`);
      return runs.join(',');
    }

    case PATTERN_TYPES.STRUCTURAL:
      return normalizeStructural(sizes);

    default:
      return '';
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.PatternNormalization = {
    PATTERN_TYPES,
    RAW_MAX_LEN,
    MAX_SEQUENCE_LEN,
    normalizeSize,
    normalizeColor,
    normalizeParity,
    normalizeStructural,
    extractNormalizedSequence
  };
}
