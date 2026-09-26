/**
 * Server Middleware for Adaptive Prediction Arena
 * Connects Vite dev server and standalone HTTP server to Arena API routes.
 */

import { globalPredictionArena } from '../arena/predictionArena.ts';
import { ArenaRouteHandler } from './arenaRoute.ts';
import { FlyRouteHandler } from './flyRoute.ts';
import { handleGetPrediction } from './predictionRoute.ts';

export function createArenaMiddleware() {
  globalPredictionArena.initialize();

  return async function arenaMiddleware(req: any, res: any, next: any) {
    const url = req.url || '';
    if (url === '/api/time' || url.startsWith('/api/time?') || url.startsWith('/api/time/')) {
      res.statusCode = 200;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      return res.end(JSON.stringify({ serverTimeMs: Date.now() }));
    }

    if (!url.startsWith('/api/prediction') && !url.startsWith('/api/web-proxy')) {
      return next();
    }

    try {
      const parsedUrl = new URL(url, 'http://localhost');
      const pathname = parsedUrl.pathname;
      const searchParams = Object.fromEntries(parsedUrl.searchParams.entries());

      // Web Proxy for Embedding Third-Party Betting Sites without X-Frame-Options block
      if (pathname === '/api/prediction/proxy' || pathname === '/api/web-proxy') {
        const targetUrl = searchParams.url || 'https://dhaniwin99.com';
        try {
          const proxyResp = await fetch(targetUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
          });
          const contentType = proxyResp.headers.get('content-type') || 'text/html';
          res.setHeader('Content-Type', contentType);
          res.setHeader('Access-Control-Allow-Origin', '*');

          if (contentType.includes('text/html')) {
            let html = await proxyResp.text();
            const baseTag = `<base href="${targetUrl}">`;
            if (html.includes('<head>')) {
              html = html.replace('<head>', `<head>${baseTag}`);
            } else {
              html = baseTag + html;
            }
            return res.end(html);
          } else {
            const buffer = await proxyResp.arrayBuffer();
            return res.end(Buffer.from(buffer));
          }
        } catch (fetchErr: any) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'text/html');
          return res.end(`
            <div style="color:#f43f5e;background:#111;padding:24px;font-family:sans-serif;border-radius:16px;text-align:center;">
              <h3 style="margin-bottom:8px;">Mirror Connection Notice</h3>
              <p style="color:#94a3b8;font-size:12px;margin-bottom:16px;">Direct iframe blocked by target host: ${targetUrl}</p>
              <a href="${targetUrl}" target="_blank" style="display:inline-block;padding:10px 20px;background:linear-gradient(135deg,#0284c7,#4f46e5);color:#fff;border-radius:10px;text-decoration:none;font-weight:bold;font-size:12px;">Open in App Popout Window ↗</a>
            </div>
          `);
        }
      }

      // Fly Sub-Arena Routes: /api/prediction/arena/fly/*
      if (pathname === '/api/prediction/arena/fly' || pathname === '/api/prediction/arena/fly/') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(FlyRouteHandler.getFlyOverview()));
      }
      if (pathname === '/api/prediction/arena/fly/ranking') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(FlyRouteHandler.getFlyRanking()));
      }
      if (pathname === '/api/prediction/arena/fly/champion') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(FlyRouteHandler.getFlyChampion()));
      }
      if (pathname === '/api/prediction/arena/fly/consensus') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(FlyRouteHandler.getFlyConsensus()));
      }
      if (pathname === '/api/prediction/arena/fly/diversity') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(FlyRouteHandler.getFlyDiversity()));
      }
      if (pathname === '/api/prediction/arena/fly/autopsy') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(FlyRouteHandler.getFlyAutopsies(searchParams.flyId)));
      }
      if (pathname.startsWith('/api/prediction/arena/fly/')) {
        const sub = pathname.replace('/api/prediction/arena/fly/', '').trim();
        const parts = sub.split('/');
        const flyId = parts[0];
        const subAction = parts[1];

        res.setHeader('Content-Type', 'application/json');
        if (subAction === 'history') {
          return res.end(JSON.stringify(FlyRouteHandler.getFlyHistory(flyId)));
        } else if (subAction === 'health') {
          return res.end(JSON.stringify(FlyRouteHandler.getFlyHealth(flyId)));
        } else {
          return res.end(JSON.stringify(FlyRouteHandler.getFlyModelDetails(flyId)));
        }
      }

      // 1. GET /api/prediction/arena/ranking
      if (pathname === '/api/prediction/arena/ranking') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(ArenaRouteHandler.getRanking()));
      }

      // 2. GET /api/prediction/arena/history
      if (pathname === '/api/prediction/arena/history') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(ArenaRouteHandler.getHistory()));
      }

      // 3. GET /api/prediction/arena/health
      if (pathname === '/api/prediction/arena/health') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(ArenaRouteHandler.getHealth()));
      }

      // 4. GET /api/prediction/arena/champion
      if (pathname === '/api/prediction/arena/champion') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(ArenaRouteHandler.getChampion()));
      }

      // 5. GET /api/prediction/arena/regime
      if (pathname === '/api/prediction/arena/regime') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(ArenaRouteHandler.getRegime()));
      }

      // 6. GET /api/prediction/arena/autopsy
      if (pathname === '/api/prediction/arena/autopsy') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(ArenaRouteHandler.getAutopsy(searchParams.roundId)));
      }

      // 7. GET /api/prediction/arena/:expertId
      if (pathname.startsWith('/api/prediction/arena/') && pathname !== '/api/prediction/arena') {
        const expertId = pathname.replace('/api/prediction/arena/', '').trim();
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(ArenaRouteHandler.getExpertDetails(expertId)));
      }

      // 8. GET /api/prediction/arena (Overview)
      if (pathname === '/api/prediction/arena') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(ArenaRouteHandler.getArenaOverview()));
      }

      // 9. GET /api/prediction (Base / Active Prediction)
      if (pathname === '/api/prediction') {
        const payload = await handleGetPrediction(searchParams);
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(payload));
      }

      next();
    } catch (err: any) {
      console.error('[ArenaMiddleware] Error handling API request:', err);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err?.message || 'Internal Arena Error' }));
    }
  };
}
