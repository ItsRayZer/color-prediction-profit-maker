/**
 * Signal Gate (BET / STOP / NO_PICK) — Phase 3D no-skip
 * =====================================================
 * Owner order 2026-10-27 ("remove the skip system, no skip
 * needed"): the gate NEVER withholds a pick for quality reasons.
 * Every round with a pick shows that pick as a BET verdict carrying
 * its honest quality (Wilson bound vs the bar, gap, gate reason);
 * the user decides with the per-bet tap. Quality failures that used
 * to be SKIP verdicts (floor, Wilson, disagreement, calibration,
 * edge, noprob) are now BET verdicts with belowBar: true. A
 * below-bar pick the user taps and loses settles like any staged
 * loss (ladder doubles, nothing stops).
 *
 * The ONLY non-BET verdict left:
 *  - NO_PICK: no pick exists at all (empty pool / no Incharge pick).
 *    There are no STOP verdicts: no loss breaker, no hard stop, no
 *    stop-loss/win, no ladder-exhaustion stop (Phase 3D, owner
 *    order "no stop no skip"). A losing streak never blocks the
 *    next pick or the next staged bet.
 *
 * A signal becomes a STRONG bet only when every check passes:
 *
 *  1. There is a pick from a bet-driving model.
 *  2. The model's sample clears a small sanity floor (below it, one
 *     round swings the Wilson bound by 10+ points) — and the stake
 *     then SCALES with sample size (graduated stakes).
 *  3. The leader's Wilson lower bound ITSELF clears breakeven +
 *     margin (strict check, owner order 2026-10-25).
 *  4. The top models agree on the pick (no split vote at the top).
 *  5. The confidence is calibrated (measured, not asserted).
 *  6. The calibrated probability clears the breakeven for the payout
 *     PLUS a safety margin. At 0.96 payout the breakeven win rate is
 *     1 / (1 + 0.96) = 51.02%.
 *
 * A below-bar BET is a pick with a warning, never silence — and a
 * below-bar pick the user taps and loses settles like any staged
 * loss (ladder doubles, nothing stops).
 */

export const GATE_DECISIONS = { BET: 'BET', NO_PICK: 'NO_PICK' };

/** Breakeven win probability for a stake-returns-profit-of `payout` x stake. */
export function breakEvenWinRate(payout = 0.96) {
  return 1 / (1 + Number(payout || 0));
}

export const DEFAULT_GATE_CONFIG = {
  payout: 0.96,
  margin: 0.02, // require breakeven + 2 points before calling it an edge
  minSamples: 20, // sanity floor: below this, one round swings the Wilson bound by 10+ points (19.0 at n=5, 12.7 at n=10), so no ranking is stable enough to bet on; at 20 the swing is 7.5 points
  requireCalibrated: true,
  topContenders: 3, // how many top models must agree on the pick
  cooldownExtraMargin: 0.03 // anti-tilt: added to the margin while cooldown is active
};

/**
 * Graduated stakes (owner order 2026-10-25, replaces the hard
 * 200-round bet blocker): the base stake scales with the leading
 * model's evaluated rounds and reaches full stake at 200. Tiers,
 * not a curve, so the factor is auditable at a glance:
 *   < 20 → 0 (no graduated tier yet — see below)
 *   20–49 → 0.25× · 50–99 → 0.5× · 100–199 → 0.75× · ≥ 200 → 1.0×
 * The factor multiplies the BASE bet; the ladder derives from the
 * scaled base and the affordability check runs on the scaled base.
 * Monotonic in n and capped at 1.0: more data can only raise the
 * stake, never lower it, and full stake still needs 200 rounds
 * exactly as before.
 * Phase 3D no-skip: a 0 factor no longer blocks anything — the
 * stake resolver floors the APPLIED factor at 0.25× (the lowest
 * graduated tier), so a below-floor pick still stages, never at
 * full base on a handful of rounds and never at ₹0. The gate
 * reports both the true factor (sampleFactor) and the applied one
 * (appliedFactor); the quality line names the thin sample.
 */
export const MIN_RANK_SAMPLES = 20;
export function sampleStakeFactor(n) {
  const rounds = Math.floor(Number(n) || 0);
  if (rounds < MIN_RANK_SAMPLES) return 0;
  if (rounds < 50) return 0.25;
  if (rounds < 100) return 0.5;
  if (rounds < 200) return 0.75;
  return 1.0;
}

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

  /** Record the outcome of a governed BET. NO_PICK rounds never reach this. */
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

/**
 * Bet type of a pick target (Phase 3A). Digit strings are exact-ball
 * (NUMBER) picks; GREEN/RED are colour; BIG/SMALL are size. Anything
 * else (null, VIOLET, unknown tokens) maps to null — never guessed.
 */
export function betTypeOfPick(target) {
  if (target === null || target === undefined) return null;
  const t = String(target).trim().toUpperCase();
  if (/^[0-9]$/.test(t)) return 'NUMBER';
  if (t === 'GREEN' || t === 'RED') return 'COLOR';
  if (t === 'BIG' || t === 'SMALL') return 'SIZE';
  return null;
}

/**
 * Phase 3A gates (owner orders 2026-10-26) — now enforced by the
 * CALLER's bet-driving selection (orb-bridge cycle), NOT by this
 * gate, since Phase 3D forbids SKIP verdicts:
 *  - EXACT_BALL_GATE_REASON: digit picks never govern a BET while the
 *    live DhaniWin exact payout is unverified. The cycle excludes
 *    exact-ball models from bet-driving selection; an exact-ball
 *    model holding Incharge still shows its digit as DISPLAY only.
 *  - ASI_TRIAL_GATE_REASON: ASI / ASI_APEX_MASTER (governed since
 *    Phase 3A) are evaluated and shown, but do not drive a BET until
 *    their ensemble trial passes vs the best single model (harness
 *    PASS). The cycle excludes them from bet-driving selection while
 *    trial-gated and notes the trial status where one would have led.
 * The constants stay exported: the cycle attaches them as notes, and
 * the trial flag is input.asiTrialPassed (default false — gated); a
 * future harness round flips it, never a toggle.
 */
export const EXACT_BALL_GATE_REASON = 'Exact-ball gated: live payout unverified.';
export const ASI_TRIAL_GATE_REASON = 'ASI trial: evaluated, not bet-driving until harness PASS.';
export const ASI_TRIAL_IDS = ['ASI', 'ASI_APEX_MASTER'];

/**
 * Phase 3D (owner order 2026-10-27, "no stop no skip"): the streak
 * guard is DELETED — no 3-loss breaker, no HARD_STOP, no re-arm, no
 * shadow clearing. The ONLY loss-consequence machinery left is the
 * anti-tilt cooldown (GateCooldown above): after 2 losses the gate
 * demands +3pts of edge for 3 rounds. It raises the displayed bar,
 * never blocks a pick or a staged bet. A losing streak never stops
 * anything anymore; the ladder restarts at base after the top rung
 * (bankroll.js) instead of stopping.
 */

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
 *  - wilsonLowerBound: the leader's Wilson lower-bound win rate
 *    (0..1), computed from its real wins/evaluated — the strict
 *    check (step 3); missing or below breakeven + margin → a
 *    below-bar BET verdict carrying the gap, never a SKIP.
 *  - predictedProb: raw probability assigned to the pick (0..1)
 *  - calibratedProb: calibrated probability (preferred when present)
 *  - calibration: CalibrationTracker or { isCalibrated, ece, count }
 *  - contenders: top model objects (each with a pick) for agreement check
 * @param {object} config overrides of DEFAULT_GATE_CONFIG
 * @returns {{decision, reason, belowBar, qualityReason, prob, breakEven, requiredProb, edge, sampleSize, sampleFactor, appliedFactor}}
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
  // Task P (owner order 2026-10-26, "keep it minimalistic"):
  // the cooldown note is display-only — margin points + rounds
  // left survive, the explanatory sentence is cut.
  const cooldownNote = cooldownActive
    ? ` Cooldown +${(cooldownExtra * 100).toFixed(1)} pts (${cd.roundsLeft ?? 1} left).`
    : '';
  const pick = pickOf(input) ?? pickOf(input.model) ?? pickOf(input.inchargeModel);
  const model = input.model || input.inchargeModel || null;
  const sampleSize = Number(
    input.sampleSize ??
    (model ? (model.totalEvaluated ?? model.evaluated ?? model.sessionEvaluated ?? 0) : 0)
  );
  const prob = Number(input.calibratedProb ?? input.predictedProb ?? input.confidence ?? NaN);
  const wilson = Number(input.wilsonLowerBound ?? NaN);

  // Phase 3D no-skip: a quality failure is a BET verdict with its
  // honest quality attached (belowBar + qualityReason), never a
  // SKIP. The pick stays stageable with the user's per-bet tap;
  // the hero shows the Wilson gap + gate reason, and the subtitle
  // marks it "(below bar)". appliedFactor floors a 0 tier at 0.25×
  // so a below-floor pick stages at the lowest tier, never at full
  // base on a handful of rounds and never at ₹0.
  const belowBar = (reason) => {
    const factor = sampleStakeFactor(sampleSize);
    const applied = factor === 0 ? 0.25 : factor;
    return {
      decision: GATE_DECISIONS.BET,
      reason,
      belowBar: true,
      qualityReason: reason,
      pick,
      prob: Number.isFinite(prob) ? prob : null,
      wilsonLowerBound: Number.isFinite(wilson) ? wilson : null,
      breakEven: breakeven,
      requiredProb,
      effectiveMargin,
      cooldownActive,
      edge: Number.isFinite(prob) ? prob - breakeven : null,
      sampleSize,
      sampleFactor: factor,
      appliedFactor: applied,
      sampleNote: applied < 1
        ? `Early-data stake: ${applied}× base (${Math.floor(sampleSize)}/200).`
        : ''
    };
  };
  // No pick exists at all — the one honest non-BET the gate itself
  // can return. The cycle keeps its no-pick note for this case only.
  const noPick = (reason) => ({
    decision: GATE_DECISIONS.NO_PICK,
    reason,
    belowBar: false,
    qualityReason: null,
    pick: null,
    prob: null,
    wilsonLowerBound: Number.isFinite(wilson) ? wilson : null,
    breakEven: breakeven,
    requiredProb,
    effectiveMargin,
    cooldownActive,
    edge: null,
    sampleSize,
    sampleFactor: sampleStakeFactor(sampleSize),
    appliedFactor: 1,
    sampleNote: ''
  });

  // Task P (owner order 2026-10-26): every gate reason below is
  // DISPLAY-ONLY minimal wording — the logic and the thresholds
  // never change. Each keeps its key number (rounds n/20, Wilson %
  // vs needed %, chance % vs bar). Under Phase 3D these reasons
  // ride on below-bar BET verdicts as their quality line, not on
  // SKIP verdicts (there are none anymore).
  // 1. A pick must exist.
  if (!pick) return noPick('No pick from Incharge yet.');

  // 1a. Phase 3A hard gates (exact-ball payout unverified, ASI trial
  // not passed) are enforced by the CALLER's bet-driving selection
  // (orb-bridge cycle excludes exact-ball + trial-gated ASI/APEX
  // picks from bet-driving) — the gate itself never sees them as
  // verdicts anymore, so no branch here can return a SKIP for them.

  // 2. Sanity floor: below 20 rounds one round swings the Wilson
  // bound by 10+ points, so no ranking is stable enough to bet on.
  // Above the floor, the Wilson bound itself must clear the bar
  // (step 3) and the calibrated edge below is the second money
  // check — and the stake scales with sample size (graduated stakes).
  if (!Number.isFinite(sampleSize) || sampleSize < cfg.minSamples) {
    return belowBar(`Too few rounds (${Math.max(0, Math.floor(sampleSize) || 0)}/${cfg.minSamples}).`);
  }

  // 3. Strict Wilson check (owner order 2026-10-25): ranking by
  // Wilson is not enough — the leader's defended win rate itself
  // must clear breakeven + margin. A thin record with high stated
  // confidence bets nothing until its Wilson bound clears.
  if (!Number.isFinite(wilson)) {
    return belowBar('Wilson unmeasurable (no win record).');
  }
  if (wilson < requiredProb) {
    return belowBar(`Wilson ${(wilson * 100).toFixed(1)}% < ${(requiredProb * 100).toFixed(1)}% needed.${cooldownNote}`);
  }

  // 4. Top-model agreement: a split vote at the top is not a signal.
  const contenders = Array.isArray(input.contenders) ? input.contenders.slice(0, cfg.topContenders) : [];
  if (contenders.length > 1) {
    const picks = contenders.map(pickOf).filter(Boolean);
    const distinct = [...new Set(picks)];
    if (picks.length > 1 && distinct.length > 1) {
      return belowBar(`Top models disagree (${distinct.join(' vs ')}).`);
    }
  }

  // 5. Calibration: unmeasured confidence is not confidence.
  const cal = calibrationStatus(input.calibration);
  if (cfg.requireCalibrated) {
    if (!cal.present) {
      return belowBar('Uncalibrated (no history yet).');
    }
    if (!cal.calibrated) {
      return belowBar('Uncalibrated (probabilities off).');
    }
  }

  // 6. Real edge only: calibrated probability must clear breakeven + margin.
  if (!Number.isFinite(prob)) return belowBar('No probability produced.');
  if (prob < requiredProb) {
    return belowBar(`Edge too thin: ${(prob * 100).toFixed(1)}% < ${(requiredProb * 100).toFixed(1)}% needed.${cooldownNote}`);
  }

  // Graduated-stake note: a small-sample bet is never presented as
  // a full-confidence bet. The note rides on the BET reason and on
  // the sampleNote field (the hero carries it under NEXT PREDICTION).
  const sampleFactor = sampleStakeFactor(sampleSize);
  const appliedFactor = sampleFactor === 0 ? 0.25 : sampleFactor;
  const sampleNote = appliedFactor < 1
    ? ` Early-data stake: ${appliedFactor}× base (${Math.floor(sampleSize)}/200).`
    : '';
  return {
    decision: GATE_DECISIONS.BET,
    reason: `Chance ${(prob * 100).toFixed(1)}% clears ${(requiredProb * 100).toFixed(1)}% bar (sample ${Math.floor(sampleSize)}, top agree).${cooldownNote}${sampleNote}`,
    belowBar: false,
    qualityReason: null,
    pick,
    prob,
    wilsonLowerBound: wilson,
    breakEven: breakeven,
    requiredProb,
    effectiveMargin,
    cooldownActive,
    edge: prob - breakeven,
    sampleSize,
    sampleFactor,
    appliedFactor,
    sampleNote: sampleNote.trim()
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
  module.exports = { GATE_DECISIONS, DEFAULT_GATE_CONFIG, breakEvenWinRate, evaluateSignalGate, evaluateGate, SignalGate, GateCooldown, MIN_RANK_SAMPLES, sampleStakeFactor, betTypeOfPick, EXACT_BALL_GATE_REASON, ASI_TRIAL_GATE_REASON, ASI_TRIAL_IDS };
}

if (typeof self !== "undefined") {
  self.evaluateSignalGate = evaluateSignalGate;
  self.SignalGate = SignalGate;
  self.GateCooldown = GateCooldown;
  self.sampleStakeFactor = sampleStakeFactor;
}
