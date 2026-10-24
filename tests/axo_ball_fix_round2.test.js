/**
 * axo_ball_fix_round2.test.js — Axo ball fix round #2 (owner's bug
 * report, 2026-10-24). The owner tested the preview and reported
 * many bugs; the biggest single finding is that he tested the STALE
 * alias build (see the report), but every order below is a real
 * change to the current build regardless.
 *
 * Pins:
 *  1. No login gate — dispatch, auto-prep, chips, tabs, celebrations
 *     and the governed display never consult login state. (The
 *     mobile.js side is pinned in fix_round_phone2.test.js; here the
 *     orb-bridge pure layer is pinned.)
 *  2. Short period — no rendered surface ever shows a full period
 *     number, only the last 4 digits. Internal period identity
 *     (locks, keys, records) is untouched by this file's change.
 *  3. Subtitle by default — subtitle-on + panel-closed shows the
 *     prediction as the floating subtitle line, never cramped in
 *     the ball; subtitle-off shows the minimal in-ball display;
 *     panel-open hides the floating line.
 *  4. Centered overlay — the opened sheet's geometry is centered
 *     with overlay minimums, never a small corner box.
 *  5. Voice — website matching (exact tag, tag-prefix, language
 *     prefix) and the built-in speechSynthesis route only.
 *  6. Transparent faces — the regenerated module carries all 12
 *     faces as WebP data URIs (alpha itself is verified with PIL
 *     outside node; see the ship report).
 *  7. Markup — the ball is uncropped and transparent, the floating
 *     subtitle element exists, and the overlay class + CSS exist.
 * Standing rules re-pinned: SKIP never flips on login grounds (the
 * display gate takes no login input), and the governed engine still
 * decides (displayGateFor returns the engine gate unchanged).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  shortPeriod, resolveBaseBet, displayGateFor, pickAxoVoice,
  subtitleSurfaces, centeredSheetGeometry,
  roadSuffix, withRoadSuffix, roadCells, orbPredictionView
} from '../systems/orb-bridge.js';
import { GATE_DECISIONS } from '../systems/signalGate.js';
import { autoBaseBet } from '../systems/autoPilot.js';

const mobileJs = fs.readFileSync('mobile.js', 'utf8');
const mobileHtml = fs.readFileSync('mobile.html', 'utf8');
const mobileCss = fs.readFileSync('mobile.css', 'utf8');
const orbSrc = fs.readFileSync('systems/orb-bridge.js', 'utf8');
const facesSrc = fs.readFileSync('systems/axo-faces.js', 'utf8');

const HISTORY = [
  { period: '50774', number: 2, size: 'SMALL' },
  { period: '50775', number: 8, size: 'BIG' },
  { period: '50776', number: 1, size: 'SMALL' },
  { period: '50777', number: 9, size: 'BIG' },
  { period: '50778', number: 7, size: 'BIG' },
  { period: '50779', number: 8, size: 'BIG' },
  { period: '50780', number: 3, size: 'SMALL' }
];

// ── Pin 1: no login gate in the orb-bridge pure layer ─────────────
test('pin 1 — displayGateFor takes no login input: a BET stays a BET', () => {
  const engineGate = { decision: GATE_DECISIONS.BET, pick: 'BIG', prob: 0.6, reason: 'leader' };
  const out = displayGateFor(engineGate, { hardStopped: false });
  assert.equal(out.decision, GATE_DECISIONS.BET, 'login state cannot flip a BET — it is not even a parameter');
  assert.equal(out.pick, 'BIG');
  assert.equal(out, engineGate, 'unchanged gate object when no overlay applies');
});

test('pin 1 — HARD_STOP is the only overlay that can flip a verdict', () => {
  const engineGate = { decision: GATE_DECISIONS.BET, pick: 'BIG', prob: 0.6, reason: 'leader' };
  const out = displayGateFor(engineGate, { hardStopped: true });
  assert.equal(out.decision, GATE_DECISIONS.SKIP);
  assert.equal(out.prob, null);
  assert.match(out.reason, /3-loss streak/);
});

test('pin 1 — resolveBaseBet: AUTO falls back to the chip base without a verified balance', () => {
  assert.equal(resolveBaseBet({ autoBase: true, verifiedBalance: 10000, riskMode: 'balanced' }), 100, 'verified balance drives AUTO');
  assert.equal(resolveBaseBet({ autoBase: true, verifiedBalance: 10000, riskMode: 'balanced' }), autoBaseBet(10000, 'balanced'), 'AUTO matches the bankroll figure');
  assert.equal(resolveBaseBet({ autoBase: true, verifiedBalance: null, riskMode: 'balanced', chipBase: 50 }), 50, 'AUTO without a verified balance uses the chip base instead of stalling');
  assert.equal(resolveBaseBet({ autoBase: false, chipBase: 50 }), 50, 'manual mode uses the chip base');
  assert.equal(resolveBaseBet({ autoBase: true, verifiedBalance: null, chipBase: null }), null, 'nothing knowable → null, the session is kept as-is');
});

test('pin 1 — no login-gate wording survives in the governed layer', () => {
  assert.ok(!orbSrc.includes('No signal or stake is suggested until'), 'the login display overlay is gone');
  assert.ok(!orbSrc.includes('Paused: login not verified'), 'the Auto-Pilot login pause is gone');
  assert.ok(!orbSrc.includes('No stake is shown while login is unverified'), 'the stake suppression is gone');
});

// ── Pin 2: short period everywhere it renders ──────────────────────
test('pin 2 — shortPeriod keeps only the last 4 digits', () => {
  assert.equal(shortPeriod('50781'), '0781');
  assert.equal(shortPeriod(50781), '0781');
  assert.equal(shortPeriod('123'), '123', 'shorter inputs pass through');
  assert.equal(shortPeriod(null), '');
  assert.equal(shortPeriod(undefined), '');
});

test('pin 2 — road suffix and in-ball view show the short form only', () => {
  const line = withRoadSuffix('New signal: BIG from the leader.', { history: HISTORY, period: '50781' });
  assert.match(line, /#0781/);
  assert.ok(!line.includes('50781'), 'the full period never appears in the subtitle');
  const fallback = roadSuffix({ history: HISTORY });
  assert.match(fallback, /#0780/);
  assert.ok(!fallback.includes('50780'), 'the fallback period is short too');
  const view = orbPredictionView({ verdict: 'BET', pick: 'BIG', period: '50781' });
  assert.equal(view.periodText, '#0781');
  assert.ok(!view.periodText.includes('50781'));
});

// ── Pin 3: subtitle surfaces ───────────────────────────────────────
test('pin 3 — subtitle-on default shows the floating subtitle, never the cramped ball text', () => {
  const d = subtitleSurfaces({ subsOn: true, panelOpen: false });
  assert.equal(d.floatingVisible, true, 'default state = floating subtitle line');
  assert.equal(d.sheetHidden, false);
  assert.equal(d.pillVisible, false, 'the in-ball pill hides while subtitles carry the prediction');
});

test('pin 3 — subtitle-off shows the minimal in-ball display; panel-open hides the floating line', () => {
  const off = subtitleSurfaces({ subsOn: false, panelOpen: false });
  assert.equal(off.floatingVisible, false);
  assert.equal(off.sheetHidden, true);
  assert.equal(off.pillVisible, true, 'only CC-off falls back to the in-ball display, silently');
  const open = subtitleSurfaces({ subsOn: true, panelOpen: true });
  assert.equal(open.floatingVisible, false, 'the sheet line shows the same text while the panel is open');
  assert.equal(open.sheetHidden, false);
});

// ── Pin 4: centered overlay geometry ───────────────────────────────
test('pin 4 — the opened sheet centers with overlay minimums', () => {
  const g = centeredSheetGeometry({ vw: 390, vh: 844, width: 270, height: 360 });
  assert.equal(g.width, 360, 'the saved small width is raised to the overlay minimum');
  assert.equal(g.height, 480, 'the saved small height is raised to the overlay minimum');
  assert.equal(g.left, 15, 'centered: (390 - 360) / 2');
  assert.equal(g.top, 182, 'centered: (844 - 480) / 2');
  const big = centeredSheetGeometry({ vw: 1200, vh: 900, width: 500, height: 600 });
  assert.equal(big.width, 500, 'a larger saved size is kept');
  assert.equal(big.left, 350);
  assert.equal(big.top, 150);
  const tiny = centeredSheetGeometry({ vw: 320, vh: 500, width: 360, height: 480 });
  assert.ok(tiny.left >= 8 && tiny.top >= 50, 'never placed off-screen on a tiny viewport');
});

// ── Pin 5: voice matching + route ──────────────────────────────────
test('pin 5 — pickAxoVoice: exact tag, then tag-prefix, then language-prefix', () => {
  const voices = [
    { lang: 'en-US', name: 'us' },
    { lang: 'en-IN', name: 'in' },
    { lang: 'hi-IN', name: 'hi' }
  ];
  assert.equal(pickAxoVoice(voices, 'en-IN').name, 'in', 'exact tag wins over the first en-* voice');
  assert.equal(pickAxoVoice([{ lang: 'en-GB' }], 'en-IN').lang, 'en-GB', 'tag-prefix fallback');
  assert.equal(pickAxoVoice([{ lang: 'ml' }], 'ml-IN').lang, 'ml', 'language-prefix fallback');
  assert.equal(pickAxoVoice([], 'en-IN'), null);
  assert.equal(pickAxoVoice([{ lang: 'fr-FR' }], 'en-IN'), null);
});

test('pin 5 — voice is the built-in speechSynthesis only; no external TTS route', () => {
  const voiceSrc = orbSrc + mobileJs;
  assert.ok(!/elevenlabs|text-to-speech|texttospeech|api\.openai\.com/i.test(voiceSrc), 'no external TTS service referenced');
  assert.ok(orbSrc.includes('window.speechSynthesis'), 'speechSynthesis is the voice engine');
  assert.ok(orbSrc.includes('speechSynthesis.resume()'), 'the engine resumes on every gesture (website pattern)');
  assert.ok(orbSrc.includes('speechSynthesis.cancel()'), 'mute cancels via speechSynthesis');
});

// ── Pin 6: transparent faces module ────────────────────────────────
test('pin 6 — the faces module carries all 12 faces as WebP data URIs', () => {
  for (const key of ['base', 'blink', 'halfblink', 'thinking', 'wow', 'celebrate', 'sad', 'angry', 'pleading', 'wink', 'sleep', 'sleep2']) {
    assert.ok(facesSrc.includes(`${key}: 'data:image/webp;base64,`), `face ${key} present`);
  }
  assert.ok(facesSrc.includes('transparent'), 'the header records the transparent source');
});

// ── Pin 7: markup ──────────────────────────────────────────────────
test('pin 7 — the ball is uncropped and transparent, and the floating subtitle exists', () => {
  const ballLine = mobileHtml.split('\n').find(l => l.includes('id="floatingOrbAxoFace"'));
  assert.ok(ballLine.includes('object-contain'), 'the face shows fully, not circle-cropped');
  assert.ok(!ballLine.includes('object-cover') && !ballLine.includes('rounded-full'), 'no cover crop and no circle mask on the ball face');
  const ringLine = mobileHtml.split('\n').find(l => l.includes('id="floatingOrbRing"'));
  assert.ok(!ringLine.includes('bg-[#0b0b10]') && !ringLine.includes('overflow-hidden'), 'no disc background and no crop on the ring');
  assert.ok(mobileHtml.includes('id="axoFloatingSubtitle"'), 'the floating subtitle element exists');
  assert.ok(mobileHtml.includes('axo-big-overlay') || mobileCss.includes('axo-big-overlay'), 'the overlay mode exists');
});

test('pin 7 — the opened Axo floats OUTSIDE the panel (fix round #3, replaces the in-panel big face)', () => {
  assert.ok(mobileCss.includes('#axoFloatingOverlay{'), 'the floating overlay rules exist');
  assert.ok(mobileCss.includes('#dhaniwinAssistantSheet.axo-big-overlay #axoFaceHost{display:none'), 'the panel header hides its face while open');
  assert.ok(mobileHtml.includes('id="axoFloatingOverlay"'), 'the overlay element exists');
  assert.ok(mobileJs.includes("sheet.classList.add('axo-big-overlay')"), 'opening adds the overlay class');
  assert.ok(mobileJs.includes("sheet.classList.remove('axo-big-overlay')"), 'closing removes it');
  assert.ok(mobileJs.includes('Math.floor((window.innerWidth - boxWidth) / 2)'), 'opening centers horizontally');
});
