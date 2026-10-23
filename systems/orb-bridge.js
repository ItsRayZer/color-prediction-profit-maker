/**
 * orb-bridge.js — Smart Ball background decision layer.
 * ════════════════════════════════════════════════════════════════════
 * REBASED 2026-10-24 onto the owner's live app (0one.pages.dev): loaded
 * as a module by mobile.html AFTER the live app's own engine scripts
 * (quant_algorithm, arena_models, wingo systems, pattern analysis).
 * Those engines stay loaded and untouched — this bridge is the
 * decision layer OVER them. It drives the live ball window's NEXT
 * PREDICTION area (target, calibrated confidence, bankroll Base/Bet)
 * and the window's bridge status line; the live app's own leaderboard
 * (AI tab) is NOT duplicated.
 *
 *  - Maintains a persisted per-model history (localStorage, versioned)
 *    for EVERY arena model: on every settled round it records the pick
 *    each model made from the data available BEFORE that round
 *    (walk-forward — the same method the app's own arena audit uses),
 *    the active pattern context, the actual result, and correctness.
 *  - Runs the v2 systems in the background on that real record:
 *    InchargeEngine (Wilson/UCB) chooses the Incharge, BlacklistManager
 *    benches failing models (shadow scoring continues), the
 *    CalibrationTracker measures stated vs actual probability, the
 *    signal gate decides BET or SKIP, and bankroll.js runs the
 *    double-on-loss ladder inside its caps (advice/state only — this
 *    bridge never places a bet).
 *  - Feeds the existing Assistant Orb via predictBot lines: gate
 *    decisions with reasons, Incharge changes, win/loss events,
 *    ladder state and every stop state. Serious tone on losses is
 *    predictBot's own rule. No confidence is ever shown uncalibrated.
 *
 * Everything is defensive: if the app's data is not ready, the bridge
 * waits quietly. It never throws into the page.
 */

import { InchargeEngine, INCHARGE_MODES, wilsonLowerBound } from './inchargeEngine.js';
import { CalibrationTracker, plattScale } from './calibration.js';
import { evaluateSignalGate, GATE_DECISIONS, GateCooldown } from './signalGate.js';
import { BlacklistManager } from './blacklist.js';
import {
  createSession, settle, planLadder, suggestBaseBet,
  balanceSourceLabel, BALANCE_SOURCES, DEFAULT_STAKING_MODE
} from './bankroll.js';
import { botLine, BOT_EVENTS } from './predictBot.js';

export const MODEL_HISTORY_KEY = 'o101_model_history_v1';
const RECENT_CAP = 100;
const RAW_CAP = 200;

// ─────────────────────────────────────────────────────────────────────
// Persisted per-model history store (pure, testable)
// ─────────────────────────────────────────────────────────────────────
export class ModelHistoryStore {
  constructor(storage = null, key = MODEL_HISTORY_KEY) {
    this.storage = storage;
    this.key = key;
    this.data = { v: 1, tf: {} };
    this._dirty = false;
    this.load();
  }

  load() {
    try {
      const raw = this.storage ? this.storage.getItem(this.key) : null;
      if (raw) {
        const d = JSON.parse(raw);
        if (d && d.v === 1 && d.tf && typeof d.tf === 'object') this.data = d;
      }
    } catch (e) { /* corrupted storage must never break the app */ }
  }

  save() {
    try {
      if (this.storage) this.storage.setItem(this.key, JSON.stringify(this.data));
      this._dirty = false;
    } catch (e) { /* quota: aggregates in memory still power this session */ }
  }

  _tf(tf) {
    if (!this.data.tf[tf]) this.data.tf[tf] = { models: {}, periods: [] };
    return this.data.tf[tf];
  }

  hasPeriod(tf, period) {
    const bucket = this.data.tf[tf];
    return !!bucket && bucket.periods.includes(String(period));
  }

  /**
   * Record one settled round for many models at once.
   * entries: [{ modelId, pick, patternKey, patternName, correct, source }]
   * Idempotent per (tf, period): a round is never double-counted.
   */
  recordRound(tf, period, entries) {
    const bucket = this._tf(tf);
    const p = String(period);
    if (bucket.periods.includes(p)) return false;
    bucket.periods.push(p);
    if (bucket.periods.length > 2000) bucket.periods = bucket.periods.slice(-2000);

    for (const e of entries || []) {
      if (!e || !e.modelId || e.correct === null || e.correct === undefined) continue;
      let m = bucket.models[e.modelId];
      if (!m) {
        m = bucket.models[e.modelId] = {
          evaluated: 0, wins: 0, losses: 0, streak: 0,
          recent: [], patterns: {}, rounds: []
        };
      }
      const ok = e.correct === true;
      m.evaluated += 1;
      if (ok) { m.wins += 1; m.streak += 1; } else { m.losses += 1; m.streak = 0; }
      m.recent.push(ok ? 1 : 0);
      if (m.recent.length > RECENT_CAP) m.recent = m.recent.slice(-RECENT_CAP);
      if (e.patternKey) {
        const pat = m.patterns[e.patternKey] || (m.patterns[e.patternKey] = { name: e.patternName || e.patternKey, fired: 0, hits: 0 });
        pat.fired += 1;
        if (ok) pat.hits += 1;
      }
      m.rounds.push({ period: p, pick: e.pick || null, patternKey: e.patternKey || null, correct: ok, source: e.source || 'live' });
      if (m.rounds.length > RAW_CAP) m.rounds = m.rounds.slice(-RAW_CAP);
    }
    this._dirty = true;
    return true;
  }

  /** Aggregate stats for one model (null when it has no record yet). */
  modelStats(tf, modelId) {
    const bucket = this.data.tf[tf];
    const m = bucket && bucket.models[modelId];
    if (!m || !m.evaluated) return null;
    const recentEvaluated = m.recent.length;
    const recentWins = m.recent.reduce((a, b) => a + b, 0);
    return {
      evaluated: m.evaluated,
      wins: m.wins,
      losses: m.losses,
      winRate: m.wins / m.evaluated,
      wilson: wilsonLowerBound(m.wins, m.evaluated),
      streak: m.streak,
      recentEvaluated,
      recentWins,
      recentWinRate: recentEvaluated ? recentWins / recentEvaluated : null
    };
  }

  /** Per-pattern hit summary for one model ([] when none recorded). */
  patternSummary(tf, modelId) {
    const bucket = this.data.tf[tf];
    const m = bucket && bucket.models[modelId];
    if (!m) return [];
    return Object.entries(m.patterns).map(([key, p]) => ({
      key, name: p.name, fired: p.fired, hits: p.hits,
      hitRate: p.fired ? p.hits / p.fired : 0
    })).sort((a, b) => b.fired - a.fired);
  }

  /** Per-pattern summary merged across ALL timeframes (global scope). */
  patternSummaryAll(modelId) {
    const merged = {};
    for (const tf of Object.keys(this.data.tf)) {
      for (const p of this.patternSummary(tf, modelId)) {
        const cur = merged[p.key] || (merged[p.key] = { key: p.key, name: p.name, fired: 0, hits: 0 });
        cur.fired += p.fired;
        cur.hits += p.hits;
      }
    }
    return Object.values(merged)
      .map(p => ({ ...p, hitRate: p.fired ? p.hits / p.fired : 0 }))
      .sort((a, b) => b.fired - a.fired);
  }

  /** Pattern summary for a governance scope ('ALL' merges timeframes). */
  patternSummaryFor(scopeKey, modelId) {
    return scopeKey === 'ALL' ? this.patternSummaryAll(modelId) : this.patternSummary(scopeKey, modelId);
  }

  /** Stats for every recorded model in a timeframe: { modelId: stats } */
  allModelStats(tf) {
    const bucket = this.data.tf[tf];
    const out = {};
    if (!bucket) return out;
    for (const id of Object.keys(bucket.models)) {
      const s = this.modelStats(tf, id);
      if (s) out[id] = s;
    }
    return out;
  }

  recordedPeriodCount(tf) {
    const bucket = this.data.tf[tf];
    return bucket ? bucket.periods.length : 0;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Walk-forward pick computation (pure)
// ─────────────────────────────────────────────────────────────────────
/**
 * Entries for the round at history[index], computed ONLY from
 * history[0..index-1] — the data that existed before that round.
 * genFn(model, historySlice, stats) -> pred with .target/.conf
 * evalFn(target, number, size, color) -> true/false/null
 */
export function walkForwardEntries(models, history, index, genFn, evalFn, patternCtx = null, source = 'backfill') {
  const round = history[index];
  if (!round) return [];
  const slice = history.slice(0, index).filter(r => !r.gap);
  const entries = [];
  for (const model of models || []) {
    let pred = null;
    try { pred = genFn(model, slice, { streak: model.streak || 0, dopamine: model.dopamine ?? 0.5, lossPain: model.lossPain ?? 0 }); } catch (e) { pred = null; }
    const target = pred ? (pred.target || pred.predTarget) : null;
    if (!target) continue;
    let correct = null;
    try { correct = evalFn(target, round.number, round.size, round.color); } catch (e) { correct = null; }
    if (correct === null || correct === undefined) continue;
    entries.push({
      modelId: model.id,
      pick: target,
      patternKey: patternCtx ? patternCtx.key : null,
      patternName: patternCtx ? patternCtx.name : null,
      correct: !!correct,
      source
    });
  }
  return entries;
}

/** Picks for the NEXT round from the full current history (pure). */
export function nextRoundPicks(models, history, genFn) {
  const slice = (history || []).filter(r => !r.gap);
  const out = new Map();
  for (const model of models || []) {
    try {
      const pred = genFn(model, slice, { streak: model.streak || 0, dopamine: model.dopamine ?? 0.5, lossPain: model.lossPain ?? 0 });
      const target = pred ? (pred.target || pred.predTarget) : null;
      if (target) out.set(model.id, { target, conf: typeof pred.conf === 'number' ? pred.conf : null });
    } catch (e) { /* one bad model must not stop the arena */ }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Login verification (pure, testable)
// ─────────────────────────────────────────────────────────────────────
// REBASE v2 RULE (owner's order, 2026-10-24): the old two-kind rule
// still amounted to guessing — a token in storage or a number scraped
// off the page is not proof of a live session, and the balance it
// produced was not necessarily the account's real balance. The truth
// source is now the bridge's published USER STATE (dhaniwin-bridge.js
// section 12): the bridge runs INSIDE the DhaniWin page, proves login
// from the page's own authenticated wallet/user API traffic (and its
// session-powered active re-query of the learned wallet endpoint),
// and publishes { isLoggedIn, balance, balanceSource, apiProven,
// fetchMode, userId, ts, seq } on the BroadcastChannel, via window
// postMessage AND to Firebase RTDB /user_state.
// VERIFIED now requires: a bridge state received ≤60s ago with
// isLoggedIn=true AND apiProven=true. The displayed balance is that
// state's exact figure; when its balanceSource is 'dom' the figure is
// labelled "from page" until an API payload confirms it. Legacy
// signals (USER_SYNC / REAL_BALANCE / app-state polls) still feed
// evidence and explicit negatives, but can never reach VERIFIED on
// their own. An explicit negative drops to NOT_LOGGED_IN immediately;
// a stale bridge state decays VERIFIED back to UNKNOWN; and if NO
// signal of any kind has EVER arrived 15s after load the state is
// NO_SIGNAL — say the bridge is silent instead of checking forever.
export const LOGIN_STATES = { VERIFIED: 'VERIFIED', NOT_LOGGED_IN: 'NOT_LOGGED_IN', UNKNOWN: 'UNKNOWN', NO_SIGNAL: 'NO_SIGNAL' };
export const NO_SIGNAL_AFTER_MS = 15000;
export const BRIDGE_STATE_FRESH_MS = 60000;
export const BRIDGE_STATE_KEY = 'o101_bridge_state_v1';
export const RTDB_BASE = 'https://zer0one-376d1-default-rtdb.asia-southeast1.firebasedatabase.app';

/**
 * Normalise a raw published bridge state (from DHANIWIN_USER_STATE on
 * the channel / postMessage, or the RTDB /user_state node) — or null
 * when the payload is not a bridge state at all. Pure. The session
 * token is NEVER part of a published state; if one ever appears in a
 * payload it is dropped here, never propagated.
 */
export function normaliseBridgeState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type !== undefined && raw.type !== 'DHANIWIN_USER_STATE') return null;
  if (typeof raw.isLoggedIn !== 'boolean' && raw.balance === undefined && raw.apiProven === undefined) return null;
  const balance = raw.balance !== null && raw.balance !== undefined && Number.isFinite(Number(raw.balance)) ? Number(raw.balance) : null;
  return {
    isLoggedIn: typeof raw.isLoggedIn === 'boolean' ? raw.isLoggedIn : null,
    balance,
    balanceSource: raw.balanceSource === 'api' || raw.balanceSource === 'dom' ? raw.balanceSource : null,
    apiProven: raw.apiProven === true,
    fetchMode: raw.fetchMode === 'active' || raw.fetchMode === 'intercept' || raw.fetchMode === 'pending' ? raw.fetchMode : null,
    userId: raw.userId !== null && raw.userId !== undefined ? String(raw.userId) : null,
    ts: Number.isFinite(Number(raw.ts)) ? Number(raw.ts) : null,
    seq: Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : null
  };
}

export class LoginVerifier {
  constructor({ balanceFreshMs = 60000, staleMs = 90000, stateFreshMs = BRIDGE_STATE_FRESH_MS, noSignalAfterMs = NO_SIGNAL_AFTER_MS, startedAt = null } = {}) {
    this.balanceFreshMs = balanceFreshMs;
    this.staleMs = staleMs;
    this.stateFreshMs = stateFreshMs;
    this.noSignalAfterMs = noSignalAfterMs;
    this.startedAt = startedAt !== null && Number.isFinite(Number(startedAt)) ? Number(startedAt) : Date.now();
    this.everObserved = false;
    this.lastSyncAt = null;
    this.lastBalanceAt = null;
    this.lastBridgeLoginAt = null;
    this.lastTokenAt = null;
    this.lastPositiveAt = null;
    this.negativeAt = null;
    this.balance = null;
    // The bridge's published user state (the only path to VERIFIED).
    this.bridgeState = null;      // last normalised state accepted
    this.bridgeStateAt = null;    // app-clock time it was received
  }

  /**
   * Feed one published bridge state (already normalised, or raw — it
   * is normalised here). receivedAt is the APP clock; the bridge's own
   * ts is kept for display but freshness is judged on receivedAt so a
   * skewed page clock cannot fake or kill freshness. Out-of-order
   * states (older ts AND older seq than the last accepted) are
   * ignored, except after a long silence (bridge restart resets seq).
   */
  observeBridgeState(raw, receivedAt = Date.now()) {
    const st = normaliseBridgeState(raw);
    if (!st) return this.status(receivedAt);
    const t = Number.isFinite(Number(receivedAt)) ? Number(receivedAt) : Date.now();
    if (this.bridgeState) {
      const olderTs = st.ts !== null && this.bridgeState.ts !== null && st.ts < this.bridgeState.ts;
      const olderSeq = st.seq !== null && this.bridgeState.seq !== null && st.seq < this.bridgeState.seq;
      const longSilence = t - this.bridgeStateAt > 120000;
      if ((olderTs || olderSeq) && !longSilence) return this.status(t);
    }
    this.everObserved = true;
    this.bridgeState = st;
    this.bridgeStateAt = t;
    this.lastSyncAt = t;
    if (st.isLoggedIn === false) {
      this.negativeAt = t;
    } else if (st.isLoggedIn === true) {
      this.lastPositiveAt = t;
      if (this.negativeAt !== null && this.negativeAt < t) this.negativeAt = null;
    }
    if (st.balance !== null) {
      this.balance = st.balance;
      this.lastBalanceAt = t;
    }
    return this.status(t);
  }

  /**
   * Feed one bridge signal. sig: { isLoggedIn (bool|null), balance
   * (number|null), hasToken (bool), isAuthPage (bool), explicitLogout }
   */
  observe(sig = {}, now = Date.now()) {
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    this.everObserved = true;
    if (sig.explicitLogout || sig.isAuthPage || sig.isLoggedIn === false) {
      this.negativeAt = t;
      if (sig.isLoggedIn === false || sig.isAuthPage) this.lastSyncAt = t;
    }
    if (sig.isLoggedIn === true) {
      this.lastBridgeLoginAt = t;
      this.lastSyncAt = t;
      this.lastPositiveAt = t;
    }
    if (sig.balance !== null && sig.balance !== undefined && Number.isFinite(Number(sig.balance))) {
      this.balance = Number(sig.balance);
      this.lastBalanceAt = t;
      this.lastSyncAt = t;
      this.lastPositiveAt = t;
    }
    if (sig.hasToken) {
      this.lastTokenAt = t;
      this.lastPositiveAt = t;
    }
    return this.status(t);
  }

  status(now = Date.now()) {
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const syncAgeMs = this.lastSyncAt !== null ? Math.max(0, t - this.lastSyncAt) : null;
    const bs = this.bridgeState;
    const stateAgeMs = this.bridgeStateAt !== null ? Math.max(0, t - this.bridgeStateAt) : null;
    const stateFresh = bs !== null && stateAgeMs <= this.stateFreshMs;
    const base = {
      balance: bs && bs.balance !== null ? bs.balance : this.balance,
      balanceSource: bs ? bs.balanceSource : null,
      apiProven: bs ? bs.apiProven : false,
      fetchMode: bs ? bs.fetchMode : null,
      userId: bs ? bs.userId : null,
      stateAgeMs,
      lastSyncAt: this.lastSyncAt,
      syncAgeMs,
      everSynced: this.lastSyncAt !== null
    };
    // An explicit negative that is NEWER than every positive signal
    // wins immediately — including over a still-fresh VERIFIED state
    // (a logout event at T+1s must not wait for the state to stale).
    // Ties go to the negative: when in doubt, say logged out.
    const negativeNewest = this.negativeAt !== null
      && this.negativeAt >= Math.max(
        this.lastPositiveAt === null ? -1 : this.lastPositiveAt,
        this.bridgeStateAt === null ? -1 : this.bridgeStateAt);
    if (negativeNewest) {
      return { ...base, state: LOGIN_STATES.NOT_LOGGED_IN, evidence: ['explicit negative (logout / auth page / bridge state isLoggedIn=false)'] };
    }
    // VERIFIED: fresh bridge state, bridge-proven login, API proof.
    if (stateFresh && bs.isLoggedIn === true && bs.apiProven) {
      const evidence = ['bridge user state (fresh)', 'authenticated wallet API proof'];
      evidence.push(bs.balanceSource === 'api' ? 'balance exact from wallet API' : 'balance from page (DOM), API confirmation pending');
      if (bs.fetchMode) evidence.push(`bridge fetch mode: ${bs.fetchMode}`);
      return { ...base, state: LOGIN_STATES.VERIFIED, evidence };
    }
    // No signal of ANY kind has ever arrived and the grace window has
    // passed: say the bridge is silent instead of "checking" forever.
    if (!this.everObserved && t - this.startedAt >= this.noSignalAfterMs) {
      return { ...base, state: LOGIN_STATES.NO_SIGNAL, balance: this.balance, evidence: [], lastSyncAt: null, syncAgeMs: null, everSynced: false };
    }
    // UNKNOWN — with honest evidence about what is still missing.
    const kinds = [];
    if (bs !== null) {
      if (!stateFresh) kinds.push(`bridge state stale (${Math.round(stateAgeMs / 1000)}s old)`);
      else if (bs.isLoggedIn === true && !bs.apiProven) kinds.push('bridge reports login · waiting for API wallet proof');
      else if (bs.isLoggedIn === null) kinds.push('bridge connected · login not yet determined');
      if (bs.fetchMode === 'pending') kinds.push('wallet endpoint not learned yet (active fetch pending)');
    }
    if (this.lastBridgeLoginAt !== null && t - this.lastBridgeLoginAt <= this.staleMs) kinds.push('legacy sync claims login (not API-proven)');
    if (this.lastBalanceAt !== null && t - this.lastBalanceAt <= this.balanceFreshMs) kinds.push(`balance seen ₹${this.balance} (unproven source)`);
    if (this.lastTokenAt !== null && t - this.lastTokenAt <= this.staleMs) kinds.push('session token present (not proof on its own)');
    return { ...base, state: LOGIN_STATES.UNKNOWN, evidence: kinds };
  }
}

/**
 * Map one raw bridge message (the exact objects dhaniwin-bridge.js
 * posts on BroadcastChannel / window.postMessage, and mobile.js
 * consumes) to a LoginVerifier signal — or null when the message is
 * not a login signal. Pure: shared by the window-message listener,
 * the BroadcastChannel listener and the tests.
 */
export function signalFromBridgeMessage(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return null;
  const url = String(msg.url || '').toLowerCase();
  const isAuthPage = url.includes('/login') || url.includes('/register');
  const balance = msg.balance !== null && msg.balance !== undefined && Number.isFinite(Number(msg.balance)) ? Number(msg.balance) : null;
  switch (msg.type) {
    case 'DHANIWIN_USER_STATE': {
      const bridgeState = normaliseBridgeState(msg);
      return bridgeState ? { bridgeState } : null;
    }
    case 'DHANIWIN_USER_SYNC':
      return {
        isLoggedIn: typeof msg.isLoggedIn === 'boolean' ? msg.isLoggedIn : null,
        balance,
        hasToken: !!msg.token,
        isAuthPage
      };
    case 'DHANIWIN_REAL_BALANCE':
      return balance !== null ? { balance } : null;
    case 'DHANIWIN_LOGIN_DETECTED':
      return { isLoggedIn: true };
    case 'DHANIWIN_USER_LOGGED_OUT':
    case 'DHANIWIN_SESSION_OUT':
      return { explicitLogout: true };
    default:
      return null;
  }
}

/**
 * Derive a verifier signal from a snapshot of the app's own bridge
 * state (window.MobileBridgeState, mobile.js line ~4940: userBalance
 * is only ever set from real bridge sync messages; authToken from a
 * sync or a restored session token). POLLING this state must never
 * fabricate a negative, so `loggedIn` is positive-only: the caller
 * passes true when the app's own login flag is set, otherwise null.
 * Returns { sig, signature } — feed the verifier ONLY when the
 * signature changes, so a static snapshot cannot fake freshness.
 */
export function signalFromBridgeStateSnapshot(snapshot = {}) {
  const bal = Number(snapshot.userBalance);
  const sig = {
    isLoggedIn: snapshot.loggedIn === true ? true : null,
    balance: Number.isFinite(bal) && bal > 0 ? bal : null,
    hasToken: !!snapshot.authToken
  };
  return { sig, signature: JSON.stringify([sig.balance, sig.hasToken, sig.isLoggedIn]) };
}

/** One-line evidence text for the login pill / window status line. Pure. */
export function loginEvidenceLine(login) {
  if (!login) return 'Checking login…';
  const inrFmt = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const ageMs = login.stateAgeMs !== null && login.stateAgeMs !== undefined ? login.stateAgeMs : login.syncAgeMs;
  const age = ageMs !== null && ageMs !== undefined
    ? ` · sync ${Math.max(0, Math.round(ageMs / 1000))}s ago` : '';
  switch (login.state) {
    case LOGIN_STATES.VERIFIED: {
      const label = login.balanceSource === 'api' ? 'exact · API' : login.balanceSource === 'dom' ? 'from page' : 'API-proven';
      return `Login verified · ${inrFmt(login.balance)} (${label})${age}`;
    }
    case LOGIN_STATES.NOT_LOGGED_IN: return 'Not logged in';
    case LOGIN_STATES.NO_SIGNAL: return 'No bridge signal — open DhaniWin with the bridge active';
    default: {
      const ev = Array.isArray(login.evidence) ? login.evidence : [];
      if (ev.some(e => e.includes('API wallet proof'))) return 'Bridge connected · waiting for API wallet proof…';
      if (ev.some(e => e.includes('stale'))) return `Bridge signal stale${age} — waiting for the DhaniWin tab`;
      return login.everSynced ? `Checking login…${age}` : 'Checking login…';
    }
  }
}

/**
 * Structured diagnostic of the login/balance system for the settings
 * page (which renders it as: login state, balance + source, bridge
 * mode, last sync age). Pure — fed from a LoginVerifier status object.
 */
export function bridgeDiagnostic(login) {
  if (!login) {
    return { loginState: 'UNKNOWN', balanceText: '—', balanceSource: null, fetchMode: null, syncAgeText: 'never', line: 'Checking login…' };
  }
  const inrFmt = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const ageMs = login.stateAgeMs !== null && login.stateAgeMs !== undefined ? login.stateAgeMs : login.syncAgeMs;
  return {
    loginState: login.state,
    balanceText: login.balance !== null && login.balance !== undefined ? inrFmt(login.balance) : '—',
    balanceSource: login.balanceSource || null,
    fetchMode: login.fetchMode || null,
    syncAgeText: ageMs !== null && ageMs !== undefined ? `${Math.max(0, Math.round(ageMs / 1000))}s ago` : 'never',
    line: loginEvidenceLine(login)
  };
}

// ─────────────────────────────────────────────────────────────────────
// Per-timeframe governance scope (pure, testable)
// ─────────────────────────────────────────────────────────────────────
// Incharge / gate / blacklist must judge a model on the CURRENT
// timeframe's record. Only when that timeframe has too little history
// (< 50 recorded rounds) may governance fall back to the merged global
// record — and that fallback is always labelled, never silent.
export const GOVERNANCE_MIN_TF_ROUNDS = 50;

export function resolveGovernanceScope(store, tf, minRounds = GOVERNANCE_MIN_TF_ROUNDS) {
  const rounds = store.recordedPeriodCount(tf);
  if (rounds >= minRounds) {
    return { key: tf, tf, perTimeframe: true, rounds, label: `${tf} record · ${rounds} rounds` };
  }
  let total = 0;
  for (const k of Object.keys(store.data.tf)) total += store.recordedPeriodCount(k);
  return { key: 'ALL', tf, perTimeframe: false, rounds: total, label: `global record · ${total} rounds (${tf} has ${rounds}, needs ${minRounds})` };
}

/** One model's stats merged across every timeframe (global scope). */
export function mergedModelStats(store, modelId) {
  let evaluated = 0, wins = 0, losses = 0, recentWins = 0, recentEvaluated = 0;
  let streak = 0, bestEvaluated = -1;
  for (const tf of Object.keys(store.data.tf)) {
    const s = store.modelStats(tf, modelId);
    if (!s) continue;
    evaluated += s.evaluated;
    wins += s.wins;
    losses += s.losses;
    recentWins += s.recentWins;
    recentEvaluated += s.recentEvaluated;
    // Streaks do not merge chronologically across timeframes; report the
    // streak of the timeframe with the deepest record (labelled global).
    if (s.evaluated > bestEvaluated) { bestEvaluated = s.evaluated; streak = s.streak; }
  }
  if (!evaluated) return null;
  return {
    evaluated, wins, losses,
    winRate: wins / evaluated,
    wilson: wilsonLowerBound(wins, evaluated),
    streak,
    recentEvaluated, recentWins,
    recentWinRate: recentEvaluated ? recentWins / recentEvaluated : null
  };
}

/**
 * Engine-ready model pool for a governance scope. When a pattern context
 * is active, each model also carries its hit rate under that exact
 * pattern (patternHitRate / patternSamples) for the bounded ranking
 * blend in InchargeEngine.scoreModel.
 */
export function buildPoolFromStore(store, models, scopeKey, patternCtx = null) {
  return (models || []).map(m => {
    const s = scopeKey === 'ALL' ? mergedModelStats(store, m.id) : store.modelStats(scopeKey, m.id);
    const base = !s
      ? { id: m.id, name: m.name, wins: 0, totalEvaluated: 0, winRate: 0, streak: 0, recentWinRate: null, recentEvaluated: 0 }
      : {
          id: m.id, name: m.name,
          wins: s.wins, totalEvaluated: s.evaluated, winRate: s.winRate,
          streak: s.streak,
          recentWinRate: s.recentWinRate, recentEvaluated: s.recentEvaluated
        };
    if (patternCtx && patternCtx.key) {
      const hit = store.patternSummaryFor(scopeKey, m.id).find(p => p.key === patternCtx.key);
      if (hit) {
        base.patternHitRate = hit.hitRate;
        base.patternSamples = hit.fired;
        base.patternKey = hit.key;
      }
    }
    return base;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Display probability (pure, testable)
// ─────────────────────────────────────────────────────────────────────
// The confidence shown to the user is the raw probability first capped
// to [0.05, 0.95] (hard 0/1 probabilities are never honest) and then run
// through the Platt fit (plattScale with the tracker's fitted a/b) that
// was learned from this app's own recorded outcomes.
export function displayProbability(rawProb, tracker) {
  if (rawProb === null || rawProb === undefined || !Number.isFinite(Number(rawProb))) return null;
  const capped = Math.min(0.95, Math.max(0.05, Number(rawProb)));
  if (!tracker || typeof tracker.fitPlatt !== 'function') return capped;
  const { a, b } = tracker.fitPlatt();
  return plattScale(capped, a, b);
}

// ─────────────────────────────────────────────────────────────────────
// Governed settlement (pure, testable)
// ─────────────────────────────────────────────────────────────────────
// One place decides what a settled governed pick DOES: bankroll ladder
// settlement, the win/loss SOUND hook, and the bot events to speak.
// Before this existed, bridge-governed rounds settled silently — the
// Suii/Bruh cues only ever fired from the old sim path. The sound hook
// is injected (window.playSoundEffect in the browser) so the mobile
// app's own sound setting and synth fallback stay in charge of audio.
export function settleGovernedPick({ won, session = null, gateDecision = null, hooks = {} } = {}) {
  const events = [];
  let nextSession = session || null;
  if (gateDecision !== GATE_DECISIONS.BET) {
    return { session: nextSession, sound: null, events };
  }
  const sound = won ? 'win' : 'loss';
  if (typeof hooks.playSound === 'function') {
    try { hooks.playSound(sound); } catch (e) { /* audio must never break settlement */ }
  }
  if (nextSession && nextSession.nextStake > 0) {
    nextSession = settle(nextSession, !!won);
    events.push(won ? BOT_EVENTS.WIN : BOT_EVENTS.LOSS);
    if (nextSession.state === 'LADDER_EXHAUSTED') events.push(BOT_EVENTS.CIRCUIT_BREAKER);
    else if (nextSession.state === 'STOP_LOSS') events.push(BOT_EVENTS.STOP_LOSS);
    else if (nextSession.state === 'STOP_WIN') events.push(BOT_EVENTS.STOP_WIN);
    else if (!won && nextSession.state === 'CONTINUE') events.push(BOT_EVENTS.LADDER_UP);
  } else {
    events.push(won ? BOT_EVENTS.WIN : BOT_EVENTS.LOSS);
  }
  return { session: nextSession, sound, events };
}

// ═════════════════════════════════════════════════════════════════════
// BROWSER RUNTIME (never runs under node / tests)
// ═════════════════════════════════════════════════════════════════════
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try { initBridge(); } catch (e) { /* the bridge must never break the app */ }
}

function initBridge() {
  const $ = id => document.getElementById(id);
  const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

  const store = new ModelHistoryStore(safeStorage());
  const tracker = new CalibrationTracker();
  // One blacklist per governance scope: a model benched on 30s evidence
  // must not stay benched on 5m, and vice versa.
  const blacklists = new Map();
  const blacklistForScope = key => {
    if (!blacklists.has(key)) blacklists.set(key, new BlacklistManager());
    return blacklists.get(key);
  };
  const engine = new InchargeEngine({ mode: INCHARGE_MODES.WINNING_STREAK_OVERRIDE });
  const verifier = new LoginVerifier();
  const cooldown = new GateCooldown();

  const state = {
    page: null,            // 'mobile' | 'index'
    tf: null,
    lastPeriodSeen: null,  // latest settled period processed
    pendingPicks: null,    // Map for the upcoming round (computed pre-round)
    pendingForPeriod: null,
    inchargeId: null,
    inchargeReason: null,
    gate: null,            // last gate verdict for the upcoming round
    gatePeriodKey: null,   // history fingerprint the gate verdict belongs to
    lastPick: null,        // { target, prob } the bridge displayed for the round that just settled
    session: null,         // bankroll session
    balance: null,
    balanceSource: 'none',
    balanceAnnounced: false,
    greeted: false,
    backfilledKey: null,
    loginState: null,      // last LoginVerifier state string spoken/rendered
    login: null,           // last LoginVerifier status object
    cooldownRound: { active: false, roundsLeft: 0, extraMargin: 0, lossStreak: 0 },
    scopeKey: null,
    scopeLabel: null
  };

  function safeStorage() {
    try { const t = '__o101_probe__'; localStorage.setItem(t, '1'); localStorage.removeItem(t); return localStorage; }
    catch (e) { return null; }
  }

  // ── Page adapters ────────────────────────────────────────────────
  function detectPage() {
    if (window.MobileState && window.MobileState.historyByTf) return 'mobile';
    try { if (typeof S !== 'undefined' && S && Array.isArray(S.history)) return 'index'; } catch (e) {}
    return null;
  }

  function currentTf() {
    if (state.page === 'mobile') return window.MobileState.timeframe || '30s';
    try { return S.timeframe || '30s'; } catch (e) { return '30s'; }
  }

  function rawHistory(tf) {
    if (state.page === 'mobile') return window.MobileState.historyByTf[tf] || [];
    try {
      const byTf = S.historyByTimeframe && S.historyByTimeframe[tf];
      if (byTf && byTf.length) return byTf;
      return S.history || [];
    } catch (e) { return []; }
  }

  function settledHistory(tf) {
    return rawHistory(tf).filter(r => r && !r.gap && r.number !== null && r.number !== undefined);
  }

  function arenaModels() {
    const list = (typeof window !== 'undefined' && Array.isArray(window.ARENA_CANONICAL_MODELS)) ? window.ARENA_CANONICAL_MODELS : [];
    return list;
  }

  function genFn() { return typeof window.generateModelNextPrediction === 'function' ? window.generateModelNextPrediction : null; }
  function evalFn() { return typeof window.evaluatePredictionCorrectness === 'function' ? window.evaluatePredictionCorrectness : null; }

  function activePatternContext(tf) {
    try {
      const gha = window.GameHistoryAnalysis;
      if (gha && typeof gha.getDashboardData === 'function') {
        const d = gha.getDashboardData(tf);
        const cand = d && Array.isArray(d.candidates) ? d.candidates[0] : null;
        const rank = d && d.rankings ? (d.rankings.mostPredictive && d.rankings.mostPredictive[0]) || (d.rankings.activeList && d.rankings.activeList[0]) : null;
        const top = cand || rank;
        if (top) {
          const key = top.signature || top.id || top.patternId || top.fingerprint || top.exactSequence || top.name || null;
          if (key) return { key: String(key), name: String(top.name || top.patternName || top.exactSequence || 'Active pattern') };
        }
      }
    } catch (e) {}
    return null;
  }

  function detectBalance() {
    if (state.page === 'mobile') {
      // The bridge's published user state is the exact figure; the
      // app's own MobileBridgeState balance is the fallback.
      const vs = verifier.bridgeState;
      if (vs && vs.balance !== null && vs.balance !== undefined) {
        return { balance: Number(vs.balance), source: BALANCE_SOURCES.BRIDGE };
      }
      const b = window.MobileBridgeState && Number(window.MobileBridgeState.userBalance);
      if (b && b > 0) return { balance: b, source: BALANCE_SOURCES.BRIDGE };
      return { balance: null, source: 'none' };
    }
    try {
      if (typeof S !== 'undefined' && S && S.isInitialized && Number(S.balance) > 0) {
        return { balance: Number(S.balance), source: BALANCE_SOURCES.MANUAL };
      }
    } catch (e) {}
    return { balance: null, source: 'none' };
  }

  // Hear the bridge feed on EVERY transport it actually uses. The
  // bridge's notifyApp() sends primarily on BroadcastChannel
  // ('dhaniwin_quant_channel') — window.postMessage copies reach only
  // opener/parent, so the old window-'message'-only listener starved
  // and the verifier sat on UNKNOWN forever. Feed all three sources:
  // the channel, window messages, and a read-only poll of the app's
  // own MobileBridgeState (state mobile.js already received counts).
  function feedBridgeMessage(msg) {
    const sig = signalFromBridgeMessage(msg);
    if (!sig) return;
    if (sig.bridgeState) {
      // The published user state is the truth path: its balance is the
      // exact figure (0 is a real balance), its login is API-proven.
      verifier.observeBridgeState(sig.bridgeState, Date.now());
      if (sig.bridgeState.balance !== null) {
        state.balance = sig.bridgeState.balance;
        state.balanceSource = BALANCE_SOURCES.BRIDGE;
      }
    } else {
      verifier.observe(sig, Date.now());
      const b = Number(msg.balance);
      if (Number.isFinite(b) && b > 0) {
        state.balance = b;
        state.balanceSource = BALANCE_SOURCES.BRIDGE;
      }
    }
    const login = verifier.status(Date.now());
    state.login = login;
    renderLogin(login);
  }
  window.addEventListener('message', ev => { feedBridgeMessage(ev && ev.data); });
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const bridgeChannel = new BroadcastChannel('dhaniwin_quant_channel');
      bridgeChannel.onmessage = ev => { feedBridgeMessage(ev && ev.data); };
    }
  } catch (e) { /* channel unavailable: window messages + poll still feed */ }

  // Read-only poll of the app's bridge state (mobile only). Feeds the
  // verifier ONLY when the derived signature changes, so a static
  // snapshot can never fake sync freshness. Positive-only: the app's
  // login flag is set exclusively by bridge-confirmed events inside
  // mobile.js (markUserLoggedIn), never guessed here.
  let lastPolledSignature = null;
  function pollBridgeState() {
    try {
      const mbs = window.MobileBridgeState;
      if (!mbs) return;
      let loggedIn = null;
      try { loggedIn = typeof window.isUserLoggedIn === 'function' && window.isUserLoggedIn() ? true : null; } catch (e) {}
      const { sig, signature } = signalFromBridgeStateSnapshot({
        userBalance: mbs.userBalance,
        authToken: mbs.authToken,
        loggedIn
      });
      if (signature === lastPolledSignature) return;
      lastPolledSignature = signature;
      if (sig.balance === null && !sig.hasToken && sig.isLoggedIn === null) return; // empty state: no information
      verifier.observe(sig, Date.now());
      if (sig.balance !== null) { state.balance = sig.balance; state.balanceSource = BALANCE_SOURCES.BRIDGE; }
      const login = verifier.status(Date.now());
      state.login = login;
      renderLogin(login);
    } catch (e) { /* polling must never break the app */ }
  }
  setInterval(pollBridgeState, 2000);
  setTimeout(pollBridgeState, 1000);

  // Fourth feed: the bridge also publishes its user state to Firebase
  // RTDB /user_state (codebase convention: plain fetch of the .json
  // node, like the universal_state poller). This reaches the app even
  // when the DhaniWin tab is in another window/browser context where
  // BroadcastChannel cannot. Poll politely; failures are silent.
  async function pollRtdbUserState() {
    try {
      if (typeof fetch !== 'function') return;
      const resp = await fetch(`${RTDB_BASE}/user_state.json`, { cache: 'no-store' });
      if (!resp || !resp.ok) return;
      const data = await resp.json();
      const st = normaliseBridgeState(data);
      if (!st) return;
      verifier.observeBridgeState(st, Date.now());
      if (st.balance !== null) { state.balance = st.balance; state.balanceSource = BALANCE_SOURCES.BRIDGE; }
      const login = verifier.status(Date.now());
      state.login = login;
      renderLogin(login);
    } catch (e) { /* offline / rules: channel + postMessage still feed */ }
  }
  setInterval(pollRtdbUserState, 5000);
  setTimeout(pollRtdbUserState, 2500);

  // Persist a compact bridge snapshot so the settings page (a separate
  // document) can show the same diagnostic: login state, exact balance
  // + source, bridge fetch mode, last sync age.
  function persistBridgeSnapshot(login) {
    try {
      const d = bridgeDiagnostic(login);
      const snap = {
        state: d.loginState,
        line: d.line,
        balance: login ? login.balance : null,
        balanceSource: d.balanceSource,
        fetchMode: d.fetchMode,
        lastSyncAt: login ? login.lastSyncAt : null,
        updatedAt: Date.now()
      };
      localStorage.setItem(BRIDGE_STATE_KEY, JSON.stringify(snap));
    } catch (e) { /* storage full/blocked: settings falls back to its own feeds */ }
  }

  // ── Speaking (orb's line) ────────────────────────────────────────
  function say(text) {
    const el = $('smartBallLine');
    if (el && text) el.textContent = text;
    state.lastLine = text;
  }

  function speakEvent(event, extra = {}) {
    const ctx = contextSnapshot(extra);
    const { line } = botLine(event, ctx);
    say(line);
    return line;
  }

  function contextSnapshot(extra = {}) {
    const stats = state.inchargeId ? store.modelStats(state.tf, state.inchargeId) : null;
    const modelObj = arenaModels().find(m => m.id === state.inchargeId) || null;
    return {
      balance: state.balance,
      balanceSource: state.balanceSource,
      balanceSourceLabel: state.balanceSource !== 'none' ? balanceSourceLabel(state.balanceSource) : null,
      baseBet: state.session ? state.session.baseBet : 0,
      ladderLevel: state.session ? state.session.level : 0,
      ladderLevels: state.session ? state.session.ladderLevels : 0,
      nextStake: state.session ? state.session.nextStake : 0,
      sessionPnL: state.session ? state.session.sessionPnL || 0 : 0,
      startingBalance: state.session ? state.session.startingBalance : 0,
      inchargeModel: modelObj ? { id: modelObj.id, name: modelObj.name } : null,
      inchargeReason: state.inchargeReason,
      gateDecision: state.gate,
      pick: state.gate ? state.gate.pick : null,
      calibratedConfidence: state.gate && state.gate.prob !== null && state.gate.prob !== undefined ? state.gate.prob : null,
      isCalibrated: tracker.isCalibrated(),
      streak: stats ? stats.streak : 0,
      circuitBreakerState: state.session && state.session.state === 'LADDER_EXHAUSTED' ? 'TRIPPED' : 'ARMED',
      sessionState: state.session ? state.session.state : null,
      ...extra
    };
  }

  // ── Governance for a timeframe: scope (per-tf or labelled global
  //    fallback), the engine pool for that scope, and its blacklist ──
  function governanceFor(tf) {
    const scope = resolveGovernanceScope(store, tf);
    const patternCtx = activePatternContext(tf);
    const pool = buildPoolFromStore(store, arenaModels(), scope.key, patternCtx);
    const bl = blacklistForScope(scope.key);
    state.scopeKey = scope.key;
    state.scopeLabel = scope.label;
    return { scope, pool, bl, patternCtx };
  }

  // ── Login status: window line + ball announcements ───────────────
  function loginLine(login) {
    if (login.state === LOGIN_STATES.VERIFIED) return `Login verified · ${inr(login.balance)} on DhaniWin (bridge API proof).`;
    if (login.state === LOGIN_STATES.NOT_LOGGED_IN) return 'Not logged in. Open the DhaniWin tab and log in first — no signal or stake until login is verified.';
    if (login.state === LOGIN_STATES.NO_SIGNAL) return 'No bridge signal yet. Open DhaniWin with the bridge active so I can verify your login — I will not guess it.';
    return 'Checking login… waiting for the bridge\'s API-proven user state.';
  }

  function renderLogin(login) {
    const text = loginEvidenceLine(login);
    document.querySelectorAll('.bridge-login-pill').forEach(el => {
      el.textContent = text;
      el.setAttribute('data-state', login.state);
    });
    persistBridgeSnapshot(login);
    renderWindowStatus();
    if (state.loginState !== login.state) {
      state.loginState = login.state;
      say(loginLine(login));
    }
  }

  // The ONE slim line added to the live ball window (#bridgeStatusLine):
  // login evidence first, then the governed call for this round. It
  // never invents a number: balance comes from the bridge state, the
  // call from the gate, stakes from the bankroll session.
  function renderWindowStatus() {
    const el = $('bridgeStatusLine');
    if (!el) return;
    const parts = [];
    if (state.login) parts.push(loginEvidenceLine(state.login));
    const gate = state.gate;
    if (gate) {
      if (gate.decision === GATE_DECISIONS.BET) {
        const verified = state.login && state.login.state === LOGIN_STATES.VERIFIED;
        parts.push('BET ' + (gate.pick || '')
          + (verified && state.session ? ` · ladder step ${state.session.level + 1}/${state.session.ladderLevels} · next ${inr(state.session.nextStake)}` : ''));
      } else {
        parts.push('SKIP — ' + (gate.reason || 'gate declined'));
      }
    }
    el.textContent = parts.length ? parts.join(' · ') : 'Bridge: checking login…';
    el.setAttribute('data-login-state', state.login ? state.login.state : 'UNKNOWN');
  }

  // ── Backfill: walk the stored history once per (tf, history length)
  function backfill(tf, history) {
    const key = tf + ':' + history.length + ':' + (history.length ? history[history.length - 1].period : '');
    if (state.backfilledKey === key) return;
    state.backfilledKey = key;
    const gen = genFn(), ev = evalFn();
    if (!gen || !ev || history.length < 2) return;
    const models = arenaModels();
    if (!models.length) return;
    const patternCtx = activePatternContext(tf);
    // Only rounds not already recorded (live or earlier backfill).
    let idx = history.length - 1;
    const step = () => {
      const t0 = Date.now();
      while (idx >= 1 && Date.now() - t0 < 24) {
        const round = history[idx];
        if (!store.hasPeriod(tf, round.period)) {
          const entries = walkForwardEntries(models, history, idx, gen, ev, patternCtx, 'backfill');
          store.recordRound(tf, round.period, entries);
        }
        idx -= 1;
      }
      if (idx >= 1) setTimeout(step, 60);
      else { store.save(); }
    };
    setTimeout(step, 300);
  }

  // ── One background cycle ─────────────────────────────────────────
  function cycle() {
    const page = detectPage();
    if (!page) return;
    state.page = page;
    // Login verification is re-evaluated every cycle so a VERIFIED state
    // expires to UNKNOWN when the DhaniWin tab goes silent (>90s).
    const login = verifier.status(Date.now());
    state.login = login;
    renderLogin(login);
    const gen = genFn(), ev = evalFn();
    if (!gen || !ev || !arenaModels().length) return;

    const tf = currentTf();
    const history = settledHistory(tf);
    if (!history.length) return;
    state.tf = tf;
    const latest = history[history.length - 1];
    const latestPeriod = String(latest.period);

    // Balance + bankroll session
    const det = detectBalance();
    if (det.balance !== null) { state.balance = det.balance; state.balanceSource = det.source; }
    if (state.balance !== null && !state.session) {
      state.session = createSession(state.balance, { mode: DEFAULT_STAKING_MODE });
      if (!state.balanceAnnounced) {
        state.balanceAnnounced = true;
        if (state.session.state === 'STOP') speakEvent(BOT_EVENTS.BALANCE_LOW);
        else speakEvent(BOT_EVENTS.BALANCE_DETECTED);
      }
    }
    if (state.balance === null && !state.balanceAnnounced) {
      state.balanceAnnounced = true;
      speakEvent(BOT_EVENTS.BALANCE_NOT_DETECTED);
    }

    // New settled round? (Pending picks and the displayed pick were
    // computed from the history ending at the PREVIOUS latest period,
    // so they were issued FOR this newly settled round.)
    const prevLatest = state.lastPeriodSeen;
    if (prevLatest !== latestPeriod) {
      const isFirst = prevLatest === null;
      state.lastPeriodSeen = latestPeriod;

      // 1) Settle the bridge's displayed pick for the round that just
      //    closed (calibration + bankroll + win/loss sound), if we had
      //    issued one. settleGovernedPick owns the sound hook so
      //    governed rounds are never silent.
      if (!isFirst && state.lastPick) {
        const won = ev(state.lastPick.target, latest.number, latest.size, latest.color);
        if (won !== null && won !== undefined) {
          tracker.record(state.lastPick.prob, !!won);
          const gateDecision = state.gate ? state.gate.decision : null;
          const result = settleGovernedPick({
            won: !!won,
            session: state.session,
            gateDecision,
            hooks: {
              playSound: type => { try { if (typeof window.playSoundEffect === 'function') window.playSoundEffect(type); } catch (e) {} }
            }
          });
          state.session = result.session;
          for (const eventName of result.events) {
            speakEvent(eventName, { lastResult: `${latest.size} ${latest.number}` });
          }
          if (gateDecision === GATE_DECISIONS.BET) cooldown.recordSettledBet(!!won);
        }
        state.lastPick = null;
      }

      // A new round begins: consume one anti-tilt cooldown round, if any.
      state.cooldownRound = cooldown.beginRound();

      // 2) Record this round for EVERY model (live pending picks when
      //    we have them, else walk-forward computation for this round).
      if (!store.hasPeriod(tf, latestPeriod)) {
        const patternCtx = activePatternContext(tf);
        let entries;
        if (state.pendingPicks) {
          entries = [];
          for (const [modelId, pred] of state.pendingPicks.entries()) {
            const correct = ev(pred.target, latest.number, latest.size, latest.color);
            if (correct !== null && correct !== undefined) {
              entries.push({ modelId, pick: pred.target, patternKey: patternCtx ? patternCtx.key : null, patternName: patternCtx ? patternCtx.name : null, correct: !!correct, source: 'live' });
            }
          }
        } else {
          entries = walkForwardEntries(arenaModels(), history, history.length - 1, gen, ev, patternCtx, 'backfill');
        }
        store.recordRound(tf, latestPeriod, entries);
        store.save();
      }
      state.pendingPicks = null;

      // First sight of this page: backfill the older stored history in
      // idle chunks so ranking/blacklist start from the full record.
      backfill(tf, history);
    }

    // 3) Engines on the governance scope for this timeframe (per-tf
    //    record, or the labelled global fallback while it warms up)
    const { scope, pool, bl } = governanceFor(tf);
    bl.update(pool);
    engine.config.blacklist = bl;
    const verdict = engine.evaluateIncharge(bl.filterEligible(pool), {});
    const incharge = verdict && verdict.model ? verdict.model : null;

    if (incharge && incharge.id !== state.inchargeId) {
      const changed = state.inchargeId !== null;
      state.inchargeId = incharge.id;
      state.inchargeReason = verdict.reason || null;
      if (changed) speakEvent(BOT_EVENTS.MODEL_CHANGE);
    } else if (incharge) {
      state.inchargeReason = verdict.reason || state.inchargeReason;
    }

    // 4) Picks for the upcoming round + gate
    const picks = nextRoundPicks(arenaModels(), history, gen);
    state.pendingPicks = picks;

    if (incharge) {
      const myPick = picks.get(incharge.id) || null;
      const ranked = engine.rankModels(bl.filterEligible(pool));
      const contenders = ranked.slice(0, 3).map(m => ({ id: m.id, name: m.name, pick: picks.get(m.id) ? picks.get(m.id).target : null }));
      const rawConf = myPick && typeof myPick.conf === 'number' ? Math.min(0.99, Math.max(0.01, myPick.conf)) : null;
      // Displayed confidence: cap hard probabilities, then Platt-scale
      // through the fit learned from recorded outcomes.
      const calibratedProb = rawConf !== null ? displayProbability(rawConf, tracker) : null;
      const poolEntry = pool.find(m => m.id === incharge.id) || null;
      let gate = evaluateSignalGate({
        pick: myPick ? myPick.target : null,
        model: incharge,
        sampleSize: poolEntry ? poolEntry.totalEvaluated : 0,
        calibratedProb,
        calibration: tracker,
        contenders,
        cooldown: state.cooldownRound
      });
      // Login is a hard stop: unless VERIFIED there is no signal and
      // no stake suggestion, whatever the engines think.
      if (login.state !== LOGIN_STATES.VERIFIED) {
        const reason = login.state === LOGIN_STATES.NOT_LOGGED_IN
          ? 'Not logged in: login on the DhaniWin tab first. No signal or stake is suggested until the bridge proves login from its wallet API traffic.'
          : login.state === LOGIN_STATES.NO_SIGNAL
            ? 'No bridge signal: open DhaniWin with the bridge active. No signal or stake is suggested until the bridge proves login from its wallet API traffic.'
            : 'Login not verified yet: waiting for the bridge\'s API-proven user state. No signal or stake is suggested until then.';
        gate = { ...gate, decision: GATE_DECISIONS.SKIP, prob: null, reason };
      }
      state.gate = gate;
      // Remember the displayed pick so its outcome can settle
      // calibration and bankroll when the upcoming round lands.
      state.lastPick = myPick ? { target: myPick.target, prob: calibratedProb !== null ? calibratedProb : rawConf } : null;

      // Orb face + badges reflect the GOVERNED signal, not raw engine output.
      renderSignal(gate, incharge, login);
      renderWindowStatus();
      const gateKey = latestPeriod + ':' + gate.decision + ':' + (gate.pick || '');
      if (state.gatePeriodKey !== gateKey) {
        state.gatePeriodKey = gateKey;
        if (!state.greeted) { state.greeted = true; speakEvent(BOT_EVENTS.GREETING); }
        speakEvent(gate.decision === GATE_DECISIONS.BET ? BOT_EVENTS.SIGNAL_BET : BOT_EVENTS.SIGNAL_SKIP);
      }
    }

    renderRanking(tf, pool, bl, scope);
  }

  // ── Rendering: governed signal into the orb/sheet ────────────────
  function renderSignal(gate, incharge, login) {
    const bet = gate.decision === GATE_DECISIONS.BET;
    // No stake suggestion while login is unverified (UNKNOWN or worse).
    const loginVerified = !!login && login.state === LOGIN_STATES.VERIFIED;
    const confText = bet && gate.prob !== null && gate.prob !== undefined ? Math.round(gate.prob * 100) + '%' : '—';
    if (state.page === 'mobile') {
      const orbTarget = $('floatingOrbTarget');
      if (orbTarget) orbTarget.textContent = bet ? gate.pick : 'SKIP';
      const orbStake = $('floatingOrbStake');
      if (orbStake) orbStake.textContent = bet && loginVerified && state.session ? inr(state.session.nextStake) : '—';
      const targetEl = $('mobileWebTargetDisplay');
      if (targetEl) targetEl.textContent = bet ? gate.pick : 'SKIP';
      const conf = $('assistantConfBadge');
      if (conf) conf.textContent = confText;
      // Ladder Base/Bet in the live window come from bankroll.js (the
      // governed ladder). No stake is shown while login is unverified.
      // The Level badge stays the live app's own recovery display —
      // the governed ladder state is carried by Base/Bet + the status
      // line, never by relabelling the app's ladder.
      const baseEl = $('assistantBaseStakeDisplay');
      if (baseEl) baseEl.textContent = state.session ? inr(state.session.baseBet) : '—';
      const betEl = $('mobileWebStakeDisplay');
      if (betEl) betEl.textContent = bet && loginVerified && state.session ? inr(state.session.nextStake) : '—';
    }
  }

  // ── Rendering: Ranking + Blacklist (single-column minimal list) ──
  function rowHtml(rank, m, stats, wilson) {
    const wr = stats ? (stats.winRate * 100).toFixed(1) + '%' : '—';
    const recent = stats && stats.recentWinRate !== null ? (stats.recentWinRate * 100).toFixed(0) + '%' : '—';
    const pats = store.patternSummaryFor(state.scopeKey || state.tf, m.id);
    const patText = pats.length ? pats.slice(0, 2).map(p => `${p.name} ${Math.round(p.hitRate * 100)}% (${p.fired})`).join(' · ') : 'no pattern history yet';
    const crown = state.inchargeId === m.id ? ' 👑' : '';
    return `<div class="flex items-start justify-between gap-2 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06]">
      <div class="min-w-0">
        <div class="text-[10px] font-bold text-white truncate">${rank}. ${m.name}${crown}</div>
        <div class="text-[8px] font-mono text-zinc-500 truncate">${patText}</div>
      </div>
      <div class="text-right shrink-0">
        <div class="text-[10px] font-black font-mono text-emerald-300">${wr}</div>
        <div class="text-[8px] font-mono text-zinc-500">W ${stats ? stats.wins : 0} · L ${stats ? stats.losses : 0} · n ${stats ? stats.evaluated : 0} · Wilson ${(wilson * 100).toFixed(1)} · recent ${recent} · streak ${stats ? stats.streak : 0}</div>
      </div>
    </div>`;
  }

  function renderRanking(tf, pool, bl, scope) {
    const listEl = $('bridgeRankingList');
    const blEl = $('bridgeBlacklistList');
    if (!listEl && !blEl) return;
    const scopeKey = scope ? scope.key : tf;
    const ranked = engine.rankModels(bl.filterEligible(pool));
    if (listEl) {
      listEl.innerHTML = ranked.map((m, i) => rowHtml(i + 1, m, scopeKey === 'ALL' ? mergedModelStats(store, m.id) : store.modelStats(tf, m.id), typeof engine.scoreModel === 'function' ? engine.scoreModel(m) : wilsonLowerBound(m.wins || 0, m.totalEvaluated || 0))).join('');
    }
    const meta = $('bridgeRankingMeta');
    if (meta) meta.textContent = `${ranked.length} models · ${store.recordedPeriodCount(tf)} rounds recorded · ${tf} · scope: ${scope ? scope.label : tf}`;
    if (blEl) {
      const entries = bl.list();
      blEl.innerHTML = entries.length ? entries.map(e => `<div class="px-3 py-2 rounded-xl bg-rose-500/[0.06] border border-rose-500/20">
        <div class="text-[10px] font-bold text-rose-200">${e.name}</div>
        <div class="text-[8px] font-mono text-zinc-400">${e.reason}</div>
        <div class="text-[8px] font-mono text-zinc-500">WR ${(e.winRate * 100).toFixed(1)}% · samples ${e.samples} · ${e.shadowStatus}</div>
      </div>`).join('') : '<div class="text-[9px] font-mono text-zinc-500 px-1 py-2">No models are blacklisted right now. Models are benched automatically when their proven record falls below breakeven, and return when their shadow record recovers.</div>';
    }
  }

  // ── Public face ──────────────────────────────────────────────────
  window.__smartBall = {
    say,
    context: () => contextSnapshot(),
    openRanking() {
      if (state.page === 'mobile' && typeof window.switchMobileTab === 'function') window.switchMobileTab('ai');
      const ov = $('bridgeRankingOverlay');
      if (ov) ov.classList.remove('hidden');
      const tfNow = state.tf || currentTf();
      const g = governanceFor(tfNow);
      g.bl.update(g.pool);
      renderRanking(tfNow, g.pool, g.bl, g.scope);
    },
    closeRanking() {
      const ov = $('bridgeRankingOverlay');
      if (ov) ov.classList.add('hidden');
    },
    verifyLogin: () => verifier.status(Date.now()),
    loginState: () => state.loginState,
    diagnostic: () => bridgeDiagnostic(verifier.status(Date.now())),
    store,
    _state: state
  };

  setInterval(() => { try { cycle(); } catch (e) {} }, 3000);
  setTimeout(() => { try { cycle(); } catch (e) {} }, 1200);
}
