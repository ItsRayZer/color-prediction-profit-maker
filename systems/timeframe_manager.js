/**
 * ===========================================================================
 * TimeframeManager: Multi-Timeframe Isolated Prediction & Session Stats Engine
 *
 * Ensures each WinGo timeframe (30s, 1m, 3m, 5m):
 *   1. Maintains its own completely isolated live history.
 *   2. Generates its own distinct AI prediction (strictly single target: BIG/SMALL or Color).
 *   3. Tracks its own session stats: Correct, Wrong, Accuracy, Streaks (Max W / Max L).
 * ===========================================================================
 */
(function(global) {
  'use strict';

  function createTimeframeSession(tf) {
    let savedReset = null;
    try {
      if (typeof localStorage !== 'undefined') {
        savedReset = localStorage.getItem('wingo_audit_reset_' + tf);
      }
    } catch(e) {}
    return {
      tf,
      history: [],
      predictionsMap: {},
      aiSignal: null,
      auditResetPeriod: savedReset || null,
      stats: {
        totalSettled: 0,
        correctCount: 0,
        wrongCount: 0,
        accPct: 0,
        curStreak: 0,
        maxWinStreak: 0,
        maxLossStreak: 0
      }
    };
  }

  const sessions = {
    '30s': createTimeframeSession('30s'),
    '1m':  createTimeframeSession('1m'),
    '3m':  createTimeframeSession('3m'),
    '5m':  createTimeframeSession('5m')
  };

  const TimeframeManager = {
    getSession(tf) {
      if (!sessions[tf]) sessions[tf] = createTimeframeSession(tf);
      return sessions[tf];
    },

    resetAudit(tf, resetPeriod) {
      const sess = this.getSession(tf);
      const sorted = [...sess.history].sort((a, b) => String(a.period).localeCompare(String(b.period)));
      const cutoff = resetPeriod || (sorted.length > 0 ? sorted[sorted.length - 1].period : 'RESET_NOW');
      sess.auditResetPeriod = cutoff;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('wingo_audit_reset_' + tf, String(cutoff));
        }
      } catch (e) {}
      sess.stats = {
        totalSettled: 0,
        correctCount: 0,
        wrongCount: 0,
        accPct: 0,
        curStreak: 0,
        maxWinStreak: 0,
        maxLossStreak: 0
      };
      return sess.stats;
    },

    getHistory(tf) {
      return this.getSession(tf).history;
    },

    setHistory(tf, list) {
      const sess = this.getSession(tf);
      if (Array.isArray(list)) {
        const sys = (global.WIN_GO_SYSTEMS && global.WIN_GO_SYSTEMS[tf]);
        let filtered = list;
        if (sys && typeof sys.filterHistory === 'function') {
          filtered = sys.filterHistory(list);
        }
        sess.history = filtered.filter(r => !r.gap);
        this.evaluateSessionHistory(tf);
        this.generatePrediction(tf);
      }
      return sess.history;
    },

    recordSettledRound(tf, period, number, size, color) {
      const sess = this.getSession(tf);
      const pStr = String(period);
      const pLast5 = pStr.slice(-5);

      const existingIdx = sess.history.findIndex(r => String(r.period) === pStr || String(r.period).slice(-5) === pLast5);
      const row = {
        period: pStr,
        number: Number(number),
        size: size || (number >= 5 ? 'BIG' : 'SMALL'),
        color: color || (number === 0 || number === 5 ? 'VIOLET' : ([1,3,7,9].includes(number) ? 'GREEN' : 'RED'))
      };

      if (existingIdx >= 0) {
        sess.history[existingIdx] = Object.assign(sess.history[existingIdx], row);
      } else {
        sess.history.push(row);
      }

      const result = this.scoreRound(tf, row);
      this.generatePrediction(tf);
      return result;
    },

    scoreRound(tf, row) {
      const sess = this.getSession(tf);
      const pred = this.getPredictionForPeriod(tf, row.period);
      if (!pred || !pred.target) return null;

      const isGreen = [1,3,7,9,5].includes(row.number);
      let isWin = false;
      if (pred.type === 'COLOR') {
        isWin = pred.target === 'GREEN' ? isGreen : !isGreen;
      } else {
        isWin = pred.target === row.size;
      }

      row.aiTarget = pred.target;
      row.aiType = pred.type;
      row.aiCorrect = isWin;

      // If audit reset cutoff is active, only accumulate stats for periods after the reset
      if (!sess.auditResetPeriod || String(row.period) > String(sess.auditResetPeriod)) {
        sess.stats.totalSettled++;
        if (isWin) {
          sess.stats.correctCount++;
          sess.stats.curStreak = sess.stats.curStreak >= 0 ? sess.stats.curStreak + 1 : 1;
          if (sess.stats.curStreak > sess.stats.maxWinStreak) {
            sess.stats.maxWinStreak = sess.stats.curStreak;
          }
        } else {
          sess.stats.wrongCount++;
          sess.stats.curStreak = sess.stats.curStreak <= 0 ? sess.stats.curStreak - 1 : -1;
          const lossStreakLen = Math.abs(sess.stats.curStreak);
          if (lossStreakLen > sess.stats.maxLossStreak) {
            sess.stats.maxLossStreak = lossStreakLen;
          }
        }

        sess.stats.accPct = sess.stats.totalSettled > 0
          ? Math.round((sess.stats.correctCount / sess.stats.totalSettled) * 100)
          : 0;
      }

      return {
        isWin,
        predTarget: pred.target,
        predType: pred.type,
        stats: { ...sess.stats }
      };
    },

    evaluateSessionHistory(tf) {
      const sess = this.getSession(tf);
      const sorted = [...sess.history].sort((a, b) => String(a.period).localeCompare(String(b.period)));

      let total = 0, correct = 0, wrong = 0;
      let runWin = 0, runLoss = 0;
      let maxWin = 0, maxLoss = 0;
      let curStreak = 0;

      sorted.forEach((row, idx) => {
        let pred = sess.predictionsMap[row.period] || sess.predictionsMap[String(row.period).slice(-5)];
        if (!pred && row.aiTarget) {
          pred = { target: row.aiTarget, type: row.aiType || (['RED','GREEN'].includes(row.aiTarget) ? 'COLOR' : 'SIZE') };
          sess.predictionsMap[row.period] = pred;
        }
        // Fast retro prediction on prior draws to populate audit for all historical rounds without lag
        if (!pred && idx >= 2) {
          const prior = sorted.slice(0, idx);
          if (global.QuantAlgorithm && typeof global.QuantAlgorithm.generateConsensus === 'function') {
            try {
              const c = global.QuantAlgorithm.generateConsensus(prior);
              pred = { target: c.target || 'BIG', type: 'SIZE' };
              sess.predictionsMap[row.period] = pred;
            } catch(e) {}
          }
          if (!pred) {
            const lastRow = prior[prior.length - 1];
            pred = { target: lastRow ? (lastRow.size === 'BIG' ? 'SMALL' : 'BIG') : 'BIG', type: 'SIZE' };
            sess.predictionsMap[row.period] = pred;
          }
        }

        if (pred && pred.target) {
          const isGreen = [1,3,7,9,5].includes(row.number);
          const isWin = pred.type === 'COLOR'
            ? (pred.target === 'GREEN' ? isGreen : !isGreen)
            : pred.target === row.size;

          row.aiTarget = pred.target;
          row.aiType = pred.type;
          row.aiCorrect = isWin;

          const isAfterReset = !sess.auditResetPeriod || String(row.period) > String(sess.auditResetPeriod);
          if (isAfterReset) {
            total++;
            if (isWin) {
              correct++;
              runWin++;
              runLoss = 0;
              if (runWin > maxWin) maxWin = runWin;
              curStreak = runWin;
            } else {
              wrong++;
              runLoss++;
              runWin = 0;
              if (runLoss > maxLoss) maxLoss = runLoss;
              curStreak = -runLoss;
            }
          }
        }
      });

      sess.stats.totalSettled = total;
      sess.stats.correctCount = correct;
      sess.stats.wrongCount = wrong;
      sess.stats.accPct = total > 0 ? Math.round((correct / total) * 100) : 0;
      sess.stats.curStreak = curStreak;
      sess.stats.maxWinStreak = maxWin;
      sess.stats.maxLossStreak = maxLoss;

      return sess.stats;
    },

    generatePrediction(tf) {
      const sess = this.getSession(tf);
      const hist = sess.history;

      let outcome = null;
      if (global.QuantAlgorithm && typeof global.QuantAlgorithm.predictNextBet === 'function' && hist.length >= 3) {
        try {
          outcome = global.QuantAlgorithm.predictNextBet({
            history: hist,
            balance: 1000,
            lossStreak: sess.stats.curStreak < 0 ? Math.abs(sess.stats.curStreak) : 0,
            timeframe: tf
          });
        } catch(e) {
          console.warn('[TimeframeManager] Prediction error:', e);
        }
      }

      if (!outcome || !outcome.target) {
        const last = hist.length > 0 ? hist[hist.length - 1] : null;
        const fallbackTarget = last ? (last.size === 'BIG' ? 'SMALL' : 'BIG') : 'BIG';
        outcome = {
          target: fallbackTarget,
          type: 'SIZE',
          prob: 0.55,
          decision: 'BET',
          engines: ['Trend Engine'],
          pickDesc: fallbackTarget
        };
      }

      const cleanTarget = outcome.target;
      const cleanType = ['RED', 'GREEN'].includes(cleanTarget) ? 'COLOR' : 'SIZE';

      sess.aiSignal = {
        target: cleanTarget,
        type: cleanType,
        prob: outcome.prob || 0.60,
        decision: 'BET',
        engines: outcome.engines || ['Quant AI'],
        pickDesc: cleanTarget,
        timeframe: tf
      };

      if (global.S && global.S.currentPeriod) {
        this.recordPrediction(tf, global.S.currentPeriod, sess.aiSignal);
      }

      return sess.aiSignal;
    },

    recordPrediction(tf, period, pred) {
      if (!period || !pred || !pred.target) return;
      const sess = this.getSession(tf);
      const pStr = String(period);
      const pLast5 = pStr.slice(-5);
      const record = {
        target: pred.target,
        type: pred.type || (['RED', 'GREEN'].includes(pred.target) ? 'COLOR' : 'SIZE'),
        prob: pred.prob || 0.60
      };
      if (!sess.predictionsMap[pStr]) sess.predictionsMap[pStr] = record;
      if (!sess.predictionsMap[pLast5]) sess.predictionsMap[pLast5] = record;
    },

    getPrediction(tf) {
      const sess = this.getSession(tf);
      if (!sess.aiSignal) {
        this.generatePrediction(tf);
      }
      return sess.aiSignal;
    },

    getPredictionForPeriod(tf, period) {
      const sess = this.getSession(tf);
      const pStr = String(period);
      const pLast5 = pStr.slice(-5);

      if (sess.predictionsMap[pStr]) return sess.predictionsMap[pStr];
      if (sess.predictionsMap[pLast5]) return sess.predictionsMap[pLast5];

      const row = sess.history.find(r => String(r.period) === pStr || String(r.period).slice(-5) === pLast5);
      if (row && row.aiTarget) {
        return { target: row.aiTarget, type: row.aiType || 'SIZE' };
      }

      // If this is the active live current round, return sess.aiSignal
      if (global.S && (pStr === String(global.S.currentPeriod) || pLast5 === String(global.S.currentPeriod).slice(-5))) {
        return sess.aiSignal;
      }

      // Fallback for historical rounds: retro-calculate strictly on prior history
      const sorted = sess.history.filter(r => !r.gap && String(r.period) < pStr).sort((a,b) => String(a.period).localeCompare(String(b.period)));
      if (sorted.length >= 2 && global.QuantAlgorithm && typeof global.QuantAlgorithm.generateConsensus === 'function') {
        try {
          const c = global.QuantAlgorithm.generateConsensus(sorted);
          if (c && c.target) {
            const retro = { target: c.target, type: c.type || 'SIZE', prob: c.prob || 0.60 };
            sess.predictionsMap[pStr] = retro;
            return retro;
          }
        } catch(e) {}
      }

      return null;
    },

    getStats(tf) {
      return this.getSession(tf).stats;
    }
  };

  global.TimeframeManager = TimeframeManager;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TimeframeManager;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
