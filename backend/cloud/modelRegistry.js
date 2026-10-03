/**
 * 53+ Model Registry & State Engine
 * =================================
 * Standardized interface wrapping all 53 canonical models with 100% logic preservation.
 * Supports adding future models (54, 55, ...) without engine redesign.
 * Manages incremental updates and persistent server state.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  ARENA_CANONICAL_MODELS,
  generateModelNextPrediction,
  determineOptimalArenaInChargeModel,
  evaluatePredictionCorrectness
} = require('../../scripts/arena_models.cjs');

export { evaluatePredictionCorrectness, determineOptimalArenaInChargeModel };

export class RegisteredModel {
  constructor(metadata) {
    this.id = metadata.id;
    this.name = metadata.name;
    this.cat = metadata.cat || 'general';
    this.arch = metadata.arch || '';
    this.desc = metadata.desc || '';
    this.predType = metadata.predType || (this.cat === 'fly' ? 'COLOR' : 'SIZE');
    this.version = metadata.version || '1.0.0';

    // Model Performance Statistics (Server-side & All-time)
    this.wins = 0;
    this.losses = 0;
    this.totalEvaluated = 0;
    this.winRate = 0;
    this.winRatePct = '0.0%';

    // Dynamic State Variables
    this.streak = 0;
    this.bestStreak = 0;
    this.dopamine = 0.50;
    this.lossPain = 0.0;
    this.historyPath = [];

    // Current Upcoming Prediction
    this.predTarget = metadata.predTarget || (this.predType === 'COLOR' ? 'GREEN' : 'BIG');
    this.predColor = metadata.predColor || 'GREEN';
    this.predSize = metadata.predSize || 'BIG';
    this.num = metadata.num || 7;
    this.conf = metadata.conf || 0.75;

    // Custom model predict override (if registered dynamically)
    this.customPredictFn = metadata.predictFn || null;
  }

  initialize() {
    this.wins = 0;
    this.losses = 0;
    this.totalEvaluated = 0;
    this.winRate = 0;
    this.winRatePct = '0.0%';
    this.streak = 0;
    this.bestStreak = 0;
    this.dopamine = 0.50;
    this.lossPain = 0.0;
    this.historyPath = [];
  }

  restoreState(savedState, savedStats) {
    if (savedState) {
      this.streak = Number(savedState.streak || 0);
      this.bestStreak = Number(savedState.bestStreak || savedState.best_streak || 0);
      this.dopamine = Number(savedState.dopamine !== undefined ? savedState.dopamine : 0.50);
      this.lossPain = Number(savedState.lossPain !== undefined ? savedState.lossPain : (savedState.loss_pain || 0.0));
      if (typeof savedState.history_path === 'string') {
        try { this.historyPath = JSON.parse(savedState.history_path); } catch(e) { this.historyPath = []; }
      } else if (Array.isArray(savedState.historyPath)) {
        this.historyPath = savedState.historyPath;
      }
    }

    if (savedStats) {
      this.totalEvaluated = Number(savedStats.totalEvaluated || savedStats.total_evaluated || 0);
      this.wins = Number(savedStats.wins || 0);
      this.losses = Number(savedStats.losses || 0);
      this.winRate = Number(savedStats.winRate !== undefined ? savedStats.winRate : (savedStats.win_rate || 0.0));
      this.winRatePct = (this.winRate * 100).toFixed(1) + '%';
    }
  }

  predict(history, allModels = null) {
    if (typeof this.customPredictFn === 'function') {
      const p = this.customPredictFn(history, this.getState(), allModels);
      this.applyPrediction(p);
      return p;
    }

    const modelRef = {
      id: this.id,
      name: this.name,
      cat: this.cat,
      arch: this.arch,
      desc: this.desc,
      predType: this.predType,
      streak: this.streak,
      bestStreak: this.bestStreak,
      dopamine: this.dopamine,
      lossPain: this.lossPain
    };

    const statsRef = {
      streak: this.streak,
      bestStreak: this.bestStreak,
      dopamine: this.dopamine,
      lossPain: this.lossPain,
      allModels: (Array.isArray(allModels) && allModels.length > 0) ? allModels : undefined
    };

    const p = generateModelNextPrediction(modelRef, history, statsRef);
    this.applyPrediction(p);
    return p;
  }

  applyPrediction(p) {
    if (!p) return;
    this.predType = p.predType || this.predType;
    this.predTarget = p.predTarget || this.predTarget;
    this.predColor = p.predColor || this.predColor;
    this.predSize = p.predSize || this.predSize;
    this.num = p.num !== undefined ? p.num : this.num;
    this.conf = p.conf !== undefined ? p.conf : this.conf;
  }

  evaluatePrediction(round) {
    const numVal = parseInt(round.number, 10);
    const actualColor = [1, 3, 5, 7, 9].includes(numVal) ? 'GREEN' : 'RED';
    const actualSize = round.size || (numVal >= 5 ? 'BIG' : 'SMALL');

    const won = !!evaluatePredictionCorrectness(this.predTarget, numVal, actualSize, actualColor);

    this.totalEvaluated++;
    if (won) {
      this.wins++;
      this.streak = this.streak >= 0 ? this.streak + 1 : 1;
      if (this.streak > this.bestStreak) this.bestStreak = this.streak;
      this.dopamine = Math.min(1.0, Number((this.dopamine + 0.10).toFixed(2)));
      this.lossPain = Math.max(0.0, Number((this.lossPain - 0.15).toFixed(2)));
    } else {
      this.losses++;
      this.streak = this.streak <= 0 ? this.streak - 1 : -1;
      this.lossPain = Math.min(1.0, Number((this.lossPain + 0.15).toFixed(2)));
      this.dopamine = Math.max(0.0, Number((this.dopamine - 0.10).toFixed(2)));
    }

    this.winRate = this.totalEvaluated > 0 ? Number((this.wins / this.totalEvaluated).toFixed(3)) : 0;
    this.winRatePct = (this.winRate * 100).toFixed(1) + '%';

    this.historyPath.unshift({
      period: round.period,
      won,
      predType: this.predType,
      predTarget: this.predTarget,
      actual: this.predType === 'COLOR' ? actualColor : actualSize
    });
    if (this.historyPath.length > 10) this.historyPath.length = 10;

    return { won, target: this.predTarget, numVal, actualSize, actualColor };
  }

  getState() {
    return {
      id: this.id,
      streak: this.streak,
      bestStreak: this.bestStreak,
      dopamine: this.dopamine,
      lossPain: this.lossPain,
      historyPath: [...this.historyPath]
    };
  }

  getStatistics() {
    return {
      modelId: this.id,
      id: this.id,
      name: this.name,
      cat: this.cat,
      predType: this.predType,
      predTarget: this.predTarget,
      predColor: this.predColor,
      predSize: this.predSize,
      num: this.num,
      conf: this.conf,
      totalEvaluated: this.totalEvaluated,
      wins: this.wins,
      losses: this.losses,
      winRate: this.winRate,
      winRatePct: this.winRatePct,
      streak: this.streak,
      bestStreak: this.bestStreak
    };
  }

  rebuild(chronologicalRounds) {
    this.initialize();
    for (let i = 0; i < chronologicalRounds.length; i++) {
      const round = chronologicalRounds[i];
      if (i >= 2) {
        const priorContext = chronologicalRounds.slice(0, i);
        this.predict(priorContext);
        this.evaluatePrediction(round);
      }
    }
  }
}

export class ModelRegistry {
  constructor() {
    this.modelTemplates = new Map();
    this.loadCanonicalModels();
  }

  loadCanonicalModels() {
    ARENA_CANONICAL_MODELS.forEach(m => {
      this.modelTemplates.set(m.id, { ...m });
    });
  }

  registerCustomModel(modelDef) {
    if (!modelDef.id || !modelDef.name) {
      throw new Error('Custom model must provide id and name');
    }
    this.modelTemplates.set(modelDef.id, {
      ...modelDef,
      cat: modelDef.cat || 'custom',
      predType: modelDef.predType || 'SIZE'
    });
  }

  getModelCount() {
    return this.modelTemplates.size;
  }

  getAllModelDefinitions() {
    return Array.from(this.modelTemplates.values());
  }

  createPool() {
    const pool = [];
    for (const tmpl of this.modelTemplates.values()) {
      pool.push(new RegisteredModel(tmpl));
    }
    return pool;
  }
}

export const globalModelRegistry = new ModelRegistry();
