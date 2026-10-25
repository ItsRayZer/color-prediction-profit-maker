/**
 * Fix round #10 pins (2026-10-25, owner orders on the mini-ship #9
 * direct build):
 *
 * (1) "Use the same app loading animation when the Dhani app [is]
 * loading, remember the current bad loading screen" — the round #6
 * matte-black spinner splash (#dhaniwinLoadingOverlay with
 * .o101-loading-ring on #040405) is replaced ENTIRELY by the app's
 * OWN loading animation, reused exactly: the 3-dot quantum wave
 * from #appleMinimalLoader (mobile.html .apple-dots-container with
 * .apple-dot.dot-1/.dot-2/.dot-3, mobile.css .apple-dot +
 * appleQuantumWave) on the loader's black/90 blurred backdrop.
 * Behaviour is unchanged: the overlay still shows on every DhaniWin
 * navigation, clears ONLY on the iframe's real load/error event
 * (never a guessed timer), keeps the 8s slow-connection note and
 * the "Show page anyway" button for that load only.
 *
 * (2) Default DhaniWin worker base moves from the dead worker URL to
 * the newly deployed worker https://o101-dhani-proxy.mrabensojan.workers.dev
 * (account workers.dev subdomain "mrabensojan" — the bare
 * <name>.workers.dev address does not route, proven by curl empty
 * replies). The mechanics stay exactly intact: localStorage
 * o101_worker_base override still wins when set, the 15s watchdog
 * stays, the one-shot direct fallback stays.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const NEW_BASE = 'https://o101-dhani-proxy.mrabensojan.workers.dev';
const OLD_BASE = 'https://wingo-edge-sync.itsrayzer.workers.dev';

// ── Change 1: overlay uses the app's own loading animation ──────────

test('overlay reuses the app loader dots markup, in source and deploy', () => {
  for (const file of ['mobile.html', 'deploy/mobile.html']) {
    const html = read(file);
    const overlay = html.slice(html.indexOf('id="dhaniwinLoadingOverlay"'));
    assert.ok(overlay.includes('class="apple-dots-container"'), `${file}: dots container missing from overlay`);
    assert.ok(overlay.includes('class="apple-dot dot-1"'), `${file}: dot-1 missing`);
    assert.ok(overlay.includes('class="apple-dot dot-2"'), `${file}: dot-2 missing`);
    assert.ok(overlay.includes('class="apple-dot dot-3"'), `${file}: dot-3 missing`);
  }
});

test('old matte-spinner overlay markup is gone everywhere', () => {
  for (const file of ['mobile.html', 'deploy/mobile.html', 'mobile.css', 'deploy/mobile.css']) {
    assert.ok(!read(file).includes('o101-loading-ring'), `${file}: old ring markup still present`);
  }
  for (const file of ['mobile.css', 'deploy/mobile.css']) {
    const css = read(file);
    const rule = css.slice(css.indexOf('#dhaniwinLoadingOverlay {'), css.indexOf('#dhaniwinLoadingOverlay {') + 400);
    assert.ok(!rule.includes('#040405'), `${file}: old matte background still on overlay rule`);
    assert.ok(rule.includes('rgba(0,0,0,.9)'), `${file}: overlay is not the loader black/90 backdrop`);
    assert.ok(rule.includes('blur(40px)'), `${file}: overlay lacks the loader blur(40px) backdrop`);
  }
});

test('the app loader animation itself is untouched', () => {
  const html = read('mobile.html');
  assert.ok(html.includes('id="appleMinimalLoader"'), 'app loader element missing');
  assert.ok(html.includes('class="apple-dots-container"'), 'app loader dots missing');
  const css = read('mobile.css');
  assert.ok(css.includes('.apple-dot {'), 'apple-dot class missing from CSS');
  assert.ok(css.includes('@keyframes appleQuantumWave'), 'appleQuantumWave keyframes missing');
  assert.ok(css.includes('animation-delay: 0.18s'), 'dot-2 stagger missing');
  assert.ok(css.includes('animation-delay: 0.36s'), 'dot-3 stagger missing');
});

test('overlay behaviour is unchanged: load-only clear, 8s note, dismiss', () => {
  const js = read('mobile.js');
  assert.ok(js.includes('function showDhaniLoadingOverlay()'), 'show function missing');
  assert.ok(js.includes('function hideDhaniLoadingOverlay()'), 'hide function missing');
  assert.ok(js.includes("el.classList.add('o101-loading-visible')"), 'show does not add the visible class');
  assert.ok(js.includes("el.classList.remove('o101-loading-visible')"), 'hide does not remove the visible class');
  assert.ok(js.includes('Still loading DhaniWin — slow connection…'), '8s slow note text missing');
  assert.ok(js.includes('}, 8000);'), '8s slow timer missing');
  assert.ok(js.includes("iframe.addEventListener('load'"), 'overlay no longer clears on the real iframe load event');
  assert.ok(js.includes("dismiss.addEventListener('click'"), 'dismiss button listener missing');
  assert.ok(js.includes('id="dhaniwinLoadingDismissBtn"') || read('mobile.html').includes('id="dhaniwinLoadingDismissBtn"'), 'dismiss button missing');
});

// ── Change 2: default worker base ────────────────────────────────────

test('default worker base is the new worker URL, in source and deploy', () => {
  for (const file of ['mobile.js', 'deploy/mobile.js']) {
    const js = read(file);
    assert.ok(js.includes(`const CF_WORKER_BASE_DEFAULT = '${NEW_BASE}';`), `${file}: default is not the new worker URL`);
    assert.ok(!js.includes(OLD_BASE), `${file}: dead worker URL still present`);
    const count = js.split('o101-dhani-proxy.mrabensojan.workers.dev').length - 1;
    assert.equal(count, 1, `${file}: default literal must live in exactly one place`);
  }
});

function resolveWith(preset) {
  const js = read('mobile.js');
  const start = js.indexOf("const CF_WORKER_BASE_DEFAULT");
  const end = js.indexOf('const CF_WORKER_BASE = resolveWorkerBase();') + 'const CF_WORKER_BASE = resolveWorkerBase();'.length;
  const span = js.slice(start, end);
  const ctx = {};
  ctx.__preset = preset;
  vm.createContext(ctx);
  const script = `
    const localStorage = { getItem: k => (k === 'o101_worker_base' ? globalThis.__preset : null), setItem() {}, removeItem() {} };
    ${span}
    globalThis.__resolved = CF_WORKER_BASE;
  `;
  vm.runInContext(script, ctx);
  return ctx.__resolved;
}

test('worker base: override still wins, default is the new worker', () => {
  assert.equal(resolveWith(null), NEW_BASE, 'no override must resolve to the new default');
  assert.equal(resolveWith('https://custom.example.dev/'), 'https://custom.example.dev', 'override wins and trailing slash is stripped');
  assert.equal(resolveWith('notaurl'), NEW_BASE, 'non-URL override falls back to the new default');
});

test('watchdog and direct fallback behaviour unchanged', () => {
  const js = read('mobile.js');
  assert.ok(js.includes('const DHANI_PROXY_LOAD_TIMEOUT_MS = 15000;'), '15s watchdog constant missing');
  assert.ok(js.includes('_dhaniProxyWatchdog = setTimeout('), 'watchdog arm missing');
  assert.ok(js.includes('function clearDhaniProxyWatchdog()'), 'watchdog clear missing');
  assert.ok(js.includes('runDhaniProxyFallback'), 'direct fallback entry missing');
  assert.ok(js.includes('proxifyDhaniUrl(url, CF_WORKER_BASE)'), 'iframe URL still routes through the resolved base');
  assert.ok(js.includes('${CF_WORKER_BASE}/api/wingo'), 'results fetch still consumes the resolved base');
});
