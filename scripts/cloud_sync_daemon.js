/**
 * 24/7 Cloud WinGo Sync Daemon
 * ============================
 * Continuously polls upstream WinGo lottery feeds (30s, 1m, 3m, 5m)
 * and keeps Firebase Realtime Database (zer0one-376d1) synchronized in real-time.
 *
 * All clients connected to https://zer0ne.web.app subscribe to this feed
 * to receive instant, zero-latency round settlements and history updates.
 */

import { getFirebaseDatabaseAccessToken } from '../backend/cloud/firebaseAuth.js';

const RTDB_BASE = 'https://zer0one-376d1-default-rtdb.asia-southeast1.firebasedatabase.app';

const TIMEFRAMES = [
  { id: '30s', url: 'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1', intervalMs: 3000 },
  { id: '1m',  url: 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageNo=1',  intervalMs: 5000 },
  { id: '3m',  url: 'https://draw.ar-lottery01.com/WinGo/WinGo_3M/GetHistoryIssuePage.json?pageNo=1',  intervalMs: 10000 },
  { id: '5m',  url: 'https://draw.ar-lottery01.com/WinGo/WinGo_5M/GetHistoryIssuePage.json?pageNo=1',  intervalMs: 15000 }
];

const lastPeriodSeen = {};

function parseRounds(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList.slice(0, 50).reverse().map(row => {
    const period = String(row.issueNumber || row.issue || row.period || row.expect || '');
    const n = parseInt(row.number || row.openNumber || row.code || 0, 10);
    const size = row.size || (n >= 5 ? 'BIG' : 'SMALL');
    const color = row.color || (n === 0 ? 'red,violet' : n === 5 ? 'green,violet' : [1,3,7,9].includes(n) ? 'green' : 'red');
    return { period, number: n, size, color };
  }).filter(r => r.period && !isNaN(r.number));
}

async function syncTimeframe(tfConfig) {
  const { id, url } = tfConfig;
  try {
    const resp = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://dhaniwin0.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
      }
    });

    if (!resp.ok) return;

    const data = await resp.json();
    const rawList = data.data?.list || [];
    if (!rawList.length) return;

    const parsedList = parseRounds(rawList);
    if (!parsedList.length) return;

    const latest = parsedList[parsedList.length - 1];
    if (lastPeriodSeen[id] === latest.period) {
      // Period has not changed, skip redundant write to save bandwidth
      return;
    }

    lastPeriodSeen[id] = latest.period;
    console.log(`[${new Date().toISOString()}] [${id.toUpperCase()}] New Period Detected: ${latest.period} -> #${latest.number} (${latest.size}/${latest.color})`);

    // Write to Firebase Realtime Database
    const accessToken = await getFirebaseDatabaseAccessToken();
    if (!accessToken) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
    const putResp = await fetch(`${RTDB_BASE}/live_history/${id}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(parsedList)
    });

    if (putResp.ok) {
      console.log(`[${id.toUpperCase()}] Synced ${parsedList.length} rounds to Firebase RTDB.`);
    }
  } catch (err) {
    console.warn(`[${id.toUpperCase()}] Sync failed; next poll will retry: ${err.message}`);
  }
}

console.log('====================================================');
console.log('🚀 24/7 WinGo Cloud Sync Service Started');
console.log(`Target RTDB: ${RTDB_BASE}`);
console.log('Listening to timeframes: 30s, 1m, 3m, 5m');
console.log('====================================================');

// Initial sync on start
TIMEFRAMES.forEach(tf => {
  syncTimeframe(tf);
  setInterval(() => syncTimeframe(tf), tf.intervalMs);
});
