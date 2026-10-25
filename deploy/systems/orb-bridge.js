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
import { botLine, BOT_EVENTS, answerQuestion } from './predictBot.js';
import { AxoAiClient, buildAxoPayload, localRegimeLabel, localSessionSummary, AXO_AI_ENDPOINT } from './axo-ai.js';
import { analyseHistoryChunked } from './longAnalysis.js';
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
// and publishes { isLoggedIn, pending, balance, balanceSource, apiProven,
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
    // Pending (Fix 5a): the bridge reports its state as unproven.
    // A pending state is NEVER a negative, even when isLoggedIn
    // reads false (no previous confirmation exists yet) — the
    // verifier must treat it as indeterminate, like null.
    pending: raw.pending === true,
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
    // A pending state never records a negative (Fix 5a): its false
    // only means "nothing confirmed yet", not "logged out". A
    // non-pending false is still an explicit negative.
    if (st.isLoggedIn === false && !st.pending) {
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
      else if (bs.pending) kinds.push('bridge reports login pending · not yet proven');
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
      // Presence only: the bridge reports tokenPresent (boolean).
      // A raw token is never read here — the old msg.token field is
      // ignored even if an older bridge build still sends it.
      // Pending (Fix 5a): an unproven sync is indeterminate, not a
      // negative — map it to null, and do not let a transient
      // auth-page URL during the pending window count as one.
      return {
        isLoggedIn: msg.pending === true ? null : (typeof msg.isLoggedIn === 'boolean' ? msg.isLoggedIn : null),
        balance,
        hasToken: msg.tokenPresent === true,
        isAuthPage: msg.pending === true ? false : isAuthPage
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
      // Round 3: a VERIFIED state with no qualified balance (proof
      // came from userId alone) must NEVER render as ₹0 — that was
      // the false-₹0 display path. Unknown renders as unknown.
      if (login.balance === null || login.balance === undefined) {
        return `Login verified · balance unknown (${label})${age}`;
      }
      return `Login verified · ${inrFmt(login.balance)} (${label})${age}`;
    }
    case LOGIN_STATES.NOT_LOGGED_IN: return 'Not logged in';
    case LOGIN_STATES.NO_SIGNAL: return 'No bridge signal — open the DhaniWin tab in the 01.01 app; the app injects the bridge itself';
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
// the proxy failed": proxy unreachable, direct mode — the game frame
// still loads directly and the app injects the bridge. Shared by the
// status line and the settings diagnostic so they can never disagree.
export const PROXY_FAILED_LINE = 'Proxy unreachable — direct mode · game frame loads directly, bridge injected by the app';

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
    // Pivot: a direct load CAN carry the bridge (APK native
    // injection), so the mode is the verifier's own — never a
    // forced "inactive". No-login direct stays "inactive" above.
    fetchMode: (login.fetchMode || null),
    syncAgeText: ageMs !== null && ageMs !== undefined ? `${Math.max(0, Math.round(ageMs / 1000))}s ago` : 'never',
    // After a proxy failure the line names the failure itself — a
    // generic "direct load" or "checking" line would hide WHY the
    // route changed.
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
  if (!gate || !gate.decision) return { decision: 'NONE', targetText: '—', confText: '—', pick: null, reasonText: '' };
  if (gate.decision === GATE_DECISIONS.BET) {
    return {
      decision: 'BET',
      targetText: gate.pick || '—',
      confText: gate.prob !== null && gate.prob !== undefined ? Math.round(gate.prob * 100) + '%' : '—',
      pick: gate.pick || null,
      reasonText: ''
    };
  }
  // SKIP carries the firing gate's reason verbatim (numbers included:
  // sample count, required probability, streak state) so the hero
  // surface itself says WHY — the reason must survive subtitle
  // overwrites by later Auto-Pilot/ball announcements.
  return { decision: 'SKIP', targetText: 'SKIP', confText: '—', pick: null, reasonText: gate.reason || '' };
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
// Axo layer — face + voice decisions (pure, testable)
// ─────────────────────────────────────────────────────────────────────
// Axo is the ball's face and voice, layered over the governed flow
// without touching it. The DECISIONS live here as pure data and
// functions so the test pins can prove them without a DOM: which
// governed events are SPOKEN (and which face they wear), how a line
// is normalised for ears, how settled events group into utterances,
// when a settled round counts as a MISSED BET, and when the VERIFIED
// moment fires. The runtime below only executes these decisions.
export const AXO_VOICE_KEY = 'o101_axo_voice';

/** Bot event → Axo face for the SPOKEN set (PLAN.md §5). An event
 *  absent from this map is not spoken and changes no face. */
export const AXO_SPOKEN_FACES = {
  SIGNAL_BET: 'wow',
  // Fix round #3 (2026-10-24, owner's order): EVERY round is
  // announced — size, colour, or skip. The old skip-silence rule is
  // REPLACED: a SKIP now speaks and shows like any other verdict,
  // with the neutral base face (no emotion invented for sitting out).
  SIGNAL_SKIP: 'base',
  WIN: 'celebrate',
  LOSS: 'sad',
  LADDER_UP: 'thinking',
  MISSED_BET: 'sad',
  LOGIN_VERIFIED: 'wink',
  CIRCUIT_BREAKER: 'angry',
  STOP_LOSS: 'sad',
  STOP_WIN: 'celebrate'
};

/**
 * Minimal verdict icons: SVG/CSS shapes only, NEVER emoji. Big/Small
 * are arrows, colours are dots, a skip is a circle-slash. Icons are
 * visual only — they are never part of a spoken string.
 */
export const VERDICT_ICONS = {
  big: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 L20 15 H4 Z" fill="#fbbf24"/></svg>',
  small: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20 L4 9 H20 Z" fill="#38bdf8"/></svg>',
  green: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="#34d399"/></svg>',
  red: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="#fb7185"/></svg>',
  violet: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="#a78bfa"/></svg>',
  skip: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="#d4d4d8" stroke-width="2.5"/><line x1="6" y1="18" x2="18" y2="6" stroke="#d4d4d8" stroke-width="2.5" stroke-linecap="round"/></svg>'
};

/** Icon kind + SVG for one governed verdict (pick domain: BIG, SMALL, GREEN, RED, VIOLET). */
export function verdictIconFor(pick, decision) {
  if (decision === 'SKIP') return { kind: 'skip', svg: VERDICT_ICONS.skip };
  const p = String(pick || '').toUpperCase();
  if (p === 'BIG') return { kind: 'big', svg: VERDICT_ICONS.big };
  if (p === 'SMALL') return { kind: 'small', svg: VERDICT_ICONS.small };
  if (p === 'GREEN') return { kind: 'green', svg: VERDICT_ICONS.green };
  if (p === 'RED') return { kind: 'red', svg: VERDICT_ICONS.red };
  if (p === 'VIOLET') return { kind: 'violet', svg: VERDICT_ICONS.violet };
  return { kind: null, svg: '' };
}

/**
 * Fix round #4: the small prediction badge on the opened Axo
 * avatar shows the governed verdict as WRITTEN text — the size
 * (Big/Small), the colour (Red/Green/Violet), or Skip. Anything
 * else (no verdict, unknown pick) yields '' so the badge shows
 * nothing — never a stale or invented prediction.
 */
export function predictionBadgeText(pick, decision) {
  if (decision === 'SKIP') return 'Skip';
  if (decision !== 'BET') return '';
  const p = String(pick || '').toUpperCase();
  if (p === 'BIG') return 'Big';
  if (p === 'SMALL') return 'Small';
  if (p === 'GREEN') return 'Green';
  if (p === 'RED') return 'Red';
  if (p === 'VIOLET') return 'Violet';
  return '';
}

/** Badge text for one hero-view render (BET/SKIP/NONE). */
export function badgeFromView(view) {
  if (!view) return '';
  if (view.decision === 'SKIP') return 'Skip';
  if (view.decision === 'BET') return predictionBadgeText(view.pick, 'BET');
  return '';
}

/** { face, spoken } for a bot event — null/false off the table. */
export function axoEventEffects(event) {
  const face = AXO_SPOKEN_FACES[event] || null;
  return { face, spoken: !!face };
}

/** The Axo voice setting ('o101_axo_voice'), default ON (!== '0'),
 *  wired exactly like quant_sound. Read live at speak time. */
export function axoVoiceEnabled(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return true;
    return storage.getItem(AXO_VOICE_KEY) !== '0';
  } catch (e) { return true; }
}

export const AXO_SUBS_KEY = 'o101_axo_subs';
export const AXO_MODE_KEY = 'o101_axo_mode';

/**
 * Subtitle visibility ('o101_axo_subs'), default ON (!== '0'). The
 * CC toggle governs ONLY the subtitle strip: Axo, the face, the
 * voice and every governed behaviour keep running with subtitles
 * closed, and say() keeps writing the line (state + hidden DOM) so
 * re-opening shows the current line, not a stale one.
 */
export function axoSubsEnabled(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return true;
    return storage.getItem(AXO_SUBS_KEY) !== '0';
  } catch (e) { return true; }
}

/** Axo mode ('o101_axo_mode'): 'ai' (default) or 'normal'. Anything
 *  unrecognised reads as 'ai'. */
export function axoModeFrom(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return 'ai';
    return storage.getItem(AXO_MODE_KEY) === 'normal' ? 'normal' : 'ai';
  } catch (e) { return 'ai'; }
}

/**
 * The mode gate for every AI narration call. Normal mode NEVER
 * touches the AI client — the local templated text is returned
 * immediately, so Normal means zero AI calls across every event,
 * including ask-Axo. AI mode delegates to the client, whose own
 * failure handling falls back to the same local text. Pure seam:
 * the runtime passes its live mode + client in.
 */
export function axoNarrateWith({ mode, client, args } = {}) {
  const localText = () => {
    try { return typeof args.local === 'function' ? args.local() : args.local; } catch (e) { return null; }
  };
  if (mode !== 'ai' || !client) return Promise.resolve({ text: localText(), source: 'local' });
  return client.narrate(args);
}

const SPEECH_SMALL_NUMBERS = {
  0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five',
  6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven',
  12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen',
  16: 'sixteen', 17: 'seventeen', 18: 'eighteen', 19: 'nineteen', 20: 'twenty'
};

/**
 * Rewrite a subtitle line for ears: '₹4' → 'four rupees', 'BIG' →
 * 'Big', 'P&L' → 'P and L'. The subtitle keeps the original
 * formatting; only the spoken copy passes through here. Pure.
 */
export function normaliseSpeechText(line) {
  let t = String(line || '');
  t = t.replace(/₹\s*([\d,]+(?:\.\d+)?)/g, (m, n) => {
    const clean = n.replace(/,/g, '');
    const v = Number(clean);
    const num = Number.isInteger(v) && SPEECH_SMALL_NUMBERS[v] !== undefined ? SPEECH_SMALL_NUMBERS[v] : clean;
    return num + ' rupees';
  });
  t = t.replace(/\bBIG\b/g, 'Big').replace(/\bSMALL\b/g, 'Small');
  t = t.replace(/P&L/g, 'P and L');
  t = t.replace(/…/g, ', ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * Group settled events into utterances. A LOSS immediately followed
 * by LADDER_UP is ONE utterance — the ladder line folds into the
 * loss line, never a second overlapping voice. Everything else
 * stands alone. Pure.
 */
export function groupSpokenEvents(events = []) {
  const groups = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i] === BOT_EVENTS.LOSS && events[i + 1] === BOT_EVENTS.LADDER_UP) {
      groups.push([events[i], events[i + 1]]);
      i++;
    } else {
      groups.push([events[i]]);
    }
  }
  return groups;
}

/**
 * MISSED BET (PLAN.md §6): the locked governed verdict for a period
 * was BET and no bet was confirmed for it — a staged-but-never-
 * confirmed Auto-Pilot staging is the headline case. Fires exactly
 * once per (tf, period) key. An engine SKIP can never fire it: the
 * decision is read from the lock, never recomputed, and non-BET
 * decisions return false here by construction.
 */
export class MissedBetTracker {
  constructor() { this.firedKeys = new Set(); }
  /** Decide + record atomically: true exactly once per key. */
  shouldFire(key, { gateDecision = null, fired = false } = {}) {
    if (gateDecision !== GATE_DECISIONS.BET || fired) return false;
    if (this.firedKeys.has(key)) return false;
    this.firedKeys.add(key);
    return true;
  }
  has(key) { return this.firedKeys.has(key); }
}

/** The VERIFIED moment: a transition INTO VERIFIED from any other
 *  state. Staying VERIFIED across polls is not an edge. */
export function verifiedEdge(prevState, nextState) {
  return nextState === LOGIN_STATES.VERIFIED && prevState !== LOGIN_STATES.VERIFIED;
}

/** The spoken VERIFIED line needs the verifier's API-proven figure:
 *  a balance scraped from the page (balanceSource 'dom') never
 *  produces it, even inside a VERIFIED state. */
export function verifiedLineApplies(login) {
  return !!login && login.state === LOGIN_STATES.VERIFIED
    && login.balanceSource === 'api'
    && login.balance !== null && login.balance !== undefined;
}

// ─────────────────────────────────────────────────────────────────────
// Axo fix round (2026-10-24, owner's phone feedback) — pure layer
// ─────────────────────────────────────────────────────────────────────
// 1. VOICE GATE. Mobile browsers (Chrome/Brave on Android) keep
//    speechSynthesis silent until a user gesture, and every gameplay
//    tap lands inside the DhaniWin iframe — which never bubbles a
//    gesture to this document. That is why Axo never spoke on the
//    owner's phone while subtitles worked: the old code dropped
//    pre-gesture lines ("never queued") and the unlock gesture never
//    arrived. The gate below queues the latest line until the first
//    tap on the ball/panel (same document) and never swallows a
//    blocked utterance silently: the caller shows the tap affordance
//    while a line is queued.
// 2. SUBTITLE-CLOSED QUIET STATE (owner's 2026-10-24 refinement).
//    CC off means the prediction shows inside the Axo ball, silently.
//    The voice toggle VALUE is never flipped by opening/closing the
//    panel — speech is only suppressed while subtitles are closed,
//    and resumes (if the voice switch is on) when CC comes back.
//    This refines the earlier "voice is not bundled" rule for exactly
//    this state; the switches themselves stay independent.
// 3. LANGUAGE. 'o101_axo_lang' (new key, never reused from voice or
//    subs): en (default) / hi / ml. It drives the speechSynthesis
//    language tag + voice choice. Subtitles stay the governed
//    English strings — no translated template exists, so none is
//    invented; the language control is one-word changeable on the
//    owner's say if he ever supplies real templates.
// 4. BALL CLAMP. The floating ball (62px circle + ring + under-bar)
//    must never sit outside the viewport: clamped on load, drag end,
//    resize and orientation change, with safe margins.
// 5. ROAD. Every BET prediction's subtitle carries the sequence road
//    + the period number, and the road strip cells pair each settled
//    result with the governed pick recorded for that period.
export const AXO_LANG_KEY = 'o101_axo_lang';
export const AXO_LANGS = {
  en: { code: 'en', tag: 'en-IN', label: 'EN' },
  hi: { code: 'hi', tag: 'hi-IN', label: 'HI' },
  ml: { code: 'ml', tag: 'ml-IN', label: 'ML' }
};
export const AXO_LANG_ORDER = ['en', 'hi', 'ml'];

/** Axo voice language code ('en' default; unknown reads as 'en'). */
export function axoLangFrom(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return 'en';
    const v = storage.getItem(AXO_LANG_KEY);
    return AXO_LANGS[v] ? v : 'en';
  } catch (e) { return 'en'; }
}

/** speechSynthesis language tag for a language code. */
export function axoSpeechTag(code) {
  return (AXO_LANGS[code] || AXO_LANGS.en).tag;
}

/** Next language in the EN → HI → ML cycle. */
export function axoNextLang(code) {
  const idx = AXO_LANG_ORDER.indexOf(code);
  return AXO_LANG_ORDER[(idx < 0 ? 0 : idx + 1) % AXO_LANG_ORDER.length];
}

// ─────────────────────────────────────────────────────────────────────
// Axo fix round #2 (2026-10-24, owner's bug report) — pure layer
// ─────────────────────────────────────────────────────────────────────
// 1. SHORT PERIOD. No surface ever shows a full period number — only
//    the last 4 digits. Internal period identity (locks, disposition
//    keys, history records) always stays the full string; ONLY the
//    rendered text shortens, through this one helper.
// 2. NO LOGIN GATE. The display gate is the governed engine gate plus
//    the HARD_STOP overlay only — login state is not an input at all,
//    so it can never flip a BET to SKIP again. The base bet resolves
//    from the verified balance when fresh, else the manual chip base.
// 3. SUBTITLE SURFACES. Fix round #5: no floating subtitle exists
//    anymore — minimized state always shows the prediction inside
//    the Axo ball; the sheet line hides only when subtitles are
//    closed; voice follows its own switch, not the subtitle element.
// 4. CENTERED OVERLAY. The opened sheet's geometry: centered in the
//    viewport, never smaller than the overlay minimums.
// 5. VOICE MATCHING. Website voice matching (axofy.shop axo-site.js):
//    exact tag, then tag-prefix, then language-prefix.

/** Display-only short period: the last 4 digits, never the full number. */
export function shortPeriod(period) {
  if (period === null || period === undefined) return '';
  const s = String(period);
  return s ? s.slice(-4) : '';
}

/**
 * The base bet the governed ladder should run. AUTO uses the fresh
 * verified balance when one exists and falls back to the manual chip
 * base when it does not — login state never stalls staging.
 * null = no base knowable at all (no chip value either).
 */
export function resolveBaseBet({ autoBase = false, verifiedBalance = null, riskMode = 'balanced', chipBase = null } = {}) {
  const chip = Number(chipBase);
  const chipOk = Number.isFinite(chip) && chip > 0 ? Math.floor(chip) : null;
  if (autoBase) {
    if (verifiedBalance !== null && verifiedBalance !== undefined) return autoBaseBet(verifiedBalance, riskMode);
    return chipOk;
  }
  return chipOk;
}

/**
 * The display gate for a locked engine verdict: HARD_STOP overlays
 * a SKIP, nothing else does. Login state is deliberately NOT a
 * parameter — it cannot change what is shown or staged.
 */
export function displayGateFor(engineGate, { hardStopped = false } = {}) {
  if (hardStopped) return { ...engineGate, decision: GATE_DECISIONS.SKIP, prob: null, reason: HARD_STOP_REASON };
  return engineGate;
}

/** Website voice matching: exact tag, then tag-prefix, then language-prefix. */
export function pickAxoVoice(voices, tag) {
  const list = Array.isArray(voices) ? voices : [];
  const want = String(tag || '').toLowerCase();
  if (!want) return null;
  const prefix = want.split('-')[0];
  const norm = v => String((v && v.lang) || '').toLowerCase();
  return list.find(v => norm(v) === want)
    || list.find(v => norm(v).indexOf(want) === 0)
    || list.find(v => norm(v).indexOf(prefix) === 0)
    || null;
}

/**
 * Which prediction surfaces show, from CC + panel state. Fix round
 * #5: the floating subtitle element is DELETED — minimized state
 * always shows the prediction inside the Axo ball (pillVisible
 * whenever the panel is closed, regardless of CC); the sheet line
 * hides only when subtitles are closed. Voice is untouched by
 * this: it follows its own switch, not the subtitle element.
 */
export function subtitleSurfaces({ subsOn = true, panelOpen = false } = {}) {
  return {
    floatingVisible: false,
    sheetHidden: !subsOn,
    pillVisible: !panelOpen
  };
}

/** Centered overlay geometry: middle of the viewport, overlay minimums enforced. */
export function centeredSheetGeometry({ vw = 0, vh = 0, width = 360, height = 480, minWidth = 360, minHeight = 480 } = {}) {
  const w = Math.min(Math.max(minWidth, width), Math.max(minWidth, vw - 24));
  const h = Math.min(Math.max(minHeight, height), Math.max(minHeight, vh - 60));
  return {
    width: w,
    height: h,
    left: Math.max(8, Math.floor((vw - w) / 2)),
    top: Math.max(50, Math.floor((vh - h) / 2))
  };
}

/**
 * The voice decision for one narration attempt. 'speak' = say it now,
 * 'queue' = voice is on but no gesture yet (caller queues + shows
 * the tap affordance), 'silent' = voice switch off, or subtitles
 * closed (the quiet in-ball state) — never a swallowed line.
 */
export function axoMaySpeak({ voiceOn = true, subsOn = true, unlocked = false } = {}) {
  if (!voiceOn || !subsOn) return { action: 'silent' };
  if (!unlocked) return { action: 'queue' };
  return { action: 'speak' };
}

/**
 * The voice gate's queue state (pure, testable). The runtime syncs
 * voiceOn/subsOn live at every attempt and flushes `unlock()` on the
 * first ball/panel tap. A line queued while blocked is dropped the
 * moment the state goes silent — a stale line must never speak after
 * the user muted or closed subtitles.
 */
export class AxoVoiceGate {
  constructor({ voiceOn = true, subsOn = true, unlocked = false } = {}) {
    this.voiceOn = voiceOn;
    this.subsOn = subsOn;
    this.unlocked = unlocked;
    this.pending = null;
  }
  sync({ voiceOn, subsOn }) {
    if (voiceOn !== undefined) this.voiceOn = voiceOn;
    if (subsOn !== undefined) this.subsOn = subsOn;
    if (!this.voiceOn || !this.subsOn) this.pending = null;
  }
  attempt(line) {
    const d = axoMaySpeak({ voiceOn: this.voiceOn, subsOn: this.subsOn, unlocked: this.unlocked });
    if (d.action === 'queue') { this.pending = line || null; return { action: 'queue', line: this.pending }; }
    if (d.action === 'silent') { this.pending = null; return { action: 'silent', line: null }; }
    return { action: 'speak', line: line || null };
  }
  unlock() {
    this.unlocked = true;
    const line = this.pending;
    this.pending = null;
    return line;
  }
  get blocked() { return this.voiceOn && this.subsOn && !this.unlocked; }
  get hasPending() { return this.pending !== null; }
}

// Floating ball footprint: 62px circle + 3px ring each side (68px)
// + the fixed under-bar (period + mini road) below it.
export const AXO_ORB_WIDTH = 68;
export const AXO_ORB_HEIGHT = 86;

/**
 * Clamp a ball rect inside the viewport with safe margins. Pure.
 * When the viewport is narrower than the ball + margins, the ball
 * pins to the margin — the least-bad position, never off-screen.
 */
export function clampBallRect({ left = 0, top = 0, width = AXO_ORB_WIDTH, height = AXO_ORB_HEIGHT, vw = 0, vh = 0, margin = 8, topMargin = 10, bottomMargin = 12 } = {}) {
  const maxLeft = Math.max(margin, vw - width - margin);
  const maxTop = Math.max(topMargin, vh - height - bottomMargin);
  return {
    left: Math.min(Math.max(margin, left), maxLeft),
    top: Math.min(Math.max(topMargin, top), maxTop)
  };
}

const roadSizeWord = r => {
  if (r === 'BIG' || r === 'SMALL') return r;
  const n = Number(r);
  return Number.isFinite(n) ? (n >= 5 ? 'BIG' : 'SMALL') : null;
};
const roadSizeLetter = r => {
  const w = roadSizeWord(r);
  return w === 'BIG' ? 'B' : (w === 'SMALL' ? 'S' : null);
};

/**
 * The road suffix every BET subtitle carries: the last `count`
 * settled sizes as words (speakable) + the period being predicted.
 * Period prefers the open period, falling back to the last settled
 * period; with no history and no period the suffix is empty.
 */
export function roadSuffix({ history = [], period = null, count = 8 } = {}) {
  const settled = (history || []).filter(r => r && !r.gap && r.number !== null && r.number !== undefined);
  const last = settled.slice(-count);
  const road = last.map(r => roadSizeWord(r.size !== undefined && r.size !== null ? r.size : r.number)).filter(Boolean).join(', ');
  const p = period !== null && period !== undefined ? shortPeriod(period)
    : (settled.length ? shortPeriod(settled[settled.length - 1].period) : '');
  if (road && p) return `Road: ${road} · #${p}`;
  if (p) return `#${p}`;
  return '';
}

/** Append the road suffix to a prediction line (no-op when empty). */
export function withRoadSuffix(line, roadInfo = {}) {
  const s = roadSuffix(roadInfo);
  return s ? `${String(line || '').trim()} ${s}` : String(line || '');
}

/**
 * Road strip cells (newest first, matching the app's NEW→OLD roads).
 * Each settled cell pairs the real result with the governed pick
 * recorded for that period (dispositions carry `pick` since this
 * round); `correct` is true/false, or null when no governed pick
 * exists (engine SKIP / no disposition). `next` is the open period
 * being predicted, with the current governed pick.
 */
export function roadCells({ history = [], dispositions = {}, tf = '', openPeriod = null, nextPick = null, count = 8 } = {}) {
  const settled = (history || []).filter(r => r && !r.gap && r.number !== null && r.number !== undefined);
  const last = settled.slice(-count);
  const cells = [...last].reverse().map(r => {
    const disp = dispositions[`${tf}:${r.period}`] || null;
    const pick = disp && disp.pick ? disp.pick : null;
    const result = roadSizeWord(r.size !== undefined && r.size !== null ? r.size : r.number);
    return {
      period: String(r.period),
      number: Number(r.number),
      result,
      resultLetter: roadSizeLetter(result),
      pick,
      pickLetter: pick ? roadSizeLetter(pick) : null,
      correct: pick && result ? pick === result : null
    };
  });
  const next = openPeriod !== null && openPeriod !== undefined
    ? { period: String(openPeriod), next: true, pick: nextPick || null, pickLetter: nextPick ? roadSizeLetter(nextPick) : null }
    : null;
  return { cells, next };
}

/**
 * The in-ball prediction view for the minimized state: Axo
 * face + pick + period, minimal, never the old classic ball art.
 * SKIP renders as SKIP (announced via subtitle + voice at verdict
 * time since round #3); no verdict renders the neutral dash.
 */
export function orbPredictionView({ verdict = null, pick = null, period = null } = {}) {
  if (verdict === 'BET' && pick) return { pickText: pick, periodText: period ? `#${shortPeriod(period)}` : '', state: 'bet' };
  if (verdict === 'SKIP') return { pickText: 'SKIP', periodText: period ? `#${shortPeriod(period)}` : '', state: 'skip' };
  return { pickText: '—', periodText: period ? `#${shortPeriod(period)}` : '', state: 'none' };
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
        ? 'No bridge signal — open the DhaniWin tab in the 01.01 app'
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
  // Calibration now persists like model history (o101_calibration_v1,
  // recent 500 records): a fresh page load used to reset it to zero
  // and the gate skipped every round until 50 fresh settlements.
  const tracker = new CalibrationTracker({ storage: safeStorage() });
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

  // Axo runtime state: current face, the missed-bet ledger, the
  // HARD_STOP announcement edge, the first-gesture voice unlock and
  // the (dark-by-default) AI narration client. The voice gate is the
  // fix-round queue: pre-gesture lines wait in it instead of being
  // dropped, and the tap affordance shows while one waits.
  const axo = {
    face: null,
    visibleEl: 'front',  // which of the two stacked <img>s is showing
    faceSeq: 0,          // bumps on every face set (stale-beat guard)
    sleeping: false,
    lastInteractAt: Date.now(),
    missed: new MissedBetTracker(),
    hardStopAnnounced: false,
    voiceUnlocked: false,
    voiceGate: new AxoVoiceGate({ voiceOn: true, subsOn: true, unlocked: false }),
    lastRoadKey: null,
    lastOrbKey: null,
    lastLongRuns: null,
    lastLongRunsKey: null,
    ai: new AxoAiClient({ endpoint: AXO_AI_ENDPOINT })
  };

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
    // Order-channel liveness: a message that arrived through a window
    // reference (iframe parent / opener postMessage, or the same-origin
    // channel) proves the app can SEND an order back along that path.
    // The RTDB poll deliberately does NOT set this — it feeds the
    // verifier directly, and a state-only path must never be mistaken
    // for an order path (firing there would post to nowhere).
    state.orderChannelAt = Date.now();
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
  // Pivot origin allowlist (mirror of systems/dhani-transport.js —
  // update both together): bridge state is accepted ONLY from the
  // app's own origin or a DhaniWin family origin, never '*' and
  // never an unlisted origin. The BroadcastChannel path below is
  // origin-scoped by the platform and needs no gate.
  const O101_DHANIWIN_ORIGINS = ['https://dhaniwin44.com', 'https://dhaniwin.99.com', 'https://dhaniwin99.com', 'https://dhaniwin0.com', 'https://dhaniwin2.com'];
  function isAllowedBridgeOrigin(origin) {
    if (typeof origin !== 'string') return false;
    if (typeof window !== 'undefined' && window.location && origin === window.location.origin) return true;
    return O101_DHANIWIN_ORIGINS.indexOf(origin) !== -1;
  }
  window.addEventListener('message', ev => {
    if (!ev || !isAllowedBridgeOrigin(ev.origin)) return;
    feedBridgeMessage(ev.data);
  });
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
  // settings document). 'direct' means the game frame loads
  // directly; under the pivot the bridge arrives via APK native
  // injection, not via the worker.
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

  // ── Axo: face ────────────────────────────────────────────────────
  function axoFaces() {
    try { return typeof window !== 'undefined' ? window.__O101_AXO_FACES || null : null; } catch (e) { return null; }
  }

  function reducedMotion() {
    try { return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  /**
   * Set Axo's face by key, crossfading the two stacked header frames
   * over ~140ms (the widget's crossfadePair semantics). No-ops when
   * the face module or the sheet markup is absent (index page), and
   * never throws into the app.
   */
  function setAxoFace(name) {
    const faces = axoFaces();
    if (!faces || !faces[name]) return;
    if (name !== 'sleep' && name !== 'sleep2') axo.sleeping = false;
    if (axo.face === name) return;
    axo.face = name;
    axo.faceSeq++;
    const host = $('axoFaceHost');
    if (host) host.setAttribute('data-axo-face', name);
    // The floating ball wears the SAME face: the ball IS Axo, never
    // the old classic ball art. A plain src swap (no crossfade pair
    // on the 62px ball) keeps it in step with the sheet header.
    const orbFace = $('floatingOrbAxoFace');
    if (orbFace) orbFace.src = faces[name];
    // Fix round #4: the OPENED Axo is a SMALL avatar straddling
    // the sheet's top-center edge (Axofy-app pattern) — it wears
    // the same face, synced on every change. The giant centered
    // overlay from round #3 is deleted; this is its replacement.
    const topFace = $('axoTopAvatarFace');
    if (topFace) topFace.src = faces[name];
    const front = $('axoFaceFront'), back = $('axoFaceBack');
    if (!front || !back) return;
    const vis = axo.visibleEl === 'back' ? back : front;
    const hid = vis === front ? back : front;
    hid.src = faces[name];
    if (reducedMotion()) {
      vis.src = faces[name];
      vis.style.opacity = '1';
      hid.style.opacity = '0';
      return;
    }
    hid.style.opacity = '1';
    vis.style.opacity = '0';
    axo.visibleEl = hid === front ? 'front' : 'back';
  }

  // Idle behaviours, copied from the widget: the blink loop
  // (halfblink → blink → base, re-armed 2.8–5.5s, base face only)
  // and sleep after ~90s without interaction while the sheet is
  // closed (sleep ↔ sleep2 every 2.4s). Any governed event or tap
  // wakes Axo back to base first.
  function axoMaybeSleep() {
    if (axo.sleeping || guard.hardStopped) return;
    if (Date.now() - axo.lastInteractAt < 90000) return;
    const modal = $('dhaniwinAssistantModal');
    if (modal && !modal.classList.contains('hidden')) { axo.lastInteractAt = Date.now(); return; }
    axo.sleeping = true;
    setAxoFace('sleep');
  }

  function axoWake() {
    axo.lastInteractAt = Date.now();
    if (axo.sleeping) { axo.sleeping = false; setAxoFace('base'); }
  }

  function axoBlinkLoop() {
    const delay = axo.sleeping ? 2400 : 2800 + Math.random() * 2700;
    setTimeout(() => {
      try {
        if (axo.sleeping) {
          setAxoFace(axo.face === 'sleep' ? 'sleep2' : 'sleep');
        } else if (!reducedMotion() && axo.face === 'base' && !guard.hardStopped) {
          const seq = axo.faceSeq;
          setAxoFace('halfblink');
          setTimeout(() => { if (axo.faceSeq === seq + 1) setAxoFace('blink'); }, 110);
          setTimeout(() => { if (axo.faceSeq === seq + 2) setAxoFace('base'); }, 250);
        }
        axoMaybeSleep();
      } catch (e) { /* the loop must never break the app */ }
      axoBlinkLoop();
    }, delay);
  }

  // Voice unlock: Chrome/Brave keep speechSynthesis silent until a
  // user gesture, and gameplay taps land inside the DhaniWin iframe
  // (never bubbling to this document) — so the unlock gesture must
  // come from the ball/panel itself, which lives in this document.
  // The first such tap resumes the engine AND flushes the queued
  // line; nothing attempted before it is ever silently dropped.
  function unlockAxoVoice() {
    axoWake();
    if (axo.voiceUnlocked && !axo.voiceGate.hasPending) return;
    axo.voiceUnlocked = true;
    try { if (window.speechSynthesis) window.speechSynthesis.resume(); } catch (e) {}
    const queued = axo.voiceGate.unlock();
    renderAxoVoiceBadge();
    if (queued) speakUtterance(queued);
  }

  // Website pattern (axofy.shop axo-site.js): resume the engine on
  // EVERY capture-phase gesture, not only while locked — a paused
  // engine mid-utterance resumes the same way — and flush a queued
  // line the moment one waits. Gameplay taps inside the DhaniWin
  // iframe never reach this document, so the ball/panel tap is the
  // unlock that matters; the queue covers everything before it.
  document.addEventListener('pointerdown', () => {
    axoWake();
    try { if (window.speechSynthesis) window.speechSynthesis.resume(); } catch (e) {}
    if (!axo.voiceUnlocked || axo.voiceGate.hasPending) unlockAxoVoice();
  }, true);
  document.addEventListener('keydown', () => {
    try { if (window.speechSynthesis) window.speechSynthesis.resume(); } catch (e) {}
    if (!axo.voiceUnlocked || axo.voiceGate.hasPending) unlockAxoVoice();
  }, true);

  // ── Axo: voice ───────────────────────────────────────────────────
  function axoVoiceOn() { return axoVoiceEnabled(safeStorage()); }

  function axoCancelSpeech() {
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
  }

  /** The tap affordance: visible only while a line waits for a gesture. */
  function renderAxoVoiceBadge() {
    const badge = $('axoVoiceBlockedBadge');
    if (!badge) return;
    const show = axo.voiceGate.blocked && axo.voiceGate.hasPending;
    badge.classList.toggle('hidden', !show);
  }

  /** The raw utterance: language tag + voice from the persisted
   *  language choice. A rejected voice entry never kills the line —
   *  it falls back to the language tag alone. */
  function speakUtterance(text) {
    const synth = window.speechSynthesis;
    if (!synth || typeof synth.speak !== 'function' || typeof SpeechSynthesisUtterance === 'undefined') return;
    try {
      const u = new SpeechSynthesisUtterance(normaliseSpeechText(text));
      const tag = axoSpeechTag(axoLangFrom(safeStorage()));
      // Website voice matching (axofy.shop axo-site.js): exact tag,
      // then tag-prefix, then language-prefix — so en-IN finds an
      // en-IN voice before falling back to any en-* voice. Voices
      // are read fresh on every utterance (mobile engines publish
      // them asynchronously), so a first-call empty list never sticks.
      let voice = null;
      try {
        const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
        voice = pickAxoVoice(voices, tag);
      } catch (e) {}
      if (voice) {
        try { u.voice = voice; u.lang = voice.lang; } catch (e) { u.lang = tag; }
      } else { u.lang = tag; }
      u.rate = 1.02;
      u.pitch = 1.0;
      try { synth.cancel(); } catch (e) {}
      synth.speak(u);
    } catch (e) { /* voice must never break the app */ }
  }

  /**
   * Speak exactly the subtitle string (normalised for ears) — or
   * queue it when no gesture has arrived yet, or stay silent when
   * muted / subtitles closed (the quiet in-ball state). The gate's
   * voice/subs flags are read live at every attempt, so a Settings
   * change in another document takes effect on the next line.
   */
  function axoSpeak(text) {
    if (!text) return;
    axo.voiceGate.sync({ voiceOn: axoVoiceOn(), subsOn: axoSubsOn() });
    const d = axo.voiceGate.attempt(text);
    if (d.action === 'queue') { renderAxoVoiceBadge(); return; }
    if (d.action === 'silent') { renderAxoVoiceBadge(); return; }
    renderAxoVoiceBadge();
    speakUtterance(d.line);
  }

  function renderAxoVoiceChip() {
    const chip = $('axoVoiceChip');
    if (!chip) return;
    const on = axoVoiceOn();
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.classList.toggle('text-emerald-300', on);
    chip.classList.toggle('text-rose-300', !on);
    chip.classList.toggle('opacity-60', !on);
    const icon = $('axoVoiceChipIcon');
    if (icon) icon.className = 'fa-solid ' + (on ? 'fa-volume-high' : 'fa-volume-xmark') + ' pointer-events-none';
  }

  function setAxoVoice(on) {
    try { localStorage.setItem(AXO_VOICE_KEY, on ? '1' : '0'); } catch (e) {}
    if (!on) axoCancelSpeech();
    axo.voiceGate.sync({ voiceOn: on });
    renderAxoVoiceChip();
    renderAxoVoiceBadge();
  }

  // ── Axo: subtitles (CC) + mode ───────────────────────────────────
  // CC hides ONLY the subtitle strip; the governed flow, the face
  // and the toggle VALUES are untouched. Subtitle-closed is a quiet
  // state by the owner's refinement: the prediction shows inside
  // the Axo ball (pick + period + road) with no sound, and opening
  // the panel never flips CC or voice back — both stay exactly as
  // the user left them until he toggles them.
  function axoSubsOn() { return axoSubsEnabled(safeStorage()); }

  function renderAxoCcChip() {
    const chip = $('axoCcChip');
    if (!chip) return;
    const on = axoSubsOn();
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.classList.toggle('bg-emerald-500/25', on);
    chip.classList.toggle('text-emerald-300', on);
    chip.classList.toggle('border-emerald-500/40', on);
    chip.classList.toggle('bg-white/10', !on);
    chip.classList.toggle('text-zinc-400', !on);
    chip.classList.toggle('border-white/10', !on);
    chip.classList.toggle('opacity-60', !on);
  }

  function applyAxoSubs() {
    const el = $('smartBallLine');
    if (el) el.classList.toggle('hidden', !axoSubsOn());
    renderAxoCcChip();
    syncAxoSubtitleSurfaces();
  }

  function setAxoSubs(on) {
    try { localStorage.setItem(AXO_SUBS_KEY, on ? '1' : '0'); } catch (e) {}
    axo.voiceGate.sync({ subsOn: on });
    applyAxoSubs();
    renderAxoVoiceBadge();
    renderAxoOrb();
  }

  function axoMode() { return axoModeFrom(safeStorage()); }

  function renderAxoModeChip() {
    const chip = $('axoModeChip');
    if (!chip) return;
    const ai = axoMode() === 'ai';
    chip.textContent = ai ? 'AI' : 'NORMAL';
    chip.setAttribute('aria-pressed', ai ? 'true' : 'false');
    chip.classList.toggle('bg-emerald-500/25', ai);
    chip.classList.toggle('text-emerald-300', ai);
    chip.classList.toggle('border-emerald-500/40', ai);
    chip.classList.toggle('bg-white/10', !ai);
    chip.classList.toggle('text-zinc-300', !ai);
    chip.classList.toggle('border-white/10', !ai);
  }

  function setAxoMode(mode) {
    try { localStorage.setItem(AXO_MODE_KEY, mode === 'normal' ? 'normal' : 'ai'); } catch (e) {}
    renderAxoModeChip();
  }

  // ── Axo: language (EN / HI / ML, persisted, one-word changeable) ─
  function axoLang() { return axoLangFrom(safeStorage()); }

  function renderAxoLangChip() {
    const chip = $('axoLangChip');
    if (!chip) return;
    chip.textContent = (AXO_LANGS[axoLang()] || AXO_LANGS.en).label;
    chip.setAttribute('title', `Axo language: ${axoLang()} — tap to change`);
  }

  function setAxoLang(code) {
    const next = AXO_LANGS[code] ? code : 'en';
    try { localStorage.setItem(AXO_LANG_KEY, next); } catch (e) {}
    renderAxoLangChip();
  }

  function toggleAxoLang() { setAxoLang(axoNextLang(axoLang())); }

  /** Every AI narration call passes the mode gate (Normal = zero
   *  AI calls, templates only). Mode is read live, so a switch
   *  takes effect on the next event without a reload. */
  function axoNarrate(args) {
    return axoNarrateWith({ mode: axoMode(), client: axo.ai, args });
  }

  // The Settings page writes the same keys from its own document;
  // the storage event applies them here live (quant_sound parity).
  window.addEventListener('storage', e => {
    if (!e) return;
    if (e.key === AXO_VOICE_KEY) {
      if (e.newValue === '0') axoCancelSpeech();
      axo.voiceGate.sync({ voiceOn: e.newValue !== '0' });
      renderAxoVoiceChip();
      renderAxoVoiceBadge();
    } else if (e.key === AXO_SUBS_KEY) {
      axo.voiceGate.sync({ subsOn: e.newValue !== '0' });
      applyAxoSubs();
      renderAxoVoiceBadge();
      renderAxoOrb();
    } else if (e.key === AXO_MODE_KEY) {
      renderAxoModeChip();
    } else if (e.key === AXO_LANG_KEY) {
      renderAxoLangChip();
    }
  });

  // ── Speaking (orb's line) ────────────────────────────────────────
  /** The panel is open when the assistant modal is visible. The
   *  floating subtitle lives only in the closed-ball state: with the
   *  panel open, the sheet's own subtitle line shows the same text. */
  function axoPanelOpen() {
    const modal = $('dhaniwinAssistantModal');
    if (!modal) return false;
    return !modal.classList.contains('hidden') && modal.style.display !== 'none';
  }

  /** Sync prediction surfaces with CC + panel state. Fix round #5:
   *  no floating subtitle exists anymore: the closed ball always
   *  shows the prediction inside it (renderAxoOrb), and the panel
   *  subtitle line follows CC via applyAxoSubs. Called from say(),
   *  applyAxoSubs(), and the panel open/close hook in mobile.js. */
  function syncAxoSubtitleSurfaces() {
    renderAxoOrb();
  }

  function say(text) {
    const el = $('smartBallLine');
    // The sheet line carries an icon slot beside the text (fix round
    // #3): write the text span only, so a subtitle write never wipes
    // the verdict icon. Fix round #5: no floating subtitle exists —
    // the closed ball shows the prediction inside it (renderAxoOrb).
    const sheetText = $('axoSheetVerdictText');
    if (sheetText && text) sheetText.textContent = text;
    else if (el && text) el.textContent = text;
    state.lastLine = text;
    syncAxoSubtitleSurfaces();
  }

  /** Write one verdict icon into every icon slot that exists. Icons
   *  are visual only and never enter a spoken string; a null kind
   *  clears all slots. Each surface's own visibility logic (sheet
   *  open/closed, subtitles on/off) still governs display. Fix round
   *  #5: the floating subtitle's slot is gone with the element. */
  function setVerdictIcon(kind) {
    const svg = (kind && VERDICT_ICONS[kind]) || '';
    for (const id of ['axoSheetVerdictIcon', 'axoHeroVerdictIcon', 'orbVerdictIcon']) {
      const slot = $(id);
      if (slot) slot.innerHTML = svg;
    }
  }

  /** Fix round #4: the small prediction badge on the opened Axo
   *  avatar — written verdict text, or nothing at all. It is
   *  independent of CC (it is the avatar's badge, not the subtitle
   *  strip) and hides with the avatar cluster when the panel is
   *  closed. Empty text always hides it: never stale, never made up. */
  function setAxoPredictionBadge(text) {
    const badge = $('axoTopAvatarBadge');
    if (!badge) return;
    badge.textContent = text || '';
    badge.style.display = text ? 'inline-block' : 'none';
  }

  /** Face + voice for one governed event (spoken set only). */
  function axoOnEvent(event, line) {
    const fx = axoEventEffects(event);
    if (!fx.face) return;
    axo.lastInteractAt = Date.now();
    setAxoFace(fx.face);
    if (fx.spoken) axoSpeak(line);
  }

  function speakEvent(event, extra = {}) {
    const ctx = contextSnapshot(extra);
    const { line } = botLine(event, ctx);
    if (event === BOT_EVENTS.SIGNAL_SKIP) {
      // Fix round #3 (2026-10-24, owner's order): EVERY round is
      // announced — a SKIP speaks and shows like any other verdict.
      // This REPLACES the old skip-silence rule. Minimal line: the
      // word Skip + the short period only (no road suffix, no gate
      // reason); the skip icon rides alongside, never spoken. The
      // per-period gateKey lock in the governance cycle already
      // fires this exactly once per (timeframe, period).
      const sp = shortPeriod(openPeriodFor(state.tf || currentTf()));
      const full = sp ? `Skip · #${sp}` : 'Skip';
      say(full);
      setVerdictIcon('skip');
      setAxoPredictionBadge('Skip');
      axoOnEvent(event, full);
      return full;
    }
    // Every BET prediction's subtitle carries the sequence road +
    // the period number, and the voice speaks exactly that string.
    const full = event === BOT_EVENTS.SIGNAL_BET
      ? withRoadSuffix(line, {
          history: settledHistory(state.tf || currentTf()),
          period: openPeriodFor(state.tf || currentTf()),
          count: 8
        })
      : line;
    say(full);
    // Fix round #3: every verdict carries its icon — size arrow,
    // colour dot, or skip mark — beside the subtitle, never spoken.
    // Fix round #4: the opened avatar's badge carries the same
    // verdict as written text.
    if (event === BOT_EVENTS.SIGNAL_BET) {
      setVerdictIcon(verdictIconFor(ctx.pick, 'BET').kind);
      setAxoPredictionBadge(predictionBadgeText(ctx.pick, 'BET'));
    }
    axoOnEvent(event, full);
    return full;
  }

  /**
   * Speak a settled round's events as utterances. A LOSS+LADDER_UP
   * pair merges into ONE utterance whose text is the combined
   * subtitle — spoken string === subtitle string, always. Faces
   * beat in order (sad, then thinking for the ladder step).
   */
  function speakSettledEvents(events, extra = {}) {
    for (const group of groupSpokenEvents(events)) {
      const ctx = contextSnapshot(extra);
      const text = group.map(ev => botLine(ev, ctx).line).join(' ');
      say(text);
      const first = axoEventEffects(group[0]);
      if (first.face) {
        axo.lastInteractAt = Date.now();
        setAxoFace(first.face);
        if (group.length > 1) {
          const last = axoEventEffects(group[group.length - 1]);
          const seq = axo.faceSeq;
          if (last.face && last.face !== first.face) {
            setTimeout(() => { if (axo.faceSeq === seq) setAxoFace(last.face); }, 900);
          }
        }
      }
      if (first.spoken) axoSpeak(text);
      if (group.some(ev => ev === BOT_EVENTS.STOP_LOSS || ev === BOT_EVENTS.STOP_WIN || ev === BOT_EVENTS.CIRCUIT_BREAKER)) {
        axoSessionSummary();
      }
    }
  }

  /** HARD_STOP announcement edge: angry face (held) + the guard's
   *  own governed reason, spoken once per trip; clearing resets. */
  function axoSyncHardStop() {
    if (guard.hardStopped && !axo.hardStopAnnounced) {
      axo.hardStopAnnounced = true;
      const line = HARD_STOP_REASON + ' It clears after two shadow wins in a row, or re-arm it manually.';
      say(line);
      axo.lastInteractAt = Date.now();
      setAxoFace('angry');
      axoSpeak(line);
    } else if (!guard.hardStopped && axo.hardStopAnnounced) {
      axo.hardStopAnnounced = false;
      setAxoFace('base');
    }
  }

  /** The VERIFIED moment: wink face, and the spoken line only when
   *  the balance is the API-proven figure (never a page scrape). */
  function axoOnVerified(login) {
    axo.lastInteractAt = Date.now();
    setAxoFace('wink');
    if (!verifiedLineApplies(login)) return;
    const { line } = botLine(BOT_EVENTS.LOGIN_VERIFIED, contextSnapshot({ balance: login.balance }));
    say(line);
    axoSpeak(line);
  }

  // ── Axo: AI readout (display only; dark until the owner sets a
  //    server hop — PLAN.md §7/§8) ─────────────────────────────────
  function renderAxoAi(text) {
    const el = $('axoAiLine');
    if (el && text) el.textContent = text;
  }

  function axoPayload(eventName) {
    const tf = state.tf || currentTf();
    const gate = state.gate;
    const stats = state.inchargeId ? store.modelStats(tf, state.inchargeId) : null;
    const modelObj = arenaModels().find(m => m.id === state.inchargeId) || null;
    const history = settledHistory(tf);
    const pf = currentPatternFiring(tf);
    return buildAxoPayload({
      event: eventName,
      timeframe: tf,
      period: openPeriodFor(tf) || (history.length ? String(history[history.length - 1].period) : null),
      verdict: gate ? gate.decision : null,
      target: gate ? gate.pick : null,
      stake: state.session ? state.session.nextStake : null,
      ladderStep: state.session ? state.session.level : null,
      gateReason: gate ? gate.reason : null,
      conflictReason: gate && gate.conflict ? gate.reason : null,
      leaderModel: modelObj ? modelObj.name : null,
      leaderWilsonLB: stats ? stats.wilson : null,
      leaderFirings: stats ? stats.evaluated : null,
      patternFiring: pf ? { name: pf.name, hitRate: pf.hitRate, firings: pf.fired } : null,
      trend: currentTrend(tf),
      sessionPnL: state.session ? state.session.sessionPnL : null,
      settledCount: history.length,
      verifiedBalance: state.login && state.login.state === LOGIN_STATES.VERIFIED ? state.login.balance : null,
      lastResults: history.slice(-10).map(r => r.number)
    });
  }

  function axoRegimeRefresh() {
    const payload = axoPayload('REGIME');
    const local = () => localRegimeLabel(payload.lastResults, payload.trend).line;
    axoNarrate({ event: 'REGIME', payload, local }).then(r => { if (r && r.text) renderAxoAi(r.text); }).catch(() => {});
  }

  function axoSessionSummary() {
    const payload = axoPayload('SESSION_END');
    const local = () => localSessionSummary(payload);
    axoNarrate({ event: 'SESSION_END', payload, local }).then(r => { if (r && r.text) renderAxoAi(r.text); }).catch(() => {});
  }

  /** Ask Axo: AI when configured, the local predictBot answer
   *  otherwise. The answer is display text in the readout only —
   *  it is never spoken and never touches a decision. */
  async function askAxo(question) {
    const q = String(question || '').trim();
    if (!q) return null;
    const payload = axoPayload('QUESTION');
    const local = () => answerQuestion(q, contextSnapshot()).line;
    const r = await axoNarrate({ event: 'QUESTION', payload, question: q, local });
    const text = (r && r.text) || local();
    renderAxoAi(text);
    return text;
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
    if (login.state === LOGIN_STATES.NOT_LOGGED_IN) return 'Not logged into DhaniWin — signals and stakes still show here; an order needs DhaniWin login and will report its real result.';
    if (login.state === LOGIN_STATES.NO_SIGNAL) return 'No bridge signal yet — signals still show here; open the DhaniWin tab in the 01.01 app to connect.';
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
      const prevLoginState = state.loginState;
      state.loginState = login.state;
      say(loginLine(login));
      if (verifiedEdge(prevLoginState, login.state)) axoOnVerified(login);
    }
  }

  // The ONE slim line added to the live ball window (#bridgeStatusLine):
  // login evidence first, then the governed call for this round. It
  // never invents a number: balance comes from the bridge state, the
  // call from the gate, stakes from the bankroll session.
  function renderWindowStatus() {
    const el = $('bridgeStatusLine');
    if (!el) return;
    // Direct load with NO live bridge signal: say exactly that
    // instead of the "waiting for the bridge" line. A direct load
    // WITH a live login falls through to the normal evidence line —
    // under the pivot the bridge arrives via APK native injection,
    // so "direct" no longer means "bridge inactive".
    if (currentDhaniTransport() === 'direct' && (!state.login || state.login.state === LOGIN_STATES.NO_SIGNAL)) {
      // If this direct load is the proxy-failure fallback, name the
      // failure; otherwise name the remedy (reopen the tab — the
      // app injects the bridge itself).
      el.textContent = currentDhaniProxyFailed()
        ? PROXY_FAILED_LINE
        : 'Direct load — bridge inactive · reopen the DhaniWin tab in the 01.01 app (the app injects the bridge itself)';
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
        <div class="text-[8px] font-mono text-zinc-500">last fired · period …${esc(shortPeriod(r.lastPeriod))}</div>
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
   *  Fix round #2: AUTO without a fresh verified balance falls back
   *  to the manual chip base instead of stalling — login state never
   *  blocks staging. null = no chip value either. */
  function desiredBaseBet(login) {
    const chip = window.MobileBridgeState ? Number(window.MobileBridgeState.baseStake) : NaN;
    return resolveBaseBet({
      autoBase: ap.state.autoBase,
      verifiedBalance: freshVerifiedBalance(login) ? login.balance : null,
      riskMode: ap.state.riskMode,
      chipBase: chip
    });
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
    if (desired === null) return; // No base knowable at all (no chip value): keep the session as-is.
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
      // Honest-fire check: a staged bet fires only when a window
      // channel to the DhaniWin tab was heard recently (<=60s). A
      // bookmarklet-fed tab the app did NOT open gives state but no
      // order path — firing there must refuse, never fake success.
      orderChannel: state.orderChannelAt ? (Date.now() - state.orderChannelAt <= 60000) : false,
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
    say(`Fired: ${res.order.target} ${inr(res.order.stake)} for period …${shortPeriod(res.order.period)} — sent to the bridge on the tap you just gave.`);
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
    // Fix round #2: login is not a staging gate. Staging proceeds on
    // the governed session base (AUTO falls back to the chip base
    // without a fresh verified balance); only the DhaniWin page
    // itself can refuse an order, and it reports honestly.
    ap.notePaused(false);
    if (guard.hardStopped) { ap.forceStop(AP_STOP_REASONS.HARD_STOP); renderAutoPilot(); return; }
    if (gate.decision !== GATE_DECISIONS.BET) {
      if (ap.stagedBet()) ap.invalidate('gate flipped to SKIP');
      renderAutoPilot();
      return;
    }
    if (!openP || !state.session) return;
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
    // Generation guard (fix round #6): every new settled round used
    // to spawn a fresh walk WITHOUT stopping the old chains, so several
    // 101-model walks contended on the main thread at once. A stale
    // chain now exits at its next chunk boundary.
    const walkGen = (state.backfillGen = (state.backfillGen || 0) + 1);
    const gen = genFn(), ev = evalFn();
    if (!gen || !ev || history.length < 2) return;
    const models = arenaModels();
    if (!models.length) return;
    const patternCtx = activePatternContext(tf);
    // Only rounds not already recorded (live or earlier backfill).
    let idx = history.length - 1;
    const step = () => {
      if (walkGen !== state.backfillGen) return; // superseded walk: stop
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

  // ── Deep backfill (fix round #6): walk the warm-up's OLDER rounds ──
  // Same chunked walk as backfill, but over mobile.js's deep list
  // (MobileState.deepHistoryByTf, persisted as quant_deep_history_<tf>),
  // which the live fetch loop never wipes. recordRound is idempotent
  // per (tf, period), so live, backfill, and deep walks can never
  // double-count a round. This is what feeds a fresh origin's starved
  // store up to (and past) the 200-round gate from REAL settled
  // rounds — the "shadow evaluation" the owner asked for: every
  // observed round gets every model's pick recorded against its
  // outcome, whether or not any bet was placed.
  function backfillDeep(tf, deepHistory) {
    if (!Array.isArray(deepHistory) || deepHistory.length < 2) return;
    const key = tf + ':deep:' + deepHistory.length + ':' + deepHistory[deepHistory.length - 1].period;
    if (state.deepBackfilledKey === key) return;
    state.deepBackfilledKey = key;
    const walkGen = (state.deepBackfillGen = (state.deepBackfillGen || 0) + 1);
    const gen = genFn(), ev = evalFn();
    if (!gen || !ev) return;
    const models = arenaModels();
    if (!models.length) return;
    const patternCtx = activePatternContext(tf);
    let idx = deepHistory.length - 1;
    const step = () => {
      if (walkGen !== state.deepBackfillGen) return; // superseded walk: stop
      const t0 = Date.now();
      while (idx >= 1 && Date.now() - t0 < 24) {
        const round = deepHistory[idx];
        if (round && !store.hasPeriod(tf, round.period)) {
          const entries = walkForwardEntries(models, deepHistory, idx, gen, ev, patternCtx, 'deep');
          store.recordRound(tf, round.period, entries);
        }
        idx -= 1;
      }
      if (idx >= 1) setTimeout(step, 60);
      else { store.save(); }
    };
    setTimeout(step, 300);
  }

  // Consume the warm-up's deep list whenever cycle() runs (cheap:
  // key-checked inside backfillDeep). Rehydrates from localStorage
  // when the in-memory slot is empty, so a reload resumes warming
  // without re-fetching upstream pages.
  function consumeDeepHistory(tf) {
    try {
      const ms = (typeof window !== 'undefined' && window.MobileState) || null;
      if (!ms) return;
      if (!ms.deepHistoryByTf) ms.deepHistoryByTf = {};
      let deep = ms.deepHistoryByTf[tf];
      if ((!deep || !deep.length) && typeof localStorage !== 'undefined') {
        try {
          const raw = localStorage.getItem('quant_deep_history_' + tf);
          const parsed = raw ? JSON.parse(raw) : null;
          if (Array.isArray(parsed) && parsed.length) { ms.deepHistoryByTf[tf] = parsed; deep = parsed; }
        } catch (e) {}
      }
      if (deep && deep.length) backfillDeep(tf, deep);
    } catch (e) {}
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
            // a MISSED BET (PLAN.md §6) — the locked pick went
            // unplayed. Calibration still measures the pick; no
            // ladder movement, no P&L change. An engine SKIP never
            // reaches this branch, so a skip can never count as missed.
            tracker.record(state.lastPick.prob, !!won);
            ap.resolveUnfired(tf, latestPeriod, 'skipped');
            if (axo.missed.shouldFire(tf + ':' + latestPeriod, { gateDecision: decision, fired })) {
              speakEvent(BOT_EVENTS.MISSED_BET, {
                missedPick: state.lastPick.target,
                missedWon: !!won,
                missedResult: !!won ? (latest.size === 'BIG' ? 'Big' : latest.size === 'SMALL' ? 'Small' : null) : null,
                lastResult: `${latest.size} ${latest.number}`
              });
            }
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
            speakSettledEvents(result.events, { lastResult: `${latest.size} ${latest.number}` });
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
            // SKIP verdict at settlement: no settled-event
            // announcements — the skip was already announced at
            // verdict time (fix round #3: every round announced).
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

    // Deep-history warm-up (fix round #6): every cycle, cheap
    // key-checked consume of mobile.js's deep list, so a fresh
    // origin's store warms even when no new round settles that tick.
    consumeDeepHistory(tf);

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

    // Display overlay on the LOCKED engine verdict: HARD_STOP only.
    // Login is NOT a display gate (fix round #2, owner's order): the
    // governed signal and stake show regardless of bridge login
    // state; only a real order through the DhaniWin page needs its
    // own login, and a failed order reports its real failure.
    // Overlays change what is shown and staged, never the locked
    // verdict itself.
    const engineGate = locked.gate;
    const gate = displayGateFor(engineGate, { hardStopped: guard.hardStopped });
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
        // The governed pick rides along so the road strip can pair
        // each settled result with the pick the governor made for it.
        // A SKIP carries NO pick: the governor picked nothing that
        // round, and the strip must never invent one for it.
        state.dispositions[dKey] = { decision: engineGate.decision, pick: engineGate.decision === GATE_DECISIONS.BET ? (engineGate.pick || null) : null, fired: ap.hasFired(tf, openP), apOn: ap.enabled };
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
    // Axo surfaces follow the same verdict: the road strip, the
    // in-ball prediction, and (throttled) the long-run analysis.
    renderAxoRoad();
    renderAxoOrb();
    scheduleLongAnalysis();
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
      // Axo AI readout: the regime label refreshes on a BET lock
      // only — never on a SKIP, never per tick (PLAN.md §7).
      if (gate.decision === GATE_DECISIONS.BET) axoRegimeRefresh();
    }
    axoSyncHardStop();

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
    window.__o101Verdict = { decision: view.decision, pick: view.pick, confText: view.confText, reason: view.reasonText || '', key: state.verdictKey || null };
    if (state.page !== 'mobile') return;
    const targetEl = $('mobileWebTargetDisplay');
    if (targetEl) {
      targetEl.textContent = view.targetText;
      // Canonical class on every render: the target's size can never
      // jump because another writer left a different size class on it.
      targetEl.className = HERO_TARGET_CLASSES[view.decision === 'BET' ? (view.pick || 'NONE') : view.decision] || HERO_TARGET_CLASSES.NONE;
    }
    // Fix round #3: the hero verdict carries its icon too — size
    // arrow, colour dot, or skip mark — re-asserted on every cycle
    // so the hero never shows a stale verdict's icon.
    // Fix round #4: the opened avatar's badge follows the same
    // cycle, and clears whenever there is no live verdict.
    setVerdictIcon(view.decision === 'BET' ? verdictIconFor(view.pick, 'BET').kind : (view.decision === 'SKIP' ? 'skip' : null));
    setAxoPredictionBadge(badgeFromView(view));
    const conf = $('assistantConfBadge');
    if (conf) conf.textContent = view.confText;
    // Skip reason on the hero surface itself (mobile.html
    // #mobileWebVerdictReason, under NEXT PREDICTION). Cleared on
    // BET/NONE so a stale reason never outlives its verdict.
    const why = $('mobileWebVerdictReason');
    if (why) why.textContent = view.reasonText || '';
  }

  function renderSignal(gate, incharge, login) {
    const bet = gate.decision === GATE_DECISIONS.BET;
    // Fix round #2: the stake suggestion is never login-gated. The
    // figures shown are always the governed session's own (or '—'
    // when no session exists) — never invented, never blocked.
    if (state.page === 'mobile') {
      // The floating ball's pick pill is written by renderAxoOrb
      // (the ONE ball writer, from the published hero verdict) —
      // never here, so the native and governed writers cannot fight
      // over the ball. The stake lives in the sheet hero only.
      // Ladder Base/Bet in the live window come from bankroll.js (the
      // governed ladder) and show whenever a session exists,
      // regardless of login state.
      // Level integrity (owner's rule, 2026-10-24): the Level pill,
      // the Base/Bet lines, Auto-Pilot staging and settlement ALL read
      // this one governed session — the pill no longer shows the live
      // app's separate recovery ladder. (This supersedes the rebase's
      // "leave the pill to the app" call, on the owner's explicit
      // one-source-of-truth order.)
      const baseEl = $('assistantBaseStakeDisplay');
      if (baseEl) {
        baseEl.textContent = state.session ? inr(state.session.baseBet) : '—';
      }
      const betEl = $('mobileWebStakeDisplay');
      if (betEl) betEl.textContent = bet && state.session ? inr(state.session.nextStake) : '—';
      const levelEl = $('mobileWebLevelBadge');
      if (levelEl) {
        levelEl.textContent = state.session && state.session.level > 0
          ? `Level ${state.session.level + 1} (Recovery)`
          : 'Level 1 (Base)';
      }
    }
  }

  // ── Axo surfaces: road strip, in-ball prediction, long runs ─────
  // The road strip pairs each settled result with the governed pick
  // for that period (dispositions carry the pick); the NEXT cell is
  // the open period + the current governed pick. Fixed height, one
  // view, minimal mono — and keyed, so an unchanged road costs no
  // DOM write on the 3s cycle.
  function renderAxoRoad() {
    const strip = $('axoRoadStrip');
    if (!strip || state.page !== 'mobile') return;
    const tf = state.tf || currentTf();
    const history = settledHistory(tf);
    const openP = openPeriodFor(tf);
    const gate = state.gate;
    const { cells, next } = roadCells({
      history, dispositions: state.dispositions, tf,
      openPeriod: openP, nextPick: gate && gate.decision === GATE_DECISIONS.BET ? gate.pick : null,
      count: 8
    });
    const key = JSON.stringify([tf, openP, gate ? gate.decision + ':' + (gate.pick || '') : '', cells.map(c => c.period + ':' + (c.pick || '-') + ':' + c.result).join(',')]);
    if (key === axo.lastRoadKey) return;
    axo.lastRoadKey = key;
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const cellHtml = c => {
      const pickCls = c.correct === true ? 'text-emerald-300' : (c.correct === false ? 'text-rose-300' : 'text-zinc-500');
      // Fix round #3: a skipped round shows the skip mark, never an
      // invented pick — the strip stays honest about what the
      // governor actually called that period.
      const disp = state.dispositions[`${tf}:${c.period}`] || null;
      const skipped = disp && disp.decision === GATE_DECISIONS.SKIP;
      const pickHtml = skipped ? VERDICT_ICONS.skip : esc(c.pickLetter || '–');
      return `<div class="flex flex-col items-center shrink-0 px-1" title="Period #${esc(shortPeriod(c.period))} — result ${esc(c.result)}, governed pick ${esc(c.pick || (skipped ? 'skip' : 'none'))}">
        <span class="text-[10px] font-mono font-black text-white leading-none">${esc(c.number)}</span>
        <span class="text-[7px] font-mono font-bold ${pickCls} leading-none mt-0.5">${pickHtml}</span>
      </div>`;
    };
    const nextHtml = next
      ? `<div class="flex flex-col items-center shrink-0 px-1.5 py-0.5 rounded-lg bg-amber-500/15 border border-amber-500/30" title="Next period #${esc(shortPeriod(next.period))}">
          <span class="text-[7px] font-mono font-black text-amber-300 leading-none">NEXT ${esc(shortPeriod(next.period))}</span>
          <span class="text-[10px] font-mono font-black text-amber-200 leading-none mt-0.5">${esc(next.pickLetter || '–')}</span>
        </div>`
      : '';
    strip.innerHTML = cells.length || next
      ? nextHtml + cells.map(cellHtml).join('<div class="shrink-0 w-px h-4 bg-white/10 self-center"></div>')
      : '<span class="text-[7.5px] font-mono text-zinc-500 px-1">No settled rounds yet.</span>';
  }

  // The in-ball prediction (subtitle-closed state included): the Axo
  // ball's pick pill + under-bar (period + last-5 road letters).
  // Keyed like the strip. The ball never shows the old classic art:
  // its face is Axo's (setAxoFace), its text is the governed verdict.
  function renderAxoOrb() {
    if (state.page !== 'mobile') return;
    const pill = $('floatingOrbTarget');
    const bar = $('floatingOrbUnderBar');
    if (!pill && !bar) return;
    const v = window.__o101Verdict || null;
    const tf = state.tf || currentTf();
    const openP = openPeriodFor(tf);
    const history = settledHistory(tf);
    const road = history.slice(-5).map(r => {
      const w = (r.size === 'BIG' || r.size === 'SMALL') ? r.size : (Number(r.number) >= 5 ? 'BIG' : 'SMALL');
      return w === 'BIG' ? 'B' : 'S';
    }).join(' ');
    const view = orbPredictionView({ verdict: v ? v.decision : null, pick: v ? v.pick : null, period: openP });
    const key = JSON.stringify([view.pickText, view.periodText, road]);
    if (key === axo.lastOrbKey) return;
    axo.lastOrbKey = key;
    // Fix round #5: minimized state always shows the prediction
    // inside the Axo ball itself — the floating subtitle element is
    // deleted, so the pill, icon, and under-bar are never hidden by
    // the subtitle switch. (The ball fades out when the panel opens,
    // so this display is only ever seen minimized.) Positioning
    // classes are never overwritten here: only text and colour (via
    // style) change, so the pill can never lose its place on the ball.
    if (pill) {
      pill.textContent = view.pickText;
      pill.style.color = view.state === 'bet' ? '#fde68a' : (view.state === 'skip' ? '#d4d4d8' : '#71717a');
      pill.classList.remove('hidden');
    }
    // Fix round #3: the in-ball display carries the verdict icon
    // beside the pill (skip mark for a skipped round).
    const orbIcon = $('orbVerdictIcon');
    if (orbIcon) {
      orbIcon.innerHTML = view.state === 'bet' ? (verdictIconFor(v ? v.pick : null, 'BET').svg || '') : (view.state === 'skip' ? VERDICT_ICONS.skip : '');
      orbIcon.classList.remove('hidden');
    }
    if (bar) {
      bar.textContent = [view.periodText, road].filter(Boolean).join(' · ') || '—';
      bar.classList.remove('hidden');
    }
  }

  // Background long analysis (display only): re-runs in idle-time
  // chunks only when the settled count for this timeframe changes.
  // It never feeds a verdict, a stake or a gate — the block below the
  // road strip just shows what the history already contains.
  function scheduleLongAnalysis() {
    const block = $('axoLongRuns');
    if (!block || state.page !== 'mobile') return;
    const tf = state.tf || currentTf();
    const history = settledHistory(tf);
    const key = tf + ':' + history.length;
    if (key === axo.lastLongRunsKey) return;
    axo.lastLongRunsKey = key;
    block.innerHTML = '<div class="text-[7.5px] font-mono text-zinc-500 px-1 py-1">Analysing history…</div>';
    try {
      analyseHistoryChunked(history, {
        onDone: result => {
          axo.lastLongRuns = result;
          const top = (result.findings || []).slice(0, 6);
          const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
          block.innerHTML = `<div class="flex items-center justify-between px-1">
              <span class="text-[7px] font-mono font-bold tracking-wider text-zinc-400">LONG RUNS · ${result.rounds} ROUNDS</span>
              <span class="text-[6.5px] font-mono text-zinc-500">observed history only</span>
            </div>`
            + (top.length ? top.map(f => `<div class="flex items-center justify-between px-1 py-0.5">
                <span class="text-[8px] font-mono font-bold text-white truncate">${esc(f.label)}</span>
                <span class="text-[7px] font-mono text-zinc-500 shrink-0 ml-2">${f.startPeriod ? '…#' + esc(shortPeriod(f.startPeriod)) : ''}${f.endPeriod ? ' → …#' + esc(shortPeriod(f.endPeriod)) : ''}${f.count ? ` · ${f.count}×` : ''}</span>
              </div>`).join('')
              : '<div class="text-[7.5px] font-mono text-zinc-500 px-1 py-1">No long runs yet — the history is still short.</div>');
        }
      });
    } catch (e) {
      block.innerHTML = '<div class="text-[7.5px] font-mono text-zinc-500 px-1 py-1">Analysis unavailable.</div>';
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
    // Axo (this build): voice setting, face state, ask-Axo.
    toggleAxoVoice: () => setAxoVoice(!axoVoiceOn()),
    refreshAxoVoiceChip: renderAxoVoiceChip,
    toggleAxoSubs: () => setAxoSubs(!axoSubsOn()),
    refreshAxoSubs: applyAxoSubs,
    syncAxoSubtitleSurfaces,
    toggleAxoMode: () => setAxoMode(axoMode() === 'ai' ? 'normal' : 'ai'),
    refreshAxoModeChip: renderAxoModeChip,
    toggleAxoLang,
    refreshAxoLangChip: renderAxoLangChip,
    unlockAxoVoice,
    axoLang,
    askAxo,
    axo: {
      face: () => axo.face,
      setFace: setAxoFace,
      speakEvent,
      setVerdictIcon,
      setPredictionBadge: setAxoPredictionBadge,
      missed: axo.missed,
      aiConfigured: () => axo.ai.configured,
      mode: axoMode,
      subs: axoSubsOn,
      voice: axoVoiceOn,
      lang: axoLang
    },
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

  // Axo comes up on the base face with the chips synced to the
  // persisted voice / subtitle / mode / language settings; the
  // tap-for-voice badge starts hidden (nothing queued yet); the
  // ball clamp is published for the classic script's orb drag
  // (mobile.js cannot import this module — same function, one
  // source of truth, inline fallback when the module is absent).
  // Blink/sleep run from here.
  window.__o101ClampBall = clampBallRect;
  renderAxoVoiceChip();
  renderAxoVoiceBadge();
  applyAxoSubs();
  renderAxoModeChip();
  renderAxoLangChip();
  setAxoFace('base');
  axoBlinkLoop();

  setInterval(() => { try { cycle(); } catch (e) {} }, 3000);
  setTimeout(() => { try { cycle(); } catch (e) {} }, 1200);
  setInterval(apTick, 500);
}
