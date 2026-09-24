import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function arenaApiPlugin() {
  return {
    name: 'arena-api-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || (!req.url.startsWith('/api/prediction') && !req.url.startsWith('/api/web-proxy'))) {
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
    cors: true,
    proxy: {
      '/api-wingo': {
        target: 'https://draw.ar-lottery01.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-wingo/, ''),
        secure: false,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Referer': 'https://dhaniwin0.com/',
          'Origin': 'https://dhaniwin0.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*'
        }
      }
    }
  }
})
