/**
 * Full-History Replay & Model Rebuild Engine
 * ===========================================
 * Chronologically replays complete database history from round 0 to present.
 * Reconstructs exact model states, predictions, win rates, and streaks.
 * Used for migration verification, corrupted state recovery, and model version testing.
 */

export class RebuildEngine {
  constructor(db, modelRegistry) {
    this.db = db;
    this.modelRegistry = modelRegistry;
  }

  async rebuildAllModels(interval) {
    const startTime = Date.now();
    const history = this.db.getAllChronologicalHistory(interval);
    if (!history || history.length === 0) {
      return { success: false, message: 'No history found to rebuild', rounds: 0 };
    }

    const pool = this.modelRegistry.createPool();
    const results = [];

    for (const model of pool) {
      const modelStart = Date.now();
      model.initialize();

      // Walk forward chronologically
      for (let i = 0; i < history.length; i++) {
        const round = history[i];
        if (i >= 2) {
          const priorContext = history.slice(0, i);
          model.predict(priorContext);
          model.evaluatePrediction(round);
        }
      }

      // Persist reconstructed state and server stats
      this.db.saveModelState(model.id, interval, model.getState());
      this.db.saveModelServerStats(model.id, interval, model.getStatistics());

      results.push({
        modelId: model.id,
        name: model.name,
        roundsReplayed: history.length,
        wins: model.wins,
        losses: model.losses,
        winRate: model.winRate,
        winRatePct: model.winRatePct,
        streak: model.streak,
        bestStreak: model.bestStreak,
        durationMs: Date.now() - modelStart
      });
    }

    return {
      success: true,
      interval,
      totalRounds: history.length,
      totalModels: pool.length,
      durationMs: Date.now() - startTime,
      models: results
    };
  }

  async rebuildSingleModel(interval, modelId) {
    const startTime = Date.now();
    const history = this.db.getAllChronologicalHistory(interval);
    if (!history || history.length === 0) {
      return { success: false, message: 'No history found to rebuild', rounds: 0 };
    }

    const pool = this.modelRegistry.createPool();
    const model = pool.find(m => m.id === modelId);
    if (!model) {
      return { success: false, message: `Model ${modelId} not found in registry` };
    }

    model.initialize();

    for (let i = 0; i < history.length; i++) {
      const round = history[i];
      if (i >= 2) {
        const priorContext = history.slice(0, i);
        model.predict(priorContext);
        model.evaluatePrediction(round);
      }
    }

    this.db.saveModelState(model.id, interval, model.getState());
    this.db.saveModelServerStats(model.id, interval, model.getStatistics());

    return {
      success: true,
      modelId: model.id,
      name: model.name,
      interval,
      roundsReplayed: history.length,
      wins: model.wins,
      losses: model.losses,
      winRate: model.winRate,
      winRatePct: model.winRatePct,
      streak: model.streak,
      bestStreak: model.bestStreak,
      durationMs: Date.now() - startTime
    };
  }
}
