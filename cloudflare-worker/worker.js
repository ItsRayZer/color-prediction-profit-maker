/**
 * Cloudflare Edge Worker for WinGo 24/7 Universal Sync
 * ====================================================
 * 1. Bypasses all ISP, DNS, and carrier firewall blocks.
 * 2. Emits CORS headers (Access-Control-Allow-Origin: *).
 * 3. Supports HTTP API: /api/wingo?tf=30s|1m|3m|5m
 * 4. Runs scheduled cron to push to Firebase Realtime Database 24/7.
 */

const RTDB_BASE = 'https://zer0one-376d1-default-rtdb.asia-southeast1.firebasedatabase.app';
let cachedFirebaseToken = null;
let cachedFirebaseTokenExpiresAt = 0;

function base64Url(bytesOrString) {
  const bytes = typeof bytesOrString === 'string' ? new TextEncoder().encode(bytesOrString) : bytesOrString;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getFirebaseDatabaseAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedFirebaseToken && cachedFirebaseTokenExpiresAt - now > 60) return cachedFirebaseToken;
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON secret is not configured');
  }

  const credentials = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('Service account secret is missing client_email or private_key');
  }
  const assertionBody = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }))}`;
  const pem = credentials.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const keyBytes = Uint8Array.from(atob(pem), char => char.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(assertionBody));
  const assertion = `${assertionBody}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!response.ok) throw new Error(`OAuth token request failed: HTTP ${response.status}`);
  const tokenResponse = await response.json();
  cachedFirebaseToken = tokenResponse.access_token;
  cachedFirebaseTokenExpiresAt = now + Number(tokenResponse.expires_in || 3600);
  return cachedFirebaseToken;
}

const TIMEFRAMES = {
  '30s': { code: '10005', url: 'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1' },
  '1m':  { code: '10001', url: 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageNo=1' },
  '3m':  { code: '10002', url: 'https://draw.ar-lottery01.com/WinGo/WinGo_3M/GetHistoryIssuePage.json?pageNo=1' },
  '5m':  { code: '10003', url: 'https://draw.ar-lottery01.com/WinGo/WinGo_5M/GetHistoryIssuePage.json?pageNo=1' }
};

function parseRounds(rawList, expectedCode) {
  if (!Array.isArray(rawList)) return [];
  return rawList.slice(0, 50).map(row => {
    const period = String(row.issueNumber || row.issue || row.period || row.expect || '');
    const n = parseInt(row.number !== undefined ? row.number : (row.openNumber !== undefined ? row.openNumber : row.code || 0), 10);
    const size = row.size || (n >= 5 ? 'BIG' : 'SMALL');
    const color = row.color || (n === 0 ? 'red,violet' : n === 5 ? 'green,violet' : [1,3,7,9].includes(n) ? 'green' : 'red');
    return { period, number: n, size, color };
  })
  .filter(r => r.period && !isNaN(r.number) && (!expectedCode || r.period.includes(expectedCode)))
  .sort((a, b) => String(a.period).localeCompare(String(b.period)));
}

async function fetchTimeframeFromUpstream(tfKey) {
  const tfConfig = TIMEFRAMES[tfKey] || TIMEFRAMES['30s'];
  const resp = await fetch(tfConfig.url, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://dhaniwin0.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (!resp.ok) {
    throw new Error(`Upstream HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const list = data.data?.list || [];
  return parseRounds(list, tfConfig.code);
}

async function syncToFirebase(tfKey, rounds, env) {
  if (!rounds || !rounds.length) return false;
  let accessToken;
  try {
    accessToken = await getFirebaseDatabaseAccessToken(env);
  } catch (error) {
    console.error(`[Firebase Sync] ${error.message}`);
    return false;
  }
  const putUrl = `${RTDB_BASE}/live_history/${tfKey}.json`;
  const res = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(rounds)
  });
  return res.ok;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    const tf = url.searchParams.get('tf') || '30s';

    if (url.pathname === '/api/wingo' || url.pathname === '/api-wingo') {
      try {
        const rounds = await fetchTimeframeFromUpstream(tf);
        // Asynchronously replicate to Firebase RTDB in background
        ctx.waitUntil(syncToFirebase(tf, rounds, env));

        return new Response(JSON.stringify({ success: true, tf, count: rounds.length, data: rounds }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=1'
          }
        });
      } catch (err) {
        // Fallback to reading from Firebase RTDB directly
        try {
          const fbResp = await fetch(`${RTDB_BASE}/live_history/${tf}.json`);
          const fbData = await fbResp.json();
          return new Response(JSON.stringify({ success: true, tf, fromCache: true, data: fbData }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=2'
            }
          });
        } catch(fbErr) {
          return new Response(JSON.stringify({ error: err.message }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      }
    }

    // Pattern Intelligence Cloud Sync Endpoint
    if (url.pathname === '/api/pattern/sync' && request.method === 'POST') {
      try {
        const body = await request.json();
        const batch = Array.isArray(body?.batch) ? body.batch : [];
        let validCount = 0;

        for (const item of batch) {
          if (!item.patternId || !item.fingerprint || !item.type || !item.interval) continue;
          validCount++;
        }

        // Asynchronously persist deltas to Firebase RTDB in background
        if (validCount > 0) {
          ctx.waitUntil((async () => {
            try {
              const accessToken = await getFirebaseDatabaseAccessToken(env);
              for (const item of batch) {
                const patTf = item.interval || '30s';
                const putUrl = `${RTDB_BASE}/patterns/${patTf}/${item.patternId}.json`;
                await fetch(putUrl, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
                  body: JSON.stringify({
                    patternId: item.patternId,
                    fingerprint: item.fingerprint,
                    type: item.type,
                    interval: item.interval,
                    length: item.length,
                    normalizedSequence: item.normalizedSequence,
                    lastSyncedAt: Date.now()
                  })
                });
              }
            } catch (syncErr) {
              console.error('[Pattern Sync Worker Error]', syncErr);
            }
          })());
        }

        return new Response(JSON.stringify({ success: true, count: validCount }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Pattern Registry Fetch Endpoint
    if (url.pathname === '/api/pattern/registry') {
      try {
        const fbResp = await fetch(`${RTDB_BASE}/patterns/${tf}.json`);
        const data = await fbResp.json();
        return new Response(JSON.stringify({ success: true, tf, patterns: data || {} }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=5'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: true, tf, patterns: {} }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    return new Response(JSON.stringify({ status: 'ok', service: 'WinGo Cloudflare Edge Proxy' }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  },

  // Scheduled Cron Trigger (Runs every minute in Cloudflare)
  async scheduled(event, env, ctx) {
    for (const tf of ['30s', '1m', '3m', '5m']) {
      try {
        const rounds = await fetchTimeframeFromUpstream(tf);
        await syncToFirebase(tf, rounds, env);
      } catch(e) {}
    }
  }
};
