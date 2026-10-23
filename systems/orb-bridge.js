/**
 * orb-bridge.js — Smart Ball background decision layer for the OLD app.
 * ════════════════════════════════════════════════════════════════════
 * Loaded as a module by index.html and mobile.html AFTER the app's own
 * engine scripts (quant_algorithm, arena_models, wingo systems, pattern
 * analysis). Those engines stay loaded and untouched — this bridge is
 * the decision layer OVER them:
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
// The DhaniWin bridge script already computes isLoggedIn inside the
// embedded site and posts DHANIWIN_USER_SYNC / DHANIWIN_REAL_BALANCE.
// One flickering message is NOT proof of login. VERIFIED requires TWO
// independent positive signal kinds (bridge isLoggedIn=true, a fresh
// balance, a session token) with a sync seen inside the stale window.
// An explicit negative (isLoggedIn=false, auth page, logout event)
// drops to NOT_LOGGED_IN immediately; silence for >90s decays a
// VERIFIED back to UNKNOWN — never the other way round.
export const LOGIN_STATES = { VERIFIED: 'VERIFIED', NOT_LOGGED_IN: 'NOT_LOGGED_IN', UNKNOWN: 'UNKNOWN' };

export class LoginVerifier {
  constructor({ balanceFreshMs = 60000, staleMs = 90000 } = {}) {
    this.balanceFreshMs = balanceFreshMs;
    this.staleMs = staleMs;
    this.lastSyncAt = null;
    this.lastBalanceAt = null;
    this.lastBridgeLoginAt = null;
    this.lastTokenAt = null;
    this.lastPositiveAt = null;
    this.negativeAt = null;
    this.balance = null;
  }

  /**
   * Feed one bridge signal. sig: { isLoggedIn (bool|null), balance
   * (number|null), hasToken (bool), isAuthPage (bool), explicitLogout }
   */
  observe(sig = {}, now = Date.now()) {
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
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
    if (this.negativeAt !== null && (this.lastPositiveAt === null || this.negativeAt >= this.lastPositiveAt)) {
      return { state: LOGIN_STATES.NOT_LOGGED_IN, balance: this.balance, evidence: ['explicit negative (logout / auth page / isLoggedIn=false)'], lastSyncAt: this.lastSyncAt };
    }
    const kinds = [];
    if (this.lastBridgeLoginAt !== null && t - this.lastBridgeLoginAt <= this.staleMs) kinds.push('bridge isLoggedIn=true');
    if (this.lastBalanceAt !== null && t - this.lastBalanceAt <= this.balanceFreshMs) kinds.push(`fresh balance ₹${this.balance}`);
    if (this.lastTokenAt !== null && t - this.lastTokenAt <= this.staleMs) kinds.push('session token present');
    const syncFresh = this.lastSyncAt !== null && t - this.lastSyncAt <= this.staleMs;
    if (kinds.length >= 2 && syncFresh) {
      return { state: LOGIN_STATES.VERIFIED, balance: this.balance, evidence: kinds, lastSyncAt: this.lastSyncAt };
    }
    return { state: LOGIN_STATES.UNKNOWN, balance: this.balance, evidence: kinds, lastSyncAt: this.lastSyncAt };
  }
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

  // Also hear the bridge feed directly (same messages mobile.js uses).
  const isAuthUrl = url => {
    const u = String(url || '').toLowerCase();
    return u.includes('/login') || u.includes('/register');
  };
  window.addEventListener('message', ev => {
    const msg = ev && ev.data;
    if (!msg || typeof msg.type !== 'string') return;
    const now = Date.now();
    if (msg.type === 'DHANIWIN_USER_SYNC') {
      verifier.observe({
        isLoggedIn: typeof msg.isLoggedIn === 'boolean' ? msg.isLoggedIn : null,
        balance: msg.balance !== null && msg.balance !== undefined && Number.isFinite(Number(msg.balance)) ? Number(msg.balance) : null,
        hasToken: !!msg.token,
        isAuthPage: isAuthUrl(msg.url)
      }, now);
    } else if (msg.type === 'DHANIWIN_REAL_BALANCE') {
      verifier.observe({ balance: Number(msg.balance) }, now);
    } else if (msg.type === 'DHANIWIN_LOGIN_DETECTED') {
      verifier.observe({ isLoggedIn: true }, now);
    } else if (msg.type === 'DHANIWIN_USER_LOGGED_OUT') {
      verifier.observe({ explicitLogout: true }, now);
    } else {
      return;
    }
    const b = Number(msg.balance);
    if (Number.isFinite(b) && b > 0) {
      state.balance = b;
      state.balanceSource = BALANCE_SOURCES.BRIDGE;
    }
  });

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

  // ── Login status: pills + ball announcements ─────────────────────
  function loginLine(login) {
    if (login.state === LOGIN_STATES.VERIFIED) return `Login verified · ${inr(login.balance)} on DhaniWin.`;
    if (login.state === LOGIN_STATES.NOT_LOGGED_IN) return 'Not logged in. Open the DhaniWin tab and log in first — no signal or stake until login is verified.';
    return 'Checking login… waiting for two independent confirmations from the DhaniWin tab.';
  }

  function renderLogin(login) {
    const text = login.state === LOGIN_STATES.VERIFIED
      ? `Login verified · ${inr(login.balance)}`
      : login.state === LOGIN_STATES.NOT_LOGGED_IN ? 'Not logged in' : 'Checking login…';
    document.querySelectorAll('.bridge-login-pill').forEach(el => {
      el.textContent = text;
      el.setAttribute('data-state', login.state);
    });
    if (state.loginState !== login.state) {
      state.loginState = login.state;
      say(loginLine(login));
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
      // Login is a hard stop: while NOT_LOGGED_IN there is no signal and
      // no stake suggestion, whatever the engines think.
      if (login.state === LOGIN_STATES.NOT_LOGGED_IN) {
        gate = {
          ...gate,
          decision: GATE_DECISIONS.SKIP,
          prob: null,
          reason: 'Not logged in: login on the DhaniWin tab first. No signal or stake is suggested until login is verified with two independent confirmations.'
        };
      }
      state.gate = gate;
      // Remember the displayed pick so its outcome can settle
      // calibration and bankroll when the upcoming round lands.
      state.lastPick = myPick ? { target: myPick.target, prob: calibratedProb !== null ? calibratedProb : rawConf } : null;

      // Orb face + badges reflect the GOVERNED signal, not raw engine output.
      renderSignal(gate, incharge, login);
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
    const confText = bet && gate.prob !== null && gate.prob !== undefined ? Math.round(gate.prob * 100) + '%' : '—%';
    if (state.page === 'mobile') {
      const orbTarget = $('floatingOrbTarget');
      if (orbTarget) orbTarget.textContent = bet ? gate.pick : 'SKIP';
      const orbStake = $('floatingOrbStake');
      if (orbStake) orbStake.textContent = bet && loginVerified && state.session ? inr(state.session.nextStake) : '—';
      const targetEl = $('mobileWebTargetDisplay');
      if (targetEl) targetEl.textContent = bet ? gate.pick : 'SKIP';
      const conf = $('assistantConfBadge');
      if (conf) conf.textContent = confText;
      const lvl = $('mobileWebLevelBadge');
      if (lvl && state.session) lvl.textContent = bet ? `Level ${state.session.level + 1} (bridge ladder)` : 'Bridge: no bet this round';
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
    store,
    _state: state
  };

  setInterval(() => { try { cycle(); } catch (e) {} }, 3000);
  setTimeout(() => { try { cycle(); } catch (e) {} }, 1200);
}
