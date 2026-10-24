/**
 * axo_ball.test.js — Axo in the smart ball (faces + voice + AI layer).
 * Pins the PLAN.md §9 contract:
 *  1. Skip silence — a SKIP produces no events, no face, no voice.
 *  2. MISSED BET fires exactly once per period (staged-but-unfired
 *     counts as missed).
 *  3. A SKIP can never be a missed bet.
 *  4. The missed line names a result only from settled data, and
 *     only when the missed pick would have won.
 *  5. AI failure / timeout / garbage → local templated text, no throw.
 *  6. Verdict immutability — hostile AI text changes nothing; the
 *     payload whitelist drops secrets structurally.
 *  7. Spoken-set exactness — only the §5 table speaks + sets a face;
 *     grouping folds LOSS+LADDER_UP into one utterance.
 *  8. Mute — o101_axo_voice '0' silences + cancels; subtitles remain.
 *  9. Face module — the 12 faces exist as WebP data URIs, < 90 KB.
 * 10. VERIFIED edge — speaks once per transition into VERIFIED, and
 *     only from the API-proven balance (never a page scrape).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BOT_EVENTS, botLine } from '../systems/predictBot.js';
import {
  settleGovernedPick, AXO_VOICE_KEY, AXO_SUBS_KEY, AXO_MODE_KEY, AXO_SPOKEN_FACES, axoEventEffects,
  axoVoiceEnabled, axoSubsEnabled, axoModeFrom, axoNarrateWith, normaliseSpeechText, groupSpokenEvents,
  MissedBetTracker, verifiedEdge, verifiedLineApplies, LOGIN_STATES
} from '../systems/orb-bridge.js';
import {
  AXO_AI_ENDPOINT, AXO_AI_SYSTEM_PROMPT, buildAxoPrompt, buildAxoPayload,
  localRegimeLabel, localSessionSummary, sanitizeAiText, extractAiText, AxoAiClient
} from '../systems/axo-ai.js';

const orbSrc = fs.readFileSync('systems/orb-bridge.js', 'utf8');
const axoAiSrc = fs.readFileSync('systems/axo-ai.js', 'utf8');
const mobileHtml = fs.readFileSync('mobile.html', 'utf8');
const mobileJs = fs.readFileSync('mobile.js', 'utf8');
const settingsHtml = fs.readFileSync('settings.html', 'utf8');

const CTX = {
  balance: 1500, balanceSource: 'bridge', balanceSourceLabel: 'DhaniWin (live bridge)',
  baseBet: 15, ladderLevel: 1, ladderLevels: 5, nextStake: 30, sessionPnL: 45,
  startingBalance: 1500, inchargeModel: { name: 'Quantum Bloch Sphere' },
  inchargeReason: 'Wilson leader', gateDecision: { decision: 'BET', pick: 'BIG' },
  pick: 'BIG', calibratedConfidence: 0.58, isCalibrated: true, streak: 0,
  lastResult: 'BIG 7', circuitBreakerState: 'ARMED'
};

// ── Pin 1: skip silence ──────────────────────────────────────────
test('pin 1 — settleGovernedPick: a non-BET round produces no events and no sound', () => {
  let sounds = 0;
  const out = settleGovernedPick({
    won: true, session: null, gateDecision: 'SKIP',
    hooks: { playSound: () => { sounds++; } }
  });
  assert.deepEqual(out.events, []);
  assert.equal(out.sound, null);
  assert.equal(sounds, 0, 'the sound hook never fires for a skip');
});

test('pin 1 — SIGNAL_SKIP has no Axo face and is never spoken', () => {
  assert.deepEqual(axoEventEffects(BOT_EVENTS.SIGNAL_SKIP), { face: null, spoken: false });
  // Runtime pin: speakEvent returns a skip line as STATE ONLY, before
  // any say()/face/voice work can happen.
  const fn = orbSrc.slice(orbSrc.indexOf('function speakEvent'), orbSrc.indexOf('function speakSettledEvents'));
  const skipAt = fn.indexOf('SIGNAL_SKIP');
  const sayAt = fn.indexOf('say(line)');
  assert.ok(skipAt > -1 && sayAt > skipAt, 'the skip early-return precedes the subtitle write');
  assert.ok(fn.includes('state.lastLine = line'), 'the skip line survives only as internal state');
});

// ── Pins 2 + 3: missed bet ───────────────────────────────────────
test('pin 2 — MISSED BET fires exactly once per period; staged-but-unconfirmed counts', () => {
  const t = new MissedBetTracker();
  assert.equal(t.shouldFire('30s:P100', { gateDecision: 'BET', fired: false }), true, 'first settlement fires');
  assert.equal(t.shouldFire('30s:P100', { gateDecision: 'BET', fired: false }), false, 'processed twice → still once');
  assert.equal(t.shouldFire('30s:P101', { gateDecision: 'BET', fired: false }), true, 'a new period can fire');
  assert.equal(t.has('30s:P100'), true);
});

test('pin 3 — a SKIP lock can never produce a missed bet; a fired bet is not missed', () => {
  const t = new MissedBetTracker();
  assert.equal(t.shouldFire('30s:P200', { gateDecision: 'SKIP', fired: false }), false);
  assert.equal(t.shouldFire('30s:P200', { gateDecision: 'SKIP', fired: false }), false, 'not even on repeat');
  assert.equal(t.has('30s:P200'), false, 'a skip never enters the missed ledger');
  assert.equal(t.shouldFire('30s:P201', { gateDecision: 'BET', fired: true }), false, 'a confirmed bet is not missed');
});

test('pin 2/3 — runtime wiring: the settlement branch decides via the tracker, from the lock', () => {
  assert.ok(orbSrc.includes('axo.missed.shouldFire(tf + \':\' + latestPeriod, { gateDecision: decision, fired })'),
    'missed detection uses the locked decision + fired record');
  assert.ok(orbSrc.includes('speakEvent(BOT_EVENTS.MISSED_BET'), 'the missed event goes through the one funnel');
});

// ── Pin 4: missed line honesty ───────────────────────────────────
test('pin 4 — the missed line names the result only when the settled pick would have won', () => {
  const won = botLine(BOT_EVENTS.MISSED_BET, { ...CTX, missedPick: 'BIG', missedWon: true, missedResult: 'Big' });
  assert.match(won.line, /That was our pick, and it came Big\. Why didn't you bet\?/);
  const lost = botLine(BOT_EVENTS.MISSED_BET, { ...CTX, missedPick: 'BIG', missedWon: false, missedResult: null });
  assert.match(lost.line, /That was our pick… why didn't you bet\?/);
  assert.ok(!/it came/.test(lost.line), 'no result is claimed for a pick that would have lost');
  assert.ok(!/Big|Small/.test(lost.line), 'no result word appears at all');
});

// ── Pin 5: AI failure fallback ───────────────────────────────────
test('pin 5 — the endpoint is the same-origin hop; an endpoint-less client never fetches', async () => {
  assert.equal(AXO_AI_ENDPOINT, '/api/axo-ai', 'the client targets the same-origin server hop');
  let fetches = 0;
  const dark = new AxoAiClient({ endpoint: null, fetchImpl: async () => { fetches++; throw new Error('must not be called'); } });
  const r = await dark.narrate({ event: 'REGIME', payload: { period: 'P1' }, local: 'LOCAL LINE' });
  assert.deepEqual(r, { text: 'LOCAL LINE', source: 'local' });
  assert.equal(fetches, 0, 'no endpoint → no fetch, local text');
  // A hop that answers non-200 (e.g. 503 before the owner sets the
  // env key) is "AI unavailable": local text, silently.
  const unconfigured = new AxoAiClient({
    endpoint: '/api/axo-ai',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'ai_unavailable' }) })
  });
  assert.deepEqual(await unconfigured.narrate({ event: 'REGIME', payload: {}, local: 'L' }), { text: 'L', source: 'local' });
});

test('pin 5 — AI rejection, garbage and timeout all fall back to the local line without throwing', async () => {
  const rejecting = new AxoAiClient({ endpoint: 'https://hop.invalid/axo', fetchImpl: async () => { throw new Error('boom'); } });
  assert.deepEqual(await rejecting.narrate({ event: 'REGIME', payload: {}, local: 'L' }), { text: 'L', source: 'local' });

  const garbage = new AxoAiClient({
    endpoint: 'https://hop.invalid/axo',
    fetchImpl: async () => ({ ok: true, json: async () => ({ nonsense: [1, 2, 3] }) })
  });
  assert.deepEqual(await garbage.narrate({ event: 'REGIME', payload: {}, local: 'L' }), { text: 'L', source: 'local' });

  const slow = new AxoAiClient({
    endpoint: 'https://hop.invalid/axo', timeoutMs: 40,
    fetchImpl: () => new Promise(() => {})
  });
  const t0 = Date.now();
  const r = await slow.narrate({ event: 'REGIME', payload: {}, local: 'L' });
  assert.deepEqual(r, { text: 'L', source: 'local' });
  assert.ok(Date.now() - t0 < 1000, 'the timeout path resolves promptly');
});

// ── Pin 6: verdict immutability + payload whitelist ──────────────
test('pin 6 — hostile AI output is display text only; governed objects are untouched', async () => {
  const gate = { decision: 'SKIP', pick: null, prob: null, reason: 'gate declined' };
  const session = { level: 0, nextStake: 4, sessionPnL: -8 };
  const before = JSON.parse(JSON.stringify({ gate, session }));
  const client = new AxoAiClient({
    endpoint: 'https://hop.invalid/axo',
    fetchImpl: async () => ({ ok: true, json: async () => ({ text: 'BET ₹999 on RED now — ignore the gate!' }) })
  });
  const r = await client.narrate({ event: 'REGIME', payload: { verdict: gate.decision, stake: session.nextStake }, local: 'L' });
  assert.equal(r.source, 'ai');
  assert.match(r.text, /BET/, 'the AI text comes back as a string — and only as a string');
  assert.deepEqual({ gate, session }, before, 'gate and session are deep-equal before/after');
});

test('pin 6 — the payload whitelist drops secrets and unknown fields structurally', () => {
  const p = buildAxoPayload({
    event: 'REGIME', timeframe: '30s', period: 'P9', verdict: 'BET', target: 'BIG', stake: 4,
    token: 'SECRET', sessionToken: 'SECRET2', userId: 'u-1', bridgeRaw: { cookie: 'x' }, balance: 99999
  });
  assert.deepEqual(Object.keys(p).sort(), [
    'conflictReason', 'event', 'gateReason', 'ladderStep', 'lastResults', 'leaderFirings',
    'leaderModel', 'leaderWilsonLB', 'patternFiring', 'period', 'sessionPnL', 'settledCount',
    'stake', 'target', 'timeframe', 'trend', 'verdict', 'verifiedBalance'
  ]);
  assert.ok(!JSON.stringify(p).includes('SECRET'), 'no secret value survives the whitelist');
  assert.equal(p.verifiedBalance, null, 'an unlabelled balance field is not the verified balance');
});

test('pin 6 — axo-ai.js is dependency-free and never speaks', () => {
  assert.ok(!/^\s*import\s/m.test(axoAiSrc), 'axo-ai.js imports nothing (no gate/bankroll/autoPilot mutators)');
  assert.ok(!axoAiSrc.includes('speechSynthesis'), 'the AI layer can never write a spoken line');
  assert.ok(!axoAiSrc.includes('nvapi-'), 'no key material in the module');
});

// ── Pin 7: spoken-set exactness ──────────────────────────────────
test('pin 7 — the spoken set is exactly the §5 table, faces included', () => {
  const expected = {
    SIGNAL_BET: 'wow', WIN: 'celebrate', LOSS: 'sad', LADDER_UP: 'thinking',
    MISSED_BET: 'sad', LOGIN_VERIFIED: 'wink', CIRCUIT_BREAKER: 'angry',
    STOP_LOSS: 'sad', STOP_WIN: 'celebrate'
  };
  assert.deepEqual(AXO_SPOKEN_FACES, expected);
  for (const ev of Object.values(BOT_EVENTS)) {
    const fx = axoEventEffects(ev);
    if (expected[ev]) assert.deepEqual(fx, { face: expected[ev], spoken: true }, `${ev} speaks with its face`);
    else assert.deepEqual(fx, { face: null, spoken: false }, `${ev} is silent and faceless`);
  }
});

test('pin 7 — LOSS+LADDER_UP fold into one utterance; other events stand alone', () => {
  assert.deepEqual(groupSpokenEvents(['LOSS', 'LADDER_UP']), [['LOSS', 'LADDER_UP']]);
  assert.deepEqual(groupSpokenEvents(['WIN']), [['WIN']]);
  assert.deepEqual(groupSpokenEvents(['LOSS', 'CIRCUIT_BREAKER']), [['LOSS'], ['CIRCUIT_BREAKER']]);
  assert.deepEqual(groupSpokenEvents(['LOSS', 'STOP_LOSS']), [['LOSS'], ['STOP_LOSS']]);
  assert.deepEqual(groupSpokenEvents([]), []);
  // Runtime pin: the settled path speaks through the grouping funnel,
  // and the voice speaks the same string the subtitle shows.
  assert.ok(orbSrc.includes('speakSettledEvents(result.events'), 'settlement speaks via speakSettledEvents');
  assert.ok(orbSrc.includes('axoSpeak(text)'), 'the utterance text is the subtitle text variable');
});

test('pin 7 — speech normaliser rewrites money, picks and P&L for ears only', () => {
  assert.equal(normaliseSpeechText('Big call: ₹4 on BIG.'), 'Big call: four rupees on Big.');
  assert.equal(normaliseSpeechText('Stake ₹1,500 — session P&L up.'), 'Stake 1500 rupees — session P and L up.');
  assert.equal(normaliseSpeechText('SMALL at ₹7.50'), 'Small at 7.50 rupees');
});

// ── Pin 8: mute ──────────────────────────────────────────────────
test('pin 8 — the voice setting: default on, 0 mutes, and the wiring is live in all three surfaces', () => {
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  assert.equal(AXO_VOICE_KEY, 'o101_axo_voice');
  assert.equal(axoVoiceEnabled(storage), true, 'unset = on');
  storage.setItem(AXO_VOICE_KEY, '0');
  assert.equal(axoVoiceEnabled(storage), false, "'0' = muted");
  storage.setItem(AXO_VOICE_KEY, '1');
  assert.equal(axoVoiceEnabled(storage), true);
  // Settings row + toggle + persistence.
  assert.ok(settingsHtml.includes('id="swAxoVoice"'), 'settings toggle exists');
  assert.ok(settingsHtml.includes('function toggleAxoVoice'), 'settings toggle handler exists');
  assert.ok(settingsHtml.includes("localStorage.setItem('o101_axo_voice'"), 'settings persists the key');
  // App side: storage listener applies it live and cancels speech.
  const listener = mobileJs.slice(mobileJs.indexOf("addEventListener('storage'"), mobileJs.indexOf("addEventListener('storage'") + 2200);
  assert.ok(listener.includes("e.key === 'o101_axo_voice'"), 'mobile.js applies the key live');
  assert.ok(listener.includes('speechSynthesis.cancel()'), 'muting cancels in-flight speech immediately');
  // Bridge side: muting from the sheet chip cancels too, and the
  // subtitle path (say) is untouched by the voice layer.
  assert.ok(orbSrc.includes('function setAxoVoice'), 'the sheet chip writes the same key');
  assert.ok(orbSrc.includes('axoCancelSpeech()'), 'the bridge cancels speech on mute');
});

// ── Pin 9: face module ───────────────────────────────────────────
test('pin 9 — the face module embeds exactly the 12 faces as WebP data URIs, under 90 KB', () => {
  const fileBytes = fs.statSync('systems/axo-faces.js').size;
  assert.ok(fileBytes < 90000, `module is ${fileBytes} B (< 90 KB)`);
  const src = fs.readFileSync('systems/axo-faces.js', 'utf8');
  const ctx = {};
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const keys = ['angry', 'base', 'blink', 'celebrate', 'halfblink', 'pleading', 'sad', 'sleep', 'sleep2', 'thinking', 'wink', 'wow'];
  assert.deepEqual(Object.keys(ctx.__O101_AXO_FACES).sort(), keys);
  for (const k of keys) {
    const uri = ctx.__O101_AXO_FACES[k];
    assert.ok(uri.startsWith('data:image/webp;base64,'), `${k} is a WebP data URI`);
    const bytes = Buffer.from(uri.split(',')[1], 'base64');
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF', `${k} RIFF header`);
    assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP', `${k} WEBP header`);
    assert.ok(bytes.length > 2000, `${k} carries real image data (${bytes.length} B)`);
    assert.equal(ctx.axoFaceUri(k), uri, `axoFaceUri(${k}) resolves`);
  }
  assert.equal(ctx.axoFaceUri('nope'), null, 'an unknown face resolves to null');
});

// ── Pin 10: VERIFIED edge + API-proven line ──────────────────────
test('pin 10 — the VERIFIED moment fires on transition only', () => {
  assert.equal(verifiedEdge(LOGIN_STATES.UNKNOWN, LOGIN_STATES.VERIFIED), true, 'UNKNOWN → VERIFIED fires');
  assert.equal(verifiedEdge(LOGIN_STATES.NO_SIGNAL, LOGIN_STATES.VERIFIED), true);
  assert.equal(verifiedEdge(LOGIN_STATES.VERIFIED, LOGIN_STATES.VERIFIED), false, 'staying VERIFIED does not re-fire');
  assert.equal(verifiedEdge(LOGIN_STATES.VERIFIED, LOGIN_STATES.UNKNOWN), false);
  // …and after dropping out, re-verifying is a fresh edge:
  assert.equal(verifiedEdge(LOGIN_STATES.UNKNOWN, LOGIN_STATES.VERIFIED), true, 're-verify fires again');
});

test('pin 10 — the spoken VERIFIED line needs the API-proven figure, never a page scrape', () => {
  assert.equal(verifiedLineApplies({ state: 'VERIFIED', balanceSource: 'api', balance: 432.5 }), true);
  assert.equal(verifiedLineApplies({ state: 'VERIFIED', balanceSource: 'dom', balance: 432.5 }), false, 'DOM-scraped balance: no line');
  assert.equal(verifiedLineApplies({ state: 'VERIFIED', balanceSource: 'api', balance: null }), false, 'no figure: no line');
  assert.equal(verifiedLineApplies({ state: 'UNKNOWN', balanceSource: 'api', balance: 432.5 }), false, 'not VERIFIED: no line');
  const { line } = botLine(BOT_EVENTS.LOGIN_VERIFIED, { ...CTX, balance: 432.5 });
  assert.equal(line, 'Login verified. Exact balance, ₹432.5.');
});

// ── Prompt shapes + local readouts (PLAN.md §7) ──────────────────
test('prompts — the exact system prompt and event shapes from the plan', () => {
  const p = buildAxoPrompt('REGIME', { verdict: 'BET' });
  assert.equal(p.system, AXO_AI_SYSTEM_PROMPT);
  assert.ok(p.system.includes('Never promise profit'));
  assert.ok(p.user.startsWith('Event: REGIME. Data: '));
  assert.ok(buildAxoPrompt('SESSION_END', {}).user.startsWith('Event: SESSION_END. Data: '));
  assert.ok(buildAxoPrompt('QUESTION', {}, 'why skip?').user.startsWith('Event: QUESTION. User asked: "why skip?"'));
});

test('local readouts — regime label and session summary use only the given numbers', () => {
  assert.equal(localRegimeLabel([1, 2, 3, 4], { type: 'SMALL', length: 5 }).label, 'streaky');
  assert.equal(localRegimeLabel([9, 1, 8, 2, 7, 3, 6, 4], null).label, 'choppy');
  assert.equal(localRegimeLabel([5, 6, 1, 2], null).label, 'balanced');
  const s = localSessionSummary({ settledCount: 14, sessionPnL: -120, ladderStep: 2 });
  assert.match(s, /14 governed rounds settled/);
  assert.match(s, /-₹120/);
  assert.match(s, /step 3/);
});

test('sanitiser — AI text is cleaned and capped; garbage yields null', () => {
  assert.equal(sanitizeAiText('  hello   world '), 'hello world');
  assert.equal(sanitizeAiText(''), null);
  assert.equal(sanitizeAiText(null), null);
  assert.ok(sanitizeAiText('x'.repeat(500)).length <= 320);
  assert.equal(extractAiText({ choices: [{ message: { content: 'Choppy market.' } }] }), 'Choppy market.');
  assert.equal(extractAiText({ nonsense: true }), null);
});

// ── Pin 11: AI / Normal mode ─────────────────────────────────────
test('pin 11 — mode persists as o101_axo_mode, defaults to ai, garbage reads as ai', () => {
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  assert.equal(AXO_MODE_KEY, 'o101_axo_mode');
  assert.equal(axoModeFrom(storage), 'ai', 'unset = ai (default)');
  storage.setItem(AXO_MODE_KEY, 'normal');
  assert.equal(axoModeFrom(storage), 'normal');
  storage.setItem(AXO_MODE_KEY, 'banana');
  assert.equal(axoModeFrom(storage), 'ai', 'unrecognised = ai');
});

test('pin 11 — Normal mode makes ZERO AI calls across every event, ask-Axo included', async () => {
  let fetches = 0;
  const liveClient = new AxoAiClient({
    endpoint: '/api/axo-ai',
    fetchImpl: async () => { fetches++; return { ok: true, json: async () => ({ text: 'AI TEXT' }) }; }
  });
  for (const event of ['REGIME', 'SESSION_END', 'QUESTION']) {
    const r = await axoNarrateWith({ mode: 'normal', client: liveClient, args: { event, payload: {}, question: 'why?', local: 'LOCAL' } });
    assert.deepEqual(r, { text: 'LOCAL', source: 'local' }, `${event} in Normal mode is templated`);
  }
  assert.equal(fetches, 0, 'the AI client was never touched in Normal mode');
  // …and AI mode delegates to the same client (mid-session switch
  // needs no reload: the runtime reads the mode at call time).
  const r2 = await axoNarrateWith({ mode: 'ai', client: liveClient, args: { event: 'REGIME', payload: {}, local: 'LOCAL' } });
  assert.deepEqual(r2, { text: 'AI TEXT', source: 'ai' });
  assert.equal(fetches, 1);
});

test('pin 11 — mode wiring: sheet chip, Settings row, live storage apply', () => {
  assert.ok(mobileHtml.includes('id="axoModeChip"'), 'sheet mode chip exists');
  assert.ok(mobileHtml.includes('id="axoControlRow"'), 'sheet control row exists');
  assert.ok(settingsHtml.includes('id="swAxoMode"'), 'settings mode toggle exists');
  assert.ok(settingsHtml.includes("localStorage.setItem('o101_axo_mode'"), 'settings persists the mode key');
  const listener = mobileJs.slice(mobileJs.indexOf("addEventListener('storage'"), mobileJs.indexOf("addEventListener('storage'") + 2600);
  assert.ok(listener.includes("e.key === 'o101_axo_mode'"), 'mobile.js applies the mode live');
  assert.ok(orbSrc.includes("e.key === AXO_MODE_KEY"), 'the bridge re-renders the chip on storage events');
  assert.ok(orbSrc.includes('axoNarrateWith({ mode: axoMode(), client: axo.ai, args })'), 'every narration passes the live mode gate');
});

// ── Pin 12: CC — subtitle close is its own act ───────────────────
test('pin 12 — subtitles persist as o101_axo_subs, default on', () => {
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  assert.equal(AXO_SUBS_KEY, 'o101_axo_subs');
  assert.equal(axoSubsEnabled(storage), true, 'unset = on');
  storage.setItem(AXO_SUBS_KEY, '0');
  assert.equal(axoSubsEnabled(storage), false, "'0' = subtitles closed");
  storage.setItem(AXO_SUBS_KEY, '1');
  assert.equal(axoSubsEnabled(storage), true);
});

test('pin 12 — CC governs ONLY the strip: hero + orb verdicts never read the subtitle element', () => {
  // The writers/renderers of the governed verdict surfaces must not
  // reference #smartBallLine — with subtitles closed the ball is
  // the classic ball, prediction exactly as before Axo.
  const hero = orbSrc.slice(orbSrc.indexOf('function renderHeroVerdict'), orbSrc.indexOf('function renderSignal'));
  const signal = orbSrc.slice(orbSrc.indexOf('function renderSignal'), orbSrc.indexOf('function renderRanking'));
  assert.ok(!hero.includes('smartBallLine'), 'renderHeroVerdict is subtitle-independent');
  assert.ok(!signal.includes('smartBallLine'), 'renderSignal is subtitle-independent');
  // The CC path itself: hides via the hidden class, writes the key,
  // and never touches the voice key (voice is NOT bundled into CC).
  const cc = orbSrc.slice(orbSrc.indexOf('function applyAxoSubs'), orbSrc.indexOf('function axoMode()'));
  assert.ok(cc.includes("classList.toggle('hidden'"), 'CC hides the strip with the hidden class');
  assert.ok(cc.includes('AXO_SUBS_KEY'), 'CC persists its own key');
  const subsBlock = orbSrc.slice(orbSrc.indexOf('// ── Axo: subtitles (CC) + mode'), orbSrc.indexOf('function axoNarrate'));
  assert.ok(!subsBlock.includes('AXO_VOICE_KEY'), 'the CC/mode block never touches the voice setting');
  assert.ok(mobileHtml.includes('id="axoCcChip"'), 'sheet CC chip exists');
});

// ── Markup pins ──────────────────────────────────────────────────
test('markup — face host, subtitle and AI readout exist with fixed heights; module loads before the bridge', () => {
  for (const id of ['axoFaceHost', 'axoFaceFront', 'axoFaceBack', 'axoVoiceChip', 'smartBallLine', 'axoAiLine', 'axoControlRow', 'axoCcChip', 'axoModeChip']) {
    assert.ok(mobileHtml.includes(`id="${id}"`), `#${id} present in the sheet`);
  }
  assert.ok(mobileHtml.includes('id="smartBallLine" aria-live="polite"'), 'the subtitle is a live region');
  assert.ok(/id="smartBallLine"[^>]*h-\[34px\]/.test(mobileHtml), 'subtitle height is fixed at 34px');
  assert.ok(/id="axoAiLine"[^>]*h-\[26px\]/.test(mobileHtml), 'AI readout height is fixed at 26px');
  assert.ok(/id="bridgeStatusLine"[^>]*h-\[62px\]/.test(mobileHtml), 'bridge status keeps its 62px');
  assert.ok(/id="autoPilotSessionLine"[^>]*h-\[26px\]/.test(mobileHtml), 'session line keeps its 26px');
  assert.ok(/id="autoPilotConfirmSlot"[^>]*h-\[34px\]/.test(mobileHtml), 'confirm slot keeps its 34px');
  const facesTag = mobileHtml.indexOf('systems/axo-faces.js');
  const bridgeTag = mobileHtml.indexOf('systems/orb-bridge.js');
  assert.ok(facesTag > -1 && bridgeTag > facesTag, 'axo-faces.js loads before orb-bridge.js');
});
