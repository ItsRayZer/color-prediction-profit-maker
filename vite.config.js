import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function arenaApiPlugin() {
  return {
    name: 'arena-api-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();

        // Native High-Speed Proxy for WinGo Lottery API (bypasses node-http-proxy ECONNRESET)
        if (req.url.startsWith('/api-wingo')) {
          const upstreamPath = req.url.replace(/^\/api-wingo/, '');
          const targetUrl = 'https://draw.ar-lottery01.com' + upstreamPath;
          try {
            const resp = await fetch(targetUrl, {
              headers: {
                'Referer': 'https://dhaniwin0.com/',
                'Origin': 'https://dhaniwin0.com',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*'
              }
            });
            res.statusCode = resp.status;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json');
            const dateHdr = resp.headers.get('date');
            if (dateHdr) res.setHeader('Date', dateHdr);
            const body = await resp.text();
            return res.end(body);
          } catch (fetchErr) {
            console.error('[API Wingo Proxy Error]', fetchErr.message);
            res.statusCode = 502;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ error: fetchErr.message }));
          }
        }

        if (!req.url.startsWith('/api/prediction') && !req.url.startsWith('/api/web-proxy')) {
          return next();
        }
        try {
          const { createArenaMiddleware } = await import('./backend/api/serverMiddleware.ts');
          const middleware = createArenaMiddleware();
          return middleware(req, res, next);
        } catch (err) {
          console.error('[Vite Arena API] Error in middleware:', err);
          next(err);
        }
      });
    }
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), arenaApiPlugin()],
  server: {
    host: true,
    cors: true
  }
})
