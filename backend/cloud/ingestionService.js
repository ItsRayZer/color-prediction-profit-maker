/**
 * 24/7 Cloud Ingestion & Processing Daemon
 * ========================================
 * Continuously runs independent of user connections.
 * Ingests, validates, deduplicates, and recovers missing periods for all intervals.
 * Executes the 53+ model engine, updates server model statistics,
 * maintains Incharge B, and emits real-time updates.
 */

import { EventEmitter } from 'node:events';
import { INTERVAL_CONFIGS, computeNextPeriod, getColorForNumber, getSizeForNumber } from './intervalConfig.js';
import { getFirebaseDatabaseAccessToken } from './firebaseAuth.js';

export class IngestionService extends EventEmitter {
  constructor(db, modelRegistry, inchargeController, options = {}) {
    super();
    this.db = db;
    this.modelRegistry = modelRegistry;
    this.inchargeController = inchargeController;
    this.options = options;

    this.modelPools = {};
    this.lastProcessedPeriod = {};
    this.scheduledPredictions = {};
    this.pollTimers = {};
    this.isRunning = false;

    this.rtdbBase = options.rtdbBase || 'https://zer0one-376d1-default-rtdb.asia-southeast1.firebasedatabase.app';
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[IngestionService] 🚀 Starting 24/7 Cloud Ingestion for all intervals...');

    for (const [tfKey, cfg] of Object.entries(INTERVAL_CONFIGS)) {
      if (!cfg.enabled) continue;
      this.initIntervalPool(tfKey);
      await this.warmupInterval(tfKey);
      this.startPolling(tfKey);
    }
  }

  stop() {
    this.isRunning = false;
    for (const timer of Object.values(this.pollTimers)) {
      clearInterval(timer);
    }
    this.pollTimers = {};
    console.log('[IngestionService] 🛑 Ingestion stopped.');
  }

  initIntervalPool(interval) {
    if (!this.modelPools[interval]) {
      this.modelPools[interval] = this.modelRegistry.createPool();
      // Restore persisted states from database if available
      for (const model of this.modelPools[interval]) {
        const savedState = this.db.getModelState(model.id, interval);
        const savedStats = this.db.getModelServerStats(model.id, interval);
        model.restoreState(savedState, savedStats);
      }
    }
    if (!this.scheduledPredictions[interval]) {
      this.scheduledPredictions[interval] = {};
    }
  }

  async fetchUpstreamPages(cfg, pagesCount = 5) {
    const promises = [];
    for (let p = 1; p <= pagesCount; p++) {
      const url = `${cfg.urlBase}?pageNo=${p}&pageSize=10`;
      promises.push(
        fetch(url, {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Referer': 'https://dhaniwin0.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        })
        .then(res => res.ok ? res.json() : null)
        .then(d => {
          if (d && d.data && d.data.list) return d.data.list;
          return [];
        })
        .catch(() => [])
      );
    }
    const results = await Promise.all(promises);
    return results.flat();
  }

  parseRounds(rawList, intervalCode) {
    if (!Array.isArray(rawList)) return [];
    return rawList
      .map(row => {
        const period = String(row.issueNumber || row.issue || row.period || row.expect || '').trim();
        const n = parseInt(row.number !== undefined ? row.number : (row.openNumber !== undefined ? row.openNumber : row.code || 0), 10);
        const size = row.size ? String(row.size).toUpperCase() : getSizeForNumber(n);
        const color = row.color ? String(row.color).toLowerCase() : getColorForNumber(n);
        return {
          period,
          number: n,
          size,
          color,
          source_timestamp: row.createTime || row.time || null
        };
      })
      .filter(r => r.period && !isNaN(r.number) && (!intervalCode || r.period.includes(intervalCode)))
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  detectGaps(rounds) {
    const gaps = [];
    for (let i = 0; i < rounds.length - 1; i++) {
      const p1 = parseInt(rounds[i].period.slice(-4), 10);
      const p2 = parseInt(rounds[i + 1].period.slice(-4), 10);
      if (!isNaN(p1) && !isNaN(p2) && p2 > p1 + 1) {
        gaps.push({ from: rounds[i].period, to: rounds[i + 1].period, missingCount: p2 - p1 - 1 });
      }
    }
    return gaps;
  }

  async warmupInterval(interval) {
    const cfg = INTERVAL_CONFIGS[interval];
    console.log(`[IngestionService] [${interval.toUpperCase()}] Performing initial sync & warmup...`);

    // Fetch upstream past rounds
    const rawList = await this.fetchUpstreamPages(cfg, 5);
    const parsed = this.parseRounds(rawList, cfg.code);

    if (parsed.length > 0) {
      // Save raw event for audit
      this.db.saveRawEvent('ar-lottery', interval, rawList);

      // Check for gaps
      const gaps = this.detectGaps(parsed);
      if (gaps.length > 0) {
        console.warn(`[IngestionService] [${interval.toUpperCase()}] Detected ${gaps.length} gaps. Fetching deep history to recover...`);
        this.db.recordHealthMetric(interval, 'missing_periods', gaps.length, gaps);
        const deepRaw = await this.fetchUpstreamPages(cfg, 10);
        const deepParsed = this.parseRounds(deepRaw, cfg.code);
        deepParsed.forEach(r => this.db.insertRound({ ...r, interval }));
      } else {
        parsed.forEach(r => this.db.insertRound({ ...r, interval }));
      }
    }

    // Load full chronological history from database
    const history = this.db.getAllChronologicalHistory(interval);
    if (!history || history.length === 0) return;

    const models = this.modelPools[interval];
    const latestSettled = history[history.length - 1];
    this.lastProcessedPeriod[interval] = latestSettled.period;

    // Walk forward to calculate model states if freshly started
    const startIdx = Math.max(2, Math.floor(history.length * 0.3));
    for (let i = startIdx; i < history.length; i++) {
      const priorContext = history.slice(0, i);
      const currentRound = history[i];

      // Predict
      models.forEach(m => {
        try { m.predict(priorContext, models); } catch(e) {}
      });

      // Select Incharge B
      const inChargeSelection = this.inchargeController.evaluateServiceIncharge(interval, models, null, true);
      const inCharge = inChargeSelection?.model || models[0];

      // Evaluate and stamp
      const inChargeEval = inCharge.evaluatePrediction(currentRound);
      currentRound.ai_target = inCharge.predTarget;
      currentRound.ai_type = inCharge.predType;
      currentRound.ai_model = inCharge.name;
      currentRound.ai_correct = inChargeEval.won ? 1 : 0;
      currentRound.ai_confidence = Math.round((inCharge.conf || 0.75) * 100);
      currentRound.result = inChargeEval.won ? 'WIN' : 'LOSS';

      this.db.updateRoundPrediction(interval, currentRound.period, {
        target: currentRound.ai_target,
        type: currentRound.ai_type,
        modelName: currentRound.ai_model,
        correct: inChargeEval.won,
        confidence: currentRound.ai_confidence,
        result: currentRound.result
      });

      // Evaluate remaining models
      models.forEach(m => {
        if (m.id !== inCharge.id) {
          try { m.evaluatePrediction(currentRound); } catch(e) {}
        }
      });
    }

    // Persist all model states & server stats
    for (const m of models) {
      this.db.saveModelState(m.id, interval, m.getState());
      this.db.saveModelServerStats(m.id, interval, m.getStatistics());
    }

    // Predict upcoming round
    models.forEach(m => {
      try { m.predict(history, models); } catch(e) {}
    });

    const inChargeSelection = this.inchargeController.evaluateServiceIncharge(interval, models, null, true);
    const inCharge = inChargeSelection?.model || models[0];
    const nextPeriod = computeNextPeriod(latestSettled.period);

    const now = Date.now();
    const serviceState = {
      latestPeriod: latestSettled.period,
      latestNumber: latestSettled.number,
      latestSize: latestSettled.size,
      latestColor: latestSettled.color,
      serviceTarget: inCharge.predTarget,
      serviceType: inCharge.predType,
      serviceModelId: inCharge.id,
      serviceModelName: inCharge.name,
      serviceConfidence: Math.round((inCharge.conf || 0.75) * 100),
      serviceWinRate: inCharge.winRate,
      serviceStreak: inCharge.streak,
      targetPeriod: nextPeriod,
      target: inCharge.predTarget,
      targetType: inCharge.predType,
      targetColor: inCharge.predColor,
      targetSize: inCharge.predSize,
      targetNum: inCharge.num,
      targetConfidence: Math.round((inCharge.conf || 0.75) * 100),
      roundStart: now,
      roundEnd: now + (cfg.durationSec * 1000),
      lastSourceTimestamp: now,
      lastProcessedAt: now,
      processingStatus: 'healthy',
      leaderboard: models.map(m => m.getStatistics()).sort((a, b) => b.winRate - a.winRate)
    };

    this.db.saveServiceState(interval, serviceState);
    console.log(`[IngestionService] [${interval.toUpperCase()}] Warmup complete. In-Charge: ${inCharge.name} (${(inCharge.winRate * 100).toFixed(1)}% WR) -> Target: ${inCharge.predTarget}`);
  }

  startPolling(interval) {
    const cfg = INTERVAL_CONFIGS[interval];
    this.pollTimers[interval] = setInterval(async () => {
      try {
        await this.pollInterval(interval);
      } catch (err) {
        console.error(`[IngestionService] [${interval.toUpperCase()}] Poll error:`, err.message);
      }
    }, cfg.pollIntervalMs);
  }

  async pollInterval(interval) {
    const cfg = INTERVAL_CONFIGS[interval];
    const fetchStart = Date.now();

    const rawList = await this.fetchUpstreamPages(cfg, 1);
    const fetchLatency = Date.now() - fetchStart;
    this.db.recordHealthMetric(interval, 'ingestion_latency_ms', fetchLatency);

    if (!rawList || rawList.length === 0) return;
    const parsed = this.parseRounds(rawList, cfg.code);
    if (parsed.length === 0) return;

    // Check newly arrived rounds
    const lastP = this.lastProcessedPeriod[interval] || '';
    const newRounds = parsed.filter(r => r.period > lastP);
    if (newRounds.length === 0) return; // No new round yet

    const procStart = Date.now();

    for (const round of newRounds) {
      // 1. Deduplicate & persist
      const inserted = this.db.insertRound({ ...round, interval });
      if (!inserted) {
        this.db.recordHealthMetric(interval, 'duplicates', 1, { period: round.period });
      }

      this.lastProcessedPeriod[interval] = round.period;

      // 2. Load context
      const history = this.db.getAllChronologicalHistory(interval);
      const models = this.modelPools[interval];

      // 3. Evaluate previous in-charge prediction for this settled round
      const inChargeSelection = this.inchargeController.evaluateServiceIncharge(interval, models, null, true);
      const inCharge = inChargeSelection?.model || models[0];
      const inChargeEval = inCharge.evaluatePrediction(round);

      this.db.updateRoundPrediction(interval, round.period, {
        target: inCharge.predTarget,
        type: inCharge.predType,
        modelName: inCharge.name,
        correct: inChargeEval.won,
        confidence: Math.round((inCharge.conf || 0.75) * 100),
        result: inChargeEval.won ? 'WIN' : 'LOSS'
      });

      // 4. Evaluate all other models
      models.forEach(m => {
        if (m.id !== inCharge.id) {
          try { m.evaluatePrediction(round); } catch(e) {}
        }
        // Save persistent server state & server stats
        this.db.saveModelState(m.id, interval, m.getState());
        this.db.saveModelServerStats(m.id, interval, m.getStatistics());
      });

      // 5. Generate prediction for upcoming round across all models
      models.forEach(m => {
        try { m.predict(history, models); } catch(e) {}
      });

      // 6. Select new Incharge B
      const nextInChargeSelection = this.inchargeController.evaluateServiceIncharge(interval, models, null, true);
      const nextInCharge = nextInChargeSelection?.model || models[0];
      const nextPeriod = computeNextPeriod(round.period);

      const now = Date.now();
      const serviceState = {
        latestPeriod: round.period,
        latestNumber: round.number,
        latestSize: round.size,
        latestColor: round.color,
        serviceTarget: nextInCharge.predTarget,
        serviceType: nextInCharge.predType,
        serviceModelId: nextInCharge.id,
        serviceModelName: nextInCharge.name,
        serviceConfidence: Math.round((nextInCharge.conf || 0.75) * 100),
        serviceWinRate: nextInCharge.winRate,
        serviceStreak: nextInCharge.streak,
        targetPeriod: nextPeriod,
        target: nextInCharge.predTarget,
        targetType: nextInCharge.predType,
        targetColor: nextInCharge.predColor,
        targetSize: nextInCharge.predSize,
        targetNum: nextInCharge.num,
        targetConfidence: Math.round((nextInCharge.conf || 0.75) * 100),
        roundStart: now,
        roundEnd: now + (cfg.durationSec * 1000),
        lastSourceTimestamp: round.source_timestamp ? new Date(round.source_timestamp).getTime() : now,
        lastProcessedAt: now,
        processingStatus: 'healthy',
        leaderboard: models.map(m => m.getStatistics()).sort((a, b) => b.winRate - a.winRate)
      };

      this.db.saveServiceState(interval, serviceState);

      const procLatency = Date.now() - procStart;
      this.db.recordHealthMetric(interval, 'processing_latency_ms', procLatency);

      console.log(`[IngestionService] [${interval.toUpperCase()}] Round Settled: ${round.period} -> #${round.number} (${round.size}, ${round.color}) | In-Charge: ${inCharge.name} (${inChargeEval.won ? 'WIN ✓' : 'LOSS ✗'}) | Next: ${nextInCharge.name} -> ${nextInCharge.predTarget} (${procLatency}ms)`);

      // 7. Emit atomic event for realtime subscribers
      const eventPayload = {
        interval,
        settledRound: round,
        serviceState,
        inChargeResult: inChargeEval.won ? 'WIN' : 'LOSS',
        serverTimeMs: now
      };
      this.emit('NEW_ROUND', eventPayload);

      // Also replicate to Firebase RTDB asynchronously if configured
      this.syncToFirebaseRTDB(interval, history.slice(-50), serviceState).catch(() => {});
    }
  }

  async syncToFirebaseRTDB(interval, historySlice, serviceState) {
    if (!this.rtdbBase) return;
    try {
      const accessToken = await getFirebaseDatabaseAccessToken();
      if (!accessToken) {
        console.warn('[IngestionService] Firebase write skipped: FIREBASE_SERVICE_ACCOUNT_JSON is not configured.');
        return;
      }
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      };
      const lastSettled = historySlice && historySlice.length > 0 ? historySlice[historySlice.length - 1] : null;
      await Promise.all([
        fetch(`${this.rtdbBase}/live_history/${interval}.json`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(historySlice.map(r => ({
            period: r.period,
            number: r.number,
            size: r.size,
            color: r.color,
            aiTarget: r.ai_target,
            aiType: r.ai_type,
            aiModel: r.ai_model,
            aiCorrect: r.ai_correct === 1,
            aiConfidence: r.ai_confidence,
            result: r.result
          })))
        }),
        fetch(`${this.rtdbBase}/universal_state/${interval}.json`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            timeframe: interval,
            latestSettledPeriod: serviceState.latestPeriod,
            latestSettledNumber: serviceState.latestNumber,
            latestSettledSize: serviceState.latestSize,
            latestSettledColor: serviceState.latestColor,
            latestSettledResult: lastSettled?.result || 'WIN',
            latestSettledWon: lastSettled ? (lastSettled.ai_correct === 1 || lastSettled.result === 'WIN') : true,
            latestSettledTarget: lastSettled?.ai_target || serviceState.serviceTarget,
            latestSettledType: lastSettled?.ai_type || serviceState.serviceType,
            targetPeriod: serviceState.targetPeriod,
            target: serviceState.target,
            type: serviceState.targetType,
            color: serviceState.targetColor,
            size: serviceState.targetSize,
            number: serviceState.targetNum,
            confidence: serviceState.targetConfidence,
            inChargeModel: serviceState.serviceModelName,
            inChargeModelId: serviceState.serviceModelId,
            inChargeStreak: serviceState.serviceStreak,
            inChargeWinRate: serviceState.serviceWinRate,
            inChargeWinRatePct: (serviceState.serviceWinRate * 100).toFixed(1) + '%',
            serverTimeMs: serviceState.lastProcessedAt,
            leaderboard: serviceState.leaderboard
          })
        })
      ]);
    } catch (e) {}
  }
}
