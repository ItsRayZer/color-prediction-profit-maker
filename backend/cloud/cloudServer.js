/**
 * Cloud HTTP API & Realtime Server
 * =================================
 * Provides authoritative API endpoints and Realtime Event Streams (SSE) for thin-client browsers:
 * - GET /api/state?interval=30s&sessionId=...
 * - GET /api/history?interval=30s&page=1&limit=50
 * - POST /api/session/reset
 * - GET /api/models
 * - GET /api/health
 * - GET /api/events?interval=30s (Real-Time SSE)
 * - POST /api/admin/rebuild
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export class CloudServer {
  constructor(db, modelRegistry, inchargeController, ingestionService, rebuildEngine, options = {}) {
    this.db = db;
    this.modelRegistry = modelRegistry;
    this.inchargeController = inchargeController;
    this.ingestionService = ingestionService;
    this.rebuildEngine = rebuildEngine;
    this.port = options.port || 3001;

    this.sseClients = new Set();
    this.setupEventListener();
  }

  setupEventListener() {
    this.ingestionService.on('NEW_ROUND', (event) => {
      this.broadcastSSE(event);
    });
  }

  broadcastSSE(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      if (!client.interval || client.interval === event.interval) {
        try {
          client.res.write(payload);
        } catch (e) {
          this.sseClients.delete(client);
        }
      }
    }
  }

  createHandler() {
    return async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id, X-Admin-Token');

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        return res.end();
      }

      const parsedUrl = new URL(req.url, 'http://localhost');
      const pathname = parsedUrl.pathname;
      const query = Object.fromEntries(parsedUrl.searchParams.entries());
      const interval = query.interval || '30s';
      const sessionId = query.sessionId || req.headers['x-session-id'] || 'default-session';

      // ── 1. Lightweight Server Time ──
      if (pathname === '/api/time') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ serverTimeMs: Date.now() }));
      }

      // ── 2. Authoritative State (Incharge A + Incharge B) ──
      if (pathname === '/api/state') {
        res.setHeader('Content-Type', 'application/json');
        const serviceState = this.db.getServiceState(interval) || {};
        const pool = this.ingestionService.modelPools[interval] || [];

        // Incharge B (Server Service Incharge)
        const inchargeB = this.inchargeController.evaluateServiceIncharge(interval, pool, null, true);

        // Incharge A (User Session Incharge)
        const inchargeA = this.inchargeController.evaluateSessionIncharge(sessionId, interval, pool, null, true);

        // Session Stats
        const sessionStats = this.db.getUserSessionStats(sessionId, interval);

        return res.end(JSON.stringify({
          success: true,
          interval,
          sessionId,
          serverTimeMs: Date.now(),
          serviceIncharge: {
            id: inchargeB?.model?.id || serviceState.serviceModelId,
            name: inchargeB?.model?.name || serviceState.serviceModelName,
            winRate: inchargeB?.model?.winRate || serviceState.serviceWinRate || 0,
            winRatePct: inchargeB?.model?.winRatePct || ((serviceState.serviceWinRate || 0) * 100).toFixed(1) + '%',
            streak: inchargeB?.model?.streak !== undefined ? inchargeB.model.streak : serviceState.serviceStreak,
            predTarget: inchargeB?.model?.predTarget || serviceState.serviceTarget,
            predType: inchargeB?.model?.predType || serviceState.serviceType,
            reason: inchargeB?.reason || ''
          },
          sessionIncharge: {
            id: inchargeA?.model?.id || 'BASE_PREDICTOR',
            name: inchargeA?.model?.name || 'Base Quant Predictor',
            winRate: inchargeA?.model?.winRate || 0,
            winRatePct: inchargeA?.model?.winRatePct || '0.0%',
            streak: inchargeA?.model?.streak || 0,
            predTarget: inchargeA?.model?.predTarget || 'BIG',
            predType: inchargeA?.model?.predType || 'SIZE',
            reason: inchargeA?.reason || 'Session Default'
          },
          target: serviceState.target,
          targetPeriod: serviceState.targetPeriod,
          targetType: serviceState.targetType,
          targetColor: serviceState.targetColor,
          targetSize: serviceState.targetSize,
          targetNum: serviceState.targetNum,
          targetConfidence: serviceState.targetConfidence,
          roundStart: serviceState.roundStart,
          roundEnd: serviceState.roundEnd,
          leaderboard: serviceState.leaderboard || [],
          userSessionStats: sessionStats
        }));
      }

      // ── 3A. Initial 24-Hour History Window (Full Chronological Dataset) ──
      if (pathname === '/api/history/24h') {
        const history24h = this.db.get24HourRollingHistory(interval);
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({
          success: true,
          interval,
          count: history24h.length,
          serverTimeMs: Date.now(),
          records: history24h.map(r => ({
            period: r.period,
            number: r.number,
            size: r.size,
            color: r.color,
            sourceTimestamp: r.source_timestamp,
            receivedAt: r.received_at,
            createdAt: r.created_at,
            aiTarget: r.ai_target,
            aiType: r.ai_type,
            aiModel: r.ai_model,
            aiCorrect: r.ai_correct === 1,
            result: r.result
          }))
        }));
      }

      // ── 3B. Paginated History (With Pre-stamped Predictions) ──
      if (pathname === '/api/history') {
        const page = parseInt(query.page || '1', 10);
        const limit = parseInt(query.limit || '50', 10);
        const historyData = this.db.getPaginatedHistory(interval, page, limit);
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({
          success: true,
          interval,
          ...historyData
        }));
      }

      // ── 4. User Session Reset (Strictly isolates user reset from server stats) ──
      if (pathname === '/api/session/reset' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          let reqSessionId = sessionId;
          try {
            const data = JSON.parse(body);
            if (data.sessionId) reqSessionId = data.sessionId;
          } catch(e) {}

          const result = this.inchargeController.resetUserSession(reqSessionId);
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({
            success: true,
            message: 'User session statistics reset successfully. Global server statistics untouched.',
            session: result
          }));
        });
        return;
      }

      // ── 5. All Models & Server-Side All-Time Statistics ──
      if (pathname === '/api/models') {
        const allModels = this.modelRegistry.getAllModelDefinitions();
        const serverStats = this.db.getAllServerStats(interval);
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({
          success: true,
          interval,
          count: allModels.length,
          models: allModels,
          serverStats
        }));
      }

      // ── 6. Health & Latency Diagnostics ──
      if (pathname === '/api/health') {
        const summary = this.db.getHealthSummary(interval);
        const serviceState = this.db.getServiceState(interval);
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({
          status: 'healthy',
          interval,
          latestPeriod: serviceState?.latestPeriod,
          lastProcessedAt: serviceState?.lastProcessedAt,
          diagnostics: summary
        }));
      }

      // ── 7. Realtime SSE Stream ──
      if (pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
        res.write(`data: ${JSON.stringify({ type: 'CONNECTED', interval, serverTimeMs: Date.now() })}\n\n`);

        const client = { res, interval };
        this.sseClients.add(client);
        req.on('close', () => {
          this.sseClients.delete(client);
        });
        return;
      }

      // ── 8. Admin Rebuild Endpoint ──
      if (pathname === '/api/admin/rebuild' && req.method === 'POST') {
        const configuredToken = process.env.ADMIN_REBUILD_TOKEN || '';
        const suppliedToken = String(req.headers['x-admin-token'] || '');
        const configuredBytes = Buffer.from(configuredToken);
        const suppliedBytes = Buffer.from(suppliedToken);
        if (!configuredToken || configuredBytes.length !== suppliedBytes.length || !timingSafeEqual(configuredBytes, suppliedBytes)) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ error: 'Admin rebuild is disabled or unauthorized' }));
        }
        const modelId = query.modelId;
        let result;
        if (modelId) {
          result = await this.rebuildEngine.rebuildSingleModel(interval, modelId);
        } else {
          result = await this.rebuildEngine.rebuildAllModels(interval);
        }
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(result));
      }

      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Endpoint not found' }));
    };
  }

  start() {
    this.server = http.createServer(this.createHandler());
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`[CloudServer] 🌐 Server running at http://localhost:${this.port}`);
        resolve(this.server);
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}
