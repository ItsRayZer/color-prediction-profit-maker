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
 *    signal gate decides BET or NO_PICK, and bankroll.js runs the
 *    double-on-loss ladder until a win (no caps, no stops —
 *    advice/state only, this bridge never places a bet).
 *  - Feeds the existing Assistant Orb via predictBot lines: gate
 *    decisions with reasons, Incharge changes, win/loss events,
 *    ladder state and every stop state. Serious tone on losses is
 *    predictBot's own rule. No confidence is ever shown uncalibrated.
 *
 * Everything is defensive: if the app's data is not ready, the bridge
 * waits quietly. It never throws into the page.
 */

import { InchargeEngine, INCHARGE_MODES, wilsonLowerBound, selectInchargeOwnerRule } from './inchargeEngine.js';
import { CalibrationTracker, PerModelCalibrationTracker, calibrationLabel, plattScale, CALIBRATION_KEY, expectedCalibrationError } from './calibration.js';
import { evaluateSignalGate, GATE_DECISIONS, GateCooldown, sampleStakeFactor, betTypeOfPick, ASI_TRIAL_IDS, ASI_TRIAL_GATE_REASON } from './signalGate.js';
import { BlacklistManager } from './blacklist.js';
import { BenchManager, benchStatusLabel, benchProgressText, benchRoundsText } from './bench.js';
import {
  isObserverId, observerIdForType, observerPickFor, rankFollowCandidates,
  chooseRule, ruleWilson,
  ObserverRuleStore, OBSERVER_RULES, OBSERVER_RULE_LABELS
} from './observer.js';
import {
  barFor, ledgerWeight, ledgerStake, applyLedgerResult, saveLedger, loadLedger,
  ledgerLevelIndex, ledgerResize, ledgerLineFor, overBalanceInfo,
  ladderStake, isHighChance, neverZeroCap, stakeWithGuards,
  pickSizingBalance, shouldAskBalance,
  loadPnl, savePnl, applyPnlResult, totalPnl, pnlBoxText,
  autoAnchorLabel, decideAutoBase, AUTO_ANCHOR_FRACTION,
  LADDER_LEVELS, HIGH_CHANCE_WILSON, DOUBLING_GATE_LOSSES
} from './ledger.js';
import {
  createSession, settle, planLadder, suggestBaseBet, getStakingMode,
  balanceSourceLabel, BALANCE_SOURCES, DEFAULT_STAKING_MODE,
  createExactSession, settleExactFlat, sessionStoreKey, saveSessionTo, loadSessionFrom
} from './bankroll.js';
import { botLine, BOT_EVENTS, answerQuestion } from './predictBot.js';
import { AxoAiClient, buildAxoPayload, localRegimeLabel, localSessionSummary, AXO_AI_ENDPOINT } from './axo-ai.js';
import { analyseHistoryChunked } from './longAnalysis.js';
import { AutoPilot, AUTOPILOT_SETTINGS_KEY, autoBaseBet } from './autoPilot.js';
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
    // Session baselines (Phase 3A, v2 §1.1): per (tf, modelId) the
    // evaluated/wins counters at page load, so "session" = rounds
    // since this page load (reload = new session). Models created
    // after load default to a zero baseline (their whole history
    // counts as session — correct for a model first seen mid-page).
    this.sessionBaselines = {};
    for (const tf of Object.keys(this.data.tf)) {
      const bucket = this.data.tf[tf];
      for (const [id, m] of Object.entries(bucket.models || {})) {
        this.sessionBaselines[`${tf}::${id}`] = { evaluated: m.evaluated || 0, wins: m.wins || 0 };
      }
    }
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
    // Last-10 window (v2 §1.1): the last 10 settled rounds, from the
    // capped recent array (RECENT_CAP = 100, so slice(-10) is exact).
    const last10 = m.recent.slice(-10);
    const last10Wins = last10.reduce((a, b) => a + b, 0);
    // Session window (v2 §1.1): rounds since page load, via the
    // constructor baselines (clamped ≥0 — a stored counter can never
    // run below its load-time baseline in normal operation).
    const base = (this.sessionBaselines && this.sessionBaselines[`${tf}::${modelId}`]) || { evaluated: 0, wins: 0 };
    const sessionEvaluated = Math.max(0, m.evaluated - (base.evaluated || 0));
    const sessionWins = Math.max(0, m.wins - (base.wins || 0));
    return {
      evaluated: m.evaluated,
      wins: m.wins,
      losses: m.losses,
      winRate: m.wins / m.evaluated,
      wilson: wilsonLowerBound(m.wins, m.evaluated),
      streak: m.streak,
      recentEvaluated,
      recentWins,
      recentWinRate: recentEvaluated ? recentWins / recentEvaluated : null,
      last10Evaluated: last10.length,
      last10Wins,
      last10WinRate: last10.length ? last10Wins / last10.length : null,
      sessionEvaluated,
      sessionWins,
      sessionWinRate: sessionEvaluated ? sessionWins / sessionEvaluated : null
    };
  }

  /** Rolling last-100 outcomes for one model (copy; [] when none).
   *  Phase 3E S3 leader-health slope reads last-20 vs prior-20 from
   *  this array — display only, never a selection input. */
  recentArray(tf, modelId) {
    const bucket = this.data.tf[tf];
    const m = bucket && bucket.models[modelId];
    return m ? m.recent.slice() : [];
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
    seq: Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : null,
    // Task O (connection resilience): the bridge's per-load instance id.
    // A restart resets seq to 1; the verifier re-baselines on an
    // instance change instead of stalling. Absent on older bridge
    // builds (null) — the ts rules below still cover those.
    instance: typeof raw.instance === 'string' && raw.instance !== '' ? raw.instance : null
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
    // Task O: the bridge instance id of the last accepted state.
    // A new instance re-baselines immediately (see observeBridgeState).
    this.bridgeInstance = null;
  }

  /**
   * Feed one published bridge state (already normalised, or raw — it
   * is normalised here). receivedAt is the APP clock; the bridge's own
   * ts is kept for display but freshness is judged on receivedAt so a
   * skewed page clock cannot fake or kill freshness.
   * Task O (connection resilience) acceptance rules — a replayed or
   * stale state is NEVER accepted, but a bridge restart no longer
   * stalls for 120s:
   *  * older ts than the last accepted → rejected (replay/stale),
   *    except after a long silence (the old backstop, kept);
   *  * same ts + older seq → rejected as an out-of-order duplicate,
   *    except from a NEW bridge instance or after a long silence;
   *  * NEWER ts → accepted even with an older seq: a restart resets
   *    seq to 1 while its clock keeps moving, so a fresh-ts +
   *    reset-seq state is a restart, not a replay (the old rule
   *    rejected on olderSeq alone and stalled every restart);
   *  * a NEW bridge instance (instance id changed) re-baselines
   *    immediately, provided its ts is not older than the last
   *    accepted ts; null-ts states keep the old seq + longSilence
   *    rule. Freshness for VERIFIED still needs ≤60s age AND
   *    isLoggedIn AND apiProven from a real authenticated payload.
   */
  observeBridgeState(raw, receivedAt = Date.now()) {
    const st = normaliseBridgeState(raw);
    if (!st) return this.status(receivedAt);
    // Owner rule (balance-zero fix): a 0 bridge state never
    // displaces a held balance. status() prefers bs.balance, so the
    // carried figure must live IN the stored state: a 0 becomes the
    // held figure (or null when nothing was ever held — unknown,
    // never ₹0).
    if (st.balance === 0) st.balance = this.balance;
    const t = Number.isFinite(Number(receivedAt)) ? Number(receivedAt) : Date.now();
    if (this.bridgeState) {
      const olderTs = st.ts !== null && this.bridgeState.ts !== null && st.ts < this.bridgeState.ts;
      const olderSeq = st.seq !== null && this.bridgeState.seq !== null && st.seq < this.bridgeState.seq;
      const sameTsOlderSeq = st.ts !== null && this.bridgeState.ts !== null && st.ts === this.bridgeState.ts && olderSeq;
      // A new bridge instance re-baselines immediately — but only
      // with a non-older ts, so a replayed old state (old ts, forged
      // or stale instance) still loses to the ts rule below.
      const newInstance = st.instance !== null && this.bridgeInstance !== null && st.instance !== this.bridgeInstance;
      const longSilence = t - this.bridgeStateAt > 120000;
      if (olderTs && !longSilence) return this.status(t);
      if (sameTsOlderSeq && !newInstance && !longSilence) return this.status(t);
      if (st.ts === null && olderSeq && !newInstance && !longSilence) return this.status(t);
    }
    this.everObserved = true;
    this.bridgeState = st;
    this.bridgeStateAt = t;
    if (st.instance !== null) this.bridgeInstance = st.instance;
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
    // Owner rule (balance-zero fix): a 0 bridge state never
    // displaces a held balance — the old figure stands, and with no
    // held figure the state stays unknown instead of becoming ₹0.
    if (st.balance !== null && st.balance !== 0) {
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
    // Owner rule (balance-zero fix): a 0 signal never displaces a
    // held balance, and never becomes the first figure either.
    if (sig.balance !== null && sig.balance !== undefined && Number.isFinite(Number(sig.balance)) && Number(sig.balance) !== 0) {
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
 * verdict surface inside the sheet. Derived only from the LOCKED
 * gate verdict — NO_PICK renders '—' with no target and no
 * confidence, so a prediction and a no-pick can never be visible
 * in the sheet at the same time.
 */
// Digit test for ball images (pure): a governed pick that is exactly
// one digit 0–9 carries a ball image; colour/size picks do not.
export function ballDigitFor(pick) {
  const p = String(pick === null || pick === undefined ? '' : pick);
  return /^[0-9]$/.test(p) ? p : null;
}

// Phase 3B ball key (pure): every governed pick carries a ball image
// key — exact digits 0–9 (balls.js PNGs) plus the letter balls
// (systems/letter-balls.js, game-style glossy spheres): BIG, SMALL,
// GREEN, RED, VIOLET. The view field keeps the name `ballDigit` to
// avoid ripples; its values are now ball KEYS (digit or letter).
// A no-pick round never gets a key (callers pass null for NO_PICK).
export function ballKeyFor(pick) {
  const d = ballDigitFor(pick);
  if (d) return d;
  const p = String(pick === null || pick === undefined ? '' : pick).toUpperCase();
  return ['BIG', 'SMALL', 'GREEN', 'RED', 'VIOLET'].includes(p) ? p : null;
}

/**
 * Phase 3E display spec (design §9): every round's hero detail carries
 * the pick's honest quality — Chance (RAW win rate, labelled raw),
 * Wilson (defended chance), signed gap to the type's bar, and ONE
 * quality tag. Tags describe, they never block: a below-bar pick
 * shows with the same layout and a muted/amber tag, still stageable.
 * Pure, testable. Thin-sample floor: 20 rounds (colour/size gate
 * floor); Uncalibrated is read off the gate's own quality reason.
 */
export function qualityTagFor(gate) {
  if (!gate || gate.decision !== GATE_DECISIONS.BET) return '';
  if (Number.isFinite(gate.sampleSize) && gate.sampleSize < 20) return 'Thin sample';
  if (gate.qualityReason && /uncalibrated/i.test(gate.qualityReason)) return 'Uncalibrated';
  return gate.belowBar ? 'Below bar' : 'Above bar';
}

/** Signed gap in points between a Wilson bound and the type's bar. */
export function gapPtsFor(wilson, type) {
  if (!Number.isFinite(wilson)) return null;
  return (wilson - barFor(type || 'COLOR')) * 100;
}

export function heroVerdictView(gate) {
  if (!gate || !gate.decision) return { decision: 'NONE', targetText: '—', confText: '—', pick: null, reasonText: '' };
  if (gate.decision === GATE_DECISIONS.BET) {
    // Phase 3D: a BET carries its HONEST quality — the below-bar
    // reason (Wilson %, required %, gap) when below bar, the
    // graduated-stake note, and any pattern/trend conflict note —
    // so the hero surface itself says how strong the pick is.
    // Phase 3E: + Chance (raw) / Wilson / signed gap / quality tag /
    // ledger line (design §9 display spec) — all descriptive, none
    // of them gates or blocks the pick.
    const wilson = Number.isFinite(gate.wilsonLowerBound) ? gate.wilsonLowerBound : null;
    const gap = gapPtsFor(wilson, gate.driverType);
    return {
      decision: 'BET',
      targetText: gate.pick || '—',
      confText: gate.prob !== null && gate.prob !== undefined ? Math.round(gate.prob * 100) + '%' : '—',
      pick: gate.pick || null,
      reasonText: gate.qualityReason || '',
      ballDigit: ballKeyFor(gate.pick),
      sampleNote: gate.sampleNote || '',
      conflictNote: gate.conflictNote || '',
      chanceText: Number.isFinite(gate.driverWinRate) ? `Chance ${Math.round(gate.driverWinRate * 100)}% (raw)` : '—',
      wilsonText: wilson !== null ? `Wilson ${(wilson * 100).toFixed(1)}%` : '—',
      gapText: gap !== null ? `Gap ${gap >= 0 ? '+' : ''}${gap.toFixed(1)} pts vs ${(barFor(gate.driverType || 'COLOR') * 100).toFixed(2)}% bar` : '—',
      qualityTag: qualityTagFor(gate),
      // Phase Observer hero line (design §6): one short line naming
      // the followed model + its last-100 Wilson, so the choice is
      // checkable. Only present when the bet driver IS Observer.
      observerLine: gate.observerFollow
        ? `Observer · following ${gate.observerFollow.followedId} · last-100 Wilson ${Number.isFinite(gate.observerFollow.last100Wilson) ? (gate.observerFollow.last100Wilson * 100).toFixed(1) + '%' : '—'} (n=${gate.observerFollow.last100N || 0})`
        : '',
      ledgerLine: gate.ledgerView ? ledgerLineFor(gate.ledgerView.tracked, gate.ledgerView.stake) : ''
    };
  }
  // NO_PICK carries the no-pick note verbatim so the hero surface
  // itself says WHY there is no pick this round. Target shows '—'
  // (never an invented pick, never a SKIP label).
  return { decision: 'NO_PICK', targetText: '—', confText: '—', pick: null, reasonText: gate.reason || '', ballDigit: null, chanceText: '', wilsonText: '', gapText: '', qualityTag: '', ledgerLine: '' };
}

/** Panel text for one hero view (pure, testable). Owner order
 *  2026-10-27 ("No long text needed inside the window"): the panel
 *  shows NO long hero-detail block at all — a BET writes neither
 *  its reason line (below-bar reason + early-data note + conflict
 *  note) nor its detail line (Chance · Wilson · gap · quality tag ·
 *  Observer follow line). The view fields still exist (data layer
 *  + published verdict copies untouched) — only the panel writer
 *  stops displaying them. What stays in the window: NEXT PREDICTION
 *  pick + %, Base, Bet, sequence road, base-bet chips, game-time,
 *  the one short ledger line, and the short exact/trial line. The
 *  NO_PICK reason is KEPT: it is one short honest line explaining
 *  why the panel shows '—', not long text. */
export function heroPanelTextFor(view) {
  if (!view || view.decision === 'BET') return { reason: '', detail: '' };
  return { reason: view.reasonText || '', detail: '' };
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
  let last10Wins = 0, last10Evaluated = 0, sessionWins = 0, sessionEvaluated = 0;
  let streak = 0, bestEvaluated = -1;
  for (const tf of Object.keys(store.data.tf)) {
    const s = store.modelStats(tf, modelId);
    if (!s) continue;
    evaluated += s.evaluated;
    wins += s.wins;
    losses += s.losses;
    recentWins += s.recentWins;
    recentEvaluated += s.recentEvaluated;
    // Merged last10/session are SUMS across timeframes — an
    // approximation in the same class as the merged recent/streak
    // handling (a true merged last-10 would need chronological
    // interleaving, which the per-tf buckets do not store).
    last10Wins += s.last10Wins || 0;
    last10Evaluated += s.last10Evaluated || 0;
    sessionWins += s.sessionWins || 0;
    sessionEvaluated += s.sessionEvaluated || 0;
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
    recentWinRate: recentEvaluated ? recentWins / recentEvaluated : null,
    last10Evaluated, last10Wins,
    last10WinRate: last10Evaluated ? last10Wins / last10Evaluated : null,
    sessionEvaluated, sessionWins,
    sessionWinRate: sessionEvaluated ? sessionWins / sessionEvaluated : null
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
      ? { id: m.id, name: m.name, wins: 0, totalEvaluated: 0, winRate: 0, streak: 0, recentWinRate: null, recentEvaluated: 0, recentWins: 0,
          predType: m.predType || null, cat: m.cat || null,
          last10Wins: 0, last10Evaluated: 0, last10WinRate: null,
          sessionWins: 0, sessionEvaluated: 0, sessionWinRate: null }
      : {
          id: m.id, name: m.name,
          wins: s.wins, totalEvaluated: s.evaluated, winRate: s.winRate,
          streak: s.streak,
          recentWinRate: s.recentWinRate, recentEvaluated: s.recentEvaluated, recentWins: s.recentWins || 0,
          predType: m.predType || null, cat: m.cat || null,
          last10Wins: s.last10Wins || 0, last10Evaluated: s.last10Evaluated || 0,
          last10WinRate: s.last10WinRate !== undefined ? s.last10WinRate : null,
          sessionWins: s.sessionWins || 0, sessionEvaluated: s.sessionEvaluated || 0,
          sessionWinRate: s.sessionWinRate !== undefined ? s.sessionWinRate : null
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

/**
 * Phase 3B transitional calibration migration (owner order 2026-10-27,
 * users complaining about the skip): which tracker gates a round.
 * The Phase 3A per-type split stranded the pooled calibration history
 * (o101_calibration_v1) existing users had already accrued — per-type
 * trackers start at n=0, so every round that passed Wilson then
 * skipped on calibration until 50 fresh per-type settlements accrued
 * (~30–60 min of active 30s play). That wall is a migration artifact,
 * not a bar: the pooled records ARE real recorded (prob, won) evidence
 * from this same app and gate, just without a type label. So until a
 * type's own tracker matures to its bar, the gate uses the pooled
 * tracker; once mature, the per-type tracker takes over permanently.
 * The transition is self-expiring (the per-type tracker keeps
 * recording every settlement) and no bar moves: minSamples 50 and
 * ECE ≤ 0.08 apply to whichever tracker is active. A brand-new user
 * with neither history still honestly skips on calibration until 50
 * real settlements accrue.
 */
export function selectGateTracker({ typeTracker = null, pooledTracker = null } = {}) {
  if (typeTracker && typeof typeTracker.count === 'number'
    && typeof typeTracker.minSamplesForCalibration === 'number'
    && typeTracker.count >= typeTracker.minSamplesForCalibration) return typeTracker;
  return pooledTracker || typeTracker || null;
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
    // Phase 3D: no stop events exist — a loss only ever pushes
    // LADDER_UP (the ladder doubles), a win pushes nothing extra.
    if (!won && nextSession.state === 'CONTINUE') events.push(BOT_EVENTS.LADDER_UP);
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
// calibration tick or a history refresh could flip BIG↔SMALL↔
// NO_PICK mid-round — the owner's "prediction glitch".
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

/**
 * Fix round (RC2) settlement guard (pure, testable): a governed
 * settlement may run only when the settled round has an issued
 * governed record for EXACTLY that period. First sight, no issued
 * pick, or no record for the period → not allowed, and the decision
 * is null (callers must settle nothing, and must not catch up).
 */
export function governedSettlementAllowed({ isFirst = false, lastPick = null, picksByPeriod = null, tf = '', period = '' } = {}) {
  if (isFirst || !lastPick) return { allowed: false, decision: null };
  const rec = picksByPeriod ? picksByPeriod[String(tf) + ':' + String(period)] : null;
  if (!rec) return { allowed: false, decision: null };
  return { allowed: true, decision: rec.decision || null };
}

/**
 * Fix round (no-pick window, owner orders 2026-10-27 ~11:56–11:58 IST):
 * the panel must never sit in NO_PICK for multiple consecutive rounds
 * while models and history exist. When a freshly computed verdict is
 * NO_PICK but the previous verdict for the timeframe was a BET with a
 * pick, HOLD the previous verdict as this round's displayed/staged
 * verdict (marked heldFrom) instead of flashing NO_PICK. The hold is
 * NOT a new pick: it re-shows the last real governed pick, which is
 * what the owner ordered ("predict every round") and what the hero
 * already showed. It applies ONLY while the governed pool and the
 * history are non-empty — a genuinely empty pool still shows NO_PICK
 * honestly. Pure, testable; the cycle wires it (see state.gate below).
 */
export function holdVerdictOnNoPick({ gate = null, prevGate = null, poolSize = 0, historyLen = 0 } = {}) {
  if (!gate || gate.decision !== GATE_DECISIONS.NO_PICK) return { held: false, gate };
  if (!prevGate || prevGate.decision !== GATE_DECISIONS.BET || !prevGate.pick) return { held: false, gate };
  if (!(poolSize > 0) || !(historyLen > 0)) return { held: false, gate };
  return { held: true, gate: { ...prevGate, heldFrom: true } };
}

/**
 * Fix round (settlement-record gap): the period a verdict's pick is
 * FOR, when the native open period is unknown (ball minimized,
 * Analyse tab, game frame not reporting). WinGo issue numbers run
 * sequentially, so the round after the latest settled period is
 * latestPeriod + 1 numerically. Used ONLY as the record key when
 * openPeriodFor() returns null — never to invent a pick, and the
 * settlement guard still requires an exact period match. Null when
 * the period is not numeric.
 */
export function expectedOpenPeriod(latestPeriod) {
  // String arithmetic, NOT Number: real issue numbers (e.g.
  // 20261027100050774) exceed 2^53, so Number() rounds the last digit
  // and +1 lands on the wrong period. Only pure digit strings qualify.
  const s = String(latestPeriod);
  if (!/^\d+$/.test(s)) return null;
  const digits = s.split('');
  let i = digits.length - 1;
  let carry = 1;
  while (i >= 0 && carry) {
    const d = Number(digits[i]) + carry;
    digits[i] = String(d % 10);
    carry = d >= 10 ? 1 : 0;
    i -= 1;
  }
  if (carry) digits.unshift('1');
  return digits.join('');
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
  // Phase 3D: no SKIP, no stop events exist anymore — the spoken
  // set is BET, WIN, LOSS, LADDER_UP, MISSED_BET, LOGIN_VERIFIED.
  WIN: 'celebrate',
  LOSS: 'sad',
  LADDER_UP: 'thinking',
  MISSED_BET: 'sad',
  LOGIN_VERIFIED: 'wink'
};

/**
 * Minimal verdict icons: SVG/CSS shapes only, NEVER emoji. Big/Small
 * are arrows, colours are dots. Icons are visual only — they are
 * never part of a spoken string.
 */
export const VERDICT_ICONS = {
  big: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 L20 15 H4 Z" fill="#fbbf24"/></svg>',
  small: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20 L4 9 H20 Z" fill="#38bdf8"/></svg>',
  green: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="#34d399"/></svg>',
  red: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="#fb7185"/></svg>',
  violet: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="#a78bfa"/></svg>'
};

/** Icon kind + SVG for one governed verdict (pick domain: BIG, SMALL, GREEN, RED, VIOLET). */
export function verdictIconFor(pick, decision) {
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
 * (Big/Small) or the colour (Red/Green/Violet). Anything else (no
 * verdict, unknown pick) yields '' so the badge shows nothing —
 * never a stale or invented prediction.
 */
export function predictionBadgeText(pick, decision) {
  if (decision !== 'BET') return '';
  const p = String(pick || '').toUpperCase();
  if (p === 'BIG') return 'Big';
  if (p === 'SMALL') return 'Small';
  if (p === 'GREEN') return 'Green';
  if (p === 'RED') return 'Red';
  if (p === 'VIOLET') return 'Violet';
  return '';
}

/** Badge text for one hero-view render (BET/NONE). */
export function badgeFromView(view) {
  if (!view) return '';
  if (view.decision === 'BET') return predictionBadgeText(view.pick, 'BET');
  return '';
}

/** { face, spoken } for a bot event — null/false off the table. */
export function axoEventEffects(event) {
  const face = AXO_SPOKEN_FACES[event] || null;
  return { face, spoken: !!face };
}

/** Axo Chat celebration bounce (owner order 2026-10-25, Task B):
 *  the axo-ai repo's axo-bounce keyframes, ported verbatim as
 *  o101-axo-bounce in mobile.css, celebrate the governed WIN and
 *  LOGIN_VERIFIED moments on the ball. Display-only: never a
 *  verdict, stake, or gate input. axo-ai uses the bounce for
 *  typing dots; the ball has no typing phase, so the motion
 *  itself is the port, applied as a short hop on the face image.
 *  Faces stay the real 14 frames — axo-ai's robot-emoji default
 *  glyph is a configurable placeholder, not character art, and
 *  never replaces a frame. */
export const AXO_BOUNCE_EVENTS = new Set([BOT_EVENTS.WIN, BOT_EVENTS.LOGIN_VERIFIED]);
export function axoBounceForEvent(event) {
  return AXO_BOUNCE_EVENTS.has(event);
}

/* Task P (owner order 2026-10-26, "win loss animation from
 * above — fix it"): the LOSS counterpart the face never had.
 * WIN hops (o101-axo-bounce); LOSS droops (o101-axo-loss, the
 * existing lossSadShrinkHeadDown keyframes) on the same visible
 * face IMAGE only, same reduced-motion rule. STOP_LOSS is a
 * session summary, not a settled loss — it keeps the static sad
 * face and never droops. Display-only, like the bounce. */
export const AXO_DROOP_EVENTS = new Set([BOT_EVENTS.LOSS]);
export function axoDroopForEvent(event) {
  return AXO_DROOP_EVENTS.has(event);
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
 * once per (tf, period) key. A NO_PICK can never fire it: the
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
// 2. NO LOGIN GATE. The display verdict is the governed engine
//    verdict — login state is not an input at all, so it can never
//    change what is shown or staged. Phase 3B: the base bet
//    resolves from the user-selected chip (default ₹2), never from a
//    synced balance; a verified balance only ever sizes an explicit
//    AUTO opt-in and is never a precondition.
// 3. SUBTITLE SURFACES. Owner order 2026-10-25 (UI batch, reverses
//    fix round #5's deletion): the subtitle is an OUTSIDE FLOATING
//    bubble next to the avatar whenever a subtitle exists —
//    speaking or panel opened. Minimized state still shows the
//    prediction inside the Axo ball; voice follows its own switch,
//    not the subtitle element.
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
 * The base bet the governed ladder should run. Phase 3B balance
 * decoupling (owner order 2026-10-27: "remove the balance sync, just
 * give stake from user selected base"): the default base is the
 * USER-SELECTED chip, and when no chip value is known it defaults to
 * ₹2 (the chip shown selected in the owner's screenshot) — never
 * null, never balance-derived. AUTO is an explicit opt-in that sizes
 * from a verified balance when one exists and falls back to the chip
 * otherwise; it is never a precondition for a session or a stake.
 * The old "null = no base knowable" outcome no longer exists.
 */
export const DEFAULT_CHIP_BASE = 2;
export function resolveBaseBet({ autoBase = false, verifiedBalance = null, riskMode = 'balanced', chipBase = null } = {}) {
  const chip = Number(chipBase);
  const chipOk = Number.isFinite(chip) && chip > 0 ? Math.floor(chip) : DEFAULT_CHIP_BASE;
  if (autoBase) {
    if (verifiedBalance !== null && verifiedBalance !== undefined) return autoBaseBet(verifiedBalance, riskMode);
    return chipOk;
  }
  return chipOk;
}

/**
 * No-skip mode (owner order 2026-10-25, UI batch). Pure layer.
 * A gate SKIP is convertible ONLY when its family is 'edge'
 * (calibrated chance below the bar) — the one confidence verdict.
 * Wilson, floor, disagreement, calibration, noprob, nopick,
 * conflict and hard-stop SKIPs are guards, never convertible, and
 * the conversion never touches bankroll guards: staging still
 * refuses STOP/STOP_LOSS/STOP_WIN/LADDER_EXHAUSTED sessions and
 * non-positive stakes, and firing still needs the per-bet tap.
 * The converted verdict is marked forced everywhere it displays.
 *
 * DORMANT (Phase 2A, owner correction 2): the owner removed the
 * NO-SKIP button — the chip, its badge, and the #axoNoSkipPopup are
 * gone from the panel, the cycle no longer calls applyNoSkip, and
 * the hero no longer shows no-skip wording. These helpers stay in
 * code, unreferenced by any live path, so the removal is reversible;
 * the automatic skip cap (above) is now the skip handling. Do NOT
 * re-wire these without a fresh owner order.
 */
export const NO_SKIP_WARNING_TEXT = 'No-skip mode bets rounds the engine would skip for low confidence. Expect more losses — this does not improve the edge, it only bets more often. Bankroll guards (stop-loss, stop-win, ladder limits, Wilson check) still apply, and every bet still needs your tap.';

export function noSkipConvertible(gate) {
  return !!gate && gate.decision === GATE_DECISIONS.SKIP && gate.skipKind === 'edge';
}

export function applyNoSkip(gate, { enabled = false, pick = null } = {}) {
  if (!enabled || !noSkipConvertible(gate) || !pick) return gate;
  const factor = gate.sampleFactor ?? 1;
  const earlyNote = factor < 1
    ? ` Early-data stake: ${factor}× base (${Math.floor(gate.sampleSize || 0)} evaluated rounds; full stake at 200).`
    : '';
  return {
    ...gate,
    decision: GATE_DECISIONS.BET,
    pick,
    forced: true,
    reason: `No-skip forced pick: ${pick} — ${gate.reason} (No-skip mode: this bets a round the engine would skip for low confidence.)`,
    sampleNote: `${earlyNote} No-skip forced pick.`.trim()
  };
}

/**
 * Phase 2A (2026-10-26) — governed-pool split, skip cap, subtitle
 * routing, system notifications, closed-orb stake badge, thin-pool
 * flag. Pure helpers, unit-tested in tests/fix_round_phase2a.test.js.
 * NO threshold changes: every locked bar (51.02% breakeven, +2%
 * margin, Wilson bar, floor 20, tiers, streak 5+, ECE 0.08, ±20%
 * stops, ladder, per-bet tap) is untouched by this round.
 */

// ── Governed pool: the 99 (Phase 3A, owner order 2026-10-26) ────────
// 33 colour + 33 size + 33 exact-ball, equal by construction. Per
// (family, type) cap 3 in catalog order; the first 3 families in
// catalog first-appearance order (fly, neural, classical) get a 4th
// slot per type: 4×3 + 3×7 = 33 per type. ASI + ASI_APEX_MASTER take
// slot 1 within their (family, type) — without priority,
// ASI_APEX_MASTER (4th meta SIZE in catalog order) would be cut, and
// meta COLOR would need its gap filled. Cut models are DISPLAY-ONLY
// spares (reversible, never deleted): 38 = 13 colour + 25 size +
// 0 exact-ball (all 33 exact-ball models are governed).
// One function serves both catalog-level counts and pool splits:
// pool entries carry id/cat/predType in catalog order via
// buildPoolFromStore, so the same logic applies to both.
// LEGACY: DISPLAY_ONLY_MODEL_IDS / isDisplayOnlyModel stay exported
// for old tests but NO live path gates on them anymore — ASI is
// governed in Phase 3A (trial-gated for bets, see signalGate.js).
export const DISPLAY_ONLY_MODEL_IDS = ['ASI', 'ASI_APEX_MASTER'];
export const GOVERNED_ASI_IDS = ['ASI', 'ASI_APEX_MASTER'];

export function isDisplayOnlyModel(modelOrId) {
  const id = typeof modelOrId === 'string' ? modelOrId : (modelOrId && modelOrId.id);
  return DISPLAY_ONLY_MODEL_IDS.includes(id);
}

export function selectGoverned(entries) {
  // Phase 3D (owner order "make the display-only models rank and
  // bet too"): NO slot cap anymore — every catalog model ranks and
  // is bet-eligible under the same gate (137, not 99). The function
  // stays as the membership hook (callers + tests), now the identity
  // over catalog order; ASI/APEX keep no slot privilege because
  // there are no slots left to privilege.
  return (entries || []).slice();
}

export function splitGovernedPool(pool) {
  const governed = selectGoverned(pool);
  return { governed, displayOnly: [] };
}

// ── Subtitle routing (owner correction 5)
// VERDICT lines (BET, WIN, LOSS, ladder steps, missed bets)
// keep the EXISTING bubble: sticky,
// X dismisses only the current line, next say() re-shows. SYSTEM /
// STATUS lines (login/bridge status, Auto-Pilot on/off/refused/fired
// notes) show as a MINIMAL notification
// above the Axo/ball area that AUTO-CLOSES after
// SYSTEM_NOTIFICATION_MS. Voice is unchanged: voice still speaks
// exactly the subtitle string even when the visual is an auto-closing
// notification — auto-close is visual only. The routing is by event
// for speakEvent lines and by explicit kind at direct say() sites;
// the default is 'verdict', so any unmarked line keeps the old bubble
// behavior. Phase 3B: greeting, balance and model-change events no
// longer route here at all — those announcements are deleted, not
// re-routed (LOGIN_VERIFIED stays: short, login-only, functional).
export const SYSTEM_NOTIFICATION_MS = 4000;
export const SYSTEM_SUBTITLE_EVENTS = new Set([
  BOT_EVENTS.LOGIN_VERIFIED
]);

export function subtitleKindForEvent(event) {
  return SYSTEM_SUBTITLE_EVENTS.has(event) ? 'system' : 'verdict';
}

export function resolveSubtitleTarget(kind) {
  return kind === 'system' ? 'notification' : 'bubble';
}

/**
 * Notification geometry: above the Axo anchor; if the subtitle bubble
 * is itself above the anchor, stack the notification above the
 * bubble instead of overlapping it. Viewport-clamped, 8px margins.
 */
export function systemNotificationGeometry({ anchor = null, vw = 0, vh = 0, nw = 0, nh = 0, bubbleRect = null } = {}) {
  let top;
  if (anchor) {
    top = anchor.top - 8 - nh;
    if (bubbleRect && bubbleRect.bottom <= anchor.top) top = Math.min(top, bubbleRect.top - 8 - nh);
  } else {
    top = 8;
  }
  if (top < 8) top = 8;
  if (top + nh > vh - 8) top = Math.max(8, vh - 8 - nh);
  let left = anchor ? anchor.left + (anchor.width - nw) / 2 : (vw - nw) / 2;
  if (left < 8) left = 8;
  if (left + nw > vw - 8) left = Math.max(8, vw - 8 - nw);
  return { left: Math.round(left), top: Math.round(top) };
}

// ── Thin pool (display only, NOT a gate) ────────────────────────────
export const THIN_POOL_MIN = 10;

// ── Closed-orb stake badge (owner correction 4) ─────────────────────
// The closed orb's pill shows the governed stake alongside the
// prediction on BET verdicts and '—' otherwise, so the badge never
// invites betting a round with no pick. The stake figure is
// formatted exactly like the
// hero's Bet figure ('₹' + en-IN grouping, whole rupees) and comes
// from the same source (state.session.nextStake) — no new math.
/** Stake figure formatter (owner order 2026-10-30 "never show bet
 *  less than 1"): whole ₹, ceiled, never below ₹1. Pure. Balances
 *  and P&L keep their own honest formatters — this is stakes only. */
export function inrStake(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '₹1';
  return '₹' + Math.ceil(v).toLocaleString('en-IN');
}
export function closedOrbPill({ decision = null, pick = null, stake = null, wilson = null } = {}) {
  // Phase 3D: no SKIP pill, no HELD pill — a BET shows pick · stake
  // (the governed session's nextStake, never invented); anything
  // else shows '—'.
  // Phase 3E (design §9): the closed pill is pick · Wilson% · stake —
  // Wilson, the conservative chance, is the pill number; the raw
  // Chance lives in the hero detail. Wilson absent -> old pick ·
  // stake form (backward compatible for callers without a pool entry).
  if (decision === GATE_DECISIONS.BET && pick) {
    if (stake !== null && stake !== undefined && Number.isFinite(Number(stake)) && Number(stake) > 0) {
      const stakeText = inrStake(stake);
      const text = Number.isFinite(wilson)
        ? `${pick} · ${(wilson * 100).toFixed(1)}% · ${stakeText}`
        : `${pick} · ${stakeText}`;
      return { text, state: 'bet', ballDigit: ballKeyFor(pick) };
    }
    return { text: pick, state: 'bet', ballDigit: ballKeyFor(pick) };
  }
  return { text: '—', state: 'none', ballDigit: null };
}

/**
 * Task L (owner screenshot 2026-10-26): which avatar the subtitle
 * bubble anchors to. The panel-open anchor used to be ONLY the
 * top-center avatar — but the header face is the visible Axo
 * whenever the open morph's avatar swap did not run (stale script
 * or another open path), so the bubble hid behind the
 * hidden-anchor guard and NO subtitle showed at all, even with CC
 * on and a spoken verdict line. The chain now falls through to the
 * next VISIBLE avatar: top-center avatar → header face → orb →
 * none (bubble stays hidden only when no Axo is visible at all).
 */
export function axoBubbleAnchorChoice({ panelOpen = false, topVisible = false, faceVisible = false, orbVisible = false } = {}) {
  if (panelOpen) {
    if (topVisible) return 'top';
    if (faceVisible) return 'face';
    if (orbVisible) return 'orb';
    return null;
  }
  return orbVisible ? 'orb' : null;
}

/**
 * Task L: plain wording for the reason line when NO-SKIP is ON but
 * the verdict is a SKIP no-skip cannot convert. Display only — it
 * never changes the locked verdict or the conversion scope.
 */
export function noSkipBlockedNote(skipKind, hasPick = true) {
  const tail = 'No-skip only converts low-confidence edge skips.';
  if (!hasPick) return `No-skip is ON but this round has no leader pick to force. ${tail}`;
  switch (skipKind) {
    case 'floor': return `No-skip is ON but cannot convert this skip — too few rounds to rank (needs 20). ${tail}`;
    case 'wilson': return `No-skip is ON but cannot convert this skip — the Wilson bound is below the bar. ${tail}`;
    case 'hardstop': return `No-skip is ON but cannot convert this skip — the 3-loss stop blocks all picks. ${tail}`;
    default: return `No-skip is ON but cannot convert this kind of skip. ${tail}`;
  }
}

/**
 * Task L: confirm-slot height from its buttons' visibility — 34px
 * when a button shows, 0px when both are hidden. Pure so the
 * collapse rule is testable; the DOM sync below applies it.
 */
export function confirmSlotHeight({ confirmHidden = true, rearmHidden = true } = {}) {
  return (!confirmHidden || !rearmHidden) ? 34 : 0;
}

/**
 * Task L: true sheet content height from measured parts (header +
 * control row + the body's full scroll height + the sheet border).
 * The Task K budget counted a 33px header; the real header carries
 * the 64px face, so it is ~77px — that 44px miss plus the reserved
 * slot is why the chip row clipped under the 380px cap.
 */
export function sheetContentHeight({ headerH = 0, controlsH = 0, bodyScrollH = 0, border = 2 } = {}) {
  return Math.ceil(headerH + controlsH + bodyScrollH + border);
}

/**
 * Task L: grow-only sheet fit. Returns the new height when measured
 * content exceeds the current sheet height, capped by the viewport
 * (never below the 220px drag floor); null when no growth is
 * needed, so callers never shrink a user's size and never loop.
 */
export function fitSheetHeight({ need = 0, current = 0, vh = 0 } = {}) {
  if (need <= current) return null;
  const cap = Math.max(220, (Number(vh) || 0) - 24);
  const target = Math.min(need, cap);
  return target > current ? target : null;
}

/**
 * Task N (owner order 2026-10-26, "resizable to any size and all be
 * visible"): compaction tiers. The Task K fixed 340px content floor
 * is REMOVED — it blocked shrinking below 340 even though the
 * content can compact far below it. Instead the sheet compacts in
 * tiers (CSS rules in mobile.css, keyed on the sheet's
 * data-axo-compact attribute) and the settle pass measures at the
 * applied tier, so the settled size is the MEASURED compacted need
 * — never a guessed floor, never a clip. Tiers only tighten
 * padding, gaps, and sizes (see the CSS); no tier hides a section,
 * truncates a reason, or drops a control. Savings below are the
 * documented per-tier totals, measured from the markup:
 * - tier 1 (−13): body padding 16→8 (−8) + body gaps 4→3px × 5 (−5).
 * - tier 2 (−29): + hero padding 16→8 (−8) + road padding 8→4 (−4)
 *   + control row 27→23 (−4).
 * - tier 3 (−52): + body gaps 3→2px × 5 (−5) + hero verdict text
 *   28→24 line (−4) + road beads 20→18 (−2) + pills/chips padding
 *   8→4 each (−8) + base top padding 2→0 (−2) + reason bottom
 *   padding 2→0 (−2).
 * The 64px header face is NEVER shrunk (it is Axo's identity and
 * the drag handle) and the reason text is NEVER truncated. Runtime
 * measurement is authoritative: these numbers pick the tier, and
 * fitSheetToContent measures at the tier and grows if still short.
 * Live-drag bands (absolute heights, no measurement — the settle
 * pass corrects them): ≥340 → 0, ≥300 → 1, ≥265 → 2, else 3.
 * Narrow flag: sheet width < 240px tightens control-row padding
 * and gaps only (never a font below readable, never a wrap that
 * would add a row). Smallest fully-visible default content
 * (tier-0 359px, Task L baseline) is 359 − 52 = 307px; with a staged
 * confirm slot (+34) it is 341px. Below that, or on a viewport
 * shorter than need + 24, full visibility is physically
 * impossible — the sheet keeps the most compact layout there and
 * the settle rule caps at the viewport instead of clipping by
 * choice (see axoSettledHeight).
 */
export const AXO_COMPACT_SAVINGS = [0, 13, 29, 52];
export const AXO_COMPACT_BANDS = [340, 300, 265];
export const AXO_NARROW_WIDTH = 240;

export function axoCompactedHeight({ fullH = 0, level = 0 } = {}) {
  const lv = Math.min(3, Math.max(0, Math.floor(Number(level)) || 0));
  return Math.max(0, (Number(fullH) || 0) - AXO_COMPACT_SAVINGS[lv]);
}

export function axoCompactLevelFor({ sheetH = 0, fullH = 0 } = {}) {
  const h = Number(sheetH) || 0;
  const full = Number(fullH) || 0;
  for (let level = 0; level <= 3; level += 1) {
    if (axoCompactedHeight({ fullH: full, level }) <= h) return level;
  }
  return 3;
}

export function axoCompactBandFor({ height = 0 } = {}) {
  const h = Number(height) || 0;
  if (h >= AXO_COMPACT_BANDS[0]) return 0;
  if (h >= AXO_COMPACT_BANDS[1]) return 1;
  if (h >= AXO_COMPACT_BANDS[2]) return 2;
  return 3;
}

export function axoNarrowFor({ width = 0 } = {}) {
  return (Number(width) || 0) < AXO_NARROW_WIDTH;
}

/**
 * Task N settle rule (pure): the settled height is the largest of
 * the wanted height, the measured compacted need, and the 220px
 * absolute drag floor — capped by the viewport (vh − 24, never
 * below 220). When the returned height is below needH, the content
 * physically cannot fit even compacted (viewport too short); the
 * caller keeps the most compact layout at the cap and must not
 * pretend otherwise. This never shrinks a user's size by choice:
 * wantH is always honored unless the measured need exceeds it.
 */
export function axoSettledHeight({ wantH = 0, needH = 0, vh = 0 } = {}) {
  const cap = Math.max(220, (Number(vh) || 0) - 24);
  return Math.min(cap, Math.max(220, Number(wantH) || 0, Number(needH) || 0));
}

/**
 * Task J (owner need 2026-10-25, swarm binding constraint): one-tap
 * history export — PURE builder. Secrets are excluded BY
 * CONSTRUCTION: the output is built field-by-field from an
 * allowlist below. No state object is ever spread, so no token,
 * key, cookie, session identifier, balance, UPI detail, or personal
 * data can leak into the file — rounds and model stats only.
 * - rounds: settled rounds only (gap rows and number-less rows
 *   dropped), deep history merged under live history, deduped by
 *   tf:period with live winning. Governed pick/outcome ride on the
 *   session's dispositions where one exists (dispositions are
 *   session-scoped, so older rounds carry result only — honest,
 *   never backfilled). outcome is 'none' on SKIP rounds (no pick)
 *   and null when the pick cannot be evaluated.
 * - settledPnl: set ONLY for fired bets, derived with the governed
 *   0.96 payout exactly as settleFired computes it (win: stake ×
 *   0.96, loss: −stake), from the recorded fired stake and the
 *   fired target's outcome. Unfired rounds carry null, never 0.
 * - models: one row per (timeframe, model) so per-scope stats are
 *   never lossily merged; Wilson bound from the real wins/evaluated.
 */
export function buildHistoryExport({ liveByTf = {}, deepByTf = {}, dispositions = {}, fired = {}, modelsByTf = {}, calibration = null, evaluateWin = null } = {}) {
  const r2 = v => Math.round(Number(v) * 100) / 100;
  const settled = r => r && !r.gap && r.number !== null && r.number !== undefined;
  const byKey = new Map();
  for (const [tf, list] of Object.entries(deepByTf)) {
    for (const r of (Array.isArray(list) ? list : [])) {
      if (settled(r)) byKey.set(`${tf}:${String(r.period)}`, { tf, round: r });
    }
  }
  for (const [tf, list] of Object.entries(liveByTf)) {
    for (const r of (Array.isArray(list) ? list : [])) {
      if (settled(r)) byKey.set(`${tf}:${String(r.period)}`, { tf, round: r });
    }
  }
  const rounds = [...byKey.values()].map(({ tf, round }) => {
    const key = `${tf}:${String(round.period)}`;
    const disp = dispositions[key] || null;
    const governedDecision = disp ? (disp.decision || null) : null;
    const governedPick = governedDecision === 'BET' ? (disp.pick ?? null) : null;
    const wonGov = (governedPick && typeof evaluateWin === 'function')
      ? evaluateWin(governedPick, round.number, round.size, round.color) : null;
    const outcome = governedPick === null ? 'none'
      : (wonGov === null || wonGov === undefined ? null : (wonGov ? 'win' : 'loss'));
    const frec = fired[key] || null;
    const stake = frec ? Number(frec.stake) : NaN;
    const firedWon = (frec && typeof evaluateWin === 'function')
      ? evaluateWin(frec.target, round.number, round.size, round.color) : null;
    const settledPnl = (frec && Number.isFinite(stake) && firedWon !== null && firedWon !== undefined)
      ? (firedWon ? r2(stake * 0.96) : -stake) : null;
    return {
      tf,
      period: String(round.period),
      number: Number(round.number),
      size: round.size ?? null,
      color: round.color ?? null,
      governedDecision,
      governedPick,
      outcome,
      fired: !!frec,
      firedStake: Number.isFinite(stake) ? stake : null,
      settledPnl
    };
  });
  rounds.sort((a, b) => (a.tf < b.tf ? -1 : a.tf > b.tf ? 1 : (a.period < b.period ? -1 : a.period > b.period ? 1 : 0)));
  const models = [];
  for (const [tf, list] of Object.entries(modelsByTf)) {
    for (const m of (Array.isArray(list) ? list : [])) {
      const evaluated = Number(m.totalEvaluated ?? m.evaluated ?? 0) || 0;
      const wins = Number(m.wins ?? 0) || 0;
      models.push({
        tf,
        id: m.id ?? null,
        name: m.name ?? null,
        evaluated,
        wins,
        winRate: evaluated > 0 ? wins / evaluated : null,
        wilsonLowerBound: wilsonLowerBound(wins, evaluated)
      });
    }
  }
  return {
    app: '01.01',
    exportedAt: new Date().toISOString(),
    timeframes: [...new Set([...Object.keys(liveByTf), ...Object.keys(deepByTf)])].sort(),
    roundCount: rounds.length,
    rounds,
    models,
    calibration: calibration ? { count: calibration.count ?? null, ece: calibration.ece ?? null } : null,
    notes: 'Rounds + model stats only. No tokens, keys, cookies, session identifiers, balances, UPI details, or personal data are included. outcome is none on SKIP rounds (no pick). settledPnl is set only for fired bets, derived with the governed 0.96 payout (win: stake x 0.96, loss: -stake).'
  };
}

/**
 * Where the outside floating subtitle bubble sits, relative to the
 * visible avatar (owner reference screenshot: bubble LEFT of the
 * avatar, vertically centered on it). Falls back to above, then
 * below, then a dock-clear bottom-right slot when no anchor exists.
 * All positions are clamped into the viewport. Pure + tested.
 */
export function axoBubbleGeometry({ anchor = null, vw = 0, vh = 0, bw = 280, bh = 60, gap = 10, margin = 8, overhang = 16 } = {}) {
  const w = Math.max(1, Number(bw) || 280);
  const h = Math.max(1, Number(bh) || 60);
  const oh = Number.isFinite(Number(overhang)) && Number(overhang) >= 0 ? Number(overhang) : 16;
  const maxLeft = Math.max(margin, (Number(vw) || 0) - w - margin - oh);
  const maxTop = Math.max(margin, (Number(vh) || 0) - h - margin);
  const clamp = (v, max) => Math.max(margin, Math.min(max, Math.round(v)));
  // Top clamp keeps the corner-centred 32px X fully on-screen: the X
  // extends `overhang` above and right of the bubble box, so a bubble
  // top at `margin` left the X's top quarter off-screen (owner order
  // 2026-10-27, "caption off and on is hard": the bubble sits at the
  // very top of the screen on his phone). The right edge keeps the
  // same clearance via maxLeft.
  const clampTop = (v, max) => Math.max(margin + oh, Math.min(max, Math.round(v)));
  if (anchor && Number.isFinite(Number(anchor.left)) && Number.isFinite(Number(anchor.top))) {
    const a = anchor;
    if (a.left - gap - w >= margin) {
      return { left: clamp(a.left - gap - w, maxLeft), top: clampTop(a.top + ((Number(a.height) || 0) - h) / 2, maxTop) };
    }
    if (a.top - gap - h >= margin) {
      return { left: clamp(a.left + ((Number(a.width) || 0) - w) / 2, maxLeft), top: clampTop(a.top - gap - h, maxTop) };
    }
    return { left: clamp(a.left + ((Number(a.width) || 0) - w) / 2, maxLeft), top: clampTop(a.top + (Number(a.height) || 0) + gap, maxTop) };
  }
  return { left: clamp(vw - w - 16, maxLeft), top: clampTop(vh - h - 100, maxTop) };
}

/**
 * Axo panel size on open (owner order 2026-10-25, UI batch).
 * The panel opens SMALL by default (its own authored compact
 * 270×380); a saved drag/preset size is honored exactly — the old
 * open path forced minimums of 360×480, so a smaller saved size
 * was silently discarded on every reopen. Saved values are
 * validated (finite, positive) and clamped to the viewport.
 *
 * Task K (owner order 2026-10-25): the panel body is exactly four
 * sections with NO vertical scroll, so the sheet must never shrink
 * below its content. AXO_PANEL_MIN_SIZE (200×220) stays the ABSOLUTE
 * floor — it is what the resize handles and the tiny-viewport path
 * bottom out at — but at normal viewports the effective floor is
 * the CONTENT floor: 340px, softening to (vh − 64) on short
 * viewports so the sheet still fits inside the viewport (50px top
 * clearance for the straddling avatar + 14px bottom margin). The
 * short-viewport tightening in mobile.css covers the residual gap
 * between the softened floor and the tightened content.
 * Task N (owner order 2026-10-26, "resizable to any size and all be
 * visible"): the Task K fixed 340px content floor is REMOVED — it
 * blocked shrinking below 340 even though compaction carries the
 * same content down to ~307px (default) at tier 3. The resolver
 * now floors only at the ABSOLUTE drag floor (200×220) so a saved
 * compact size restores exactly; the post-open compact fit
 * (fitSheetToContent: tier by measurement, then grow to measured
 * compacted need) guarantees no section clips, and a size below
 * the compacted need settles at that need instead of clipping.
 * The old 340px floor constant and floor function are deleted
 * with this change (no other importer existed); the 340 number
 * survives only in the compact preset's height (230×340), which
 * still resolves exactly.
 * Published for the classic script (mobile.js cannot import this
 * module) with an inline fallback there.
 */
export const AXO_PANEL_DEFAULT_SIZE = { width: 270, height: 380 };
export const AXO_PANEL_MIN_SIZE = { width: 200, height: 220 };
export const AXO_PANEL_SIZE_KEY = 'dhaniwin_assistant_box_size';

export function resolveAxoPanelSize({ saved = null, vw = 0, vh = 0 } = {}) {
  const maxW = Math.max(AXO_PANEL_MIN_SIZE.width, (Number(vw) || 0) - 16);
  const maxH = Math.max(AXO_PANEL_MIN_SIZE.height, (Number(vh) || 0) - 60);
  const num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null);
  const w = num(saved && saved.width);
  const h = num(saved && saved.height);
  return {
    width: Math.min(maxW, Math.max(AXO_PANEL_MIN_SIZE.width, w ?? AXO_PANEL_DEFAULT_SIZE.width)),
    // Task N: absolute floor only (220). A saved compact size
    // restores exactly; the post-open compact fit grows to the
    // measured compacted need when content would otherwise clip.
    height: Math.min(maxH, Math.max(AXO_PANEL_MIN_SIZE.height, h ?? AXO_PANEL_DEFAULT_SIZE.height))
  };
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
 * Which prediction surfaces show, from CC + panel state + subtitle.
 * Owner order 2026-10-25 (REVERSES fix round #5's deletion): the
 * subtitle is an OUTSIDE FLOATING bubble next to the avatar whenever
 * a subtitle exists — AI speaking AND panel opened. The in-panel
 * sheet line is still written (state) but never displayed while the
 * bubble ships, so the same text never appears twice. The ball's
 * pick pill is independent of CC, as before.
 */
export function bubbleVisible({ subsOn = true, text = '', dismissedText = '' } = {}) {
  if (!subsOn) return false;
  const t = typeof text === 'string' ? text : '';
  if (!t) return false;
  return dismissedText !== t;
}

/** Whether a say() clears a previous bubble dismissal (pure).
 *  Subtitle-X fix (owner order 2026-10-27, "the subtitle button is
 *  not clickable"): the X closes the CURRENT line — and a textually
 *  identical re-say IS the same line. The signal line repeats every
 *  round while pick/stake/level hold (the gate key changes per
 *  period), so clearing on EVERY say() resurrected the bubble ≤30s
 *  after the user tapped X — the tap looked dead. Only a DIFFERENT
 *  line clears the dismissal and re-shows. This supersedes the Phase
 *  2A "same-text re-say must re-show" rule for immediate repeats; a
 *  same-text line after an intervening DIFFERENT line still re-shows,
 *  because that line already cleared the dismissal. */
export function shouldClearBubbleDismissal({ text = '', dismissedText = '' } = {}) {
  return !!text && text !== dismissedText;
}

/**
 * What a subtitles toggle does to a per-line bubble dismissal (pure).
 * Owner order 2026-10-27 ("caption off and on is hard"): X-dismissing
 * a line, then toggling CC off and back on, left the bubble hidden —
 * the dismissal outlived the toggle, so "on" looked dead. CC-on
 * means "show subtitles again", so it clears the per-line dismissal
 * and the current line re-shows. CC-off keeps the dismissal (the X's
 * effect is not a setting; a later different line still clears it
 * via shouldClearBubbleDismissal). The X itself is untouched: it
 * still closes only the current line.
 */
export function dismissalAfterSubsToggle({ on = true, dismissedText = '' } = {}) {
  return on ? '' : dismissedText;
}

/** One page of a list (pure, testable). Analyse pagination (owner
 *  order 2026-10-27, corrected 12:56 IST): NO "See all" — < > step
 *  through pages of 10. Page clamps into range (never an empty page,
 *  never past the ends); the union of all pages is exactly the input
 *  list, in order, with no gaps or duplicates. */
export function paginatePage(items, page, pageSize) {
  const list = Array.isArray(items) ? items : [];
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 10;
  const totalPages = Math.max(1, Math.ceil(list.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const offset = (p - 1) * size;
  return { page: p, totalPages, offset, rows: list.slice(offset, offset + size) };
}

export function subtitleSurfaces({ subsOn = true, panelOpen = false, text = '', dismissedText = '' } = {}) {
  const vis = bubbleVisible({ subsOn, text, dismissedText });
  return {
    bubbleVisible: vis,
    floatingVisible: vis,
    sheetHidden: true,
    pillVisible: !panelOpen
  };
}

/** Pull-to-refresh visual math (owner order 2026-10-25, Task C):
 *  pure + tested. A downward pull maps to a spinner offset with
 *  0.5 resistance (capped at 56px) and full opacity at the cap;
 *  the refresh itself triggers at the raw pull threshold. The
 *  classic script (mobile.js) consumes this via window.__o101PullVisual
 *  with an inline fallback when the module is absent. */
export const PULL_REFRESH_THRESHOLD = 64;
export function pullRefreshVisual(dy, threshold = PULL_REFRESH_THRESHOLD) {
  const pull = Math.max(0, Number(dy) || 0);
  const offset = Math.min(pull * 0.5, 56);
  return {
    offset,
    opacity: Math.min(1, offset / 56),
    shouldRefresh: pull >= (Number(threshold) || PULL_REFRESH_THRESHOLD)
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
// + 6px gap + the 32px prediction ball below the face (ball bottom
// = container top + 103) + 3px margin = 106px tall. The under-bar
// is retired (ball-only) — the footprint is ring + ball, not ring
// + under-bar.
export const AXO_ORB_WIDTH = 68;
export const AXO_ORB_HEIGHT = 106;

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
  // Phase 3D: only a BET shows a pick; anything else shows '—'
  // (no SKIP view, no HELD view — both deleted).
  if (verdict === 'BET' && pick) return { pickText: pick, periodText: period ? `#${shortPeriod(period)}` : '', state: 'bet' };
  return { pickText: '—', periodText: period ? `#${shortPeriod(period)}` : '', state: 'none' };
}

// ─────────────────────────────────────────────────────────────────────
// Trend / pattern conflict detection (pure, testable)
// ─────────────────────────────────────────────────────────────────────
// Learning signals may strengthen a pick (the pattern hit-rate blend
// in InchargeEngine.scoreModel) but they may never SILENTLY override
// it. When a proven pattern (≥20 persisted firings, hit-rate clearly
// above the 51.02% breakeven) fires AGAINST the leader's pick, or a
// strong trend (≥5 in a row) runs against it, the governed answer
// NOTES the conflict on the verdict (never a skip).
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
      reason: `Pattern ${patternFiring.name || patternFiring.patternId} is firing ${patternFiring.prediction} against the leader's ${pick} (${Math.round(patternFiring.hitRate * 100)}% over ${patternFiring.fired} firings) — pick shown with this conflict noted.`
    };
  }
  if (trend && trend.type && trend.type !== pick && trend.length >= TREND_CONFLICT_MIN_STREAK) {
    return {
      kind: 'trend',
      reason: `Trend conflict: ${trend.length} ${trend.type} in a row against the leader's ${pick} — pick shown with this conflict noted.`
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
  // Phase 3A fix (owner add-on A): a mid-ladder replan (chip change,
  // AUTO recompute, risk-mode change) used to reset the ladder rung
  // — the spread carried consecutiveLosses/sessionPnL/rounds but NOT
  // level, so nextStake fell back to the fresh base and a loss's
  // doubling was silently forgotten. Carry the level when the
  // previous session was still active (CONTINUE/RESET) and recompute
  // nextStake = newBase × 2^level. Phase 3D corrected ladder: the
  // carried level is NEVER capped — capping would silently reduce
  // the doubled stake (forbidden); the ladder doubles past any
  // planned depth until a win. An inactive session keeps fresh
  // level 0.
  const wasActive = prev.state === 'CONTINUE' || prev.state === 'RESET';
  const level = wasActive ? (prev.level || 0) : 0;
  const nextStake = (wasActive && fresh.state === 'CONTINUE' && fresh.baseBet > 0)
    ? fresh.baseBet * Math.pow(2, level)
    : fresh.nextStake;
  return {
    ...fresh,
    level,
    nextStake,
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
  // Phase 3A per-type calibration (v2 §8): one tracker per bet type,
  // persisted under distinct keys. The gate + Platt fit use the
  // LEADER's type tracker once it matures; until then the pooled
  // tracker carries the gate (Phase 3B transitional migration — see
  // selectGateTracker). The pooled tracker keeps recording alongside.
  // Transition cost (report it): a brand-new user with no pooled
  // history is still calibration-gated until 50 fresh per-type
  // settlements each (exact starts empty too, moot while its bets
  // stay gated off) — but an existing user keeps their pooled
  // evidence instead of restarting at zero.
  const trackersByType = {
    COLOR: new CalibrationTracker({ storage: safeStorage(), key: `${CALIBRATION_KEY}_COLOR` }),
    SIZE: new CalibrationTracker({ storage: safeStorage(), key: `${CALIBRATION_KEY}_SIZE` }),
    NUMBER: new CalibrationTracker({ storage: safeStorage(), key: `${CALIBRATION_KEY}_NUMBER` })
  };
  // Record the displayed pick's outcome into its TYPE's tracker
  // (mirrors every pooled tracker.record call below). Null pick or
  // non-numeric prob → nothing (the pooled call guards the same).
  const recordTypeCalibration = (target, prob, won) => {
    const type = betTypeOfPick(target);
    if (type && trackersByType[type] && typeof prob === 'number') {
      try { trackersByType[type].record(prob, !!won); } catch (e) { /* calibration must never break settlement */ }
    }
  };
  // Phase 2A: per-model calibration (observability only — never a
  // verdict input). Records every governed model's RAW stated
  // confidence at settlement; session-scoped, bounded per model.
  const modelCalib = new PerModelCalibrationTracker();
  // One blacklist per governance scope: a model benched on 30s evidence
  // must not stay benched on 5m, and vice versa.
  const blacklists = new Map();
  const blacklistForScope = key => {
    if (!blacklists.has(key)) blacklists.set(key, new BlacklistManager());
    return blacklists.get(key);
  };
  const engine = new InchargeEngine({ mode: INCHARGE_MODES.WINNING_STREAK_OVERRIDE });
  const verifier = new LoginVerifier();
  // Phase 3D anti-tilt cooldown (owner order "no stop no skip"):
  // the standalone GateCooldown IS the only streak machinery left.
  // It raises the DISPLAYED bar (+3pts for 3 rounds after 2
  // consecutive losses) but never blocks a pick or a staged bet —
  // it is a margin, not a stop. Not persisted: a reload starts
  // fresh, because there is no stop left to launder.
  const cooldown = new GateCooldown();
  const locker = new VerdictLocker();
  const patternStore = new PatternStore(safeStorage());
  const ap = new AutoPilot(safeStorage());
  // Phase 3E demotion + bench (owner-approved design §§1–3, §10, as
  // amended 2026-10-27 ~11:15 IST: uniform 10-clean-round restoration,
  // no 4-loss streak — replaces next-win demotion-clear and 2-shadow-
  // win bench re-entry). Keyed per timeframe, persisted o101_bench_v1.
  // Fed ONLY from the live settlement branch (beside the shadow feed);
  // backfill never touches it. Blacklist subsumes bench (design §3):
  // the cycle drops bench state for newly blacklisted ids and the
  // live feed skips blacklisted ids.
  const bench = new BenchManager(safeStorage());
  // Phase Observer: per-rule walk-forward records (persisted,
  // o101_observer_v1). Observer follows the best-measured rule;
  // these records are that measurement, updated every live round.
  const observerRules = new ObserverRuleStore(safeStorage());

  // Axo runtime state: current face, the missed-bet ledger, the
  // first-gesture voice unlock and
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
    lastPeriodSeen: null,  // latest settled period processed (global, kept for compat)
    lastPeriodSeenByTf: {}, // Fix round (RC2): per-timeframe latest settled period
    picksByPeriod: {},   // Fix round (RC2): 'tf:period' -> { target, prob, decision } for the issued governed pick, cap ~5
    lastCycleTf: null,   // Fix round (RC2): timeframe of the previous cycle (tf-change reset detection)
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
    // Stake redesign (owner order 2026-10-30 ~01:06 IST): the user's
    // TYPED balance — session-scoped (cleared on reload; the owner
    // ordered the ask on each reload). Feeds stake sizing via
    // sizingBalance() when no fresh verified bridge balance exists.
    typedBalance: null,
    balanceAsk: false,        // the subtitle balance-ask is live
    balanceAskDismissed: false, // user X-dismissed the ask this session
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
    // AUTO base anchor (owner order 2026-10-30 ~10:36 IST): the
    // balance the AUTO base was last anchored from ("first balance"
    // at session start, then re-anchored between loss runs), plus
    // the fraction used — rendered as "Base ₹X · 1% of ₹Y". Cleared
    // when AUTO turns off; the ladder base locks mid-run (see
    // desiredBaseBet), so the anchor never moves during a run.
    baseAnchorBalance: null,
    baseAnchorFraction: AUTO_ANCHOR_FRACTION,
    apIntentSeen: null,    // updatedAt of the last settings intent applied
    lastChipBase: null,    // last MobileBridgeState.baseStake seen (manual-override detection)
    // Phase 3D: no skip counters, no hold state, no governed-
    // membership filter — every round shows a pick and every
    // catalog model is governed, so the Phase 2A/3A hold/cap
    // bookkeeping no longer exists.
    // Phase Observer: cached Observer picks, keyed by tf:latestPeriod
    // (the verdict lock key) so a mid-round backfill can never flip
    // the pick; the per-type follow info for the hero line; and the
    // per-type rule picks awaiting settlement scoring.
    observerPickKey: null,   // tf:latestPeriod the cached picks belong to
    observerPicks: null,     // Map observerId -> { target, conf } for the upcoming round
    observerFollow: null,    // { COLOR|SIZE|NUMBER: { followedId, followedName, rule, last100Wilson, last100N } }
    observerRulePicks: null, // { tf, byType: { TYPE: { rule: { target, followedId } } } }
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
      // exact figure, its login is API-proven. Task F (balance-zero
      // fix): a 0 state NEVER sets state.balance — the held figure
      // stands (or null when nothing was held). observeBridgeState
      // re-normalises internally and does not mutate this object, so
      // the guard must live on this assignment itself.
      verifier.observeBridgeState(sig.bridgeState, Date.now());
      if (sig.bridgeState.balance !== null && sig.bridgeState.balance !== 0) {
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
      // Task F (balance-zero fix): same guard as feedBridgeMessage —
      // a 0 RTDB state never sets state.balance (held figure stands).
      if (st.balance !== null && st.balance !== 0) { state.balance = st.balance; state.balanceSource = BALANCE_SOURCES.BRIDGE; }
      const login = verifier.status(Date.now());
      state.login = login;
      renderLogin(login);
    } catch (e) { /* offline / rules: channel + postMessage still feed */ }
  }
  setInterval(pollRtdbUserState, 5000);
  setTimeout(pollRtdbUserState, 2500);

  // ── Task O (connection resilience): ALWAYS reconnect + auto-connect ──
  // Backgrounding throttles/suspends every timer above (2s snapshot
  // poll, 5s RTDB poll, the bridge's own 15s heartbeat + 20s wallet
  // poll), and a bridge restart resets seq — so after a background
  // gap the app used to sit UNKNOWN for minutes waiting for the next
  // tick. The resume path below closes the gap immediately instead
  // of waiting for any tick. VERIFIED is never weakened by this: a
  // fresh state still needs isLoggedIn + apiProven from a real
  // authenticated payload, and a dead session still surfaces as
  // "login needed", never VERIFIED.
  let bridgeSyncChannel = null;
  function postBridgeSyncRequest() {
    const payload = { type: 'DHANIWIN_REQUEST_SYNC', timestamp: Date.now() };
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        if (!bridgeSyncChannel) bridgeSyncChannel = new BroadcastChannel('dhaniwin_quant_channel');
        bridgeSyncChannel.postMessage(payload);
      }
    } catch (e) { /* channel unavailable: iframe post still tries */ }
    try {
      const iframe = document.getElementById('dhaniwinIframe');
      if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage(payload, '*');
    } catch (e) { /* no iframe: channel already tried */ }
  }
  let lastReverifyAt = 0;
  function requestBridgeReverify() {
    // Throttle: launch already calls this once, and pageshow fires
    // on initial load too — a second call within 1s would only
    // duplicate the probe. A real resume (>1s after the last run)
    // always runs.
    const now = Date.now();
    if (now - lastReverifyAt < 1000) return;
    lastReverifyAt = now;
    try { pollBridgeState(); } catch (e) { /* polling must never break the app */ }
    try { pollRtdbUserState(); } catch (e) { /* offline / rules: channel still feeds */ }
    try {
      // Gap recovery: re-render NOW so a state older than 60s decays
      // to UNKNOWN/pending at once — a held figure (if any) renders
      // flagged stale, never as a fresh verified balance — until a
      // fresh probe lands and re-verifies it.
      const login = verifier.status(Date.now());
      state.login = login;
      renderLogin(login);
    } catch (e) { /* render must never break the app */ }
    postBridgeSyncRequest();
  }
  // Exposed for mobile.js / console / tests: no tap required.
  try { window.__o101BridgeReverify = requestBridgeReverify; } catch (e) {}
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestBridgeReverify();
  });
  // pageshow covers bfcache restores (persisted) and WebView resumes
  // that do not fire visibilitychange; the 1s throttle above absorbs
  // the initial-load pageshow, which the launch call already covers.
  window.addEventListener('pageshow', () => { requestBridgeReverify(); });
  window.addEventListener('online', () => { requestBridgeReverify(); });
  // Launch auto-connect: do not wait for the first poll ticks or for
  // the bridge's own init publish — ask for a probe immediately.
  requestBridgeReverify();

  // Stake redesign (owner order 2026-10-30 ~01:06 IST): on each reload
  // Axo asks for the balance via the subtitle when no fresh verified
  // balance exists. Slightly delayed so a live bridge can report
  // first and the ask never fires needlessly.
  setTimeout(() => { try { maybeAskBalance(); } catch (e) { /* never break boot */ } }, 4000);

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

  /** Axo Chat celebration hop (owner order 2026-10-25, Task B):
   *  the ported o101-axo-bounce keyframes on the visible face
   *  IMAGE only — never the avatar container, whose own transform
   *  (centering translate / orb morph) must not be overridden
   *  mid-animation. Skipped under reduced motion. The class is
   *  removed after the hop so a later win re-triggers cleanly. */
  let axoBounceTimer = null;
  function axoCelebrateBounce() {
    if (reducedMotion()) return;
    const img = axoPanelOpen() ? $('axoTopAvatarFace') : $('floatingOrbAxoFace');
    if (!img) return;
    img.classList.remove('o101-axo-bounce');
    void img.offsetWidth; // restart the hop on repeat wins
    img.classList.add('o101-axo-bounce');
    if (axoBounceTimer) clearTimeout(axoBounceTimer);
    axoBounceTimer = setTimeout(() => { img.classList.remove('o101-axo-bounce'); }, 2100);
  }

  /* Task P: the LOSS droop — mirrors axoCelebrateBounce exactly
   * (face image only, reduced-motion skip, class removed after
   * the animation so a later loss re-triggers cleanly). */
  let axoDroopTimer = null;
  function axoSadDroop() {
    if (reducedMotion()) return;
    const img = axoPanelOpen() ? $('axoTopAvatarFace') : $('floatingOrbAxoFace');
    if (!img) return;
    img.classList.remove('o101-axo-loss');
    void img.offsetWidth; // restart the droop on repeat losses
    img.classList.add('o101-axo-loss');
    if (axoDroopTimer) clearTimeout(axoDroopTimer);
    axoDroopTimer = setTimeout(() => { img.classList.remove('o101-axo-loss'); }, 1000);
  }

  /* Task P: hero/badge settle pulse — WIN glows green, LOSS glows
   * red, on the hero box (panel open) and the closed-orb pill.
   * The pill keeps its -translate-x-1/2 centering, so it gets a
   * shadow-only pulse: the standard scale pulse would override
   * the centering translate for 0.75s and make the pill jump.
   * Reduced-motion skips it, like the face animations. The
   * classes are removed after the pulse so the next settlement
   * re-triggers cleanly. Never fires on SKIP (this is called
   * only from the settled WIN/LOSS path). */
  let axoSettlePulseTimer = null;
  function axoSettlePulse(won) {
    if (reducedMotion()) return;
    const hero = $('axoHeroBox');
    if (hero) {
      hero.classList.remove('win-pulse-active', 'loss-pulse-active');
      void hero.offsetWidth;
      hero.classList.add(won ? 'win-pulse-active' : 'loss-pulse-active');
    }
    const pill = $('floatingOrbTarget');
    if (pill) {
      pill.classList.remove('o101-pill-win-pulse', 'o101-pill-loss-pulse');
      void pill.offsetWidth;
      pill.classList.add(won ? 'o101-pill-win-pulse' : 'o101-pill-loss-pulse');
    }
    if (axoSettlePulseTimer) clearTimeout(axoSettlePulseTimer);
    axoSettlePulseTimer = setTimeout(() => {
      if (hero) hero.classList.remove('win-pulse-active', 'loss-pulse-active');
      if (pill) pill.classList.remove('o101-pill-win-pulse', 'o101-pill-loss-pulse');
    }, 800);
  }

  // Idle behaviours, copied from the widget: the blink loop
  // (halfblink → blink → base, re-armed 2.8–5.5s, base face only)
  // and sleep after ~90s without interaction while the sheet is
  // closed (sleep ↔ sleep2 every 2.4s). Any governed event or tap
  // wakes Axo back to base first.
  function axoMaybeSleep() {
    if (axo.sleeping) return;
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
        } else if (!reducedMotion() && axo.face === 'base') {
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
    state.bubbleDismissedText = dismissalAfterSubsToggle({ on, dismissedText: state.bubbleDismissedText || '' });
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
   *  subtitle bubble anchors next to the visible avatar in either
   *  state: the top-center avatar when open, the floating ball
   *  when closed (owner order 2026-10-25). */
  function axoPanelOpen() {
    const modal = $('dhaniwinAssistantModal');
    if (!modal) return false;
    return !modal.classList.contains('hidden') && modal.style.display !== 'none';
  }

  /** Sync prediction surfaces with CC + panel state. Owner order
   *  2026-10-25 (UI batch, reverses fix round #5): the subtitle is
   *  an OUTSIDE FLOATING bubble next to the avatar whenever a
   *  subtitle exists — speaking or panel opened. The bubble is the
   *  single subtitle surface: the in-panel sheet line is written
   *  but never displayed while the bubble ships, so the same text
   *  never appears twice. Old cached HTML without the bubble
   *  element keeps the previous sheet-line behaviour. Called from
   *  say(), applyAxoSubs(), and the panel open/close hook. */
  /** Position the subtitle bubble next to Axo's CURRENT anchor rect
   *  (owner order 2026-10-25, bubble-tracks-Axo): the single
   *  positioning path used by the full sync AND by the lightweight
   *  reposition hook. Returns true when the bubble is shown. Task L:
   *  the anchor is the first VISIBLE avatar (top-center avatar →
   *  header face → orb) — a hidden anchor hides the bubble only
   *  when NO Axo is visible at all, never because the open morph's
   *  avatar swap did not run while the header face is on screen. */
  function axoBubbleAnchorEl() {
    const open = axoPanelOpen();
    const visible = (el) => {
      if (!el) return false;
      try {
        return !window.getComputedStyle || window.getComputedStyle(el).display !== 'none';
      } catch (e) { return true; }
    };
    const choice = axoBubbleAnchorChoice({
      panelOpen: open,
      topVisible: visible($('axoTopAvatar')),
      faceVisible: visible($('axoFaceHost')),
      orbVisible: visible($('dhaniwinFloatingOrb'))
    });
    if (choice === 'top') return $('axoTopAvatar');
    if (choice === 'face') return $('axoFaceHost');
    if (choice === 'orb') return $('dhaniwinFloatingOrb');
    return null;
  }

  function positionAxoBubble() {
    const bubble = $('axoSubtitleBubble');
    if (!bubble) return false;
    // Stake redesign: while the balance ask is live, the bubble shows
    // the ask line (sticky) — verdict says keep updating lastLine and
    // voice, but the ask stays visible until typed or X-dismissed.
    const line = (state.balanceAsk && !state.balanceAskDismissed) ? BALANCE_ASK_TEXT : (state.lastLine || '');
    const show = bubbleVisible({ subsOn: axoSubsOn(), text: line, dismissedText: state.bubbleDismissedText || '' });
    if (!show) {
      bubble.style.display = 'none';
      return false;
    }
    const anchorEl = axoBubbleAnchorEl();
    if (!anchorEl) {
      bubble.style.display = 'none';
      return false;
    }
    bubble.style.display = 'block';
    const r = anchorEl ? anchorEl.getBoundingClientRect() : null;
    const bw = bubble.offsetWidth || 280;
    const bh = bubble.offsetHeight || 60;
    const pos = axoBubbleGeometry({
      anchor: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null,
      vw: window.innerWidth, vh: window.innerHeight, bw, bh
    });
    bubble.style.left = pos.left + 'px';
    bubble.style.top = pos.top + 'px';
    return true;
  }

  /** Lightweight bubble tracking (owner order 2026-10-25): re-run
   *  ONLY the positioning step when Axo moves — orb drag, sheet
   *  drag/resize, open/close transitions — without rewriting the
   *  subtitle text or re-rendering the orb face mid-gesture. A
   *  hidden bubble stays hidden: the next say() shows it at the
   *  then-current anchor through the full sync. */
  function repositionAxoBubble() {
    const bubble = $('axoSubtitleBubble');
    if (!bubble || bubble.style.display !== 'block') return false;
    const shown = positionAxoBubble();
    // Phase 2A: a visible system notification tracks Axo too (its
    // 4s timer is NOT restarted — this is position only).
    positionSystemNotification();
    return shown;
  }

  function syncAxoSubtitleSurfaces() {
    renderAxoOrb();
    const bubble = $('axoSubtitleBubble');
    if (!bubble) return;
    const line = (state.balanceAsk && !state.balanceAskDismissed) ? BALANCE_ASK_TEXT : (state.lastLine || '');
    const textEl = $('axoSubtitleBubbleText');
    if (textEl && line) textEl.textContent = line;
    positionAxoBubble();
    // Dedup: the bubble owns the subtitle now.
    const sheetLine = $('smartBallLine');
    if (sheetLine) sheetLine.classList.add('hidden');
  }

  /** The bubble's X: closes the CURRENT subtitle bubble only —
   *  never the bot, never CC, never voice. The next DIFFERENT say()
   *  line shows the bubble again: dismissal is per-line (distinct
   *  text), not a setting — a same-text re-say stays dismissed.
   *  Stake redesign: X also ends a live balance ask for this session
   *  (the ask returns on the next reload, per the owner's order). */
  function dismissAxoBubble() {
    state.bubbleDismissedText = state.lastLine || '';
    if (state.balanceAsk) {
      state.balanceAsk = false;
      state.balanceAskDismissed = true;
      const row = $('axoBalanceAskRow');
      if (row) row.style.display = 'none';
    }
    syncAxoSubtitleSurfaces();
  }

  // ── Balance ask (owner order 2026-10-30 ~01:06 IST) ───────────────
  // On each reload, Axo asks for the balance via the subtitle when no
  // fresh verified balance exists. The user taps the bubble and TYPES
  // the balance into the inline row — clean, minimal, obvious. The
  // typed balance is session-scoped (the ask returns on reload) and
  // feeds stake sizing via sizingBalance() until a verified balance
  // arrives. It never blocks anything: every feature works
  // balance-free exactly as today.
  const BALANCE_ASK_TEXT = 'Tap here and type your balance \u2193';

  function maybeAskBalance() {
    let fresh = false;
    try { fresh = freshVerifiedBalance(verifier.status(Date.now())); } catch (e) { /* never break boot */ }
    if (shouldAskBalance({ verifiedFresh: fresh, typed: state.typedBalance, dismissed: state.balanceAskDismissed })) {
      state.balanceAsk = true;
      say(BALANCE_ASK_TEXT, 'verdict');
      syncAxoSubtitleSurfaces();
    }
  }

  function resolveBalanceAsk() {
    state.balanceAsk = false;
    const row = $('axoBalanceAskRow');
    if (row) row.style.display = 'none';
    syncAxoSubtitleSurfaces();
  }

  /** Tap on the subtitle bubble (not the X — it has its own handler):
   *  while the balance ask is live, toggles the inline type row. */
  function axoBubbleTap(e) {
    try {
      if (e && e.target && e.target.closest && e.target.closest('#axoSubtitleBubbleClose')) return;
    } catch (err) { /* fall through to the ask check */ }
    if (!state.balanceAsk || state.balanceAskDismissed) return;
    const row = $('axoBalanceAskRow');
    if (!row) return;
    const showing = row.style.display !== 'none';
    row.style.display = showing ? 'none' : 'block';
    if (!showing) {
      const input = $('axoBalanceAskInput');
      if (input) { try { input.focus({ preventScroll: true }); } catch (err) { try { input.focus(); } catch (e2) {} } }
    }
  }

  /** Submit the typed balance: validate, store session-scoped, resize
   *  stakes immediately. Invalid input keeps the row open. */
  function submitTypedBalance() {
    const input = $('axoBalanceAskInput');
    const raw = input ? String(input.value).replace(/[^\d.]/g, '') : '';
    const v = raw ? Number(raw) : NaN;
    if (!Number.isFinite(v) || v <= 0) return;
    state.typedBalance = Math.round(v * 100) / 100;
    resolveBalanceAsk();
    say(`Balance set \u2014 stakes now follow \u20B9${state.typedBalance}.`, 'system');
    if (typeof window !== 'undefined' && typeof window.__o101SyncBaseNow === 'function') {
      try { window.__o101SyncBaseNow(); } catch (e) { /* a sync must never break on submit */ }
    }
    renderAxoOrb();
  }

  // ── No-skip mode (owner order 2026-10-25, UI batch) ─────────────
  // DORMANT (Phase 2A, owner correction 2): the chip, badge, and
  // popup are removed from the panel and nothing calls these
  // functions anymore. They stay, unreferenced, so the removal is
  // reversible; the automatic skip cap is now the skip handling.
  // Session-scoped by construction: plain closure flags, never
  // localStorage, so every launch starts OFF. Tapping the chip
  // while OFF only OPENS the warning — enabling requires an
  // explicit tap on the warning's Confirm button. Turning OFF
  // needs no warning. While ON, the chip + badge stay visible.
  let noSkipOn = false;
  let noSkipWarnOpen = false;

  function renderNoSkipChip() {
    const chip = $('axoNoSkipChip');
    if (chip) {
      chip.setAttribute('aria-pressed', noSkipOn ? 'true' : 'false');
      chip.classList.toggle('bg-rose-500/25', noSkipOn);
      chip.classList.toggle('text-rose-300', noSkipOn);
      chip.classList.toggle('border-rose-500/40', noSkipOn);
      chip.classList.toggle('bg-white/10', !noSkipOn);
      chip.classList.toggle('text-zinc-400', !noSkipOn);
      chip.classList.toggle('border-white/10', !noSkipOn);
      chip.classList.toggle('opacity-60', !noSkipOn);
    }
    const badge = $('axoNoSkipBadge');
    if (badge) badge.classList.toggle('hidden', !noSkipOn);
    // Task H (owner order 2026-10-25): the warning is the Apple-style
    // popup OUTSIDE the panel (the in-panel element is gone — exactly
    // one warning surface). Show/hide via display, never a class
    // that could fight the popup's inline flex layout.
    const popup = $('axoNoSkipPopup');
    if (popup) popup.style.display = noSkipWarnOpen ? 'flex' : 'none';
  }

  function toggleNoSkip() {
    if (noSkipOn) { noSkipOn = false; noSkipWarnOpen = false; }
    else noSkipWarnOpen = true;
    renderNoSkipChip();
  }

  function confirmNoSkip() {
    noSkipOn = true;
    noSkipWarnOpen = false;
    renderNoSkipChip();
  }

  function cancelNoSkip() {
    noSkipWarnOpen = false;
    renderNoSkipChip();
  }

  /**
   * Subtitle write (Phase 2A routing — owner correction 5).
   * kind 'verdict' (default): the EXISTING bubble path — writes the
   * sheet state, sets state.lastLine, syncs surfaces. A new verdict
   * line clears a previous bubble dismissal ONLY when its text
   * differs from the dismissed line (shouldClearBubbleDismissal):
   * the X closed THAT line, and a textually identical re-say is the
   * same line, not a new utterance — clearing on every say() used
   * to resurrect the bubble every round and made the X look dead
   * (owner order 2026-10-27). A same-text line after an intervening
   * different line still re-shows, because that line already cleared
   * the dismissal.
   * kind 'system': shows the MINIMAL auto-closing notification above
   * the Axo/ball area instead, and touches NEITHER the bubble NOR
   * state.lastLine — so a status line can never evict the current
   * verdict subtitle. Voice is untouched: callers that speak a line
   * (speakEvent → axoOnEvent → axoSpeak) still speak exactly the
   * subtitle string; auto-close is visual only.
   */
  function say(text, kind = 'verdict') {
    if (resolveSubtitleTarget(kind) === 'notification') {
      if (text) showSystemNotification(text);
      return;
    }
    const el = $('smartBallLine');
    // The sheet line carries an icon slot beside the text (fix round
    // #3): write the text span only, so a subtitle write never wipes
    // the verdict icon. The line is state only now — the bubble is
    // the visible subtitle (owner order 2026-10-25).
    const sheetText = $('axoSheetVerdictText');
    if (sheetText && text) sheetText.textContent = text;
    else if (el && text) el.textContent = text;
    // A DIFFERENT line clears a previous bubble dismissal: the X
    // closed THAT line, not subtitles in general. A same-text
    // re-say never clears (shouldClearBubbleDismissal) — the signal
    // line repeats every round while pick/stake/level hold, and
    // clearing on every say() made the X look unclickable.
    if (shouldClearBubbleDismissal({ text, dismissedText: state.bubbleDismissedText || '' })) state.bubbleDismissedText = '';
    state.lastLine = text;
    syncAxoSubtitleSurfaces();
  }

  /** System/status notification (Phase 2A, owner correction 5):
   * small dark-matte box ABOVE the Axo/ball area, pointer-events
   * none (never blocks a tap, never a modal), auto-closes after
   * SYSTEM_NOTIFICATION_MS (4000ms). A new system line replaces the
   * text and restarts the timer. The verdict bubble is untouched. */
  let systemNotificationTimer = null;

  function positionSystemNotification() {
    const note = $('axoSystemNotification');
    if (!note || note.style.display !== 'block') return false;
    const anchorEl = axoBubbleAnchorEl();
    const r = anchorEl ? anchorEl.getBoundingClientRect() : null;
    const bubble = $('axoSubtitleBubble');
    let bubbleRect = null;
    if (bubble && bubble.style.display === 'block') {
      const br = bubble.getBoundingClientRect();
      bubbleRect = { top: br.top, bottom: br.bottom, left: br.left, right: br.right };
    }
    const pos = systemNotificationGeometry({
      anchor: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null,
      vw: window.innerWidth, vh: window.innerHeight,
      nw: note.offsetWidth || 280, nh: note.offsetHeight || 32,
      bubbleRect
    });
    note.style.left = pos.left + 'px';
    note.style.top = pos.top + 'px';
    return true;
  }

  function showSystemNotification(text) {
    const note = $('axoSystemNotification');
    const textEl = $('axoSystemNotificationText');
    if (!note || !textEl) return;
    textEl.textContent = text;
    note.style.display = 'block';
    positionSystemNotification();
    if (systemNotificationTimer) clearTimeout(systemNotificationTimer);
    systemNotificationTimer = setTimeout(() => {
      note.style.display = 'none';
      systemNotificationTimer = null;
    }, SYSTEM_NOTIFICATION_MS);
  }

  /** Write one verdict icon into every icon slot that exists. Icons
   *  are visual only and never enter a spoken string; a null kind
   *  clears all slots. Each surface's own visibility logic (sheet
   *  open/closed, subtitles on/off, bubble dismissed) still governs
   *  display. */
  function setVerdictIcon(kind) {
    const svg = (kind && VERDICT_ICONS[kind]) || '';
    for (const id of ['axoSheetVerdictIcon', 'axoHeroVerdictIcon']) {
      // Fix round (ball-only): orbVerdictIcon is the floating
      // widget's icon — renderAxoOrb keeps it cleared, and this
      // writer must never re-paint it. Sheet/hero icons are panel
      // surfaces, not the widget, and stay.
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

    // Phase 3B: the prediction subtitle is pick + stake + level
    // ONLY (owner order 2026-10-27). The sequence road used to ride
    // along on every BET subtitle (and the voice spoke it too) —
    // deleted from the subtitle; the road stays in the panel's
    // Sequence Road section only. withRoadSuffix/roadSuffix stay
    // exported but unwired (Phase 2A dormant-helper precedent).
    const full = line;
    say(full, subtitleKindForEvent(event));
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
      say(text, 'verdict'); // settled WIN/LOSS/ladder lines are verdict lines
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
      if (group.some(ev => axoBounceForEvent(ev))) axoCelebrateBounce();
      if (group.some(ev => axoDroopForEvent(ev))) axoSadDroop();
      if (group.some(ev => ev === BOT_EVENTS.WIN)) axoSettlePulse(true);
      else if (group.some(ev => ev === BOT_EVENTS.LOSS)) axoSettlePulse(false);
    }
  }

  /** The VERIFIED moment: wink face, and the spoken line only when
   *  the balance is the API-proven figure (never a page scrape). */
  function axoOnVerified(login) {
    axo.lastInteractAt = Date.now();
    setAxoFace('wink');
    if (axoBounceForEvent(BOT_EVENTS.LOGIN_VERIFIED)) axoCelebrateBounce();
    if (!verifiedLineApplies(login)) return;
    const { line } = botLine(BOT_EVENTS.LOGIN_VERIFIED, contextSnapshot({ balance: login.balance }));
    say(line, 'system'); // login status: notification, not the verdict bubble
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
      // Stake redesign (owner order 2026-10-30): the spoken "level"
      // is the doubling-ladder rung index (0-based; display adds 1)
      // when known, else the session loss-run counter.
      ladderLevel: state.session && Number.isFinite(state.session.ledgerLevelIndex) ? state.session.ledgerLevelIndex : (state.session ? state.session.level : 0),
      // Phase 3E: post-settlement tracked ledger loss for the WIN
      // line (null when no ledger info — the old line is kept then).
      ledgerTracked: state.session && state.session.ledgerView ? state.session.ledgerView.tracked : null,
      ladderLevels: state.session ? state.session.ladderLevels : 0,
      nextStake: state.session ? state.session.nextStake : 0,
      // Task R: the speaker must know whether a bankroll session
      // exists — without it the SIGNAL_BET line falls back to ₹0,
      // which is not a suggestion at all (see predictBot normCtx).
      hasSession: !!state.session,
      sessionPnL: state.session ? state.session.sessionPnL || 0 : 0,
      startingBalance: state.session ? state.session.startingBalance : 0,
      inchargeModel: modelObj ? { id: modelObj.id, name: modelObj.name } : null,
      inchargeReason: state.inchargeReason,
      gateDecision: state.gate,
      pick: state.gate ? state.gate.pick : null,
      calibratedConfidence: state.gate && state.gate.prob !== null && state.gate.prob !== undefined ? state.gate.prob : null,
      isCalibrated: tracker.isCalibrated(),
      streak: stats ? stats.streak : 0,
      belowBar: state.gate ? !!state.gate.belowBar : false,
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
    // Phase 3D: the governed pool is the WHOLE catalog (137) — no
    // display-only spares remain. `pool` and `governedPool` are the
    // same membership now; governance uses `governedPool` everywhere
    // below (blacklist, ranking, lookup).
    const { governed: governedPool } = splitGovernedPool(pool);
    const bl = blacklistForScope(scope.key);
    state.scopeKey = scope.key;
    state.scopeLabel = scope.label;
    return { scope, pool, governedPool, bl, patternCtx };
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
    // Stake redesign: a fresh verified balance arriving resolves a
    // live balance ask — no need to type what the bridge proved.
    if (state.balanceAsk && freshVerifiedBalance(login)) resolveBalanceAsk();
    if (state.loginState !== login.state) {
      const prevLoginState = state.loginState;
      state.loginState = login.state;
      say(loginLine(login), 'system'); // bridge/login status: notification, not the verdict bubble
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
        // Phase 3E: ledger level (derived log2 of stake/base), not
        // the retired ladder's rung — the stake figure is the ledger
        // figure, never the doubling figure.
        const li = state.session && Number.isFinite(state.session.ledgerLevelIndex) ? state.session.ledgerLevelIndex : null;
        parts.push('BET ' + (gate.pick || '')
          + (verified && state.session ? ` · ledger level ${li !== null ? li + 1 : 1} · next ${inrStake(state.session.nextStake)}` : ''));
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
// Analyse patterns pagination state (closure — survives the cycle's
// re-renders, so paging is not reset every 3s).
let patternPage = 1;
const PATTERN_PAGE_SIZE = 10;

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
    // Pager state (label + disabled ends) always reflects the FULL
    // list; the meta totals above stay global too — only the ROWS
    // are sliced to the current page.
    const pg = paginatePage(rows, patternPage, PATTERN_PAGE_SIZE);
    patternPage = pg.page;
    const updatePatternPager = () => {
      const label = $('patternStatsPageLabel');
      if (label) label.textContent = `Page ${pg.page} of ${pg.totalPages}`;
      const prevBtn = $('patternStatsPrevBtn');
      if (prevBtn) { prevBtn.disabled = pg.page <= 1; prevBtn.classList.toggle('opacity-40', pg.page <= 1); }
      const nextBtn = $('patternStatsNextBtn');
      if (nextBtn) { nextBtn.disabled = pg.page >= pg.totalPages; nextBtn.classList.toggle('opacity-40', pg.page >= pg.totalPages); }
    };
    if (!rows.length) {
      list.innerHTML = '<div class="text-[9px] font-mono text-zinc-500 px-1 py-2">No pattern firings yet. The engine evaluates the catalog patterns on every settled round and records each firing here — nothing is back-computed or invented.</div>';
      updatePatternPager();
      return;
    }
    list.innerHTML = pg.rows.map(r => `<div class="flex items-start justify-between gap-2 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06]">
      <div class="min-w-0">
        <div class="text-[10px] font-bold text-white truncate">${esc(r.name)} <span class="text-zinc-500 font-mono text-[8px]">${esc(r.patternId)} · ${esc(r.timeframe)}</span></div>
        <div class="text-[8px] font-mono text-zinc-500">last fired · period …${esc(shortPeriod(r.lastPeriod))}</div>
      </div>
      <div class="text-right shrink-0">
        <div class="text-[10px] font-black font-mono ${r.hitRate >= 0.5102 ? 'text-emerald-300' : 'text-zinc-300'}">${(r.hitRate * 100).toFixed(1)}%</div>
        <div class="text-[8px] font-mono text-zinc-500">${r.hits}/${r.fired} hits</div>
      </div>
    </div>`).join('');
    updatePatternPager();
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

  /** The base bet the governed ladder should run: AUTO (anchored to
   *  the balance, re-anchored between loss runs, locked mid-run) or
   *  the window's chip value. Fix round #2: AUTO without a usable
   *  balance falls back to the manual chip base instead of stalling —
   *  login state never blocks staging. */
  function desiredBaseBet(login) {
    const chip = window.MobileBridgeState ? Number(window.MobileBridgeState.baseStake) : NaN;
    const chipOk = Number.isFinite(chip) && chip > 0 ? Math.floor(chip) : DEFAULT_CHIP_BASE;
    if (ap.state.autoBase) {
      // AUTO base anchor (owner order 2026-10-30 ~10:36 IST):
      // 1% of the sizing balance (fresh verified > typed > none),
      // re-anchored automatically between loss runs, LOCKED while a
      // run is live — the ladder's recovery math is computed from
      // the run's base, so moving it mid-run would break recovery
      // sizing. Unknown balance → the chip fallback, unchanged.
      const lossRun = state.session ? Math.max(0, state.session.consecutiveLosses || 0) : 0;
      const mode = getStakingMode(ap.state.riskMode);
      const dec = decideAutoBase({
        autoBase: true,
        balance: sizingBalance(),
        lossRun,
        currentBase: state.session ? state.session.baseBet : null,
        fraction: mode.baseFraction
      });
      if (dec.base === null) return chipOk;
      if (lossRun > 0) return dec.base; // run lock: the exact figure, never re-scaled mid-run
      state.baseAnchorBalance = dec.anchorBalance;
      state.baseAnchorFraction = mode.baseFraction;
      // Graduated stakes (existing safety rule): the anchored base is
      // scaled by the current bet driver's sample factor at anchor
      // time only — never ₹0 (the Task R1 ₹0 bug must not return).
      const f = state.graduatedFactor ?? 1;
      if (f === 0) return Math.max(1, Math.floor(dec.base * 0.25));
      return Math.max(1, Math.floor(dec.base * f));
    }
    return chipOk;
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
        state.baseAnchorBalance = null; // manual chip wins: no AUTO anchor to show
        say(`AUTO base off — your manual chip ${inrStake(chip)} wins.`, 'system');
      }
      state.lastChipBase = chip;
    }
    const desired = desiredBaseBet(login);
    const sig = JSON.stringify([desired, ap.state.riskMode, ap.state.autoBase]);
    if (sig === state.baseSignature) return;
    state.baseSignature = sig;
    if (desired === null) return; // Defensive only: resolveBaseBet never returns null since Phase 3B (chip default ₹2).
    if (desired === state.session.baseBet && ap.state.riskMode === state.session.mode) return;
    const balForPlan = freshVerifiedBalance(login) ? login.balance : state.session.balance;
    state.session = replanSession(state.session, balForPlan, { mode: ap.state.riskMode, baseBet: desired });
    // Phase 3A: persist the replanned ladder (level carried, see
    // replanSession) so a reload keeps the doubling position.
    try { saveSessionTo(safeStorage(), 'SHARED', state.session); } catch (e) { /* storage must never break the cycle */ }
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
      sessionStake: state.session ? state.session.nextStake : undefined,
      countdownMsLeft: countdownMsLeft(),
      nowMs: Date.now(),
      maxStake: (window.MobileBridgeState && Number(window.MobileBridgeState.maxStakeCap)) || (staged ? staged.stake : undefined)
    });
    if (!res.ok) {
      say('Auto-Pilot: ' + res.reason, 'system');
      renderAutoPilot();
      return res;
    }
    transportOrder(res.order);
    const dKey = res.order.timeframe + ':' + res.order.period;
    if (state.dispositions[dKey]) state.dispositions[dKey].fired = true;
    say(`Fired: ${res.order.target} ${inrStake(res.order.stake)} for period …${shortPeriod(res.order.period)} — sent to the bridge on the tap you just gave.`, 'system');
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
      });
      if (!res.ok) say('Auto-Pilot refused: ' + res.reason, 'system');
      else {
        state.baseSignature = null;
        say('Auto-Pilot on. I stage every governed BET — you fire it with one tap per bet.', 'system');
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

  // Fix round (real-time base bet, owner order 2026-10-27 ~12:01 IST):
  // the Recovery Ledger resize as ONE named step — the cycle calls it
  // after syncSessionBase, and the synchronous chip/AUTO hook calls
  // the same function. A gate's driverType is always set by the cycle
  // companions (held gates carry their own previous driver), so no
  // locker fallback is needed here.
  // Stake redesign (owner order 2026-10-30 ~01:06 IST): the balance
  // the stake engine sizes against. Precedence: fresh verified bridge
  // balance (ground truth) -> typed balance (the user's explicit
  // input this session) -> none. A stale number never beats the
  // user's typed input; nothing is invented when neither exists.
  function sizingBalance() {
    let verified = null, fresh = false;
    try {
      const login = verifier.status(Date.now());
      fresh = freshVerifiedBalance(login);
      if (fresh && login && Number.isFinite(login.balance) && login.balance > 0) verified = login.balance;
    } catch (e) { /* a verifier hiccup must never break sizing */ }
    return pickSizingBalance({ verified, verifiedFresh: fresh, typed: state.typedBalance });
  }

  // Stake redesign (owner order 2026-10-30 ~01:06 IST): the doubling
  // ladder is the SOLE stake authority — double on loss across 6
  // levels, high-chance gate past 5 consecutive losses, never-₹0
  // floor, never-zero-balance guard. Driven by the session's
  // consecutive-loss counter (persisted via saveSessionTo, so a
  // reload keeps the doubling position).
  function applyLedgerResize(g) {
    if (state.session && g.decision === GATE_DECISIONS.BET) {
      const driverType = g.driverType || 'COLOR';
      const L = loadLedger(safeStorage(), driverType);
      const W = Number.isFinite(g.wilsonLowerBound) ? g.wilsonLowerBound : null;
      const lossRun = Math.max(0, state.session.consecutiveLosses || 0);
      const rz = ledgerResize(state.session.baseBet, lossRun, W, driverType, sizingBalance());
      state.session.nextStake = rz.stake;
      state.session.shortfall = rz.over ? rz.over.shortfall : null;
      state.session.overPlan = false;
      state.session.ledgerLevelIndex = rz.levelIndex;
      state.session.ledgerView = {
        tracked: L, stake: rz.stake, required: rz.required, weight: rz.weight,
        shortfall: rz.over ? rz.over.shortfall : null,
        capped: rz.over ? rz.over.capped : null,
        levelIndex: rz.levelIndex, level: rz.level, gated: rz.gated, lossRun
      };
      g.ledgerView = state.session.ledgerView;
      try { saveSessionTo(safeStorage(), 'SHARED', state.session); } catch (e) { /* storage must never break the cycle */ }
    } else {
      g.ledgerView = null;
      // No stake this round (NO_PICK): clear the session's ledger
      // view + shortfall so a stale "needs Rs X more" from the last
      // BET round never lingers on a round with no pick.
      if (state.session) {
        state.session.ledgerView = null;
        state.session.shortfall = null;
      }
    }
  }

  function toggleAutoBase() {
    ap.setAutoBase(!ap.state.autoBase);
    state.baseSignature = null;
    if (!ap.state.autoBase) state.baseAnchorBalance = null; // anchor label belongs to AUTO only
    say(ap.state.autoBase
      ? 'AUTO base on — the base bet now follows your verified balance and risk mode.'
      : 'AUTO base off — the manual chips rule.', 'system');
    renderAutoPilot();
    // Fix round (real-time base bet): AUTO toggle updates Base/Bet/
    // pill/level synchronously via the same sync path as the cycle.
    if (typeof window !== 'undefined' && typeof window.__o101SyncBaseNow === 'function') {
      try { window.__o101SyncBaseNow(); } catch (e) { /* a toggle must never break on sync */ }
    }
  }


  /** Per-cycle Auto-Pilot staging against the LOCKED gate. */
  function apStageCycle(tf, gate, login, openP) {
    if (!ap.enabled) return;
    // Fix round #2: login is not a staging gate. Staging proceeds on
    // the governed session base (AUTO falls back to the chip base
    // without a fresh verified balance); only the DhaniWin page
    // itself can refuse an order, and it reports honestly.
    ap.notePaused(false);
    if (gate.decision !== GATE_DECISIONS.BET) {
      // Phase 3D: no SKIP exists — a non-BET verdict is NO_PICK
      // (empty pool). Any staged bet for a round with no pick is
      // invalidated; nothing else stages.
      const staged = ap.stagedBet();
      if (staged) ap.invalidate('no pick for this round');
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

  /**
   * Task L: collapse the confirm slot when it has nothing to show.
   * The slot's old always-34px reservation was the blank gap between
   * the skip reason and the road in the owner's screenshot. 0px when
   * both buttons are hidden, 34px when either shows; the hidden
   * countdown keeper never counts as visible content.
   */
  function syncConfirmSlotHeight() {
    const slot = $('autoPilotConfirmSlot');
    if (!slot) return;
    const btn = $('autoPilotConfirmBtn');
    // Phase 3D: the re-arm button is deleted (no stops) — always hidden.
    slot.style.height = confirmSlotHeight({
      confirmHidden: !btn || btn.classList.contains('hidden'),
      rearmHidden: true
    }) + 'px';
  }

  /**
   * Task L: grow the open sheet to its measured content whenever
   * content exceeds the sheet height, so a staged confirm slot, a
   * long reason, or a taller road can never clip the base-bet chip
   * row under the sheet cap again. Grow-only and viewport-capped
   * (fitSheetHeight); never shrinks a user's size, never scrolls.
   * Task N (owner order 2026-10-26): compact-fit FIRST, then grow.
   * Before measuring, the sheet steps through compaction tiers by
   * measurement — up while the need exceeds the sheet, back down
   * while a roomier tier still fits — so a user-shrunk sheet shows
   * every section compacted instead of clipping, and a roomy sheet
   * never stays over-compacted. The narrow flag follows the sheet
   * width. Only after max compaction does the grow step run, so a
   * size below the compacted need settles AT that need (the honest
   * smallest fully-visible size) rather than clipping. The
   * grow-only contract for user sizes is unchanged: this never
   * shrinks the sheet below the user's height except by applying
   * a tighter tier, and the viewport cap still wins on short
   * viewports (physical limit — most compact layout kept there).
   */
  function fitSheetToContent() {
    if (!axoPanelOpen()) return false;
    const sheet = $('dhaniwinAssistantSheet');
    const body = sheet ? sheet.querySelector('.assistant-sheet-body') : null;
    const header = $('assistantSheetHeader');
    const controls = $('axoControlRow');
    if (!sheet || !body || !header || !controls) return false;
    const measure = () => sheetContentHeight({
      headerH: header.offsetHeight || 0,
      controlsH: controls.offsetHeight || 0,
      bodyScrollH: body.scrollHeight || 0
    });
    const applyTier = (level) => { sheet.dataset.axoCompact = String(level); };
    let level = Number(sheet.dataset.axoCompact || 0) || 0;
    if (level < 0 || level > 3) level = 0;
    applyTier(level);
    let need = measure();
    const sheetH = () => sheet.offsetHeight || 0;
    while (need > sheetH() && level < 3) { level += 1; applyTier(level); need = measure(); }
    while (level > 0) {
      applyTier(level - 1);
      const lower = measure();
      if (lower <= sheetH()) { level -= 1; need = lower; }
      else { applyTier(level); need = measure(); break; }
    }
    sheet.dataset.axoNarrow = axoNarrowFor({ width: sheet.offsetWidth || 0 }) ? '1' : '0';
    const target = fitSheetHeight({ need, current: sheetH(), vh: window.innerHeight || 0 });
    if (target === null) return false;
    sheet.style.height = target + 'px';
    sheet.style.maxHeight = target + 'px';
    return true;
  }

  function renderAutoPilot() {
    const toggle = $('autoPilotToggle');
    if (toggle) {
      toggle.setAttribute('aria-checked', ap.enabled ? 'true' : 'false');
      toggle.textContent = ap.enabled ? 'AP ON' : 'AP OFF';
      toggle.className = ap.enabled
        ? 'text-[7.5px] font-mono font-black px-2 py-0.5 rounded-full bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 active:scale-95 transition'
        : 'text-[7.5px] font-mono font-black px-2 py-0.5 rounded-full bg-white/10 text-zinc-300 border border-white/10 active:scale-95 transition';
    }
    const btn = $('autoPilotConfirmBtn');
    const staged = ap.stagedBet();
    if (btn) {
      if (staged && ap.enabled) {
        btn.classList.remove('hidden');
        btn.textContent = `BET ${staged.target} · ${inrStake(staged.stake)} — tap to confirm`;
      } else {
        btn.classList.add('hidden');
      }
    }
    const line = $('autoPilotSessionLine');
    if (line) line.textContent = ap.sessionLine();
    const stopEl = $('autoPilotStopLine');
    const stopText = (ap.enabled && ap.state.paused ? ap.state.pauseReason : null);
    if (stopEl) {
      if (stopText) { stopEl.textContent = stopText; stopEl.classList.remove('hidden'); }
      else stopEl.classList.add('hidden');
    }
    const auto = $('autoBaseToggle');
    if (auto) {
      auto.setAttribute('aria-pressed', ap.state.autoBase ? 'true' : 'false');
      auto.className = ap.state.autoBase
        ? 'text-[7.5px] font-mono font-bold px-1.5 py-0.2 rounded bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 transition active:scale-95'
        : 'text-[7.5px] font-mono font-bold px-1.5 py-0.2 rounded bg-white/10 text-zinc-300 border border-white/10 transition active:scale-95';
    }
    // Task L: the confirm slot collapses when empty (no reserved
    // blank gap) and the sheet grows to its measured content so a
    // staged bet or a long reason can never clip the chip row.
    syncConfirmSlotHeight();
    fitSheetToContent();
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
  // store up to (and past) full stake at 200 rounds from REAL settled
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
    // Fix round (RC2): a timeframe switch resets the governed
    // settlement state — a pick issued for the old timeframe must
    // never settle a round of the new one.
    if (state.lastCycleTf !== null && state.lastCycleTf !== tf) {
      state.lastPick = null;
      state.picksByPeriod = {};
    }
    state.lastCycleTf = tf;
    state.tf = tf;
    const latest = history[history.length - 1];
    const latestPeriod = String(latest.period);

    // Headless pattern engine: feed every newly settled round of
    // every timeframe (walk-forward, persisted) before governance
    // reads pattern stats below.
    feedPatternEngine();

    // Balance + bankroll session (Phase 3B balance decoupling, owner
    // order 2026-10-27: "remove the balance sync, just give stake
    // from user selected base"). The session starts on the FIRST
    // cycle with no balance at all — the stake is the user-selected
    // chip (default ₹2) × the ladder, and a synced balance is never
    // a precondition again. The bridge verifier still updates
    // state.balance for DISPLAY only (verified-balance block); it
    // can no longer gate a session or a stake. The old
    // BALANCE_DETECTED / BALANCE_LOW / BALANCE_NOT_DETECTED
    // announcements are deleted with this block (a session state
    // change is announced by the short STOP_LOSS / STOP_WIN /
    // CIRCUIT_BREAKER verdict lines, not by a balance notice).
    const det = detectBalance();
    if (det.balance !== null) { state.balance = det.balance; state.balanceSource = det.source; }
    if (!state.session) {
      const startBase = desiredBaseBet(login);
      // Phase 3A (owner add-on A): resume the persisted ladder first
      // — a reload resumes level/loss-count/base when the saved
      // record is fresh (24h); with no live balance known the resume
      // is balance-free (balance-derived fields zeroed, see
      // loadSessionFrom). Otherwise a fresh session.
      // Phase 3B fix: loadSessionFrom returns a { session, reason }
      // wrapper — the Phase 3A caller assigned the WRAPPER as the
      // session and tested `if (resumed)` (always truthy), so a saved
      // ladder never actually resumed and every first cycle announced
      // a bogus "Ladder resumed — level NaN". Destructure properly:
      // only a real saved session resumes; anything else is fresh.
      const saved = loadSessionFrom(safeStorage(), 'SHARED', state.balance);
      if (saved.session) {
        state.session = saved.session;
        if (saved.session.state === 'CONTINUE' || saved.session.state === 'RESET') {
          // Phase 3E: the resumed figure is the ledger figure (the
          // resize step re-derives it next cycle); the level is the
          // derived ledger level, not the loss-run counter.
          const li = ledgerLevelIndex(saved.session.nextStake, saved.session.baseBet);
          say(`Session resumed — level ${li + 1}, next ${inrStake(saved.session.nextStake)}.`, 'system');
        }
      } else {
        state.session = createSession(state.balance, { mode: ap.state.riskMode, baseBet: startBase });
      }
      try { saveSessionTo(safeStorage(), 'SHARED', state.session); } catch (e) { /* storage must never break the cycle */ }
      // Phase 3A: hold state is per-timeframe, NOT reset on session
      // start — the new rule's resets are a real BET, a fired bet,
      // or a dismissal (see the hold block in the cycle).
    }
    // One session, one truth: chips / AUTO / risk mode replan it here.
    syncSessionBase(login);

    // New settled round? (Pending picks and the displayed pick were
    // computed from the history ending at the PREVIOUS latest period,
    // so they were issued FOR this newly settled round.)
    const prevLatest = state.lastPeriodSeenByTf ? state.lastPeriodSeenByTf[tf] : null;
    if (prevLatest !== latestPeriod) {
      const isFirst = prevLatest === null;
      state.lastPeriodSeen = latestPeriod;
      if (state.lastPeriodSeenByTf) state.lastPeriodSeenByTf[tf] = latestPeriod;

      // 1) Settle the bridge's displayed pick for the round that just
      //    closed, if we had issued one. The verdict that governs the
      //    settlement is the LOCKED engine verdict for that round.
      //    Silence rule (owner's order): a NO_PICK round — or an
      //    Auto-Pilot round with no FIRED bet — produces NO win/loss
      //    sound, NO bot line, NO ladder movement and NO P&L change;
      //    it is only logged as skipped. Win/loss treatment is
      //    reserved for rounds with an actually settled governed BET.
      // Fix round (RC2): period-stamped settlement, fail closed.
      // The settled round must have an issued governed record for
      // EXACTLY this period — a jumped round (feed gap, background
      // sleep) or a switched timeframe has no record and settles
      // NOTHING here (no sound, no events, no ladder/ledger/
      // calibration movement). The decision is read from the stored
      // record, not the single-slot locker peek (which the next
      // verdict can overwrite). Skipped rounds are NOT caught up.
      const settleCheck = governedSettlementAllowed({ isFirst, lastPick: state.lastPick, picksByPeriod: state.picksByPeriod, tf, period: latestPeriod });
      if (settleCheck.allowed) {
        const won = ev(state.lastPick.target, latest.number, latest.size, latest.color);
        if (won !== null && won !== undefined) {
          const decision = settleCheck.decision;
          const fired = ap.hasFired(tf, latestPeriod);
          if (decision === GATE_DECISIONS.BET && ap.enabled && !fired) {
            // Auto-Pilot was on but the owner never fired this round:
            // a MISSED BET (PLAN.md §6) — the locked pick went
            // unplayed. Calibration still measures the pick; no
            // ladder movement, no P&L change. An engine SKIP never
            // reaches this branch, so a skip can never count as missed.
            tracker.record(state.lastPick.prob, !!won);
            recordTypeCalibration(state.lastPick.target, state.lastPick.prob, !!won);
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
            recordTypeCalibration(state.lastPick.target, state.lastPick.prob, !!won);
            const result = settleGovernedPick({
              won: !!won,
              session: state.session,
              gateDecision: decision,
              hooks: {
                playSound: type => { try { if (typeof window.playSoundEffect === 'function') window.playSoundEffect(type); } catch (e) {} }
              }
            });
            state.session = result.session;
            // Phase 3E Recovery Ledger: the SAME settlement events as
            // the ladder (this branch = ap-off every BET + ap-on
            // fired BETs). The missed-bet branch above moves NO
            // ledger; NO_PICK moves none. stakeUsed is the ledger
            // figure from the previous cycle's resize (settle() only
            // ever sees that figure as nextStake here).
            const settleType = (state.gate && state.gate.driverType)
              || (state.lastPick && (state.lastPick.target === 'BIG' || state.lastPick.target === 'SMALL') ? 'SIZE' : 'COLOR');
            if (result.session && Number.isFinite(result.session.stakeUsed) && result.session.stakeUsed > 0) {
              const L0 = loadLedger(safeStorage(), settleType);
              const upd = applyLedgerResult(L0, result.session.stakeUsed, !!won);
              saveLedger(safeStorage(), settleType, upd.L);
              // Stake redesign (owner order 2026-10-30 ~01:06 IST):
              // long-term P&L — win adds the exact 0.96x profit, loss
              // subtracts the exact stake. Persisted across sessions;
              // reset only by the owner's explicit Settings reset.
              // Manual DhaniWin-surface bets are invisible to the app
              // and are NOT in it.
              try {
                const p0 = loadPnl(safeStorage(), settleType);
                savePnl(safeStorage(), settleType, applyPnlResult(p0, result.session.stakeUsed, !!won));
              } catch (e) { /* P&L must never break settlement */ }
              // Provisional next stake from the new doubling ladder
              // (driven by the post-settlement consecutive-loss run;
              // the next cycle's resize re-derives it with the fresh
              // driver Wilson before any display or staging).
              const base = state.session.baseBet;
              const wLast = state.gate && Number.isFinite(state.gate.wilsonLowerBound) ? state.gate.wilsonLowerBound : null;
              const newLossRun = Math.max(0, (result.session && result.session.consecutiveLosses) || 0);
              const rz2 = ledgerResize(base, newLossRun, wLast, settleType, sizingBalance());
              const nextStake = rz2.stake;
              state.session.nextStake = nextStake;
              state.session.shortfall = null;
              state.session.overPlan = false;
              state.session.ledgerLevelIndex = rz2.levelIndex;
              state.session.ledgerView = { tracked: upd.L, stake: nextStake, required: rz2.required, weight: rz2.weight, shortfall: null, capped: null, levelIndex: rz2.levelIndex, level: rz2.level, gated: rz2.gated, lossRun: newLossRun };
            }
            // Phase 3A: persist the settled ladder immediately.
            try { saveSessionTo(safeStorage(), 'SHARED', state.session); } catch (e) { /* storage must never break settlement */ }
            speakSettledEvents(result.events, { lastResult: `${latest.size} ${latest.number}` });
            // Phase 3D: the anti-tilt cooldown records every settled
            // governed bet (it only raises the displayed bar — it
            // never blocks a pick or a staged bet).
            cooldown.recordSettledBet(!!won);
            if (fired) {
              const apRes = ap.settleFired({
                timeframe: tf, period: latestPeriod, won: !!won,
                stakeUsed: result.session ? result.session.stakeUsed : 0,
                sessionState: result.session ? result.session.state : null
              });
              // Phase 3D: settleFired never stops (no stops exist);
              // apRes.stopped is always false — kept for call-compat.
              if (apRes.stopped) say(apRes.reason);
            }
            renderAutoPilot();
          } else {
            // Non-BET verdict at settlement (NO_PICK): no
            // settled-event announcements — there was no pick to
            // settle, only calibration + unfired bookkeeping.
            tracker.record(state.lastPick.prob, !!won);
            recordTypeCalibration(state.lastPick.target, state.lastPick.prob, !!won);
            ap.resolveUnfired(tf, latestPeriod, 'skipped');
          }
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
              // Phase 3A: per-model calibration (observability only).
              // Records the model's RAW stated confidence — never a
              // Platt output — so ECE measures the model, not the
              // scaler. Phase 3D: EVERY catalog model is governed,
              // so every live entry is recorded (no membership
              // filter left to apply).
              if (typeof pred.conf === 'number') {
                modelCalib.record(modelId, pred.conf, !!correct, latestPeriod);
              }
            }
          }
        } else {
          // Backfill entries carry no stated confidence, so per-model
          // calibration skips them (live entries only, above).
          entries = walkForwardEntries(arenaModels(), history, history.length - 1, gen, ev, patternCtx, 'backfill');
        }
        store.recordRound(tf, latestPeriod, entries);
        store.save();
        // Phase 3A shadow feed (previously unwired — recordShadowResult
        // had zero live callers): every live entry feeds the scope
        // manager's shadow record for blacklisted models, so shadow
        // reinstatement can actually fire. LIVE BRANCH ONLY: the
        // pendingPicks guard below excludes backfill (state.pendingPicks
        // is nulled only after this block) — backfill must never feed
        // shadow, or a bulk import would fake a recovery.
        if (state.pendingPicks) {
        const blForShadow = blacklistForScope(resolveGovernanceScope(store, tf).key);
        for (const e of entries) {
          if (e && e.modelId && e.correct !== null && e.correct !== undefined) {
            blForShadow.recordShadowResult(e.modelId, !!e.correct);
          }
        }
        // Phase 3E bench feed (same live-branch guard as the shadow
        // feed: pendingPicks is nulled only after this block, so
        // backfill can never feed bench). Blacklisted ids are skipped
        // (blacklist subsumes bench, design §3); the governance step
        // below drops bench state for newly blacklisted ids.
        for (const e of entries) {
          if (e && e.modelId && e.correct !== null && e.correct !== undefined && !blForShadow.isBlacklisted(e.modelId)) {
            bench.recordLive(tf, e.modelId, !!e.correct, latestPeriod, e.pick || null);
          }
        }
        // Phase Observer rule scoring (background, forever): score
        // ALL FIVE candidate follow-rules against this settled
        // result, using the rule picks stored when the pending picks
        // were computed (pre-round evidence only — never this
        // round's result). LIVE BRANCH ONLY (same pendingPicks
        // guard as shadow/bench): backfill must never score
        // Observer's rules, or a bulk import would fake its
        // learning. A null rule pick scores nothing (a rule with no
        // pick pauses, like a model). The scored records are what
        // the next round's follow choice is measured by.
        if (state.observerRulePicks && state.observerRulePicks.tf === tf && state.observerRulePicks.byType) {
          for (const t of ['COLOR', 'SIZE', 'NUMBER']) {
            const byRule = state.observerRulePicks.byType[t];
            if (!byRule) continue;
            for (const rule of OBSERVER_RULES) {
              const rp = byRule[rule];
              if (!rp || rp.target === null || rp.target === undefined) continue;
              let correct = null;
              try { correct = ev(rp.target, latest.number, latest.size, latest.color); } catch (e) { correct = null; }
              if (correct !== null && correct !== undefined) observerRules.record(tf, t, rule, !!correct);
            }
          }
        }
        } // end live-branch-only shadow feeds
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
    //    record, or the labelled global fallback while it warms up).
    //    Phase 3D: governance runs on the WHOLE catalog (137);
    //    `pool` and `governedPool` are the same membership now.
    const { scope, pool, governedPool, bl } = governanceFor(tf);
    // The pool floor needs the rank order to break ties: one extra
    // sort per cycle over the governed pool with NO blacklist filter
    // (empty Set), so blacklisted models still have a rank.
    const floorRank = engine.rankModels(governedPool, 'overall', { blacklist: new Set() });
    const blRes = bl.update(governedPool, { rankOrder: floorRank.map(m => m.id) });
    // Phase 3E blacklist subsumption (design §3): a model that just
    // became blacklisted drops its bench state entirely — the
    // blacklist re-entry rule is the only path back for it.
    if (blRes && Array.isArray(blRes.blacklisted)) {
      for (const entry of blRes.blacklisted) bench.dropState(tf, entry && entry.id);
    }
    engine.config.blacklist = bl;
    // Phase 3A leader: the v2 §1–§2 owner rule (streak surprise +
    // Wilson margins, session rule via margins, 2-pt band) — NOT the
    // legacy streak-override engine (still used for ranking only).
    // Phase 3D: no type is ever excluded from candidacy — stops are
    // deleted, so every eligible model can lead.
    // Phase 3E: candidates = governed minus blacklisted minus
    // benched minus demoted, then v2 Steps 1–3 unchanged. Unified
    // leadership floor: if a whole type is demoted/benched at once,
    // the highest-Wilson benched/demoted model of the blacklist-
    // filtered pool leads FLAGGED (never an empty board).
    const blEligible = bl.filterEligible(governedPool);
    const benchEligible = bench.filterEligible(tf, blEligible);
    let incCandidates = benchEligible;
    let benchFloorId = null;
    if (!incCandidates.length) {
      const fm = bench.floorModel(tf, blEligible);
      if (fm) { incCandidates = [fm]; benchFloorId = fm.id; }
    }
    const ownerVerdict = selectInchargeOwnerRule(incCandidates);
    const incharge = ownerVerdict && ownerVerdict.model ? ownerVerdict.model : null;

    if (incharge && incharge.id !== state.inchargeId) {
      // Phase 3B: a routine lead change is NOT announced anymore
      // (owner order 2026-10-27 — leadership is already visible in
      // the panel; the long MODEL_CHANGE line is deleted entirely,
      // with no replacement announcement).
      state.inchargeId = incharge.id;
      state.inchargeReason = ownerVerdict.reason || null;
    } else if (incharge) {
      state.inchargeReason = ownerVerdict.reason || state.inchargeReason;
    }

    // 4) Picks for the upcoming round + gate. The governed verdict
    //    is computed ONCE per (timeframe, latest settled period) and
    //    LOCKED: history refreshes, balance updates and polls within
    //    the round reuse it verbatim, so the displayed verdict can
    //    never flip mid-round. The lock releases on period roll-over
    //    or timeframe switch (a new key).
    const picks = nextRoundPicks(arenaModels(), history, gen);
    // Phase Observer: compute (or reuse, keyed by tf:latestPeriod —
    // the verdict lock key — so a mid-round backfill can never flip
    // the pick) Observer's picks for the upcoming round from live
    // store evidence, and inject them into the pending picks.
    // genFn returns null for observer ids, so without this injection
    // Observer would never have a pick; with it, Observer's record
    // accrues exactly like every model's (live branch only — the
    // settlement above records pendingPicks entries, and backfill
    // paths never produce observer entries because genFn is null
    // for them). Candidates are the bench-eligible list (governed −
    // blacklisted − benched − demoted); observerPickFor additionally
    // filters to type and excludes observer ids, so Observer can
    // never follow itself or an excluded model. Rule records were
    // just updated by the settlement above, so the follow choice
    // uses the freshest measured evidence.
    const obsKey = tf + ':' + latestPeriod;
    if (state.observerPickKey !== obsKey) {
      const obsByType = {};
      const obsPicks = new Map();
      const obsFollow = {};
      for (const t of ['COLOR', 'SIZE', 'NUMBER']) {
        const cands = benchEligible.filter(m => String(m.predType || 'COLOR').toUpperCase() === t);
        const res = observerPickFor({ type: t, candidates: cands, picks, ruleRecords: observerRules.recordsFor(tf, t) });
        obsByType[t] = res ? res.rulePicks : null;
        if (res && res.target !== null && res.target !== undefined) {
          // Observer's pick IS the followed model's pick, so it
          // carries that pick's stated confidence (never invented;
          // null when the followed pick states none). This keeps
          // Observer-led bets' confidence display + per-model
          // calibration identical in kind to every model's.
          const followedPick = picks.get(res.followedId);
          const followedConf = followedPick && typeof followedPick.conf === 'number' ? followedPick.conf : null;
          obsPicks.set(observerIdForType(t), { target: res.target, conf: followedConf });
          obsFollow[t] = { followedId: res.followedId, followedName: res.followedName, rule: res.rule, last100Wilson: res.followedLast100Wilson, last100N: res.followedLast100N };
        }
      }
      state.observerPickKey = obsKey;
      state.observerPicks = obsPicks;
      state.observerFollow = obsFollow;
      state.observerRulePicks = { tf, byType: obsByType };
    }
    if (state.observerPicks) {
      for (const [id, pred] of state.observerPicks.entries()) picks.set(id, pred);
    }
    state.pendingPicks = picks;

    const lockKey = tf + ':' + latestPeriod;
    state.verdictKey = lockKey;
    const locked = locker.get(lockKey, () => {
      if (!incharge) {
        return {
          // Phase 2A: with the pool floor, "every model blacklisted"
          // cannot happen for a non-empty governed pool — no Incharge
          // means the governed pool has no record yet.
          gate: { decision: GATE_DECISIONS.NO_PICK, pick: null, prob: null, reason: 'No eligible Incharge model right now — the governed pool has no record yet (the pool floor keeps one model eligible whenever the pool is non-empty).' },
          pick: null,
          inchargeId: null,
          inchargeType: null,
          driverWinRate: null, driverType: null, benchFloor: null
        };
      }
      const myPick = picks.get(incharge.id) || null;
      // Phase 3E: contenders + bet-driving rank from the BENCH-
      // FILTERED list (demoted/benched models never contend or drive
      // a bet while penalised). The floor fallback below covers the
      // case where the filtered list yields no colour/size pick but
      // a bench-excluded model has one (highest Wilson, flagged).
      const ranked = engine.rankModels(bench.filterEligible(tf, bl.filterEligible(governedPool)));
      const contenders = ranked.slice(0, 3).map(m => ({ id: m.id, name: m.name, pick: picks.get(m.id) ? picks.get(m.id).target : null }));
      // Phase 3D bet-driving selection (no SKIP, no STOP): the
      // Incharge pick is stageable ONLY when it is a colour/size
      // pick from a model that is not trial-gated. Otherwise the
      // verdict shows the best remaining bet-driving pick (first
      // ranked eligible colour/size model with a pick, trial-gated
      // models excluded) — this is a PICK, never a skip. When
      // Incharge holds an exact-ball model, its digit still shows
      // as DISPLAY (exactDisplay, ball image) per the owner's rule;
      // when a trial-gated ASI/APEX model would have led, its trial
      // status rides asiTrialNote. If no colour/size pick exists at
      // all, the verdict is NO_PICK (the only honest no-pick state).
      const inchargeIsTrial = ASI_TRIAL_IDS.includes(incharge.id);
      const inchargeIsExact = (incharge.predType || 'COLOR') === 'NUMBER';
      const exactDisplay = inchargeIsExact && myPick ? { digit: myPick.target, modelId: incharge.id, modelName: incharge.name } : null;
      const asiTrialNote = inchargeIsTrial ? ASI_TRIAL_GATE_REASON : null;
      let betDriver = null;
      let betPick = null;
      if (!inchargeIsTrial && !inchargeIsExact && myPick) {
        betDriver = incharge; betPick = myPick;
      } else {
        for (const m of ranked) {
          if (ASI_TRIAL_IDS.includes(m.id)) continue;
          if ((m.predType || 'COLOR') === 'NUMBER') continue;
          const pp = picks.get(m.id);
          if (pp) { betDriver = m; betPick = pp; break; }
        }
      }
      // Phase 3E unified leadership floor, bet-driving side: when the
      // bench-filtered list yields no colour/size pick, the highest-
      // Wilson bench-excluded colour/size model with a pick drives
      // the bet FLAGGED (benchFloor) — never an empty board, never a
      // SKIP. (The Incharge-side floor above already covers the
      // whole-type-benched case; this covers a filtered list that
      // has models but no colour/size pick among them.)
      let floorDriver = null;
      if (!betDriver) {
        let bestW = -Infinity;
        for (const m of blEligible) {
          if (ASI_TRIAL_IDS.includes(m.id)) continue;
          if ((m.predType || 'COLOR') === 'NUMBER') continue;
          if (!bench.isExcluded(tf, m.id)) continue;
          const pp = picks.get(m.id);
          if (!pp) continue;
          const w = wilsonLowerBound(m.wins || 0, m.totalEvaluated || 0);
          if (w > bestW) { bestW = w; floorDriver = m; }
        }
        if (floorDriver) { betDriver = floorDriver; betPick = picks.get(floorDriver.id); }
      }
      if (!betDriver) {
        return {
          gate: { decision: GATE_DECISIONS.NO_PICK, pick: null, prob: null, reason: 'No stageable colour/size pick exists right now — no eligible model has a pick for this round.', exactDisplay, asiTrialNote },
          pick: null,
          inchargeId: incharge.id,
          inchargeType: incharge.predType || null,
          exactDisplay, asiTrialNote, observerFollow: null,
          driverWinRate: null, driverType: null, benchFloor: benchFloorId || null
        };
      }
      // Phase Observer hero line: when the bet driver IS Observer,
      // name the model it followed + that model's last-100 Wilson,
      // so the choice is checkable. Observer's OWN Wilson is the
      // number the bet is judged by (gate.wilsonLowerBound, from the
      // driver's pool entry) — never the followed model's.
      let observerFollow = null;
      if (isObserverId(betDriver.id)) {
        const f = state.observerFollow ? state.observerFollow[betDriver.predType || 'COLOR'] : null;
        if (f) observerFollow = { observerId: betDriver.id, followedId: f.followedId, followedName: f.followedName, rule: f.rule, last100Wilson: f.last100Wilson, last100N: f.last100N };
      }
      const rawConf = betPick && typeof betPick.conf === 'number' ? Math.min(0.99, Math.max(0.01, betPick.conf)) : null;
      // Phase 3A per-type calibration: the gate + Platt fit use the
      // BET DRIVER's type tracker once it matures; until then the pooled
      // tracker carries the gate (Phase 3B transitional migration —
      // see selectGateTracker: pooled history is real evidence, and
      // the per-type tracker takes over permanently at 50 records).
      const driverType = betDriver.predType || 'COLOR';
      const gateTracker = selectGateTracker({ typeTracker: trackersByType[driverType] || null, pooledTracker: tracker });
      // Displayed confidence: cap hard probabilities, then Platt-scale
      // through the fit learned from recorded outcomes.
      const calibratedProb = rawConf !== null ? displayProbability(rawConf, gateTracker) : null;
      const poolEntry = governedPool.find(m => m.id === betDriver.id) || null;
      // Strict Wilson check (owner order 2026-10-25): the bet
      // driver's defended win rate from its real wins/evaluated —
      // the same stats the engine ranking already uses (pool entries
      // carry wins + totalEvaluated). Null when no pool entry exists.
      const wilsonLower = poolEntry ? wilsonLowerBound(poolEntry.wins || 0, poolEntry.totalEvaluated || 0) : null;
      let gate = evaluateSignalGate({
        pick: betPick ? betPick.target : null,
        model: betDriver,
        sampleSize: poolEntry ? poolEntry.totalEvaluated : 0,
        wilsonLowerBound: wilsonLower,
        calibratedProb,
        calibration: gateTracker,
        contenders,
        cooldown: state.cooldownRound
      });
      // Trend / pattern learning in the pick: a proven pattern firing
      // or a strong trend AGAINST the pick is NOTED on the verdict
      // (conflict + conflictNote) — never a silent override, and
      // never a skip: the pick still shows, with the conflict named.
      // (Agreement strengthens the pick through the pattern hit-rate
      // blend inside scoreModel, fed by the persisted pattern store.)
      if (gate.decision === GATE_DECISIONS.BET) {
        const conflict = detectSignalConflict({
          pick: gate.pick,
          patternFiring: currentPatternFiring(tf),
          trend: currentTrend(tf)
        });
        if (conflict) {
          gate = { ...gate, conflict: conflict.kind, conflictNote: conflict.reason };
        }
      }
      return {
        gate,
        pick: betPick ? { target: betPick.target, prob: calibratedProb !== null ? calibratedProb : rawConf } : null,
        inchargeId: betDriver.id,
        inchargeType: betDriver.predType || null,
        exactDisplay, asiTrialNote, observerFollow,
        // Phase 3E display companions: the bet driver's raw win rate
        // (hero Chance, labelled raw), its type (ledger key + gap
        // bar), and the bench-floor flag when the pick came from a
        // bench-excluded model (Incharge floor or bet-driver floor).
        driverWinRate: poolEntry ? poolEntry.winRate : null,
        driverType,
        benchFloor: benchFloorId || (floorDriver ? floorDriver.id : null)
      };
    });

    // Phase 3D (owner order "no stop no skip"): NO overlay exists
    // anymore. The LOCKED engine verdict IS the display verdict: no
    // HARD_STOP overlay, no session-stop overlay, no hold. Safety
    // stops are deleted, so nothing stands between the engine pick
    // and the hero/staging. Login is NOT a display gate (fix round
    // #2, owner's order). The no-skip toggle is GONE (owner
    // correction 2) — its applyNoSkip helper is dormant and is NOT
    // called here.
    let gate = locked.gate;
    // Display companions ride the gate for renderers: the exact-ball
    // display (when exact holds Incharge) and the ASI trial note
    // (when a trial-gated model would have led). They are display
    // only — the stageable pick is always gate.pick.
    // Phase 3E companions: bet driver raw win rate + type (hero
    // Chance/gap/ledger key) and the bench-floor flag.
    gate.exactDisplay = locked.exactDisplay || null;
    gate.asiTrialNote = locked.asiTrialNote || null;
    gate.observerFollow = locked.observerFollow || null;
    gate.driverWinRate = locked.driverWinRate ?? null;
    gate.driverType = locked.driverType || null;
    gate.benchFloor = locked.benchFloor || null;
    // Fix round (no-pick hold): a fresh NO_PICK while models and
    // history exist must not replace the previous BET display — hold
    // the previous verdict (see holdVerdictOnNoPick). The held gate
    // flows through resize, render, staging and settlement exactly
    // like a fresh BET gate; the locker keeps the NO_PICK compute
    // for this key, so the next fresh BET still replaces the hold.
    const prevGate = state.gate;
    let heldGate = false;
    const hold = holdVerdictOnNoPick({ gate, prevGate, poolSize: governedPool.length, historyLen: history.length });
    if (hold.held) { gate = hold.gate; heldGate = true; }
    state.gate = gate;
    // Graduated stakes: the session base follows the CURRENT
    // bet driver's sample factor. The gate just ran, so take the
    // factor from it (falling back to the sample size when the gate
    // has no factor) and re-sync now — before any render or staging
    // in this cycle — so the displayed base, the staged stake and
    // the ladder all use the scaled base. syncSessionBase is
    // idempotent: it replans only when the desired base changes. A
    // tier crossing mid-ladder replans from rung 0 at the new base
    // (existing replan semantics; loss streak and P&L carry over —
    // no breaker exists anymore, the ladder just continues). Once
    // the driver passes 200 rounds the factor pins at 1.0 and
    // planning is identical to before.
    state.graduatedFactor = gate.sampleFactor ?? sampleStakeFactor(gate.sampleSize ?? 0);
    syncSessionBase(login);
    // Phase 3E Recovery Ledger resize — SOLE STAKE AUTHORITY. Runs
    // after syncSessionBase and before every render/staging in this
    // cycle, so the Bet figure, the closed pill, staging and the
    // persisted session all carry the ledger figure. The doubling
    // figure settle()/replanSession() computed is overwritten here
    // (and at settlement) before any use — the ladder is replaced,
    // not layered. Base = session baseBet (already graduated-scaled;
    // the ledger weight applies on top). W = the bet driver's Wilson
    // bound (null -> 0.25x floor). Balance anchor = the session's
    // running balance when finite and positive; balance-free chip
    // sessions get no invented shortfall (null).
    // Fix round (real-time base bet): the resize step lives at
    // closure scope (applyLedgerResize, near syncSessionBase) so the
    // synchronous chip/AUTO hook runs the SAME resize the cycle runs
    // — never a divergent formula. A held gate resizes on its own
    // (previous) driver type + Wilson.
    applyLedgerResize(gate);
    // Remember the locked pick so its outcome can settle calibration,
    // the cooldown and (when fired) the bankroll when the round lands.
    // A held round settles its HELD pick (the displayed pick), so the
    // settlement guard's record for this period matches the display.
    state.lastPick = heldGate ? (gate.pick ? { target: gate.pick, prob: gate.prob ?? null } : null) : locked.pick;

    // Governor disposition for the live app's own win/loss path: the
    // round's governed verdict + whether a bet was actually fired.
    const openP = openPeriodFor(tf);
    // Fix round (settlement-record gap): when the native open period
    // is unknown (ball minimized, Analyse tab, game frame silent),
    // key the record by the expected open period (latest settled + 1)
    // instead of writing NO record — a missing record used to make
    // the next settlement silently skip (ledger frozen, sound lost)
    // for that round. The guard still requires an exact period match.
    // A held round records its HELD pick (the displayed pick).
    const recordP = openP || expectedOpenPeriod(latestPeriod);
    if (recordP) {
      const dKey = tf + ':' + recordP;
      if (!state.dispositions[dKey]) {
        // The governed pick rides along so the road strip can pair
        // each settled result with the pick the governor made for it.
        // A NO_PICK carries NO pick: no stageable pick exists that
        // round, and the strip must never invent one for it. A BET
        // disposition carries the pick shown (the bet-driving pick,
        // never a trial-gated or exact display). NOTE: this pick is
        // the gate's pick STRING — roadCells + the history pairing
        // read it as a string; mobile.js RC1 accepts string or object.
        state.dispositions[dKey] = { decision: gate.decision, pick: gate.decision === GATE_DECISIONS.BET ? (gate.pick || null) : null, fired: ap.hasFired(tf, recordP), apOn: ap.enabled };
        const keys = Object.keys(state.dispositions);
        if (keys.length > 60) delete state.dispositions[keys[0]];
      }
      // Fix round (RC2): the same round's issued governed pick,
      // stamped for settlement verification (fail closed: settlement
      // for a period with no record here settles nothing).
      if (!state.picksByPeriod) state.picksByPeriod = {};
      if (!state.picksByPeriod[dKey]) {
        const recPick = heldGate ? (gate.pick ? { target: gate.pick, prob: gate.prob ?? null } : null) : locked.pick;
        state.picksByPeriod[dKey] = { target: recPick ? recPick.target : null, prob: recPick ? recPick.prob : null, decision: gate.decision };
        const pKeys = Object.keys(state.picksByPeriod);
        if (pKeys.length > 5) delete state.picksByPeriod[pKeys[0]];
      }
    }

    if (incharge) {
      // Orb face reflects the GOVERNED signal, not raw engine output.
      renderSignal(gate, incharge, login);
    }
    // The sheet hero follows the SAME locked verdict on every cycle,
    // incharge or not — one verdict surface, owned by the governor.
    renderHeroVerdict(gate);
    // Phase 2A display flags on the published verdict (backward-
    // compatible extra fields — the hero publish above replaces the
    // object every cycle, so these are re-applied every cycle).
    if (window.__o101Verdict) {
      window.__o101Verdict.scopeFallback = !scope.perTimeframe;
      window.__o101Verdict.thinPool = bl.filterEligible(governedPool).length < THIN_POOL_MIN;
      window.__o101Verdict.floorExemption = bl.floorExemption ? bl.floorExemption.id : null;
      window.__o101Verdict.floorExemptions = (bl.floorExemptions || []).map(e => e.id);
      // Phase 3E: bench floor + penalised count for inspection.
      window.__o101Verdict.benchFloor = gate.benchFloor || null;
      window.__o101Verdict.benchCount = bench.count(tf);
      // Fix round (no-pick hold): flag a held display verdict so any
      // surface can tell it re-shows the last real BET pick.
      window.__o101Verdict.held = heldGate;
    }
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
      // Phase 3B: no start-up greeting announcement anymore (owner
      // order 2026-10-27 — the first verdict speaks for itself).
      if (!(ap.enabled && gate.decision === GATE_DECISIONS.BET)) {
        // Phase 3D: only BET speaks. NO_PICK (empty pool) stays
        // silent — there is no pick to announce, and no SKIP line
        // exists anymore.
        if (gate.decision === GATE_DECISIONS.BET) speakEvent(BOT_EVENTS.SIGNAL_BET);
      }
      // Axo AI readout: the regime label refreshes on a BET lock
      // only — never on a SKIP, never per tick (PLAN.md §7).
      if (gate.decision === GATE_DECISIONS.BET) axoRegimeRefresh();
    }

    renderRanking(tf, governedPool, bl, scope);
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
    NONE: 'text-2xl font-black tracking-tight mt-0.5 text-zinc-500'
  };
  function renderHeroVerdict(gate) {
    const view = heroVerdictView(gate);
    // Publish the lock first: native renders mirror it verbatim.
    // Phase 3D decisions are BET / NO_PICK / NONE, plus the display
    // companions (exactDisplay, asiTrialNote) for inspection.
    // Phase 3E: + Chance/Wilson/gap/tag/ledger line + bench floor
    // (the closed pill reads wilson + stake from here).
    window.__o101Verdict = { decision: view.decision, pick: view.pick, confText: view.confText, reason: view.reasonText || '', key: state.verdictKey || null, exactDisplay: gate.exactDisplay || null, asiTrialNote: gate.asiTrialNote || null, chanceText: view.chanceText || '', wilsonText: view.wilsonText || '', gapText: view.gapText || '', qualityTag: view.qualityTag || '', observerLine: view.observerLine || '', ledgerLine: view.ledgerLine || '', wilson: Number.isFinite(gate.wilsonLowerBound) ? gate.wilsonLowerBound : null, benchFloor: gate.benchFloor || null };
    if (state.page !== 'mobile') return;
    const targetEl = $('mobileWebTargetDisplay');
    if (targetEl) {
      // Phase 3A ball image (governed picks only, never SKIP): a
      // digit pick shows its systems/balls.js PNG at 24px beside the
      // text, and Phase 3B letter picks (BIG/SMALL/GREEN/RED/VIOLET)
      // show their systems/letter-balls.js glossy sphere at the same
      // size. The axo.lastHeroBall key guard avoids re-parsing the
      // ~20KB data URI on every 3s cycle; a missing ballImg (or an
      // empty string) falls back to plain text, never a blank.
      const ballKey = view.decision === 'BET' && view.ballDigit ? `${view.ballDigit}:${view.decision}` : null;
      if (ballKey && typeof window.ballImg === 'function') {
        if (axo.lastHeroBall !== ballKey) {
          axo.lastHeroBall = ballKey;
          const img = window.ballImg(view.ballDigit, 24, '');
          if (img) {
            targetEl.innerHTML = '';
            targetEl.insertAdjacentHTML('beforeend', img);
            const t = document.createElement('span');
            t.textContent = view.targetText;
            targetEl.appendChild(t);
          } else {
            axo.lastHeroBall = null;
            targetEl.textContent = view.targetText;
          }
        }
      } else {
        axo.lastHeroBall = null;
        targetEl.textContent = view.targetText;
      }
      // Canonical class on every render: the target's size can never
      // jump because another writer left a different size class on it.
      targetEl.className = HERO_TARGET_CLASSES[view.decision === 'BET' ? (view.pick || 'NONE') : view.decision] || HERO_TARGET_CLASSES.NONE;
    }
    // Fix round #3: the hero verdict carries its icon too — size
    // arrow or colour dot — re-asserted on every cycle so the hero
    // never shows a stale verdict's icon.
    // Fix round #4: the opened avatar's badge follows the same
    // cycle, and clears whenever there is no live verdict.
    setVerdictIcon(view.decision === 'BET' ? verdictIconFor(view.pick, 'BET').kind : null);
    setAxoPredictionBadge(badgeFromView(view));
    const conf = $('assistantConfBadge');
    if (conf) conf.textContent = view.confText;
    // Panel text (mobile.html #mobileWebVerdictReason +
    // #mobileWebVerdictDetail, under NEXT PREDICTION). Owner order
    // 2026-10-27: NO long text inside the window — a BET writes
    // neither its reason nor its detail line (heroPanelTextFor
    // returns both empty for BET); NO_PICK still shows its one
    // short reason line. Cleared + hidden on empty so no stale
    // text and no blank gap ever outlive their verdict.
    const panelText = heroPanelTextFor(view);
    const why = $('mobileWebVerdictReason');
    if (why) {
      why.textContent = panelText.reason;
      why.classList.toggle('hidden', !panelText.reason);
    }
    const detailEl = $('mobileWebVerdictDetail');
    if (detailEl) {
      detailEl.textContent = panelText.detail;
      detailEl.classList.toggle('hidden', !panelText.detail);
    }
    const ledgerEl = $('mobileWebLedgerLine');
    if (ledgerEl) {
      ledgerEl.textContent = view.decision === 'BET' ? (view.ledgerLine || '') : '';
    }
    // Exact-ball display / ASI trial note (mobile.html
    // #mobileWebExactDisplay, under the reason). Exact shows only
    // when an exact-ball model holds Incharge (display only, never
    // a stageable bet); the trial note shows only when a
    // trial-gated ASI/APEX model would have led.
    const exactEl = $('mobileWebExactDisplay');
    if (exactEl) {
      if (gate.exactDisplay && gate.exactDisplay.digit) {
        exactEl.textContent = `Exact ball ${gate.exactDisplay.digit} (display only — payout unverified).`;
      } else if (gate.asiTrialNote) {
        exactEl.textContent = gate.asiTrialNote;
      } else {
        exactEl.textContent = '';
      }
    }
    // Task L: the sheet grows to its measured content on every
    // verdict render, so no verdict can clip the chip row.
    fitSheetToContent();
  }

  function renderSignal(gate, incharge, login) {
    // Phase 3D: the Bet figure shows for BET verdicts only (the
    // governed session's nextStake). Anything else shows '—'.
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
        baseEl.textContent = state.session ? inrStake(state.session.baseBet) : '—';
      }
      // AUTO base anchor (owner order 2026-10-30 ~10:36 IST): when
      // the AUTO base is anchored to a balance, the Base line shows
      // the anchor — "Base ₹X · 1% of ₹Y". Manual chips and
      // unknown-balance sessions show the figure alone.
      const anchorEl = $('assistantBaseAnchorDisplay');
      if (anchorEl) {
        const showAnchor = !!(state.session && ap.state.autoBase && state.baseAnchorBalance);
        anchorEl.textContent = showAnchor
          ? autoAnchorLabel(state.baseAnchorBalance, state.baseAnchorFraction)
          : '';
      }
      const betEl = $('mobileWebStakeDisplay');
      if (betEl) betEl.textContent = bet && state.session ? inrStake(state.session.nextStake) : '—';
      // Phase 3D corrected ladder (owner order 2026-10-27 ~10:38):
      // when the doubled stake exceeds a known balance, show the
      // REQUIRED stake (the Bet figure above) + the shortfall
      // plainly; when the ladder runs past its planned depth, say
      // so. Staging is NEVER blocked on either — the user decides
      // with the per-bet tap. Balance-free sessions show the
      // over-plan note only (no balance anchor exists to measure
      // a shortfall against, so none is invented).
      // Phase 3E: the ledger replaces the ladder — the shortfall
      // line now reads the ledger's over-balance view (required +
      // shortfall + capped stake, never a silent reduction, never a
      // block). The planned-depth line is gone: rung caps are an
      // affordability ceiling only, not a progression.
      const shortEl = $('mobileWebShortfallDisplay');
      if (shortEl) {
        const parts = [];
        const lv = state.session ? state.session.ledgerView : null;
        if (lv && lv.shortfall !== null && lv.shortfall !== undefined && lv.shortfall > 0) {
          parts.push(`Needs ${inrStake(lv.shortfall)} more than balance (required ${inrStake(lv.required)}, fits ${inrStake(lv.capped)}).`);
        } else if (state.session && state.session.shortfall !== null && state.session.shortfall !== undefined && state.session.shortfall > 0) {
          parts.push(`Needs ${inrStake(state.session.shortfall)} more than balance.`);
        }
        shortEl.textContent = parts.join(' ');
      }
      const levelEl = $('mobileWebLevelBadge');
      if (levelEl) {
        // Phase 3E: derived ledger level (log2 of stake/base), not
        // the session loss-run counter — the ladder is retired.
        const li = state.session && Number.isFinite(state.session.ledgerLevelIndex) ? state.session.ledgerLevelIndex : null;
        levelEl.textContent = state.session && li !== null && li > 0
          ? `Level ${li + 1} (Recovery)`
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
      // Phase 3D: a no-pick round shows '–', never an invented
      // pick — the strip stays honest about what the governor
      // actually called that period.
      const disp = state.dispositions[`${tf}:${c.period}`] || null;
      const noPick = disp && disp.decision === GATE_DECISIONS.NO_PICK;
      const pickHtml = noPick ? '–' : esc(c.pickLetter || '–');
      return `<div class="flex flex-col items-center shrink-0 px-1" title="Period #${esc(shortPeriod(c.period))} — result ${esc(c.result)}, governed pick ${esc(c.pick || (noPick ? 'no pick' : 'none'))}">
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
    // Stake redesign (owner order 2026-10-30 ~01:06 IST): the minimal
    // P&L box above the Axo widget — long-term cumulative P&L,
    // +₹X profit / −₹X loss, same dark-matte theme. Rendered before
    // the ball's early-return key so it updates on settlement even
    // when the verdict is unchanged. pointer-events:none in markup —
    // it never blocks orb taps or drag.
    try {
      const pnlBox = $('axoPnlBox');
      if (pnlBox) {
        const total = totalPnl(safeStorage());
        const txt = pnlBoxText(total);
        if (pnlBox.textContent !== txt) pnlBox.textContent = txt;
        pnlBox.style.color = total > 0 ? '#6ee7b7' : total < 0 ? '#fda4af' : '#a1a1aa';
      }
    } catch (e) { /* the P&L box must never break the orb render */ }
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
    // Phase 3D: the closed orb's badge shows the governed stake
    // alongside the prediction on BET verdicts — the SAME nextStake
    // figure the hero's Bet figure uses, through the same render
    // path — and '—' otherwise, so the badge never invites betting
    // a round with no pick. The render key includes the stake text,
    // so the badge updates when the stake changes. The pill keeps
    // pointer-events-none (drag safe) and the orb's position/size
    // are untouched (clamp unaffected).
    // Phase 3E: the closed pill is pick · Wilson% · stake (Wilson
    // from the published verdict; the stake is the ledger figure).
    const pillView = closedOrbPill({ decision: v ? v.decision : null, pick: v ? v.pick : null, stake: state.session ? state.session.nextStake : null, wilson: v ? v.wilson : null });
    // Fix round (ball-only, owner order 2026-10-27): the Axo widget
    // shows ONLY the prediction ball — no pill text, no road line,
    // no verdict icon. The render key is the ball alone, so a text
    // or road change can never re-render text back in. Ball-below-
    // Axo (owner order 2026-10-27): the ball sits BELOW the face
    // (mobile.html #floatingOrbTarget, top below the ring) at 32px
    // — double the old 16px — so it is big and visible.
    const key = JSON.stringify([pillView.state, pillView.ballDigit]);
    if (key === axo.lastOrbKey) return;
    axo.lastOrbKey = key;
    if (pill) {
      const ballHtml = pillView.ballDigit && typeof window.ballImg === 'function' ? window.ballImg(pillView.ballDigit, 32, '') : '';
      if (ballHtml) {
        pill.innerHTML = ballHtml;
        pill.classList.remove('hidden');
      } else {
        // No ball to show (no BET pick): hide the pill entirely —
        // never a text fallback, never a blank.
        pill.innerHTML = '';
        pill.classList.add('hidden');
      }
    }
    const orbIcon = $('orbVerdictIcon');
    if (orbIcon) {
      orbIcon.innerHTML = '';
      orbIcon.classList.add('hidden');
    }
    if (bar) {
      bar.textContent = '';
      bar.classList.add('hidden');
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
  function rowHtml(rank, m, stats, wilson, calibLabel = '') {
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
        <div class="text-[8px] font-mono text-zinc-500">W ${stats ? stats.wins : 0} · L ${stats ? stats.losses : 0} · n ${stats ? stats.evaluated : 0} · Wilson ${(wilson * 100).toFixed(1)} · recent ${recent} · streak ${stats ? stats.streak : 0}${calibLabel ? ` · ${calibLabel}` : ''}</div>
      </div>
    </div>`;
  }

  function renderRanking(tf, pool, bl, scope) {
    const listEl = $('bridgeRankingList');
    const blEl = $('bridgeBlacklistList');
    const doEl = $('bridgeDisplayOnlyList');
    const benchEl = $('bridgeBenchList');
    const trendEl = $('bridgeTrendList');
    const obsEl0 = $('bridgeObserverList');
    if (!listEl && !blEl && !doEl && !benchEl && !trendEl && !obsEl0) return;
    const scopeKey = scope ? scope.key : tf;
    // Phase 3E: the ranked list excludes demoted/benched models
    // (they cannot lead or drive a bet while penalised); the bench
    // card below names them instead. The blacklist filter stays.
    const ranked = engine.rankModels(bench.filterEligible(tf, bl.filterEligible(pool)));
    if (listEl) {
      listEl.innerHTML = ranked.map((m, i) => {
        const stats = scopeKey === 'ALL' ? mergedModelStats(store, m.id) : store.modelStats(tf, m.id);
        // Phase 2A: the Wilson column is the TRUE Wilson bound from
        // the model's own wins/evaluated. The old code passed
        // scoreModel(m) — a recency/pattern blend (and, in UCB mode,
        // called without totalEvaluatedAll, so not even a valid UCB
        // score) — while labelling it "Wilson". Display only.
        const wilson = wilsonLowerBound(stats ? stats.wins || 0 : 0, stats ? stats.evaluated || 0 : 0);
        const calib = modelCalib.stats(m.id);
        return rowHtml(i + 1, m, stats, wilson, `Cal: ${calib.label}`);
      }).join('');
    }
    const meta = $('bridgeRankingMeta');
    if (meta) {
      // Phase 3A: per-type ECE figures (type named) replace the pooled
      // line — calibration is per-type now, so a pooled figure would
      // hide which type is miscalibrated. The pooled tracker still
      // records (legacy display) but no longer gates anything.
      const flags = [];
      if (ranked.length < THIN_POOL_MIN) flags.push('thin pool');
      if (scope && !scope.perTimeframe) flags.push('global fallback scope');
      const ecePart = ['COLOR', 'SIZE', 'NUMBER'].map(t => {
        const tr = trackersByType[t];
        const n = tr ? tr.count : 0;
        return `${t} ECE ${n > 0 ? tr.expectedCalibrationError().toFixed(3) : '—'} (n=${n})`;
      }).join(' · ');
      meta.textContent = `${ranked.length} models · ${store.recordedPeriodCount(tf)} rounds recorded · ${tf} · scope: ${scope ? scope.label : tf}${flags.length ? ' · ' + flags.join(' · ') : ''} · ${ecePart}`;
    }
    if (blEl) {
      const entries = bl.list();
      // Phase 3A: render ALL per-type floor exemptions (not just the
      // singular compat field) + a Restore button per blacklisted
      // row (manual unblacklist — property handlers, never inline
      // onclick attributes). Reasons name metric + window + samples
      // (the manager builds them); nothing is silently blacklisted.
      const exemptions = (bl.floorExemptions && bl.floorExemptions.length ? bl.floorExemptions : (bl.floorExemption ? [bl.floorExemption] : []));
      const floorNote = exemptions.map(fx => `<div class="px-3 py-2 rounded-xl bg-amber-500/[0.06] border border-amber-500/20">
        <div class="text-[10px] font-bold text-amber-200">Pool floor${fx.type ? ` (${fx.type})` : ''}: ${fx.name} kept eligible</div>
        <div class="text-[8px] font-mono text-zinc-400">${fx.reason} (Wilson ${(fx.wilson * 100).toFixed(1)}%, ${fx.samples} samples).</div>
      </div>`).join('');
      const escAttr = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      blEl.innerHTML = floorNote + (entries.length ? entries.map(e => `<div class="px-3 py-2 rounded-xl bg-rose-500/[0.06] border border-rose-500/20">
        <div class="flex items-center justify-between gap-2"><div class="text-[10px] font-bold text-rose-200">${e.name}</div><button data-unblacklist="${escAttr(e.id)}" class="shrink-0 px-2 py-0.5 rounded-full bg-white/10 text-zinc-200 border border-white/10 text-[9px] font-bold">Restore</button></div>
        <div class="text-[8px] font-mono text-zinc-400">${e.reason}</div>
        <div class="text-[8px] font-mono text-zinc-500">WR ${(e.winRate * 100).toFixed(1)}% · samples ${e.samples} · ${e.shadowStatus}</div>
      </div>`).join('') : '<div class="text-[9px] font-mono text-zinc-500 px-1 py-2">No models are blacklisted right now. Blacklist is evidence-based: a model is blacklisted only on a Wilson bound below its type bar across 2 consecutive windows (thin models are never blacklisted). Bench (below) is separate: 3 straight walk-forward wrongs, cleared after 10 rounds with no 4-loss streak.</div>');
      blEl.querySelectorAll('[data-unblacklist]').forEach(btn => {
        btn.onclick = () => { try { window.__o101Unblacklist(btn.getAttribute('data-unblacklist')); } catch (e) {} };
      });
    }
    // Phase 3E bench card (Analyse): every demoted/benched model
    // with its flag, the benching rounds, restoration progress x/10
    // clean rounds, times benched, and a manual unbench button.
    // Bench is rotation, not punishment: a model returns to NORMAL
    // after 10 consecutive walk-forward rounds with no 4-loss streak
    // (a 4-streak inside the window restarts the clock and
    // re-benches). The manual button restores immediately.
    if (benchEl) {
      const rows = bench.list(tf);
      const escAttr = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const benchMeta = $('bridgeBenchMeta');
      if (benchMeta) {
        benchMeta.textContent = rows.length
          ? `${rows.length} model${rows.length === 1 ? '' : 's'} penalised on ${tf} (demoted at 2 straight wrongs, benched at 3; restore after 10 rounds with no 4-loss streak).`
          : `No models penalised on ${tf} right now.`;
      }
      benchEl.innerHTML = rows.length ? rows.map(s => {
        const model = (pool || []).find(m => m.id === s.id);
        const name = model ? (model.name || s.id) : s.id;
        const unbenchBtn = s.status === 'benched'
          ? `<button data-unbench="${escAttr(s.id)}" class="shrink-0 px-2 py-0.5 rounded-full bg-white/10 text-zinc-200 border border-white/10 text-[9px] font-bold">Unbench</button>`
          : '';
        return `<div class="px-3 py-2 rounded-xl ${s.status === 'benched' ? 'bg-amber-500/[0.06] border border-amber-500/20' : 'bg-white/[0.03] border border-white/10'}">
        <div class="flex items-center justify-between gap-2"><div class="text-[10px] font-bold ${s.status === 'benched' ? 'text-amber-200' : 'text-zinc-200'}">${name} · ${benchStatusLabel(s.status)}</div>${unbenchBtn}</div>
        <div class="text-[8px] font-mono text-zinc-400">Benching rounds: ${benchRoundsText(s)}</div>
        <div class="text-[8px] font-mono text-zinc-500">${benchProgressText(s)} · benched ${s.timesBenched}× this record · current wrong-run ${s.run}</div>
      </div>`;
      }).join('') : '<div class="text-[9px] font-mono text-zinc-500 px-1 py-2">No demoted or benched models on this timeframe.</div>';
      benchEl.querySelectorAll('[data-unbench]').forEach(btn => {
        btn.onclick = () => { try { window.__o101Unbench(tf, btn.getAttribute('data-unbench')); } catch (e) {} };
      });
    }
    // Phase 3E trend signals S2–S5 (Analyse): DISPLAY ONLY. None of
    // these touches leader selection until a harness PASS on real
    // TEST data + the owner's word (no TEST data exists yet). S1,
    // bench rotation itself, is the live mechanism above.
    if (trendEl) renderTrendSection(tf, trendEl, scopeKey);
    // Phase Observer card (Analyse): current follow per type, top-5
    // followed-model table, Observer's own record + status, rule
    // records, pattern findings (fired>=20 floor), and the
    // always-visible confidence-limits box. DISPLAY ONLY — this
    // renderer never touches selection, bench, or blacklist state.
    const obsEl = $('bridgeObserverList');
    if (obsEl) renderObserverSection(tf, obsEl, pool, bl, scopeKey);
  }

  // Phase Observer card (Analyse). Pure reads over the store, the
  // bench manager, the blacklist, and the persisted rule records.
  // Returns nothing; writes the card's innerHTML. Observer's status
  // here is its EVALUATION state — there is no trial gate and no
  // flag: Observer leads only when its own record wins the normal
  // Incharge competition, exactly like every model.
  function renderObserverSection(tf, obsEl, pool, bl, scopeKey) {
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const pct = w => (w === null || w === undefined || !Number.isFinite(w)) ? '—' : (w * 100).toFixed(1) + '%';
    const eligible = bench.filterEligible(tf, bl.filterEligible(pool));
    const benchStates = {};
    try {
      for (const s of bench.list(tf)) benchStates[s.id] = s.status;
    } catch (e) { /* bench list failure must never break the card */ }
    const sections = [];
    for (const t of ['COLOR', 'SIZE', 'NUMBER']) {
      const oid = observerIdForType(t);
      const model = (pool || []).find(m => m.id === oid);
      const name = model ? (model.name || oid) : oid;
      const stats = scopeKey === 'ALL' ? mergedModelStats(store, oid) : store.modelStats(tf, oid);
      const evaluated = stats ? stats.evaluated : 0;
      const wins = stats ? stats.wins : 0;
      const raw = stats ? stats.winRate : null;
      const wilson = stats ? wilsonLowerBound(wins, evaluated) : null;
      const streak = stats ? stats.streak : 0;
      const bStatus = benchStates[oid] || 'normal';
      const blacklisted = bl.isBlacklisted(oid);
      const leading = state.inchargeId === oid;
      let status;
      if (blacklisted) status = 'Blacklisted (evidence-based, 2-window rule) — cannot lead until reinstated.';
      else if (bStatus === 'benched') status = 'Benched — returns after 10 rounds with no 4-loss streak.';
      else if (bStatus === 'demoted') status = 'Demoted — returns after 10 rounds with no 4-loss streak.';
      else if (leading) status = 'Incharge now — its own record won the normal Incharge competition.';
      else if (!stats) status = 'Observed, not yet ranked — its record must win the normal Incharge competition first.';
      else status = 'Observed — not yet Incharge. Its record must win the normal Incharge competition first.';
      if (t === 'NUMBER') status += ' Display only — exact payout unverified (O4).';
      const follow = state.observerFollow ? state.observerFollow[t] : null;
      const followLine = follow
        ? `Following ${esc(follow.followedId)} via ${esc(OBSERVER_RULE_LABELS[follow.rule] || follow.rule || '—')} · last-100 Wilson ${pct(follow.last100Wilson)} (n=${follow.last100N || 0})`
        : 'No follow this round — no eligible model has a pick.';
      const top5 = rankFollowCandidates(eligible, t).slice(0, 5);
      const top5Html = top5.length ? top5.map((m, i) => `<div class="text-[8px] font-mono text-zinc-400 px-1">${i + 1}. ${esc(m.id)} · last-100 ${pct(m.last100Wilson)} (n=${m.last100N}) · full ${pct(m.fullWilson)} (n=${m.totalEvaluated || 0}) · streak ${m.streak || 0}</div>`).join('')
        : '<div class="text-[8px] font-mono text-zinc-500 px-1">No eligible models of this type yet.</div>';
      const recs = observerRules.recordsFor(tf, t);
      const best = chooseRule(recs);
      const ruleHtml = OBSERVER_RULES.map(rule => {
        const r = recs[rule];
        const w = ruleWilson(r);
        return `<div class="text-[8px] font-mono text-zinc-400 px-1">${esc(OBSERVER_RULE_LABELS[rule])}: ${r.wins}/${r.evaluated} · Wilson ${w >= 0 ? pct(w) : '—'}${rule === best ? ' · current' : ''}</div>`;
      }).join('');
      const pats = store.patternSummaryFor(scopeKey, oid).filter(p => p.fired >= 20).slice(0, 3);
      const anyPats = store.patternSummaryFor(scopeKey, oid).length > 0;
      const patHtml = pats.length
        ? pats.map(p => `<div class="text-[8px] font-mono text-zinc-400 px-1">${esc(p.name)} · fired ${p.fired} · hits ${p.hits} · Wilson ${pct(wilsonLowerBound(p.hits, p.fired))}</div>`).join('')
        : (anyPats
          ? '<div class="text-[8px] font-mono text-zinc-500 px-1">Patterns firing, but too few firings to judge (fired &lt; 20).</div>'
          : '<div class="text-[8px] font-mono text-zinc-500 px-1">No pattern found yet.</div>');
      sections.push(`<div class="px-3 py-2 rounded-xl bg-white/[0.03] border border-white/10">
        <div class="text-[10px] font-bold text-white">${esc(name)} (${t})${leading ? ' 👑' : ''}</div>
        <div class="text-[8px] font-mono text-zinc-400">Record: ${wins}/${evaluated} · raw ${raw !== null ? (raw * 100).toFixed(1) + '%' : '—'} · Wilson ${pct(wilson)} · streak ${streak}</div>
        <div class="text-[8px] font-mono text-zinc-400">${esc(status)}</div>
        <div class="text-[8px] font-mono text-zinc-300 pt-1">${followLine}</div>
        <div class="text-[8px] font-mono font-bold text-zinc-400 pt-1">Top-5 followed models (last-100 Wilson order):</div>
        ${top5Html}
        <div class="text-[8px] font-mono font-bold text-zinc-400 pt-1">Follow-rule records (background, every live round):</div>
        ${ruleHtml}
        <div class="text-[8px] font-mono font-bold text-zinc-400 pt-1">Pattern findings (fired ≥ 20 only):</div>
        ${patHtml}
      </div>`);
    }
    obsEl.innerHTML = sections.join('') + `<div class="px-3 py-2 rounded-xl bg-amber-500/[0.06] border border-amber-500/20">
      <div class="text-[8px] font-mono text-amber-200">Observer follows recent-form evidence. It has not demonstrated an edge above the bar on held-out TEST rounds. It does not know how draws are generated.</div>
    </div>`;
  }

  // Phase 3E trend display (S2–S5). Pure reads + one throttled,
  // visibility-gated consensus computation. Returns nothing; writes
  // the trend card's innerHTML. Never mutates selection, bench, or
  // blacklist state. governanceFor for other timeframes is read-only
  // except state.scopeKey/scopeLabel, which are saved + restored.
  function renderTrendSection(tf, trendEl, scopeKey) {
    const leaderId = state.inchargeId;
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const leader = leaderId ? (arenaModels().find(m => m.id === leaderId) || null) : null;
    const leaderName = leader ? (leader.name || leaderId) : '—';
    const stats = leaderId ? (scopeKey === 'ALL' ? mergedModelStats(store, leaderId) : store.modelStats(tf, leaderId)) : null;
    const lines = [];
    lines.push('<div class="text-[8px] font-mono text-zinc-500 px-1 pb-1">Trend signals — display only, never change leadership (harness PASS on real TEST data + owner word required before any signal touches selection).</div>');
    // S2: last-100 Wilson recent-form (replaces the raw last-100 rate
    // that flukes: 52/100 raw looks fine, its Wilson bound does not).
    if (stats && stats.recentEvaluated) {
      const w = wilsonLowerBound(stats.recentWins || 0, stats.recentEvaluated);
      lines.push(`<div class="text-[9px] font-mono text-zinc-300 px-1">S2 recent-form (last 100): leader ${esc(leaderName)} — Wilson ${(w * 100).toFixed(1)}% (raw ${(stats.recentWinRate * 100).toFixed(1)}%, n=${stats.recentEvaluated})</div>`);
    } else {
      lines.push(`<div class="text-[9px] font-mono text-zinc-500 px-1">S2 recent-form: no last-100 record for the leader yet.</div>`);
    }
    // S3: leader-health slope, last-20 vs prior-20 (tie-break only).
    if (leaderId) {
      const rec = store.recentArray(tf, leaderId);
      if (rec.length >= 40) {
        const last20 = rec.slice(-20);
        const prior20 = rec.slice(-40, -20);
        const a = last20.reduce((x, y) => x + y, 0) / 20;
        const b = prior20.reduce((x, y) => x + y, 0) / 20;
        const slope = (a - b) * 100;
        lines.push(`<div class="text-[9px] font-mono text-zinc-300 px-1">S3 leader-health slope: ${slope >= 0 ? '+' : ''}${slope.toFixed(1)} pts (last-20 ${(a * 100).toFixed(0)}% vs prior-20 ${(b * 100).toFixed(0)}%) — tie-break only</div>`);
      } else {
        lines.push(`<div class="text-[9px] font-mono text-zinc-500 px-1">S3 leader-health slope: needs 40 rounds (has ${rec.length}).</div>`);
      }
    }
    // S4: cross-timeframe consensus (same pick direction led on ≥3 of
    // 4 timeframes, tie-break boost only). Throttled: at most one
    // computation per 60s, only while the card is visible, and only
    // when some timeframe's latest settled round moved.
    const s4 = trendConsensus(tf, trendEl);
    lines.push(`<div class="text-[9px] font-mono text-zinc-300 px-1">S4 consensus: ${s4}</div>`);
    // S5: per-leader calibration drift, last-50 ECE vs full ECE
    // (per-type buckets only; session records only — modelCalib is
    // session-scoped, so drift resets on reload).
    if (leaderId) {
      try {
        const recs = modelCalib.recordsFor(leaderId) || [];
        if (recs.length >= 50) {
          const full = expectedCalibrationError(recs);
          const last50 = expectedCalibrationError(recs.slice(-50));
          lines.push(`<div class="text-[9px] font-mono text-zinc-300 px-1">S5 calibration drift (session): leader ECE full ${full.toFixed(3)} vs last-50 ${last50.toFixed(3)} (n=${recs.length}) — display only</div>`);
        } else {
          lines.push(`<div class="text-[9px] font-mono text-zinc-500 px-1">S5 calibration drift: too few session records (n=${recs.length}, needs 50).</div>`);
        }
      } catch (e) {
        lines.push(`<div class="text-[9px] font-mono text-zinc-500 px-1">S5 calibration drift: unavailable.</div>`);
      }
    }
    trendEl.innerHTML = lines.join('');
  }

  // S4 consensus computation (display only). Returns a plain string.
  // Visibility-gated (hidden card -> stale text kept, no compute)
  // and throttled (60s + settled-round movement) so the 4-timeframe
  // governance + pick computation cannot tax every 3s cycle.
  function trendConsensus(tf, trendEl) {
    const el = trendEl || $('bridgeTrendList');
    if (!el || el.offsetParent === null) return state.trendS4Text || 'card hidden — consensus computes when Analyse is open.';
    const TFS = ['30s', '1m', '3m', '5m'];
    const keyParts = [];
    for (const t of TFS) {
      try {
        const h = settledHistory(t) || [];
        keyParts.push(`${t}:${h.length}:${h.length ? (h[h.length - 1].issueNumber || h[h.length - 1].period || '') : ''}`);
      } catch (e) { keyParts.push(`${t}:?`); }
    }
    const key = keyParts.join('|');
    const now = Date.now();
    if (state.trendS4Key === key && state.trendS4Text && (now - (state.trendS4At || 0)) < 60000) return state.trendS4Text;
    let text = 'unavailable';
    try {
      const saveKey = state.scopeKey;
      const saveLabel = state.scopeLabel;
      const gen = genFn();
      const counts = {};
      const who = {};
      if (gen) {
        for (const t of TFS) {
          try {
            const g = governanceFor(t);
            let cands = bench.filterEligible(t, g.bl.filterEligible(g.governedPool));
            if (!cands.length) {
              const fm = bench.floorModel(t, g.bl.filterEligible(g.governedPool));
              if (fm) cands = [fm];
            }
            const v = selectInchargeOwnerRule(cands);
            if (v && v.model) {
              const picks = nextRoundPicks(arenaModels(), settledHistory(t), gen);
              const pp = picks.get(v.model.id);
              if (pp && pp.target) {
                counts[pp.target] = (counts[pp.target] || 0) + 1;
                (who[pp.target] = who[pp.target] || []).push(t);
              }
            }
          } catch (e) { /* one timeframe failing must not kill S4 */ }
        }
      }
      state.scopeKey = saveKey;
      state.scopeLabel = saveLabel;
      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (!entries.length) {
        text = 'no leader pick on any timeframe yet.';
      } else {
        const [dir, n] = entries[0];
        text = n >= 3
          ? `${dir} leads on ${n}/4 timeframes (${who[dir].join(', ')}) — tie-break boost only`
          : `split (best ${dir} on ${n}/4) — no consensus boost`;
      }
    } catch (e) {
      text = 'unavailable';
    }
    state.trendS4Key = key;
    state.trendS4Text = text;
    state.trendS4At = now;
    return text;
  }

  // ── Task J: one-tap history export ─────────────────────────────
  // Share-first (the APK WebView has no native download listener,
  // so a Blob download may do nothing there — the Android share
  // sheet is the reliable route on the phone), Blob download as the
  // fallback for browsers. A user-cancelled share stops quietly
  // instead of falling through to an unwanted download.
  async function exportHistory() {
    const ms = (typeof window !== 'undefined') ? window.MobileState : null;
    const liveByTf = {};
    const deepByTf = {};
    const tfSet = new Set([
      ...Object.keys((ms && ms.historyByTf) || {}),
      ...Object.keys((ms && ms.deepHistoryByTf) || {})
    ]);
    for (const tf of tfSet) {
      try { liveByTf[tf] = settledHistory(tf); } catch (e) { liveByTf[tf] = []; }
      deepByTf[tf] = (ms && ms.deepHistoryByTf && ms.deepHistoryByTf[tf]) || [];
    }
    const modelsByTf = {};
    for (const tf of tfSet) {
      try { modelsByTf[tf] = governanceFor(tf).pool; } catch (e) { modelsByTf[tf] = []; }
    }
    // Phase 3A FORMAT CHANGE (report it): the export calibration
    // payload is now a per-type map, not pooled {count, ece} — any
    // consumer reading .count/.ece must read per type instead.
    let calib = null;
    try {
      calib = {};
      for (const t of ['COLOR', 'SIZE', 'NUMBER']) {
        const tr = trackersByType[t];
        calib[t] = tr ? { count: tr.count, ece: tr.expectedCalibrationError() } : { count: 0, ece: null };
      }
    } catch (e) { calib = null; }
    const payload = buildHistoryExport({
      liveByTf,
      deepByTf,
      dispositions: state.dispositions,
      fired: (ap && ap.state && ap.state.fired) || {},
      modelsByTf,
      calibration: calib,
      evaluateWin: evalFn()
    });
    const text = JSON.stringify(payload, null, 2);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const filename = `o101-history-${stamp}.json`;
    try {
      const file = new File([text], filename, { type: 'application/json' });
      if (typeof navigator !== 'undefined' && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: '01.01 history' });
        return 'shared';
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // Any other share failure falls through to the download below.
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return 'downloaded';
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
      const upd = g.bl.update(g.governedPool);
      // Phase 3E: same blacklist-subsumes-bench rule as the cycle.
      if (upd && Array.isArray(upd.blacklisted)) {
        for (const entry of upd.blacklisted) bench.dropState(tfNow, entry && entry.id);
      }
      renderRanking(tfNow, g.governedPool, g.bl, g.scope);
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
    confirmAutoPilotBet,
    toggleAutoPilot,
    toggleAutoBase,
    // Axo (this build): voice setting, face state, ask-Axo.
    toggleAxoVoice: () => setAxoVoice(!axoVoiceOn()),
    refreshAxoVoiceChip: renderAxoVoiceChip,
    toggleAxoSubs: () => setAxoSubs(!axoSubsOn()),
    refreshAxoSubs: applyAxoSubs,
    // Phase 2A (owner correction 2): no-skip toggle functions stay
    // exposed but DORMANT — no UI calls them, the cycle never
    // consults them. Removal is reversible; re-wiring needs a fresh
    // owner order.
    toggleNoSkip,
    confirmNoSkip,
    cancelNoSkip,
    exportHistory,
    dismissAxoBubble,
    // Stake redesign (owner order 2026-10-30 ~01:06 IST): balance ask.
    axoBubbleTap,
    submitTypedBalance,
    maybeAskBalance,
    // Analyse pagination (owner order 2026-10-27): < > step the
    // patterns list one page at a time; renderPatternStats clamps,
    // so next past the last page is a safe no-op re-render.
    patternPrevPage: () => { if (patternPage > 1) { patternPage--; renderPatternStats(); } },
    patternNextPage: () => { patternPage++; renderPatternStats(); },
    noSkipOn: () => noSkipOn,
    syncAxoSubtitleSurfaces,
    repositionAxoBubble,
    fitSheetToContent,
    syncConfirmSlotHeight,
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
  // Fix round (real-time base bet, owner order 2026-10-27 ~12:01 IST):
  // synchronous base-bet sync for chip taps (mobile.js
  // setAssistantBaseStake) and the AUTO toggle (toggleAutoBase above).
  // Runs the SAME path the cycle runs, in the same order —
  // syncSessionBase (manual-tap-turns-AUTO-off lives there) +
  // applyLedgerResize + the governed renders — with no cycle tick
  // or round boundary needed and no divergent formula. The
  // Settings-page AUTO toggle is a separate document and cannot call
  // this hook synchronously; that path still updates on the next
  // cycle tick (pollApIntent) — a document limitation, not a second
  // formula. A tap must never break on sync: errors are swallowed.
  window.__o101SyncBaseNow = () => {
    try {
      const login = verifier.status(Date.now());
      syncSessionBase(login);
      if (state.gate) {
        applyLedgerResize(state.gate);
        renderSignal(state.gate, null, login);
        renderHeroVerdict(state.gate);
        renderAxoOrb();
      }
    } catch (e) { /* sync must never break a tap */ }
  };
  // Phase 3E manual unbench (Analyse bench card): restores the model
  // to NORMAL immediately (full eligibility, subject to winning
  // Incharge). The card re-renders on the next cycle. Like manual
  // unblacklist, it never clears a blacklist entry.
  window.__o101Unbench = (tf, modelId) => {
    try { bench.unbench(tf || state.tf || currentTf(), modelId); } catch (e) { /* button must never throw */ }
  };

  // Axo comes up on the base face with the chips synced to the
  // persisted voice / subtitle / mode / language settings; the
  // tap-for-voice badge starts hidden (nothing queued yet); the
  // ball clamp is published for the classic script's orb drag
  // (mobile.js cannot import this module — same function, one
  // source of truth, inline fallback when the module is absent).
  // Blink/sleep run from here.
  window.__o101ClampBall = clampBallRect;
  // Panel size for the classic script (mobile.js cannot import this
  // module — same function, one source of truth, inline fallback
  // when the module is absent).
  window.__o101AxoPanelSize = resolveAxoPanelSize;
  // Pull-to-refresh visual math for the classic script (same
  // pattern: one source of truth, inline fallback when absent).
  window.__o101PullVisual = pullRefreshVisual;
  renderAxoVoiceChip();
  renderAxoVoiceBadge();
  applyAxoSubs();
  renderAxoModeChip();
  renderAxoLangChip();
  // Phase 2A: no renderNoSkipChip() — the chip/badge/popup are
  // removed (owner correction 2); the functions stay dormant.
  setAxoFace('base');
  axoBlinkLoop();

  setInterval(() => { try { cycle(); } catch (e) {} }, 3000);
  setTimeout(() => { try { cycle(); } catch (e) {} }, 1200);
  setInterval(apTick, 500);
}
