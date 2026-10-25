/**
 * Bankroll / Balance Module
 * =========================
 * Balance identification (consumed by the v2 front, in priority order):
 *  1. A DHANIWIN_REAL_BALANCE / DHANIWIN_USER_SYNC window message posted
 *     by dhaniwin-bridge.js (its Real Balance Engine intercepts wallet /
 *     user / balance JSON, with a DOM scanner fallback) — the same
 *     channel mobile.js stores into MobileBridgeState.userBalance.
 *  2. A manual balance entered by the user in the Money panel.
 *  3. A simulated balance in prototype mode.
 * This module never invents a balance; the front shows the source and
 * freshness of whatever balance it was given.
 *
 * Staking math (honest version):
 *  - Base bet fractions reuse the staking modes already shipped in
 *    mobile.js: safe 0.5%, balanced/profitable 1%, growth/risk 2.5%,
 *    aggressive/high-risk 5% of balance, rounded down, minimum ₹1.
 *  - Loss progression DOUBLES the stake (multiplier 2), reset on a win.
 *    Win profit = stake * 0.96, loss = the stake (signal_validation.py).
 *  - IMPORTANT: doubling does NOT create an edge and does NOT make a
 *    losing system profitable. It only reshapes variance. Long-term
 *    profit still requires a real win rate above the 51.02% breakeven
 *    for a 0.96 payout, plus the hard caps below.
 *  - Never run out: a ladder must fit inside a session risk budget of
 *    50% of balance AND leave a 30% untouchable reserve. A full ladder
 *    loss ends the session (3-loss circuit breaker) — no chasing.
 *  - Session hard stops: stop-loss at -20% of starting balance,
 *    stop-win lock at +20% (bank the profit and stop).
 */

export const PAYOUT = 0.96;
export const MULTIPLIER = 2;
export const BREAKEVEN_WIN_RATE = 1 / (1 + PAYOUT); // 0.5102…
export const RISK_BUDGET_FRACTION = 0.5; // a ladder may risk at most 50% of balance
export const RESERVE_FRACTION = 0.3; // 30% of balance is untouchable
export const SESSION_STOP_LOSS_FRACTION = 0.2;
export const SESSION_STOP_WIN_FRACTION = 0.2;
export const CIRCUIT_BREAKER_LOSSES = 3;
export const MIN_LADDER_LEVELS = 3;
export const MIN_BASE_BET = 1;

export const STAKING_MODES = {
  safe: { id: 'safe', name: 'SAFE', baseFraction: 0.005, description: 'Capital preservation: 0.5% of balance per base bet' },
  balanced: { id: 'balanced', name: 'BALANCED', baseFraction: 0.01, description: 'Recommended default: 1% of balance per base bet' },
  growth: { id: 'growth', name: 'GROWTH', baseFraction: 0.025, description: 'Faster growth, deeper drawdowns: 2.5% of balance' },
  aggressive: { id: 'aggressive', name: 'AGGRESSIVE', baseFraction: 0.05, description: 'Maximum aggression: 5% of balance, ladders get expensive fast' }
};
// Aliases matching the mode ids used in mobile.js.
STAKING_MODES.profitable = { ...STAKING_MODES.balanced, id: 'profitable' };
STAKING_MODES.risk = { ...STAKING_MODES.growth, id: 'risk' };
STAKING_MODES.high_risk = { ...STAKING_MODES.aggressive, id: 'high_risk' };

export const DEFAULT_STAKING_MODE = 'balanced';

const cleanBalance = b => {
  const n = Number(b);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function getStakingMode(mode) {
  return STAKING_MODES[mode] || STAKING_MODES[DEFAULT_STAKING_MODE];
}

/**
 * Suggested base bet for a mode: balance * fraction, rounded DOWN to
 * whole rupees, minimum ₹1. Returns 0 when there is no usable balance.
 */
export function suggestBaseBet(balance, mode = DEFAULT_STAKING_MODE) {
  const bal = cleanBalance(balance);
  if (bal <= 0) return 0;
  const { baseFraction } = getStakingMode(mode);
  return Math.max(MIN_BASE_BET, Math.floor(bal * baseFraction));
}

/** Total cost of the first `levels` rungs: base * (2^levels - 1). */
export function ladderCumulativeCost(base, levels) {
  if (!(base > 0) || !(levels > 0)) return 0;
  return base * (Math.pow(MULTIPLIER, levels) - 1);
}

/** Money that may be put at risk: inside the 50% budget AND above the 30% reserve. */
export function riskBudget(balance) {
  const bal = cleanBalance(balance);
  return Math.min(bal * RISK_BUDGET_FRACTION, bal * (1 - RESERVE_FRACTION));
}

/**
 * Largest number of doubling levels whose CUMULATIVE cost stays inside
 * the session risk budget (which itself protects the 30% reserve).
 */
export function ladderLevels(balance, base) {
  const bal = cleanBalance(balance);
  const b = Number(base);
  if (bal <= 0 || !(b >= MIN_BASE_BET)) return 0;
  const budget = riskBudget(bal);
  let levels = 0;
  while (ladderCumulativeCost(b, levels + 1) <= budget) levels += 1;
  return levels;
}

/**
 * Per-level ladder table for display: stake, cumulative risk, and the
 * net result if the win lands exactly at that level.
 */
export function ladderTable(balance, base, levels = ladderLevels(balance, base)) {
  const bal = cleanBalance(balance);
  const rows = [];
  let cumulative = 0;
  for (let i = 0; i < levels; i++) {
    const stake = base * Math.pow(MULTIPLIER, i);
    const lostBefore = cumulative;
    cumulative += stake;
    const netIfWin = stake * PAYOUT - lostBefore; // profit after covering earlier rungs
    rows.push({
      level: i + 1,
      stake,
      cumulativeRisk: cumulative,
      netIfWin: Math.round(netIfWin * 100) / 100,
      balanceIfWin: Math.round((bal - lostBefore + stake * PAYOUT) * 100) / 100,
      balanceIfLoss: bal - cumulative
    });
  }
  return rows;
}

/**
 * Plan a safe ladder for a balance. If even a 3-level ladder does not
 * fit at the suggested base, the base is lowered; if it would fall
 * below ₹1 the plan is a STOP — the balance is too low for a safe ladder.
 */
export function planLadder(balance, { mode = DEFAULT_STAKING_MODE, baseBet } = {}) {
  const bal = cleanBalance(balance);
  if (bal <= 0) {
    return { state: 'STOP', reason: 'No balance available, so no ladder can be planned.', baseBet: 0, levels: 0, cumulativeRisk: 0, riskBudget: 0, reserve: 0, table: [] };
  }
  let base = baseBet !== undefined ? Math.floor(Number(baseBet)) : suggestBaseBet(bal, mode);
  if (!(base >= MIN_BASE_BET)) base = MIN_BASE_BET;

  let levels = ladderLevels(bal, base);
  if (levels < MIN_LADDER_LEVELS) {
    // Largest base that still fits a minimum 3-level ladder.
    const maxBaseForMinLadder = Math.floor(riskBudget(bal) / (Math.pow(MULTIPLIER, MIN_LADDER_LEVELS) - 1));
    base = Math.min(base, maxBaseForMinLadder);
    if (!(base >= MIN_BASE_BET)) {
      return {
        state: 'STOP',
        reason: 'Balance too low for a safe ladder: even a ₹1 base cannot fit 3 levels inside the risk budget with the reserve protected.',
        baseBet: 0,
        levels: 0,
        cumulativeRisk: 0,
        riskBudget: riskBudget(bal),
        reserve: bal * RESERVE_FRACTION,
        table: []
      };
    }
    levels = ladderLevels(bal, base);
  }

  return {
    state: 'OK',
    reason: `${levels}-level ladder fits inside the session risk budget with the 30% reserve protected.`,
    baseBet: base,
    levels,
    cumulativeRisk: ladderCumulativeCost(base, levels),
    riskBudget: riskBudget(bal),
    reserve: bal * RESERVE_FRACTION,
    table: ladderTable(bal, base, levels)
  };
}

/** Create a session state object for settle(). */
export function createSession(balance, { mode = DEFAULT_STAKING_MODE, baseBet } = {}) {
  const bal = cleanBalance(balance);
  const plan = planLadder(bal, { mode, baseBet });
  return {
    startingBalance: bal,
    balance: bal,
    mode,
    baseBet: plan.baseBet,
    ladderLevels: plan.levels,
    planState: plan.state,
    planReason: plan.reason,
    level: 0, // 0-based rung of the ladder
    consecutiveLosses: 0,
    nextStake: plan.state === 'OK' ? plan.baseBet : 0,
    peakBalance: bal,
    drawdown: 0,
    sessionPnL: 0,
    rounds: 0,
    state: plan.state === 'OK' ? 'CONTINUE' : 'STOP'
  };
}

/**
 * Settle one bet inside a session (pure: returns a new result object,
 * the input session is not mutated).
 *
 * @param {object} session from createSession() (or a previous settle())
 * @param {boolean} won
 * @returns new session fields plus { stakeUsed, state, reason } where
 *  state is CONTINUE | RESET | STOP_LOSS | STOP_WIN | LADDER_EXHAUSTED.
 */
export function settle(session, won) {
  if (!session || session.state === 'STOP' || !(session.nextStake > 0)) {
    return { ...session, stakeUsed: 0, reason: 'Session is not active.' };
  }
  const stake = session.nextStake;
  const startingBalance = session.startingBalance;
  let balance = session.balance;
  let level = session.level;
  let consecutiveLosses = session.consecutiveLosses;
  let state;
  let reason;

  if (won) {
    balance += stake * PAYOUT;
    level = 0;
    consecutiveLosses = 0;
  } else {
    balance -= stake;
    consecutiveLosses += 1;
    level += 1;
  }

  const sessionPnL = Math.round((balance - startingBalance) * 100) / 100;
  const peakBalance = Math.max(session.peakBalance ?? startingBalance, balance);
  const drawdown = Math.round((peakBalance - balance) * 100) / 100;

  if (sessionPnL <= -(startingBalance * SESSION_STOP_LOSS_FRACTION)) {
    state = 'STOP_LOSS';
    reason = 'Session stop-loss hit: down 20% of the starting balance. The session ends here — no chasing.';
  } else if (sessionPnL >= startingBalance * SESSION_STOP_WIN_FRACTION) {
    state = 'STOP_WIN';
    reason = 'Stop-win lock: up 20% on the session. Bank the profit and stop.';
  } else if (!won && consecutiveLosses >= CIRCUIT_BREAKER_LOSSES) {
    state = 'LADDER_EXHAUSTED';
    reason = 'Circuit breaker: 3 losses in a row. The ladder ends and the session stops — no chasing beyond the ladder.';
  } else if (!won && level >= session.ladderLevels) {
    state = 'LADDER_EXHAUSTED';
    reason = 'Ladder exhausted: the full planned ladder was used. Session over — no extra rungs.';
  } else if (won) {
    state = 'RESET';
    reason = 'Win settled. Stake resets to the base bet.';
  } else {
    state = 'CONTINUE';
    reason = `Loss settled. Next rung doubles to ₹${stake * MULTIPLIER}.`;
  }

  const active = state === 'CONTINUE' || state === 'RESET';
  return {
    ...session,
    balance: Math.round(balance * 100) / 100,
    level,
    consecutiveLosses,
    peakBalance,
    drawdown,
    sessionPnL,
    rounds: (session.rounds || 0) + 1,
    stakeUsed: stake,
    nextStake: active ? session.baseBet * Math.pow(MULTIPLIER, level) : 0,
    state,
    reason
  };
}

/** Pure single-bet settlement: settleBet(balance, stake, won). */
export function settleBet(balance, stake, won) {
  const bal = Number(balance) || 0;
  const s = Number(stake) || 0;
  const delta = won ? s * PAYOUT : -s;
  return {
    balance: Math.round((bal + delta) * 100) / 100,
    delta: Math.round(delta * 100) / 100,
    won: won === true
  };
}

/** Balance-source labels, in the priority order the front consumes them. */
export const BALANCE_SOURCES = {
  DHANIWIN: 'dhaniwin',
  MANUAL: 'manual',
  SIMULATED: 'simulated',
  NONE: 'none'
};

export function balanceSourceLabel(source) {
  switch (source) {
    case BALANCE_SOURCES.DHANIWIN: return 'DhaniWin (live bridge)';
    case BALANCE_SOURCES.MANUAL: return 'Entered manually';
    case BALANCE_SOURCES.SIMULATED: return 'Simulated (prototype)';
    default: return 'Not detected';
  }
}

export const BALANCE_NOT_DETECTED_MESSAGE = 'Balance not detected — open the DhaniWin tab or enter it manually';

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PAYOUT, MULTIPLIER, BREAKEVEN_WIN_RATE, STAKING_MODES, DEFAULT_STAKING_MODE,
    suggestBaseBet, ladderLevels, ladderTable, ladderCumulativeCost, riskBudget,
    planLadder, createSession, settle, settleBet, BALANCE_SOURCES, balanceSourceLabel,
    BALANCE_NOT_DETECTED_MESSAGE
  };
}

if (typeof self !== "undefined") {
  self.Bankroll = { suggestBaseBet, ladderLevels, ladderTable, planLadder, createSession, settle, settleBet };
}
