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
['systems', 'algorithms', 'src', 'sounds'].forEach(dir => {
  const src = path.join(rootDir, dir);
  const dest = path.join(deployDir, dir);
  copyDirRecursive(src, dest);
  console.log(`Copied ${dir} -> deploy/${dir}`);
});

  // Copy individual files
  ['terminal.html', 'dhaniwin-bridge.js', 'logo_0101.jpg', 'coffee_card.jpg', 'favicon.svg', 'mobile.html', 'mobile.css', 'mobile.js', 'settings.html', 'manifest.json', 'sw.js', '_headers'].forEach(file => {
    const src = path.join(rootDir, file);
    const dest = path.join(deployDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`Copied ${file} -> deploy/${file}`);
    }
  });

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
