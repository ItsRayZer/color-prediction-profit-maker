/**
 * axo_ball_fix_round5.test.js — Axo ball fix round #5 (owner's
 * layout correction on the round #4 build, 2026-10-24). The owner
 * was on the round #4 direct build (bqed9y1vq): small top-center
 * avatar, "Axo" label, "Skip" badge, "Skip · #2133" pill, road
 * strip, short periods — all working. What he rejected was the
 * LAYOUT around them: a tall blank band between the avatar
 * cluster and the "01:01 ASSISTANT" header (the round #4 76px
 * header clearance), plus the minimized-state floating subtitle
 * as unwanted clutter.
 *
 * Pins:
 *  1. No clearance band: the panel layout is exactly the old
 *     layout with only the smart Axo added — the avatar overlaps
 *     the top edge WITHOUT pushing content down; the header keeps
 *     its old offset and spacing.
 *  2. Minimized = prediction inside the Axo ball; the floating
 *     subtitle element (#axoFloatingSubtitle) is DELETED entirely
 *     — no extra subtitle in minimized state. Voice is untouched:
 *     it still follows its own switch.
 *  3. Panel subtitle keeps its position and content but its
 *     BACKGROUND is the Axofy app's subtitle background
 *     (axo-site.js .axo-site-card surface: rgba(28,28,31,.92) +
 *     1px rgba(255,255,255,.1) border), not the round #4 matte
 *     black pill.
 *  4. No regressions: round #3 login removals still hold, and the
 *     every-round announcement (size/colour/skip + icons) still
 *     holds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  subtitleSurfaces
} from '../systems/orb-bridge.js';

const orbSrc = fs.readFileSync('systems/orb-bridge.js', 'utf8');
const mobileHtml = fs.readFileSync('mobile.html', 'utf8');
const mobileJs = fs.readFileSync('mobile.js', 'utf8');
const mobileCss = fs.readFileSync('mobile.css', 'utf8');

// ── Pin 1: no clearance band ─────────────────────────────────────
test('pin 1 — panel top has no clearance band; header keeps its old offset', () => {
  assert.ok(!mobileCss.includes('#assistantSheetHeader{padding-top:76px'), 'no 76px header clearance anywhere in CSS');
  assert.ok(!mobileCss.includes('padding-top:76px'), 'no 76px clearance band at all');
  assert.ok(mobileCss.includes('#dhaniwinAssistantSheet.axo-top-avatar-open{overflow:visible}'), 'open sheet still lets the avatar paint outside its top edge');
  // The avatar still straddles the top-center edge (round #4 shape kept).
  assert.ok(mobileCss.includes('#axoTopAvatar{position:absolute;left:50%;top:0;transform:translate(-50%,-50%)'), 'avatar still anchored top-center, overlapping the edge');
  assert.ok(mobileHtml.includes('id="axoTopAvatar"'), 'the smart Axo avatar is still added');
  assert.ok(mobileHtml.includes('id="axoTopAvatarBadge"'), 'its prediction badge is still added');
});

// ── Pin 2: floating subtitle deleted; minimized = in-ball ────────
test('pin 2 — floating subtitle element is absent; minimized shows the prediction inside the ball', () => {
  assert.ok(!mobileHtml.includes('id="axoFloatingSubtitle"'), 'no floating subtitle element in the markup');
  for (const [name, src] of [['orb-bridge', orbSrc], ['mobile.js', mobileJs]]) {
    assert.ok(!src.includes('axoFloatingSubtitle'), `${name}: no floating subtitle reference`);
    assert.ok(!src.includes('axoSubtitleText'), `${name}: no floating subtitle text span`);
    assert.ok(!src.includes('positionAxoFloatingSubtitle'), `${name}: no floating subtitle positioning function`);
  }
  // The decision: minimized always shows the in-ball prediction.
  const d = subtitleSurfaces({ subsOn: true, panelOpen: false });
  assert.equal(d.floatingVisible, false, 'no floating surface can ever show');
  assert.equal(d.pillVisible, true, 'minimized shows the prediction inside the ball, CC or not');
  const off = subtitleSurfaces({ subsOn: false, panelOpen: false });
  assert.equal(off.pillVisible, true, 'CC-off minimized also shows the in-ball prediction');
  // renderAxoOrb never hides the pill/bar/icon behind the subtitle switch.
  const orbFn = orbSrc.slice(orbSrc.indexOf('function renderAxoOrb()'), orbSrc.indexOf('function scheduleLongAnalysis'));
  assert.ok(!orbFn.includes("classList.toggle('hidden', subsOn)"), 'in-ball pill/bar/icon are never hidden by the subtitle switch');
  assert.ok(orbFn.includes("pill.classList.remove('hidden')"), 'the pill is kept visible in minimized state');
  // The in-ball elements themselves still exist.
  assert.ok(mobileHtml.includes('id="floatingOrbTarget"'), 'the in-ball pick pill exists');
  assert.ok(mobileHtml.includes('id="floatingOrbUnderBar"'), 'the in-ball under-bar exists');
});

// ── Pin 3: panel subtitle background = Axofy app's ───────────────
test('pin 3 — panel subtitle background matches the Axofy app subtitle background', () => {
  // The reference value: axo-site.js .axo-site-card surface the
  // spoken line sits on — rgba(28,28,31,.92) + 1px rgba(255,255,255,.1).
  assert.ok(mobileCss.includes('#smartBallLine{background:rgba(28,28,31,.92);border-color:rgba(255,255,255,.1)}'), 'sheet line uses the Axofy app subtitle background');
  const line = mobileHtml.split('\n').find(l => l.includes('id="smartBallLine"'));
  assert.ok(line && line.includes('bg-[rgba(28,28,31,0.92)]'), 'sheet line markup carries the Axofy background value');
  assert.ok(!line.includes('bg-black/75'), 'the generic matte black pill is gone');
  // Position and content unchanged: first body element, fixed height, mono.
  assert.ok(line && line.includes('h-[34px]'), 'sheet line keeps its fixed height');
  assert.ok(line && line.includes('text-[8.5px]') && line.includes('font-mono'), 'sheet line keeps its size and font');
  assert.ok(line && line.includes('id="axoSheetVerdictIcon"') && line.includes('id="axoSheetVerdictText"'), 'sheet line keeps its icon slot and text span');
});

// ── Pin 4: no regressions ─────────────────────────────────────────
test('pin 4 — round #3 login removals still hold; every-round announcement still holds', () => {
  for (const id of ['homeTopAuthPill', 'floatingAlreadyLoggedInBtn', 'unlock0101Modal', 'alreadyLoggedPromptModal', 'headerAccountIcon']) {
    for (const [name, src] of [['mobile.html', mobileHtml], ['mobile.js', mobileJs], ['orb-bridge', orbSrc]]) {
      assert.ok(!src.includes(id), `${name}: no login remnant ${id}`);
    }
  }
  // Every-round announcement: skip still speaks at verdict time with
  // its icon, and the verdict icon set still exists.
  assert.ok(orbSrc.includes("setVerdictIcon('skip')"), 'skip still sets its icon');
  assert.ok(orbSrc.includes('VERDICT_ICONS.skip'), 'skip mark still exists');
  assert.ok(orbSrc.includes('VERDICT_ICONS'), 'verdict icon set still exists');
  // Voice still built-in speechSynthesis only.
  assert.ok(orbSrc.includes('window.speechSynthesis'), 'voice still uses the browser speech API');
});
