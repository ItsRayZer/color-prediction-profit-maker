/**
 * PredictBot — the voice of the 01:01 prediction engine (Axo standard)
 * ====================================================================
 * Pure bot brain: no DOM, no I/O. It takes a context snapshot built from
 * the REAL engine state and returns the line the bot should say.
 *
 * Rules (the Axo standard from the Axofy assistant):
 *  - Reply to everything: every event gets a line, every question gets
 *    an answer built from real context. A SKIP is a decision and is
 *    always explained in plain words — never silence.
 *  - Full user context is fed in: balance + source, base bet, ladder
 *    level, next stake, session P&L, Incharge model + reason, gate
 *    decision + reason, calibrated confidence, streak, last result,
 *    circuit breaker state.
 *  - Tone: human, professional, lightly playful for greetings and wins.
 *    Tone switches fully OFF (serious, supportive, no jokes) for
 *    losses, circuit breaker trips and stop states — the drama-off rule
 *    for money problems.
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

const SERIOUS_EVENTS = new Set([
  BOT_EVENTS.LOSS,
  BOT_EVENTS.CIRCUIT_BREAKER,
  BOT_EVENTS.STOP_LOSS,
  BOT_EVENTS.STOP_WIN,
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
    circuitBreakerState: ctx.circuitBreakerState || 'ARMED',
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
    case BOT_EVENTS.GREETING: {
      const hello = c.userName ? `Hi ${c.userName}` : 'Hi there';
      line = `${hello}, I am watching the board for you. ${balancePhrase(c)} ${pnlPhrase(c)} ${c.inchargeName ? `The leading model right now is ${c.inchargeName}.` : 'No model has taken charge yet — I will speak up the moment a real signal forms.'}`;
      break;
    }
    case BOT_EVENTS.SIGNAL_BET: {
      const conf = pct(c.calibratedConfidence);
      line = `New signal: ${c.pick || 'the Incharge pick'} from ${c.inchargeName || 'the Incharge model'}${conf ? ` at ${conf} calibrated confidence` : ''}. ${c.inchargeReason ? c.inchargeReason + ' ' : ''}Suggested stake is ${inr(c.nextStake)} at ladder level ${c.ladderLevel + 1}. Small, planned, and inside your risk caps.`;
      break;
    }
    case BOT_EVENTS.SIGNAL_SKIP: {
      line = `I am skipping this round, and that is a deliberate decision. ${c.gateReason || 'The numbers do not clear the safety bar this round.'} Sitting out costs nothing; a weak bet costs real money. I will keep watching and call the next clean signal.`;
      break;
    }
    case BOT_EVENTS.MISSED_BET: {
      // The engine's locked verdict was BET and the round settled
      // with no bet fired. The win fact (and only the win fact) may
      // be named, and only from the settled result in the context.
      line = c.missedWon && c.missedResult
        ? `That was our pick, and it came ${c.missedResult}. Why didn't you bet? When a pick is staged, one tap on the confirm button fires it.`
        : `That was our pick… why didn't you bet? When a pick is staged, one tap on the confirm button fires it.`;
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
      line = `That one landed — ${c.lastResult ? String(c.lastResult) + ', ' : ''}well played for sticking to the plan. ${pnlPhrase(c)} Stake resets to your base bet of ${inr(c.baseBet)}. We enjoy it for a second, then it is back to the numbers.`;
      break;
    }
    case BOT_EVENTS.LOSS: {
      line = `That round went against us${c.lastResult ? ` (${String(c.lastResult)})` : ''}. ${pnlPhrase(c)} No chasing and no doubling beyond the plan — the ladder and the caps exist for exactly this moment. Take a breath; the next decision stays a numbers decision.`;
      break;
    }
    case BOT_EVENTS.LADDER_UP: {
      line = `Ladder level ${c.ladderLevel + 1} of ${c.ladderLevels || '?'} now. The next stake is ${inr(c.nextStake)}, which is the double from your ${inr(c.baseBet)} base, exactly as planned before the session started. If this rung also misses, the circuit breaker ends the ladder — there is no rung beyond the plan.`;
      break;
    }
    case BOT_EVENTS.CIRCUIT_BREAKER: {
      line = `Circuit breaker tripped: 3 losses in a row, so the ladder stops here and the session pauses. ${pnlPhrase(c)} This is the protection working, not a failure. Step away from the board, and only start a new session deliberately, never to win this one back.`;
      break;
    }
    case BOT_EVENTS.STOP_LOSS: {
      line = `Session stop-loss reached — down 20% of the starting balance, so betting stops for this session. ${pnlPhrase(c)} Protecting what is left matters more than any single round. Please do not start a revenge session; review the History first and decide with a clear head.`;
      break;
    }
    case BOT_EVENTS.STOP_WIN: {
      line = `Stop-win lock reached: this session is up 20%, so the profit is banked and betting stops here. ${pnlPhrase(c)} Walking away while ahead is the discipline that keeps a good session good.`;
      break;
    }
    case BOT_EVENTS.BALANCE_DETECTED: {
      line = `Balance detected: ${inr(c.balance)}${c.balanceSourceLabel ? ` (${c.balanceSourceLabel})` : ''}. Your suggested base bet is ${inr(c.baseBet)} per your staking mode, and the ladder is planned inside the risk budget with the reserve protected.`;
      break;
    }
    case BOT_EVENTS.BALANCE_LOW: {
      line = `Your balance of ${inr(c.balance)} is too low for a safe ladder — even a ₹1 base cannot fit 3 levels with the reserve protected. I will not suggest stakes on a balance that cannot survive the ladder. Add funds only if you had already planned to, never because a bot asked.`;
      break;
    }
    case BOT_EVENTS.BALANCE_NOT_DETECTED: {
      line = 'Balance not detected — open the DhaniWin tab or enter it manually (tap the ball, then the gear for settings). Until I see a real balance I will show signals only, with no stake suggestions.';
      break;
    }
    case BOT_EVENTS.MODEL_CHANGE: {
      line = `The lead changed: ${c.inchargeName || 'a new model'} is now Incharge. ${c.inchargeReason || 'It earned the lead on its measured record — sample size first, then its safety-adjusted score, not on one lucky streak.'} I follow the new lead from the next round.`;
      break;
    }
    default: {
      line = `${balancePhrase(c)} ${pnlPhrase(c)} ${c.gate === 'SKIP' ? `Current call: skip. ${c.gateReason || ''}` : c.inchargeName ? `Current lead: ${c.inchargeName}, next stake ${inr(c.nextStake)}.` : 'I am watching for the next clean signal.'}`;
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
    line = c.gate === 'SKIP' || c.gateReason
      ? `We skipped because: ${c.gateReason || 'the gate did not clear this round.'} A skip keeps your money for rounds where the calibrated chance actually clears the breakeven plus the safety margin.`
      : `There is no skip active right now — the current call is ${c.gate || 'being evaluated'} for ${c.pick || 'the next round'}. The gate skips when the sample is too small, the top models disagree, confidence is uncalibrated, or the edge sits below breakeven plus margin.`;
  } else if (q.includes('how') && (q.includes('prediction') || q.includes('signal') || q.includes('made') || q.includes('decide'))) {
    const conf = pct(c.calibratedConfidence);
    line = `Here is the chain, in order: 101 models each make a pick from the recent WinGo history. The Incharge engine ranks them by a safety-adjusted score — the Wilson lower bound of their win rate, which punishes small samples — blended with recent form. ${c.inchargeName || 'The leader'} leads${c.inchargeReason ? ` because ${c.inchargeReason}` : ''}. Its stated chance is then corrected against real outcomes by calibration${conf ? `, giving ${conf}` : ''}, and the gate only allows a bet when that clears breakeven plus margin with the top models agreeing.`;
  } else if (q.includes('why this signal') || q.includes('why bet') || q.includes('this signal')) {
    const conf = pct(c.calibratedConfidence);
    line = c.gate === 'SKIP'
      ? `Honestly, this round is a skip: ${c.gateReason || 'the gate did not clear it.'}`
      : `This signal comes from ${c.inchargeName || 'the Incharge model'} picking ${c.pick || 'its target'}${conf ? ` at ${conf} calibrated confidence` : ''}. ${c.inchargeReason || 'It leads the Arena on its safety-adjusted measured record.'} Suggested stake: ${inr(c.nextStake)} at ladder level ${c.ladderLevel + 1}.`;
  } else if (q.includes('base bet') || q.includes('base') || q.includes('stake') || q.includes('ladder') || q.includes('risk') && q.includes('money')) {
    line = `Your base bet is ${inr(c.baseBet)} — your staking mode's fraction of your ${inr(c.balance)} balance. On a loss the stake doubles per rung; a win pays stake × 0.96 and resets to base. The full ladder is ${c.ladderLevels || 'planned'} levels, its total cost is capped inside 50% of your balance, and 30% of the balance is an untouchable reserve. One honest note: doubling does not create an edge by itself — it only works alongside a real win rate above 51.02%.`;
  } else if (q.includes('leading') || q.includes('leader') || q.includes('incharge') || q.includes('which model') || q.includes('best model')) {
    line = c.inchargeName
      ? `${c.inchargeName} is Incharge. ${c.inchargeReason || 'It ranks first on the Wilson safety-adjusted score: think of it as the win rate we can defend after punishing small samples, blended with its last-100-rounds form.'} A model needs at least 200 evaluated rounds before it can hold the lead on merit; streak overrides now need a 5-win streak with real recent form behind them.`
      : 'No model is Incharge yet — the Arena is still building samples. A model needs 200 evaluated rounds before its record is trusted for the lead.';
  } else if (q.includes('balance') || q.includes('money status') || q.includes('money') || q.includes('p&l') || q.includes('profit') || q.includes('session')) {
    line = `${balancePhrase(c)} ${pnlPhrase(c)} Circuit breaker: ${String(c.circuitBreakerState).toLowerCase()}. Next stake if a bet is called: ${inr(c.nextStake)}. Session hard stops are fixed: stop at −20% (stop-loss) or +20% (bank the profit).`;
  } else if (q.includes('rule') || q.includes('stop') || q.includes('breaker')) {
    line = 'The money rules, plainly: base bet from your staking mode; losses double the stake up the ladder and a win resets it; 3 losses in a row trip the circuit breaker and end the ladder; the session stops at −20% (stop-loss) or +20% (stop-win, profit banked); 30% of the balance is never touched. And the gate skips any round without a measured edge — skipping is part of the system, not a failure of it.';
  } else if (q.includes('confidence') || q.includes('sure') || q.includes('accurate')) {
    const conf = pct(c.calibratedConfidence);
    line = conf
      ? `The current calibrated confidence is ${conf}${c.isCalibrated ? ', measured against real outcomes' : ' — and it is still marked uncalibrated, which means treat it as a rough estimate, not a promise'}. Calibration constantly compares what the models said with what actually happened; if those drift apart, the gate starts skipping. No number here is ever a certainty.`
      : 'There is no live confidence number this second because there is no active signal. When a signal forms, its confidence is the calibrated one — measured against real outcomes, not the raw model number.';
  } else {
    // Never silent: fall back to a full, real status answer.
    line = `${balancePhrase(c)} ${pnlPhrase(c)} ${c.inchargeName ? `Leading model: ${c.inchargeName}. ` : ''}${c.gate === 'SKIP' ? `Current call: skip — ${c.gateReason || 'the gate did not clear this round.'}` : c.gate === 'BET' ? `Current call: bet ${c.pick || ''} with a suggested stake of ${inr(c.nextStake)}.` : 'No bet is being called right now.'} Ask me why this signal, your money status, or which model is leading and I will break it down.`;
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
