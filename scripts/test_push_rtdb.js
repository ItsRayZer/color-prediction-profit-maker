// Native fetch in Node 18+
import { getFirebaseDatabaseAccessToken } from '../backend/cloud/firebaseAuth.js';

const RTDB_URL = "https://zer0one-376d1-default-rtdb.asia-southeast1.firebasedatabase.app";
const LOTTERY_URL = "https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1";

async function syncOnce() {
  try {
    console.log('[Sync] Fetching from upstream lottery feed...');
    const resp = await fetch(LOTTERY_URL, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://dhaniwin0.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });
    
    if (!resp.ok) {
      throw new Error(`Upstream returned ${resp.status}`);
    }

    const data = await resp.json();
    const list = data.data?.list || [];
    if (!list.length) {
      console.log('[Sync] No rounds received.');
      return;
    }

    const parsedList = list.slice(0, 50).reverse().map(row => {
      const period = String(row.issueNumber || row.issue || row.period || row.expect || '');
      const n = parseInt(row.number || row.openNumber || row.code || 0, 10);
      const size = row.size || (n >= 5 ? 'BIG' : 'SMALL');
      const color = row.color || (n === 0 ? 'red,violet' : n === 5 ? 'green,violet' : [1,3,7,9].includes(n) ? 'green' : 'red');
      return { period, number: n, size, color };
    }).filter(r => r.period && !isNaN(r.number));

    console.log(`[Sync] Parsed ${parsedList.length} rounds. Latest period: ${parsedList[parsedList.length - 1]?.period}`);

    const accessToken = await getFirebaseDatabaseAccessToken();
    if (!accessToken) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
    const putResp = await fetch(`${RTDB_URL}/live_history/30s.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(parsedList)
    });

    if (putResp.ok) {
      console.log('[Sync] Successfully pushed history to Firebase Realtime Database!');
    } else {
      console.error('[Sync] Failed to push to RTDB:', putResp.status, await putResp.text());
    }
  } catch (err) {
    console.error('[Sync Error]:', err.message);
  }
}

syncOnce();
