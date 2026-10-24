/**
 * axo_ball_fix_round3.test.js — Axo ball fix round #3 (owner's
 * feedback on the NEW build, 2026-10-24). The owner was on the new
 * direct build this time (short #0917 live, road strip + EN chip
 * present), so these are real bugs, not a stale build.
 *
 * Pins:
 *  1. Opened Axo floats OUTSIDE the panel — a top-level overlay,
 *     centered, transparent, pointer-events none; the panel header
 *     carries no face while open. Closed ball unchanged (clamped).
 *  2. Every round announced — Big/Small/Red/Green/Violet/Skip each
 *     produce a voice line + subtitle + icon (SVG/CSS only, never
 *     emoji). This REPLACES skip silence; settlement silence and
 *     the MISSED BET rule are untouched.
 *  3. Login UI fully gone — every our-side login element removed;
 *     bridge state stays display-only (status lines).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BOT_EVENTS } from '../systems/predictBot.js';
import {
  axoEventEffects, verdictIconFor, VERDICT_ICONS, shortPeriod
} from '../systems/orb-bridge.js';

const orbSrc = fs.readFileSync('systems/orb-bridge.js', 'utf8');
const mobileHtml = fs.readFileSync('mobile.html', 'utf8');
const mobileJs = fs.readFileSync('mobile.js', 'utf8');
const mobileCss = fs.readFileSync('mobile.css', 'utf8');
const settingsHtml = fs.readFileSync('settings.html', 'utf8');

// ── Pin 1: opened Axo floats OUTSIDE the panel ───────────────────
test('pin 1 — the opened Axo is a top-level overlay outside the panel card', () => {
  const overlayAt = mobileHtml.indexOf('id="axoFloatingOverlay"');
  const modalAt = mobileHtml.indexOf('id="dhaniwinAssistantModal"');
  assert.ok(overlayAt > -1, 'the floating overlay element exists');
  assert.ok(modalAt > -1, 'the panel modal still exists');
  assert.ok(overlayAt < modalAt, 'the overlay is a sibling BEFORE the modal, never a child of the panel');
  assert.ok(mobileHtml.includes('id="axoFloatingFace"'), 'the overlay carries the Axo face image');
  // Centering + transparency + non-blocking, in markup and in CSS.
  const overlayTag = mobileHtml.slice(overlayAt, mobileHtml.indexOf('>', overlayAt));
  assert.ok(/left:50%/.test(overlayTag) && /top:50%/.test(overlayTag), 'overlay centered on screen');
  assert.ok(/translate\(-50%,-50%\)/.test(overlayTag), 'overlay centered by transform');
  assert.ok(/pointer-events:none/.test(overlayTag), 'overlay never blocks panel taps');
  assert.ok(/background:transparent/.test(overlayTag), 'overlay background transparent');
  assert.ok(mobileCss.includes('#axoFloatingOverlay{'), 'overlay rules live in mobile.css');
  assert.ok(mobileCss.includes('#dhaniwinAssistantSheet.axo-big-overlay #axoFaceHost{display:none'), 'the panel header hides its face while open');
  // The toggle wires it: open shows the overlay + hides the host,
  // close restores both.
  const toggle = mobileJs.slice(mobileJs.indexOf('function toggleDhaniwinAssistantModal'), mobileJs.indexOf('window.toggleDhaniwinAssistantModal'));
  assert.ok(toggle.includes("axoFloatingOverlay')") && toggle.includes("style.display = 'block'"), 'open shows the overlay');
  assert.ok(toggle.includes("axoFaceHost')") && toggle.includes("style.display = 'none'"), 'open hides the header face');
  assert.ok(toggle.includes("style.display = 'none'") && toggle.includes("style.display = ''"), 'close hides the overlay and restores the host');
  // The voice chip survived the move: it lives in the header
  // controls cluster now, same ids, so toggleAxoVoice is untouched.
  assert.ok(mobileHtml.includes('id="axoVoiceChip"') && mobileHtml.includes('id="axoVoiceChipIcon"'), 'voice chip ids intact');
  const hostBlock = mobileHtml.slice(mobileHtml.indexOf('id="axoFaceHost"'), mobileHtml.indexOf('id="axoVoiceChip"'));
  assert.ok(!hostBlock.includes('axoVoiceChip'), 'the chip is no longer inside the face host');
});

test('pin 1b — the closed ball is still clamped inside the viewport', () => {
  assert.ok(orbSrc.includes('clampBallRect') || mobileJs.includes('clampFloatingOrb'), 'ball clamp still exists');
  assert.ok(mobileJs.includes('clampFloatingOrb'), 'closed ball clamping wired on load/drag/resize');
});

// ── Pin 2: every round announced, with icons ─────────────────────
test('pin 2 — verdict icons cover every pick type plus skip, SVG only, never emoji', () => {
  const cases = [
    ['BIG', 'BET', 'big'], ['SMALL', 'BET', 'small'], ['GREEN', 'BET', 'green'],
    ['RED', 'BET', 'red'], ['VIOLET', 'BET', 'violet'], [null, 'SKIP', 'skip'],
    ['BIG', 'SKIP', 'skip']
  ];
  for (const [pick, decision, kind] of cases) {
    const got = verdictIconFor(pick, decision);
    assert.equal(got.kind, kind, `${pick}/${decision} -> ${kind}`);
    assert.ok(got.svg.startsWith('<svg'), 'icon is inline SVG');
    assert.ok(/^[\x00-\x7F]*$/.test(got.svg), 'icon SVG is ASCII only — no emoji');
  }
  assert.deepEqual(verdictIconFor(null, 'BET'), { kind: null, svg: '' });
  assert.deepEqual(verdictIconFor('NOPE', 'BET'), { kind: null, svg: '' });
  assert.ok(VERDICT_ICONS.skip.includes('<circle') && VERDICT_ICONS.skip.includes('<line'), 'skip mark is a circle-slash');
  assert.ok(VERDICT_ICONS.big.includes('<path'), 'big is an arrow');
  assert.equal(shortPeriod('50781'), '0781', 'short periods stay short-form on display');
});

test('pin 2b — a SKIP announces at verdict time: subtitle + icon + voice', () => {
  assert.deepEqual(axoEventEffects(BOT_EVENTS.SIGNAL_SKIP), { face: 'base', spoken: true });
  const fn = orbSrc.slice(orbSrc.indexOf('function speakEvent'), orbSrc.indexOf('function speakSettledEvents'));
  assert.ok(fn.includes("setVerdictIcon('skip')"), 'skip sets its icon');
  assert.ok(fn.includes('axoOnEvent(event, full)'), 'skip speaks through the normal event path');
  assert.ok(fn.includes("`Skip · #${sp}`") || fn.includes('Skip · #'), 'skip line is the minimal word + short period');
  // Icon slots exist on every surface the announcement touches.
  for (const id of ['axoSubtitleIcon', 'axoSheetVerdictIcon', 'axoHeroVerdictIcon', 'orbVerdictIcon']) {
    assert.ok(mobileHtml.includes(`id="${id}"`), `icon slot ${id} exists`);
  }
  // say() writes the text spans, never wiping an icon slot.
  const sayFn = orbSrc.slice(orbSrc.indexOf('function say(text)'), orbSrc.indexOf('function setVerdictIcon'));
  assert.ok(sayFn.includes('axoSheetVerdictText') && sayFn.includes('axoSubtitleText'), 'say writes text spans, icons survive');
  // Hero + road re-assert icons from the governed verdict.
  assert.ok(orbSrc.includes('setVerdictIcon(view.decision'), 'hero verdict sets its icon');
  assert.ok(orbSrc.includes('VERDICT_ICONS.skip'), 'road skip cells show the skip mark');
});

test('pin 2c — voice stays built-in speechSynthesis only', () => {
  const speakFn = orbSrc.slice(orbSrc.indexOf('function speakUtterance'), orbSrc.indexOf('function speakUtterance') + 1600);
  assert.ok(speakFn.includes('window.speechSynthesis'), 'voice uses the browser speech API');
  assert.ok(speakFn.includes('new SpeechSynthesisUtterance'), 'voice builds a speech utterance');
  assert.ok(!/fetch\s*\(|XMLHttpRequest|elevenlabs|openai/i.test(speakFn), 'no network TTS in the voice path');
});

// ── Pin 3: login UI fully gone ────────────────────────────────────
test('pin 3 — no our-side login element survives in markup, code, or styles', () => {
  for (const id of ['homeTopAuthPill', 'floatingAlreadyLoggedInBtn', 'dhaniAuthBar', 'unlock0101Modal', 'alreadyLoggedPromptModal', 'headerAccountIcon']) {
    assert.ok(!mobileHtml.includes(`id="${id}"`), `markup has no ${id}`);
  }
  for (const fn of ['updateDhaniAuthBar', 'openDhaniLogin', 'openDhaniRegister', 'toggleUnlockModal', 'startDhaniAuthFlow', 'toggleAlreadyLoggedPromptModal', 'openAlreadyLoggedPromptModal', 'handleAlreadyLoggedResponse', 'verifyLoginViaWinGoProbe', 'confirmDhaniLoggedIn', 'openDhaniAccountMenu', 'showDhaniAuthBar', 'dismissDhaniAuthBar', 'updateAppUnlockState']) {
    assert.ok(!mobileJs.includes(`function ${fn}`), `mobile.js defines no ${fn}`);
  }
  assert.ok(!mobileCss.includes('home-top-auth-pill') && !mobileCss.includes('floatingAlreadyLoggedInBtn') && !mobileCss.includes('apple-auth'), 'auth styles gone');
  // The entry URL no longer routes on login state.
  const entry = mobileJs.slice(mobileJs.indexOf('function getDhaniEntryUrl()'), mobileJs.indexOf('window.getDhaniEntryUrl'));
  assert.ok(entry.includes('DHANIWIN_HOME_URL') && !entry.includes('DHANIWIN_LOGIN_URL') && !entry.includes('DHANIWIN_REGISTRATION_URL'), 'entry URL is always home');
  // Settings diagnostics never blame login for a pause anymore.
  assert.ok(!settingsHtml.includes('Paused: login not verified'), 'no login pause fallback in settings');
  // Bridge state reporting itself survives as status lines only.
  assert.ok(mobileHtml.includes('id="bridgeStatusLine"'), 'bridge status line kept (display-only)');
  assert.ok(mobileJs.includes('setMobileBridgeStatus'), 'bridge status reporting kept');
});
