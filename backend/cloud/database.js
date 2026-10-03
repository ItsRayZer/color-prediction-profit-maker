/**
 * Authoritative Permanent Cloud History Database
 * ==============================================
 * High-performance, zero-latency SQLite storage using Node's native DatabaseSync.
 * Stores 100% permanent history, raw source events, model states,
 * server model statistics, and user session statistics.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export class CloudDatabase {
  constructor(dbPath = 'data/prediction_cloud.db') {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.initPragmas();
    this.initSchema();
  }

  initPragmas() {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        interval TEXT NOT NULL,
        period TEXT NOT NULL,
        number INTEGER NOT NULL,
        color TEXT NOT NULL,
        size TEXT NOT NULL,
        source_timestamp TEXT,
        received_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        ai_target TEXT,
        ai_type TEXT,
        ai_model TEXT,
        ai_correct INTEGER,
        ai_confidence INTEGER,
        result TEXT,
        UNIQUE(source, interval, period)
      );

      CREATE INDEX IF NOT EXISTS idx_rounds_interval_period ON rounds(interval, period DESC);

      CREATE TABLE IF NOT EXISTS raw_source_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        interval TEXT NOT NULL,
        payload TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cat TEXT NOT NULL,
        arch TEXT,
        desc TEXT,
        pred_type TEXT NOT NULL,
        version TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_states (
        model_id TEXT NOT NULL,
        interval TEXT NOT NULL,
        streak INTEGER NOT NULL DEFAULT 0,
        best_streak INTEGER NOT NULL DEFAULT 0,
        dopamine REAL NOT NULL DEFAULT 0.5,
        loss_pain REAL NOT NULL DEFAULT 0.0,
        history_path TEXT NOT NULL DEFAULT '[]',
        custom_state TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(model_id, interval)
      );

      CREATE TABLE IF NOT EXISTS model_server_stats (
        model_id TEXT NOT NULL,
        interval TEXT NOT NULL,
        total_evaluated INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        win_rate REAL NOT NULL DEFAULT 0.0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(model_id, interval)
      );

      CREATE TABLE IF NOT EXISTS user_sessions (
        session_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        incharge_a_id TEXT
      );

      CREATE TABLE IF NOT EXISTS user_session_stats (
        session_id TEXT NOT NULL,
        interval TEXT NOT NULL,
        model_id TEXT NOT NULL,
        total_evaluated INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        win_rate REAL NOT NULL DEFAULT 0.0,
        streak INTEGER NOT NULL DEFAULT 0,
        best_streak INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, interval, model_id)
      );

      CREATE TABLE IF NOT EXISTS service_state (
        interval TEXT PRIMARY KEY,
        latest_period TEXT,
        latest_number INTEGER,
        latest_size TEXT,
        latest_color TEXT,
        service_target TEXT,
        service_type TEXT,
        service_model_id TEXT,
        service_model_name TEXT,
        service_confidence INTEGER,
        service_win_rate REAL,
        service_streak INTEGER,
        target_period TEXT,
        target TEXT,
        target_type TEXT,
        target_color TEXT,
        target_size TEXT,
        target_num INTEGER,
        target_confidence INTEGER,
        round_start INTEGER,
        round_end INTEGER,
        last_source_timestamp INTEGER,
        last_processed_at INTEGER,
        processing_status TEXT,
        leaderboard_json TEXT
      );

      CREATE TABLE IF NOT EXISTS system_health (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        interval TEXT NOT NULL,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        details TEXT,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_health_lookup ON system_health(interval, metric, timestamp DESC);
    `);
  }

  // ── Round Storage & Deduplication ──
  insertRound(round) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO rounds (
        source, interval, period, number, color, size,
        source_timestamp, received_at, created_at,
        ai_target, ai_type, ai_model, ai_correct, ai_confidence, result
      ) VALUES (
        $source, $interval, $period, $number, $color, $size,
        $source_timestamp, $received_at, $created_at,
        $ai_target, $ai_type, $ai_model, $ai_correct, $ai_confidence, $result
      )
    `);
    const now = Date.now();
    const result = stmt.run({
      $source: round.source || 'ar-lottery',
      $interval: round.interval,
      $period: String(round.period),
      $number: Number(round.number),
      $color: String(round.color),
      $size: String(round.size),
      $source_timestamp: round.source_timestamp || null,
      $received_at: round.received_at || now,
      $created_at: now,
      $ai_target: round.ai_target || null,
      $ai_type: round.ai_type || null,
      $ai_model: round.ai_model || null,
      $ai_correct: round.ai_correct !== undefined && round.ai_correct !== null ? (round.ai_correct ? 1 : 0) : null,
      $ai_confidence: round.ai_confidence || null,
      $result: round.result || null
    });
    return result.changes > 0;
  }

  updateRoundPrediction(interval, period, prediction) {
    const stmt = this.db.prepare(`
      UPDATE rounds
      SET ai_target = $ai_target,
          ai_type = $ai_type,
          ai_model = $ai_model,
          ai_correct = $ai_correct,
          ai_confidence = $ai_confidence,
          result = $result
      WHERE interval = $interval AND period = $period
    `);
    stmt.run({
      $interval: interval,
      $period: String(period),
      $ai_target: prediction.target || null,
      $ai_type: prediction.type || null,
      $ai_model: prediction.modelName || null,
      $ai_correct: prediction.correct !== undefined && prediction.correct !== null ? (prediction.correct ? 1 : 0) : null,
      $ai_confidence: prediction.confidence || null,
      $result: prediction.result || (prediction.correct ? 'WIN' : 'LOSS')
    });
  }

  hasRound(interval, period) {
    const stmt = this.db.prepare(`
      SELECT 1 FROM rounds WHERE interval = $interval AND period = $period LIMIT 1
    `);
    return !!stmt.get({ $interval: interval, $period: String(period) });
  }

  getLatestRound(interval) {
    const stmt = this.db.prepare(`
      SELECT * FROM rounds WHERE interval = $interval ORDER BY period DESC LIMIT 1
    `);
    return stmt.get({ $interval: interval }) || null;
  }

  getPaginatedHistory(interval, page = 1, limit = 50) {
    const offset = Math.max(0, (page - 1) * limit);
    const countStmt = this.db.prepare(`
      SELECT COUNT(*) as total FROM rounds WHERE interval = $interval
    `);
    const totalRow = countStmt.get({ $interval: interval });
    const total = totalRow ? totalRow.total : 0;

    const stmt = this.db.prepare(`
      SELECT * FROM rounds
      WHERE interval = $interval
      ORDER BY period DESC
      LIMIT $limit OFFSET $offset
    `);
    const rows = stmt.all({ $interval: interval, $limit: limit, $offset: offset });
    return {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      records: rows
    };
  }

  getAllChronologicalHistory(interval) {
    const stmt = this.db.prepare(`
      SELECT * FROM rounds WHERE interval = $interval ORDER BY period ASC
    `);
    return stmt.all({ $interval: interval });
  }

  // ── 24-Hour Rolling History Window ──
  get24HourRollingHistory(interval) {
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    const stmt = this.db.prepare(`
      SELECT * FROM rounds
      WHERE interval = $interval AND created_at >= $cutoff
      ORDER BY period ASC
    `);
    let rows = stmt.all({ $interval: interval, $cutoff: twentyFourHoursAgo });

    // Fallback: If database is new/seeded without created_at timestamps, return last 24h capacity
    if (!rows || rows.length < 50) {
      const maxPeriods = interval === '30s' ? 2880 : interval === '1m' ? 1440 : interval === '3m' ? 480 : 288;
      const fallbackStmt = this.db.prepare(`
        SELECT * FROM (
          SELECT * FROM rounds WHERE interval = $interval ORDER BY period DESC LIMIT $limit
        ) ORDER BY period ASC
      `);
      rows = fallbackStmt.all({ $interval: interval, $limit: maxPeriods });
    }
    return rows;
  }

  // Prune expired records outside the active window to archive if needed
  pruneExpiredHistory(interval, retentionHours = 24) {
    const cutoff = Date.now() - (retentionHours * 60 * 60 * 1000);
    const stmt = this.db.prepare(`
      DELETE FROM rounds WHERE interval = $interval AND created_at < $cutoff
    `);
    const res = stmt.run({ $interval: interval, $cutoff: cutoff });
    return res.changes;
  }

  saveRawEvent(source, interval, payload) {
    const stmt = this.db.prepare(`
      INSERT INTO raw_source_events (source, interval, payload, received_at)
      VALUES ($source, $interval, $payload, $received_at)
    `);
    stmt.run({
      $source: source,
      $interval: interval,
      $payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      $received_at: Date.now()
    });
  }

  // ── Model Registration & State Persistence ──
  registerModel(model) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO models (id, name, cat, arch, desc, pred_type, version, created_at)
      VALUES ($id, $name, $cat, $arch, $desc, $pred_type, $version, $created_at)
    `);
    stmt.run({
      $id: model.id,
      $name: model.name,
      $cat: model.cat || 'general',
      $arch: model.arch || '',
      $desc: model.desc || '',
      $pred_type: model.predType || 'SIZE',
      $version: model.version || '1.0.0',
      $created_at: Date.now()
    });
  }

  getAllModels() {
    const stmt = this.db.prepare(`SELECT * FROM models ORDER BY cat, id`);
    return stmt.all();
  }

  getModelState(modelId, interval) {
    const stmt = this.db.prepare(`
      SELECT * FROM model_states WHERE model_id = $model_id AND interval = $interval
    `);
    return stmt.get({ $model_id: modelId, $interval: interval }) || null;
  }

  saveModelState(modelId, interval, state) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO model_states (
        model_id, interval, streak, best_streak, dopamine, loss_pain, history_path, custom_state, updated_at
      ) VALUES (
        $model_id, $interval, $streak, $best_streak, $dopamine, $loss_pain, $history_path, $custom_state, $updated_at
      )
    `);
    stmt.run({
      $model_id: modelId,
      $interval: interval,
      $streak: Number(state.streak || 0),
      $best_streak: Number(state.bestStreak || 0),
      $dopamine: Number(state.dopamine !== undefined ? state.dopamine : 0.5),
      $loss_pain: Number(state.lossPain !== undefined ? state.lossPain : 0.0),
      $history_path: JSON.stringify(state.historyPath || []),
      $custom_state: state.customState ? JSON.stringify(state.customState) : null,
      $updated_at: Date.now()
    });
  }

  getModelServerStats(modelId, interval) {
    const stmt = this.db.prepare(`
      SELECT * FROM model_server_stats WHERE model_id = $model_id AND interval = $interval
    `);
    return stmt.get({ $model_id: modelId, $interval: interval }) || null;
  }

  getAllServerStats(interval) {
    const stmt = this.db.prepare(`
      SELECT s.*, m.name, m.cat, m.arch, m.desc, m.pred_type, st.streak, st.best_streak, st.dopamine, st.loss_pain, st.history_path
      FROM model_server_stats s
      JOIN models m ON m.id = s.model_id
      LEFT JOIN model_states st ON st.model_id = s.model_id AND st.interval = s.interval
      WHERE s.interval = $interval
      ORDER BY s.win_rate DESC, s.total_evaluated DESC
    `);
    return stmt.all({ $interval: interval });
  }

  saveModelServerStats(modelId, interval, stats) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO model_server_stats (
        model_id, interval, total_evaluated, wins, losses, win_rate, updated_at
      ) VALUES (
        $model_id, $interval, $total_evaluated, $wins, $losses, $win_rate, $updated_at
      )
    `);
    stmt.run({
      $model_id: modelId,
      $interval: interval,
      $total_evaluated: Number(stats.totalEvaluated || 0),
      $wins: Number(stats.wins || 0),
      $losses: Number(stats.losses || 0),
      $win_rate: Number(stats.winRate || 0.0),
      $updated_at: Date.now()
    });
  }

  // ── User Session Statistics & Reset ──
  getOrCreateUserSession(sessionId) {
    let stmt = this.db.prepare(`SELECT * FROM user_sessions WHERE session_id = $session_id`);
    let session = stmt.get({ $session_id: sessionId });
    const now = Date.now();
    if (!session) {
      this.db.prepare(`
        INSERT INTO user_sessions (session_id, started_at, last_active_at)
        VALUES ($session_id, $started_at, $last_active_at)
      `).run({
        $session_id: sessionId,
        $started_at: now,
        $last_active_at: now
      });
      session = { session_id: sessionId, started_at: now, last_active_at: now, incharge_a_id: null };
    } else {
      this.db.prepare(`UPDATE user_sessions SET last_active_at = $now WHERE session_id = $session_id`).run({
        $now: now,
        $session_id: sessionId
      });
    }
    return session;
  }

  resetUserSession(sessionId) {
    const now = Date.now();
    // 1. Delete session stats
    this.db.prepare(`DELETE FROM user_session_stats WHERE session_id = $session_id`).run({ $session_id: sessionId });
    // 2. Update session start time
    this.db.prepare(`UPDATE user_sessions SET started_at = $now, incharge_a_id = NULL WHERE session_id = $session_id`).run({
      $now: now,
      $session_id: sessionId
    });
    return { sessionId, resetAt: now };
  }

  getUserSessionStats(sessionId, interval) {
    const stmt = this.db.prepare(`
      SELECT s.*, m.name, m.cat, m.arch, m.desc, m.pred_type
      FROM user_session_stats s
      LEFT JOIN models m ON m.id = s.model_id
      WHERE s.session_id = $session_id AND s.interval = $interval
      ORDER BY s.win_rate DESC, s.total_evaluated DESC
    `);
    return stmt.all({ $session_id: sessionId, $interval: interval });
  }

  saveUserSessionStat(sessionId, interval, modelId, stats) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO user_session_stats (
        session_id, interval, model_id, total_evaluated, wins, losses, win_rate, streak, best_streak, updated_at
      ) VALUES (
        $session_id, $interval, $model_id, $total_evaluated, $wins, $losses, $win_rate, $streak, $best_streak, $updated_at
      )
    `);
    stmt.run({
      $session_id: sessionId,
      $interval: interval,
      $model_id: modelId,
      $total_evaluated: Number(stats.totalEvaluated || 0),
      $wins: Number(stats.wins || 0),
      $losses: Number(stats.losses || 0),
      $win_rate: Number(stats.winRate || 0.0),
      $streak: Number(stats.streak || 0),
      $best_streak: Number(stats.bestStreak || 0),
      $updated_at: Date.now()
    });
  }

  // ── Global Service State ──
  getServiceState(interval) {
    const stmt = this.db.prepare(`SELECT * FROM service_state WHERE interval = $interval`);
    const row = stmt.get({ $interval: interval });
    if (row && row.leaderboard_json) {
      try { row.leaderboard = JSON.parse(row.leaderboard_json); } catch (e) { row.leaderboard = []; }
    }
    return row || null;
  }

  saveServiceState(interval, state) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO service_state (
        interval, latest_period, latest_number, latest_size, latest_color,
        service_target, service_type, service_model_id, service_model_name, service_confidence,
        service_win_rate, service_streak, target_period, target, target_type,
        target_color, target_size, target_num, target_confidence,
        round_start, round_end, last_source_timestamp, last_processed_at,
        processing_status, leaderboard_json
      ) VALUES (
        $interval, $latest_period, $latest_number, $latest_size, $latest_color,
        $service_target, $service_type, $service_model_id, $service_model_name, $service_confidence,
        $service_win_rate, $service_streak, $target_period, $target, $target_type,
        $target_color, $target_size, $target_num, $target_confidence,
        $round_start, $round_end, $last_source_timestamp, $last_processed_at,
        $processing_status, $leaderboard_json
      )
    `);
    stmt.run({
      $interval: interval,
      $latest_period: state.latestPeriod ? String(state.latestPeriod) : null,
      $latest_number: state.latestNumber !== undefined ? Number(state.latestNumber) : null,
      $latest_size: state.latestSize || null,
      $latest_color: state.latestColor || null,
      $service_target: state.serviceTarget || null,
      $service_type: state.serviceType || null,
      $service_model_id: state.serviceModelId || null,
      $service_model_name: state.serviceModelName || null,
      $service_confidence: state.serviceConfidence || null,
      $service_win_rate: state.serviceWinRate || null,
      $service_streak: state.serviceStreak || null,
      $target_period: state.targetPeriod ? String(state.targetPeriod) : null,
      $target: state.target || null,
      $target_type: state.targetType || null,
      $target_color: state.targetColor || null,
      $target_size: state.targetSize || null,
      $target_num: state.targetNum !== undefined ? Number(state.targetNum) : null,
      $target_confidence: state.targetConfidence || null,
      $round_start: state.roundStart || null,
      $round_end: state.roundEnd || null,
      $last_source_timestamp: state.lastSourceTimestamp || null,
      $last_processed_at: state.lastProcessedAt || Date.now(),
      $processing_status: state.processingStatus || 'healthy',
      $leaderboard_json: state.leaderboard ? JSON.stringify(state.leaderboard) : null
    });
  }

  // ── Observability & Health Tracking ──
  recordHealthMetric(interval, metric, value, details = null) {
    const stmt = this.db.prepare(`
      INSERT INTO system_health (interval, metric, value, details, timestamp)
      VALUES ($interval, $metric, $value, $details, $timestamp)
    `);
    stmt.run({
      $interval: interval,
      $metric: metric,
      $value: Number(value),
      $details: details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
      $timestamp: Date.now()
    });
  }

  getHealthSummary(interval) {
    const metrics = ['ingestion_latency_ms', 'processing_latency_ms', 'missing_periods', 'duplicates'];
    const summary = {};
    for (const m of metrics) {
      const stmt = this.db.prepare(`
        SELECT value, timestamp, details FROM system_health
        WHERE interval = $interval AND metric = $metric
        ORDER BY timestamp DESC LIMIT 1
      `);
      summary[m] = stmt.get({ $interval: interval, $metric: m }) || null;
    }
    return summary;
  }

  close() {
    this.db.close();
  }
}
