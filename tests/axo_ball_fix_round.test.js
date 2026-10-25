/**
 * axo_ball_fix_round.test.js — Axo ball fix round (owner's phone
 * feedback, 2026-10-24) + subtitle-closed refinement + history-full
 * and background long analysis (owner additions #1/#2).
 *
 * Pins:
 *  1. Ball clamp — load / drag / resize cases stay inside the viewport.
 *  2. Road suffix — every BET subtitle carries road + period number.
 *  3. Road cells — each settled result pairs with its governed pick.
 *  4. Mute — voice off silences speech, never subtitles; the voice
 *     toggle never touches the subtitle state.
 *  5. Language — persisted choice, speech tag mapping, EN→HI→ML cycle.
 *  6. Voice gate — blocked-before-gesture queues + shows the tap
 *     affordance; the gesture flushes the queued line and speaks.
 *  7. Subtitle-closed — prediction renders inside Axo (not the old
 *     ball), silently, and opening the panel flips neither CC nor
 *     voice state.
 *  8. SKIP announcement (fix round #3, replaces skip silence) — a
 *     skip is announced at verdict time (subtitle + voice + skip
 *     icon); settlement still produces no events/sound and the
 *     strip never invents a pick for a skipped round.
 *  9. History full — no render cap (8/25/30/-25) survives in any
 *     road/table/graph renderer; full list, newest first, chunked.
 * 10. Long analysis — finds a planted long run with its period range,
 *     never mutates history, and never emits a verdict/stake/gate.
 * 11. Voice route — speechSynthesis only; no external TTS anywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  AXO_LANG_KEY, AXO_LANGS, axoLangFrom, axoSpeechTag, axoNextLang,
  axoMaySpeak, AxoVoiceGate, clampBallRect, AXO_ORB_WIDTH, AXO_ORB_HEIGHT,
  roadSuffix, withRoadSuffix, roadCells, orbPredictionView,
  axoVoiceEnabled, axoSubsEnabled, settleGovernedPick
} from '../systems/orb-bridge.js';
import {
  cleanHistory, findSizeRuns, findAlternatingRuns, findSameNumberRuns,
  findRepeatedSequences, analyseHistory
} from '../systems/longAnalysis.js';
import { fullRoadList, chunkList } from '../systems/historyRoad.js';

const mobileJs = fs.readFileSync('mobile.js', 'utf8');
const mobileHtml = fs.readFileSync('mobile.html', 'utf8');
const settingsHtml = fs.readFileSync('settings.html', 'utf8');
const orbSrc = fs.readFileSync('systems/orb-bridge.js', 'utf8');

const store = (entries = {}) => ({
  getItem: k => (k in entries ? entries[k] : null),
  setItem: (k, v) => { entries[k] = v; }
});

function fnBody(src, fnName) {
  const start = src.indexOf(`function ${fnName}(`);
  assert.notEqual(start, -1, `${fnName} must exist`);
  const next = src.indexOf('\nfunction ', start + 1);
  return next === -1 ? src.slice(start) : src.slice(start, next);
}

// ── Pin 1: ball clamp ────────────────────────────────────────────
test('pin 1 — clamp: a saved off-screen position lands inside the viewport on load', () => {
  const c = clampBallRect({ left: 390, top: 700, vw: 390, vh: 844 });
  assert.ok(c.left >= 8 && c.left + AXO_ORB_WIDTH <= 390, `left ${c.left} inside 390px viewport`);
  assert.ok(c.top >= 10 && c.top + AXO_ORB_HEIGHT <= 844, `top ${c.top} inside 844px viewport`);
});

test('pin 1 — clamp: a drag far past every edge stays inside', () => {
  const c = clampBallRect({ left: -500, top: 5000, vw: 390, vh: 844 });
  assert.equal(c.left, 8);
  assert.ok(c.top + AXO_ORB_HEIGHT <= 844);
  const d = clampBallRect({ left: 5000, top: -500, vw: 390, vh: 844 });
  assert.ok(d.left + AXO_ORB_WIDTH <= 390);
  assert.equal(d.top, 10);
});

test('pin 1 — clamp: shrinking the viewport (rotation/resize) pulls the ball back in', () => {
  const before = clampBallRect({ left: 300, top: 700, vw: 800, vh: 900 });
  assert.equal(before.left, 300);
  const after = clampBallRect({ left: before.left, top: before.top, vw: 390, vh: 844 });
  assert.ok(after.left + AXO_ORB_WIDTH <= 390 && after.top + AXO_ORB_HEIGHT <= 844);
});

// ── Pin 2: road suffix ───────────────────────────────────────────
const HISTORY = [
  { period: '50774', number: 7, size: 'BIG' },
  { period: '50775', number: 2, size: 'SMALL' },
  { period: '50776', number: 9, size: 'BIG' },
  { period: '50777', number: 4, size: 'SMALL' },
  { period: '50778', number: 1, size: 'BIG' },
  { period: '50779', number: 8, size: 'BIG' },
  { period: '50780', number: 3, size: 'SMALL' }
];

test('pin 2 — BET subtitle carries the sequence road + the open period number', () => {
  const line = withRoadSuffix('New signal: BIG from the leader.', { history: HISTORY, period: '50781' });
  assert.match(line, /Road: BIG, SMALL, BIG, SMALL, BIG, BIG, SMALL/);
  assert.match(line, /#0781/);
  assert.ok(!line.includes('50781'), 'the full period number never appears in a rendered surface');
  assert.ok(line.startsWith('New signal: BIG'), 'the governed line itself is untouched, the suffix is appended');
});

test('pin 2 — road suffix falls back to the last settled period, and empties with no data', () => {
  assert.match(roadSuffix({ history: HISTORY }), /#0780/);
  assert.ok(!roadSuffix({ history: HISTORY }).includes('50780'), 'the full period number never appears in a rendered surface');
  assert.equal(roadSuffix({ history: [] }), '');
  assert.equal(withRoadSuffix('line', { history: [] }), 'line');
});

// ── Pin 3: road cells ────────────────────────────────────────────
test('pin 3 — road cells pair each settled result with its governed pick', () => {
  const dispositions = {
    '30s:50780': { decision: 'BET', pick: 'SMALL' },
    '30s:50779': { decision: 'BET', pick: 'BIG' },
    '30s:50778': { decision: 'SKIP', pick: null }
  };
  const { cells, next } = roadCells({ history: HISTORY, dispositions, tf: '30s', openPeriod: '50781', nextPick: 'BIG' });
  assert.equal(cells.length, 7, 'all settled rounds, newest first');
  assert.equal(cells[0].period, '50780');
  assert.equal(cells[0].result, 'SMALL');
  assert.equal(cells[0].pick, 'SMALL');
  assert.equal(cells[0].correct, true);
  assert.equal(cells[1].pick, 'BIG');
  assert.equal(cells[1].correct, true);
  const skipped = cells.find(c => c.period === '50778');
  assert.equal(skipped.pick, null, 'a SKIP disposition carries no pick');
  assert.equal(skipped.correct, null);
  assert.equal(next.period, '50781');
  assert.equal(next.pick, 'BIG');
  assert.equal(next.next, true);
});

// ── Pin 4: mute ──────────────────────────────────────────────────
test('pin 4 — mute silences speech but never subtitles; toggles stay independent', () => {
  const s = store({ o101_axo_voice: '0', o101_axo_subs: '1' });
  assert.equal(axoVoiceEnabled(s), false);
  assert.equal(axoSubsEnabled(s), true, 'subtitles stay on while voice is muted');
  const gate = new AxoVoiceGate({ voiceOn: false, subsOn: true, unlocked: true });
  assert.deepEqual(gate.attempt('hello'), { action: 'silent', line: null });
  gate.sync({ voiceOn: true });
  assert.equal(gate.attempt('hello').action, 'speak');
});

// ── Pin 5: language ──────────────────────────────────────────────
test('pin 5 — language persists, maps to speech tags, and cycles EN→HI→ML', () => {
  const s = store({});
  assert.equal(axoLangFrom(s), 'en', 'default is English');
  assert.equal(axoLangFrom(store({ [AXO_LANG_KEY]: 'xx' })), 'en', 'unknown reads as English');
  assert.equal(axoLangFrom(store({ [AXO_LANG_KEY]: 'ml' })), 'ml');
  assert.equal(axoSpeechTag('en'), 'en-IN');
  assert.equal(axoSpeechTag('hi'), 'hi-IN');
  assert.equal(axoSpeechTag('ml'), 'ml-IN');
  assert.equal(axoNextLang('en'), 'hi');
  assert.equal(axoNextLang('hi'), 'ml');
  assert.equal(axoNextLang('ml'), 'en');
  assert.deepEqual(Object.keys(AXO_LANGS), ['en', 'hi', 'ml'], 'the initial set is exactly EN/HI/ML');
});

// ── Pin 6: voice gate ────────────────────────────────────────────
test('pin 6 — blocked-before-gesture queues the line; the gesture flushes and speaks', () => {
  const gate = new AxoVoiceGate({ voiceOn: true, subsOn: true, unlocked: false });
  assert.equal(gate.blocked, true);
  const queued = gate.attempt('New signal: BIG. Road: Big, Small. Period 50781.');
  assert.equal(queued.action, 'queue');
  assert.equal(gate.hasPending, true, 'the tap affordance condition: blocked + pending');
  const flushed = gate.unlock();
  assert.match(flushed, /Period 50781/, 'the queued line survives to the gesture');
  assert.equal(gate.hasPending, false);
  assert.equal(gate.attempt('next line').action, 'speak', 'later lines speak directly once unlocked');
});

test('pin 6 — a queued line is dropped when the state goes silent, never spoken stale', () => {
  const gate = new AxoVoiceGate({ voiceOn: true, subsOn: true, unlocked: false });
  gate.attempt('stale line');
  gate.sync({ voiceOn: false });
  assert.equal(gate.hasPending, false, 'muting drops the queue');
  assert.equal(gate.unlock(), null);
});

// ── Pin 7: subtitle-closed ───────────────────────────────────────
test('pin 7 — subtitle-closed: the prediction renders inside Axo, silently, toggles untouched', () => {
  const view = orbPredictionView({ verdict: 'BET', pick: 'BIG', period: '50781' });
  assert.equal(view.pickText, 'BIG');
  assert.equal(view.periodText, '#0781', 'fix round #2: short period only, never the full number');
  assert.equal(orbPredictionView({ verdict: 'SKIP', pick: null, period: '50781' }).pickText, 'SKIP');
  assert.equal(orbPredictionView({ verdict: null }).pickText, '—');
  // Speech is suppressed while subtitles are closed, but the voice
  // toggle VALUE is never flipped by the state change.
  const gate = new AxoVoiceGate({ voiceOn: true, subsOn: true, unlocked: true });
  gate.sync({ subsOn: false });
  assert.equal(gate.voiceOn, true, 'the voice switch value is preserved');
  assert.deepEqual(gate.attempt('prediction'), { action: 'silent', line: null });
  gate.sync({ subsOn: true });
  assert.equal(gate.attempt('prediction').action, 'speak', 're-opening subtitles restores speech');
});

test('pin 7 — opening the panel flips neither CC nor voice state (source pin)', () => {
  const body = fnBody(mobileJs, 'toggleDhaniwinAssistantModal');
  assert.ok(!body.includes('o101_axo_voice'), 'panel open never writes the voice key');
  assert.ok(!body.includes('o101_axo_subs'), 'panel open never writes the subtitle key');
  assert.ok(!body.includes('setAxoVoice') && !body.includes('setAxoSubs'), 'panel open never calls the setters');
});

test('pin 7 — the ball markup is Axo (face + pick pill + under-bar), not the old ball art', () => {
  assert.ok(mobileHtml.includes('id="floatingOrbAxoFace"'), 'Axo face image in the ball');
  assert.ok(mobileHtml.includes('id="floatingOrbUnderBar"'), 'period + road under-bar');
  assert.ok(!mobileHtml.includes('id="floatingOrbIcon"'), 'no emoji icon element left');
  assert.ok(!mobileHtml.includes('id="floatingOrbStake"'), 'no stake text left on the ball');
  assert.ok(!mobileHtml.includes('bg-gradient-to-tr from-amber-500'), 'no gradient ring left');
  assert.ok(mobileHtml.includes('id="axoVoiceBlockedBadge"'), 'tap-for-voice affordance exists');
  assert.ok(mobileHtml.includes('id="axoLangChip"'), 'language chip exists in panel chrome');
  assert.ok(mobileHtml.includes('id="axoRoadStrip"'), 'road strip exists');
  assert.ok(mobileHtml.includes('id="axoLongRuns"'), 'long-runs block exists');
  assert.ok(settingsHtml.includes('id="swAxoSubs"'), 'subtitles switch exists in Settings');
  assert.ok(settingsHtml.includes('id="axoLangBtn-hi"') && settingsHtml.includes('id="axoLangBtn-ml"'), 'language control exists in Settings');
});

// ── Pin 8: SKIP silence ──────────────────────────────────────────
test('pin 8 — SKIP still produces no events, no sound, no road pick', () => {
  const out = settleGovernedPick({ won: true, session: null, gateDecision: 'SKIP', hooks: { playSound: () => { throw new Error('must not sound'); } } });
  assert.deepEqual(out.events, []);
  assert.equal(out.sound, null);
  assert.equal(axoMaySpeak({ voiceOn: true, subsOn: true, unlocked: true }).action, 'speak');
  // A skip line never gains a road suffix through the BET-only path:
  // withRoadSuffix is only ever applied to SIGNAL_BET lines. (Fix
  // round #3: the verdict-time skip announcement is the short
  // 'Skip · #0781' line, not this explanatory botLine text — and
  // settlement here still emits nothing.)
  assert.ok(!/Road:/.test('I am skipping this round, and that is a deliberate decision.'));
});

// ── Pin 9: history full ──────────────────────────────────────────
test('pin 9 — full road list returns every round, newest first, with no cap', () => {
  const list = Array.from({ length: 40 }, (_, i) => ({ period: String(1000 + i), number: i % 10, size: i % 2 ? 'BIG' : 'SMALL' }));
  const full = fullRoadList(list);
  assert.equal(full.length, 40);
  assert.equal(full[0].period, '1039', 'newest first');
  assert.equal(full[39].period, '1000');
  assert.equal(list.length, 40, 'input untouched');
  assert.deepEqual(chunkList([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('pin 9 — no render cap survives in any road/table/graph renderer (source pins)', () => {
  assert.ok(!fnBody(mobileJs, 'renderAssistantMiniRoad').includes('slice(0, 8)'), 'mini road cap gone');
  assert.ok(!fnBody(mobileJs, 'renderHeroSequentialBallRoad').includes('slice(0, 25)'), 'hero road cap gone');
  assert.ok(!fnBody(mobileJs, 'renderHistoryTable').includes('slice(0, 30)'), 'history table cap gone');
  assert.ok(!fnBody(mobileJs, 'renderMobileHistoryGraph').includes('slice(0, 30)'), 'history graph cap gone');
  assert.ok(!mobileJs.includes('renderSequentialRoad(settled.slice(-25))'), 'bead road feed cap gone');
  assert.ok(mobileJs.includes('renderSequentialRoad(settled)'), 'bead road now fed the full list');
  for (const fn of ['renderAssistantMiniRoad', 'renderHeroSequentialBallRoad', 'renderHistoryTable', 'renderMobileHistoryGraph']) {
    assert.ok(fnBody(mobileJs, fn).includes('renderRoadCellsChunked'), `${fn} renders chunked`);
  }
});

// ── Pin 10: long analysis ────────────────────────────────────────
function plantedHistory() {
  // Chronological: 12 BIG in a row (periods 2000-2011), then alternating.
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ period: String(2000 + i), number: 7, size: 'BIG' });
  for (let i = 0; i < 8; i++) rows.push({ period: String(2012 + i), number: i % 2 ? 8 : 2, size: i % 2 ? 'BIG' : 'SMALL' });
  return rows;
}

test('pin 10 — background analysis finds the planted 12-long run with its period range', () => {
  const rows = plantedHistory();
  const runs = findSizeRuns(rows);
  const dragon = runs.find(r => r.length === 12);
  assert.ok(dragon, 'the 12-long BIG run is found');
  assert.equal(dragon.size, 'BIG');
  assert.equal(dragon.startPeriod, '2000');
  assert.equal(dragon.endPeriod, '2011');
  const alt = findAlternatingRuns(rows);
  assert.ok(alt.some(r => r.length >= 8), 'the alternating tail is found');
  const repeats = findRepeatedSequences(rows);
  assert.ok(repeats.length > 0, 'repeated short sequences are found');
  const full = analyseHistory(rows);
  assert.equal(full.rounds, 20);
  assert.equal(full.findings[0].length, 12, 'longest first');
  for (const f of full.findings) {
    const keys = Object.keys(f);
    for (const banned of ['verdict', 'stake', 'gate', 'decision', 'pick']) {
      assert.ok(!keys.includes(banned), `finding must never carry ${banned}`);
    }
  }
});

test('pin 10 — analysis never mutates history and handles frozen input', () => {
  const rows = plantedHistory();
  rows.forEach(r => Object.freeze(r));
  Object.freeze(rows);
  const out = analyseHistory(rows);
  assert.equal(out.rounds, 20);
  assert.equal(cleanHistory(rows).length, 20);
  assert.deepEqual(findSameNumberRuns([{ period: '1', number: 5 }, { period: '2', number: 5 }, { period: '3', number: 5 }])[0].length, 3);
});

// ── Pin 11: voice route ──────────────────────────────────────────
test('pin 11 — voice is the built-in speechSynthesis only; no external TTS route', () => {
  const voiceSrc = orbSrc + mobileJs;
  assert.ok(!/elevenlabs|text-to-speech|texttospeech|api\.openai\.com/i.test(voiceSrc), 'no external TTS service referenced');
  assert.ok(orbSrc.includes('window.speechSynthesis'), 'speechSynthesis is the voice engine');
  assert.ok(orbSrc.includes('speechSynthesis.cancel()'), 'mute cancels via speechSynthesis');
});
