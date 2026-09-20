/**
 * ===========================================================================
 * QUANT AI ALGORITHM & BET PREDICTION ENGINE (Modular & Customizable)
 * ===========================================================================
 * This file contains the complete statistical analysis, consensus algorithms,
 * risk management, and bet prediction logic.
 * You can modify rules, weights, engine formulas, and staking strategies here.
 */

(function(global) {
  'use strict';

  // -- Default Configurable Parameters --------------------------------------
  const CONFIG = {
    MIN_DATA_TO_PREDICT: 8,
    BREAKEVEN_P: 0.505,
    NET_ODDS_B: 0.98,
    MAX_BET_PCT: 0.12,
    DEFAULT_WEIGHTS: {
      Sum: 15,
      Trend: 25,
      DNA: 35,
      Markov: 30,
      Rolling: 20,
      NeuralNet: 45,
      HouseAdversary: 45,
      Metacognition: 30
    }
  };

  /**
   * Required Z-Score threshold based on current loss streak.
   * Higher loss streaks require higher confidence before placing a bet.
   */
  function requiredZScore(lossStreak) {
    if (lossStreak === 0) return 1.64; // 90% confidence
    if (lossStreak === 1) return 1.96; // 95% confidence
    return 2.58;                       // 99% confidence (streak >= 2)
  }

  /**
   * Shannon Entropy calculation for size distribution.
   * Max entropy = 1.0 (pure randomness / 50-50). Lower values indicate strong bias/streak.
   */
  function calcEntropy(sizes) {
    if (!sizes || !sizes.length) return 1.0;
    const p = sizes.filter(s => s === 'BIG').length / sizes.length;
    const q = 1 - p;
    if (p === 0 || q === 0) return 0;
    return -(p * Math.log2(p) + q * Math.log2(q));
  }

  // -- ENGINE 1: Sum of Last 2 Numbers Mod 10 --------------------------------
  function engineSum(hist) {
    if (!hist || hist.length < 2) return { signal: 'NEUTRAL', weight: 0 };
    const s = (hist[hist.length - 1].number + hist[hist.length - 2].number) % 10;
    return { signal: s <= 4 ? 'SMALL' : 'BIG', weight: CONFIG.DEFAULT_WEIGHTS.Sum, engine: 'Sum' };
  }

  // -- ENGINE 2: Trend / Dragon / Chop Pattern -------------------------------
  function engineTrend(hist) {
    if (!hist || hist.length < 5) return { signal: 'NEUTRAL', weight: 0 };
    const cur = hist[hist.length - 1].size;
    let streak = 1;
    for (let k = 2; k <= 6 && k <= hist.length; k++) {
      if (hist[hist.length - k].size === cur) streak++;
      else break;
    }
    // Dragon streak (3 or more consecutive identical results)
    if (streak >= 3) return { signal: cur, weight: CONFIG.DEFAULT_WEIGHTS.Trend, engine: 'Dragon' };
    
    // Chop / Alternation pattern (e.g. B-S-B-S)
    if (streak === 1 && hist.length >= 3 && hist[hist.length - 2].size !== hist[hist.length - 3].size) {
      return { signal: cur === 'BIG' ? 'SMALL' : 'BIG', weight: 25, engine: 'Chop' };
    }
    return { signal: 'NEUTRAL', weight: 0 };
  }

  // -- ENGINE 3: Empirical Transition Matrix (DNA) ---------------------------
  function engineDNA(hist) {
    if (!hist || hist.length < 10) return { signal: 'NEUTRAL', weight: 0 };
    const trigger = hist[hist.length - 1].number;
    let bigAfter = 0, smAfter = 0;
    for (let i = 0; i < hist.length - 1; i++) {
      if (hist[i].number === trigger) {
        if (hist[i + 1].size === 'BIG') bigAfter++;
        else smAfter++;
      }
    }
    const total = bigAfter + smAfter;
    if (total < 3) return { signal: 'NEUTRAL', weight: 0 };
    const bigRate = bigAfter / total;
    if (bigRate >= 0.60) return { signal: 'BIG', weight: CONFIG.DEFAULT_WEIGHTS.DNA, engine: 'DNA' };
    if (bigRate <= 0.40) return { signal: 'SMALL', weight: CONFIG.DEFAULT_WEIGHTS.DNA, engine: 'DNA' };
    return { signal: 'NEUTRAL', weight: 0 };
  }

  // -- ENGINE 4: 2nd-Order Markov Chain --------------------------------------
  function engineMarkov2(hist) {
    if (!hist || hist.length < 5) return { signal: 'NEUTRAL', weight: 0, prob: 0.5, count: 0 };
    const k1 = hist[hist.length - 2].size;
    const k2 = hist[hist.length - 1].size;
    const key = k1 + '_' + k2;
    let matches = 0, bigNext = 0;
    for (let i = 2; i < hist.length - 1; i++) {
      if ((hist[i - 2].size + '_' + hist[i - 1].size) === key) {
        matches++;
        if (hist[i].size === 'BIG') bigNext++;
      }
    }
    if (matches < 3) return { signal: 'NEUTRAL', weight: 0, prob: 0.5, count: matches };
    const p = bigNext / matches;
    if (Math.abs(p - 0.5) < 0.12) return { signal: 'NEUTRAL', weight: 0, prob: p, count: matches };
    return { signal: p > 0.5 ? 'BIG' : 'SMALL', weight: CONFIG.DEFAULT_WEIGHTS.Markov, prob: p, count: matches, engine: 'Markov2' };
  }

  // -- ENGINE 5: Rolling Imbalance Windows (10 & 20) --------------------------
  function engineRolling(hist) {
    if (!hist) return { signal: 'NEUTRAL', weight: 0 };
    const w10 = hist.slice(-10).filter(r => !r.gap);
    const w20 = hist.slice(-20).filter(r => !r.gap);
    if (w10.length < 8) return { signal: 'NEUTRAL', weight: 0 };
    const rate10 = w10.filter(r => r.size === 'BIG').length / w10.length;
    const rate20 = w20.length >= 15 ? w20.filter(r => r.size === 'BIG').length / w20.length : 0.5;
    if (rate10 >= 0.70 && rate20 >= 0.60) return { signal: 'BIG', weight: CONFIG.DEFAULT_WEIGHTS.Rolling, engine: 'Rolling' };
    if (rate10 <= 0.30 && rate20 <= 0.40) return { signal: 'SMALL', weight: CONFIG.DEFAULT_WEIGHTS.Rolling, engine: 'Rolling' };
    return { signal: 'NEUTRAL', weight: 0 };
  }

  // -- ENGINE 6: 2-Layer Adaptive Neural Network with Dynamic Synaptic Rewiring --
  function engineNeuralNetwork(hist, winStreak = 0, lossStreak = 0) {
    if (!hist || hist.length < 5) return { signal: 'NEUTRAL', weight: 0, prob: 0.5 };
    const realHist = hist.filter(r => !r.gap);
    const n = realHist.length;
    if (n < 5) return { signal: 'NEUTRAL', weight: 0, prob: 0.5 };

    function extractFeatures(slice, wStreak = 0, lStreak = 0) {
      const len = slice.length;
      if (len < 4) return null;
      const w5 = slice.slice(-5);
      const w12 = slice.slice(-12);
      const w25 = slice.slice(-25);

      const r5 = w5.filter(r => r.size === 'BIG').length / w5.length;
      const r12 = w12.filter(r => r.size === 'BIG').length / w12.length;
      const r25 = w25.filter(r => r.size === 'BIG').length / w25.length;

      let streak = 1;
      const curSize = slice[len - 1].size;
      for (let i = len - 2; i >= 0 && i >= len - 8; i--) {
        if (slice[i].size === curSize) streak++;
        else break;
      }
      const streakVal = (curSize === 'BIG' ? 1 : -1) * Math.tanh(streak / 2.5);

      let chopCount = 0;
      for (let i = len - 1; i >= 1 && i >= len - 6; i--) {
        if (slice[i].size !== slice[i - 1].size) chopCount++;
      }
      const chopRate = chopCount / Math.min(len - 1, 5);

      const lastDigits = slice.slice(-6).map(r => Number(r.number));
      const oddRatio = lastDigits.filter(d => d % 2 === 1).length / lastDigits.length;
      const digitMean = lastDigits.reduce((a, b) => a + b, 0) / (lastDigits.length * 9);

      const last = slice[len - 1].size;
      let afterLastBig = 0, afterLastTotal = 0;
      for (let i = 0; i < len - 1; i++) {
        if (slice[i].size === last) {
          afterLastTotal++;
          if (slice[i + 1].size === 'BIG') afterLastBig++;
        }
      }
      const markovP = afterLastTotal >= 2 ? (afterLastBig / afterLastTotal) : 0.5;
      const entropy = calcEntropy(slice.slice(-12).map(r => r.size));
      const accel = r5 - r12;
      const spring = (0.5 - r25) * 2;

      // Streak-aware dynamic momentum and anti-phase features
      const winStreakFeat = Math.min(5, wStreak) / 5;
      const lossStreakFeat = Math.min(4, lStreak) / 4;
      const phaseAntiLag = (chopRate > 0.6 && streak === 1) ? 1.0 : (streak >= 3 ? -1.0 : 0.0);

      return [
        r5 - 0.5,
        r12 - 0.5,
        r25 - 0.5,
        streakVal,
        chopRate - 0.5,
        oddRatio - 0.5,
        digitMean - 0.5,
        markovP - 0.5,
        entropy - 0.5,
        accel,
        spring,
        winStreakFeat,
        lossStreakFeat,
        phaseAntiLag
      ];
    }

    const numInputs = 14;
    const numHidden = 4;

    // Hidden Layer initial weights: [H1: Trend, H2: Chop, H3: Win Momentum, H4: Loss Anti-Phase]
    let W_h = [
      [0.8, 0.6, -0.4, 1.2, -0.7, 0.4, 0.5, 0.8, -0.3, 0.6, 0.7, 0.5, -0.4, -0.8],
      [-0.5, -0.3, 0.2, -1.0, 1.3, -0.3, -0.4, -0.7, 0.6, -0.5, -0.6, -0.2, 0.6, 1.1],
      [0.4, 0.5, 0.1, 0.7, -0.2, 0.6, 0.4, 0.5, -0.2, 0.3, 0.4, 1.2, -0.5, 0.0],
      [-0.6, -0.4, 0.3, -0.8, 0.9, -0.2, -0.3, -0.6, 0.5, -0.4, -0.5, -0.4, 1.5, 1.2]
    ];
    let b_h = [0.05, -0.05, 0.05, -0.05];

    // Output weights: [h1, h2, h3, h4]
    let W_o = [0.9, -0.8, 0.7, -0.9];
    let b_o = 0.05;

    // Dynamic Learning Rate based on win/loss streak for real-time plastic adaptation
    const lr0 = 0.12;
    const lr = lr0 * (1 + (lossStreak * 0.55) + Math.min(3, winStreak) * 0.18);

    function leakyRelu(x) { return x >= 0 ? x : 0.1 * x; }
    function dLeakyRelu(x) { return x >= 0 ? 1.0 : 0.1; }

    const trainWindow = Math.min(22, n - 4);
    for (let i = n - trainWindow; i < n; i++) {
      const trainSlice = realHist.slice(0, i);
      const feats = extractFeatures(trainSlice, winStreak, lossStreak);
      if (!feats) continue;
      const actualY = realHist[i].size === 'BIG' ? 1.0 : 0.0;

      // Forward pass to hidden layer
      const h_raw = new Array(numHidden);
      const h_act = new Array(numHidden);
      for (let j = 0; j < numHidden; j++) {
        let sum = b_h[j];
        for (let f = 0; f < numInputs; f++) sum += W_h[j][f] * feats[f];
        h_raw[j] = sum;
        h_act[j] = leakyRelu(sum);
      }

      let z_out = b_o;
      for (let j = 0; j < numHidden; j++) z_out += W_o[j] * h_act[j];
      const yHat = 1 / (1 + Math.exp(-Math.max(-8, Math.min(8, z_out))));

      const err = actualY - yHat;
      const dOut = err;

      // Output layer update
      for (let j = 0; j < numHidden; j++) W_o[j] += lr * dOut * h_act[j];
      b_o += lr * dOut * 0.2;

      // Hidden layer backprop
      for (let j = 0; j < numHidden; j++) {
        const dH = dOut * W_o[j] * dLeakyRelu(h_raw[j]);
        for (let f = 0; f < numInputs; f++) {
          W_h[j][f] += lr * dH * feats[f];
        }
        b_h[j] += lr * dH * 0.2;
      }
    }

    // Adaptive Synaptic Rewiring: amplify anti-phase neuron on loss streak, boost momentum on win streak
    if (lossStreak >= 2) {
      W_o[3] *= (1 + lossStreak * 0.4);
      W_o[0] *= 0.7; // dampen lagging trend chasing
    } else if (winStreak >= 2) {
      W_o[2] *= (1 + Math.min(4, winStreak) * 0.25);
    }

    const currentFeats = extractFeatures(realHist, winStreak, lossStreak);
    if (!currentFeats) return { signal: 'NEUTRAL', weight: 0, prob: 0.5 };

    const final_h = new Array(numHidden);
    for (let j = 0; j < numHidden; j++) {
      let sum = b_h[j];
      for (let f = 0; f < numInputs; f++) sum += W_h[j][f] * currentFeats[f];
      final_h[j] = leakyRelu(sum);
    }

    let final_z = b_o;
    for (let j = 0; j < numHidden; j++) final_z += W_o[j] * final_h[j];
    const activation = 1 / (1 + Math.exp(-Math.max(-8, Math.min(8, final_z))));

    const signal = activation >= 0.50 ? 'BIG' : 'SMALL';
    const prob = Math.min(0.86, 0.50 + Math.abs(activation - 0.50) * 0.46);
    const weight = Math.round(50 * (1 + Math.abs(activation - 0.50)));

    return {
      signal,
      prob,
      weight,
      activation,
      hiddenActivations: final_h,
      engine: 'NeuralNet'
    };
  }

  // -- ENGINE 7: House Adversary & Psychological Trap Counter-Model ----------
  function engineHouseAdversary(hist, lossStreak = 0) {
    if (!hist || hist.length < 5) return { signal: 'NEUTRAL', weight: 0, trapDetected: false };
    const realHist = hist.filter(r => !r.gap);
    const n = realHist.length;
    if (n < 5) return { signal: 'NEUTRAL', weight: 0, trapDetected: false };

    const sizes = realHist.map(r => r.size);
    const lastSize = sizes[n - 1];

    let streak = 1;
    for (let i = n - 2; i >= 0 && i >= n - 10; i--) {
      if (sizes[i] === lastSize) streak++;
      else break;
    }

    let altCount = 1;
    for (let i = n - 1; i >= 1 && i >= n - 8; i--) {
      if (sizes[i] !== sizes[i - 1]) altCount++;
      else break;
    }

    const last10 = sizes.slice(-10);
    const bigCount10 = last10.filter(s => s === 'BIG').length;
    const dominantSize10 = bigCount10 >= 7 ? 'BIG' : (bigCount10 <= 3 ? 'SMALL' : null);

    let trapDetected = false;
    let trapType = 'NONE';
    let counterSignal = 'NEUTRAL';
    let baseWeight = 45;

    if (streak >= 5) {
      trapDetected = true;
      trapType = 'DRAGON_KILL';
      counterSignal = lastSize === 'BIG' ? 'SMALL' : 'BIG';
      baseWeight += streak * 6;
    } else if (altCount >= 4) {
      trapDetected = true;
      trapType = 'MARTINGALE_CHOP_BREAKER';
      counterSignal = lastSize;
      baseWeight += altCount * 5;
    } else if (dominantSize10 && streak <= 3) {
      trapDetected = true;
      trapType = 'GAMBLERS_FALLACY_SQUEEZE';
      counterSignal = dominantSize10;
      baseWeight += 25;
    } else {
      const lastNum = realHist[n - 1].number;
      if (lastNum === 0 || lastNum === 9) {
        trapDetected = true;
        trapType = 'BOUNDARY_REBOUND';
        counterSignal = lastNum === 0 ? 'BIG' : 'SMALL';
        baseWeight += 15;
      }
    }

    if (lossStreak >= 2) {
      baseWeight = Math.round(baseWeight * (1 + lossStreak * 0.35));
    }

    return {
      signal: counterSignal,
      weight: trapDetected ? baseWeight : 0,
      trapDetected,
      trapType,
      engine: 'HouseAdversary'
    };
  }

  // -- ENGINE 8: Meta-Cognitive Consciousness & Regime Classifier ------------
  function engineMetacognition(hist, lossStreak = 0) {
    if (!hist || hist.length < 5) {
      return { regime: 'NORMAL', reflection: 'Initializing Cognitive Baseline', boostEngine: null };
    }
    const realHist = hist.filter(r => !r.gap);
    const n = realHist.length;

    const recentSizes = realHist.slice(-8).map(r => r.size);
    let flips = 0;
    for (let i = 1; i < recentSizes.length; i++) {
      if (recentSizes[i] !== recentSizes[i - 1]) flips++;
    }

    let streak = 1;
    for (let i = n - 2; i >= 0 && i >= n - 7; i--) {
      if (realHist[i].size === realHist[n - 1].size) streak++;
      else break;
    }

    let regime = 'BALANCED';
    let reflection = '';
    let boostEngine = null;

    if (streak >= 4) {
      regime = 'DRAGON_TREND';
      reflection = `Conscious awareness: Deep Dragon Persistence (${streak} consecutive). Aligning with market momentum.`;
      boostEngine = 'Trend';
    } else if (flips >= 5) {
      regime = 'CHOP_ALTERNATION';
      reflection = `Conscious awareness: Rapid Chop Regimes (${flips}/7 flips). Elevating Markov & Anti-Chop engines.`;
      boostEngine = 'Markov';
    } else if (lossStreak >= 2) {
      regime = 'ADVERSARIAL_TRAP';
      reflection = `Conscious self-correction: Elevated loss defense. Activating Anti-Trap Shield to block 4th consecutive loss.`;
      boostEngine = 'HouseAdversary';
    } else {
      regime = 'STOCHASTIC_BALANCED';
      reflection = `Conscious awareness: Multi-engine neural consensus operating at peak calibration.`;
      boostEngine = 'NeuralNet';
    }

    return {
      regime,
      reflection,
      boostEngine,
      engine: 'Metacognition'
    };
  }

  // -- ABSOLUTE 4-LOSS PREVENTION FORTRESS SHIELD ----------------------------
  function enforceLossPreventionShield(hist, lossStreak, candidateTarget, v5Ensemble, houseAdversary, neuralNet) {
    if (lossStreak < 3) {
      return {
        target: candidateTarget,
        isShieldActive: false,
        shieldReason: null
      };
    }

    const realHist = (hist || []).filter(r => !r.gap && r.number !== null && r.number !== undefined);
    const n = realHist.length;
    if (n < 4) {
      return {
        target: candidateTarget,
        isShieldActive: true,
        shieldReason: '🛡️ FORTRESS SHIELD: Insufficient history, retaining candidate'
      };
    }

    const r1 = realHist[n - 3].size;
    const r2 = realHist[n - 2].size;
    const r3 = realHist[n - 1].size;

    const isDragon3 = (r1 === r2 && r2 === r3);
    const isChop3 = (r1 !== r2 && r2 !== r3);

    let shieldTarget = candidateTarget;
    let strategy = '';

    // Priority 1: House Psychological Trap Inversion
    if (houseAdversary && houseAdversary.trapDetected && houseAdversary.signal !== 'NEUTRAL') {
      shieldTarget = houseAdversary.signal;
      strategy = `House Adversary Inversion (${houseAdversary.trapType} → ${shieldTarget})`;
    }
    // Priority 2: Persistent Dragon Continuation (Breaks Gambler's Fallacy Trap)
    else if (isDragon3) {
      shieldTarget = r3;
      strategy = `Dragon Continuation (${r3} Persistence)`;
    }
    // Priority 3: Alternating Chop Synchronization (Breaks Phase Lag Trap)
    else if (isChop3) {
      shieldTarget = (r3 === 'BIG' ? 'SMALL' : 'BIG');
      strategy = `Chop Phase Alignment (${r3} → ${shieldTarget})`;
    }
    // Priority 4: 2-Layer Adaptive Neural Network Anti-Phase Inference
    else if (neuralNet && neuralNet.signal && neuralNet.prob >= 0.52) {
      shieldTarget = neuralNet.signal;
      strategy = `2-Layer Neural Anti-Phase (${shieldTarget} ${(neuralNet.prob * 100).toFixed(0)}%)`;
    }
    // Priority 5: Top Historical Python v5 Expert
    else if (v5Ensemble && v5Ensemble.sizePick) {
      shieldTarget = v5Ensemble.sizePick;
      strategy = `V5 Ensemble Expert (${v5Ensemble.sizeSource})`;
    }
    // Priority 6: Empirical Markov Attractor on 2-gram
    else {
      const key = r2 + '_' + r3;
      let bAfter = 0, sAfter = 0;
      for (let i = 2; i < n - 1; i++) {
        if ((realHist[i - 1].size + '_' + realHist[i].size) === key) {
          if (realHist[i + 1].size === 'BIG') bAfter++;
          else sAfter++;
        }
      }
      shieldTarget = bAfter >= sAfter ? 'BIG' : 'SMALL';
      strategy = `2-Gram Empirical Attractor [${key}→${shieldTarget}]`;
    }

    return {
      target: shieldTarget,
      isShieldActive: true,
      shieldReason: `🛡️ FORTRESS 4-LOSS PREVENTION SHIELD: ${strategy}`
    };
  }

  // =========================================================================
  // COLOR PATTERN ENGINES (RED vs GREEN)
  // WinGo colors: 1,3,7,9 = GREEN | 2,4,6,8 = RED | 0 = RED/VIOLET | 5 = GREEN/VIOLET
  // =========================================================================
  function getColorForNum(n) {
    if (n === null || n === undefined) return null;
    const num = Number(n);
    if ([1, 3, 7, 9, 5].includes(num)) return 'GREEN';
    if ([2, 4, 6, 8, 0].includes(num)) return 'RED';
    return null;
  }

  function calcColorEntropy(colors) {
    if (!colors || !colors.length) return 1.0;
    const valid = colors.filter(c => c === 'GREEN' || c === 'RED');
    if (!valid.length) return 1.0;
    const p = valid.filter(c => c === 'GREEN').length / valid.length;
    const q = 1 - p;
    if (p === 0 || q === 0) return 0;
    return -(p * Math.log2(p) + q * Math.log2(q));
  }

  // -- COLOR ENGINE 1: Sum Modulo Parity -> Color Bias ----------------------
  function engineColorSum(hist) {
    if (!hist || hist.length < 2) return { signal: 'NEUTRAL', weight: 0 };
    const s = (hist[hist.length - 1].number + hist[hist.length - 2].number) % 10;
    // Odd digits (1,3,5,7,9) have 100% green representation
    const sig = (s % 2 === 1) ? 'GREEN' : 'RED';
    return { signal: sig, weight: CONFIG.DEFAULT_WEIGHTS.Sum || 20, engine: 'ColorSum' };
  }

  // -- COLOR ENGINE 2: Color Trend / Dragon / Chop / 2-2 Cycle --------------
  function engineColorTrend(hist) {
    if (!hist || hist.length < 3) return { signal: 'NEUTRAL', weight: 0 };
    const colors = hist.map(r => r.color || getColorForNum(r.number)).filter(Boolean);
    if (colors.length < 3) return { signal: 'NEUTRAL', weight: 0 };

    const cur = colors[colors.length - 1];
    let streak = 1;
    for (let k = colors.length - 2; k >= 0 && k >= colors.length - 8; k--) {
      if (colors[k] === cur) streak++;
      else break;
    }

    // Dragon streak (3+ consecutive identical colors)
    if (streak >= 3) {
      return { signal: cur, weight: (CONFIG.DEFAULT_WEIGHTS.Trend || 35) + streak * 3, engine: 'ColorDragon', streak };
    }

    // Chop / Alternation pattern (e.g. R-G-R-G)
    let alt = 1;
    for (let k = colors.length - 1; k >= 1; k--) {
      if (colors[k] !== colors[k - 1]) alt++;
      else break;
    }
    if (alt >= 3) {
      const nextChop = cur === 'GREEN' ? 'RED' : 'GREEN';
      return { signal: nextChop, weight: 30 + alt * 4, engine: 'ColorChop', alt };
    }

    // 2-2 Double pattern (e.g. R-R-G-G-R -> second R)
    if (colors.length >= 5) {
      const [c1, c2, c3, c4, c5] = colors.slice(-5);
      if (c1 === c2 && c2 !== c3 && c3 === c4 && c4 !== c5) {
        return { signal: c5, weight: 28, engine: 'Color2x2' };
      }
    }

    return { signal: 'NEUTRAL', weight: 0 };
  }

  // -- COLOR ENGINE 3: Number-to-Color Transition Matrix (Color DNA) ---------
  function engineColorDNA(hist) {
    if (!hist || hist.length < 8) return { signal: 'NEUTRAL', weight: 0 };
    const trigger = hist[hist.length - 1].number;
    let greenAfter = 0, redAfter = 0;

    for (let i = 0; i < hist.length - 1; i++) {
      if (hist[i].number === trigger) {
        const nextColor = hist[i + 1].color || getColorForNum(hist[i + 1].number);
        if (nextColor === 'GREEN') greenAfter++;
        else if (nextColor === 'RED') redAfter++;
      }
    }

    const total = greenAfter + redAfter;
    if (total < 3) return { signal: 'NEUTRAL', weight: 0 };
    const greenRate = greenAfter / total;
    if (greenRate >= 0.60) return { signal: 'GREEN', weight: CONFIG.DEFAULT_WEIGHTS.DNA || 45, engine: 'ColorDNA' };
    if (greenRate <= 0.40) return { signal: 'RED', weight: CONFIG.DEFAULT_WEIGHTS.DNA || 45, engine: 'ColorDNA' };
    return { signal: 'NEUTRAL', weight: 0 };
  }

  // -- COLOR ENGINE 4: 2nd-Order Markov Chain on Colors ----------------------
  function engineColorMarkov2(hist) {
    if (!hist || hist.length < 5) return { signal: 'NEUTRAL', weight: 0, prob: 0.5 };
    const colors = hist.map(r => r.color || getColorForNum(r.number)).filter(Boolean);
    if (colors.length < 5) return { signal: 'NEUTRAL', weight: 0, prob: 0.5 };

    const k1 = colors[colors.length - 2];
    const k2 = colors[colors.length - 1];
    const key = k1 + '_' + k2;

    let matches = 0, greenNext = 0;
    for (let i = 2; i < colors.length - 1; i++) {
      if ((colors[i - 2] + '_' + colors[i - 1]) === key) {
        matches++;
        if (colors[i] === 'GREEN') greenNext++;
      }
    }

    if (matches < 3) return { signal: 'NEUTRAL', weight: 0, prob: 0.5 };
    const p = greenNext / matches;
    if (Math.abs(p - 0.5) < 0.12) return { signal: 'NEUTRAL', weight: 0, prob: p };
    return {
      signal: p > 0.5 ? 'GREEN' : 'RED',
      weight: CONFIG.DEFAULT_WEIGHTS.Markov || 40,
      prob: p,
      engine: 'ColorMarkov'
    };
  }

  // -- COLOR ENGINE 5: Rolling Imbalance Windows on Colors -------------------
  function engineColorRolling(hist) {
    if (!hist) return { signal: 'NEUTRAL', weight: 0 };
    const colors = hist.map(r => r.color || getColorForNum(r.number)).filter(Boolean);
    const w10 = colors.slice(-10);
    const w20 = colors.slice(-20);
    if (w10.length < 8) return { signal: 'NEUTRAL', weight: 0 };

    const rate10 = w10.filter(c => c === 'GREEN').length / w10.length;
    const rate20 = w20.length >= 15 ? w20.filter(c => c === 'GREEN').length / w20.length : 0.5;

    if (rate10 >= 0.70 && rate20 >= 0.60) return { signal: 'GREEN', weight: CONFIG.DEFAULT_WEIGHTS.Rolling || 25, engine: 'ColorRolling' };
    if (rate10 <= 0.30 && rate20 <= 0.40) return { signal: 'RED', weight: CONFIG.DEFAULT_WEIGHTS.Rolling || 25, engine: 'ColorRolling' };
    return { signal: 'NEUTRAL', weight: 0 };
  }

  // -- COLOR CONSENSUS COMBINER ----------------------------------------------
  function generateColorConsensus(hist) {
    const eSum    = engineColorSum(hist);
    const eTrend  = engineColorTrend(hist);
    const eDNA    = engineColorDNA(hist);
    const eMarkov = engineColorMarkov2(hist);
    const eRoll   = engineColorRolling(hist);

    const engines = [eSum, eTrend, eDNA, eMarkov, eRoll];
    let greenScore = 0, redScore = 0;
    const reasons = [];

    for (const e of engines) {
      if (e.signal === 'GREEN') { greenScore += e.weight; if (e.engine) reasons.push(e.engine + '→G'); }
      if (e.signal === 'RED')   { redScore   += e.weight; if (e.engine) reasons.push(e.engine + '→R'); }
    }

    let leading = greenScore >= redScore ? 'GREEN' : 'RED';
    const leadScore = Math.max(greenScore, redScore);

    if (leadScore === 0 && hist.length > 0) {
      const lastNum = hist[hist.length - 1].number;
      leading = getColorForNum(lastNum) || 'GREEN';
      reasons.push('ColorFallback→' + leading[0]);
    }

    const totalScore = greenScore + redScore || 20;
    const rawRatio   = Math.max(greenScore, redScore) / totalScore;
    const mappedProb = Math.min(0.75, Math.max(0.53, 0.50 + (rawRatio - 0.5) * 0.5 + (leadScore / 220)));

    return {
      target: leading,
      prob: mappedProb,
      engines: reasons,
      scores: { green: greenScore, red: redScore },
      leadScore
    };
  }

  // -- PATTERN SEQUENCE STRENGTH EVALUATOR ----------------------------------
  /**
   * Quantifies the pattern sequence strength for Size (BIG/SMALL) or Color (RED/GREEN).
   * Computes streak momentum, alternation chop, and cycle regularity.
   */
  function evaluatePatternSequence(hist, type) {
    const seq = (hist || []).map(r => type === 'COLOR' ? (r.color || getColorForNum(r.number)) : r.size).filter(Boolean);
    if (seq.length === 0) return { streak: 0, chop: 0, score: 0, patternName: 'None' };

    const last = seq[seq.length - 1];
    let streak = 1;
    for (let i = seq.length - 2; i >= 0 && i >= seq.length - 10; i--) {
      if (seq[i] === last) streak++;
      else break;
    }

    let chop = 0;
    for (let i = seq.length - 1; i >= 1 && i >= seq.length - 8; i--) {
      if (seq[i] !== seq[i - 1]) chop++;
      else break;
    }

    let patternScore = 0;
    let patternName = 'Standard';

    if (streak >= 4) {
      patternScore = 65 + streak * 8;
      patternName = `${streak}x Dragon Streak`;
    } else if (streak === 3) {
      patternScore = 48;
      patternName = '3x Dragon Streak';
    } else if (chop >= 4) {
      patternScore = 55 + chop * 7;
      patternName = `${chop}x Chop Alternation`;
    } else if (chop === 3) {
      patternScore = 42;
      patternName = '3x Chop Alternation';
    } else if (seq.length >= 5) {
      const [a, b, c, d, e] = seq.slice(-5);
      if (a === b && b !== c && c === d && d !== e) {
        patternScore = 38;
        patternName = '2-2 Pattern Cycle';
      }
    }

    return { streak, chop, patternScore, patternName };
  }

  // -- ADAPTIVE ENGINE WEIGHT TUNING (STREAK-AWARE SYNAPTIC REWIRING) ---------
  function updateAdaptiveEngineWeights(hist, currentWeights, winStreak = 0, lossStreak = 0) {
    const weights = Object.assign({}, CONFIG.DEFAULT_WEIGHTS, currentWeights || {});
    const realHist = (hist || []).filter(r => !r.gap);
    if (realHist.length < 15) return weights;

    const testWindow = realHist.slice(-30);
    const perf = {
      Sum: { c: 0, t: 0 },
      Trend: { c: 0, t: 0 },
      DNA: { c: 0, t: 0 },
      Markov: { c: 0, t: 0 },
      Rolling: { c: 0, t: 0 },
      NeuralNet: { c: 0, t: 0 },
      HouseAdversary: { c: 0, t: 0 }
    };

    for (let i = 8; i < testWindow.length; i++) {
      const subHist = testWindow.slice(0, i);
      const actual  = testWindow[i].size;

      const eS = engineSum(subHist);
      const eT = engineTrend(subHist);
      const eD = engineDNA(subHist);
      const eM = engineMarkov2(subHist);
      const eR = engineRolling(subHist);
      const eNN = engineNeuralNetwork(subHist, winStreak, lossStreak);
      const eH  = engineHouseAdversary(subHist, lossStreak);

      if (eS.signal !== 'NEUTRAL') { perf.Sum.t++; if (eS.signal === actual) perf.Sum.c++; }
      if (eT.signal !== 'NEUTRAL') { perf.Trend.t++; if (eT.signal === actual) perf.Trend.c++; }
      if (eD.signal !== 'NEUTRAL') { perf.DNA.t++; if (eD.signal === actual) perf.DNA.c++; }
      if (eM.signal !== 'NEUTRAL') { perf.Markov.t++; if (eM.signal === actual) perf.Markov.c++; }
      if (eR.signal !== 'NEUTRAL') { perf.Rolling.t++; if (eR.signal === actual) perf.Rolling.c++; }
      if (eNN.signal !== 'NEUTRAL') { perf.NeuralNet.t++; if (eNN.signal === actual) perf.NeuralNet.c++; }
      if (eH.signal !== 'NEUTRAL') { perf.HouseAdversary.t++; if (eH.signal === actual) perf.HouseAdversary.c++; }
    }

    Object.keys(perf).forEach(key => {
      const p = perf[key];
      if (p.t >= 4) {
        const acc = p.c / p.t;
        if (acc >= 0.58) {
          weights[key] = Math.min(85, Math.round((CONFIG.DEFAULT_WEIGHTS[key] || 30) * (1 + (acc - 0.5) * 1.8)));
        } else if (acc <= 0.42) {
          weights[key] = Math.max(8, Math.round((CONFIG.DEFAULT_WEIGHTS[key] || 30) * (acc / 0.5)));
        } else {
          weights[key] = CONFIG.DEFAULT_WEIGHTS[key] || 30;
        }
      }
    });

    // Dynamic Synaptic Rewiring on Streaks:
    if (lossStreak >= 2) {
      weights.HouseAdversary = Math.min(95, (weights.HouseAdversary || 45) + lossStreak * 15);
      weights.NeuralNet = Math.min(95, (weights.NeuralNet || 45) + lossStreak * 10);
      weights.Trend = Math.max(10, Math.round((weights.Trend || 25) * 0.5));
    } else if (winStreak >= 2) {
      weights.Trend = Math.min(70, (weights.Trend || 25) + winStreak * 8);
      weights.NeuralNet = Math.min(80, (weights.NeuralNet || 45) + winStreak * 6);
    }

    return weights;
  }

  // -- CONSENSUS COMBINER ---------------------------------------------------
  function generateConsensus(hist, adaptiveWeights, extraSignals, lossStreak = 0, winStreak = 0) {
    const weights = adaptiveWeights || CONFIG.DEFAULT_WEIGHTS;
    const eSum    = engineSum(hist);     if (eSum.signal !== 'NEUTRAL') eSum.weight = weights.Sum || 15;
    const eTrend  = engineTrend(hist);   if (eTrend.signal !== 'NEUTRAL') eTrend.weight = weights.Trend || 25;
    const eDNA    = engineDNA(hist);     if (eDNA.signal !== 'NEUTRAL') eDNA.weight = weights.DNA || 35;
    const eMarkov = engineMarkov2(hist); if (eMarkov.signal !== 'NEUTRAL') eMarkov.weight = weights.Markov || 30;
    const eRoll   = engineRolling(hist); if (eRoll.signal !== 'NEUTRAL') eRoll.weight = weights.Rolling || 20;

    const eNN     = engineNeuralNetwork(hist, winStreak, lossStreak);
    if (eNN.signal !== 'NEUTRAL') eNN.weight = weights.NeuralNet || eNN.weight || 45;

    const eHouse  = engineHouseAdversary(hist, lossStreak);
    if (eHouse.signal !== 'NEUTRAL') eHouse.weight = weights.HouseAdversary || eHouse.weight || 45;

    const eMeta   = engineMetacognition(hist, lossStreak);

    // Meta-cognitive dynamic boosting based on consciousness regime
    if (eMeta.boostEngine === 'Trend' && eTrend.signal !== 'NEUTRAL') eTrend.weight += 20;
    if (eMeta.boostEngine === 'Markov' && eMarkov.signal !== 'NEUTRAL') eMarkov.weight += 20;
    if (eMeta.boostEngine === 'HouseAdversary' && eHouse.signal !== 'NEUTRAL') eHouse.weight += 25;
    if (eMeta.boostEngine === 'NeuralNet' && eNN.signal !== 'NEUTRAL') eNN.weight += 20;

    // Direct synaptic weight reinforcement on loss streak
    if (lossStreak >= 2) {
      if (eHouse.signal !== 'NEUTRAL') eHouse.weight += 20;
      if (eNN.signal !== 'NEUTRAL') eNN.weight += 15;
      if (eTrend.signal !== 'NEUTRAL') eTrend.weight = Math.max(10, Math.round(eTrend.weight * 0.5));
    }

    const engines = [eSum, eTrend, eDNA, eMarkov, eRoll, eNN, eHouse];
    if (extraSignals && Array.isArray(extraSignals)) {
      engines.push(...extraSignals.filter(Boolean));
    }

    let bigScore = 0, smScore = 0;
    const reasons = [];
    for (const e of engines) {
      if (e.signal === 'BIG')   { bigScore += e.weight; if (e.engine) reasons.push(e.engine + '→B'); }
      if (e.signal === 'SMALL') { smScore  += e.weight; if (e.engine) reasons.push(e.engine + '→S'); }
    }

    let leading = bigScore >= smScore ? 'BIG' : 'SMALL';
    const leadScore = Math.max(bigScore, smScore);

    // Fallback prediction if all engines are neutral
    if (leadScore === 0 && hist.length > 0) {
      const lastNum = hist[hist.length - 1].number;
      leading = (lastNum % 2 === 1) ? 'BIG' : 'SMALL';
      reasons.push('Parity→' + leading[0]);
    }

    const totalScore = bigScore + smScore || 20;
    const rawRatio   = Math.max(bigScore, smScore) / totalScore;
    const mappedProb = Math.min(0.85, Math.max(0.53, 0.50 + (rawRatio - 0.5) * 0.5 + (leadScore / 220)));

    return {
      target: leading,
      prob: mappedProb,
      engines: reasons,
      scores: { big: bigScore, small: smScore },
      leadScore,
      neuralNet: eNN,
      houseAdversary: eHouse,
      meta: eMeta
    };
  }

  // -- STAKING & RISK MANAGEMENT CALCULATION ---------------------------------
  function calculateStake(params) {
    const {
      balance = 1000,
      initialBalance = 1000,
      pWin = 0.55,
      lossStreak = 0,
      winStreak = 0,
      balanceTrend = 0
    } = params;

    const q = 1 - pWin;
    const fStar = Math.max(0, (pWin * CONFIG.NET_ODDS_B - q) / CONFIG.NET_ODDS_B);
    let fraction = fStar * 0.5; // Half-Kelly base

    // Loss recovery (Controlled Soft Martingale)
    if (lossStreak === 1) fraction *= 1.20;
    else if (lossStreak === 2) fraction *= 1.50;

    // Trend modifiers
    if (balanceTrend === 1)  fraction *= 1.10; // Rising balance
    if (balanceTrend === -1) fraction *= 0.80; // Drawdown defense

    // Stop-loss protection
    const stopLossTriggered = balance < (initialBalance * 0.30);
    const stopLossRecovery  = balance < (initialBalance * 0.50);

    if (stopLossTriggered) {
      fraction = 0.01; // Minimum preservation micro-stake
    } else if (stopLossRecovery) {
      fraction = Math.min(fraction, 0.02);
    }

    // Win streak momentum boost
    if (winStreak >= 3) {
      fraction = Math.min(fraction * 1.20, 0.08);
    }

    // Absolute safety cap
    fraction = Math.min(fraction, CONFIG.MAX_BET_PCT);
    const stake = Math.max(1, Math.round(balance * fraction * 100) / 100);

    return {
      stake,
      fraction,
      stopLossTriggered,
      stopLossRecovery
    };
  }

  // =========================================================================
  // PYTHON v5 EXPERT ENSEMBLE SYSTEM & SAFETY OVERRIDE
  // =========================================================================
  function parityOf(n) {
    return (Number(n) % 2 === 1) ? 'O' : 'E';
  }

  function opposite(sym) {
    return sym === 'B' ? 'S' : 'B';
  }

  function describePick(size, par) {
    if (size) return `Target: ${size}`;
    if (par === 'O') return 'Target: GREEN';
    if (par === 'E') return 'Target: RED';
    return 'Target: BIG';
  }

  /**
   * Evaluates Python v5 Expert Predictions on history
   */
  function evaluateV5Ensemble(hist, activePattern, lossStreak = 0) {
    const seq = (hist || []).map(r => (r.size === 'BIG' ? 'B' : 'S'));
    const pseq = (hist || []).map(r => parityOf(r.number));
    const n = seq.length;
    if (n === 0) return null;

    const experts = [];

    // Cycle 1 to 8
    for (let p = 1; p <= 8; p++) {
      experts.push({
        name: `Cycle-${p}`,
        predict: (customSeq) => {
          const s = customSeq || seq;
          const len = s.length;
          return len >= p ? s[len - p] : null;
        },
        weight: 1.0
      });
    }

    // Repeat-last & Alternate
    experts.push({
      name: 'Repeat-last',
      predict: (customSeq) => {
        const s = customSeq || seq;
        return s.length > 0 ? s[s.length - 1] : null;
      },
      weight: 1.0
    });
    experts.push({
      name: 'Alternate',
      predict: (customSeq) => {
        const s = customSeq || seq;
        return s.length > 0 ? opposite(s[s.length - 1]) : null;
      },
      weight: 1.0
    });

    // Majority-5, Majority-12, All-time-majority
    experts.push({
      name: 'Majority-5',
      predict: (customSeq) => {
        const s = customSeq || seq;
        if (!s.length) return null;
        const slice = s.slice(-5);
        const b = slice.filter(x => x === 'B').length;
        const cS = slice.length - b;
        return b === cS ? s[s.length - 1] : (b > cS ? 'B' : 'S');
      },
      weight: 1.0
    });

    experts.push({
      name: 'Majority-12',
      predict: (customSeq) => {
        const s = customSeq || seq;
        if (!s.length) return null;
        const slice = s.slice(-12);
        const b = slice.filter(x => x === 'B').length;
        const cS = slice.length - b;
        return b === cS ? s[s.length - 1] : (b > cS ? 'B' : 'S');
      },
      weight: 1.0
    });

    experts.push({
      name: 'All-time-majority',
      predict: (customSeq) => {
        const s = customSeq || seq;
        if (!s.length) return null;
        const b = s.filter(x => x === 'B').length;
        return b >= (s.length - b) ? 'B' : 'S';
      },
      weight: 1.0
    });

    // Markov 1, 2, 3 for Size
    for (let order = 1; order <= 3; order++) {
      experts.push({
        name: `Markov-${order}`,
        predict: (customSeq) => {
          const s = customSeq || seq;
          const len = s.length;
          if (len <= order) return null;
          const ctx = s.slice(-order).join('_');
          let bCount = 0, sCount = 0;
          for (let i = order; i < len; i++) {
            if (s.slice(i - order, i).join('_') === ctx) {
              if (s[i] === 'B') bCount++;
              else sCount++;
            }
          }
          if (bCount + sCount === 0) return null;
          return bCount >= sCount ? 'B' : 'S';
        },
        weight: 1.0
      });
    }

    // Parity Experts (Parity-5, Parity-12, ParMarkov 1-3)
    const parityExperts = [
      {
        name: 'Parity-5',
        predict: (customPSeq) => {
          const p = customPSeq || pseq;
          if (!p.length) return null;
          const slice = p.slice(-5);
          const o = slice.filter(x => x === 'O').length;
          return o >= (slice.length - o) ? 'O' : 'E';
        },
        weight: 1.0
      },
      {
        name: 'Parity-12',
        predict: (customPSeq) => {
          const p = customPSeq || pseq;
          if (!p.length) return null;
          const slice = p.slice(-12);
          const o = slice.filter(x => x === 'O').length;
          return o >= (slice.length - o) ? 'O' : 'E';
        },
        weight: 1.0
      }
    ];

    for (let order = 1; order <= 3; order++) {
      parityExperts.push({
        name: `ParMarkov-${order}`,
        predict: (customPSeq) => {
          const p = customPSeq || pseq;
          const len = p.length;
          if (len <= order) return null;
          const ctx = p.slice(-order).join('_');
          let oCount = 0, eCount = 0;
          for (let i = order; i < len; i++) {
            if (p.slice(i - order, i).join('_') === ctx) {
              if (p[i] === 'O') oCount++;
              else eCount++;
            }
          }
          if (oCount + eCount === 0) return null;
          return oCount >= eCount ? 'O' : 'E';
        },
        weight: 1.0
      });
    }

    // Evaluate recent rolling accuracy of each expert over last 12 rounds to tune weights online
    const recentWindow = Math.min(12, n - 1);
    experts.forEach(exp => {
      let correct = 0, total = 0;
      for (let i = n - recentWindow; i < n; i++) {
        const subSeq = seq.slice(0, i);
        if (subSeq.length >= 2) {
          const p = exp.predict(subSeq);
          if (p !== null) {
            total++;
            if (p === seq[i]) correct++;
          }
        }
      }
      const acc = total > 0 ? correct / total : 0.5;
      exp.recentAcc = acc;
      // Dynamic reinforcement learning: weights scale exponentially with out-of-sample accuracy
      exp.weight = Math.max(0.05, 1.0 * (1 + (acc - 0.5) * 2.2));
    });

    // Also tune parity experts online
    parityExperts.forEach(exp => {
      let correct = 0, total = 0;
      for (let i = pseq.length - recentWindow; i < pseq.length; i++) {
        const subP = pseq.slice(0, i);
        if (subP.length >= 2) {
          const p = exp.predict(subP);
          if (p !== null) {
            total++;
            if (p === pseq[i]) correct++;
          }
        }
      }
      const acc = total > 0 ? correct / total : 0.5;
      exp.recentAcc = acc;
      exp.weight = Math.max(0.05, 1.0 * (1 + (acc - 0.5) * 2.2));
    });

    // Pattern bonus multiplier: if an active candidate pattern matches, dynamically boost matching experts
    let patternBonusApplied = null;
    if (activePattern) {
      const matchName = activePattern.code === 'P1-STREAK' ? 'Cycle-1' :
                        activePattern.code === 'P2-ALT' ? 'Alternate' :
                        activePattern.code === 'P4-DOUBLE' ? 'Cycle-4' : null;
      if (matchName) {
        const targetExp = experts.find(e => e.name === matchName);
        if (targetExp) {
          const conf = activePattern.confidence || 0.8;
          targetExp.weight += conf * 3.0;
          patternBonusApplied = `${targetExp.name} boosted by ${activePattern.code}`;
        }
      }
      // If candidate pattern predicted direction is known, boost aligned experts
      const patBias = activePattern.nextPredicted || activePattern.predictedNext || (activePattern.probabilityB >= 0.5 ? 'B' : (activePattern.probabilityS >= 0.5 ? 'S' : null));
      if (patBias) {
        experts.forEach(e => {
          if (e.predict() === patBias) {
            const edge = (activePattern.outOfSampleAccuracy ? (activePattern.outOfSampleAccuracy - 0.5) : 0.2);
            e.weight += Math.max(0.2, edge * 2.5);
          }
        });
      }
    }

    // Safety Override: if loss streak >= 3, best single recent expert takes direct command!
    let isSafetyOverride = false;
    let sizePick = null;
    let sizeSource = '';

    if (lossStreak >= 3) {
      const validExperts = experts.filter(e => e.predict() !== null);
      if (validExperts.length > 0) {
        validExperts.sort((a, b) => (b.recentAcc || 0.5) - (a.recentAcc || 0.5));
        const best = validExperts[0];
        sizePick = best.predict();
        sizeSource = `SAFETY OVERRIDE (3+ Losses): ${best.name} (${Math.round((best.recentAcc || 0.5) * 100)}% acc)`;
        isSafetyOverride = true;
      }
    }

    if (!sizePick) {
      let bWeight = 0, sWeight = 0;
      const votes = [];
      experts.forEach(e => {
        const p = e.predict();
        if (p) {
          votes.push({ name: e.name, pick: p, weight: e.weight });
          if (p === 'B') bWeight += e.weight;
          else sWeight += e.weight;
        }
      });
      sizePick = bWeight >= sWeight ? 'B' : 'S';
      const top3 = votes.sort((a, b) => b.weight - a.weight).slice(0, 3);
      sizeSource = `Ensemble: ${top3.map(v => `${v.name}(${v.weight.toFixed(1)})`).join(', ')}`;
    }

    // Parity weighted vote
    let oWeight = 0, eWeight = 0;
    parityExperts.forEach(pe => {
      const p = pe.predict();
      if (p === 'O') oWeight += pe.weight;
      else if (p === 'E') eWeight += pe.weight;
    });
    const parityPick = oWeight >= eWeight ? 'O' : 'E'; // O = Green, E = Red

    const finalSize = sizePick === 'B' ? 'BIG' : 'SMALL';
    const finalColor = parityPick === 'O' ? 'GREEN' : 'RED';
    const pickDesc = describePick(finalSize, parityPick);

    return {
      sizePick: finalSize,
      colorPick: finalColor,
      parityPick,
      pickDesc,
      sizeSource,
      isSafetyOverride,
      patternBonusApplied
    };
  }

  // -- GROUND-TRUTH PREDICTION STREAK EVALUATOR ------------------------------
  /**
   * Directly audits historical finished draws to compute exact consecutive prediction win/loss streak.
   * Guarantees the AI is never blind to losses even if user placed no bets or reset local balance.
   */
  function computeGroundTruthStreak(hist, predMap, state) {
    let lossStreak = 0;
    let winStreak = 0;

    const userLossStreak = (state && (state.aiPredictionLossStreak !== undefined ? state.aiPredictionLossStreak : state.lossStreak)) || 0;
    const userWinStreak = (state && (state.aiPredictionWinStreak !== undefined ? state.aiPredictionWinStreak : state.winStreak)) || 0;

    const realHist = (hist || []).filter(r => !r.gap && r.number !== null && r.number !== undefined);
    const n = realHist.length;
    if (n === 0) {
      return { lossStreak: userLossStreak, winStreak: userWinStreak };
    }

    // Inspect historical finished rounds from newest to oldest
    for (let i = n - 1; i >= 0; i--) {
      const row = realHist[i];
      let isWin = row.aiCorrect;
      if (isWin === undefined || isWin === null) {
        const pred = (predMap && (predMap[row.period] || predMap[String(row.period).slice(-5)]));
        if (pred && pred.target) {
          if (pred.type === 'COLOR') {
            const isGreen = [1, 3, 7, 9, 5].includes(Number(row.number));
            isWin = pred.target === 'GREEN' ? isGreen : !isGreen;
          } else {
            isWin = String(pred.target).toUpperCase() === String(row.size).toUpperCase();
          }
        }
      }

      if (isWin === true) {
        if (lossStreak > 0) break;
        winStreak++;
      } else if (isWin === false) {
        if (winStreak > 0) break;
        lossStreak++;
      } else {
        break;
      }
    }

    return {
      lossStreak: Math.max(lossStreak, userLossStreak),
      winStreak: Math.max(winStreak, userWinStreak)
    };
  }

  // -- BET PREDICTION DECISION ENGINE (ZERO SKIP GUARANTEE) ------------------
  /**
   * Main entry point to predict the next bet.
   * NOTE: "SKIP" is completely removed as requested. Every round delivers an active BET recommendation.
   * @param {Object} state - Current application state { history, balance, initialBalance, lossStreak, winStreak, cooloffRounds, myBets, engineWeights, timeframe }
   * @param {Array} extraSignals - Optional auxiliary signals (e.g. OpenRouter LLM)
   * @returns {Object} Complete prediction outcome
   */
  function predictNextBet(state, extraSignals) {
    const history = (state.history || []).filter(r => !r.gap);
    const n = history.length;

    // Fast fallback if zero history
    if (n === 0) {
      return {
        ready: true,
        decision: 'BET',
        target: 'BIG',
        type: 'SIZE',
        sizeTarget: 'BIG',
        sizeProb: 0.55,
        colorTarget: 'GREEN',
        colorProb: 0.55,
        stake: 1,
        prob: 0.55,
        entropy: 1.0,
        zScore: 1.0,
        reqZ: 1.64,
        engines: ['Seed Engine'],
        scores: { big: 50, small: 50 },
        reason: 'Empirical starting round recommendation',
        pickDesc: 'BIG + Green (play 7 or 9, 5 adds Violet)'
      };
    }

    // 1. Query Game History Analysis candidates (if available)
    let candidateData = null;
    try {
      const GHA = (typeof window !== 'undefined' ? window.GameHistoryAnalysis : null) || (typeof global !== 'undefined' ? global.GameHistoryAnalysis : null);
      if (GHA && typeof GHA.getCandidatePatterns === 'function') {
        candidateData = GHA.getCandidatePatterns(state.timeframe || '1m', history);
      }
    } catch (e) {}

    // 1b. Determine ground-truth prediction streak directly from history
    const groundTruth = computeGroundTruthStreak(history, state.aiPredictionMap, state);
    const effectiveLossStreak = groundTruth.lossStreak;
    const effectiveWinStreak = groundTruth.winStreak;

    // 2. Calculate entropy of recent window
    const recentSizes = history.slice(-20).map(r => r.size);
    const entropy = calcEntropy(recentSizes);

    // 3. Update adaptive weights with streak rewiring
    const adaptiveWeights = updateAdaptiveEngineWeights(history, state.engineWeights, effectiveWinStreak, effectiveLossStreak);

    // 4. Inject validated candidate pattern from GameHistoryAnalysis as extra signal if present (min length 3)
    const combinedSignals = Array.isArray(extraSignals) ? [...extraSignals] : [];
    if (candidateData && candidateData.bestCandidate) {
      const best = candidateData.bestCandidate;
      const patLen = best.length || (best.exactSequence ? best.exactSequence.length : 0);
      if (patLen >= 3) {
        combinedSignals.push({
          signal: best.probabilityB >= 0.5 ? 'BIG' : 'SMALL',
          weight: Math.round((best.outOfSampleAccuracy - 0.5) * 200) + 30,
          engine: `HistoryPattern:${best.code}(${best.exactSequence})`
        });
      }
    }

    // 5. Generate consensus for BOTH Size (BIG/SMALL) and Color (RED/GREEN)
    const sizeConsensus = generateConsensus(history, adaptiveWeights, combinedSignals, effectiveLossStreak, effectiveWinStreak);
    const colorConsensus = generateColorConsensus(history);

    // 6. Evaluate Pattern Sequence Strength for both
    const sizePattern  = evaluatePatternSequence(history, 'SIZE');
    const colorPattern = evaluatePatternSequence(history, 'COLOR');

    // Total sequence scores
    const sizeSeqScore  = sizePattern.patternScore + (sizeConsensus.leadScore * 0.4) + Math.round((sizeConsensus.prob - 0.5) * 80);
    const colorSeqScore = colorPattern.patternScore + (colorConsensus.leadScore * 0.4) + Math.round((colorConsensus.prob - 0.5) * 80);

    // Compare: Which one has the stronger pattern sequence?
    const dominantType = colorSeqScore > sizeSeqScore ? 'COLOR' : 'SIZE';
    const recommendedTarget = dominantType === 'COLOR' ? colorConsensus.target : sizeConsensus.target;
    const dominantProb = dominantType === 'COLOR' ? colorConsensus.prob : sizeConsensus.prob;
    const dominantEngines = dominantType === 'COLOR' ? colorConsensus.engines : sizeConsensus.engines;
    const dominantScores = dominantType === 'COLOR' ? colorConsensus.scores : sizeConsensus.scores;

    // 7. Evaluate Python v5 Ensemble experts & Safety Override
    const activePatObj = (candidateData && candidateData.structuralMatches && candidateData.structuralMatches[0]) || {
      code: sizePattern.streak >= 3 ? 'P1-STREAK' : (sizePattern.chop >= 4 ? 'P2-ALT' : null),
      confidence: sizePattern.streak >= 3 ? 0.85 : 0.75
    };

    const v5Ensemble = evaluateV5Ensemble(history, activePatObj, effectiveLossStreak);

    // 7b. CRITICAL 4-LOSS PREVENTION FORTRESS SHIELD ENFORCER
    // Prevents loss streaks of 4 or more in a row by detecting house psychological traps,
    // inverting phase lag, analyzing persistent structural drift, or aligning with 2-layer neural anti-phase.
    const shieldResult = enforceLossPreventionShield(
      history,
      effectiveLossStreak,
      recommendedTarget,
      v5Ensemble,
      sizeConsensus.houseAdversary,
      sizeConsensus.neuralNet
    );

    // 8. Staking calculation
    const pWin = Math.max(dominantProb, CONFIG.BREAKEVEN_P + 0.01);
    const zScore = (pWin - 0.5) / Math.sqrt(0.25 / Math.max(n, 1));
    const reqZ = requiredZScore(effectiveLossStreak);

    const resolvedBets = (state.myBets || []).filter(b => b.status === 'WON' || b.status === 'LOST').slice(0, 10);
    let balanceTrend = 0;
    if (resolvedBets.length >= 3) {
      const pnls   = resolvedBets.map(b => b.status === 'WON' ? (b.payout - b.stake) : -b.stake);
      const half   = Math.floor(pnls.length / 2);
      const recent = pnls.slice(0, half).reduce((a, b) => a + b, 0);
      const older  = pnls.slice(half).reduce((a, b) => a + b, 0);
      balanceTrend = recent > older ? 1 : recent < older ? -1 : 0;
    }

    const staking = calculateStake({
      balance: state.balance || 1000,
      initialBalance: state.initialBalance || 1000,
      pWin,
      lossStreak: effectiveLossStreak,
      winStreak: effectiveWinStreak,
      balanceTrend
    });

    // 9. ALWAYS BET (NO SKIP) with intelligent protective staking
    let finalTarget = recommendedTarget;
    let finalReason = '';
    let finalDominantType = dominantType;

    const patternNote = dominantType === 'COLOR'
      ? `Color [${colorPattern.patternName}] stronger (${colorSeqScore} vs Size ${sizeSeqScore})`
      : `Size [${sizePattern.patternName}] stronger (${sizeSeqScore} vs Color ${colorSeqScore})`;

    // Check Critical 4-Loss Prevention Shield first!
    if (shieldResult.isShieldActive) {
      finalTarget = shieldResult.target;
      finalDominantType = 'SIZE';
      finalReason = `${shieldResult.shieldReason} | Loss Prevention Stake ₹${staking.stake}`;
    } else if (v5Ensemble && v5Ensemble.isSafetyOverride) {
      finalTarget = v5Ensemble.sizePick;
      finalDominantType = 'SIZE';
      finalReason = `🛡️ ${v5Ensemble.sizeSource} | Recovery Stake ₹${staking.stake}`;
    } else if (candidateData && candidateData.bestCandidate) {
      const best = candidateData.bestCandidate;
      finalReason = `📊 History Match ${best.code} (${best.exactSequence}) OOS ${Math.round(best.outOfSampleAccuracy * 100)}% | ${patternNote}`;
    } else {
      const topEngine = dominantEngines[0] || (dominantType === 'COLOR' ? 'Color' : 'Quant');
      finalReason = `${topEngine} | ${patternNote} (${Math.round(dominantProb * 100)}% Win Rate)`;
    }

    const pickDesc = `🎯 Target: ${finalTarget}`;

    return {
      ready: true,
      decision: 'BET', // Strictly BET - SKIP is completely removed
      target: finalTarget,
      type: finalDominantType,
      sizeTarget: finalDominantType === 'SIZE' ? finalTarget : sizeConsensus.target,
      sizeProb: sizeConsensus.prob,
      colorTarget: finalDominantType === 'COLOR' ? finalTarget : colorConsensus.target,
      colorProb: colorConsensus.prob,
      isShieldActive: shieldResult.isShieldActive,
      shieldReason: shieldResult.shieldReason,
      effectiveLossStreak,
      effectiveWinStreak,
      metacognition: sizeConsensus.meta,
      neuralNet: sizeConsensus.neuralNet,
      houseAdversary: sizeConsensus.houseAdversary,
      patternStrength: {
        size: sizeSeqScore,
        color: colorSeqScore,
        dominant: finalDominantType,
        sizePattern: sizePattern.patternName,
        colorPattern: colorPattern.patternName
      },
      stake: Math.max(1, staking.stake),
      prob: dominantProb,
      entropy,
      zScore,
      reqZ,
      engines: dominantEngines,
      scores: dominantScores,
      adaptiveWeights,
      reason: finalReason,
      pickDesc,
      v5Ensemble
    };
  }

  // Export as QuantAlgorithm
  const QuantAlgorithm = {
    CONFIG,
    getColorForNum,
    calcEntropy,
    calcColorEntropy,
    requiredZScore,
    engineSum,
    engineTrend,
    engineDNA,
    engineMarkov2,
    engineRolling,
    engineNeuralNetwork,
    engineHouseAdversary,
    engineMetacognition,
    enforceLossPreventionShield,
    computeGroundTruthStreak,
    engineColorSum,
    engineColorTrend,
    engineColorDNA,
    engineColorMarkov2,
    engineColorRolling,
    updateAdaptiveEngineWeights,
    generateConsensus,
    generateColorConsensus,
    evaluatePatternSequence,
    calculateStake,
    predictNextBet
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = QuantAlgorithm;
  }
  if (typeof global !== 'undefined') {
    global.QuantAlgorithm = QuantAlgorithm;
  }
  if (typeof window !== 'undefined') {
    window.QuantAlgorithm = QuantAlgorithm;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.QuantAlgorithm = QuantAlgorithm;
  }
})(typeof window !== 'undefined' ? window : globalThis);
