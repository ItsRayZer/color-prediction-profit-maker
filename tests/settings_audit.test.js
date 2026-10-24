/**
 * settings_audit.test.js — Addition 2 (2026-10-24): the Settings page
 * redesign (Axofy theme) is features-frozen, so this suite pins the
 * full working audit: every control on the page, the value it
 * persists, and the real consumer that reads it. It also pins the
 * wiring fixes the audit found (two settings were written but never
 * read anywhere) and the floating search behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const settings = fs.readFileSync('settings.html', 'utf8');
const mobileJs = fs.readFileSync('mobile.js', 'utf8');
const autoPilotJs = fs.readFileSync('systems/autoPilot.js', 'utf8');
const indexHtml = fs.readFileSync('index.html', 'utf8');
const FILES = { 'mobile.js': mobileJs, 'systems/autoPilot.js': autoPilotJs, 'index.html': indexHtml, 'settings.html': settings };

// control id → { key, consumer } — the audit manifest. `consumer` is
// the file that must contain the persisted key (the real reader).
const MANIFEST = [
  { id: 'swSoundEffects', key: 'quant_sound', consumer: 'mobile.js' },
  { id: 'swHaptics', key: 'quant_haptics', consumer: 'mobile.js' },
  { id: 'swKeepAlive', key: 'quant_bg_keepalive', consumer: 'mobile.js' },
  { id: 'swWakeLock', key: 'quant_wakelock', consumer: 'mobile.js' },
  { id: 'selTimeframe', key: 'quant_default_tf', consumer: 'mobile.js' },
  { id: 'selInchargeMode', key: 'quant_incharge_settings', consumer: 'mobile.js' },
  { id: 'stakeBtn10', key: 'quant_sim_stake', consumer: 'mobile.js' },
  { id: 'selViewMode', key: 'quant_preferred_view', consumer: 'index.html' },
  { id: 'autoPilotSettingsToggle', key: 'o101_autopilot_settings_v1', consumer: 'systems/autoPilot.js' },
  { id: 'autoPilotRiskSelect', key: 'o101_autopilot_settings_v1', consumer: 'systems/autoPilot.js' },
  { id: 'customWebsiteUrlInput', key: 'custom_default_website_url', consumer: 'mobile.js' },
  { id: 'endpointInput30s', key: 'quant_custom_api_endpoints', consumer: 'mobile.js' },
  { id: 'endpointInput1m', key: 'quant_custom_api_endpoints', consumer: 'mobile.js' },
];

test('manifest: every settings control exists and its persisted key has a real consumer', () => {
  for (const row of MANIFEST) {
    assert.ok(settings.includes(`id="${row.id}"`), `control #${row.id} still on the settings page`);
    assert.ok(settings.includes(row.key), `settings page writes/reads ${row.key} for #${row.id}`);
    assert.ok(FILES[row.consumer].includes(row.key), `${row.key} is consumed in ${row.consumer}`);
  }
});

test('non-persisted controls and diagnostics keep their hooks', () => {
  // Outside Notifications is permission-backed (no localStorage key):
  // the toggle requests permission and mobile.js is the sender.
  assert.ok(settings.includes('id="swOutsideNotif"') && settings.includes('function toggleOutsideNotif'), 'notif toggle present');
  assert.ok(mobileJs.includes('new Notification('), 'mobile.js actually sends outside notifications');
  // Persistent Storage button drives the browser API in-page.
  assert.ok(settings.includes('id="persistBtn"') && settings.includes('navigator.storage.persist'), 'persist button wired');
  // Bridge diagnostic keeps its data hooks under the new markup.
  for (const id of ['bridgeDiagTag', 'bridgeDiagLine', 'bridgeDiagDetail']) {
    assert.ok(settings.includes(`id="${id}"`), `#${id} present`);
  }
  assert.ok(settings.includes("mode = 'inactive (direct load)'"), 'bridge diagnostic stays honest on direct loads');
  assert.ok(settings.includes("localStorage.getItem('o101_dhani_transport')"), 'diagnostic reads the recorded transport');
  // Auto-Pilot mirror displays.
  for (const id of ['autoPilotDiagLine', 'autoPilotDiagDetail', 'autoPilotRiskDetail']) {
    assert.ok(settings.includes(`id="${id}"`), `#${id} present`);
  }
  // Display + action hooks across the page.
  for (const id of ['notifStatusTag', 'keepAliveTag', 'currentStakeDisplay', 'currentWebsiteSubtext',
    'customWebsiteStatusBadge', 'badgeCurrentSite', 'badgeEndpoint30s', 'badgeEndpoint1m',
    'websiteVerifyNotice', 'btnVerifyAndSaveWebsite', 'deviceSettingsGroup', 'devicePlatformTag',
    'settingsPageCoffeeTag', 'settingsPageCoffeeBody', 'profileAccountSubtext', 'appleToast']) {
    assert.ok(settings.includes(`id="${id}"`), `#${id} present`);
  }
});

test('audit fix: Default Interval (quant_default_tf) is actually read by the app', () => {
  assert.ok(mobileJs.includes("localStorage.getItem('quant_default_tf')"), 'app boots its timeframe from the settings value');
  const setter = mobileJs.slice(mobileJs.indexOf('function setMobileTimeframe'), mobileJs.indexOf('function setMobileTimeframe') + 500);
  assert.ok(setter.includes("localStorage.setItem('quant_default_tf', tf)"), 'in-app timeframe changes write the settings key back');
  assert.ok(mobileJs.includes("localStorage.getItem('dhaniwin_last_interval')"), 'last in-app choice is the fallback');
});

test('audit fix: stake setting (quant_sim_stake) is read and written by the sim', () => {
  assert.ok(mobileJs.includes("localStorage.getItem('quant_sim_stake')"), 'sim base stake boots from the settings value');
  const setter = mobileJs.slice(mobileJs.indexOf('function setSimBaseStake'), mobileJs.indexOf('function setSimBaseStake') + 600);
  assert.ok(setter.includes("localStorage.setItem('quant_sim_stake'"), 'sheet stake chips persist the shared key');
});

test('audit fix: haptics / wake lock / keep-alive apply live via the storage listener', () => {
  const listener = mobileJs.slice(mobileJs.indexOf("addEventListener('storage'"), mobileJs.indexOf("addEventListener('storage'") + 1600);
  assert.ok(listener.includes("e.key === 'quant_haptics'"), 'haptics live');
  assert.ok(listener.includes("e.key === 'quant_wakelock'"), 'wake lock live');
  assert.ok(listener.includes("e.key === 'quant_bg_keepalive'"), 'keep-alive live');
});

test('audit fix: CSV export is real draw history, JSON export is the snapshot', () => {
  assert.ok(settings.includes("localStorage.getItem('quant_history_' + tf)"), 'CSV reads the app’s cached draw history');
  assert.ok(settings.includes('timeframe,period,number,size,color'), 'CSV header matches the cached row fields');
  assert.ok(!settings.includes("format === 'csv' ? 'text/csv'"), 'the old mislabelled JSON-as-CSV path is gone');
});

// ── Floating search: behaviour in a stub DOM ───────────────────────
function loadSearchFns() {
  const start = settings.indexOf('function filterSettings');
  const end = settings.indexOf('/* ── Sub-page');
  assert.ok(start > -1 && end > start, 'search functions located');
  const src = settings.slice(start, end);
  const cats = [
    { textContent: 'Connectivity & Edge Sync bridge auto-pilot', style: {} },
    { textContent: 'Notifications & Sounds haptics', style: {} },
    { textContent: 'Data & Storage export purge', style: {} }
  ];
  const clearBtn = { style: {} };
  const input = { value: '', focused: 0, focus() { this.focused++; }, blur() {} };
  const shellClasses = new Set();
  const shell = { classList: { add: c => shellClasses.add(c), remove: c => shellClasses.delete(c), contains: c => shellClasses.has(c) } };
  const byId = { searchClearBtn: clearBtn, appleSettingsSearch: input, settingsSearchShell: shell };
  const ctx = {
    document: {
      getElementById: id => byId[id] || null,
      querySelectorAll: sel => (sel === '.setting-category' ? cats : [])
    },
    setTimeout: fn => { fn(); return 0; }
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, cats, clearBtn, input, shellClasses };
}

test('floating search filters sections live and resets cleanly', () => {
  const { ctx, cats, input } = loadSearchFns();
  ctx.filterSettings('sound');
  assert.equal(cats[0].style.display, 'none');
  assert.equal(cats[1].style.display, 'block');
  assert.equal(cats[2].style.display, 'none');
  ctx.filterSettings('');
  assert.ok(cats.every(c => c.style.display === 'block'), 'empty query restores every section');
  input.value = 'bridge';
  ctx.clearSettingsSearch();
  assert.equal(input.value, '', 'clear empties the field');
  assert.ok(cats.every(c => c.style.display === 'block'), 'clear resets the filter');
});

test('floating search expands, collapses and clears via its handlers', () => {
  const { ctx, cats, input, shellClasses } = loadSearchFns();
  ctx.expandSettingsSearch();
  assert.ok(shellClasses.has('expanded'), 'tap expands the pill');
  input.value = 'export';
  ctx.filterSettings('export');
  assert.equal(cats[2].style.display, 'block');
  assert.equal(cats[0].style.display, 'none');
  ctx.handleSearchClear();
  assert.equal(input.value, '', '× with text clears the text');
  assert.ok(shellClasses.has('expanded'), '× with text keeps the field open');
  ctx.collapseSettingsSearch();
  assert.ok(!shellClasses.has('expanded'), 'Esc/collapse closes the pill');
  assert.ok(cats.every(c => c.style.display === 'block'), 'collapse resets the filter');
});

test('floating search markup + matte floating CSS are pinned', () => {
  assert.ok(settings.includes('id="settingsSearchShell"'), 'shell id present');
  assert.ok(settings.includes('ios-search-collapsed-label'), 'collapsed label present');
  assert.ok(settings.includes("event.key === 'Escape'"), 'Esc collapses');
  const themeStart = settings.indexOf('AXOFY THEME');
  const theme = settings.slice(themeStart, settings.indexOf('</style>', themeStart));
  assert.ok(/\.ios-search-shell\s*\{[^}]*position:\s*fixed/.test(theme), 'search shell floats (position: fixed)');
  assert.ok(theme.includes('env(safe-area-inset-bottom'), 'safe-area aware');
  assert.ok(theme.includes('.ios-search-shell.expanded'), 'expanded state styled');
});

// ── Theme pins ─────────────────────────────────────────────────────
test('Axofy theme tokens are applied, matte only', () => {
  const themeStart = settings.indexOf('AXOFY THEME');
  assert.ok(themeStart > -1, 'theme block present');
  const theme = settings.slice(themeStart, settings.indexOf('</style>', themeStart));
  for (const token of ['#040405', '#f4f4f6', '#8b8b93', '#ffd166', 'Plus Jakarta Sans', 'Instrument Serif']) {
    assert.ok(settings.includes(token), `token ${token} present`);
  }
  assert.ok(theme.includes('border-radius: 22px'), 'panels use the 22px radius');
  assert.ok(!theme.includes('gradient('), 'no gradients (shine/gloss) in the theme block');
  assert.ok(settings.includes('fonts.googleapis.com/css2?family=Instrument+Serif'), 'theme fonts loaded');
});
