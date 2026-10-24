/**
 * AutoPilot — one-tap Auto-Pilot core for 01.01 (pure, testable).
 * ================================================================
 * Auto-Pilot THINKS automatically; the human FIRES. When it is ON,
 * each round the governed engine's BET verdict is STAGED here with the
 * exact ladder stake, and the bet is sent ONLY when the owner taps the
 * confirm button for that specific bet. There is deliberately NO code
 * path in this module that produces an order without confirmFire()
 * being called with a full, fresh validation — staging, ticking,
 * settling and rendering can never emit an order.
 *
 * The order produced is the codebase's existing bridge order shape
 * (the same EXECUTE_REAL_BET message mobile.js dispatchMobileBetOrder
 * sends through postMobileBridge to dhaniwin-bridge.js's
 * handleIncomingOrder, which executes only when msg.enabled is true).
 * One deliberate difference, disclosed in the build report: the app's
 * legacy dispatch sets manualConfirm:true, which makes the bridge
 * only PREPARE the bet and wait for a second tap on the DhaniWin
 * page. Auto-Pilot's single in-app confirm tap IS the authorisation
 * event for that bet, so the Auto-Pilot order carries
 * manualConfirm:false — the tap here replaces the tap there, it does
 * not remove the human from the loop.
 *
 * Ladder truth: Auto-Pilot does NOT keep its own bankroll session.
 * The governed bankroll session in orb-bridge is the single source of
 * truth for level / next stake / P&L (owner's level-integrity rule);
 * this core stages and validates against session snapshots the
 * runtime passes in, and keeps only its own session ACCOUNTING
 * (rounds / fired / settled P&L of fired bets) for display and stops.
 */

import { suggestBaseBet, STAKING_MODES, DEFAULT_STAKING_MODE } from './bankroll.js';

export const AUTOPILOT_KEY = 'o101_autopilot_v1';
export const AUTOPILOT_SETTINGS_KEY = 'o101_autopilot_settings_v1';
/** A staged bet dies when the round's countdown reaches this (the bridge's own lock). */
export const ROUND_CLOSE_MS = 5000;

export const STOP_REASONS = {
  STOP_LOSS: 'Stop-loss: session down 20% of the starting balance — Auto-Pilot off.',
  STOP_WIN: 'Stop-win: session up 20% on the starting balance — Auto-Pilot off.',
  LADDER_EXHAUSTED: 'Ladder exhausted: the full recovery ladder was used — Auto-Pilot off.',
  HARD_STOP: '3-loss streak — stopped. Auto-Pilot off.'
};

const LOG_CAP = 300;
const FIRED_CAP = 200;

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

export class AutoPilot {
  constructor(storage = null, { now = () => Date.now(), key = AUTOPILOT_KEY } = {}) {
    this.storage = storage;
    this.key = key;
    this.now = now;
    this.state = {
      v: 1,
      enabled: false,
      riskMode: DEFAULT_STAKING_MODE,
      autoBase: false,
      session: null,      // { startedAt, startBalance, rounds, fired, wins, losses, pnl }
      staged: null,       // { period, timeframe, target, stake, baseBet, ladderStep, stagedAt, expiresAt }
      fired: {},          // 'tf:period' -> { target, stake, settled }
      resolved: {},       // 'tf:period' -> true (accounting done for that round)
      paused: false,
      pauseReason: null,
      stopReason: null,   // visible until the owner manually re-arms
      log: []             // [{ ts, kind, period, timeframe, detail }]
    };
    this.load();
  }

  load() {
    try {
      const raw = this.storage ? this.storage.getItem(this.key) : null;
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && d.v === 1) this.state = { ...this.state, ...d };
    } catch (e) { /* corrupted storage must never break the app */ }
  }

  save() {
    try {
      if (this.storage) this.storage.setItem(this.key, JSON.stringify(this.state));
    } catch (e) { /* quota: in-memory state still powers this session */ }
  }

  _log(kind, { period = null, timeframe = null, detail = null } = {}) {
    this.state.log.push({ ts: this.now(), kind, period, timeframe, detail });
    if (this.state.log.length > LOG_CAP) this.state.log.splice(0, this.state.log.length - LOG_CAP);
  }

  _roundKey(tf, period) { return String(tf) + ':' + String(period); }

  // ── Arming ───────────────────────────────────────────────────────
  /**
   * Turn Auto-Pilot ON. Refuses (with the honest reason) unless login
   * is VERIFIED at this moment and no external block (e.g. HARD_STOP)
   * is in force. Starts a fresh accounting session.
   */
  arm({ verified = false, balance = null, blockedReason = null } = {}) {
    if (blockedReason) return { ok: false, reason: blockedReason };
    if (!verified) {
      return { ok: false, reason: 'Login not verified — Auto-Pilot needs the bridge\'s API-proven login before it will stage bets.' };
    }
    if (!(Number(balance) > 0)) {
      return { ok: false, reason: 'No verified balance yet — Auto-Pilot cannot size a ladder without the exact balance.' };
    }
    this.state.enabled = true;
    this.state.stopReason = null;
    this.state.paused = false;
    this.state.pauseReason = null;
    this.state.staged = null;
    this.state.session = { startedAt: this.now(), startBalance: Number(balance), rounds: 0, fired: 0, wins: 0, losses: 0, pnl: 0 };
    this._log('armed', { detail: `start balance ₹${Number(balance)}` });
    this.save();
    return { ok: true };
  }

  /** Manual OFF (owner's toggle). Not a stop: no stop reason is kept. */
  disarm(reason = 'Turned off by the owner.') {
    const was = this.state.enabled;
    this.state.enabled = false;
    this.state.staged = null;
    this.state.paused = false;
    this.state.pauseReason = null;
    if (was) this._log('disarmed', { detail: reason });
    this.save();
    return { ok: true };
  }

  /** Protective OFF: the reason stays visible until a manual re-arm. */
  forceStop(reason) {
    this.state.enabled = false;
    this.state.staged = null;
    this.state.paused = false;
    this.state.pauseReason = null;
    this.state.stopReason = reason;
    this._log('stopped', { detail: reason });
    this.save();
    return { ok: true };
  }

  get enabled() { return this.state.enabled === true; }
  get stopped() { return !this.state.enabled && !!this.state.stopReason; }

  setRiskMode(mode) {
    if (!STAKING_MODES[mode]) return { ok: false, reason: `Unknown risk mode: ${mode}` };
    this.state.riskMode = mode;
    this._log('risk-mode', { detail: mode });
    this.save();
    return { ok: true, replan: true };
  }

  setAutoBase(on) {
    this.state.autoBase = on === true;
    this._log('auto-base', { detail: this.state.autoBase ? 'on' : 'off (manual chips)' });
    this.save();
    return { ok: true, replan: true };
  }

  /** Login loss mid-session pauses staging; VERIFIED returning resumes it. */
  notePaused(paused, reason = null) {
    if (!this.state.enabled) return;
    const next = paused === true;
    if (this.state.paused === next && this.state.pauseReason === reason) return;
    this.state.paused = next;
    this.state.pauseReason = next ? reason : null;
    if (next) this.invalidate('login lost');
    this._log(next ? 'paused' : 'resumed', { detail: reason });
    this.save();
  }

  // ── Staging ──────────────────────────────────────────────────────
  /**
   * Stage a governed BET. `session` is the governed bankroll snapshot
   * (nextStake/baseBet/level/ladderLevels/state): the staged stake IS
   * session.nextStake, never a number computed here.
   * Returns 'staged' | 'already' | 'blocked'.
   */
  stage({ period, timeframe, target, session, periodDurationMs = null } = {}) {
    if (!this.state.enabled || this.state.paused || this.state.stopReason) return 'blocked';
    if (!session || ['STOP', 'STOP_LOSS', 'STOP_WIN', 'LADDER_EXHAUSTED'].includes(session.state) || !(session.nextStake > 0)) return 'blocked';
    if (!period || !target) return 'blocked';
    const cur = this.state.staged;
    if (cur && cur.period === String(period) && cur.timeframe === timeframe) {
      if (cur.target === target && cur.stake === session.nextStake) return 'already';
      // Same round, changed terms: the old staging is void.
      this.invalidate('terms changed');
    }
    const stagedAt = this.now();
    this.state.staged = {
      period: String(period),
      timeframe,
      target,
      stake: session.nextStake,
      baseBet: session.baseBet,
      ladderStep: (session.level || 0) + 1,
      stagedAt,
      expiresAt: periodDurationMs ? stagedAt + periodDurationMs : null
    };
    this._log('staged', { period: String(period), timeframe, detail: `${target} ₹${session.nextStake} (step ${this.state.staged.ladderStep})` });
    this.save();
    return 'staged';
  }

  stagedBet() { return this.state.staged ? { ...this.state.staged } : null; }

  /** Void the staged bet (it can never fire after this). */
  invalidate(reason = 'invalidated') {
    const cur = this.state.staged;
    if (!cur) return false;
    this.state.staged = null;
    this._countRound(cur.timeframe, cur.period);
    this._log('invalidated', { period: cur.period, timeframe: cur.timeframe, detail: reason });
    this.save();
    return true;
  }

  /**
   * The governed bankroll session moved (new base, ladder step,
   * balance replan): a staged stake that no longer equals the
   * session's computed stake is void.
   */
  noteSession(session) {
    const cur = this.state.staged;
    if (!cur || !session) return;
    if (['STOP', 'STOP_LOSS', 'STOP_WIN', 'LADDER_EXHAUSTED'].includes(session.state) || !(session.nextStake > 0) || cur.stake !== session.nextStake || cur.baseBet !== session.baseBet) {
      this.invalidate('ladder stake changed');
    }
  }

  /** The stop that force-stopped Auto-Pilot was cleared externally (e.g. HARD_STOP re-arm). */
  noteStopCleared() {
    if (!this.state.stopReason) return;
    this._log('stop-cleared', { detail: this.state.stopReason });
    this.state.stopReason = null;
    this.save();
  }

  /** Time-based invalidation, called by the runtime tick. */
  tick({ nowMs = null, countdownMsLeft = null } = {}) {
    const cur = this.state.staged;
    if (!cur) return false;
    const t = nowMs !== null ? nowMs : this.now();
    if (cur.expiresAt !== null && t >= cur.expiresAt) return this.invalidate('period rolled over');
    if (countdownMsLeft !== null && countdownMsLeft <= ROUND_CLOSE_MS) return this.invalidate('round closing (≤5s left)');
    return false;
  }

  hasFired(tf, period) {
    const f = this.state.fired[this._roundKey(tf, period)];
    return !!f;
  }

  // ── Firing — the ONLY order-producing path ───────────────────────
  /**
   * The owner's confirm tap. Re-validates EVERYTHING against the
   * fresh runtime state; any mismatch sends nothing. On success
   * returns { ok:true, order } with the existing bridge order shape;
   * the staged bet is consumed and the round is marked fired, so a
   * double-tap can never produce a second order.
   */
  confirmFire(validation = {}) {
    const fail = reason => ({ ok: false, reason });
    const cur = this.state.staged;
    if (!this.state.enabled) return fail('Auto-Pilot is off.');
    if (this.state.stopReason) return fail(this.state.stopReason);
    if (this.state.paused) return fail(this.state.pauseReason || 'Paused: login not verified.');
    if (!cur) {
      const key = validation.timeframe && validation.period ? this._roundKey(validation.timeframe, validation.period) : null;
      if (key && this.state.fired[key] && !this.state.fired[key].settled) return fail('Already fired for this round.');
      return fail('Nothing is staged for this round.');
    }
    if (validation.period !== undefined && String(validation.period) !== cur.period) return fail('The round rolled over — that bet is gone.');
    if (validation.timeframe !== undefined && validation.timeframe !== cur.timeframe) return fail('Timeframe changed — that bet is gone.');
    if (validation.verified !== true) return fail('Login is not verified right now.');
    if (validation.gateDecision !== undefined && validation.gateDecision !== 'BET') return fail('The gate no longer calls this a BET.');
    if (validation.hardStopped === true) return fail(STOP_REASONS.HARD_STOP);
    if (validation.sessionStake !== undefined && validation.sessionStake !== cur.stake) return fail('The ladder stake changed — that bet is gone.');
    if (validation.countdownMsLeft !== undefined && validation.countdownMsLeft !== null && validation.countdownMsLeft <= ROUND_CLOSE_MS) {
      return fail('Too late: the round is closing (≤5s left).');
    }
    if (validation.nowMs !== undefined && validation.nowMs !== null && cur.expiresAt !== null && validation.nowMs >= cur.expiresAt) {
      return fail('The round rolled over — that bet is gone.');
    }
    const order = {
      type: 'EXECUTE_REAL_BET',
      enabled: true,
      period: cur.period,
      target: cur.target,
      stake: cur.stake,
      maxStake: validation.maxStake !== undefined ? validation.maxStake : cur.stake,
      manualConfirm: false, // the in-app tap IS the authorisation (see header)
      timeframe: cur.timeframe,
      timestamp: this.now()
    };
    this.state.fired[this._roundKey(cur.timeframe, cur.period)] = { target: cur.target, stake: cur.stake, settled: false };
    const keys = Object.keys(this.state.fired);
    if (keys.length > FIRED_CAP) delete this.state.fired[keys[0]];
    if (this.state.session) this.state.session.fired += 1;
    this._log('fired', { period: cur.period, timeframe: cur.timeframe, detail: `${cur.target} ₹${cur.stake}` });
    this.state.staged = null;
    this.save();
    return { ok: true, order };
  }

  // ── Round accounting ─────────────────────────────────────────────
  /** Count a round in the session accounting exactly once. Returns true the first time. */
  _countRound(tf, period) {
    if (!tf || period === null || period === undefined) return false;
    const key = this._roundKey(tf, period);
    if (this.state.resolved[key]) return false;
    this.state.resolved[key] = true;
    const keys = Object.keys(this.state.resolved);
    if (keys.length > FIRED_CAP * 2) delete this.state.resolved[keys[0]];
    if (this.state.session) this.state.session.rounds += 1;
    return true;
  }

  /** A round ended with no fired bet (SKIP verdict, or BET never tapped). Silent by rule. */
  resolveUnfired(tf, period, kind = 'skipped') {
    if (this.hasFired(tf, period)) return;
    if (this._countRound(tf, period)) this._log(kind, { period: String(period), timeframe: tf });
    this.save();
  }

  /**
   * Settle a FIRED bet. `sessionState` is the governed bankroll
   * session's state AFTER bankroll.settle() ran on the shared
   * session; its STOP states stop Auto-Pilot here. Returns
   * { stopped, reason }.
   */
  settleFired({ timeframe, period, won, stakeUsed = 0, sessionState = null } = {}) {
    const key = this._roundKey(timeframe, period);
    const rec = this.state.fired[key];
    if (!rec || rec.settled) return { stopped: false, reason: null };
    rec.settled = true;
    const delta = won ? round2(rec.stake * 0.96) : -rec.stake;
    if (this.state.session) {
      if (won) this.state.session.wins += 1; else this.state.session.losses += 1;
      this.state.session.pnl = round2(this.state.session.pnl + delta);
    }
    this._countRound(timeframe, period);
    this._log('settled', { period: String(period), timeframe, detail: `${won ? 'WIN' : 'LOSS'} ${delta >= 0 ? '+' : ''}₹${delta}` });
    if (sessionState && STOP_REASONS[sessionState]) {
      const reason = STOP_REASONS[sessionState];
      this.forceStop(reason);
      return { stopped: true, reason };
    }
    this.save();
    return { stopped: false, reason: null };
  }

  sessionLine() {
    const s = this.state.session;
    if (this.state.stopReason) return this.state.stopReason;
    if (!this.state.enabled) return 'Auto-Pilot off.';
    if (this.state.paused) return this.state.pauseReason || 'Paused: login not verified.';
    if (!s) return 'Auto-Pilot on.';
    const pnl = `${s.pnl >= 0 ? '+' : '−'}₹${Math.abs(s.pnl).toFixed(2)}`;
    return `AP session: P&L ${pnl} · ${s.rounds} rounds · ${s.fired} fired`;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }
}

/** AUTO base bet for a fresh verified balance at a risk mode (bankroll.js math). */
export function autoBaseBet(balance, mode = DEFAULT_STAKING_MODE) {
  return suggestBaseBet(balance, mode);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AutoPilot, AUTOPILOT_KEY, AUTOPILOT_SETTINGS_KEY, ROUND_CLOSE_MS, STOP_REASONS, autoBaseBet };
}

if (typeof self !== 'undefined') {
  self.AutoPilot = AutoPilot;
}
