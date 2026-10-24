/**
 * Signal Gate (BET / SKIP)
 * ========================
 * The most valuable decision this app makes is often NO decision.
 * A signal becomes a BET only when every check passes:
 *
 *  1. There is a pick from an Incharge model.
 *  2. The model's sample size is large enough to mean anything.
 *  3. The top models agree on the pick (no split vote at the top).
 *  4. The confidence is calibrated (measured, not asserted).
 *  5. The calibrated probability clears the breakeven for the payout
 *     PLUS a safety margin. At 0.96 payout the breakeven win rate is
 *     1 / (1 + 0.96) = 51.02%. A 51.5% "edge" is noise, not an edge.
 *
 * A SKIP is a decision with a reason, never silence.
 */

export const GATE_DECISIONS = { BET: 'BET', SKIP: 'SKIP' };

/** Breakeven win probability for a stake-returns-profit-of `payout` x stake. */
export function breakEvenWinRate(payout = 0.96) {
  return 1 / (1 + Number(payout || 0));
}

export const DEFAULT_GATE_CONFIG = {
  payout: 0.96,
  margin: 0.02, // require breakeven + 2 points before calling it an edge
  minSamples: 200, // Incharge model must have at least this many evaluated rounds
  requireCalibrated: true,
  topContenders: 3, // how many top models must agree on the pick
  cooldownExtraMargin: 0.03 // anti-tilt: added to the margin while cooldown is active
};

/**
 * Anti-tilt cooldown tracker (pure, testable).
 * After the governed signal loses `triggerLosses` bets in a row, the gate
 * must demand a higher edge for the next `rounds` rounds. A win resets
 * everything immediately. beginRound() is called once per new round: it
 * reports whether the cooldown applies to that round and consumes it.
 */
export class GateCooldown {
  constructor({ triggerLosses = 2, rounds = 3, extraMargin = DEFAULT_GATE_CONFIG.cooldownExtraMargin } = {}) {
    this.triggerLosses = triggerLosses;
    this.rounds = rounds;
    this.extraMargin = extraMargin;
    this.lossStreak = 0;
    this.roundsLeft = 0;
  }

  /** Record the outcome of a governed BET. Skips never reach this. */
  recordSettledBet(won) {
    if (won) {
      this.lossStreak = 0;
      this.roundsLeft = 0;
      return;
    }
    this.lossStreak += 1;
    if (this.lossStreak >= this.triggerLosses) this.roundsLeft = this.rounds;
  }

  /** Call once per new round before evaluating the gate. */
  beginRound() {
    if (this.roundsLeft > 0) {
      const active = { active: true, roundsLeft: this.roundsLeft, extraMargin: this.extraMargin, lossStreak: this.lossStreak };
      this.roundsLeft -= 1;
      return active;
    }
    return { active: false, roundsLeft: 0, extraMargin: 0, lossStreak: this.lossStreak };
  }

  get active() {
    return this.roundsLeft > 0;
  }
}

export const HARD_STOP_LOSSES = 3;
export const HARD_STOP_REASON = '3-loss streak — stopped';

/**
 * GovernedStreakGuard — the ONE streak counter and ONE stop state for
 * the governed flow (owner's rule, 2026-10-24: never a 4th bet into a
 * losing streak).
 *
 * It reconciles what used to be parallel mechanisms:
 *  - the GateCooldown behaviour (2 settled losses → the gate demands
 *    +0.03 extra edge for the next 3 rounds) is DERIVED from this
 *    guard's single counter via beginRound()/cooldownSnapshot() — the
 *    gate still receives the same {active, roundsLeft, extraMargin,
 *    lossStreak} input shape, but there is no second counter to
 *    disagree with this one. (The standalone GateCooldown class above
 *    remains for its own unit tests; the runtime no longer wires it.)
 *  - the bankroll session's internal 3-loss ladder breaker stays a
 *    money consequence of the same settlements (it ends that
 *    session's ladder); the AUTHORITY that blocks verdicts, staging
 *    and Auto-Pilot is this guard's HARD_STOP, and only this.
 *
 * Counting rules: only SETTLED governed BET picks count (fired bets
 * when Auto-Pilot is on; governed BET verdicts in the advice flow).
 * SKIP rounds never touch the counter. A win resets it to 0.
 *
 * HARD_STOP (at 3 consecutive losses): every governed verdict is SKIP
 * with HARD_STOP_REASON, Auto-Pilot switches OFF, staging is
 * impossible. It clears ONLY when (i) the would-be governed pick wins
 * twice consecutively in shadow — tracked silently via
 * recordShadowPick() while stopped — or (ii) the owner manually
 * re-arms via manualRearm(). Clearing resets the counter to 0 and is
 * recorded in `lastClear` so the UI/report can say how it cleared.
 */
export class GovernedStreakGuard {
  constructor({ hardStopLosses = HARD_STOP_LOSSES, cooldownTriggerLosses = 2, cooldownRounds = 3, cooldownExtraMargin = DEFAULT_GATE_CONFIG.cooldownExtraMargin, shadowWinsToClear = 2 } = {}) {
    this.hardStopLosses = hardStopLosses;
    this.cooldownTriggerLosses = cooldownTriggerLosses;
    this.cooldownRounds = cooldownRounds;
    this.cooldownExtraMargin = cooldownExtraMargin;
    this.shadowWinsToClear = shadowWinsToClear;
    this.consecutiveLosses = 0;
    this.hardStopped = false;
    this.shadowWins = 0;
    this.cooldownRoundsLeft = 0;
    this.stoppedAt = null;
    this.lastClear = null; // { source: 'shadow' | 'manual', at }
  }

  /** Gate input for the round being evaluated; consumes one cooldown round. */
  beginRound() {
    if (!this.hardStopped && this.cooldownRoundsLeft > 0) {
      const snap = { active: true, roundsLeft: this.cooldownRoundsLeft, extraMargin: this.cooldownExtraMargin, lossStreak: this.consecutiveLosses };
      this.cooldownRoundsLeft -= 1;
      return snap;
    }
    return { active: false, roundsLeft: 0, extraMargin: 0, lossStreak: this.consecutiveLosses };
  }

  /** Record the settlement of one governed BET pick (never a SKIP). */
  recordSettledBet(won, at = null) {
    if (this.hardStopped) return this.snapshot();
    if (won) {
      this.consecutiveLosses = 0;
      this.cooldownRoundsLeft = 0;
      return this.snapshot();
    }
    this.consecutiveLosses += 1;
    if (this.consecutiveLosses >= this.hardStopLosses) {
      this.hardStopped = true;
      this.shadowWins = 0;
      this.cooldownRoundsLeft = 0;
      this.stoppedAt = at;
    } else if (this.consecutiveLosses >= this.cooldownTriggerLosses) {
      this.cooldownRoundsLeft = this.cooldownRounds;
    }
    return this.snapshot();
  }

  /**
   * While HARD_STOPPED, track the would-be governed pick's outcome
   * silently. Two consecutive shadow wins clear the stop.
   */
  recordShadowPick(won) {
    if (!this.hardStopped) return this.snapshot();
    if (won) {
      this.shadowWins += 1;
      if (this.shadowWins >= this.shadowWinsToClear) this._clear('shadow');
    } else {
      this.shadowWins = 0;
    }
    return this.snapshot();
  }

  /** Owner override from the window. Returns true when a stop was cleared. */
  manualRearm(at = null) {
    if (!this.hardStopped) return false;
    this._clear('manual', at);
    return true;
  }

  _clear(source, at = null) {
    this.hardStopped = false;
    this.consecutiveLosses = 0;
    this.shadowWins = 0;
    this.cooldownRoundsLeft = 0;
    this.stoppedAt = null;
    this.lastClear = { source, at };
  }

  snapshot() {
    return {
      consecutiveLosses: this.consecutiveLosses,
      hardStopped: this.hardStopped,
      shadowWins: this.shadowWins,
      cooldownRoundsLeft: this.cooldownRoundsLeft,
      stoppedAt: this.stoppedAt,
      lastClear: this.lastClear ? { ...this.lastClear } : null
    };
  }

  restore(snap) {
    if (!snap || typeof snap !== 'object') return;
    this.consecutiveLosses = Number(snap.consecutiveLosses) || 0;
    this.hardStopped = snap.hardStopped === true;
    this.shadowWins = Number(snap.shadowWins) || 0;
    this.cooldownRoundsLeft = Number(snap.cooldownRoundsLeft) || 0;
    this.stoppedAt = snap.stoppedAt ?? null;
    this.lastClear = snap.lastClear || null;
  }
}

function pickOf(entry) {
  if (!entry) return null;
  const p = entry.pick ?? entry.predTarget ?? entry.prediction ?? entry.predColor ?? entry.predSize;
  return p === undefined || p === null ? null : String(p).toUpperCase();
}

function calibrationStatus(calibration) {
  if (!calibration) return { present: false, calibrated: false, ece: null, count: 0 };
  if (typeof calibration.isCalibrated === 'function') {
    return {
      present: true,
      calibrated: calibration.isCalibrated(),
      ece: typeof calibration.expectedCalibrationError === 'function' ? calibration.expectedCalibrationError() : null,
      count: typeof calibration.count === 'number' ? calibration.count : 0
    };
  }
  return {
    present: true,
    calibrated: calibration.isCalibrated === true || calibration.calibrated === true,
    ece: typeof calibration.ece === 'number' ? calibration.ece : null,
    count: typeof calibration.count === 'number' ? calibration.count : 0
  };
}

/**
 * @param {object} input
 *  - pick: the Incharge model's pick (e.g. 'GREEN', 'BIG')
 *  - model / inchargeModel: model object (uses totalEvaluated/evaluated)
 *  - sampleSize: explicit override for the model's evaluated count
 *  - predictedProb: raw probability assigned to the pick (0..1)
 *  - calibratedProb: calibrated probability (preferred when present)
 *  - calibration: CalibrationTracker or { isCalibrated, ece, count }
 *  - contenders: top model objects (each with a pick) for agreement check
 * @param {object} config overrides of DEFAULT_GATE_CONFIG
 * @returns {{decision, reason, prob, breakEven, requiredProb, edge, sampleSize}}
 */
export function evaluateSignalGate(input = {}, config = {}) {
  const cfg = { ...DEFAULT_GATE_CONFIG, ...config };
  const breakeven = breakEvenWinRate(cfg.payout);
  // Anti-tilt cooldown: after back-to-back governed losses the bar rises.
  const cd = input.cooldown || null;
  const cooldownActive = !!(cd && cd.active);
  const cooldownExtra = cooldownActive ? Number(cd.extraMargin ?? cfg.cooldownExtraMargin ?? 0) : 0;
  const effectiveMargin = Number(cfg.margin || 0) + cooldownExtra;
  const requiredProb = breakeven + effectiveMargin;
  const cooldownNote = cooldownActive
    ? ` Anti-tilt cooldown active (governed signal lost ${cd.lossStreak ?? 2} in a row): the bar is raised by ${(cooldownExtra * 100).toFixed(1)} points for ${cd.roundsLeft ?? 1} more round(s).`
    : '';
  const pick = pickOf(input) ?? pickOf(input.model) ?? pickOf(input.inchargeModel);
  const model = input.model || input.inchargeModel || null;
  const sampleSize = Number(
    input.sampleSize ??
    (model ? (model.totalEvaluated ?? model.evaluated ?? model.sessionEvaluated ?? 0) : 0)
  );
  const prob = Number(input.calibratedProb ?? input.predictedProb ?? input.confidence ?? NaN);

  const skip = reason => ({
    decision: GATE_DECISIONS.SKIP,
    reason,
    pick,
    prob: Number.isFinite(prob) ? prob : null,
    breakEven: breakeven,
    requiredProb,
    effectiveMargin,
    cooldownActive,
    edge: Number.isFinite(prob) ? prob - breakeven : null,
    sampleSize
  });

  // 1. A pick must exist.
  if (!pick) return skip('No pick from the Incharge model yet, so there is nothing to bet on.');

  // 2. Sample size: a hot record over a handful of rounds is noise.
  if (!Number.isFinite(sampleSize) || sampleSize < cfg.minSamples) {
    return skip(`Sample too small: the leading model has only ${Math.max(0, Math.floor(sampleSize) || 0)} evaluated rounds (needs ${cfg.minSamples}) before its record means anything.`);
  }

  // 3. Top-model agreement: a split vote at the top is not a signal.
  const contenders = Array.isArray(input.contenders) ? input.contenders.slice(0, cfg.topContenders) : [];
  if (contenders.length > 1) {
    const picks = contenders.map(pickOf).filter(Boolean);
    const distinct = [...new Set(picks)];
    if (picks.length > 1 && distinct.length > 1) {
      return skip(`Top models disagree on the pick (${distinct.join(' vs ')}), so there is no clean signal this round.`);
    }
  }

  // 4. Calibration: unmeasured confidence is not confidence.
  const cal = calibrationStatus(input.calibration);
  if (cfg.requireCalibrated) {
    if (!cal.present) {
      return skip('Confidence is uncalibrated: no outcome history has been measured against these probabilities yet.');
    }
    if (!cal.calibrated) {
      return skip('Confidence is uncalibrated: stated probabilities do not match real outcomes closely enough yet, so the number cannot be trusted for money.');
    }
  }

  // 5. Real edge only: calibrated probability must clear breakeven + margin.
  if (!Number.isFinite(prob)) return skip('No probability was produced for this pick, so no edge can be shown.');
  if (prob < requiredProb) {
    return skip(`Edge too thin: calibrated chance ${(prob * 100).toFixed(1)}% is below the ${(requiredProb * 100).toFixed(1)}% needed (breakeven ${(breakeven * 100).toFixed(2)}% at ${cfg.payout} payout plus safety margin).${cooldownNote}`);
  }

  return {
    decision: GATE_DECISIONS.BET,
    reason: `Calibrated chance ${(prob * 100).toFixed(1)}% clears the ${(requiredProb * 100).toFixed(1)}% bar with sample ${Math.floor(sampleSize)} and top models in agreement.${cooldownNote}`,
    pick,
    prob,
    breakEven: breakeven,
    requiredProb,
    effectiveMargin,
    cooldownActive,
    edge: prob - breakeven,
    sampleSize
  };
}

export class SignalGate {
  constructor(config = {}) {
    this.config = { ...DEFAULT_GATE_CONFIG, ...config };
  }
  updateConfig(newConfig = {}) {
    this.config = { ...this.config, ...newConfig };
  }
  evaluate(input) {
    return evaluateSignalGate(input, this.config);
  }
}

export const evaluateGate = evaluateSignalGate;

if (typeof module !== "undefined" && module.exports) {
  module.exports = { GATE_DECISIONS, DEFAULT_GATE_CONFIG, breakEvenWinRate, evaluateSignalGate, evaluateGate, SignalGate, GateCooldown, GovernedStreakGuard, HARD_STOP_LOSSES, HARD_STOP_REASON };
}

if (typeof self !== "undefined") {
  self.evaluateSignalGate = evaluateSignalGate;
  self.SignalGate = SignalGate;
  self.GateCooldown = GateCooldown;
}
