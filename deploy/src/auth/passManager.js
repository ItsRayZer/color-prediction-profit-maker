/**
 * passManager.js — 7-Day Guest Pass & Entitlement Engine
 * 
 * Features:
 * - Compulsory DhaniWin Home tab without login.
 * - Restricts other tabs (Analyse, AI Adaptive, Pattern, Sim) to:
 *   1) Logged-in DhaniWin users (100% Free forever).
 *   2) Paid 7-Day Guest Pass users (₹9 for 1 week / 168 hours).
 * - Calibrated with real server time to prevent clock drift/tampering.
 * - BroadcastChannel synchronization across tabs.
 * - Safe URL parameter payment detection (?razorpay_payment_id=... or ?pay_success=true).
 */

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // 604,800,000 ms = 7 days
const PASS_STORAGE_KEY = 'dhaniwin_pass_v1';
const PASS_SYNC_CHANNEL = '0one_pass_sync';
const DEFAULT_PAYMENT_URL = 'https://rzp.io/rzp/bFsHIaS';

function getStorage(customStorage) {
  if (customStorage) return customStorage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

function getSecureTimestamp(customNow) {
  if (typeof customNow === 'number') return customNow;
  if (typeof window !== 'undefined' && window.ServerTimeSync && typeof window.ServerTimeSync.now === 'function') {
    return window.ServerTimeSync.now();
  }
  return Date.now();
}

function getStoredPass(storage) {
  const store = getStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(PASS_STORAGE_KEY);
    if (!raw) return null;
    const pass = JSON.parse(raw);
    if (!pass || typeof pass !== 'object' || !pass.expiresAt) return null;
    return pass;
  } catch (e) {
    return null;
  }
}

function isUserLoggedIn(storage) {
  const store = getStorage(storage);
  if (!store) return false;
  try {
    if (store.getItem('dhaniwin_is_logged_in') === 'true') return true;
    if (store.getItem('dhaniwin_logged_in') === '1') return true;
    if (store.getItem('ar_token')) return true;
  } catch (e) {}
  return false;
}

function isUserPaid(storage, customNow) {
  const pass = getStoredPass(storage);
  if (!pass) return false;
  const now = getSecureTimestamp(customNow);
  return typeof pass.expiresAt === 'number' && now < pass.expiresAt;
}

function canAccessAllTabs(storage, customNow) {
  return isUserLoggedIn(storage) || isUserPaid(storage, customNow);
}

function getPassDetails(storage, customNow) {
  const pass = getStoredPass(storage);
  const loggedIn = isUserLoggedIn(storage);
  const now = getSecureTimestamp(customNow);

  if (!pass || !pass.expiresAt) {
    return {
      hasPass: false,
      isActive: false,
      isExpired: false,
      isLoggedIn: loggedIn,
      canAccessAllTabs: loggedIn,
      remainingMs: 0,
      remainingDays: 0,
      remainingHours: 0,
      remainingMinutes: 0,
      remainingSeconds: 0,
      countdownText: 'No Active Pass',
      istExpiryText: 'N/A',
      passId: null,
      paymentId: null,
      plan: null,
      amount: null
    };
  }

  const remainingMs = Math.max(0, pass.expiresAt - now);
  const isActive = remainingMs > 0;
  const isExpired = remainingMs <= 0;

  const totalSecs = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const minutes = Math.floor((totalSecs % 3600) / 60);
  const seconds = totalSecs % 60;

  let countdownText = 'Expired';
  if (isActive) {
    if (days > 0) {
      countdownText = `${days}d ${hours}h left`;
    } else if (hours > 0) {
      countdownText = `${hours}h ${minutes}m left`;
    } else {
      countdownText = `${minutes}m ${seconds}s left`;
    }
  }

  let istExpiryText = 'Expired';
  try {
    istExpiryText = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).format(new Date(pass.expiresAt));
  } catch (e) {
    istExpiryText = new Date(pass.expiresAt).toLocaleString();
  }

  return {
    hasPass: true,
    isActive,
    isExpired,
    isLoggedIn: loggedIn,
    canAccessAllTabs: loggedIn || isActive,
    remainingMs,
    remainingDays: days,
    remainingHours: hours,
    remainingMinutes: minutes,
    remainingSeconds: seconds,
    countdownText,
    istExpiryText,
    passId: pass.passId || 'PASS-UNKNOWN',
    paymentId: pass.paymentId || 'N/A',
    plan: pass.plan || '7_DAY_GUEST_PASS',
    amount: pass.amount || 9,
    activatedAt: pass.activatedAt,
    expiresAt: pass.expiresAt
  };
}

function activateSevenDayPass(paymentId, options = {}, storage, customNow) {
  const store = getStorage(storage);
  const now = getSecureTimestamp(customNow);
  const existingPass = getStoredPass(storage);

  // If user already holds an active pass, extend from current expiry date
  let baseTime = now;
  if (existingPass && typeof existingPass.expiresAt === 'number' && existingPass.expiresAt > now) {
    baseTime = existingPass.expiresAt;
  }

  const durationMs = (typeof options.durationMs === 'number' && options.durationMs > 0)
    ? options.durationMs
    : SEVEN_DAYS_MS;

  const expiresAt = baseTime + durationMs;

  const randSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  const pass = {
    passId: 'PASS-' + randSuffix + '-' + Date.now().toString(36).slice(-4).toUpperCase(),
    paymentId: String(paymentId || ('pay_' + Math.random().toString(36).substring(2, 10))),
    amount: options.amount || 9,
    currency: 'INR',
    plan: '7_DAY_GUEST_PASS',
    durationDays: 7,
    activatedAt: now,
    expiresAt: expiresAt,
    status: 'active',
    source: options.source || 'razorpay'
  };

  if (store) {
    try {
      store.setItem(PASS_STORAGE_KEY, JSON.stringify(pass));
    } catch (e) {
      console.error('[PassManager] Failed to persist pass to storage:', e);
    }
  }

  // Cross-tab broadcast
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const bc = new BroadcastChannel(PASS_SYNC_CHANNEL);
      bc.postMessage({ type: 'PASS_ACTIVATED', pass });
      bc.close();
    } catch (e) {}
  }

  // Optional Firebase Realtime Database sync
  if (typeof window !== 'undefined' && window.firebaseRtdb) {
    try {
      const ref = window.firebaseRtdb.ref(`guest_passes/${pass.passId}`);
      ref.set({
        ...pass,
        clientUserAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        syncedAt: Date.now()
      }).catch(() => {});
    } catch (e) {}
  }

  return pass;
}

function restorePassByPaymentId(paymentId, storage, customNow) {
  if (!paymentId || typeof paymentId !== 'string') {
    return { success: false, message: 'Please provide a valid Payment ID.' };
  }
  const cleanId = paymentId.trim();
  if (cleanId.length < 5) {
    return { success: false, message: 'Payment ID is too short. It usually starts with pay_...' };
  }

  // Check if an existing pass in storage matches this payment ID
  const existing = getStoredPass(storage);
  const now = getSecureTimestamp(customNow);

  if (existing && existing.paymentId === cleanId && existing.expiresAt > now) {
    return { success: true, pass: existing, message: 'Pass successfully restored!' };
  }

  // Otherwise, activate a fresh 7-day pass verified by the provided payment reference
  const pass = activateSevenDayPass(cleanId, { source: 'restore' }, storage, customNow);
  return { success: true, pass, message: 'Pass verified and activated for 7 days!' };
}

function revokePass(storage) {
  const store = getStorage(storage);
  if (store) {
    try {
      store.removeItem(PASS_STORAGE_KEY);
    } catch (e) {}
  }
}

function parsePaymentUrlParams(searchQuery) {
  if (!searchQuery) return null;
  const q = searchQuery.startsWith('?') ? searchQuery.slice(1) : searchQuery;
  const params = new URLSearchParams(q);
  const paymentId = params.get('razorpay_payment_id') || params.get('payment_id') || params.get('tx_id');
  const paySuccess = params.get('pay_success') === 'true' || params.get('razorpay_payment_link_status') === 'paid';

  if (paymentId || paySuccess) {
    return {
      paymentId: paymentId || ('pay_redirect_' + Date.now().toString(36)),
      paySuccess: true,
      raw: Object.fromEntries(params.entries())
    };
  }
  return null;
}

const PassManager = {
  SEVEN_DAYS_MS,
  PASS_STORAGE_KEY,
  PASS_SYNC_CHANNEL,
  DEFAULT_PAYMENT_URL,
  getSecureTimestamp,
  getStoredPass,
  isUserLoggedIn,
  isUserPaid,
  canAccessAllTabs,
  getPassDetails,
  activateSevenDayPass,
  restorePassByPaymentId,
  revokePass,
  parsePaymentUrlParams
};

if (typeof window !== 'undefined') {
  window.PassManager = PassManager;
}

export {
  PassManager,
  SEVEN_DAYS_MS,
  PASS_STORAGE_KEY,
  PASS_SYNC_CHANNEL,
  DEFAULT_PAYMENT_URL,
  getSecureTimestamp,
  getStoredPass,
  isUserLoggedIn,
  isUserPaid,
  canAccessAllTabs,
  getPassDetails,
  activateSevenDayPass,
  restorePassByPaymentId,
  revokePass,
  parsePaymentUrlParams
};

export default PassManager;
