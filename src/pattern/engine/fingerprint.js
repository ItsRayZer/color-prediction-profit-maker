/**
 * Deterministic Fingerprint and Pattern ID Generation
 * SHA-256(type|interval|length|normalizedSequence)
 * Pattern ID: "PAT-" + first 8 hex characters in uppercase
 */

// Universal synchronous SHA-256 implementation ensuring 100% deterministic
// identical execution across Node.js, Web Worker, Browser, Cloudflare Worker, and edge environments.
export function sha256Sync(str) {
  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }

  const mathPow = Math.pow;
  let result = '';

  const words = [];
  const asciiBitLength = str.length * 8;

  let hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];

  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  let i = 0;
  for (i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    words[i >> 2] |= (code & 0xff) << ((3 - (i % 4)) * 8);
  }
  words[i >> 2] |= 0x80 << ((3 - (i % 4)) * 8);
  words[(((str.length + 8) >> 6) + 1) * 16 - 1] = asciiBitLength;

  for (let j = 0; j < words.length; j += 16) {
    const w = words.slice(j, j + 16);
    const oldHash = hash.slice(0);

    for (let idx = 16; idx < 64; idx++) {
      const s0 = rightRotate(w[idx - 15], 7) ^ rightRotate(w[idx - 15], 18) ^ (w[idx - 15] >>> 3);
      const s1 = rightRotate(w[idx - 2], 17) ^ rightRotate(w[idx - 2], 19) ^ (w[idx - 2] >>> 10);
      w[idx] = (w[idx - 16] + s0 + w[idx - 7] + s1) | 0;
    }

    for (let idx = 0; idx < 64; idx++) {
      const s1 = rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25);
      const ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
      const temp1 = (hash[7] + s1 + ch + k[idx] + w[idx]) | 0;
      const s0 = rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22);
      const maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
      const temp2 = (s0 + maj) | 0;

      hash[7] = hash[6];
      hash[6] = hash[5];
      hash[5] = hash[4];
      hash[4] = (hash[3] + temp1) | 0;
      hash[3] = hash[2];
      hash[2] = hash[1];
      hash[1] = hash[0];
      hash[0] = (temp1 + temp2) | 0;
    }

    for (let idx = 0; idx < 8; idx++) {
      hash[idx] = (hash[idx] + oldHash[idx]) | 0;
    }
  }

  for (let idx = 0; idx < 8; idx++) {
    for (let b = 3; b >= 0; b--) {
      const byte = (hash[idx] >>> (b * 8)) & 0xff;
      result += (byte < 16 ? '0' : '') + byte.toString(16);
    }
  }

  return result.toLowerCase();
}

export function createIdentityString(type, interval, length, normalizedSequence) {
  const normType = String(type).trim().toUpperCase();
  const normInterval = String(interval).trim().toLowerCase();
  const normLength = parseInt(length, 10);
  const normSeq = String(normalizedSequence).trim();
  return `${normType}|${normInterval}|${normLength}|${normSeq}`;
}

export function generateFingerprint(type, interval, length, normalizedSequence) {
  const idStr = createIdentityString(type, interval, length, normalizedSequence);
  return sha256Sync(idStr);
}

export function generatePatternId(type, interval, length, normalizedSequence) {
  const fingerprint = generateFingerprint(type, interval, length, normalizedSequence);
  return 'PAT-' + fingerprint.slice(0, 8).toUpperCase();
}

if (typeof globalThis !== 'undefined') {
  globalThis.PatternFingerprint = {
    sha256Sync,
    createIdentityString,
    generateFingerprint,
    generatePatternId
  };
}
