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
 * net result if the win lands exactly at that level. With
 * balanceFree (Phase 3B chip ladders) the balance columns are null:
 * there is no balance to project against, so no figure is invented.
 */
export function ladderTable(balance, base, levels = ladderLevels(balance, base), { balanceFree = false } = {}) {
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
      balanceIfWin: balanceFree ? null : Math.round((bal - lostBefore + stake * PAYOUT) * 100) / 100,
      balanceIfLoss: balanceFree ? null : bal - cumulative
    });
  }
  return rows;
}

/**
 * Fixed doubling rungs per mode for an EXPLICIT base (Phase 3B: the
 * user-selected chip, or an explicit AUTO sizing). Carried from the
 * Phase 3A balance-derived depths at ₹1000 (6/5/4/3) — now fixed caps,
 * so the ladder never depends on a synced balance. The 3-loss breaker
 * binds before these caps in practice; the caps are the backstop.
 */
export const MODE_LADDER_RUNG_CAPS = {
  safe: 6, balanced: 5, growth: 4, aggressive: 3,
  profitable: 5, risk: 4, high_risk: 3
};

/**
 * Plan a safe ladder for a balance. If even a 3-level ladder does not
 * fit at the suggested base, the base is lowered; if it would fall
 * below ₹1 the plan is a STOP — the balance is too low for a safe ladder.
 *
 * Phase 3B balance decoupling: when baseBet is EXPLICITLY provided
 * (user chip, or an explicit AUTO sizing), the ladder is planned from
 * the base alone with the fixed mode rung caps above — a synced
 * balance can neither gate it nor resize it. The balance path below
 * runs only when no explicit base is given (legacy suggestion).
 */
export function planLadder(balance, { mode = DEFAULT_STAKING_MODE, baseBet } = {}) {
  const bal = cleanBalance(balance);
  if (baseBet !== undefined && baseBet !== null && Number.isFinite(Number(baseBet))) {
    const base = Math.max(MIN_BASE_BET, Math.floor(Number(baseBet)));
    const levels = MODE_LADDER_RUNG_CAPS[mode] ?? MODE_LADDER_RUNG_CAPS[DEFAULT_STAKING_MODE];
    return {
      state: 'OK',
      reason: `${levels}-level ladder from your selected base (no balance needed; 3-loss breaker still guards).`,
      baseBet: base,
      levels,
      cumulativeRisk: ladderCumulativeCost(base, levels),
      riskBudget: null,
      reserve: 0,
      table: ladderTable(0, base, levels, { balanceFree: true })
    };
  }
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

  // Phase 3B: ±20% stops are balance-anchored, so they only fire when
  // a real starting balance exists. A balance-free session (user chip,
  // no synced balance) runs on the 3-loss breaker + rung cap instead —
  // without this guard the first loss would trip STOP_LOSS (PnL < 0 ≤ 0).
  if (startingBalance > 0 && sessionPnL <= -(startingBalance * SESSION_STOP_LOSS_FRACTION)) {
    state = 'STOP_LOSS';
    reason = 'Session stop-loss hit: down 20% of the starting balance. The session ends here — no chasing.';
  } else if (startingBalance > 0 && sessionPnL >= startingBalance * SESSION_STOP_WIN_FRACTION) {
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

// ── Phase 3A: bankroll slices, exact-ball sessions, persistence ────
/**
 * Sliced equal thirds (v2 recommendation, changeable on owner word):
 * the bankroll splits into one slice per bet type; each type's
 * session + ±20% stops run on its own slice, so one type's drawdown
 * never eats another type's stake. Whole rupees; the ₹0–2 remainder
 * goes to COLOR, then SIZE, then NUMBER (deterministic).
 * The LIVE colour/size session still runs on the full balance until
 * the owner says to flip it (see the build report) — this helper is
 * the slice model, and createExactSession takes a slice as input.
 */
export function sliceBalance(balance) {
  const bal = cleanBalance(balance);
  const base = Math.floor(bal / 3);
  const rem = bal - base * 3;
  return {
    COLOR: base + (rem >= 1 ? 1 : 0),
    SIZE: base + (rem >= 2 ? 1 : 0),
    NUMBER: base
  };
}

/** Exact-ball breaker (v2 §7.3 proposal, changeable on owner word). */
export const EXACT_BREAKER_LOSSES = 8;

/**
 * Exact-ball session factory — STRUCTURE ONLY. Returns null while
 * the exact gate is closed (no caller may fund an exact session
 * before live payout verification + harness PASS). When open, the
 * session is FLAT-stake (no doubling — one 7.82× win repays ~7.8 flat
 * losses, so doubling only explodes risk), with the 8-loss breaker
 * and ±20% stops on its slice. Same object shape as createSession
 * so future wiring is drop-in. `balance` here is the type's SLICE.
 */
export function createExactSession(balance, { mode = DEFAULT_STAKING_MODE, baseBet, gateOpen = false } = {}) {
  if (!gateOpen) return null;
  const bal = cleanBalance(balance);
  const hasBase = baseBet !== undefined && baseBet !== null && Number.isFinite(Number(baseBet));
  if (bal <= 0 && !hasBase) {
    return {
      startingBalance: 0, balance: 0, mode, baseBet: 0, ladderLevels: 0,
      planState: 'STOP', planReason: 'No balance available, so no exact session can be planned.',
      level: 0, consecutiveLosses: 0, nextStake: 0, peakBalance: 0, drawdown: 0,
      sessionPnL: 0, rounds: 0, state: 'STOP', progression: 'flat',
      breakerLosses: EXACT_BREAKER_LOSSES
    };
  }
  let base = hasBase ? Math.floor(Number(baseBet)) : suggestBaseBet(bal, mode);
  if (!(base >= MIN_BASE_BET)) base = MIN_BASE_BET;
  return {
    startingBalance: bal,
    balance: bal,
    mode,
    baseBet: base,
    ladderLevels: EXACT_BREAKER_LOSSES,
    planState: 'OK',
    planReason: bal > 0
      ? 'Flat-stake exact session: no doubling, 8-loss breaker, ±20% stops on the slice.'
      : 'Flat-stake exact session: no doubling, 8-loss breaker, ±20% stops dormant without a balance.',
    level: 0, // consecutive losses (the breaker counter for flat stakes)
    consecutiveLosses: 0,
    nextStake: base,
    peakBalance: bal,
    drawdown: 0,
    sessionPnL: 0,
    rounds: 0,
    state: 'CONTINUE',
    progression: 'flat',
    breakerLosses: EXACT_BREAKER_LOSSES
  };
}

/**
 * Settle one exact-ball bet (flat stakes, never doubling). `payout`
 * is the VERIFIED live profit multiple and is REQUIRED — when it is
 * missing, zero, or not finite the session is returned unchanged
 * with a refusal reason: no payout is ever invented, and the gate
 * being closed means this function has no live caller yet.
 */
export function settleExactFlat(session, won, payout) {
  if (!session || session.state === 'STOP' || !(session.nextStake > 0)) {
    return { ...session, stakeUsed: 0, reason: 'Session is not active.' };
  }
  if (payout === undefined || payout === null || !Number.isFinite(Number(payout)) || Number(payout) <= 0) {
    return { ...session, stakeUsed: 0, reason: 'No verified payout — exact settlement refused.' };
  }
  const stake = session.nextStake; // flat: always the base bet
  const startingBalance = session.startingBalance;
  let balance = session.balance;
  let consecutiveLosses = session.consecutiveLosses;
  let state;
  let reason;
  if (won) {
    balance += stake * Number(payout);
    consecutiveLosses = 0;
  } else {
    balance -= stake;
    consecutiveLosses += 1;
  }
  const level = consecutiveLosses; // flat: level tracks the loss run
  const sessionPnL = Math.round((balance - startingBalance) * 100) / 100;
  const peakBalance = Math.max(session.peakBalance ?? startingBalance, balance);
  const drawdown = Math.round((peakBalance - balance) * 100) / 100;
  const breaker = session.breakerLosses || EXACT_BREAKER_LOSSES;
  // Phase 3B: same balance guard as settle() — ±20% stops need a real
  // starting balance; a balance-free exact session runs on the breaker.
  if (startingBalance > 0 && sessionPnL <= -(startingBalance * SESSION_STOP_LOSS_FRACTION)) {
    state = 'STOP_LOSS';
    reason = 'Session stop-loss hit: down 20% of the slice. The session ends here — no chasing.';
  } else if (startingBalance > 0 && sessionPnL >= startingBalance * SESSION_STOP_WIN_FRACTION) {
    state = 'STOP_WIN';
    reason = 'Stop-win lock: up 20% on the slice. Bank the profit and stop.';
  } else if (!won && consecutiveLosses >= breaker) {
    state = 'LADDER_EXHAUSTED';
    reason = `Exact breaker: ${breaker} losses in a row. Flat stakes end here — no chasing.`;
  } else if (won) {
    state = 'RESET';
    reason = 'Win settled. Flat stake stays at the base bet.';
  } else {
    state = 'CONTINUE';
    reason = `Loss settled. Flat stake stays at the base bet (${consecutiveLosses}/${breaker} toward the breaker).`;
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
    nextStake: active ? session.baseBet : 0, // FLAT: never doubles
    state,
    reason
  };
}

// ── Ladder persistence (owner order 2026-10-26, add-on A) ───────────
// The live session used to live only in memory: a reload forgot the
// ladder (level, loss run, PnL, base) and the next stake silently
// reverted to the base rung — breaking doubling after a loss. These
// pure, storage-injected helpers save after every settlement/replan
// and resume on load, keyed per session/type. No secrets ever: only
// ladder numbers (level, stakes, PnL, mode) are stored.
// Resume rules (all must hold, else a fresh session starts):
//  - a saved record exists and parses with finite numbers;
//  - savedAt is within 24h (a ladder older than a day is stale);
//  - EITHER the live balance matches the saved running balance within
//    ₹0.01 (rounding only — a bigger gap means manual bets happened
//    while the app was closed, so the saved ladder is invalid),
//    OR no live balance is known at all (Phase 3B balance decoupling:
//    then the ladder resumes balance-free — level, loss run and base
//    carry, but every balance-derived field is zeroed so no stale
//    balance figure is ever shown or settled against).
export const SESSION_STORE_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_STORE_TOLERANCE = 0.01;

export function sessionStoreKey(type) {
  return `o101_session_v1_${String(type || 'SHARED').toUpperCase()}`;
}

export function saveSessionTo(storage, type, session) {
  try {
    if (!storage || !session) return false;
    const record = {
      savedAt: Date.now(),
      startingBalance: session.startingBalance,
      balance: session.balance,
      mode: session.mode,
      baseBet: session.baseBet,
      ladderLevels: session.ladderLevels,
      planState: session.planState,
      level: session.level,
      consecutiveLosses: session.consecutiveLosses,
      nextStake: session.nextStake,
      peakBalance: session.peakBalance,
      drawdown: session.drawdown,
      sessionPnL: session.sessionPnL,
      rounds: session.rounds,
      state: session.state
    };
    storage.setItem(sessionStoreKey(type), JSON.stringify(record));
    return true;
  } catch (e) { return false; }
}

export function loadSessionFrom(storage, type, liveBalance, now = Date.now()) {
  const none = (reason) => ({ session: null, reason });
  try {
    if (!storage) return none('no storage');
    const raw = storage.getItem(sessionStoreKey(type));
    if (!raw) return none('none saved');
    const d = JSON.parse(raw);
    const nums = ['startingBalance', 'balance', 'baseBet', 'level', 'consecutiveLosses',
      'nextStake', 'peakBalance', 'drawdown', 'sessionPnL', 'rounds'];
    for (const k of nums) {
      if (d[k] === undefined || d[k] === null || !Number.isFinite(Number(d[k]))) return none('corrupt');
    }
    if (!d.savedAt || (now - Number(d.savedAt)) > SESSION_STORE_TTL_MS) return none('stale');
    // Phase 3B: null/undefined/empty/NaN live balance means "no live
    // balance known" — Number(null) is 0 (finite), so the check must
    // happen BEFORE Number(), or a null balance would compare as ₹0
    // and wrongly invalidate the saved ladder.
    const live = (liveBalance === null || liveBalance === undefined || liveBalance === '')
      ? NaN : Number(liveBalance);
    if (!Number.isFinite(live)) {
      // Phase 3B balance-free resume: no live balance known, so the
      // ladder carries (level, loss run, base) but every balance-
      // derived field is zeroed — a saved balance figure is never
      // carried forward as if it were live.
      return {
        session: {
          startingBalance: 0,
          balance: 0,
          mode: d.mode || DEFAULT_STAKING_MODE,
          baseBet: Number(d.baseBet),
          ladderLevels: Number(d.ladderLevels) || 0,
          planState: d.planState || 'OK',
          planReason: 'Resumed ladder from saved session (no balance known).',
          level: Number(d.level),
          consecutiveLosses: Number(d.consecutiveLosses),
          nextStake: Number(d.nextStake),
          peakBalance: 0,
          drawdown: 0,
          sessionPnL: 0,
          rounds: Number(d.rounds),
          state: d.state || 'CONTINUE'
        },
        reason: 'resumed'
      };
    }
    if (Math.abs(live - Number(d.balance)) > SESSION_STORE_TOLERANCE) {
      return none('balance changed');
    }
    return {
      session: {
        startingBalance: Number(d.startingBalance),
        balance: live, // adopt the live figure (within rounding of saved)
        mode: d.mode || DEFAULT_STAKING_MODE,
        baseBet: Number(d.baseBet),
        ladderLevels: Number(d.ladderLevels) || 0,
        planState: d.planState || 'OK',
        planReason: 'Resumed ladder from saved session.',
        level: Number(d.level),
        consecutiveLosses: Number(d.consecutiveLosses),
        nextStake: Number(d.nextStake),
        peakBalance: Number(d.peakBalance),
        drawdown: Number(d.drawdown),
        sessionPnL: Number(d.sessionPnL),
        rounds: Number(d.rounds),
        state: d.state || 'CONTINUE'
      },
      reason: 'resumed'
    };
  } catch (e) { return none('corrupt'); }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PAYOUT, MULTIPLIER, BREAKEVEN_WIN_RATE, STAKING_MODES, DEFAULT_STAKING_MODE,
    suggestBaseBet, ladderLevels, ladderTable, ladderCumulativeCost, riskBudget,
    MODE_LADDER_RUNG_CAPS,
    planLadder, createSession, settle, settleBet, BALANCE_SOURCES, balanceSourceLabel,
    BALANCE_NOT_DETECTED_MESSAGE,
    sliceBalance, EXACT_BREAKER_LOSSES, createExactSession, settleExactFlat,
    SESSION_STORE_TTL_MS, SESSION_STORE_TOLERANCE, sessionStoreKey,
    saveSessionTo, loadSessionFrom
  };
}

if (typeof self !== "undefined") {
  self.Bankroll = { suggestBaseBet, ladderLevels, ladderTable, planLadder, createSession, settle, settleBet };
}
