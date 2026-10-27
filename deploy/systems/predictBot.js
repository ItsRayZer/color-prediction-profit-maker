/**
 * PredictBot — the voice of the 01:01 prediction engine (Axo standard)
 * ====================================================================
 * Pure bot brain: no DOM, no I/O. It takes a context snapshot built from
 * the REAL engine state and returns the line the bot should say.
 *
 * Rules (the Axo standard from the Axofy assistant):
 *  - Reply to everything: every event gets a line, every question gets
 *    an answer built from real context. Phase 3D: no SKIP verdicts
 *    exist — every round shows a pick with its honest quality.
 *  - Full user context is fed in: balance + source, base bet, ladder
 *    level, next stake, session P&L, Incharge model + reason, gate
 *    decision + reason, calibrated confidence, streak, last result.
 *  - Tone: human, professional, lightly playful for greetings and wins.
 *    Tone switches fully OFF (serious, supportive, no jokes) for
 *    losses — the drama-off rule for money problems.
 *  - Honesty: lines use only the numbers in the snapshot. The bot never
 *    invents a confidence, never promises profit, and says plainly when
 *    a balance or a signal is missing.
 */

export const BOT_EVENTS = {
  GREETING: 'GREETING',
  SIGNAL_BET: 'SIGNAL_BET',
  SIGNAL_SKIP: 'SIGNAL_SKIP',
  MISSED_BET: 'MISSED_BET',
  LOGIN_VERIFIED: 'LOGIN_VERIFIED',
  WIN: 'WIN',
  LOSS: 'LOSS',
  LADDER_UP: 'LADDER_UP',
  CIRCUIT_BREAKER: 'CIRCUIT_BREAKER',
  STOP_LOSS: 'STOP_LOSS',
  STOP_WIN: 'STOP_WIN',
  BALANCE_DETECTED: 'BALANCE_DETECTED',
  BALANCE_LOW: 'BALANCE_LOW',
  BALANCE_NOT_DETECTED: 'BALANCE_NOT_DETECTED',
  MODEL_CHANGE: 'MODEL_CHANGE',
  INCHARGE_CHANGE: 'MODEL_CHANGE'
};

// Phase 3D: the stop events are deleted (no stops exist), so the
// serious set is losses + low balance + missed bets only.
const SERIOUS_EVENTS = new Set([
  BOT_EVENTS.LOSS,
  BOT_EVENTS.BALANCE_LOW,
  BOT_EVENTS.MISSED_BET
]);
const PLAYFUL_EVENTS = new Set([BOT_EVENTS.GREETING, BOT_EVENTS.WIN, BOT_EVENTS.SIGNAL_BET, BOT_EVENTS.LOGIN_VERIFIED]);

const inr = n => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '₹0';
  return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: v % 1 === 0 ? 0 : 2 });
};
const pct = p => {
  const v = Number(p);
  if (!Number.isFinite(v)) return null;
  return (v <= 1 ? v * 100 : v).toFixed(1) + '%';
};
function normCtx(ctx = {}) {
  const model = ctx.inchargeModel;
  const gate = ctx.gateDecision && typeof ctx.gateDecision === 'object' ? ctx.gateDecision : null;
  return {
    userName: ctx.userName || null,
    balance: ctx.balance !== undefined && ctx.balance !== null ? Number(ctx.balance) : null,
    balanceSource: ctx.balanceSource || 'none',
    balanceSourceLabel: ctx.balanceSourceLabel || null,
    baseBet: Number(ctx.baseBet) || 0,
    ladderLevel: Number(ctx.ladderLevel) || 0,
    ladderLevels: Number(ctx.ladderLevels) || 0,
    nextStake: Number(ctx.nextStake) || 0,
    // Task R (owner order 2026-10-26): the caller knows whether a
    // bankroll session exists. Tri-state on purpose: true = session
    // (stake is real), false = NO session (stake is unknown, never
    // ₹0), undefined = legacy callers that do not say — they keep
    // the old stake rendering so old tests and paths do not flip.
    hasSession: ctx.hasSession,
    sessionPnL: Number(ctx.sessionPnL) || 0,
    startingBalance: Number(ctx.startingBalance) || 0,
    inchargeName: typeof model === 'string' ? model : (model ? (model.name || model.id || null) : null),
    inchargeReason: ctx.inchargeReason || (model && model.reason) || null,
    gate: gate ? (gate.decision || null) : (typeof ctx.gateDecision === 'string' ? ctx.gateDecision : null),
    gateReason: ctx.gateReason || (gate ? gate.reason : null) || null,
    pick: ctx.pick || (gate ? gate.pick : null) || null,
    // MISSED_BET facts — all read from the SETTLED round (the locked
    // pick + the real settled result), never a recomputation. The
    // result is only ever named when the missed pick would have won.
    missedPick: ctx.missedPick || null,
    missedWon: ctx.missedWon === true,
    missedResult: ctx.missedResult || null,
    calibratedConfidence: ctx.calibratedConfidence !== undefined ? ctx.calibratedConfidence : (ctx.confidence !== undefined ? ctx.confidence : null),
    isCalibrated: ctx.isCalibrated === true,
    streak: Number(ctx.streak) || 0,
    lastResult: ctx.lastResult || null,
    belowBar: ctx.belowBar === true,
    sessionState: ctx.sessionState || null
  };
}

function balancePhrase(c) {
  if (c.balance === null || !(c.balance >= 0) || c.balanceSource === 'none') {
    return 'I cannot see a balance yet — open the DhaniWin tab or enter it manually from my settings (tap the ball, then the gear) and I will plan stakes from the real number.';
  }
  const src = c.balanceSourceLabel ? ` from ${c.balanceSourceLabel}` : '';
  return `Your balance is ${inr(c.balance)}${src}.`;
}

function pnlPhrase(c) {
  if (!c.startingBalance) return 'No session is running yet, so there is no session profit or loss to report.';
  const dir = c.sessionPnL >= 0 ? 'up' : 'down';
  return `This session you are ${dir} ${inr(Math.abs(c.sessionPnL))} from a ${inr(c.startingBalance)} start.`;
}

/** Build the bot's line for an event. Always returns a non-empty line. */
export function botLine(event, context = {}) {
  const c = normCtx(context);
  const tone = SERIOUS_EVENTS.has(event) ? 'serious' : (PLAYFUL_EVENTS.has(event) ? 'playful' : 'neutral');
  let line;

  switch (event) {
    case BOT_EVENTS.SIGNAL_BET: {
      // Phase 3B: short form — pick + stake + level only. The
      // balance-decoupled session always exists (user chip, default
      // ₹2), so the old "no stake yet — balance unknown" line is
      // deleted entirely: it is impossible by construction now.
      // Phase 3D: a below-bar pick says so plainly (same ≤80-char
      // shape — voice speaks exactly the subtitle string).
      const pick = c.pick || 'the Incharge pick';
      line = c.belowBar
        ? `Signal: ${pick} · ${inr(c.nextStake)} · level ${c.ladderLevel + 1} (below bar).`
        : `New signal: ${pick} · ${inr(c.nextStake)} · level ${c.ladderLevel + 1}.`;
      break;
    }
    case BOT_EVENTS.MISSED_BET: {
      // Task R: short form. The win fact is still named ONLY when
      // the missed pick would have won (missedWon + missedResult);
      // a lost pick names no result at all. The tap guidance stays.
      line = c.missedWon && c.missedResult
        ? `That pick won (${c.missedResult}) — missed it. One tap fires a staged pick.`
        : `That pick settled — missed it. One tap fires a staged pick.`;
      break;
    }
    case BOT_EVENTS.LOGIN_VERIFIED: {
      // Only ever built from the verifier's API-proven balance (the
      // caller gates on balanceSource === 'api'); never a page scrape.
      line = c.balance !== null
        ? `Login verified. Exact balance, ${inr(c.balance)}.`
        : 'Login verified.';
      break;
    }
    case BOT_EVENTS.WIN: {
      // Task R: short form — verdict + settled result + stake reset.
      line = `Win${c.lastResult ? ` (${String(c.lastResult)})` : ''} — stake resets to ${inr(c.baseBet)}.`;
      break;
    }
    case BOT_EVENTS.LOSS: {
      // Task R: short form — verdict + settled result + no chasing.
      line = `Loss${c.lastResult ? ` (${String(c.lastResult)})` : ''} — No chasing, ladder moves on.`;
      break;
    }
    case BOT_EVENTS.LADDER_UP: {
      // Task R: short form — level + next stake + the double.
      // Phase 3D: no stop explanation exists anymore (no stops) —
      // just the rung.
      line = `Ladder level ${c.ladderLevel + 1} — next stake ${inr(c.nextStake)}, the double.`;
      break;
    }
    default: {
      // Phase 3B: the ONLY fallback line, kept short by contract
      // (botLine must return a non-empty line for any event). The
      // GREETING, BALANCE_DETECTED / BALANCE_LOW /
      // BALANCE_NOT_DETECTED and MODEL_CHANGE cases were DELETED
      // outright by owner order 2026-10-27 ("remove the long text"):
      // a routine lead change needs no announcement (leadership is
      // visible in the panel), and balance notices are obsolete
      // under balance decoupling. Any legacy call with those event
      // names lands here on this one short line — never on a long
      // announcement again. The BOT_EVENTS constants themselves stay
      // as harmless routing metadata (orb-bridge's system-routing set
      // references them); nothing speaks them anymore.
      line = 'Watching for the next signal.';
      break;
    }
  }

  return { event, line: line.replace(/\s+/g, ' ').trim(), tone };
}

export const getBotLine = botLine;
export const eventLine = (event, context) => botLine(event, context).line;

/** Spoken/display lines for a batch of events, in order. */
export function eventLines(events = [], context = {}) {
  return events.map(e => botLine(e, context));
}

/**
 * Answer a user question from the real context only. Every question
 * gets an answer; when the exact fact is not in the snapshot, the bot
 * answers with the closest real state instead of going silent.
 */
export function answerQuestion(question, context = {}) {
  const c = normCtx(context);
  const q = String(question || '').toLowerCase();
  let line;

  if (q.includes('skip') || q.includes('why not bet') || q.includes('no bet')) {
    // Phase 3D: skips are gone — every round shows a pick. A
    // below-bar pick says so and stakes at a reduced tier.
    line = c.belowBar
      ? `No skips anymore — every round shows a pick. This round's pick is ${c.pick || 'being evaluated'}${c.gateReason ? ` (${c.gateReason})` : ''} — below the safety bar, so the stake is scaled down and you decide with the tap.`
      : `No skips anymore — every round shows a pick. The current call is ${c.gate || 'being evaluated'} for ${c.pick || 'the next round'}${c.gateReason ? ` (${c.gateReason})` : ''}.`;
  } else if (q.includes('how') && (q.includes('prediction') || q.includes('signal') || q.includes('made') || q.includes('decide'))) {
    const conf = pct(c.calibratedConfidence);
    line = `Here is the chain, in order: 137 models each make a pick from the recent WinGo history. The Incharge engine ranks them by a safety-adjusted score — the Wilson lower bound of their win rate, which punishes small samples — blended with recent form. ${c.inchargeName || 'The leader'} leads${c.inchargeReason ? ` because ${c.inchargeReason}` : ''}. Its stated chance is then corrected against real outcomes by calibration${conf ? `, giving ${conf}` : ''}, and every round shows the best pick with its honest quality — below-bar picks show their gap and stake at a reduced tier, and you decide with the tap.`;
  } else if (q.includes('why this signal') || q.includes('why bet') || q.includes('this signal')) {
    const conf = pct(c.calibratedConfidence);
    line = c.belowBar
      ? `This signal comes from ${c.inchargeName || 'the Incharge model'} picking ${c.pick || 'its target'}${conf ? ` at ${conf} calibrated confidence` : ''}. It is below the safety bar (${c.gateReason || 'quality below bar'}), so the stake is scaled down. Suggested stake: ${inr(c.nextStake)} at ladder level ${c.ladderLevel + 1}.`
      : `This signal comes from ${c.inchargeName || 'the Incharge model'} picking ${c.pick || 'its target'}${conf ? ` at ${conf} calibrated confidence` : ''}. ${c.inchargeReason || 'It leads the Arena on its safety-adjusted measured record.'} Suggested stake: ${inr(c.nextStake)} at ladder level ${c.ladderLevel + 1}.`;
  } else if (q.includes('base bet') || q.includes('base') || q.includes('stake') || q.includes('ladder') || q.includes('risk') && q.includes('money')) {
    line = `Your base bet is ${inr(c.baseBet)} — your selected chip (or AUTO sizing when opted in). On a loss the stake doubles; a win pays stake × 0.96 and resets to base. The ladder keeps doubling on every loss until a win — no rung cap ends it, no restart at base. If a doubled stake exceeds your balance, the app shows the required stake plus the shortfall plainly and you decide with the tap; it never silently reduces a stake. One honest note: doubling does not create an edge by itself — it only works alongside a real win rate above 51.02%.`;
  } else if (q.includes('leading') || q.includes('leader') || q.includes('incharge') || q.includes('which model') || q.includes('best model')) {
    line = c.inchargeName
      ? `${c.inchargeName} is Incharge. ${c.inchargeReason || 'It ranks first on the Wilson safety-adjusted score: think of it as the win rate we can defend after punishing small samples, blended with its last-100-rounds form.'} Bets scale with evidence: below 200 evaluated rounds the stake is reduced (0.25× under 50, 0.5× under 100, 0.75× under 200) and full stake starts at 200; streak overrides now need a 5-win streak with real recent form behind them.`
      : 'No model is Incharge yet — the Arena is still building samples. Once a model leads, it can bet as soon as its Wilson bound clears breakeven plus margin, at a stake scaled to its evaluated rounds.';
  } else if (q.includes('balance') || q.includes('money status') || q.includes('money') || q.includes('p&l') || q.includes('profit') || q.includes('session')) {
    line = `${balancePhrase(c)} ${pnlPhrase(c)} Next stake if a bet is called: ${inr(c.nextStake)}. No stops exist: the ladder keeps doubling until a win, and an over-balance stake shows its shortfall for your tap decision.`;
  } else if (q.includes('rule') || q.includes('stop') || q.includes('breaker')) {
    line = 'The money rules, plainly: base bet from your selected chip (or AUTO sizing); losses double the stake and a win resets it; the ladder keeps doubling until a win with no cap and no restart; if a doubled stake exceeds your balance, the app shows the required stake plus the shortfall and you decide with the tap. Every round shows a pick with its honest quality — below-bar picks stake at a reduced tier.';
  } else if (q.includes('confidence') || q.includes('sure') || q.includes('accurate')) {
    const conf = pct(c.calibratedConfidence);
    line = conf
      ? `The current calibrated confidence is ${conf}${c.isCalibrated ? ', measured against real outcomes' : ' — and it is still marked uncalibrated, which means treat it as a rough estimate, not a promise'}. Calibration constantly compares what the models said with what actually happened; if those drift apart, the pick shows below-bar with a reduced stake. No number here is ever a certainty.`
      : 'There is no live confidence number this second because there is no active signal. When a signal forms, its confidence is the calibrated one — measured against real outcomes, not the raw model number.';
  } else {
    // Never silent: fall back to a full, real status answer.
    line = `${balancePhrase(c)} ${pnlPhrase(c)} ${c.inchargeName ? `Leading model: ${c.inchargeName}. ` : ''}${c.gate === 'BET' ? `Current call: bet ${c.pick || ''} with a suggested stake of ${inr(c.nextStake)}${c.belowBar ? ' (below bar — reduced tier)' : ''}.` : 'No pick is available right now (empty pool).'} Ask me why this signal, your money status, or which model is leading and I will break it down.`;
  }

  return { line: line.replace(/\s+/g, ' ').trim(), tone: SERIOUS_EVENTS.has(context.lastEvent) ? 'serious' : 'neutral' };
}

export class PredictBot {
  constructor() {
    this.lastEvent = null;
  }
  speak(event, context = {}) {
    this.lastEvent = event;
    return botLine(event, context);
  }
  ask(question, context = {}) {
    return answerQuestion(question, context);
  }
}

export function createPredictBot() {
  return new PredictBot();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { BOT_EVENTS, botLine, getBotLine, eventLine, eventLines, answerQuestion, PredictBot, createPredictBot };
}

if (typeof self !== "undefined") {
  self.PredictBot = PredictBot;
  self.botLine = botLine;
}
