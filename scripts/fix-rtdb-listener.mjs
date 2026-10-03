import fs from 'node:fs';

const filePath = 'index.html';
let c = fs.readFileSync(filePath, 'utf8');

// Fix 1: Make the RTDB history listener handle both array and object-with-numeric-keys
const oldPattern = `onValue(histRef, (snapshot) => {
            const val = snapshot.val();
            if (Array.isArray(val) && val.length > 0) {
              window._pendingCloudHistory = window._pendingCloudHistory || {};
              window._pendingCloudHistory[tfKey] = val;
              if (typeof window.applyCloudHistory === 'function') {
                window.applyCloudHistory(tfKey, val);
              } else if (typeof window.fetchLiveAPIResults === 'function') {
                window.fetchLiveAPIResults(tfKey).catch(() => {});
              }
            }
          });`;

const newPattern = `onValue(histRef, (snapshot) => {
            const raw = snapshot.val();
            // Firebase RTDB may return an array OR an object with numeric keys
            let val = null;
            if (Array.isArray(raw) && raw.length > 0) {
              val = raw.filter(Boolean);
            } else if (raw && typeof raw === 'object') {
              val = Object.values(raw).filter(v => v && typeof v === 'object');
            }
            if (val && val.length > 0) {
              window._pendingCloudHistory = window._pendingCloudHistory || {};
              window._pendingCloudHistory[tfKey] = val;
              if (typeof window.applyCloudHistory === 'function') {
                window.applyCloudHistory(tfKey, val);
              } else if (typeof window.fetchLiveAPIResults === 'function') {
                window.fetchLiveAPIResults(tfKey).catch(() => {});
              }
            }
          });`;

if (c.includes(oldPattern)) {
  c = c.replace(oldPattern, newPattern);
  console.log('✅ Fix 1: Patched RTDB history listener to handle array AND object types');
} else {
  console.log('⚠️  Fix 1: Pattern not found exactly - checking manually...');
  const idx = c.indexOf('onValue(histRef');
  if (idx >= 0) {
    console.log('Found onValue(histRef at:', idx);
    const chunk = c.substring(idx, idx + 600);
    console.log('Chunk:', chunk);
  }
}

// Fix 2: Also ensure applyCloudHistory handles object-keyed data from RTDB  
const oldApplyCheck = `  if (!Array.isArray(historyList) || historyList.length === 0) return;`;
const newApplyCheck = `  // Handle both array and object-with-numeric-keys from Firebase RTDB
  if (historyList && !Array.isArray(historyList) && typeof historyList === 'object') {
    historyList = Object.values(historyList).filter(v => v && typeof v === 'object');
  }
  if (!Array.isArray(historyList) || historyList.length === 0) return;`;

if (c.includes(oldApplyCheck)) {
  c = c.replace(oldApplyCheck, newApplyCheck);
  console.log('✅ Fix 2: Patched applyCloudHistory to normalize RTDB object to array');
} else {
  console.log('⚠️  Fix 2: applyCloudHistory check pattern not found');
}

fs.writeFileSync(filePath, c);
console.log('✅ Saved index.html');
