import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const deployDir = path.join(rootDir, 'deploy');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Ensure deploy/ directory exists
if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir, { recursive: true });

console.log('[deploy-assets] Building deploy/ folder from source (NO Vite processing)...');

// CRITICAL: Copy index.html directly from source — NOT from dist
// Vite strips the <script type="module"> Firebase init block which breaks everything.
const srcHtml = path.join(rootDir, 'index.html');
const destHtml = path.join(deployDir, 'index.html');
fs.copyFileSync(srcHtml, destHtml);
console.log('Copied index.html -> deploy/index.html (source, unprocessed)');

// Copy static assets needed by index.html
// ('api' carries the Vercel twin of the Axo AI hop
// (api/axo-ai.mjs — .mjs is load-bearing for Vercel's ESM
// detection) into the preview project's rootDirectory;
// 'functions' carries the
// Cloudflare Pages production hop — functions/api/axo-ai.js +
// the shared core — into the uploaded tree.)
['systems', 'algorithms', 'src', 'sounds', 'api', 'functions'].forEach(dir => {
  const src = path.join(rootDir, dir);
  const dest = path.join(deployDir, dir);
  copyDirRecursive(src, dest);
  console.log(`Copied ${dir} -> deploy/${dir}`);
});

  // LOAD-BEARING — deploy/package.json declares the module system
  // for everything inside deploy/. Vercel's rootDirectory IS deploy/,
  // so the repo-root package.json's "type": "module" is invisible to
  // the function runtime. Without this file Vercel's builder compiled
  // the Axo hop's ESM core to CommonJS ("Compiling ... from ESM to
  // CommonJS...") and the live preview answered 500
  // FUNCTION_INVOCATION_FAILED on every /api/axo-ai call, even after
  // the twin was renamed to .mjs. Do NOT remove this file. It is
  // regenerated on every copy-assets run, so a stale or missing copy
  // is repaired by re-running this script. The file contains only
  // {"type": "module"} — no dependencies, no secrets, nothing served
  // that matters if a client fetches it.
  fs.writeFileSync(path.join(deployDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
  console.log('Generated deploy/package.json ({"type": "module"} — load-bearing for the Vercel function runtime)');

  // Copy individual files
  // 2026-10-24 rebase: 'axofy-theme.css' dropped from the copy list —
  // the rebased app is the owner's live app, which has no Axofy theme.
  ['terminal.html', 'dhaniwin-bridge.js', 'logo_0101.jpg', 'coffee_card.jpg', 'favicon.svg', 'mobile.html', 'mobile.css', 'mobile.js', 'settings.html', 'manifest.json', 'sw.js', '_headers'].forEach(file => {
    const src = path.join(rootDir, file);
    const dest = path.join(deployDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`Copied ${file} -> deploy/${file}`);
    }
  });

  // Tampermonkey install target (fix round #6): the SAME bridge bytes
  // under the .user.js name Tampermonkey detects for install-from-URL.
  // It is generated from dhaniwin-bridge.js on every run, so the two
  // files can never drift apart. Tampermonkey checks the install URL
  // for updates, so no @updateURL/@downloadURL tags are needed.
  {
    const src = path.join(rootDir, 'dhaniwin-bridge.js');
    const dest = path.join(deployDir, 'dhaniwin-bridge.user.js');
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log('Copied dhaniwin-bridge.js -> deploy/dhaniwin-bridge.user.js (Tampermonkey install target)');
    }
  }

  // Also copy worker to deploy root for universal worker path resolution
  const workerSrc = path.join(rootDir, 'src', 'workers', 'modelWorker.js');
  if (fs.existsSync(workerSrc)) {
    fs.copyFileSync(workerSrc, path.join(deployDir, 'modelWorker.js'));
    console.log('Copied src/workers/modelWorker.js -> deploy/modelWorker.js');
  }

  const patWorkerSrc = path.join(rootDir, 'src', 'pattern', 'engine', 'patternWorker.js');
  if (fs.existsSync(patWorkerSrc)) {
    fs.copyFileSync(patWorkerSrc, path.join(deployDir, 'patternWorker.js'));
    console.log('Copied src/pattern/engine/patternWorker.js -> deploy/patternWorker.js');
  }

// Also copy public/ assets if they exist
const publicDir = path.join(rootDir, 'public');
if (fs.existsSync(publicDir)) {
  copyDirRecursive(publicDir, deployDir);
  console.log('Copied public/* -> deploy/');
}

console.log('[deploy-assets] deploy/ folder ready for Firebase Hosting.');
