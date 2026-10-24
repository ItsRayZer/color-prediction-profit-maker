/**
 * axo_ball_fix_round4.test.js — Axo ball fix round #4 (owner's
 * correction with reference screenshots, 2026-10-24). The owner was
 * on the NEW direct build (4j34z4a7q) and round #3 had mostly
 * landed (skip announcement, road marks, long runs, short periods,
 * no login UI) — but the GIANT floating overlay Axo covered the
 * middle of the panel and blocked the content underneath. His
 * Axofy-app reference shows the opposite: a SMALL avatar.
 *
 * Pins:
 *  1. The giant overlay is DELETED (no marker anywhere); the
 *     opened Axo is a SMALL circular avatar straddling the
 *     sheet's top-center edge, pointer-events none, transparent,
 *     full face, with "Axo" beneath it; the header keeps its old
 *     offset (round #5 deleted the clearance band — the avatar
 *     overlaps the edge without pushing content down). Closed ball
 *     unchanged.
 *  2. Subtitles styled like the Axofy app: small compact matte
 *     pills (rounded-full), the sheet line first in the body so
 *     it reads as the line under the avatar.
 *  3. Prediction badge on the avatar: written Big/Small/colour/
 *     Skip from the governed verdict, in addition to the subtitle,
 *     empty when no verdict is live — never stale, never invented.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  predictionBadgeText, badgeFromView
} from '../systems/orb-bridge.js';

const orbSrc = fs.readFileSync('systems/orb-bridge.js', 'utf8');
const mobileHtml = fs.readFileSync('mobile.html', 'utf8');
const mobileJs = fs.readFileSync('mobile.js', 'utf8');
const mobileCss = fs.readFileSync('mobile.css', 'utf8');

const APP_FILES = [mobileHtml, mobileJs, mobileCss, orbSrc];

// ── Pin 1: the giant overlay is gone ─────────────────────────────
test('pin 1 — the giant centered overlay is fully deleted', () => {
  for (const [i, src] of APP_FILES.entries()) {
    assert.ok(!src.includes('axoFloatingOverlay'), `file ${i}: no axoFloatingOverlay marker`);
    assert.ok(!src.includes('axoFloatingFace'), `file ${i}: no axoFloatingFace marker`);
    assert.ok(!src.includes('axo-big-overlay'), `file ${i}: no axo-big-overlay class`);
  }
  assert.ok(!mobileCss.includes('min(64vw,300px)'), 'no giant overlay sizing anywhere in CSS');
});

// ── Pin 1b: the small top-center avatar ──────────────────────────
test('pin 1b — opened Axo is a small circular avatar at the sheet top-center edge', () => {
  const sheetAt = mobileHtml.indexOf('id="dhaniwinAssistantSheet"');
  const avatarAt = mobileHtml.indexOf('id="axoTopAvatar"');
  const headerAt = mobileHtml.indexOf('id="assistantSheetHeader"');
  assert.ok(sheetAt > -1 && avatarAt > sheetAt, 'the top avatar lives inside the sheet');
  assert.ok(avatarAt < headerAt, 'the avatar sits above the header, straddling the top edge');
  assert.ok(mobileHtml.includes('id="axoTopAvatarFace"'), 'the avatar carries the Axo face image');
  const nameAt = mobileHtml.indexOf('id="axoTopAvatarName"');
  assert.ok(nameAt > avatarAt, 'the name follows the avatar');
  assert.ok(/id="axoTopAvatarName">Axo</.test(mobileHtml), 'the label under the avatar reads Axo');
  assert.ok(mobileHtml.includes('id="axoTopAvatarBadge"'), 'the prediction badge element exists');
  // CSS: small (64px) circle, top-center anchored, non-blocking.
  assert.ok(mobileCss.includes('#axoTopAvatar{position:absolute;left:50%;top:0;transform:translate(-50%,-50%)'), 'avatar anchored top-center of the sheet');
  assert.ok(mobileCss.includes('pointer-events:none'), 'avatar never blocks a tap');
  assert.ok(mobileCss.includes('#axoTopAvatar #axoTopAvatarFace{display:block;width:64px;height:64px;border-radius:50%;object-fit:contain;background:transparent}'), 'avatar is a small 64px circle, face contained not cropped, transparent');
  // SUPERSEDED by fix round #5: the clearance band is DELETED — the
  // avatar overlaps the top edge without displacing content, and
  // the header keeps its old offset and spacing.
  assert.ok(mobileCss.includes('#dhaniwinAssistantSheet.axo-top-avatar-open{overflow:visible}'), 'open sheet lets the avatar paint outside its top edge');
  assert.ok(!mobileCss.includes('#assistantSheetHeader{padding-top:76px'), 'no clearance band pushes the header down');
  // The toggle wires it: open shows the avatar + hides the header
  // face, close restores both.
  const toggle = mobileJs.slice(mobileJs.indexOf('function toggleDhaniwinAssistantModal'), mobileJs.indexOf('window.toggleDhaniwinAssistantModal'));
  assert.ok(toggle.includes("sheet.classList.add('axo-top-avatar-open')"), 'open adds the top-avatar class');
  assert.ok(toggle.includes("axoTopAvatar')") && toggle.includes("style.display = 'flex'"), 'open shows the top avatar');
  assert.ok(toggle.includes("sheet.classList.remove('axo-top-avatar-open')"), 'close removes the class');
  assert.ok(toggle.includes("style.display = 'none'") && toggle.includes("style.display = ''"), 'close hides the avatar and restores the header face');
  // The face still syncs (blink, sleep, emotes, win/loss/sad).
  assert.ok(orbSrc.includes("const topFace = $('axoTopAvatarFace')"), 'setAxoFace syncs the top avatar face');
  // The header's own X (minimize) still exists at the top-right.
  assert.ok(mobileHtml.includes('title="Minimize to Ball"'), 'the window close X still exists');
});

// ── Pin 1c: closed ball unchanged ────────────────────────────────
test('pin 1c — the closed ball is still clamped inside the viewport', () => {
  assert.ok(orbSrc.includes('clampBallRect') || mobileJs.includes('clampFloatingOrb'), 'ball clamp still exists');
  assert.ok(mobileJs.includes('clampFloatingOrb'), 'closed ball clamping wired on load/drag/resize');
});

// ── Pin 2: Axofy-app compact subtitle pills ──────────────────────
test('pin 2 — subtitles are small compact matte pills, sheet line first under the avatar', () => {
  const line = mobileHtml.split('\n').find(l => l.includes('id="smartBallLine"'));
  assert.ok(line, 'the sheet subtitle line exists');
  assert.ok(line.includes('rounded-full'), 'sheet line is a pill (rounded-full), not a card');
  // Fix round #5: the sheet line background is the Axofy app's
  // subtitle background (axo-site.js card surface), not the generic
  // matte black pill from round #4.
  assert.ok(line.includes('bg-[rgba(28,28,31,0.92)]'), 'sheet line uses the Axofy app subtitle background');
  assert.ok(line.includes('text-center'), 'sheet line text centered');
  assert.ok(line.includes('text-[8.5px]'), 'sheet line stays small and compact');
  assert.ok(line.includes('h-[34px]'), 'sheet line keeps its fixed height (no layout jumping)');
  // Placement: the sheet line is the FIRST body element, directly
  // under the header/avatar zone — before the controls row.
  const bodyAt = mobileHtml.indexOf('assistant-sheet-body');
  const lineAt = mobileHtml.indexOf('id="smartBallLine"');
  const controlsAt = mobileHtml.indexOf('id="axoControlRow"');
  assert.ok(lineAt > bodyAt && lineAt < controlsAt, 'sheet line sits first in the body, under the avatar');
  // SUPERSEDED by fix round #5: the closed-ball floating subtitle
  // element is DELETED — minimized state shows the prediction inside
  // the Axo ball instead, so no floating subtitle line may exist.
  assert.ok(!mobileHtml.includes('id="axoFloatingSubtitle"'), 'no floating subtitle element in the markup');
  assert.ok(mobileHtml.includes('id="floatingOrbTarget"'), 'the in-ball prediction pill still exists');
});

// ── Pin 3: prediction badge text ─────────────────────────────────
test('pin 3 — badge text covers every verdict type and is empty with no live verdict', () => {
  const cases = [
    ['BIG', 'BET', 'Big'], ['SMALL', 'BET', 'Small'],
    ['GREEN', 'BET', 'Green'], ['RED', 'BET', 'Red'],
    ['VIOLET', 'BET', 'Violet'], [null, 'SKIP', 'Skip'],
    [null, 'NONE', ''], [null, null, ''], ['BIG', 'NONE', ''],
    ['PURPLE', 'BET', '']
  ];
  for (const [pick, decision, want] of cases) {
    assert.equal(predictionBadgeText(pick, decision), want, `badge(${pick}, ${decision}) === ${JSON.stringify(want)}`);
  }
  assert.equal(badgeFromView({ decision: 'BET', pick: 'BIG' }), 'Big', 'view BET Big');
  assert.equal(badgeFromView({ decision: 'BET', pick: 'RED' }), 'Red', 'view BET Red');
  assert.equal(badgeFromView({ decision: 'SKIP', pick: null }), 'Skip', 'view SKIP');
  assert.equal(badgeFromView({ decision: 'NONE', pick: null }), '', 'view NONE clears');
  assert.equal(badgeFromView({}), '', 'empty view clears');
  assert.equal(badgeFromView(null), '', 'null view clears');
});

// ── Pin 3b: badge wiring ─────────────────────────────────────────
test('pin 3b — the badge follows the governed verdict every cycle and never invents one', () => {
  assert.ok(orbSrc.includes('function setAxoPredictionBadge(text)'), 'badge writer exists');
  assert.ok(orbSrc.includes("badge.style.display = text ? 'inline-block' : 'none'"), 'empty text hides the badge');
  assert.ok(orbSrc.includes("setAxoPredictionBadge('Skip')"), 'skip announcements set the badge');
  assert.ok(orbSrc.includes("setAxoPredictionBadge(predictionBadgeText(ctx.pick, 'BET'))"), 'BET announcements set the badge from the pick');
  assert.ok(orbSrc.includes('setAxoPredictionBadge(badgeFromView(view))'), 'the hero cycle re-asserts the badge (and clears it with no verdict)');
  // The badge is written from the governed view only — never from
  // AI text, never from a road cell, never from a guess. (The
  // function's own definition line is not a write site.)
  const badgeWrites = [...orbSrc.matchAll(/setAxoPredictionBadge\(([^)]*)\)/g)]
    .filter(m => !orbSrc.slice(Math.max(0, m.index - 9), m.index).includes('function'))
    .map(m => m[1]);
  assert.ok(badgeWrites.length >= 3, 'badge has all three governed writers');
  assert.ok(badgeWrites.every(w => /'Skip'|predictionBadgeText|badgeFromView/.test(w)), 'every badge write comes from the governed verdict');
});
