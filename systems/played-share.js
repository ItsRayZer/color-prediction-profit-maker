/**
 * played-share.js — OPT-IN played-data pipeline (app -> worker -> dataset).
 * ═══════════════════════════════════════════════════════════════════════════
 * Owner order 2026-10-30: "send all user played data back to server, like
 * one data, and use it". The app has other users, so this is OPT-IN:
 * a Settings toggle (default OFF). When ON, settled governed BET rounds
 * are batched and POSTed to the worker's /api/played route.
 *
 * PRIVACY INVARIANTS (test-pinned):
 * - Default OFF. Nothing is ever sent unless the user flips the toggle.
 * - installId is a random 32-hex string, generated on-device. It is NOT
 *   derived from anything identifying (no email, no device id, no login).
 * - Payloads carry ONLY played rounds: tf/issueNumber/number/color/size/
 *   prediction/stake/outcome/fired/settledAt. sanitizePlayedRound REJECTS
 *   any round containing a credential-like key (token, secret, cookie,
 *   auth, password, session, credential, bearer) — the bridge's ar_token
 *   can never ride along, by construction.
 * - Toggling OFF drops the unsent queue (consent withdrawn).
 * - All sends fail silently and never block settlement or the UI.
 *
 * Node-safe: pure functions are exported for tests; browser-only paths
 * are guarded by typeof window / typeof fetch checks.
 */

export const PLAYED_SHARE_KEY = 'o101_played_share';
export const PLAYED_QUEUE_KEY = 'o101_played_queue_v1';
export const PLAYED_LASTFLUSH_KEY = 'o101_played_lastflush_v1';
export const INSTALL_ID_KEY = 'o101_install_id';
export const PLAYED_API_PATH = '/api/played';
export const PLAYED_FLUSH_COUNT = 10;          // flush every ~10 settled rounds…
export const PLAYED_FLUSH_MS = 5 * 60 * 1000;  // …or 5 minutes, whichever first
export const PLAYED_QUEUE_CAP = 500;           // bounded: drop oldest past this

const TF_SET = new Set(['30s', '1m', '3m', '5m']);
const COLOR_SET = new Set(['RED', 'GREEN', 'RED+VIOLET', 'GREEN+VIOLET']);
const SIZE_SET = new Set(['BIG', 'SMALL']);
const OUTCOME_SET = new Set(['win', 'loss']);
// Defense in depth: played data must never carry credentials.
const FORBIDDEN_KEY_RE = /token|secret|cookie|auth|password|session|credential|bearer/i;

/** Opt-in flag. Default OFF: anything but the literal '1' reads as off. */
export function isPlayedShareOn(storage) {
  try {
    return !!storage && storage.getItem(PLAYED_SHARE_KEY) === '1';
  } catch (e) {
    return false;
  }
}

function randomHexBytes(n) {
  const buf = new Uint8Array(n);
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(buf);
    } else {
      // Fallback (very old runtimes): install id is not a secret.
      for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
    }
  } catch (e) {
    for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isValidInstallId(s) {
  return typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);
}

/** Random on-device id, persisted. Never derived from identity. Null without storage. */
export function getOrCreateInstallId(storage) {
  try {
    if (!storage) return null;
    const cur = storage.getItem(INSTALL_ID_KEY);
    if (isValidInstallId(cur)) return cur;
    const id = randomHexBytes(16);
    storage.setItem(INSTALL_ID_KEY, id);
    return id;
  } catch (e) {
    return null;
  }
}

function isPlainObject(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o);
}

/**
 * Sanitize one played round. Returns the clean round, or null when
 * invalid. Any credential-like key rejects the WHOLE round. Never throws.
 */
export function sanitizePlayedRound(input) {
  try {
    if (!isPlainObject(input)) return null;
    for (const k of Object.keys(input)) {
      if (FORBIDDEN_KEY_RE.test(k)) return null;
    }
    const { tf, issueNumber, number, color, size, prediction, stake, outcome, fired, settledAt } = input;
    if (!TF_SET.has(tf)) return null;
    if (typeof issueNumber !== 'string' || !/^[0-9A-Za-z_-]{1,40}$/.test(issueNumber)) return null;
    if (!Number.isInteger(number) || number < 0 || number > 9) return null;
    if (!COLOR_SET.has(color)) return null;
    if (!SIZE_SET.has(size)) return null;
    if (typeof prediction !== 'string' || prediction.length === 0 || prediction.length > 16) return null;
    if (typeof stake !== 'number' || !Number.isFinite(stake) || stake < 0 || stake > 1e7) return null;
    if (!OUTCOME_SET.has(outcome)) return null;
    if (typeof settledAt !== 'string' || Number.isNaN(Date.parse(settledAt))) return null;
    // Balance snapshot (owner order 2026-10-30): optional, null-safe.
    // Passed through to the worker, which ignores unknown fields it
    // doesn't validate (confirmed: validatePlayedRound destructures
    // known fields only; the forbidden-key check can't match these).
    // Omitted entirely when null (matches the worker's shape).
    const bal = Number(input.balance);
    const hbal = Number(input.highestBalance);
    const out = {
      tf,
      issueNumber,
      number,
      color,
      size,
      prediction,
      stake: Math.round(stake * 100) / 100,
      outcome,
      fired: fired === true,
      settledAt,
    };
    if (Number.isFinite(bal) && bal >= 0) out.balance = Math.round(bal * 100) / 100;
    if (Number.isFinite(hbal) && hbal > 0) out.highestBalance = Math.round(hbal * 100) / 100;
    return out;
  } catch (e) {
    return null;
  }
}

/** Build the POST payload. Rounds are re-sanitized; installId is validated. */
export function buildPlayedPayload(installId, rounds) {
  const clean = [];
  if (Array.isArray(rounds)) {
    for (const r of rounds) {
      const s = sanitizePlayedRound(r);
      if (s) clean.push(s);
    }
  }
  return {
    installId: isValidInstallId(installId) ? installId : null,
    rounds: clean,
    sentAt: new Date().toISOString(),
  };
}

// ── Queue (storage-backed, bounded) ──────────────────────────────────

export function loadQueue(storage) {
  try {
    if (!storage) return [];
    const raw = storage.getItem(PLAYED_QUEUE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const r of arr) {
      const s = sanitizePlayedRound(r);
      if (s) out.push(s);
      if (out.length >= PLAYED_QUEUE_CAP) break;
    }
    return out;
  } catch (e) {
    return [];
  }
}

export function saveQueue(storage, q) {
  try {
    if (!storage) return false;
    const arr = Array.isArray(q) ? q.slice(-PLAYED_QUEUE_CAP) : [];
    storage.setItem(PLAYED_QUEUE_KEY, JSON.stringify(arr));
    return true;
  } catch (e) {
    return false;
  }
}

/** Enqueue one round (deduped by tf+issueNumber). Returns false when rejected. */
export function enqueuePlayedRound(storage, round) {
  const clean = sanitizePlayedRound(round);
  if (!clean) return false;
  const q = loadQueue(storage);
  const key = clean.tf + ':' + clean.issueNumber;
  if (q.some((r) => r.tf + ':' + r.issueNumber === key)) return true; // already queued
  q.push(clean);
  return saveQueue(storage, q);
}

/** Drop the queue + flush watermark (used on opt-out and after a 2xx send). */
export function clearPlayedQueue(storage) {
  try {
    if (!storage) return;
    storage.removeItem(PLAYED_QUEUE_KEY);
    storage.removeItem(PLAYED_LASTFLUSH_KEY);
  } catch (e) {}
}

// ── Browser send path (guarded; never throws, never blocks) ─────────

function safeStore() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const t = '__o101_ps_probe__';
    localStorage.setItem(t, '1');
    localStorage.removeItem(t);
    return localStorage;
  } catch (e) {
    return null;
  }
}

function resolveShareEndpoint() {
  try {
    if (typeof window === 'undefined') return null;
    const base = window.CF_WORKER_BASE;
    if (typeof base !== 'string' || !/^https?:\/\//i.test(base)) return null;
    return base.replace(/\/+$/, '') + PLAYED_API_PATH;
  } catch (e) {
    return null;
  }
}

let _flushTimer = null;
function ensureFlushTimer() {
  try {
    if (typeof window === 'undefined' || _flushTimer) return;
    _flushTimer = setInterval(() => {
      try {
        maybeFlushPlayedShare();
      } catch (e) {}
    }, 60 * 1000);
    if (_flushTimer && typeof _flushTimer.unref === 'function') _flushTimer.unref();
  } catch (e) {}
}

function lastFlushAt(storage) {
  try {
    return Number(storage.getItem(PLAYED_LASTFLUSH_KEY)) || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Flush the queue when due (>=10 rounds or >=5 min since last flush).
 * Fire-and-forget: returns true when a send was attempted. Never throws.
 */
export function maybeFlushPlayedShare(storage) {
  try {
    const st = storage || safeStore();
    if (!isPlayedShareOn(st)) return false;
    const q = loadQueue(st);
    if (!q.length) return false;
    const due = q.length >= PLAYED_FLUSH_COUNT || Date.now() - lastFlushAt(st) >= PLAYED_FLUSH_MS;
    if (!due) return false;
    const installId = getOrCreateInstallId(st);
    const endpoint = resolveShareEndpoint();
    if (!installId || !endpoint || typeof fetch !== 'function') return false;
    const payload = buildPlayedPayload(installId, q);
    if (!payload.installId || !payload.rounds.length) {
      clearPlayedQueue(st);
      return false;
    }
    try {
      st.setItem(PLAYED_LASTFLUSH_KEY, String(Date.now()));
    } catch (e) {}
    fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'omit', // never send cookies/credentials with research data
      keepalive: true,
    })
      .then((res) => {
        if (res && res.ok) clearPlayedQueue(st);
        // else: keep the bounded queue; the next flush retries. Silent.
      })
      .catch(() => {
        /* silent: the share must never break the app */
      });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Settlement hook — call after a governed BET settles with:
 * {tf, issueNumber, number, color, size, prediction, stake,
 *  outcome: 'win'|'loss', fired: bool, settledAt: ISO}.
 * No-op unless the user opted in. Never throws, never blocks.
 */
export function notePlayedRound(round, storage) {
  try {
    const st = storage || safeStore();
    if (!isPlayedShareOn(st)) return false;
    if (!enqueuePlayedRound(st, round)) return false;
    ensureFlushTimer();
    maybeFlushPlayedShare(st); // fire-and-forget
    return true;
  } catch (e) {
    return false;
  }
}
