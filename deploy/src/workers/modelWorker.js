/**
 * =============================================================================
 * modelWorker.js – Local Compute Engine Web Worker
 * =============================================================================
 * Runs all 53+ canonical prediction models locally on the client device
 * in a dedicated background thread without blocking the UI thread.
 *
 * Implements:
 * - 24/7 Rolling History Replay & Progressive Training
 * - 53+ Model Execution via generateModelNextPrediction
 * - Correctness Evaluation via evaluatePredictionCorrectness
 * - Configurable In-Charge State Machine (NORMAL, STREAK_OVERRIDE, RETURN_TO_BASE)
 * - Session Isolation (User Reset ONLY resets session stats, preserves all-time stats)
 * =============================================================================
 */

'use strict';

// ── 1. Incharge Modes & State Machine ─────────────────────────────────────────

const INCHARGE_MODES = {
  OVERALL_WIN_RATE: 'OVERALL_WIN_RATE',
  WINNING_STREAK_OVERRIDE: 'WINNING_STREAK_OVERRIDE',
  SESSION_WIN_RATE: 'SESSION_WIN_RATE',
  SESSION_STREAK_OVERRIDE: 'SESSION_STREAK_OVERRIDE',
  LAST_10_WIN_RATE: 'LAST_10_WIN_RATE',
  LAST_20_WIN_RATE: 'LAST_20_WIN_RATE',
  HIGHEST_STREAK: 'HIGHEST_STREAK',
  UCB_RANKING: 'UCB_RANKING'
};

const DEFAULT_INCHARGE_CONFIG = {
  predictionSource: 'LOCAL', // 'LOCAL' (Worker Compute) or 'CLOUD' (Server Stream)
  mode: INCHARGE_MODES.WINNING_STREAK_OVERRIDE,
  minStreak: 3,
  minEvaluated: 10,
  minWinRate: 0.0,
  returnToBaseOnLoss: true,
  tieBreaker: 'HIGHER_WIN_RATE'
};

class WorkerInchargeEngine {
  constructor(initialConfig = {}) {
    this.config = { ...DEFAULT_INCHARGE_CONFIG, ...initialConfig };
    this.state = 'NORMAL'; // 'NORMAL' | 'STREAK_OVERRIDE' | 'RETURN_TO_BASE' | 'MANUAL_LOCK'
    this.activeStreakModelId = null;
    this.activeStreakCount = 0;
  }

  updateConfig(newConfig = {}) {
    this.config = { ...this.config, ...newConfig };
  }

  getConfig() {
    return { ...this.config };
  }

  getState() {
    return {
      state: this.state,
      activeStreakModelId: this.activeStreakModelId,
      activeStreakCount: this.activeStreakCount,
      config: { ...this.config }
    };
  }

  rankModels(models, metricType = 'overall') {
    const getWinRate = m => {
      if (metricType === 'last10') {
        const p = (m.historyPath || []).slice(0, 10);
        if (p.length === 0) return 0;
        return p.filter(x => x.won).length / p.length;
      }
      if (metricType === 'last20') {
        const p = (m.historyPath || []).slice(0, 20);
        if (p.length === 0) return 0;
        return p.filter(x => x.won).length / p.length;
      }
      if (metricType === 'session' && m.sessionWinRate !== undefined) return Number(m.sessionWinRate);
      if (m.winRate !== undefined) return Number(m.winRate);
      if (m.winRatePct) return parseFloat(m.winRatePct) / 100;
      return 0;
    };

    const getStreak = m => {
      if (metricType === 'session' && m.sessionStreak !== undefined) return Number(m.sessionStreak);
      return Number(m.streak !== undefined ? m.streak : 0);
    };

    const getEvaluated = m => {
      if (metricType === 'session' && m.sessionEvaluated !== undefined) return Number(m.sessionEvaluated);
      return Number(m.totalEvaluated !== undefined ? m.totalEvaluated : (m.evaluated || 0));
    };

    return [...models].sort((a, b) => {
      const wrA = getWinRate(a);
      const wrB = getWinRate(b);
      if (wrB !== wrA) return wrB - wrA;

      const evA = getEvaluated(a);
      const evB = getEvaluated(b);
      if (evB !== evA) return evB - evA;

      const sA = getStreak(a);
      const sB = getStreak(b);
      if (sB !== sA) return sB - sA;

      const wA = Number(a.wins || 0);
      const wB = Number(b.wins || 0);
      if (wB !== wA) return wB - wA;

      return (a.name || '').localeCompare(b.name || '');
    });
  }

  evaluateIncharge(models, options = {}) {
    if (!Array.isArray(models) || models.length === 0) return null;

    const manualId = options.manualId || null;
    const isAutoMode = options.isAutoMode !== false;

    if (!isAutoMode && manualId) {
      const manual = models.find(m => m.id === manualId || m.name === manualId);
      if (manual) {
        this.state = 'MANUAL_LOCK';
        this.activeStreakModelId = null;
        return {
          model: manual,
          mode: 'MANUAL_LOCK',
          state: this.state,
          reason: `Manual Override: ${manual.name}`
        };
      }
    }

    const mode = this.config.mode || INCHARGE_MODES.WINNING_STREAK_OVERRIDE;

    if (mode === 'LAST_10_WIN_RATE') {
      const ranked = this.rankModels(models, 'last10');
      const champ = ranked[0] || models[0];
      const p = (champ.historyPath || []).slice(0, 10);
      const wr = p.length > 0 ? ((p.filter(x => x.won).length / p.length) * 100).toFixed(0) : '0';
      this.state = 'NORMAL';
      return {
        model: champ,
        mode,
        state: this.state,
        reason: `⚡ Last 10 Champion: ${champ.name} (${wr}% in last 10)`
      };
    }

    if (mode === 'LAST_20_WIN_RATE') {
      const ranked = this.rankModels(models, 'last20');
      const champ = ranked[0] || models[0];
      const p = (champ.historyPath || []).slice(0, 20);
      const wr = p.length > 0 ? ((p.filter(x => x.won).length / p.length) * 100).toFixed(0) : '0';
      this.state = 'NORMAL';
      return {
        model: champ,
        mode,
        state: this.state,
        reason: `📊 Last 20 Champion: ${champ.name} (${wr}% in last 20)`
      };
    }

    if (mode === 'HIGHEST_STREAK') {
      const sortedByStreak = [...models].sort((a, b) => (Number(b.streak || 0)) - (Number(a.streak || 0)));
      const champ = sortedByStreak[0] || models[0];
      this.state = 'NORMAL';
      return {
        model: champ,
        mode,
        state: this.state,
        reason: `🔥 Streak Leader: ${champ.name} (+${champ.streak || 0}W)`
      };
    }

    const isSessionMode = mode === INCHARGE_MODES.SESSION_WIN_RATE || mode === INCHARGE_MODES.SESSION_STREAK_OVERRIDE;
    const isStreakEnabled = mode === INCHARGE_MODES.WINNING_STREAK_OVERRIDE || mode === INCHARGE_MODES.SESSION_STREAK_OVERRIDE;

    const metricType = isSessionMode ? 'session' : 'overall';
    const ranked = this.rankModels(models, metricType);
    const baseModel = ranked[0] || models[0];

    if (!isStreakEnabled) {
      this.state = 'NORMAL';
      this.activeStreakModelId = null;
      return {
        model: baseModel,
        mode,
        state: this.state,
        reason: `👑 Base Champion: ${baseModel.name} (${((baseModel.winRate || 0) * 100).toFixed(1)}% WR)`
      };
    }

    const minStreak = Number(this.config.minStreak || 3);
    const minEvaluated = Number(this.config.minEvaluated || 10);

    const getStreak = m => isSessionMode && m.sessionStreak !== undefined ? Number(m.sessionStreak) : Number(m.streak || 0);
    const getEvaluated = m => isSessionMode && m.sessionEvaluated !== undefined ? Number(m.sessionEvaluated) : Number(m.totalEvaluated || 0);

    if (this.state === 'STREAK_OVERRIDE' && this.activeStreakModelId) {
      const currentStreakModel = models.find(m => m.id === this.activeStreakModelId);
      const curStreak = currentStreakModel ? getStreak(currentStreakModel) : 0;
      if (currentStreakModel && curStreak >= minStreak) {
        this.activeStreakCount = curStreak;
        return {
          model: currentStreakModel,
          mode,
          state: this.state,
          reason: `🔥 Streak Rider Active: ${currentStreakModel.name} (+${curStreak}W streak)`
        };
      } else {
        this.state = 'RETURN_TO_BASE';
        this.activeStreakModelId = null;
        this.activeStreakCount = 0;
      }
    }

    const eligibleStreakers = models.filter(m => {
      const s = getStreak(m);
      const ev = getEvaluated(m);
      return s >= minStreak && ev >= minEvaluated && m.id !== baseModel.id;
    });

    if (eligibleStreakers.length > 0) {
      eligibleStreakers.sort((a, b) => {
        const sDiff = getStreak(b) - getStreak(a);
        if (sDiff !== 0) return sDiff;
        return (b.winRate || 0) - (a.winRate || 0);
      });

      const streakChampion = eligibleStreakers[0];
      this.state = 'STREAK_OVERRIDE';
      this.activeStreakModelId = streakChampion.id;
      this.activeStreakCount = getStreak(streakChampion);

      return {
        model: streakChampion,
        mode,
        state: this.state,
        reason: `🚀 Streak Override: ${streakChampion.name} (+${this.activeStreakCount}W streak overtaking ${baseModel.name})`
      };
    }

    this.state = 'NORMAL';
    this.activeStreakModelId = null;
    this.activeStreakCount = 0;
    return {
      model: baseModel,
      mode,
      state: this.state,
      reason: `👑 Base Champion: ${baseModel.name} (${((baseModel.winRate || 0) * 100).toFixed(1)}% WR)`
    };
  }

  handleRoundSettlement(settledRoundResult) {
    if (this.state === 'STREAK_OVERRIDE' && this.activeStreakModelId) {
      const isWon = settledRoundResult && settledRoundResult.won === true;
      if (!isWon) {
        this.state = 'RETURN_TO_BASE';
        this.activeStreakModelId = null;
        this.activeStreakCount = 0;
      }
    }
  }
}

// ── 2. Load Canonical Mathematical Models ─────────────────────────────────────

let canonicalModelsLoaded = false;

function loadAlgorithmsIfNeeded() {
  if (canonicalModelsLoaded && typeof self.generateModelNextPrediction === 'function') return;

  const candidatePaths = [
    '/algorithms/arena_models.js',
    '../../algorithms/arena_models.js',
    './algorithms/arena_models.js',
    '../algorithms/arena_models.js'
  ];

  for (const path of candidatePaths) {
    try {
      importScripts(path);
      if (self.ARENA_CANONICAL_MODELS && typeof self.generateModelNextPrediction === 'function') {
        canonicalModelsLoaded = true;
        break;
      }
    } catch (e) {
      // try next path
    }
  }
}

// Initial script import
loadAlgorithmsIfNeeded();

// ── 3. Worker State per Timeframe ─────────────────────────────────────────────

const tfStates = {
  '30s': { history: [], models: [], engine: new WorkerInchargeEngine(), activeIncharge: null },
  '1m':  { history: [], models: [], engine: new WorkerInchargeEngine(), activeIncharge: null },
  '3m':  { history: [], models: [], engine: new WorkerInchargeEngine(), activeIncharge: null },
  '5m':  { history: [], models: [], engine: new WorkerInchargeEngine(), activeIncharge: null }
};

function initModelsForTf(tf) {
  loadAlgorithmsIfNeeded();
  const canonical = self.ARENA_CANONICAL_MODELS || [];
  return canonical.map(m => ({
    id: m.id,
    name: m.name,
    cat: m.cat,
    arch: m.arch,
    desc: m.desc,
    baseWinRate: m.baseWinRate || 0,
    wins: 0,
    losses: 0,
    totalEvaluated: 0,
    winRate: 0,
    winRatePct: '0.0%',
    streak: 0,
    bestStreak: 0,
    sessionWins: 0,
    sessionLosses: 0,
    sessionEvaluated: 0,
    sessionWinRate: 0,
    sessionStreak: 0,
    sessionBestStreak: 0,
    predTarget: m.predTarget || 'BIG',
    predType: m.predType || 'SIZE',
    predColor: m.predColor || 'GREEN',
    predSize: m.predSize || 'BIG',
    num: m.num || 7,
    conf: m.conf || 0.75,
    historyPath: []
  }));
}

// ── 4. Replay 24h Rolling History Engine ──────────────────────────────────────

function processHistoryReplay(tf, rawHistory, config) {
  loadAlgorithmsIfNeeded();
  if (!Array.isArray(rawHistory) || rawHistory.length === 0) return;

  const tfObj = tfStates[tf] || (tfStates[tf] = {
    history: [],
    models: initModelsForTf(tf),
    engine: new WorkerInchargeEngine(config),
    activeIncharge: null
  });

  if (config) {
    tfObj.engine.updateConfig(config);
  }

  // Ensure models are initialized
  if (!tfObj.models || tfObj.models.length === 0) {
    tfObj.models = initModelsForTf(tf);
  }

  // Sort oldest to newest
  const sorted = [...rawHistory].sort((a, b) => String(a.period).localeCompare(String(b.period)));
  tfObj.history = sorted;

  // Progressive training and evaluation replay
  for (let i = 0; i < sorted.length; i++) {
    const currentRound = sorted[i];
    const subHistory = sorted.slice(0, i);

    if (subHistory.length >= 2) {
      // Evaluate previous predictions against currentRound outcome
      const numVal = currentRound.number ?? currentRound.openNumber ?? 0;
      const sizeVal = currentRound.size || (numVal >= 5 ? 'BIG' : 'SMALL');
      const colorVal = currentRound.color || (numVal === 0 ? 'RED,VIOLET' : numVal === 5 ? 'GREEN,VIOLET' : [1,3,7,9].includes(numVal) ? 'GREEN' : 'RED');

      for (const model of tfObj.models) {
        if (model.predTarget && typeof self.evaluatePredictionCorrectness === 'function') {
          const isWin = self.evaluatePredictionCorrectness(model.predTarget, numVal, sizeVal, colorVal);
          if (isWin !== null) {
            model.totalEvaluated = (model.totalEvaluated || 0) + 1;
            if (isWin) {
              model.wins = (model.wins || 0) + 1;
              model.streak = (model.streak || 0) > 0 ? (model.streak + 1) : 1;
              if (model.streak > (model.bestStreak || 0)) model.bestStreak = model.streak;
            } else {
              model.losses = (model.losses || 0) + 1;
              model.streak = (model.streak || 0) < 0 ? (model.streak - 1) : -1;
            }
            model.winRate = model.totalEvaluated > 0 ? model.wins / model.totalEvaluated : 0;
            model.winRatePct = `${(model.winRate * 100).toFixed(1)}%`;

            if (!model.historyPath) model.historyPath = [];
            model.historyPath.unshift({ period: currentRound.period, won: isWin, predTarget: model.predTarget });
            if (model.historyPath.length > 20) model.historyPath.pop();
          }
        }
      }
    }

    // Generate prediction for subsequent round using subHistory + currentRound
    const historyUpToCurrent = sorted.slice(0, i + 1);
    for (const model of tfObj.models) {
      if (typeof self.generateModelNextPrediction === 'function') {
        try {
          const pred = self.generateModelNextPrediction(model, historyUpToCurrent);
          if (pred && pred.predTarget) {
            model.predTarget = pred.predTarget;
            model.predType = pred.predType || model.predType;
            model.predColor = pred.predColor || model.predColor;
            model.predSize = pred.predSize || model.predSize;
            model.num = pred.num !== undefined ? pred.num : model.num;
            model.conf = pred.conf || model.conf;
          }
        } catch (e) {}
      }
    }
  }

  // Compute Authoritative In-Charge Model
  const inchargeResult = tfObj.engine.evaluateIncharge(tfObj.models);
  tfObj.activeIncharge = inchargeResult;

  // Post back results
  postMessage({
    type: 'HISTORY_INITIALIZED',
    timeframe: tf,
    activeIncharge: inchargeResult,
    inchargeState: tfObj.engine.getState(),
    allModelStats: tfObj.models,
    totalRounds: tfObj.history.length
  });
}

// ── 5. Realtime Round Settlement & Execution ─────────────────────────────────

function processNewRound(tf, round) {
  loadAlgorithmsIfNeeded();
  if (!round || !round.period) return;

  const tfObj = tfStates[tf] || (tfStates[tf] = {
    history: [],
    models: initModelsForTf(tf),
    engine: new WorkerInchargeEngine(),
    activeIncharge: null
  });

  // Deduplicate round
  const existingIdx = tfObj.history.findIndex(r => String(r.period) === String(round.period));
  if (existingIdx >= 0) {
    tfObj.history[existingIdx] = { ...tfObj.history[existingIdx], ...round };
  } else {
    tfObj.history.push(round);
    // Maintain max 2880 rolling window (24 hours @ 30s)
    if (tfObj.history.length > 2880) tfObj.history.shift();
  }

  const numVal = parseInt(round.number ?? round.openNumber ?? 0, 10);
  const sizeVal = round.size || (numVal >= 5 ? 'BIG' : 'SMALL');
  const colorVal = round.color || (numVal === 0 ? 'RED,VIOLET' : numVal === 5 ? 'GREEN,VIOLET' : [1,3,7,9].includes(numVal) ? 'GREEN' : 'RED');

  let championWon = null;
  const currentInchargeId = tfObj.activeIncharge?.model?.id;

  // 1. Evaluate all 53 models against actual round outcome
  for (const model of tfObj.models) {
    if (model.predTarget && typeof self.evaluatePredictionCorrectness === 'function') {
      const isWin = self.evaluatePredictionCorrectness(model.predTarget, numVal, sizeVal, colorVal);
      if (isWin !== null) {
        // All-Time Stats
        model.totalEvaluated = (model.totalEvaluated || 0) + 1;
        if (isWin) {
          model.wins = (model.wins || 0) + 1;
          model.streak = (model.streak || 0) > 0 ? (model.streak + 1) : 1;
          if (model.streak > (model.bestStreak || 0)) model.bestStreak = model.streak;
        } else {
          model.losses = (model.losses || 0) + 1;
          model.streak = (model.streak || 0) < 0 ? (model.streak - 1) : -1;
        }
        model.winRate = model.totalEvaluated > 0 ? model.wins / model.totalEvaluated : 0;
        model.winRatePct = `${(model.winRate * 100).toFixed(1)}%`;

        if (!model.historyPath) model.historyPath = [];
        model.historyPath.unshift({ period: round.period, won: isWin, predTarget: model.predTarget });
        if (model.historyPath.length > 20) model.historyPath.pop();

        if (isWin) {
          model.dopamine = Math.min(1.0, (model.dopamine || 0.5) + 0.12);
          model.lossPain = Math.max(0.0, (model.lossPain || 0) * 0.4);
        } else {
          // If model is wrong 5+ times consecutively, trigger fly neuron pain penalty
          if (Math.abs(model.streak || 0) >= 5) {
            model.lossPain = Math.min(1.0, (model.lossPain || 0) + 0.35 + (Math.abs(model.streak) - 5) * 0.15);
            model.dopamine = Math.max(0.05, (model.dopamine || 0.5) * 0.3);
          }
        }

        // User Session Isolated Stats
        model.sessionEvaluated = (model.sessionEvaluated || 0) + 1;
        if (isWin) {
          model.sessionWins = (model.sessionWins || 0) + 1;
          model.sessionStreak = (model.sessionStreak || 0) > 0 ? (model.sessionStreak + 1) : 1;
          if (model.sessionStreak > (model.sessionBestStreak || 0)) model.sessionBestStreak = model.sessionStreak;
        } else {
          model.sessionLosses = (model.sessionLosses || 0) + 1;
          model.sessionStreak = (model.sessionStreak || 0) < 0 ? (model.sessionStreak - 1) : -1;
        }
        model.sessionWinRate = model.sessionEvaluated > 0 ? model.sessionWins / model.sessionEvaluated : 0;

        if (model.id === currentInchargeId) {
          championWon = isWin;
        }
      }
    }
  }

  // 2. Feed settlement to Incharge State Machine (terminates streak on loss)
  tfObj.engine.handleRoundSettlement({ won: championWon });

  // 3. Compute next predictions for all 53 models for upcoming period
  for (const model of tfObj.models) {
    if (typeof self.generateModelNextPrediction === 'function') {
      try {
        const pred = self.generateModelNextPrediction(model, tfObj.history);
        if (pred && pred.predTarget) {
          model.predTarget = pred.predTarget;
          model.predType = pred.predType || model.predType;
          model.predColor = pred.predColor || model.predColor;
          model.predSize = pred.predSize || model.predSize;
          model.num = pred.num !== undefined ? pred.num : model.num;
          model.conf = pred.conf || model.conf;
        }
      } catch (e) {}
    }
  }

  // 4. Authoritative Incharge Re-evaluation
  const inchargeResult = tfObj.engine.evaluateIncharge(tfObj.models);
  tfObj.activeIncharge = inchargeResult;

  // 5. Post updated predictions to main thread
  postMessage({
    type: 'PREDICTIONS_UPDATED',
    timeframe: tf,
    period: round.period,
    activeIncharge: inchargeResult,
    inchargeState: tfObj.engine.getState(),
    allModelStats: tfObj.models,
    latestOutcome: round
  });
}

// ── 6. Message Dispatcher ─────────────────────────────────────────────────────

self.onmessage = function (event) {
  const { type, data } = event.data || {};

  switch (type) {
    case 'INIT_24H_HISTORY': {
      const { timeframe, history, config } = data;
      processHistoryReplay(timeframe || '30s', history || [], config);
      break;
    }

    case 'UPDATE_NEW_ROUND': {
      const { timeframe, round } = data;
      processNewRound(timeframe || '30s', round);
      break;
    }

    case 'SET_CONFIG': {
      const { config, timeframe } = data;
      if (config) {
        Object.keys(tfStates).forEach(tf => {
          tfStates[tf].engine.updateConfig(config);
          tfStates[tf].activeIncharge = tfStates[tf].engine.evaluateIncharge(tfStates[tf].models);
        });
      }
      postMessage({
        type: 'CONFIG_UPDATED',
        config,
        activeIncharge: timeframe ? tfStates[timeframe]?.activeIncharge : tfStates['30s']?.activeIncharge,
        inchargeState: timeframe ? tfStates[timeframe]?.engine.getState() : tfStates['30s']?.engine.getState()
      });
      break;
    }

    case 'RESET_SESSION': {
      const { timeframe } = data || {};
      const targetTfs = timeframe ? [timeframe] : Object.keys(tfStates);

      targetTfs.forEach(tf => {
        const tfObj = tfStates[tf];
        if (tfObj && Array.isArray(tfObj.models)) {
          tfObj.models.forEach(m => {
            m.sessionWins = 0;
            m.sessionLosses = 0;
            m.sessionEvaluated = 0;
            m.sessionWinRate = 0;
            m.sessionStreak = 0;
            m.sessionBestStreak = 0;
          });
          tfObj.activeIncharge = tfObj.engine.evaluateIncharge(tfObj.models);
        }
      });

      postMessage({
        type: 'SESSION_RESET',
        timeframe: timeframe || 'all',
        activeIncharge: timeframe ? tfStates[timeframe]?.activeIncharge : tfStates['30s']?.activeIncharge,
        allModelStats: timeframe ? tfStates[timeframe]?.models : tfStates['30s']?.models
      });
      break;
    }

    case 'GET_STATE': {
      const { timeframe } = data || {};
      const tf = timeframe || '30s';
      const tfObj = tfStates[tf];
      postMessage({
        type: 'STATE_RESPONSE',
        timeframe: tf,
        activeIncharge: tfObj?.activeIncharge,
        inchargeState: tfObj?.engine.getState(),
        allModelStats: tfObj?.models || []
      });
      break;
    }

    default:
      console.warn('[modelWorker] Unhandled message type:', type);
  }
};
