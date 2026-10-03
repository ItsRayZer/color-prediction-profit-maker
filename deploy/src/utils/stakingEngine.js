/**
 * Capital Protection & Staking Calculator Engine
 * Prevents 3 consecutive losses from causing exponential account collapse / bankruptcy.
 */

export function calculateNextBet({
  bankroll = 1000,
  baseBet = 10,
  currentBet = 10,
  consecutiveLosses = 0,
  lastOutcome = 'WIN', // 'WIN' or 'LOSS'
  stakingStrategy = '3_LOSS_SAFETY', // '3_LOSS_SAFETY', 'FLAT', 'MARTINGALE_CAP_3', 'PAROLI'
  maxRecoveryLevel = 3,
  stopLossLimit = 300,
  takeProfitLimit = 500,
  initialBankroll = 1000
}) {
  const currentDrawdown = initialBankroll - bankroll;
  const currentProfit = bankroll - initialBankroll;

  // Check Stop-Loss / Take-Profit Triggers
  if (stopLossLimit > 0 && currentDrawdown >= stopLossLimit) {
    return {
      nextBet: 0,
      consecutiveLosses,
      status: 'STOP_LOSS_TRIGGERED',
      message: `🛑 STOP-LOSS TRIGGERED: Max drawdown limit ($${stopLossLimit}) reached. Trading paused for safety.`
    };
  }

  if (takeProfitLimit > 0 && currentProfit >= takeProfitLimit) {
    return {
      nextBet: 0,
      consecutiveLosses,
      status: 'TAKE_PROFIT_TRIGGERED',
      message: `🎉 TAKE-PROFIT TARGET REACHED: Profit ($${currentProfit}) reached target ($${takeProfitLimit})! Protect your gains.`
    };
  }

  let nextBet = baseBet;
  let newLossCount = lastOutcome === 'LOSS' ? consecutiveLosses + 1 : 0;
  let status = 'NORMAL';
  let message = 'Standard base bet sizing.';

  switch (stakingStrategy) {
    case '3_LOSS_SAFETY':
      if (lastOutcome === 'LOSS') {
        if (newLossCount >= maxRecoveryLevel) {
          // [SAFETY TRIGGERED] Circuit breaker trips after 3 consecutive losses!
          nextBet = baseBet;
          newLossCount = 0;
          status = 'CIRCUIT_BREAKER_RESET';
          message = `🛡️ 3-LOSS CIRCUIT BREAKER RESET: Reached ${maxRecoveryLevel} consecutive losses. Bet multiplier reset to base ($${baseBet}) to prevent bankruptcy.`;
        } else {
          // Controlled 3x progression up to max level
          nextBet = currentBet * 3;
          status = 'RECOVERY_PROGRESSION';
          message = `⚠️ Recovery progression level ${newLossCount}/${maxRecoveryLevel}. Next bet: $${nextBet}.`;
        }
      } else {
        nextBet = baseBet;
        status = 'WIN_RESET';
        message = `✅ Win secured! Reset bet size to base ($${baseBet}).`;
      }
      break;

    case 'FLAT':
      nextBet = baseBet;
      status = 'FLAT_STAKING';
      message = `Fixed flat bet sizing ($${baseBet}). Lowest risk profile.`;
      break;

    case 'PAROLI':
      // Reverse Martingale: Increase on win, reset on loss
      if (lastOutcome === 'WIN') {
        nextBet = Math.min(currentBet * 2, baseBet * 8);
        status = 'PAROLI_WIN_STREAK';
        message = `🚀 Paroli win streak active! Doubling bet to $${nextBet} using profits.`;
      } else {
        nextBet = baseBet;
        status = 'PAROLI_RESET';
        message = `Reset to base bet ($${baseBet}) following a loss.`;
      }
      break;

    default:
      nextBet = baseBet;
      break;
  }

  // Ensure bet doesn't exceed total bankroll
  nextBet = Math.max(1, Math.min(nextBet, bankroll));

  return {
    nextBet,
    consecutiveLosses: newLossCount,
    status,
    message
  };
}
