/**
 * settings_icons.test.js — owner order 2026-10-24: "Use minimal
 * white/black icons for the setting." Every icon on settings.html is
 * now an inline SVG line icon (.o101-ico) drawn with currentColor at
 * one stroke weight; the coloured iOS tiles are forced matte mono by
 * the theme block; the FontAwesome icon font is gone from the page;
 * no emoji serves as an icon anywhere (strategy <option> prefixes,
 * supporter heart/lock/coffee, toast glyphs included). Everything
 * else about the page is frozen (ids, keys, layout, copy) — the
 * settings_audit suite pins that side.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const settings = fs.readFileSync('settings.html', 'utf8');

test('icons: no icon-font hooks remain on the settings page', () => {
  assert.ok(!settings.includes('fa-solid'), 'fa-solid class left behind');
  assert.ok(!settings.includes('fa-brands'), 'fa-brands class left behind');
  assert.ok(!settings.includes('fa-'), 'fa-* hook left behind');
  assert.ok(!settings.includes('font-awesome'), 'FontAwesome CDN link left behind');
});

test('icons: no emoji or symbol glyph serves as an icon anywhere on the page', () => {
  const emoji = settings.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu);
  assert.equal(emoji, null, 'emoji/symbol glyphs left: ' + (emoji || []).join(' '));
  // The two glyph-buttons (search clear, battery-guide close) are SVG now.
  assert.ok(!settings.includes('>✕</button>'), 'text ✕ button left behind');
});

test('icons: every settings icon is an inline SVG using currentColor', () => {
  const svgs = settings.match(/<svg class="o101-ico[^"]*"[^>]*>/g) || [];
  assert.ok(svgs.length >= 55, 'expected the full icon set as inline SVG, got ' + svgs.length);
  for (const tag of svgs) {
    assert.ok(tag.includes('stroke="currentColor"'), 'icon not currentColor-driven: ' + tag.slice(0, 80));
  }
  // One consistent stroke weight across the whole set.
  const weights = new Set([...settings.matchAll(/<svg class="o101-ico[^"]*"[^>]*stroke-width="([\d.]+)"/g)].map(m => m[1]));
  assert.deepEqual([...weights], ['1.8'], 'icon stroke weights drifted: ' + [...weights].join(','));
});

test('icons: tiles are forced monochrome by the theme block', () => {
  assert.ok(
    settings.includes('.ios-squircle, .ios-icon-box {\n      background: rgba(255, 255, 255, 0.06) !important;'),
    'mono tile override missing from the Axofy theme block');
  assert.ok(settings.includes('.o101-ico {'), 'icon sizing rule missing');
  // The search pill glyph is white, not gold.
  assert.ok(settings.includes('.ios-search-shell .ios-search-btn-icon { background: rgba(255, 255, 255, 0.08); color: #f4f4f6; }'),
    'search pill icon not forced monochrome');
});

test('icons: dynamic icon slots (toast, save button) swap SVG, not icon-font classes', () => {
  assert.ok(settings.includes('icon.innerHTML = isSuccess ? TOAST_ICON_OK : TOAST_ICON_ALERT;'),
    'toast icon still assigned an icon-font class');
  assert.ok(settings.includes('const TOAST_ICON_OK = \'<svg class="o101-ico"'), 'toast OK icon is not inline SVG');
  assert.ok(settings.includes('const TOAST_ICON_ALERT = \'<svg class="o101-ico"'), 'toast alert icon is not inline SVG');
  assert.ok(settings.includes('o101-spin'), 'save-button spinner is not the mono SVG loader');
});

test('icons: frozen surface intact — key ids and the bridge row survive', () => {
  for (const id of ['appleSettingsSearch', 'searchClearBtn', 'appleToastIcon', 'bridgeDiagLine',
                    'bridgeDiagDetail', 'bridgeDiagTag', 'autoPilotSettingsToggle', 'selInchargeMode']) {
    assert.ok(settings.includes('id="' + id + '"'), 'missing id after icon pass: ' + id);
  }
  // Strategy options keep their values and labels (emoji prefixes removed).
  assert.ok(settings.includes('<option value="WINNING_STREAK_OVERRIDE">Winning Streak Override</option>'));
  assert.ok(settings.includes('<option value="UCB_RANKING">UCB-MAB Bandit</option>'));
});
