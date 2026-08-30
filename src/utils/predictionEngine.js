/**
 * Dhani.win WinGo Quant Prediction Engine
 * Exact implementation of Markov 2nd Order + Shannon Entropy Noise Filter + Half-Kelly Sizing
 */

export const PAYOUT_RATIO = 1.96;
export const BREAKEVEN_P = 1.0 / PAYOUT_RATIO; // ~0.5102 (51.02%)
export const NET_ODDS_B = PAYOUT_RATIO - 1.0;  // 0.96

export function getColorForNumber(num) {
  const n = parseInt(num, 10);
  if (n === 0) return 'RED_VIOLET';
  if (n === 5) return 'GREEN_VIOLET';
  return (n % 2 === 1) ? 'GREEN' : 'RED';
}

export function getSizeForNumber(num) {
  const n = parseInt(num, 10);
  return n >= 5 ? 'BIG' : 'SMALL';
}

/**
 * Calculates Shannon Entropy over recent size outcomes
 * H = -(p*log2(p) + q*log2(q))
 * Returns value between 0.0 (pure order) and 1.0 (pure randomness / noise)
 */
export function calculateEntropy(sizes) {
  if (!sizes || sizes.length === 0) return 1.0;
  const bigCount = sizes.filter(s => s === 'BIG').length;
  const p = bigCount / sizes.length;
  const q = 1.0 - p;
  if (p === 0 || q === 0) return 0.0;
  return -(p * Math.log2(p) + q * Math.log2(q));
}

/**
 * Calculates 2nd Order Markov Chain transition probabilities
 * Key: ${state_{t-2}}_${state_{t-1}}
 */
export function calculateMarkov2ndOrder(history) {
  if (!history || history.length < 5) return { probBig: 0.5, count: 0 };
  
  const sPrev2 = history[history.length - 2].size;
  const sPrev1 = history[history.length - 1].size;
  const key = `${sPrev2}_${sPrev1}`;

  let matches = 0;
  let bigFollows = 0;

  for (let i = 2; i < history.length - 1; i++) {
    if (`${history[i-2].size}_${history[i-1].size}` === key) {
      matches++;
      if (history[i].size === 'BIG') bigFollows++;
    }
  }

  if (matches < 3) return { probBig: 0.5, count: matches };
  return { probBig: bigFollows / matches, count: matches };
}

/**
 * Main Quantitative Signal Generator
 */
export function runQuantEngine({ history, balance, lossStreak, cooloffRounds }) {
  const n = history.length;
  if (n < 4) {
    return {
      decision: 'SKIP',
      target: null,
      stake: 0,
      estProb: 0.5,
      entropy: 1.0,
      reason: 'Gathering data samples...'
    };
  }

  const recentSizes = history.slice(-20).map(r => r.size);
  const entropy = calculateEntropy(recentSizes);
  const markov = calculateMarkov2ndOrder(history);

  // Streak detection
  let streak = 1;
  const lastOutcome = history[n - 1].size;
  for (let k = 2; k <= Math.min(n, 12); k++) {
    if (history[n - k].size === lastOutcome) streak++;
    else break;
  }

  // Circuit Breaker Cool-off Check
  if (cooloffRounds > 0) {
    return {
      decision: 'SKIP',
      target: null,
      stake: 0,
      entropy,
      estProb: 0.5,
      reason: `Breaker Tripped (${cooloffRounds}R Cool-off Active)`
    };
  }

  // Entropy Noise Filter (>0.94 signals high entropy / noise)
  if (entropy > 0.94) {
    return {
      decision: 'SKIP',
      target: null,
      stake: 0,
      entropy,
      estProb: 0.5,
      reason: 'High Entropy (Noise Dominant) - Skip'
    };
  }

  // Target and Probability Detection
  let target = null;
  let prob = 0.5;

  if (markov.count >= 3 && Math.abs(markov.probBig - 0.5) >= 0.12) {
    target = markov.probBig > 0.5 ? 'BIG' : 'SMALL';
    prob = Math.max(markov.probBig, 1 - markov.probBig);
  } else if (streak >= 3) {
    target = lastOutcome; // Streak Continuation Edge
    prob = 0.56;
  }

  // Half-Kelly Criterion Bet Sizing
  if (target && prob > BREAKEVEN_P) {
    const q = 1.0 - prob;
    const fStar = (prob * NET_ODDS_B - q) / NET_ODDS_B;
    
    // Capped progressive recovery factor
    const recoveryFactor = lossStreak > 0 ? Math.pow(1.6, lossStreak) : 1.0;
    const appliedFraction = Math.min(fStar * 0.5 * recoveryFactor, 0.06); // Max 6% stake
    const computedStake = Math.max(1.0, Math.round(balance * appliedFraction * 100) / 100);

    return {
      decision: 'BET',
      target,
      stake: computedStake,
      estProb: prob,
      entropy,
      reason: lossStreak > 0 ? `Step ${lossStreak + 1} Risk Recovery` : `Markov Edge (${Math.round(prob * 100)}% EV)`
    };
  }

  return {
    decision: 'SKIP',
    target: null,
    stake: 0,
    entropy,
    estProb: 0.5,
    reason: 'Sub-threshold Edge (EV ≤ 0)'
  };
}

export function mapColor(color) {
  if (!color) return 'green';
  const c = String(color).toLowerCase();
  if (c.includes('green')) return 'green';
  if (c.includes('red')) return 'red';
  return 'green';
}

export function analyzePrediction(history) {
  if (!history || history.length === 0) {
    return {
      color: 'green',
      confidence: 50,
      reasoning: 'Initial data gathering phase',
      greenProb: 50,
      redProb: 50
    };
  }

  const recent = history.slice(-20);
  const greenCount = recent.filter(r => r.color && r.color.includes('green')).length;
  const redCount = recent.filter(r => r.color && r.color.includes('red')).length;
  const total = recent.length;

  let greenProb = Math.round((greenCount / total) * 100);
  let redProb = 100 - greenProb;

  const lastColor = history[history.length - 1]?.color || 'green';
  let streak = 1;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i]?.color === lastColor) streak++;
    else break;
  }

  let predictedColor = greenProb >= redProb ? 'green' : 'red';
  let confidence = Math.max(greenProb, redProb);
  let reasoning = `Base frequency analysis (${greenCount}G / ${redCount}R in last ${total} rounds)`;

  if (streak >= 3) {
    const isGreenStreak = lastColor.includes('green');
    predictedColor = isGreenStreak ? 'red' : 'green';
    confidence = Math.min(85, 55 + streak * 5);
    reasoning = `Streak reversal signal after ${streak} consecutive ${lastColor.toUpperCase()} rounds`;
    if (predictedColor === 'green') {
      greenProb = confidence;
      redProb = 100 - confidence;
    } else {
      redProb = confidence;
      greenProb = 100 - confidence;
    }
  }

  return {
    color: predictedColor,
    confidence,
    reasoning,
    greenProb,
    redProb
  };
}
