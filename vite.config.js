import dgram from 'node:dgram'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

let _serverClockSkewMs = 0;

function queryNtp(server = 'time.google.com') {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const req = Buffer.alloc(48);
    req[0] = 0x1B;
    const t0 = Date.now();

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { socket.close(); } catch(e) {}
        reject(new Error('NTP timeout'));
      }
    }, 2000);

    socket.on('message', (msg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const t1 = Date.now();
      const sec = msg.readUInt32BE(40) - 2208988800;
      const frac = msg.readUInt32BE(44);
      const serverMs = sec * 1000 + (frac * 1000) / 0x100000000;
      const rtt = t1 - t0;
      const midpoint = t0 + rtt / 2;
      const skew = Math.round(serverMs - midpoint);
      try { socket.close(); } catch(e) {}
      resolve(skew);
    });

    socket.on('error', (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        try { socket.close(); } catch(e) {}
        reject(err);
      }
    });

    socket.send(req, 0, req.length, 123, server);
  });
}

async function calibrateServerClock() {
  for (const ntpHost of ['time.google.com', 'time.cloudflare.com', 'pool.ntp.org']) {
    try {
      const skew = await queryNtp(ntpHost);
      _serverClockSkewMs = skew;
      return;
    } catch (e) {}
  }

  try {
    const t0 = Date.now();
    const headResp = await fetch('https://draw.ar-lottery01.com', { method: 'HEAD', cache: 'no-store' });
    const t1 = Date.now();
    const dateHdr = headResp.headers.get('date');
    if (dateHdr) {
      const serverEpoch = new Date(dateHdr).getTime();
      const rtt = t1 - t0;
      const trueNow = serverEpoch + 500;
      _serverClockSkewMs = Math.round(trueNow - (t0 + rtt / 2));
      return;
    }
  } catch (e) {}
}

calibrateServerClock();
setInterval(calibrateServerClock, 5 * 60 * 1000);

function arenaApiPlugin() {
  return {
    name: 'arena-api-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();

        // Lightweight Server Time Endpoint for Clock Synchronization
        if (req.url === '/api/time' || req.url.startsWith('/api/time?') || req.url.startsWith('/api/time/')) {
          res.statusCode = 200;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
          return res.end(JSON.stringify({ serverTimeMs: Date.now() + _serverClockSkewMs }));
        }

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
