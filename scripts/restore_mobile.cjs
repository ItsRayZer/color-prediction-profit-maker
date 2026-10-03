// restore_mobile.cjs - Downloads the live mobile.js from Firebase hosting
const https = require('https');
const fs = require('fs');
const path = require('path');

const url = 'https://zer0ne.web.app/mobile.js';
const dest = path.join(__dirname, '..', 'mobile.js');

console.log('Downloading', url, '...');
const file = fs.createWriteStream(dest);
https.get(url, (res) => {
  console.log('Status:', res.statusCode, 'Content-Type:', res.headers['content-type']);
  res.pipe(file);
  file.on('finish', () => {
    file.close();
    const sz = fs.statSync(dest).size;
    console.log('Done. Saved to', dest, '- Size:', sz, 'bytes');
    if (sz < 1000) {
      console.error('ERROR: File is too small - likely got HTML redirect, not JS!');
      console.log('Content:', fs.readFileSync(dest, 'utf8').substring(0, 200));
    }
  });
}).on('error', (err) => {
  fs.unlink(dest, () => {});
  console.error('Download error:', err.message);
});
