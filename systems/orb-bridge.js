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
import { evaluateSignalGate, GATE_DECISIONS, GateCooldown, GovernedStreakGuard, HARD_STOP_REASON } from './signalGate.js';
import { BlacklistManager } from './blacklist.js';
import {
  createSession, settle, planLadder, suggestBaseBet,
  balanceSourceLabel, BALANCE_SOURCES, DEFAULT_STAKING_MODE
} from './bankroll.js';
import { botLine, BOT_EVENTS } from './predictBot.js';
import { AutoPilot, AUTOPILOT_SETTINGS_KEY, STOP_REASONS as AP_STOP_REASONS, autoBaseBet } from './autoPilot.js';
import { PatternStore } from './patternStore.js';

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
    // Defensive bound only (the recorded period-id list): set far
    // beyond any real session so the evaluation path always sees the
    // FULL persisted history — the aggregate counters below are never
    // capped at all. (Audit 2026-10-24: was 2000.)
    if (bucket.periods.length > 100000) bucket.periods = bucket.periods.slice(-100000);

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
// The one plain-words line for "we are on the direct route BECAUSE
// the proxy failed": proxy unreachable, direct mode, bridge inactive,
// and login cannot be verified in this mode. Shared by the sheet
// status line and the settings diagnostic so they can never disagree.
export const PROXY_FAILED_LINE = 'Proxy unreachable — direct mode · bridge inactive · login cannot be verified in this mode';

export function bridgeDiagnostic(login, transport, proxyFailed) {
  const direct = transport === 'direct';
  const failed = direct && !!proxyFailed;
  if (!login) {
    return { loginState: 'UNKNOWN', balanceText: '—', balanceSource: null, fetchMode: direct ? 'inactive (direct load)' : null, syncAgeText: 'never', line: failed ? PROXY_FAILED_LINE : 'Checking login…', transport: transport || null, proxyFailed: failed };
  }
  const inrFmt = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const ageMs = login.stateAgeMs !== null && login.stateAgeMs !== undefined ? login.stateAgeMs : login.syncAgeMs;
  return {
    loginState: login.state,
    balanceText: login.balance !== null && login.balance !== undefined ? inrFmt(login.balance) : '—',
    balanceSource: login.balanceSource || null,
    // On a direct load the bridge is never injected, so its fetch
    // mode is honestly "inactive" — never a pending/active promise.
    fetchMode: direct ? 'inactive (direct load)' : (login.fetchMode || null),
    syncAgeText: ageMs !== null && ageMs !== undefined ? `${Math.max(0, Math.round(ageMs / 1000))}s ago` : 'never',
    // After a proxy failure the line names the failure itself — a
    // generic "direct load" or "checking" line would hide WHY login
    // can never verify on this route.
    line: failed ? PROXY_FAILED_LINE : loginEvidenceLine(login),
    transport: transport || null,
    proxyFailed: failed
  };
}

/**
 * The assistant sheet's hero verdict view (pure, testable): the ONE
 * verdict surface inside the sheet. Derived only from the LOCKED,
 * display-overlaid gate verdict — SKIP always renders as SKIP with no
 * target and no confidence, so a prediction and a SKIP can never be
 * visible in the sheet at the same time.
 */
export function heroVerdictView(gate) {
  if (!gate || !gate.decision) return { decision: 'NONE', targetText: '—', confText: '—', pick: null };
  if (gate.decision === GATE_DECISIONS.BET) {
    return {
      decision: 'BET',
      targetText: gate.pick || '—',
      confText: gate.prob !== null && gate.prob !== undefined ? Math.round(gate.prob * 100) + '%' : '—',
      pick: gate.pick || null
    };
  }
  return { decision: 'SKIP', targetText: 'SKIP', confText: '—', pick: null };
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

// ─────────────────────────────────────────────────────────────────────
// Per-period verdict lock (pure, testable)
// ─────────────────────────────────────────────────────────────────────
// The governed verdict for a round must be STABLE within the round:
// computed once for (timeframe, latest settled period) and reused by
// every re-render until the period rolls over or the timeframe
// switches (a new key). Before this lock existed, every 3s cycle
// recomputed the gate from live state, so a balance update, a
// calibration tick or a history refresh could flip BIG↔SMALL↔SKIP
// mid-round — the owner's "prediction glitch".
export class VerdictLocker {
  constructor() { this.lock = null; }
  /** Return the locked value for `key`, computing + locking it on first sight. */
  get(key, compute) {
    if (this.lock && this.lock.key === key) return this.lock.value;
    const value = compute();
    this.lock = { key, value };
    return value;
  }
  peek(key) {
    return this.lock && this.lock.key === key ? this.lock.value : null;
  }
  clear() { this.lock = null; }
}

// ─────────────────────────────────────────────────────────────────────
// Trend / pattern conflict detection (pure, testable)
// ─────────────────────────────────────────────────────────────────────
// Learning signals may strengthen a pick (the pattern hit-rate blend
// in InchargeEngine.scoreModel) but they may never SILENTLY override
// it. When a proven pattern (≥20 persisted firings, hit-rate clearly
// above the 51.02% breakeven) fires AGAINST the leader's pick, or a
// strong trend (≥5 in a row) runs against it, the governed answer is
// a SKIP whose reason NAMES the conflict.
export const PATTERN_CONFLICT_MIN_FIRINGS = 20;
export const PATTERN_CONFLICT_MIN_HIT_RATE = 0.58;
export const TREND_CONFLICT_MIN_STREAK = 5;

export function detectSignalConflict({ pick, patternFiring = null, trend = null } = {}) {
  if (!pick) return null;
  if (patternFiring && patternFiring.prediction && patternFiring.prediction !== pick
      && patternFiring.fired >= PATTERN_CONFLICT_MIN_FIRINGS
      && patternFiring.hitRate >= PATTERN_CONFLICT_MIN_HIT_RATE) {
    return {
      kind: 'pattern',
      patternId: patternFiring.patternId || null,
      reason: `Pattern ${patternFiring.name || patternFiring.patternId} is firing ${patternFiring.prediction} against the leader's ${pick} (${Math.round(patternFiring.hitRate * 100)}% over ${patternFiring.fired} firings) — skipping rather than betting against a proven pattern.`
    };
  }
  if (trend && trend.type && trend.type !== pick && trend.length >= TREND_CONFLICT_MIN_STREAK) {
    return {
      kind: 'trend',
      reason: `Trend conflict: ${trend.length} ${trend.type} in a row against the leader's ${pick} — skipping into a strong trend.`
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Balance block view-model (pure, testable)
// ─────────────────────────────────────────────────────────────────────
// The ball window's BALANCE element renders exactly what the verifier
// state carries — never an invented figure. Fresh VERIFIED figures
// show plainly; a figure older than 60s is flagged stale with its
// real age; no state at all renders "—" with the no-signal wording.
export function balanceBlockView(login) {
  // Money format: always two decimals (₹432.50), unlike the compact
  // evidence line — this element is the balance display.
  const inrFmt = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!login || login.balance === null || login.balance === undefined) {
    return {
      text: '—', tag: 'no signal', ageText: '', stale: true, hasState: false,
      emptyText: login && login.state === LOGIN_STATES.NO_SIGNAL
        ? 'No bridge signal — open DhaniWin with the bridge active'
        : 'No balance state yet'
    };
  }
  const ageMs = login.stateAgeMs !== null && login.stateAgeMs !== undefined ? login.stateAgeMs : login.syncAgeMs;
  const tag = login.balanceSource === 'api' ? 'exact · API'
    : login.balanceSource === 'dom' ? 'from page' : 'API-proven';
  const stale = login.state !== LOGIN_STATES.VERIFIED || (ageMs !== null && ageMs !== undefined && ageMs > BRIDGE_STATE_FRESH_MS);
  return {
    text: inrFmt(login.balance),
    tag,
    ageText: ageMs !== null && ageMs !== undefined ? `${Math.max(0, Math.round(ageMs / 1000))}s ago` : '',
    stale,
    hasState: true,
    emptyText: null
  };
}

// ─────────────────────────────────────────────────────────────────────
// Session replan (pure, testable)
// ─────────────────────────────────────────────────────────────────────
// ONE bankroll session is the single source of truth for level, next
// stake and session P&L (owner's level-integrity rule). When the base
// changes (chip tap, AUTO recompute, risk-mode change, Auto-Pilot
// arm), the ladder is replanned at the current balance via
// planLadder — fresh ladder from rung 0 — while the session's
// identity (starting balance, accumulated P&L, rounds, loss streak)
// carries over, so no surface ever computes its own copy.
export function replanSession(prev, balance, { mode = DEFAULT_STAKING_MODE, baseBet } = {}) {
  const fresh = createSession(balance, { mode, baseBet });
  if (!prev) return fresh;
  return {
    ...fresh,
    startingBalance: prev.startingBalance || fresh.startingBalance,
    sessionPnL: prev.sessionPnL || 0,
    rounds: prev.rounds || 0,
    consecutiveLosses: prev.consecutiveLosses || 0,
    peakBalance: Math.max(prev.peakBalance || 0, fresh.balance)
  };
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
  // ONE streak counter / ONE stop state (owner's rule, 2026-10-24):
  // the guard derives the anti-tilt cooldown from the same counter
  // that trips HARD_STOP at 3 settled losses. Persisted so a reload
  // cannot launder a stop. (The standalone GateCooldown is no longer
  // wired here — the guard replaces it in the runtime path.)
  const guard = new GovernedStreakGuard();
  try {
    const rawGuard = localStorage.getItem('o101_streak_guard_v1');
    if (rawGuard) guard.restore(JSON.parse(rawGuard));
  } catch (e) { /* corrupted guard state must never break the app */ }
  const saveGuard = () => { try { localStorage.setItem('o101_streak_guard_v1', JSON.stringify(guard.snapshot())); } catch (e) {} };
  const locker = new VerdictLocker();
  const patternStore = new PatternStore(safeStorage());
  const ap = new AutoPilot(safeStorage());

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
    scopeLabel: null,
    verdictKey: null,      // lock key (tf:latestPeriod) the current verdict belongs to
    dispositions: {},      // 'tf:period' -> { decision, fired, apOn } for the governor-suppression hook
    patternWatermarks: {}, // tf -> last period fed to the headless pattern engine
    patternLive: {},       // tf -> true once the initial chronological feed caught up ('live' source after)
    baseSignature: null,   // chip/AUTO/risk-mode signature driving session replans
    apIntentSeen: null,    // updatedAt of the last settings intent applied
    lastChipBase: null     // last MobileBridgeState.baseStake seen (manual-override detection)
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
        // getDashboardData().candidates is the getCandidatePatterns()
        // package (an object, NOT an array — reading it as an array
        // silently killed the pattern context on every page). The
        // firing pattern is its bestCandidate.
        const cand = d && d.candidates && d.candidates.bestCandidate ? d.candidates.bestCandidate : null;
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

  // Which transport the embedded DhaniWin load used (mobile.js
  // records it on every load; localStorage carries it to the
  // settings document). 'direct' means the bridge was never injected.
  function currentDhaniTransport() {
    try {
      return window.__o101DhaniTransport || localStorage.getItem('o101_dhani_transport') || null;
    } catch (e) { return null; }
  }

  // Did the app fall back to a direct load because the proxy route
  // failed? mobile.js records it (window flag + localStorage) at the
  // moment of the fallback; a later live bridge signal clears it.
  function currentDhaniProxyFailed() {
    try {
      return !!(window.__o101DhaniProxyFailed || localStorage.getItem('o101_dhani_proxy_failed'));
    } catch (e) { return false; }
  }

  // Persist a compact bridge snapshot so the settings page (a separate
  // document) can show the same diagnostic: login state, exact balance
  // + source, bridge fetch mode, last sync age.
  function persistBridgeSnapshot(login) {
    try {
      const d = bridgeDiagnostic(login, currentDhaniTransport());
      const snap = {
        state: d.loginState,
        line: d.line,
        balance: login ? login.balance : null,
        balanceSource: d.balanceSource,
        fetchMode: d.fetchMode,
        transport: d.transport,
        proxyFailed: currentDhaniProxyFailed(),
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
    renderBalanceBlock(login);
    renderAutoPilot();
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
    // Direct load: the bridge was never injected into the DhaniWin
    // page, so no verification is coming — say exactly that instead
    // of the "waiting for the bridge" line.
    if (currentDhaniTransport() === 'direct') {
      // If this direct load is the proxy-failure fallback, name the
      // failure: the proxy was unreachable, and login cannot be
      // verified in this mode — never imply a bridge might still
      // arrive on a direct route.
      el.textContent = currentDhaniProxyFailed()
        ? PROXY_FAILED_LINE
        : 'Direct load — bridge inactive · login + exact balance unavailable on this route';
      el.setAttribute('data-transport', 'direct');
      el.setAttribute('data-login-state', state.login ? state.login.state : 'UNKNOWN');
      return;
    }
    el.removeAttribute('data-transport');
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

  // ── Balance element in the ball window ───────────────────────────
  function renderBalanceBlock(login) {
    const v = balanceBlockView(login || state.login);
    const val = $('assistantBalanceValue');
    if (!val) return;
    val.textContent = v.text;
    val.className = 'text-[11px] font-mono font-black ' + (v.stale ? 'text-zinc-500' : 'text-white');
    const tag = $('assistantBalanceTag');
    if (tag) tag.textContent = v.hasState ? v.tag : 'no signal';
    const age = $('assistantBalanceAge');
    if (age) age.textContent = v.hasState ? v.ageText : (v.emptyText || '');
  }

  // ── Headless pattern engine ──────────────────────────────────────
  // The catalog pattern layer (GameHistoryAnalysis) used to be fed
  // only by the desktop pages — on mobile nothing ever called it, so
  // its state stayed empty and the pattern context was permanently
  // dead. Now every settled round of EVERY timeframe is fed here, in
  // chronological order, from the settlement flow itself: candidates
  // are read BEFORE the round is appended (strict walk-forward), each
  // firing is persisted to the PatternStore, and only then is the
  // round appended to the analysis state. No page visit required.
  const PATTERN_TFS = ['30s', '1m', '3m', '5m'];
  function feedPatternEngine() {
    const gha = window.GameHistoryAnalysis;
    if (!gha || typeof gha.recordRoundResult !== 'function' || typeof gha.getCandidatePatterns !== 'function') return;
    for (const tf of PATTERN_TFS) {
      try {
        const history = settledHistory(tf);
        if (!history.length) continue;
        const wm = state.patternWatermarks[tf] || null;
        let startIdx = 0;
        if (wm) {
          const idx = history.findIndex(r => String(r.period) === wm);
          startIdx = idx >= 0 ? idx + 1 : 0; // watermark scrolled out: re-feed (both stores are idempotent)
        }
        let processed = 0;
        for (let i = startIdx; i < history.length && processed < 4; i++) {
          const round = history[i];
          const cands = gha.getCandidatePatterns(tf);
          const firing = [];
          if (cands) {
            if (Array.isArray(cands.validatedCandidates)) firing.push(...cands.validatedCandidates);
            if (cands.bestCandidate && !firing.includes(cands.bestCandidate)) firing.push(cands.bestCandidate);
          }
          for (const p of firing) {
            if (!p || !p.exactSequence || !p.nextPredicted) continue;
            patternStore.recordFiring({
              patternId: p.exactSequence,
              patternName: p.name || p.exactSequence,
              timeframe: tf,
              period: round.period,
              prediction: p.nextPredicted,
              hit: p.nextPredicted === round.size,
              source: state.patternLive[tf] ? 'live' : 'backfill',
              deferSave: true
            });
          }
          gha.recordRoundResult(tf, { period: round.period, number: round.number, size: round.size, color: round.color });
          state.patternWatermarks[tf] = String(round.period);
          processed++;
        }
        if (history.length - startIdx - processed <= 0) state.patternLive[tf] = true;
      } catch (e) { /* the pattern engine must never break the cycle */ }
    }
    patternStore.flush(); // one persistence write per feed cycle, not per firing
  }

  /** The pattern firing for the NEXT round, with its persisted record. */
  function currentPatternFiring(tf) {
    try {
      const gha = window.GameHistoryAnalysis;
      if (!gha || typeof gha.getCandidatePatterns !== 'function') return null;
      const cands = gha.getCandidatePatterns(tf);
      const best = cands && cands.bestCandidate;
      if (!best || !best.exactSequence || !best.nextPredicted) return null;
      const stats = patternStore.stats(best.exactSequence, tf) || patternStore.mergedStats(best.exactSequence);
      if (!stats || !stats.fired) return null;
      return { patternId: best.exactSequence, name: best.name || best.exactSequence, prediction: best.nextPredicted, fired: stats.fired, hitRate: stats.hitRate };
    } catch (e) { return null; }
  }

  /** Trend state from the analysis layer's own summary (trailing streak). */
  function currentTrend(tf) {
    try {
      const gha = window.GameHistoryAnalysis;
      const st = gha && gha.State && typeof gha.State.getSummary === 'function' ? gha.State.getSummary(tf) : null;
      const cs = st && st.currentStreak;
      if (!cs || !cs.type) return null;
      return { type: cs.type === 'B' ? 'BIG' : 'SMALL', length: cs.length || 0 };
    } catch (e) { return null; }
  }

  // ── Analyse: persisted pattern numbers, rendered live ────────────
  function renderPatternStats() {
    const list = $('patternStatsList');
    if (!list) return;
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = patternStore.allStats();
    const meta = $('patternStatsMeta');
    if (meta) {
      meta.textContent = rows.length
        ? `${rows.reduce((a, r) => a + r.fired, 0)} firings recorded · updated on every settled round`
        : 'Headless engine running — no firings yet';
    }
    if (!rows.length) {
      list.innerHTML = '<div class="text-[9px] font-mono text-zinc-500 px-1 py-2">No pattern firings yet. The engine evaluates the catalog patterns on every settled round and records each firing here — nothing is back-computed or invented.</div>';
      return;
    }
    list.innerHTML = rows.map(r => `<div class="flex items-start justify-between gap-2 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06]">
      <div class="min-w-0">
        <div class="text-[10px] font-bold text-white truncate">${esc(r.name)} <span class="text-zinc-500 font-mono text-[8px]">${esc(r.patternId)} · ${esc(r.timeframe)}</span></div>
        <div class="text-[8px] font-mono text-zinc-500">last fired · period …${esc(String(r.lastPeriod).slice(-5))}</div>
      </div>
      <div class="text-right shrink-0">
        <div class="text-[10px] font-black font-mono ${r.hitRate >= 0.5102 ? 'text-emerald-300' : 'text-zinc-300'}">${(r.hitRate * 100).toFixed(1)}%</div>
        <div class="text-[8px] font-mono text-zinc-500">${r.hits}/${r.fired} hits</div>
      </div>
    </div>`).join('');
  }

  // ── Auto-Pilot runtime ───────────────────────────────────────────
  const TF_DURATION_MS = { '30s': 30000, '1m': 60000, '3m': 180000, '5m': 300000 };

  function openPeriodFor(tf) {
    try {
      if (state.page === 'mobile' && window.MobileState && window.MobileState.timeframe === tf
          && window.MobileState.activePrediction && window.MobileState.activePrediction.period) {
        return String(window.MobileState.activePrediction.period);
      }
    } catch (e) {}
    return null;
  }

  function countdownMsLeft() {
    const el = $('assistantCountdown');
    if (!el) return null;
    const m = /(\d+):(\d+)/.exec(el.textContent || '');
    if (!m) return null;
    return (Number(m[1]) * 60 + Number(m[2])) * 1000;
  }

  function freshVerifiedBalance(login) {
    return !!login && login.state === LOGIN_STATES.VERIFIED && login.balance !== null && login.balance !== undefined
      && (login.stateAgeMs === null || login.stateAgeMs === undefined || login.stateAgeMs <= BRIDGE_STATE_FRESH_MS);
  }

  /** The base bet the governed ladder should run: AUTO (from the fresh
   *  verified balance at the risk mode) or the window's chip value.
   *  null = cannot know right now (AUTO with no fresh verified balance). */
  function desiredBaseBet(login) {
    if (ap.state.autoBase) {
      return freshVerifiedBalance(login) ? autoBaseBet(login.balance, ap.state.riskMode) : null;
    }
    const chip = window.MobileBridgeState ? Number(window.MobileBridgeState.baseStake) : NaN;
    return Number.isFinite(chip) && chip > 0 ? Math.floor(chip) : null;
  }

  /** Keep the ONE governed session's base in step with chips / AUTO /
   *  risk mode. A manual chip tap while AUTO is on turns AUTO off —
   *  manual always wins. */
  function syncSessionBase(login) {
    if (!state.session) return;
    const chip = window.MobileBridgeState ? Number(window.MobileBridgeState.baseStake) : null;
    if (chip !== null && Number.isFinite(chip)) {
      if (state.lastChipBase !== null && chip !== state.lastChipBase && ap.state.autoBase) {
        ap.setAutoBase(false);
        say(`AUTO base off — your manual chip ${inr(chip)} wins.`);
      }
      state.lastChipBase = chip;
    }
    const desired = desiredBaseBet(login);
    const sig = JSON.stringify([desired, ap.state.riskMode, ap.state.autoBase]);
    if (sig === state.baseSignature) return;
    state.baseSignature = sig;
    if (desired === null) return; // AUTO without a fresh verified balance: keep the session; staging blocks itself
    if (desired === state.session.baseBet && ap.state.riskMode === state.session.mode) return;
    const balForPlan = freshVerifiedBalance(login) ? login.balance : state.session.balance;
    state.session = replanSession(state.session, balForPlan, { mode: ap.state.riskMode, baseBet: desired });
    ap.noteSession(state.session);
  }

  function transportOrder(order) {
    // The existing order path only: the same postMobileBridge fan-out
    // mobile.js uses (BroadcastChannel + iframe + external window +
    // window postMessage) to dhaniwin-bridge.js's handleIncomingOrder.
    if (typeof window.postMobileBridge === 'function') { window.postMobileBridge(order); return; }
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        const ch = new BroadcastChannel('dhaniwin_quant_channel');
        ch.postMessage(order);
        setTimeout(() => { try { ch.close(); } catch (e) {} }, 50);
      }
    } catch (e) {}
    try { window.postMessage(order, '*'); } catch (e) {}
  }

  function confirmAutoPilotBet() {
    const staged = ap.stagedBet();
    const login = verifier.status(Date.now());
    const res = ap.confirmFire({
      period: staged ? staged.period : undefined,
      timeframe: staged ? staged.timeframe : (state.tf || currentTf()),
      verified: login.state === LOGIN_STATES.VERIFIED,
      gateDecision: state.gate ? state.gate.decision : undefined,
      hardStopped: guard.hardStopped,
      sessionStake: state.session ? state.session.nextStake : undefined,
      countdownMsLeft: countdownMsLeft(),
      nowMs: Date.now(),
      maxStake: (window.MobileBridgeState && Number(window.MobileBridgeState.maxStakeCap)) || (staged ? staged.stake : undefined)
    });
    if (!res.ok) {
      say('Auto-Pilot: ' + res.reason);
      renderAutoPilot();
      return res;
    }
    transportOrder(res.order);
    const dKey = res.order.timeframe + ':' + res.order.period;
    if (state.dispositions[dKey]) state.dispositions[dKey].fired = true;
    say(`Fired: ${res.order.target} ${inr(res.order.stake)} for period …${String(res.order.period).slice(-5)} — sent to the bridge on the tap you just gave.`);
    renderAutoPilot();
    return res;
  }

  function applyAutoPilotIntent(intent) {
    if (!intent) return;
    if (intent.riskMode && intent.riskMode !== ap.state.riskMode) {
      ap.setRiskMode(intent.riskMode);
      state.baseSignature = null;
    }
    if (intent.desiredEnabled === true && !ap.enabled) {
      const login = verifier.status(Date.now());
      const res = ap.arm({
        verified: login.state === LOGIN_STATES.VERIFIED,
        balance: login.balance,
        blockedReason: guard.hardStopped ? HARD_STOP_REASON : null
      });
      if (!res.ok) say('Auto-Pilot refused: ' + res.reason);
      else {
        state.baseSignature = null;
        say('Auto-Pilot on. I stage every governed BET — you fire it with one tap per bet.');
      }
    } else if (intent.desiredEnabled === false && ap.enabled) {
      ap.disarm('Turned off by the owner.');
    }
    renderAutoPilot();
  }

  function pollApIntent() {
    try {
      const raw = localStorage.getItem(AUTOPILOT_SETTINGS_KEY);
      if (!raw) return;
      const intent = JSON.parse(raw);
      if (!intent || intent.updatedAt === undefined || intent.updatedAt === state.apIntentSeen) return;
      state.apIntentSeen = intent.updatedAt;
      applyAutoPilotIntent(intent);
    } catch (e) { /* a broken intent file must never break the cycle */ }
  }

  function toggleAutoPilot() {
    const intent = { desiredEnabled: !ap.enabled, riskMode: ap.state.riskMode, updatedAt: Date.now() };
    try { localStorage.setItem(AUTOPILOT_SETTINGS_KEY, JSON.stringify(intent)); } catch (e) {}
    state.apIntentSeen = intent.updatedAt;
    applyAutoPilotIntent(intent);
  }

  function toggleAutoBase() {
    ap.setAutoBase(!ap.state.autoBase);
    state.baseSignature = null;
    say(ap.state.autoBase
      ? 'AUTO base on — the base bet now follows your verified balance and risk mode.'
      : 'AUTO base off — the manual chips rule.');
    renderAutoPilot();
  }

  function rearmHardStop() {
    if (guard.manualRearm(Date.now())) {
      saveGuard();
      ap.noteStopCleared();
      say('Hard stop re-armed manually. The streak counter is reset — trade carefully.');
      renderAutoPilot();
    }
  }

  /** Per-cycle Auto-Pilot staging against the DISPLAY gate. */
  function apStageCycle(tf, gate, login, openP) {
    if (!ap.enabled) return;
    if (login.state !== LOGIN_STATES.VERIFIED) {
      ap.notePaused(true, 'Paused: login not verified — staging resumes when the bridge verifies login.');
      renderAutoPilot();
      return;
    }
    ap.notePaused(false);
    if (guard.hardStopped) { ap.forceStop(AP_STOP_REASONS.HARD_STOP); renderAutoPilot(); return; }
    if (gate.decision !== GATE_DECISIONS.BET) {
      if (ap.stagedBet()) ap.invalidate('gate flipped to SKIP');
      renderAutoPilot();
      return;
    }
    if (!openP || !state.session) return;
    if (ap.state.autoBase && !freshVerifiedBalance(login)) { renderAutoPilot(); return; }
    const res = ap.stage({
      period: openP, timeframe: tf, target: gate.pick, session: state.session,
      periodDurationMs: TF_DURATION_MS[tf] || 60000
    });
    if (res === 'staged') {
      // Attention cue once per staged round (a neutral click, never a
      // win/loss sound — nothing has been won or lost yet) + the
      // predictBot BET line, spoken here so it fires exactly once per
      // staged round even when Auto-Pilot was armed mid-round.
      try { if (typeof window.playSoundEffect === 'function') window.playSoundEffect('click'); } catch (e) {}
      speakEvent(BOT_EVENTS.SIGNAL_BET);
    }
    renderAutoPilot();
  }

  function apTick() {
    try {
      if (ap.stagedBet()) {
        if (ap.tick({ countdownMsLeft: countdownMsLeft() })) renderAutoPilot();
      }
    } catch (e) { /* the tick must never break the app */ }
  }

  function renderAutoPilot() {
    const toggle = $('autoPilotToggle');
    if (toggle) {
      toggle.setAttribute('aria-checked', ap.enabled ? 'true' : 'false');
      toggle.textContent = ap.enabled ? 'ON' : 'OFF';
      toggle.className = ap.enabled
        ? 'text-[7.5px] font-mono font-black px-2 py-0.5 rounded-full bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 active:scale-95 transition'
        : 'text-[7.5px] font-mono font-black px-2 py-0.5 rounded-full bg-white/10 text-zinc-300 border border-white/10 active:scale-95 transition';
    }
    const btn = $('autoPilotConfirmBtn');
    const staged = ap.stagedBet();
    if (btn) {
      if (staged && ap.enabled) {
        btn.classList.remove('hidden');
        btn.textContent = `BET ${staged.target} · ${inr(staged.stake)} — tap to confirm`;
      } else {
        btn.classList.add('hidden');
      }
    }
    const line = $('autoPilotSessionLine');
    if (line) line.textContent = ap.sessionLine();
    const stopEl = $('autoPilotStopLine');
    const stopText = ap.state.stopReason
      || (guard.hardStopped ? HARD_STOP_REASON + ' It clears after two shadow wins in a row, or re-arm it manually.' : null)
      || (ap.enabled && ap.state.paused ? ap.state.pauseReason : null);
    if (stopEl) {
      if (stopText) { stopEl.textContent = stopText; stopEl.classList.remove('hidden'); }
      else stopEl.classList.add('hidden');
    }
    const rearm = $('hardStopRearmBtn');
    if (rearm) rearm.classList.toggle('hidden', !guard.hardStopped);
    const auto = $('autoBaseToggle');
    if (auto) {
      auto.setAttribute('aria-pressed', ap.state.autoBase ? 'true' : 'false');
      auto.className = ap.state.autoBase
        ? 'text-[7.5px] font-mono font-bold px-1.5 py-0.2 rounded bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 transition active:scale-95'
        : 'text-[7.5px] font-mono font-bold px-1.5 py-0.2 rounded bg-white/10 text-zinc-300 border border-white/10 transition active:scale-95';
    }
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
    pollApIntent();
    const gen = genFn(), ev = evalFn();
    if (!gen || !ev || !arenaModels().length) return;

    const tf = currentTf();
    const history = settledHistory(tf);
    if (!history.length) return;
    state.tf = tf;
    const latest = history[history.length - 1];
    const latestPeriod = String(latest.period);

    // Headless pattern engine: feed every newly settled round of
    // every timeframe (walk-forward, persisted) before governance
    // reads pattern stats below.
    feedPatternEngine();

    // Balance + bankroll session
    const det = detectBalance();
    if (det.balance !== null) { state.balance = det.balance; state.balanceSource = det.source; }
    if (state.balance !== null && !state.session) {
      const startBase = desiredBaseBet(login);
      state.session = createSession(state.balance, { mode: ap.state.riskMode, baseBet: startBase !== null ? startBase : undefined });
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
    // One session, one truth: chips / AUTO / risk mode replan it here.
    syncSessionBase(login);

    // New settled round? (Pending picks and the displayed pick were
    // computed from the history ending at the PREVIOUS latest period,
    // so they were issued FOR this newly settled round.)
    const prevLatest = state.lastPeriodSeen;
    if (prevLatest !== latestPeriod) {
      const isFirst = prevLatest === null;
      state.lastPeriodSeen = latestPeriod;

      // 1) Settle the bridge's displayed pick for the round that just
      //    closed, if we had issued one. The verdict that governs the
      //    settlement is the LOCKED engine verdict for that round.
      //    Silence rule (owner's order): a SKIP round — or an
      //    Auto-Pilot round with no FIRED bet — produces NO win/loss
      //    sound, NO bot line, NO ladder movement and NO P&L change;
      //    it is only logged as skipped. Win/loss treatment is
      //    reserved for rounds with an actually settled governed BET
      //    (a fired bet while Auto-Pilot is on).
      if (!isFirst && state.lastPick) {
        const won = ev(state.lastPick.target, latest.number, latest.size, latest.color);
        if (won !== null && won !== undefined) {
          const lockVal = locker.peek(state.verdictKey);
          const decision = lockVal && lockVal.gate ? lockVal.gate.decision
            : (state.gate ? state.gate.decision : null);
          const fired = ap.hasFired(tf, latestPeriod);
          if (guard.hardStopped && !fired) {
            // HARD_STOP shadow tracking: silent. Two consecutive
            // shadow wins clear the stop (manual re-arm also works).
            guard.recordShadowPick(!!won);
            saveGuard();
            if (!guard.hardStopped && guard.lastClear && guard.lastClear.source === 'shadow') {
              ap.noteStopCleared();
              say('Hard stop cleared — the governed pick won twice in a row in shadow. Auto-Pilot can be re-armed when you are ready.');
            }
            ap.resolveUnfired(tf, latestPeriod, 'skipped');
          } else if (decision === GATE_DECISIONS.BET && ap.enabled && !fired) {
            // Auto-Pilot was on but the owner never fired this round:
            // total silence — calibration still measures the pick.
            tracker.record(state.lastPick.prob, !!won);
            ap.resolveUnfired(tf, latestPeriod, 'skipped');
          } else if (decision === GATE_DECISIONS.BET) {
            tracker.record(state.lastPick.prob, !!won);
            const result = settleGovernedPick({
              won: !!won,
              session: state.session,
              gateDecision: decision,
              hooks: {
                playSound: type => { try { if (typeof window.playSoundEffect === 'function') window.playSoundEffect(type); } catch (e) {} }
              }
            });
            state.session = result.session;
            for (const eventName of result.events) {
              speakEvent(eventName, { lastResult: `${latest.size} ${latest.number}` });
            }
            guard.recordSettledBet(!!won);
            saveGuard();
            if (fired) {
              const apRes = ap.settleFired({
                timeframe: tf, period: latestPeriod, won: !!won,
                stakeUsed: result.session ? result.session.stakeUsed : 0,
                sessionState: result.session ? result.session.state : null
              });
              if (guard.hardStopped) {
                ap.forceStop(AP_STOP_REASONS.HARD_STOP);
                say(AP_STOP_REASONS.HARD_STOP);
              } else if (apRes.stopped) {
                say(apRes.reason);
              }
            } else if (guard.hardStopped && ap.enabled) {
              ap.forceStop(AP_STOP_REASONS.HARD_STOP);
            }
            renderAutoPilot();
          } else {
            // SKIP verdict: silent by rule.
            tracker.record(state.lastPick.prob, !!won);
            ap.resolveUnfired(tf, latestPeriod, 'skipped');
          }
        }
        state.lastPick = null;
      }

      // A new round begins: consume one anti-tilt cooldown round from
      // the ONE streak counter, if any.
      state.cooldownRound = guard.beginRound();
      saveGuard();

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

    // 4) Picks for the upcoming round + gate. The governed verdict
    //    is computed ONCE per (timeframe, latest settled period) and
    //    LOCKED: history refreshes, balance updates and polls within
    //    the round reuse it verbatim, so the displayed verdict can
    //    never flip mid-round. The lock releases on period roll-over
    //    or timeframe switch (a new key).
    const picks = nextRoundPicks(arenaModels(), history, gen);
    state.pendingPicks = picks;

    const lockKey = tf + ':' + latestPeriod;
    state.verdictKey = lockKey;
    const locked = locker.get(lockKey, () => {
      if (!incharge) {
        return {
          gate: { decision: GATE_DECISIONS.SKIP, pick: null, prob: null, reason: 'No eligible Incharge model right now (every model is blacklisted or has no record yet) — nothing to bet on.' },
          pick: null
        };
      }
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
      // Trend / pattern learning in the pick: a proven pattern firing
      // or a strong trend AGAINST the pick turns the BET into a SKIP
      // whose reason names the conflict — never a silent override.
      // (Agreement strengthens the pick through the pattern hit-rate
      // blend inside scoreModel, fed by the persisted pattern store.)
      if (gate.decision === GATE_DECISIONS.BET) {
        const conflict = detectSignalConflict({
          pick: gate.pick,
          patternFiring: currentPatternFiring(tf),
          trend: currentTrend(tf)
        });
        if (conflict) {
          gate = { ...gate, decision: GATE_DECISIONS.SKIP, prob: null, reason: conflict.reason, conflict: conflict.kind };
        }
      }
      return {
        gate,
        pick: myPick ? { target: myPick.target, prob: calibratedProb !== null ? calibratedProb : rawConf } : null
      };
    });

    // Display overlays on the LOCKED engine verdict: HARD_STOP first,
    // then the login hard stop. Overlays change what is shown and
    // staged, never the locked verdict itself.
    const engineGate = locked.gate;
    let gate = engineGate;
    if (guard.hardStopped) {
      gate = { ...engineGate, decision: GATE_DECISIONS.SKIP, prob: null, reason: HARD_STOP_REASON };
    } else if (login.state !== LOGIN_STATES.VERIFIED) {
      const reason = login.state === LOGIN_STATES.NOT_LOGGED_IN
        ? 'Not logged in: login on the DhaniWin tab first. No signal or stake is suggested until the bridge proves login from its wallet API traffic.'
        : login.state === LOGIN_STATES.NO_SIGNAL
          ? 'No bridge signal: open DhaniWin with the bridge active. No signal or stake is suggested until the bridge proves login from its wallet API traffic.'
          : 'Login not verified yet: waiting for the bridge\'s API-proven user state. No signal or stake is suggested until then.';
      gate = { ...engineGate, decision: GATE_DECISIONS.SKIP, prob: null, reason };
    }
    state.gate = gate;
    // Remember the locked pick so its outcome can settle calibration,
    // the streak guard and (when fired) the bankroll when the round lands.
    state.lastPick = locked.pick;

    // Governor disposition for the live app's own win/loss path: the
    // round's governed verdict + whether a bet was actually fired.
    const openP = openPeriodFor(tf);
    if (openP) {
      const dKey = tf + ':' + openP;
      if (!state.dispositions[dKey]) {
        state.dispositions[dKey] = { decision: engineGate.decision, fired: ap.hasFired(tf, openP), apOn: ap.enabled };
        const keys = Object.keys(state.dispositions);
        if (keys.length > 60) delete state.dispositions[keys[0]];
      }
    }

    if (incharge) {
      // Orb face reflects the GOVERNED signal, not raw engine output.
      renderSignal(gate, incharge, login);
    }
    // The sheet hero follows the SAME locked verdict on every cycle,
    // incharge or not — one verdict surface, owned by the governor.
    renderHeroVerdict(gate);
    renderWindowStatus();
    // Auto-Pilot staging (speaks the BET line itself when it stages,
    // exactly once per staged round).
    apStageCycle(tf, gate, login, openP);
    const gateKey = latestPeriod + ':' + gate.decision + ':' + (gate.pick || '');
    if (state.gatePeriodKey !== gateKey) {
      state.gatePeriodKey = gateKey;
      if (!state.greeted) { state.greeted = true; speakEvent(BOT_EVENTS.GREETING); }
      if (!(ap.enabled && gate.decision === GATE_DECISIONS.BET)) {
        speakEvent(gate.decision === GATE_DECISIONS.BET ? BOT_EVENTS.SIGNAL_BET : BOT_EVENTS.SIGNAL_SKIP);
      }
    }

    renderRanking(tf, pool, bl, scope);
    renderPatternStats();
    renderAutoPilot();
  }

  // ── Rendering: governed signal into the orb/sheet ────────────────
  // ── Sheet hero verdict (the ONE verdict surface in the sheet) ────
  // Rendered from the LOCKED gate verdict on EVERY governance cycle,
  // whether or not an incharge model exists — previously the hero was
  // only painted inside renderSignal (incharge-gated) while the live
  // app's native render painted its own prediction on its own timer,
  // so the sheet could show a native prediction and a governed SKIP
  // at the same time. Now the governed render owns the hero, and the
  // published window.__o101Verdict lock makes the native render in
  // mobile.js mirror the same verdict instead of its own.
  const HERO_TARGET_CLASSES = {
    BIG: 'text-2xl font-black tracking-tight mt-0.5 drop-shadow-[0_0_12px_rgba(245,158,11,0.35)] text-amber-300',
    SMALL: 'text-2xl font-black tracking-tight mt-0.5 drop-shadow-[0_0_12px_rgba(245,158,11,0.35)] text-sky-300',
    GREEN: 'text-2xl font-black tracking-tight mt-0.5 drop-shadow-[0_0_12px_rgba(245,158,11,0.35)] text-emerald-400',
    RED: 'text-2xl font-black tracking-tight mt-0.5 drop-shadow-[0_0_12px_rgba(245,158,11,0.35)] text-rose-400',
    VIOLET: 'text-2xl font-black tracking-tight mt-0.5 drop-shadow-[0_0_12px_rgba(245,158,11,0.35)] text-violet-400',
    SKIP: 'text-2xl font-black tracking-tight mt-0.5 text-zinc-300',
    NONE: 'text-2xl font-black tracking-tight mt-0.5 text-zinc-500'
  };
  function renderHeroVerdict(gate) {
    const view = heroVerdictView(gate);
    // Publish the lock first: native renders mirror it verbatim.
    window.__o101Verdict = { decision: view.decision, pick: view.pick, confText: view.confText, key: state.verdictKey || null };
    if (state.page !== 'mobile') return;
    const targetEl = $('mobileWebTargetDisplay');
    if (targetEl) {
      targetEl.textContent = view.targetText;
      // Canonical class on every render: the target's size can never
      // jump because another writer left a different size class on it.
      targetEl.className = HERO_TARGET_CLASSES[view.decision === 'BET' ? (view.pick || 'NONE') : view.decision] || HERO_TARGET_CLASSES.NONE;
    }
    const conf = $('assistantConfBadge');
    if (conf) conf.textContent = view.confText;
  }

  function renderSignal(gate, incharge, login) {
    const bet = gate.decision === GATE_DECISIONS.BET;
    // No stake suggestion while login is unverified (UNKNOWN or worse).
    const loginVerified = !!login && login.state === LOGIN_STATES.VERIFIED;
    if (state.page === 'mobile') {
      const orbTarget = $('floatingOrbTarget');
      if (orbTarget) orbTarget.textContent = bet ? gate.pick : 'SKIP';
      const orbStake = $('floatingOrbStake');
      if (orbStake) orbStake.textContent = bet && loginVerified && state.session ? inr(state.session.nextStake) : '—';
      // Ladder Base/Bet in the live window come from bankroll.js (the
      // governed ladder). No stake is shown while login is unverified.
      // Level integrity (owner's rule, 2026-10-24): the Level pill,
      // the Base/Bet lines, Auto-Pilot staging and settlement ALL read
      // this one governed session — the pill no longer shows the live
      // app's separate recovery ladder. (This supersedes the rebase's
      // "leave the pill to the app" call, on the owner's explicit
      // one-source-of-truth order.)
      const baseEl = $('assistantBaseStakeDisplay');
      if (baseEl) {
        baseEl.textContent = ap.state.autoBase && !loginVerified ? '—'
          : state.session ? inr(state.session.baseBet) : '—';
      }
      const betEl = $('mobileWebStakeDisplay');
      if (betEl) betEl.textContent = bet && loginVerified && state.session ? inr(state.session.nextStake) : '—';
      const levelEl = $('mobileWebLevelBadge');
      if (levelEl) {
        levelEl.textContent = state.session && state.session.level > 0
          ? `Level ${state.session.level + 1} (Recovery)`
          : 'Level 1 (Base)';
      }
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
    diagnostic: () => bridgeDiagnostic(verifier.status(Date.now()), currentDhaniTransport()),
    store,
    // Auto-Pilot + pattern engine + streak guard (this build)
    autoPilot: ap,
    patternStore,
    guardSnapshot: () => guard.snapshot(),
    confirmAutoPilotBet,
    toggleAutoPilot,
    toggleAutoBase,
    rearmHardStop,
    disposition: (tf, period) => state.dispositions[String(tf) + ':' + String(period)] || null,
    _state: state
  };

  // Governor disposition hook for the live app's own win/loss path
  // (mobile.js settleRoundOutcome consults it): TRUE means the round
  // must get NO win/loss treatment there — the governor SKIPped it,
  // or Auto-Pilot was on and no bet was fired for it. No disposition
  // recorded (governor had no verdict) → the live behaviour is left
  // exactly as it was.
  window.__o101GovernorSuppresses = (tf, period) => {
    const d = state.dispositions[String(tf) + ':' + String(period)];
    if (!d) return false;
    if (d.decision !== GATE_DECISIONS.BET) return true;
    if (d.apOn) return !d.fired;
    return false;
  };
  window.__o101GovernedDisposition = (tf, period) => state.dispositions[String(tf) + ':' + String(period)] || null;

  setInterval(() => { try { cycle(); } catch (e) {} }, 3000);
  setTimeout(() => { try { cycle(); } catch (e) {} }, 1200);
  setInterval(apTick, 500);
}
