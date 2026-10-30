/**
 * =============================================================================
 * mobile.js  –  01:01 (Mobile Orchestrator)
 * WinGo Color Prediction App — Firebase RTDB: zer0one-376d1
 * =============================================================================
 * Rebuilt from: mobile.html, generate_clean_mobile.cjs, patch_mobile_js.js,
 *               timeframe_manager.js, wingo_30s.js, wingo_1m.js,
 *               quant_algorithm.js, arena_models.js
 * =============================================================================
 */

'use strict';

// ── 1. Constants & Global State ──────────────────────────────────────────────

const TF_CODES = { '30s': '10005', '1m': '10001', '3m': '10002', '5m': '10003' };
const TF_SECONDS = { '30s': 30, '1m': 60, '3m': 180, '5m': 300 };
const TF_TYPE_IDS = { '30s': 1, '1m': 2, '3m': 3, '5m': 4 };

const RTDB_BASE = 'https://zer0one-376d1-default-rtdb.asia-southeast1.firebasedatabase.app';

const MobileState = {
  // Default timeframe: the Settings page's "Default Interval"
  // (quant_default_tf) wins; the last in-app choice
  // (dhaniwin_last_interval) is the fallback. Before this wiring the
  // settings value was written but never read.
  timeframe: (() => {
    try {
      const ok = ['30s', '1m', '3m', '5m'];
      const fromSettings = localStorage.getItem('quant_default_tf');
      if (ok.includes(fromSettings)) return fromSettings;
      const last = localStorage.getItem('dhaniwin_last_interval');
      if (ok.includes(last)) return last;
    } catch (e) {}
    return '30s';
  })(),
  historyByTf: { '30s': [], '1m': [], '3m': [], '5m': [] },
  activePrediction: { period: null, target: null, type: 'SIZE', inChargeModel: null },
  scheduledPredictionsByPeriod: {},
  lastCelebratedPeriodByTf: { '30s': null, '1m': null, '3m': null, '5m': null },
  inChargeModel: null,
  // Per-timeframe in-charge (owner order 2026-10-30): each of the 4 WinGo
  // timeframes elects and keeps its own in-charge model independently.
  // MobileState.inChargeModel always mirrors the ACTIVE timeframe's entry
  // (backward compat for all existing readers).
  inChargeByTf: { '30s': null, '1m': null, '3m': null, '5m': null },
  autoMode: true,
  cloudUniversalState: { '30s': null, '1m': null, '3m': null, '5m': null },
  userModelStats: {},
  modelPools: {},
  chart: null,
  candleSeries: null,
  chartMode: (() => { try { return localStorage.getItem('quant_chart_mode') || 'candles'; } catch(e) { return 'candles'; } })(),
  sim: {
    running: false,
    balance: 10000,
    // Base stake boots from the shared settings value (quant_sim_stake,
    // written by the Settings page and by setSimBaseStake).
    baseStake: (() => { try { const v = parseInt(localStorage.getItem('quant_sim_stake') || '10', 10); return Number.isFinite(v) && v > 0 ? v : 10; } catch (e) { return 10; } })(),
    stake: (() => { try { const v = parseInt(localStorage.getItem('quant_sim_stake') || '10', 10); return Number.isFinite(v) && v > 0 ? v : 10; } catch (e) { return 10; } })(),
    level: 0,
    pendingBet: null,
    totalBets: 0,
    wins: 0,
    losses: 0,
    pnl: 0
  },
  boundaryRetryTimers: {},
  pollIntervalIds: {},
  soundEnabled: true,
  hapticsEnabled: true,
  outsideNotif: false,
  bgKeepAliveEnabled: (() => { try { return localStorage.getItem('quant_bg_keepalive') !== '0'; } catch(e) { return true; } })(),
  wakeLockEnabled: (() => { try { return localStorage.getItem('quant_wakelock') === '1'; } catch(e) { return false; } })(),
  auditStats: {
    total: 0, wins: 0, losses: 0,
    maxWinStreak: 0, maxLossStreak: 0, curStreak: 0
  },
  inchargeConfig: (() => {
    try {
      const saved = localStorage.getItem('quant_incharge_settings');
      return saved ? JSON.parse(saved) : {
        predictionSource: 'LOCAL',
        mode: 'WINNING_STREAK_OVERRIDE',
        minStreak: 3,
        minEvaluated: 10
      };
    } catch(e) {
      return {
        predictionSource: 'LOCAL',
        mode: 'WINNING_STREAK_OVERRIDE',
        minStreak: 3,
        minEvaluated: 10
      };
    }
  })(),
  workerStateByTf: { '30s': null, '1m': null, '3m': null, '5m': null }
};

window.MobileState = MobileState;

// ── 1B. Web Worker Model Compute Engine & Incharge Controller ────────────────

let modelWorker = null;

function initModelWorker() {
  if (typeof Worker === 'undefined') {
    console.warn('[ModelWorker] Web Workers not supported in this environment.');
    return;
  }

  try {
    modelWorker = new Worker('src/workers/modelWorker.js');
  } catch (e) {
    try {
      modelWorker = new Worker('modelWorker.js');
    } catch (e2) {
      console.warn('[ModelWorker] Failed to create Worker instance:', e2);
      return;
    }
  }

  modelWorker.onmessage = function (e) {
    const { type, timeframe, activeIncharge, inchargeState, allModelStats } = e.data || {};
    const currentTf = MobileState.timeframe;

    switch (type) {
      case 'HISTORY_INITIALIZED':
      case 'PREDICTIONS_UPDATED': {
        if (timeframe) {
          MobileState.workerStateByTf[timeframe] = {
            activeIncharge,
            inchargeState,
            allModelStats
          };
          if (Array.isArray(allModelStats) && allModelStats.length > 0) {
            MobileState.modelPools[timeframe] = allModelStats;
          }
          // Per-timeframe in-charge (owner order 2026-10-30): the worker
          // elects per-tf; remember each tf's leader independently.
          if (MobileState.inChargeByTf && activeIncharge?.model?.name) {
            MobileState.inChargeByTf[timeframe] = activeIncharge.model.name;
          }
        }

        if (timeframe === currentTf) {
          if (MobileState.inchargeConfig.predictionSource === 'LOCAL' && activeIncharge) {
            MobileState.inChargeModel = activeIncharge.model?.name || MobileState.inChargeModel;
          }
          renderAuthoritativeAIPrediction(MobileState.historyByTf[currentTf] || []);
          renderModelRosterUI();
        }
        break;
      }

      case 'CONFIG_UPDATED':
      case 'SESSION_RESET': {
        if (timeframe && timeframe !== 'all') {
          if (activeIncharge) {
            MobileState.workerStateByTf[timeframe] = {
              activeIncharge,
              allModelStats
            };
          }
        }
        renderAuthoritativeAIPrediction(MobileState.historyByTf[currentTf] || []);
        renderModelRosterUI();
        break;
      }
    }
  };

  modelWorker.onerror = function (err) {
    console.warn('[ModelWorker] Worker error:', err.message || err);
  };

  // Sync initial config
  modelWorker.postMessage({
    type: 'SET_CONFIG',
    data: { config: MobileState.inchargeConfig, timeframe: MobileState.timeframe }
  });
}

function setPredictionSource(source) {
  const s = source === 'CLOUD' ? 'CLOUD' : 'LOCAL';
  MobileState.inchargeConfig.predictionSource = s;
  try {
    localStorage.setItem('quant_incharge_settings', JSON.stringify(MobileState.inchargeConfig));
  } catch(e) {}

  updatePredictionSourceUI();

  if (modelWorker) {
    modelWorker.postMessage({
      type: 'SET_CONFIG',
      data: { config: MobileState.inchargeConfig, timeframe: MobileState.timeframe }
    });
  }

  renderAuthoritativeAIPrediction(MobileState.historyByTf[MobileState.timeframe] || []);
  renderModelRosterUI();
  showToast(`Prediction engine switched to ${s === 'LOCAL' ? 'Local 53-Model Web Worker' : 'Cloud Server Stream'}.`, 'success');
}
window.setPredictionSource = setPredictionSource;

function updatePredictionSourceUI() {
  const s = MobileState.inchargeConfig.predictionSource || 'LOCAL';
  const localBtn = $('sourceBtnLocal');
  const cloudBtn = $('sourceBtnCloud');
  const badge = $('activeEngineBadge');
  const desc = $('predSourceDesc');

  if (s === 'LOCAL') {
    if (localBtn) localBtn.className = 'px-2.5 py-1.5 rounded-lg text-[9px] font-mono font-bold transition flex items-center justify-center gap-1.5 bg-amber-500/25 text-amber-300 border border-amber-500/40 shadow-sm';
    if (cloudBtn) cloudBtn.className = 'px-2.5 py-1.5 rounded-lg text-[9px] font-mono font-bold transition flex items-center justify-center gap-1.5 text-zinc-400 hover:text-white border border-transparent';
    if (badge) {
      badge.textContent = 'LOCAL 53';
      badge.className = 'text-[8px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30';
    }
    if (desc) desc.textContent = 'Fastest: Client Web Worker';
  } else {
    if (localBtn) localBtn.className = 'px-2.5 py-1.5 rounded-lg text-[9px] font-mono font-bold transition flex items-center justify-center gap-1.5 text-zinc-400 hover:text-white border border-transparent';
    if (cloudBtn) cloudBtn.className = 'px-2.5 py-1.5 rounded-lg text-[9px] font-mono font-bold transition flex items-center justify-center gap-1.5 bg-purple-500/25 text-purple-300 border border-purple-500/40 shadow-sm';
    if (badge) {
      badge.textContent = 'CLOUD STREAM';
      badge.className = 'text-[8px] font-mono px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30';
    }
    if (desc) desc.textContent = 'Synced: Cloud Server Stream';
  }

  const modeSelect = $('inchargeModeSelect');
  if (modeSelect) modeSelect.value = MobileState.inchargeConfig.mode || 'WINNING_STREAK_OVERRIDE';

  const streakInput = $('inchargeMinStreakInput');
  if (streakInput) streakInput.value = MobileState.inchargeConfig.minStreak || 3;
}
window.updatePredictionSourceUI = updatePredictionSourceUI;

function setInchargeMode(mode) {
  MobileState.inchargeConfig.mode = mode;
  try {
    localStorage.setItem('quant_incharge_settings', JSON.stringify(MobileState.inchargeConfig));
  } catch(e) {}

  if (modelWorker) {
    modelWorker.postMessage({
      type: 'SET_CONFIG',
      data: { config: MobileState.inchargeConfig, timeframe: MobileState.timeframe }
    });
  }

  renderAuthoritativeAIPrediction(MobileState.historyByTf[MobileState.timeframe] || []);
  renderModelRosterUI();
  showToast(`In-Charge mode changed to ${mode}.`, 'info');
}
window.setInchargeMode = setInchargeMode;

function setInchargeMinStreak(val) {
  const n = Math.max(2, Math.min(10, parseInt(val, 10) || 3));
  MobileState.inchargeConfig.minStreak = n;
  try {
    localStorage.setItem('quant_incharge_settings', JSON.stringify(MobileState.inchargeConfig));
  } catch(e) {}

  if (modelWorker) {
    modelWorker.postMessage({
      type: 'SET_CONFIG',
      data: { config: MobileState.inchargeConfig, timeframe: MobileState.timeframe }
    });
  }

  renderAuthoritativeAIPrediction(MobileState.historyByTf[MobileState.timeframe] || []);
  renderModelRosterUI();
}
window.setInchargeMinStreak = setInchargeMinStreak;

async function hydrate24HourHistory(tf) {
  let history = [];
  try {
    const res = await fetch(`/api/history/24h?interval=${tf}`, { signal: AbortSignal.timeout(3500) });
    const contentType = res.headers.get('content-type') || '';
    if (res.ok && contentType.includes('application/json')) {
      const data = await res.json();
      history = Array.isArray(data?.history) ? data.history : (Array.isArray(data?.records) ? data.records : []);
    }
  } catch (e) {}

  // Static Firebase Hosting has no Node API runtime; use the same live feed fallback there.
  if (history.length === 0 && typeof fetchLiveHistoryFromDirectAPI === 'function') {
    try {
      const fallbackHistory = await fetchLiveHistoryFromDirectAPI(tf);
      if (Array.isArray(fallbackHistory)) history = fallbackHistory;
    } catch (e) {}
  }
  if (history.length === 0) return;

  console.log(`[Hydrate] Loaded ${history.length} history rounds for ${tf}`);
  if (modelWorker) {
    modelWorker.postMessage({
      type: 'INIT_24H_HISTORY',
      data: { timeframe: tf, history, config: MobileState.inchargeConfig }
    });
  }
  applyCloudHistory(tf, history);
}
window.hydrate24HourHistory = hydrate24HourHistory;

// ── 2. Helper Utilities ───────────────────────────────────────────────────────

function $ (id) { return document.getElementById(id); }

function setText(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

function showToast(msg, type = 'info') {
  console.log(`[Toast][${type}] ${msg}`);
}

function hapticFeedback(pattern) {
  if (!MobileState.hapticsEnabled) return;
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern || 40); } catch(e) {}
  }
}

// ── Auth Detection Helper ──────────────────────────────────────────────────────
// Checks session auth signals only. NOTE: the DhaniWin iframe is cross-origin, so
// iframe.src never reflects internal redirects (e.g. to /login on session timeout).
// It must therefore NOT be used as a login signal. 'dhaniwin_registered' only means
// the user has an account (→ show Login instead of Register), not an active session.
function isUserLoggedIn() {
  try {
    if (localStorage.getItem('dhaniwin_is_logged_in') === 'true') return true;
    if (localStorage.getItem('dhaniwin_logged_in') === '1') return true;
    // NOTE: login is never derived from a raw session token anymore
    // (the old 'ar_token' leg is removed with the credential fix).
  } catch(e) {}
  return false;
}
window.isUserLoggedIn = isUserLoggedIn;

/** Display-only short period: the last 4 digits, never the full
 *  number (fix round #2). Internal period identity (locks, keys,
 *  history records) always stays the full string. */
function shortPeriodStr(p) {
  if (p === null || p === undefined) return '';
  const s = String(p);
  return s ? s.slice(-4) : '';
}
window.shortPeriodStr = shortPeriodStr;

let _authGracePeriodUntil = 0;

function isAuthGracePeriodActive() {
  const now = Date.now();
  if (now < _authGracePeriodUntil) return true;
  try {
    const raw = sessionStorage.getItem('dhaniwin_auth_grace_until');
    if (raw && now < Number(raw)) return true;
  } catch(e) {}
  return false;
}
window.isAuthGracePeriodActive = isAuthGracePeriodActive;

// Mark login in all localStorage keys at once
function markUserLoggedIn() {
  const until = Date.now() + 15000; // 15-second protected grace period post-login
  _authGracePeriodUntil = until;
  try {
    sessionStorage.setItem('dhaniwin_auth_grace_until', String(until));
    localStorage.setItem('dhaniwin_is_logged_in', 'true');
    localStorage.setItem('dhaniwin_logged_in', '1');
    localStorage.setItem('dhaniwin_registered', '1');
  } catch(e) {}
}
window.markUserLoggedIn = markUserLoggedIn;

// Clear all login keys (only on confirmed session-out). NOTE: the
// app's OWN keys only — DhaniWin's session key 'ar_token' is NEVER
// deleted here. The app page and the DhaniWin frame share one origin
// (the worker host) and therefore one localStorage, so 'ar_token' IS
// the live DhaniWin session; deleting it would kill a live login.
// DhaniWin's own logout flow owns its token.
function markUserLoggedOut() {
  _authGracePeriodUntil = 0;
  try {
    localStorage.removeItem('dhaniwin_is_logged_in');
    localStorage.removeItem('dhaniwin_logged_in');
    sessionStorage.removeItem('dhaniwin_auth_grace_until');
  } catch(e) {}
  try {
    if (window.MobileBridgeState) {
      window.MobileBridgeState.authToken = null;
      window.MobileBridgeState.userId = null;
      window.MobileBridgeState.enabled = false;
    }
    const uIdEl = document.getElementById('mobileWebUserId');
    if (uIdEl) uIdEl.textContent = 'ID: --';
  } catch(e) {}
}
window.markUserLoggedOut = markUserLoggedOut;



// Sound Effects Engine (Siu on Win / Brhh on Loss) - Strictly Single Instance Concurrency
const _soundPool = {
  win: null,
  loss: null
};

let _lastSoundTimestamp = 0;
let _currentPlayingAudio = null;

function stopAllSoundEffects() {
  if (_currentPlayingAudio) {
    try {
      _currentPlayingAudio.pause();
      _currentPlayingAudio.currentTime = 0;
    } catch(e) {}
    _currentPlayingAudio = null;
  }
}
window.stopAllSoundEffects = stopAllSoundEffects;

function getAudioElement(type) {
  try {
    if (typeof Audio === 'undefined') return null;
    const isWin = type === 'win';
    const key = isWin ? 'win' : 'loss';
    if (!_soundPool[key]) {
      let canPlayOgg = false;
      try {
        const testAudio = document.createElement('audio');
        canPlayOgg = !!(testAudio.canPlayType && testAudio.canPlayType('audio/ogg; codecs="vorbis"').replace(/no/, ''));
      } catch(e) {}

      // Prioritize OGG where supported, otherwise use WAV for universal iOS Safari / Android support
      const src = isWin 
        ? (canPlayOgg ? 'sounds/win_siu.ogg' : 'sounds/win_siu.wav')
        : (canPlayOgg ? 'sounds/loss_brhh.ogg' : 'sounds/loss_brhh.wav');

      const audio = new Audio(src);
      audio.preload = 'auto';
      _soundPool[key] = audio;
    }
    return _soundPool[key];
  } catch(e) {
    return null;
  }
}

// User interaction unlocker for mobile browser autoplay policies (Android, iOS Safari, PWA)
let _audioUnlocked = false;
function unlockAudioOnInteraction() {
  if (_audioUnlocked) return;
  _audioUnlocked = true;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      if (!window._sharedAudioCtx) window._sharedAudioCtx = new AudioCtx();
      if (window._sharedAudioCtx.state === 'suspended') {
        window._sharedAudioCtx.resume().catch(() => {});
      }
    }
    const w = getAudioElement('win');
    const l = getAudioElement('loss');
    if (w) w.load();
    if (l) l.load();
  } catch(e) {}
}
if (typeof window !== 'undefined') {
  window.addEventListener('click', unlockAudioOnInteraction, { once: true, passive: true });
  window.addEventListener('touchstart', unlockAudioOnInteraction, { once: true, passive: true });
  window.addEventListener('pointerdown', unlockAudioOnInteraction, { once: true, passive: true });
}

function playSynthFallback(type) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!window._sharedAudioCtx) {
      window._sharedAudioCtx = new AudioCtx();
    }
    const ctx = window._sharedAudioCtx;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    if (type === 'win') {
      // Suii Celebration Fanfare + Exuberant Vocal Glissando
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();
      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.type = 'sine';
      osc2.type = 'triangle';

      const t0 = ctx.currentTime;
      osc1.frequency.setValueAtTime(523.25, t0);        // C5
      osc1.frequency.setValueAtTime(659.25, t0 + 0.12); // E5
      osc1.frequency.setValueAtTime(783.99, t0 + 0.24); // G5
      osc1.frequency.exponentialRampToValueAtTime(1320, t0 + 0.55); // High SUII glide!

      osc2.frequency.setValueAtTime(261.63, t0);
      osc2.frequency.exponentialRampToValueAtTime(660, t0 + 0.55);

      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.35, t0 + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.75);

      osc1.start(t0);
      osc2.start(t0);
      osc1.stop(t0 + 0.75);
      osc2.stop(t0 + 0.75);
    } else {
      // Bruh Low Resonant Comic Vocal Drop
      const osc = ctx.createOscillator();
      const subOsc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();

      osc.connect(filter);
      subOsc.connect(gain);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sawtooth';
      subOsc.type = 'sine';

      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(650, ctx.currentTime);
      filter.Q.setValueAtTime(3.0, ctx.currentTime);

      const t0 = ctx.currentTime;
      osc.frequency.setValueAtTime(160, t0);
      osc.frequency.exponentialRampToValueAtTime(65, t0 + 0.45); // Comic drop to 65Hz

      subOsc.frequency.setValueAtTime(80, t0);
      subOsc.frequency.exponentialRampToValueAtTime(45, t0 + 0.45);

      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(0.35, t0 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);

      osc.start(t0);
      subOsc.start(t0);
      osc.stop(t0 + 0.55);
      subOsc.stop(t0 + 0.55);
    }
  } catch(e) {}
}

let _pendingBgSound = null; // { type, period, tf } — period-stamped (RC4) so foreground return drops stale rounds

function playSoundEffect(type, force = false, meta = null) {
  // CRITICAL REQUIREMENT 1: Only 'win' and 'loss' have associated sounds. Ignore 'click' or any other type completely!
  if (type !== 'win' && type !== 'loss') return;
  if (!MobileState.soundEnabled && !force) return;

  // Background audio throttling: suppress continuous chimes when backgrounded; queue at most a single chime
  if (!force && typeof document !== 'undefined' && document.hidden) {
    _pendingBgSound = { type, period: meta && meta.period ? String(meta.period) : null, tf: meta && meta.tf ? meta.tf : null };
    return;
  }

  const now = Date.now();
  // Concurrency protection - never play win/loss sounds more than 1 at a time (min 1500ms gap unless forced)
  if (!force && (now - _lastSoundTimestamp < 1500)) {
    return; // Deduplicate / suppress rapid-fire glitch sounds
  }
  _lastSoundTimestamp = now;

  // Immediately terminate any currently playing audio so sounds NEVER overlap or play together
  stopAllSoundEffects();

  try {
    const audio = getAudioElement(type);
    if (audio) {
      _currentPlayingAudio = audio;
      audio.pause();
      audio.currentTime = 0;
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          // Do NOT trigger synth fallback on AbortError (interrupted playback)
          if (err && (err.name === 'AbortError' || err.code === 20)) return;
          console.warn('[Audio] Audio play failed, falling back to synth:', err);
          playSynthFallback(type);
        });
      }
      return;
    }
  } catch(e) {
    playSynthFallback(type);
    return;
  }
  playSynthFallback(type);
}
window.playSoundEffect = playSoundEffect;

// ── 3. Evaluate Prediction Correctness ───────────────────────────────────────

function evaluatePredictionCorrectness(target, number, size, color) {
  if (!target) return null;
  const t = String(target).toUpperCase();
  const num = Number(number);
  const sz = String(size || (num >= 5 ? 'BIG' : 'SMALL')).toUpperCase();
  const col = String(color || '').toUpperCase();

  if (t === 'BIG') return sz === 'BIG';
  if (t === 'SMALL') return sz === 'SMALL';
  if (t === 'GREEN') return col.includes('GREEN') || [1,3,5,7,9].includes(num);
  if (t === 'RED') return col.includes('RED') || [0,2,4,6,8].includes(num);
  if (t === 'VIOLET') return col.includes('VIOLET') || num === 0 || num === 5;
  // Numeric digit target
  if (!isNaN(parseInt(t, 10))) return num === parseInt(t, 10);
  return null;
}
window.evaluatePredictionCorrectness = evaluatePredictionCorrectness;

// ── 4. Compute Real-Time State (period & countdown) ──────────────────────────

function computeRTState(tf) {
  const sys = window.WIN_GO_SYSTEMS && window.WIN_GO_SYSTEMS[tf];
  if (sys && typeof sys.computeRealTimeState === 'function') {
    const s = sys.computeRealTimeState();
    return {
      periodStr: s.periodStr,
      secsLeft: s.secsLeft,
      secsTotal: TF_SECONDS[tf] || 30
    };
  }
  // Fallback: compute manually
  const secsTotal = TF_SECONDS[tf] || 30;
  const now = new Date();
  const totalSec = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  const elapsed = totalSec % secsTotal;
  const secsLeft = elapsed === 0 ? 0 : secsTotal - elapsed;
  let periodIdx = elapsed === 0
    ? Math.floor(totalSec / secsTotal) || Math.floor(86400 / secsTotal)
    : Math.floor(totalSec / secsTotal) + 1;
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const code = TF_CODES[tf] || '10001';
  const periodStr = `${y}${mo}${d}${code}${String(periodIdx).padStart(4, '0')}`;
  return { periodStr, secsLeft, secsTotal };
}
window.computeRTState = computeRTState;

// ── 5. IST Clock & Hero Countdown ─────────────────────────────────────────────

let _istClockInterval = null;

function updateOrbCountdownRing(secsLeft, secsTotal) {
  const ring = document.getElementById('orbTimerRing');
  if (!ring) return;
  const total = secsTotal > 0 ? secsTotal : 30;
  const pct = Math.max(0, Math.min(1, secsLeft / total));
  const circumference = 188.5;
  const offset = circumference * (1 - pct);
  ring.style.strokeDashoffset = offset.toFixed(2);

  if (secsLeft > 10) {
    ring.style.stroke = '#10b981'; // emerald green
    ring.style.filter = 'drop-shadow(0 0 4px rgba(16, 185, 129, 0.45))';
  } else if (secsLeft >= 6) {
    ring.style.stroke = '#f59e0b'; // amber
    ring.style.filter = 'drop-shadow(0 0 6px rgba(245, 158, 11, 0.65))';
  } else {
    ring.style.stroke = '#ef4444'; // glowing neon red
    ring.style.filter = 'drop-shadow(0 0 10px rgba(239, 68, 68, 0.95))';
  }
}
window.updateOrbCountdownRing = updateOrbCountdownRing;

function updateISTClock() {
  const now = new Date();
  // IST = UTC + 5:30
  const istOffset = 5.5 * 3600 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  const ss = String(ist.getUTCSeconds()).padStart(2, '0');

  const clockEl = $('realWorldClock');
  if (clockEl) clockEl.textContent = `${hh}:${mm}:${ss} UTC+5:30`;

  const tf = MobileState.timeframe;
  const { periodStr, secsLeft, secsTotal } = computeRTState(tf);

  // Floating Assistant Orb Dynamic Countdown Ring
  updateOrbCountdownRing(secsLeft, secsTotal);

  // Hero card
  const periodEl = $('heroPeriodNum');
  if (periodEl) periodEl.textContent = shortPeriodStr(periodStr) || periodStr;

  const countdown = $('heroCountdown');
  if (countdown) {
    const m = Math.floor(secsLeft / 60);
    const s = secsLeft % 60;
    countdown.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    const pct = secsTotal > 0 ? secsLeft / secsTotal : 0;
    if (pct < 0.2) {
      countdown.className = 'font-mono text-base font-black text-rose-400 tracking-wider animate-pulse';
    } else if (pct < 0.5) {
      countdown.className = 'font-mono text-base font-black text-amber-300 tracking-wider';
    } else {
      countdown.className = 'font-mono text-base font-black text-amber-400 tracking-wider';
    }
  }

  // DhaniWin Assistant Hub Card
  const assistPeriod = $('assistantPeriodNum');
  if (assistPeriod) assistPeriod.textContent = '#' + (shortPeriodStr(periodStr) || periodStr);

  const assistCountdown = $('assistantCountdown');
  if (assistCountdown) {
    const m = Math.floor(secsLeft / 60);
    const s = secsLeft % 60;
    assistCountdown.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // At secsLeft === 0 → schedule boundary retries
  if (secsLeft === 0) {
    scheduleBoundaryRetries(tf);
  }
}
window.updateISTClock = updateISTClock;

// ── 6. Boundary Retries at Round End ─────────────────────────────────────────

function scheduleBoundaryRetries(tf) {
  if (!MobileState.boundaryRetryTimers) MobileState.boundaryRetryTimers = {};
  clearBoundaryRetries(tf);

  const delays = [500, 1500, 3000, 5000];
  const timers = [];
  delays.forEach(delay => {
    const t = setTimeout(() => {
      fetchLiveAPIResults(tf);
    }, delay);
    timers.push(t);
  });
  MobileState.boundaryRetryTimers[tf] = timers;
}
window.scheduleBoundaryRetries = scheduleBoundaryRetries;

function clearBoundaryRetries(tf) {
  if (!MobileState.boundaryRetryTimers) return;
  const timers = MobileState.boundaryRetryTimers[tf];
  if (Array.isArray(timers)) {
    timers.forEach(t => clearTimeout(t));
  }
  MobileState.boundaryRetryTimers[tf] = [];
}
window.clearBoundaryRetries = clearBoundaryRetries;

// ── 7. Fetch Live History (Cloudflare Edge → Direct Upstream Fallback) ─────────
// No Firebase RTDB polling — zero quota consumption.
// Primary:  Cloudflare Edge Worker (/api/wingo?tf=X)  – unlimited bandwidth, fast edge cache
// Fallback: Direct upstream lottery API              – free, no limits

// The worker base lives in exactly ONE place: this default. Every
// consumer (the /api/wingo results fetch below, the DhaniWin proxy
// URL builder in systems/dhani-transport.js via proxifyDhaniUrl)
// reads the resolved CF_WORKER_BASE — never a second copy of the URL.
// A runtime override in localStorage ('o101_worker_base') wins over
// the default, so a corrected worker address can be tested on-device
// without a rebuild: set the key, reload, and all consumers follow.
// The override is resolved once at boot and normalised (no trailing
// slash) so `${CF_WORKER_BASE}/api/wingo` can never double-slash.
const CF_WORKER_BASE_DEFAULT = 'https://o101-dhani-proxy.mrabensojan.workers.dev';
const WORKER_BASE_OVERRIDE_KEY = 'o101_worker_base';
function resolveWorkerBase() {
  try {
    const raw = localStorage.getItem(WORKER_BASE_OVERRIDE_KEY);
    if (raw && typeof raw === 'string') {
      const v = raw.trim().replace(/\/+$/, '');
      if (/^https?:\/\//i.test(v)) return v;
    }
  } catch (e) {}
  return CF_WORKER_BASE_DEFAULT;
}
const CF_WORKER_BASE = resolveWorkerBase();
window.CF_WORKER_BASE = CF_WORKER_BASE;

const DEFAULT_TF_UPSTREAM_URLS = {
  '30s': 'https://draw.ar-lottery02.com/WinGo/WinGo_30S/GetHistoryIssuePage.json',
  '1m':  'https://draw.ar-lottery02.com/WinGo/WinGo_1M/GetHistoryIssuePage.json',
  '3m':  'https://draw.ar-lottery02.com/WinGo/WinGo_3M/GetHistoryIssuePage.json',
  '5m':  'https://draw.ar-lottery02.com/WinGo/WinGo_5M/GetHistoryIssuePage.json'
};

function getApiEndpoint(tf) {
  try {
    const raw = localStorage.getItem('quant_custom_api_endpoints');
    if (raw) {
      const endpoints = JSON.parse(raw);
      if (endpoints && endpoints[tf] && typeof endpoints[tf] === 'string' && endpoints[tf].trim().length > 0) {
        return endpoints[tf].trim();
      }
    }
  } catch(e) {}
  return DEFAULT_TF_UPSTREAM_URLS[tf] || DEFAULT_TF_UPSTREAM_URLS['30s'];
}
window.getApiEndpoint = getApiEndpoint;

function setCustomApiEndpoint(tf, url) {
  try {
    let endpoints = {};
    const raw = localStorage.getItem('quant_custom_api_endpoints');
    if (raw) endpoints = JSON.parse(raw) || {};
    endpoints[tf] = (url || '').trim();
    localStorage.setItem('quant_custom_api_endpoints', JSON.stringify(endpoints));
    return true;
  } catch(e) {
    return false;
  }
}
window.setCustomApiEndpoint = setCustomApiEndpoint;

function restoreDefaultApiEndpoints() {
  try {
    localStorage.removeItem('quant_custom_api_endpoints');
  } catch(e) {}
}
window.restoreDefaultApiEndpoints = restoreDefaultApiEndpoints;

const TF_UPSTREAM_URLS = new Proxy(DEFAULT_TF_UPSTREAM_URLS, {
  get(target, prop) {
    if (typeof prop === 'string' && ['30s', '1m', '3m', '5m'].includes(prop)) {
      return getApiEndpoint(prop);
    }
    return target[prop];
  }
});

async function _fetchWithTimeout(url, timeoutMs = 5000, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'Accept': 'application/json', ...(opts.headers || {}) } });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

function _parseRawList(raw) {
  if (!raw) return [];
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw.data?.list) list = raw.data.list;
  else if (raw.list) list = raw.list;
  else if (typeof raw === 'object') list = Object.values(raw).filter(v => v && typeof v === 'object');
  return list.filter(Boolean);
}

let _customApiFailureStreak = 0;
function notifyCustomApiResult(tf, success, err) {
  const hasCustomApi = !!localStorage.getItem('quant_custom_api_endpoints');
  if (!hasCustomApi) return;

  if (success) {
    _customApiFailureStreak = 0;
  } else {
    _customApiFailureStreak++;
    if (_customApiFailureStreak >= 5) {
      _customApiFailureStreak = 0;
      console.warn('[Custom API Monitor] Custom API endpoint failed 5 consecutive times. Falling back to default data stream.');
      try {
        localStorage.removeItem('quant_custom_api_endpoints');
      } catch(e) {}
      if (typeof showToast === 'function') {
        showToast('⚠️ Custom API returned no data. Reverted to universal data stream.', 'info');
      }
    }
  }
}

async function fetchLiveHistoryFromDirectAPI(tf) {
  // ── Source 1: Direct Upstream Lottery Feed (ar-lottery02.com — active live round data) ──
  try {
    const upstreamUrl = `${TF_UPSTREAM_URLS[tf] || TF_UPSTREAM_URLS['30s']}?pageNo=1&_=${Date.now()}`;
    const raw = await _fetchWithTimeout(upstreamUrl, 4000);
    const list = _parseRawList(raw);
    if (list.length > 0) {
      notifyCustomApiResult(tf, true);
      return list;
    } else {
      notifyCustomApiResult(tf, false, 'Empty data list');
    }
  } catch (e) {
    notifyCustomApiResult(tf, false, e);
    // Upstream unavailable – fall through
  }

  // ── Source 2: Firebase RTDB (fallback) ──
  try {
    const rtdbUrl = `${RTDB_BASE}/live_history/${tf}.json?_=${Date.now()}`;
    const raw = await _fetchWithTimeout(rtdbUrl, 2500);
    const list = _parseRawList(raw);
    if (list.length > 0) return list;
  } catch (e) {}

  // ── Source 3: Cloudflare Edge Worker Fallback ──
  try {
    const cfUrl = `${CF_WORKER_BASE}/api/wingo?tf=${tf}&_=${Date.now()}`;
    const cfData = await _fetchWithTimeout(cfUrl, 3000);
    const cfList = cfData?.data || _parseRawList(cfData);
    if (Array.isArray(cfList) && cfList.length > 0) return cfList;
  } catch (e) {}

  // ── Source 4: Pending cloud history cached locally ──
  if (window._pendingCloudHistory?.[tf]) {
    const cached = window._pendingCloudHistory[tf];
    return Array.isArray(cached) ? cached : Object.values(cached).filter(Boolean);
  }
  return null;
}
window.fetchLiveHistoryFromDirectAPI = fetchLiveHistoryFromDirectAPI;


// ── 8. Main Fetch Loop ────────────────────────────────────────────────────────

async function fetchLiveAPIResults(tfOverride) {
  const tf = tfOverride || MobileState.timeframe;
  if (!window._isFetchingMobile) window._isFetchingMobile = {};
  if (window._isFetchingMobile[tf]) return false;
  window._isFetchingMobile[tf] = true;

  try {
    const rawList = await fetchLiveHistoryFromDirectAPI(tf);
    if (!Array.isArray(rawList) || rawList.length === 0) return false;

    const tfCode = TF_CODES[tf];

    let parsedList = rawList.map(item => {
      const period = String(item.issueNumber || item.issue || item.period || item.expect || '');
      const num = parseInt(
        item.number !== undefined ? item.number :
        item.openNumber !== undefined ? item.openNumber :
        item.code || 0, 10);
      const size = item.size || (num >= 5 ? 'BIG' : 'SMALL');
      const color = item.color ||
        (num === 0 ? 'RED,VIOLET' : num === 5 ? 'GREEN,VIOLET' :
         [1, 3, 7, 9].includes(num) ? 'GREEN' : 'RED');
      return {
        period,
        number: num,
        size,
        color,
        result: (item.result === 'WIN' || item.result === 'LOSS') ? item.result : null,
        aiTarget: item.aiTarget || null,
        aiType: item.aiType || null,
        aiModel: item.aiModel || null,
        aiCorrect: (item.aiCorrect !== undefined && item.aiCorrect !== null) ? !!item.aiCorrect : null,
        aiConfidence: item.aiConfidence || null
      };
    }).filter(r => r.period && !isNaN(r.number));

    // Sort chronologically (oldest-first)
    parsedList.sort((a, b) => String(a.period).localeCompare(String(b.period)));

    // Filter to correct timeframe
    if (tfCode) {
      parsedList = parsedList.filter(r => !r.period || String(r.period).includes(tfCode));
    }

    if (parsedList.length === 0) return false;

    const currentList = MobileState.historyByTf[tf] || [];
    const latestOld = currentList.length > 0 ? currentList[currentList.length - 1] : null;
    const latestNew = parsedList[parsedList.length - 1];

    // Establish live session audit cutoff on the very first fetch after reload/reopening
    if (!MobileState._hasInitializedSessionCutoff) MobileState._hasInitializedSessionCutoff = {};
    if (!MobileState._hasInitializedSessionCutoff[tf]) {
      MobileState._hasInitializedSessionCutoff[tf] = true;
      const initialCutoff = String(parsedList[parsedList.length - 1].period);
      if (!MobileState.auditResetPeriod) MobileState.auditResetPeriod = {};
      MobileState.auditResetPeriod[tf] = initialCutoff;
      try { localStorage.setItem(`wingo_audit_reset_${tf}`, initialCutoff); } catch(e) {}
      if (window.TimeframeManager && typeof window.TimeframeManager.resetAudit === 'function') {
        window.TimeframeManager.resetAudit(tf, initialCutoff);
      }
    }

    const universalState = MobileState.cloudUniversalState[tf];
    const effectiveModels = (typeof getEffectiveModelList === 'function') ? getEffectiveModelList(tf) : [];
    const champModel = effectiveModels.find(m => m.name === MobileState.inChargeModel) || effectiveModels[0] || null;

    const cutoff = MobileState.auditResetPeriod?.[tf] || localStorage.getItem(`wingo_audit_reset_${tf}`);

    // Process list: retain real predictions for rounds actively predicted in current session,
    // and do NOT fabricate fake predictions for past rounds fetched on reload/reopening
    const processedList = parsedList.map(item => {
      const num = typeof item.number === 'number' ? item.number : 0;
      const size = item.size || (num >= 5 ? 'BIG' : 'SMALL');
      const color = item.color || (num === 0 ? 'RED,VIOLET' : num === 5 ? 'GREEN,VIOLET' : [1,3,7,9].includes(num) ? 'GREEN' : 'RED');

      const isPastRoundBeforeCutoff = cutoff && cutoff !== 'SESSION_START' && String(item.period) <= String(cutoff);

      let aiTarget = item.aiTarget || null;
      let isWin = (item.aiCorrect !== undefined && item.aiCorrect !== null) ? !!item.aiCorrect : null;
      // Verdict pick: preserved from storage/session, never derived from native.
      let verdictPick = item.verdictPick || null;
      let verdictCorrect = (item.verdictCorrect !== undefined && item.verdictCorrect !== null) ? !!item.verdictCorrect : null;

      if (isWin === null && (item.result === 'WIN' || item.result === 'LOSS')) {
        isWin = (item.result === 'WIN');
      }

      if (isPastRoundBeforeCutoff) {
        // Strict isolation: historical rounds before the session cutoff never carry live prediction outcomes
        aiTarget = null;
        isWin = null;
        verdictPick = null;
        verdictCorrect = null;
      } else {
        // 1. Check if this period was already settled in the current live session
        const existingInSession = currentList.find(c => String(c.period) === String(item.period));
        if (existingInSession && existingInSession.aiTarget) {
          aiTarget = existingInSession.aiTarget;
          if (existingInSession.aiCorrect !== null && existingInSession.aiCorrect !== undefined) {
            isWin = existingInSession.aiCorrect;
          }
        }
        // Verdict-sourcing (owner order 2026-10-30): preserve the stored
        // governed verdict pick from session. Never derive it from the native
        // scheduled prediction below.
        if (existingInSession && existingInSession.verdictPick && !verdictPick) {
          verdictPick = existingInSession.verdictPick;
          if (existingInSession.verdictCorrect !== null && existingInSession.verdictCorrect !== undefined) {
            verdictCorrect = !!existingInSession.verdictCorrect;
          }
        }

        // 2. Check scheduled predictions for rounds that were actively scheduled in this session
        // (native fallback for aiTarget ONLY — never for verdictPick)
        if (!aiTarget || isWin === null) {
          const sched = (MobileState.scheduledPredictionsByPeriod?.[tf] || {})[String(item.period)];
          if (sched && sched.target) {
            aiTarget = sched.target;
            if (isWin === null) isWin = evaluatePredictionCorrectness(sched.target, num, size, color);
          }
        }
      }

      // ONLY keep prediction outcome if this round was genuinely predicted in real-time in this session
      const hasRealPrediction = !isPastRoundBeforeCutoff && !!(aiTarget && isWin !== null);

      return {
        ...item,
        number: num,
        size,
        color,
        result: hasRealPrediction ? (isWin ? 'WIN' : 'LOSS') : null,
        aiTarget: hasRealPrediction ? aiTarget : null,
        aiCorrect: hasRealPrediction ? isWin : null,
        // Verdict pick survives the sync; null (renders as "—") when never
        // recorded from a governed verdict. Never fabricated from native.
        verdictPick: (!isPastRoundBeforeCutoff && verdictPick) ? verdictPick : null,
        verdictCorrect: (!isPastRoundBeforeCutoff && verdictPick && verdictCorrect !== null) ? verdictCorrect : null
      };
    });

    // Detect new round → trigger settlement
    if (latestOld && latestNew && String(latestOld.period) !== String(latestNew.period)) {
      const processedLatest = processedList[processedList.length - 1];
      settleRoundOutcome(
        tf,
        processedLatest.period,
        processedLatest.number,
        processedLatest.size,
        processedLatest.color,
        processedLatest,
        universalState
      );
    }

    MobileState.historyByTf[tf] = processedList;
    try {
      localStorage.setItem(`quant_history_${tf}`, JSON.stringify(processedList.slice(-500)));
    } catch(e) {}

    // Deep-history warm-up (fix round #6): once per session, in the
    // background, so a fresh origin's starved model store warms from
    // real older rounds instead of waiting 90+ minutes of live play.
    if (!_deepWarmupStarted[tf]) setTimeout(() => { try { warmDeepHistory(tf); } catch (e) {} }, 1500);

    // Hide loader on first successful fetch
    const loader = $('appleMinimalLoader');
    if (loader && !loader.classList.contains('hidden')) {
      loader.style.opacity = '0';
      setTimeout(() => loader.classList.add('hidden'), 300);
    }

    if (tf === MobileState.timeframe) {
      renderPredictionAudit(processedList);
      renderHistoryTable(processedList);
      renderMobileHistoryGraph(processedList);
      renderDigitFrequencies(processedList);
      renderChartData(processedList);
      renderAdaptiveAI(processedList);
      renderAuthoritativeAIPrediction(processedList);
    }

    // Feed Pattern Intelligence with fresh history after every successful fetch
    if (window.PatternIntelligence && typeof window.PatternIntelligence.startBackfill === 'function') {
      try { window.PatternIntelligence.startBackfill(tf, processedList); } catch(e) {}
    }

    return true;
  } catch (err) {
    console.warn('[Mobile Live Fetch] Notice:', err.message || err);
  } finally {
    window._isFetchingMobile[tf] = false;
  }
  return false;
}
window.fetchLiveAPIResults = fetchLiveAPIResults;

// ── Deep-history warm-up (fix round #6) ─────────────────────────────
// WHY: the live loop above REPLACES historyByTf with ONE upstream page
// every cycle, and localStorage is per-origin — so every new preview
// URL starts with a near-empty model store. Full stake needs 200
// evaluated rounds (graduated stakes: bets start at 20 rounds at
// 0.25× base); live accrual alone is 2/min at 30s, so 14 → 200
// costs 93 minutes of open app. The warm-up fetches OLDER upstream
// pages (pageNo=2..N — page 1 is the live page) once, while the store
// is starved, and orb-bridge's deep backfill records every model's
// walk-forward pick against each settled outcome. No invented data:
// every round comes from the same public feed the live loop polls.
// No threshold moves: full stake still needs 200 rounds — warm-up
// just gives the engine real rounds to evaluate instead of making it
// wait 90+ minutes. The tiers, not the warm-up, are what let early
// data bet at reduced stake.
// The deep list lives in MobileState.deepHistoryByTf + localStorage
// quant_deep_history_<tf>, NEVER in historyByTf (the live loop would
// wipe it on the next refresh). orb-bridge consumes it via backfillDeep.
const DEEP_WARMUP_TARGET = 300; // rounds (buffer above full stake at 200)
const DEEP_WARMUP_MAX_PAGES = 25;
const DEEP_WARMUP_MAX_MS = 75000;
const _deepWarmupStarted = {};
function deepHistoryStoreCount(tf) {
  try {
    const raw = localStorage.getItem('o101_model_history_v1');
    if (!raw) return 0;
    const d = JSON.parse(raw);
    const bucket = d && d.tf && d.tf[tf];
    return bucket && Array.isArray(bucket.periods) ? bucket.periods.length : 0;
  } catch (e) { return 0; }
}
function readStoredDeepHistory(tf) {
  try {
    const raw = localStorage.getItem('quant_deep_history_' + tf);
    const list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}
async function warmDeepHistory(tf) {
  try {
    if (_deepWarmupStarted[tf]) return;
    _deepWarmupStarted[tf] = true;
    if (deepHistoryStoreCount(tf) >= 200) return; // gate already fed
    if (!MobileState.deepHistoryByTf) MobileState.deepHistoryByTf = {};
    const existing = readStoredDeepHistory(tf);
    if (existing.length) MobileState.deepHistoryByTf[tf] = existing;
    if (existing.length >= DEEP_WARMUP_TARGET) return; // already deep
    const base = (typeof TF_UPSTREAM_URLS !== 'undefined' && (TF_UPSTREAM_URLS[tf] || TF_UPSTREAM_URLS['30s'])) || null;
    if (!base) return;
    const tfCode = TF_CODES[tf];
    const byPeriod = new Map();
    for (const r of existing) if (r && r.period) byPeriod.set(String(r.period), r);
    const t0 = Date.now();
    for (let page = 2, fetched = 0; fetched < DEEP_WARMUP_MAX_PAGES; page++, fetched++) {
      if (byPeriod.size >= DEEP_WARMUP_TARGET) break;
      if (Date.now() - t0 > DEEP_WARMUP_MAX_MS) break;
      let list = [];
      try {
        const raw = await _fetchWithTimeout(`${base}?pageNo=${page}&_=${Date.now()}`, 4000);
        list = _parseRawList(raw);
      } catch (e) { break; } // upstream hiccup: keep what we have; retry next session
      if (!Array.isArray(list) || list.length < 2) break; // exhausted (short/empty page)
      let added = 0;
      for (const item of list) {
        const period = String(item.issueNumber || item.issue || item.period || item.expect || '');
        const num = parseInt(item.number !== undefined ? item.number : (item.openNumber !== undefined ? item.openNumber : (item.code || 0)), 10);
        if (!period || isNaN(num)) continue;
        if (tfCode && !period.includes(tfCode)) continue;
        if (byPeriod.has(period)) continue;
        const size = item.size || (num >= 5 ? 'BIG' : 'SMALL');
        const color = item.color || (num === 0 ? 'RED,VIOLET' : num === 5 ? 'GREEN,VIOLET' : [1, 3, 7, 9].includes(num) ? 'GREEN' : 'RED');
        byPeriod.set(period, { period, number: num, size, color });
        added++;
      }
      if (added === 0) break; // pages repeat: nothing new to gain
    }
    const merged = [...byPeriod.values()].sort((a, b) => String(a.period).localeCompare(String(b.period)));
    MobileState.deepHistoryByTf[tf] = merged;
    try { localStorage.setItem('quant_deep_history_' + tf, JSON.stringify(merged.slice(-600))); } catch (e) {}
    // Still starved after this attempt (upstream short/failed): allow
    // one retry next session window instead of giving up forever.
    if (merged.length < DEEP_WARMUP_TARGET && deepHistoryStoreCount(tf) < 200) {
      setTimeout(() => { _deepWarmupStarted[tf] = false; }, 300000);
    }
  } catch (e) { /* warm-up must never break the live loop */ }
}
window.warmDeepHistory = warmDeepHistory;

// ── 9. Apply Cloud History from RTDB Listener ─────────────────────────────────

function applyCloudHistory(tfKey, val) {
  if (!Array.isArray(val) || val.length === 0) return;
  const tf = tfKey;
  const currentList = MobileState.historyByTf[tf] || [];

  let list = val.map(item => {
    const period = String(item.issueNumber || item.issue || item.period || '');
    const num = parseInt(item.number ?? item.openNumber ?? 0, 10);
    const size = item.size || (num >= 5 ? 'BIG' : 'SMALL');
    const color = item.color || (num === 0 ? 'RED,VIOLET' : num === 5 ? 'GREEN,VIOLET' : [1,3,7,9].includes(num) ? 'GREEN' : 'RED');

    // Retain prediction outcome ONLY if it was genuinely settled in the active live session
    const existingInSession = currentList.find(c => String(c.period) === period);
    const aiTarget = existingInSession?.aiTarget || null;
    const aiCorrect = (existingInSession?.aiCorrect !== undefined && existingInSession?.aiCorrect !== null) ? existingInSession.aiCorrect : null;
    const result = aiCorrect !== null ? (aiCorrect ? 'WIN' : 'LOSS') : null;

    return {
      period,
      number: num,
      size,
      color,
      result,
      aiTarget,
      aiType: existingInSession?.aiType || null,
      aiCorrect
    };
  }).filter(r => r.period && !isNaN(r.number));

  list.sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const tfCode = TF_CODES[tf];
  if (tfCode) list = list.filter(r => !r.period || r.period.includes(tfCode));

  if (list.length === 0) return;

  const latestOld = currentList.length > 0 ? currentList[currentList.length - 1] : null;
  const latestNew = list[list.length - 1];

  MobileState.historyByTf[tf] = list;

  if (latestOld && latestNew && String(latestOld.period) !== String(latestNew.period)) {
    settleRoundOutcome(
      tf, latestNew.period, latestNew.number, latestNew.size, latestNew.color,
      latestNew, MobileState.cloudUniversalState[tf]
    );
  }

  if (tf === MobileState.timeframe) {
    renderPredictionAudit(list);
    renderHistoryTable(list);
    renderMobileHistoryGraph(list);
    renderDigitFrequencies(list);
    renderChartData(list);
    renderAdaptiveAI(list);
    renderAuthoritativeAIPrediction(list);
  }
}
window.applyCloudHistory = applyCloudHistory;

function applyUniversalCloudState(tfKey, state) {
  if (!state) return;
  MobileState.cloudUniversalState[tfKey] = state;

  // Update inCharge from cloud if in auto mode
  if (MobileState.autoMode !== false && state.inChargeModel) {
    MobileState.inChargeModel = state.inChargeModel;
    if (MobileState.inChargeByTf && tfKey) MobileState.inChargeByTf[tfKey] = state.inChargeModel;
    const heroName = $('heroModelName');
    // Governed verdict owns the hero when locked — never overwrite it
    // with a native in-charge name (owner order 2026-10-30).
    if (heroName && !window.__o101Verdict) heroName.textContent = state.inChargeModel;
    const champName = $('aiChampionName');
    if (champName) champName.textContent = state.inChargeModel;
  }

  if (tfKey === MobileState.timeframe) {
    const list = MobileState.historyByTf[tfKey] || [];
    renderAuthoritativeAIPrediction(list);
    renderModelRosterUI();
  }
}
window.applyUniversalCloudState = applyUniversalCloudState;

// ── 10. Authoritative AI Prediction (Single Source, No Glitch) ───────────────

// Per-timeframe In-Charge strip (owner order 2026-10-30): shows each of the
// 4 timeframes' independently-elected in-charge model. A tf with no elected
// leader yet shows "warming up" — never a fabricated name.
function renderTfInchargeStrip() {
  const tfs = ['30s', '1m', '3m', '5m'];
  for (const t of tfs) {
    const el = document.getElementById('tfIncharge-' + t);
    if (!el) continue;
    const name = MobileState.inChargeByTf && MobileState.inChargeByTf[t];
    el.textContent = name || 'warming up';
    el.classList.toggle('text-zinc-500', !name);
    el.classList.toggle('text-purple-300', !!name);
  }
}
// Expose for tests and for orb-bridge.
if (typeof window !== 'undefined') window.renderTfInchargeStrip = renderTfInchargeStrip;

function renderAuthoritativeAIPrediction(list, forceRecompute = false) {
  const tf = MobileState.timeframe;
  const { periodStr } = computeRTState(tf);

  // ── STRICT ROUND-LOCK: PREVENT PREDICTION FLAPPING/GLITCHING IN THE SAME ROUND ──
  // If a prediction is already locked for this timeframe & period, strictly preserve it!
  // ONLY lock if the round is still active/pending (won === undefined). If already settled, generate fresh prediction!
  if (!forceRecompute && MobileState.scheduledPredictionsByPeriod?.[tf]?.[periodStr]) {
    const locked = MobileState.scheduledPredictionsByPeriod[tf][periodStr];
    if (locked && locked.target && locked.won === undefined) {
      MobileState.activePrediction = {
        period: periodStr,
        target: locked.target,
        type: locked.type || 'SIZE',
        inChargeModel: locked.inChargeModel || MobileState.inChargeModel,
        conf: locked.conf || 0.82
      };
      _updateAllPredictionUI(locked.target, locked.type || 'SIZE', locked.conf || 0.82, locked.inChargeModel || MobileState.inChargeModel, periodStr, list);
      return;
    }
  }

  const isLocalSource = (MobileState.inchargeConfig?.predictionSource || 'LOCAL') === 'LOCAL';
  const workerState = MobileState.workerStateByTf[tf];
  const cloudState = MobileState.cloudUniversalState[tf];
  const effectiveModels = (typeof getEffectiveModelList === 'function') ? getEffectiveModelList(tf) : [];

  let inChargeName = MobileState.inChargeModel;
  let inChargeReason = null;

  // 1. Resolve In-Charge Model Name
  if (MobileState.autoMode !== false) {
    if (isLocalSource && workerState?.activeIncharge?.model) {
      inChargeName = workerState.activeIncharge.model?.name || inChargeName;
      inChargeReason = workerState.activeIncharge.reason;
    } else if (!isLocalSource && cloudState?.inChargeModel) {
      inChargeName = cloudState.inChargeModel;
    } else if (effectiveModels.length > 0) {
      if (typeof determineOptimalArenaInChargeModel === 'function') {
        const opt = determineOptimalArenaInChargeModel(effectiveModels, null, true);
        if (opt?.model?.name) {
          inChargeName = opt.model.name;
          inChargeReason = opt.reason;
        }
      }
      if (!inChargeName) {
        const sorted = [...effectiveModels].sort((a, b) => {
          const wrA = Number(a.winRate !== undefined ? a.winRate : (parseFloat(a.winRatePct) / 100 || 0));
          const wrB = Number(b.winRate !== undefined ? b.winRate : (parseFloat(b.winRatePct) / 100 || 0));
          if (wrB !== wrA) return wrB - wrA;
          return (b.streak || 0) - (a.streak || 0);
        });
        inChargeName = sorted[0]?.name || inChargeName;
      }
    }
  }
  if (!inChargeName && effectiveModels.length > 0) {
    inChargeName = effectiveModels[0].name;
  }
  MobileState.inChargeModel = inChargeName;
  // Per-timeframe in-charge (owner order 2026-10-30): remember this tf's
  // leader independently so tab switches don't clobber each other.
  if (tf && MobileState.inChargeByTf) MobileState.inChargeByTf[tf] = inChargeName;
  renderTfInchargeStrip();

  // 2. Identify the authoritative In-Charge Model object
  const champModel = effectiveModels.find(m => m.name === inChargeName || m.id === inChargeName) || effectiveModels[0];

  // === SINGLE SOURCE OF TRUTH ===
  // THE AI TARGET IS STRICTLY AND 100% SYNCHRONIZED WITH THE IN-CHARGE MODEL'S PREDICTION
  let target = null;
  let predType = 'SIZE';
  let conf = 0.82;

  // Direct Execution / Stage 3 Defense Consensus Shield:
  // When at 2 consecutive losses, Stage 3 Defense Consensus Shield activates,
  // aggregating the top 5 non-slumping models to protect the critical 3rd round.
  const isStage3Active = !!(window.MobileBridgeState && window.MobileBridgeState.consecutiveLosses === 2 && effectiveModels.length >= 3);
  if (isStage3Active && typeof window.generateModelNextPrediction === 'function') {
    try {
      // Phase 3D quarantine retirement (owner order 2026-10-27):
      // quarantined status no longer filters anything — the shield
      // pool uses the slump filter only.
      const nonSlump = effectiveModels.filter(m => {
        if (Number(m.streak !== undefined ? m.streak : 0) <= -2) return false;
        return true;
      });
      const top5Pool = (nonSlump.length >= 3 ? nonSlump : effectiveModels).slice(0, 5);
      let bigVotes = 0, smallVotes = 0, confSum = 0;
      top5Pool.forEach(m => {
        try {
          const pred = window.generateModelNextPrediction(m, list, {
            streak: m.streak || 0,
            dopamine: m.dopamine || 0.5,
            lossPain: m.lossPain || 0.0
          });
          const t = (pred?.predTarget || pred?.predSize || 'BIG').toUpperCase();
          const c = Number(pred?.conf) || 0.82;
          if (t.includes('BIG')) bigVotes += c;
          else if (t.includes('SMALL')) smallVotes += c;
          confSum += c;
        } catch(e) {}
      });
      if (bigVotes > 0 || smallVotes > 0) {
        target = bigVotes >= smallVotes ? 'BIG' : 'SMALL';
        predType = 'SIZE';
        conf = Math.min(0.96, (confSum / Math.max(1, top5Pool.length)) + 0.05);
        if (champModel) {
          champModel.predTarget = target;
          champModel.predType = predType;
          champModel.conf = conf;
        }
      }
    } catch(e) {}
  }

  // Direct Execution: Calculate fresh prediction for in-charge champion on latest draw sequence
  if (!target && champModel && typeof window.generateModelNextPrediction === 'function') {
    try {
      const p = window.generateModelNextPrediction(champModel, list, {
        streak: champModel.streak || 0,
        dopamine: champModel.dopamine || 0.5,
        lossPain: champModel.lossPain || 0.0
      });
      if (p && p.predTarget) {
        target = p.predTarget;
        predType = p.predType || (['RED', 'GREEN', 'VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
        conf = p.conf || conf;
        champModel.predTarget = target;
        champModel.predType = predType;
        champModel.conf = conf;
        champModel.predColor = p.predColor;
        champModel.predSize = p.predSize;
        champModel.num = p.num;
      }
    } catch(e) {}
  }

  // Fallback 1: Worker in-charge model target if champModel matches worker
  if (!target && isLocalSource && workerState?.activeIncharge?.model) {
    const wm = workerState.activeIncharge.model;
    if (wm.name === inChargeName || !champModel) {
      target = wm.predTarget;
      predType = wm.predType || (['RED','GREEN','VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
      conf = wm.conf || conf;
    }
  }

  // Fallback 2: champModel stored target
  if (!target && champModel?.predTarget) {
    target = champModel.predTarget;
    predType = champModel.predType || (['RED','GREEN','VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
    conf = champModel.conf || conf;
  }

  // Fallback 3: Cloud current target if in cloud mode
  if (!target && !isLocalSource && cloudState?.currentPredTarget) {
    target = cloudState.currentPredTarget;
    predType = cloudState.currentPredType || (['RED','GREEN','VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
    conf = cloudState.currentConf || conf;
  }

  // Fallback 4: Sequential trend
  if (!target) {
    if (list.length >= 2) {
      const last = list[list.length - 1];
      target = last.size === 'BIG' ? 'SMALL' : 'BIG';
    } else {
      target = 'BIG';
    }
    predType = 'SIZE';
    conf = 0.70;
  }

  // Force champModel to strictly reflect target so Roster and Hero AI always match
  if (champModel) {
    champModel.predTarget = target;
    champModel.predType = predType;
    champModel.conf = conf;
  }

  // === STORE ONE AUTHORITATIVE PREDICTION ===
  MobileState.activePrediction = {
    period: periodStr,
    target,
    type: predType,
    inChargeModel: inChargeName,
    conf
  };

  // Record in scheduled predictions for later settlement AND round-locking
  if (!MobileState.scheduledPredictionsByPeriod[tf]) MobileState.scheduledPredictionsByPeriod[tf] = {};
  MobileState.scheduledPredictionsByPeriod[tf][periodStr] = {
    target,
    type: predType,
    conf,
    inChargeModel: inChargeName,
    lockedAt: Date.now()
  };

  // Limit scheduledPredictions memory to last 50 periods
  const schedKeys = Object.keys(MobileState.scheduledPredictionsByPeriod[tf]);
  if (schedKeys.length > 50) {
    schedKeys.slice(0, schedKeys.length - 50).forEach(k => delete MobileState.scheduledPredictionsByPeriod[tf][k]);
  }

  // Also record in TimeframeManager
  if (window.TimeframeManager && typeof window.TimeframeManager.recordPrediction === 'function') {
    try { window.TimeframeManager.recordPrediction(tf, periodStr, { target, type: predType, prob: conf }); } catch(e) {}
  }

  // === UPDATE ALL UI FROM SINGLE SOURCE ===
  _updateAllPredictionUI(target, predType, conf, inChargeName, periodStr, list);
}
window.renderAuthoritativeAIPrediction = renderAuthoritativeAIPrediction;

// ── High-Precision Test Mode & Prediction Delivery Gate ──────────────────────
// Evaluates calibration rounds but unlocks IMMEDIATELY for confirmed streaks (>=2) and high confidence (>=75%)
function checkPredictionGateStatus(tf, list) {
  const cutoff = MobileState.auditResetPeriod?.[tf] || localStorage.getItem(`wingo_audit_reset_${tf}`);
  const settled = (list || []).filter(r => {
    if (!r.aiTarget || r.aiCorrect === null || r.aiCorrect === undefined) return false;
    if (cutoff && cutoff !== 'SESSION_START' && String(r.period) <= String(cutoff)) return false;
    return true;
  });

  const total = settled.length;
  const wins = settled.filter(r => r.aiCorrect === true).length;
  const losses = total - wins;
  const winRate = total > 0 ? (wins / total) : 0;

  // Recent streak of settled
  const recent = settled.slice(-5);
  const recentWins = recent.filter(r => r.aiCorrect === true).length;
  let streak = 0;
  for (let i = settled.length - 1; i >= 0; i--) {
    if (settled[i].aiCorrect === true) streak++;
    else break;
  }

  // Active in-charge model and prediction signal
  const models = (typeof getEffectiveModelList === 'function' ? getEffectiveModelList(tf) : []) || [];
  const inCharge = models.find(m => m.name === MobileState.inChargeModel) || models[0];
  const inChargeStreak = Number(inCharge?.streak || 0);
  const inChargeWR = Number(inCharge?.winRate || 0);
  const conf = MobileState.activePrediction?.conf || inCharge?.conf || 0.75;

  // 🚀 EARLY UNLOCK FOR CONFIRMED STREAKS & HIGH CONFIDENCE:
  // If champion has streak >= 2, or confidence >= 75%, or recent 3 rounds have >= 2 wins, release prediction immediately!
  const hasStreakMomentum = streak >= 2 || inChargeStreak >= 2;
  const hasHighConfidence = conf >= 0.75 || inChargeWR >= 0.60;
  const hasRecentEdge = (recent.length >= 2 && recentWins >= 2);

  if (hasStreakMomentum || hasHighConfidence || hasRecentEdge) {
    return {
      ready: true,
      mode: 'ACTIVE',
      progress: total > 0 ? `${wins}W / ${losses}L` : (hasStreakMomentum ? `🔥 ${Math.max(streak, inChargeStreak)}W Streak` : `${Math.round(conf * 100)}% Conf`),
      reason: hasStreakMomentum ? `Winning Streak Active (${Math.max(streak, inChargeStreak)}W)` : `High Confidence Edge (${Math.round(conf * 100)}%)`,
      winRate: total > 0 ? Math.round(winRate * 100) : Math.round((inChargeWR || 0.65) * 100),
      wins, losses, streak: Math.max(streak, inChargeStreak)
    };
  }

  // If in initial rounds (under 3) and no confirmed streak yet, indicate calibration but don't freeze indefinitely
  const MIN_TEST_ROUNDS = 3;
  if (total < MIN_TEST_ROUNDS) {
    return {
      ready: false,
      mode: 'TESTING',
      progress: `${total}/${MIN_TEST_ROUNDS}`,
      reason: `Calibrating (${total}/${MIN_TEST_ROUNDS} test rounds)`,
      winRate: Math.round(winRate * 100),
      wins, losses, streak
    };
  }

  // If user had temporary losses, don't trap them in WAIT indefinitely:
  // After 2 losses, allow prediction to flow with anti-slump consensus
  if (wins >= losses || winRate >= 0.45 || streak >= 1) {
    return {
      ready: true,
      mode: 'ACTIVE',
      progress: `${wins}W / ${losses}L`,
      reason: `Active Edge (${Math.round(winRate * 100)}% WR)`,
      winRate: Math.round(winRate * 100),
      wins, losses, streak
    };
  }

  // Mild drawdown: still provide actionable prediction with alert
  return {
    ready: true,
    mode: 'RECOVERY',
    progress: `${wins}W / ${losses}L`,
    reason: `Recovery Edge (${Math.round(winRate * 100)}% WR)`,
    winRate: Math.round(winRate * 100),
    wins, losses, streak
  };
}
window.checkPredictionGateStatus = checkPredictionGateStatus;

function _updateAllPredictionUI(target, predType, conf, inChargeName, periodStr, list) {
  const isColor = ['RED','GREEN','VIOLET'].includes(target);
  const confPct = Math.round((conf || 0.82) * 100);
  const tf = MobileState.timeframe;

  // Test mode gate check
  const gate = checkPredictionGateStatus(tf, list);
  MobileState.predictionGate = gate;

  // Panel hero is OWNED by the governed verdict (owner order
  // 2026-10-30): every surface — hero, Axo ball, subtitle, closed
  // pill — shows the same bet-driving pick. When the bridge has
  // published a lock, the native per-type incharge never paints the
  // hero; without a lock, the native prediction is the fallback.
  const governedVerdict = window.__o101Verdict || null;
  const heroFields = (typeof window.__o101HeroFields === 'function')
    ? window.__o101HeroFields(governedVerdict)
    : (governedVerdict
      ? (governedVerdict.decision === 'BET' && governedVerdict.pick
        ? { signal: governedVerdict.pick, type: governedVerdict.pickType || 'SIZE', modelName: governedVerdict.driverName || 'In-Charge' }
        : { signal: '—', type: '—', modelName: null })
      : null);

  // Hero signal badge
  const heroSignal = $('heroSignalBadge');
  if (heroSignal) {
    if (heroFields) {
      heroSignal.textContent = heroFields.signal;
      heroSignal.className = `text-2xl font-black tracking-tight ${
        heroFields.signal === 'BIG' ? 'text-amber-300' :
        heroFields.signal === 'SMALL' ? 'text-sky-300' :
        heroFields.signal === 'GREEN' ? 'text-emerald-400' :
        heroFields.signal === 'RED' ? 'text-rose-400' :
        heroFields.signal === '—' ? 'text-zinc-500' : 'text-white'
      }`;
    } else if (gate.ready) {
      heroSignal.textContent = target || 'CALCULATING...';
      heroSignal.className = `text-2xl font-black tracking-tight ${
        target === 'BIG' ? 'text-amber-300' :
        target === 'SMALL' ? 'text-sky-300' :
        target === 'GREEN' ? 'text-emerald-400' :
        target === 'RED' ? 'text-rose-400' : 'text-white'
      }`;
    } else {
      // In calibration / test mode
      heroSignal.textContent = gate.mode === 'TESTING' ? `TESTING (${gate.progress})` : 'SEEKING EDGE';
      heroSignal.className = 'text-xl font-black tracking-tight text-amber-400/90';
    }
  }

  const heroType = $('heroTypeBadge');
  if (heroType) heroType.textContent = heroFields ? heroFields.type : (gate.ready ? (predType || 'SIZE') : `TESTING`);

  const heroConf = $('heroConfVal');
  if (heroConf) {
    heroConf.textContent = gate.ready ? `${confPct}%` : `${gate.winRate || '--'}% WR`;
    heroConf.className = gate.ready && confPct >= 75 ? 'text-emerald-400 font-black' : 'text-amber-400 font-black';
  }

  const heroModel = $('heroModelName');
  if (heroModel) heroModel.textContent = (heroFields && heroFields.modelName) || inChargeName || 'Auto Champion';

  // AI Champion card target badge
  const champTarget = $('aiChampionTargetBadge');
  if (champTarget) {
    if (gate.ready) {
      champTarget.textContent = target || 'CALCULATING';
      champTarget.className = `px-2 py-0.5 rounded font-black text-[8.5px] border ${
        target === 'BIG' ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' :
        target === 'SMALL' ? 'bg-sky-500/20 text-sky-300 border-sky-500/30' :
        target === 'GREEN' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' :
        target === 'RED' ? 'bg-rose-500/20 text-rose-300 border-rose-500/30' :
        'bg-amber-500/20 text-amber-300 border-amber-500/30'
      }`;
    } else {
      champTarget.textContent = 'CALIBRATING';
      champTarget.className = 'px-2 py-0.5 rounded font-black text-[8.5px] border bg-amber-500/20 text-amber-300 border-amber-500/30';
    }
  }

  const champType = $('aiChampionTypeBadge');
  if (champType) champType.textContent = predType || 'SIZE';

  // DhaniWin Web Tab Target & Floating Assistant Display
  // The sheet hero is OWNED by the governed verdict (orb-bridge
  // publishes window.__o101Verdict from the per-period LOCKED gate
  // verdict). While that lock exists this native render mirrors it
  // verbatim, so the sheet can never show a native prediction next to
  // a governed NO_PICK. Without orb-bridge (no lock), legacy behaviour.
  // (governedVerdict is hoisted at the top of this function.)
  const webTargetEl = $('mobileWebTargetDisplay');
  if (webTargetEl) {
    if (governedVerdict) {
      webTargetEl.textContent = governedVerdict.decision === 'BET' ? (governedVerdict.pick || '—') : '—';
    } else {
      const displayTarget = target || 'BIG';
      webTargetEl.textContent = displayTarget;
      webTargetEl.className = `text-2xl font-black ${
        displayTarget === 'BIG' ? 'text-amber-300' :
        displayTarget === 'SMALL' ? 'text-sky-300' :
        displayTarget === 'GREEN' ? 'text-emerald-400' :
        displayTarget === 'RED' ? 'text-rose-400' : 'text-white'
      }`;
    }
  }

  const assistConf = $('assistantConfBadge');
  if (assistConf) {
    assistConf.textContent = governedVerdict ? governedVerdict.confText : (gate.ready ? `${confPct}%` : (gate.mode === 'TESTING' ? gate.progress : `${gate.winRate}%`));
  }

  if (typeof updateFloatingOrbUI === 'function') {
    updateFloatingOrbUI();
  }

  // Sim bot: place next bet only if gate is active or in test
  if (MobileState.sim.running && !MobileState.sim.pendingBet && target) {
    initSimBet(target, periodStr);
  }
}


function _updateTrendSummary(list) {
  if (!list || list.length < 3) return;
  const last = list[list.length - 1];

  // Dragon streak
  let streak = 1;
  for (let i = list.length - 2; i >= 0; i--) {
    if (list[i].size === last.size) streak++;
    else break;
  }

  // Big/Small ratio
  const last20 = list.slice(-20);
  const bigCount = last20.filter(r => r.size === 'BIG').length;
  const regime = bigCount > 12 ? 'BIG Bias' : bigCount < 8 ? 'SMALL Bias' : 'Consensus';

  const heroRegime = $('heroRegimeVal');
  if (heroRegime) heroRegime.textContent = regime;

  const heroStreak = $('heroStreakVal');
  if (heroStreak) {
    heroStreak.textContent = streak >= 2 ? `🐉 ${streak}× ${last.size}` : `—`;
    heroStreak.className = streak >= 3 ? 'text-amber-400 font-bold' : 'text-emerald-400 font-bold';
  }

  const heroTrend = $('heroTrendVal');
  if (heroTrend) {
    const tf = MobileState.timeframe;
    heroTrend.textContent = `${tf.toUpperCase()} Active`;
  }
}

// ── 11. Render History Table ──────────────────────────────────────────────────

function renderHistoryTable(list) {
  const tbody = $('mobileHistoryTbody');
  if (!tbody) return;

  if (!list || list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-zinc-500">No draw history yet.</td></tr>';
    return;
  }

  const badge = $('historyCountBadge');
  if (badge) badge.textContent = `${list.length} Draws`;

  // Show most recent first — FULL history, no count cap (fix round).
  const display = [...list].reverse();

  const rows = display.map(r => {
    // Verdict-sourced (owner order 2026-10-30): the AI TARGET column shows
    // ONLY the stored governed verdict pick. Rows without a verdictPick
    // (pre-fix, or non-governed) render as "—", never a native guess.
    const vPick = r.verdictPick || null;
    const vCorrect = (r.verdictCorrect !== undefined && r.verdictCorrect !== null) ? !!r.verdictCorrect : null;
    const isWin = vCorrect === true;
    const isLoss = vCorrect === false;
    const hasResult = !!(vPick && vCorrect !== null);

    const numColor = (r.number === 0 || r.number === 5) ? 'text-purple-400' :
      [1,3,7,9].includes(r.number) ? 'text-emerald-400' : 'text-rose-400';

    const sizeColor = r.size === 'BIG' ? 'text-amber-300' : 'text-sky-300';

    let resultBadge = '';
    if (hasResult) {
      resultBadge = isWin
        ? `<span class="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[7px] font-black">✓ ${vPick}</span>`
        : `<span class="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 border border-rose-500/30 text-[7px] font-black">✗ ${vPick}</span>`;
    } else {
      resultBadge = `<span class="text-zinc-600 text-[7px]">—</span>`;
    }

    return `<tr class="hover:bg-white/[0.02] transition">
      <td class="py-1.5 px-1 font-mono text-[8.5px] text-zinc-400">${shortPeriodStr(r.period)}</td>
      <td class="py-1.5 px-1 font-mono font-black ${numColor}">${r.number}</td>
      <td class="py-1.5 px-1 font-mono font-bold ${sizeColor}">${r.size}</td>
      <td class="py-1.5 px-1 font-mono text-[8px] text-zinc-400">${r.color ? r.color.split(',')[0] : '—'}</td>
      <td class="py-1.5 px-1 text-right">${resultBadge}</td>
    </tr>`;
  });
  renderRoadCellsChunked(tbody, rows);
}
window.renderHistoryTable = renderHistoryTable;

// ── 11b. Render Mobile History Graph (0-9 Number Road & SVG connector) ──────────

const BALL_COLOR_CLASSES = [
  'ball-split-0', 'ball-green', 'ball-red', 'ball-green', 'ball-red',
  'ball-split-5', 'ball-red', 'ball-green', 'ball-red', 'ball-green'
];

function switchMobileHistoryView(mode) {
  MobileState.historyViewMode = mode;
  try { localStorage.setItem('quant_mobile_hist_view', mode); } catch(e) {}

  const btnTable = $('mobileHistTabTable');
  const btnGraph = $('mobileHistTabGraph');
  const viewTable = $('mobileHistoryTableView');
  const viewGraph = $('mobileHistoryGraphView');

  if (mode === 'graph') {
    if (btnGraph) btnGraph.className = 'px-2 py-0.5 rounded-md text-[8px] font-mono font-bold transition bg-amber-500/25 text-amber-300 border border-amber-400/40';
    if (btnTable) btnTable.className = 'px-2 py-0.5 rounded-md text-[8px] font-mono font-bold transition text-zinc-400 hover:text-white';
    if (viewTable) viewTable.classList.add('hidden');
    if (viewGraph) viewGraph.classList.remove('hidden');

    const curList = MobileState.historyByTf[MobileState.timeframe] || [];
    renderMobileHistoryGraph(curList);
  } else {
    if (btnTable) btnTable.className = 'px-2 py-0.5 rounded-md text-[8px] font-mono font-bold transition bg-amber-500/25 text-amber-300 border border-amber-400/40';
    if (btnGraph) btnGraph.className = 'px-2 py-0.5 rounded-md text-[8px] font-mono font-bold transition text-zinc-400 hover:text-white';
    if (viewGraph) viewGraph.classList.add('hidden');
    if (viewTable) viewTable.classList.remove('hidden');
  }
}
window.switchMobileHistoryView = switchMobileHistoryView;

function renderMobileHistoryGraph(list) {
  const container = $('mobileGraphRoadRows');
  const svg = $('mobileRoadConnectorSvg');
  if (!container) return;

  if (!list || list.length === 0) {
    container.innerHTML = '<div class="py-4 text-center text-zinc-500 font-mono text-[8px]">No graph data available.</div>';
    if (svg) svg.innerHTML = '';
    return;
  }

  // Calculate Big/Small and Win ratio
  const bigCount = list.filter(r => r.size === 'BIG').length;
  const total = list.length || 1;
  const bigPct = Math.round((bigCount / total) * 100);
  const smallPct = 100 - bigPct;

  const settled = list.filter(r => r.aiTarget && r.aiCorrect !== null && r.aiCorrect !== undefined);
  const winCount = settled.filter(r => r.aiCorrect === true).length;
  const winPct = settled.length ? `${Math.round((winCount / settled.length) * 100)}%` : '—';

  setText('mobileGraphBigPct', `${bigPct}%`);
  setText('mobileGraphSmallPct', `${smallPct}%`);
  setText('mobileGraphWinRatio', winPct);

  // Show recent rounds: newest on top, like PC number road — FULL
  // history, no count cap (fix round), chunked; the connector draws
  // once every row exists.
  const display = [...list].reverse();
  const COLS = 'grid-template-columns:46px repeat(10,1fr) 20px 20px';

  const rows = display.map((row, idx) => {
    const n = Number(row.number);
    const periodShort = String(row.period).slice(-4);

    // 10 ball cells
    const balls = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => {
      if (i === n) {
        return `<div class="flex items-center justify-center">
          ${(window.ballImg && window.ballImg(n, 16, 'shadow-sm')) || `<div class="ball-3d ${BALL_COLOR_CLASSES[n] || 'ball-red'} w-4 h-4 rounded-full flex items-center justify-center font-black text-[8px] text-white shadow-sm">${n}</div>`}
        </div>`;
      }
      return `<div class="flex items-center justify-center">
        <div class="w-4 h-4 rounded-full flex items-center justify-center text-[7px] text-zinc-600 font-bold">${i}</div>
      </div>`;
    }).join('');

    // B/S badge
    const bsBadge = row.size === 'BIG'
      ? `<div class="w-4 h-4 rounded-full bg-amber-400 flex items-center justify-center font-black text-[7.5px] text-zinc-950">B</div>`
      : `<div class="w-4 h-4 rounded-full bg-sky-400 flex items-center justify-center font-black text-[7.5px] text-zinc-950">S</div>`;

    // AI badge
    let aiBadge = `<div class="w-4 h-4 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[7px] text-zinc-500">—</div>`;
    if (row.aiTarget) {
      const correct = row.aiCorrect === true;
      const targetLabel = String(row.aiTarget)[0];
      aiBadge = `<div class="w-4 h-4 rounded-full flex items-center justify-center font-black text-[7px] ${correct ? 'bg-emerald-500/30 text-emerald-300 border border-emerald-500' : 'bg-rose-500/30 text-rose-300 border border-rose-500'}">${targetLabel}</div>`;
    }

    return `<div id="mobile-road-row-${idx}" class="grid items-center py-0.5 border-b border-white/[0.04]" style="${COLS}">
      <div class="text-[8px] text-zinc-400 font-mono truncate">${periodShort}</div>
      ${balls}
      <div class="flex items-center justify-center">${bsBadge}</div>
      <div class="flex items-center justify-center">${aiBadge}</div>
    </div>`;
  });

  // Draw connector SVG once all rows exist (chunked render completes).
  renderRoadCellsChunked(container, rows, { onComplete: () => drawMobileGraphConnector(display) });
}
window.renderMobileHistoryGraph = renderMobileHistoryGraph;

function drawMobileGraphConnector(hist) {
  const svg = $('mobileRoadConnectorSvg');
  const container = $('mobileGraphRoadRows');
  if (!svg || !container || hist.length < 2) {
    if (svg) svg.innerHTML = '';
    return;
  }

  requestAnimationFrame(() => {
    const points = [];
    hist.forEach((row, idx) => {
      const rowEl = document.getElementById(`mobile-road-row-${idx}`);
      if (!rowEl) return;
      const ballEl = rowEl.querySelector('.ball-3d');
      if (!ballEl) return;
      const cRect = container.getBoundingClientRect();
      const bRect = ballEl.getBoundingClientRect();
      points.push({
        x: bRect.left - cRect.left + bRect.width / 2,
        y: bRect.top - cRect.top + bRect.height / 2
      });
    });

    if (points.length < 2) {
      svg.innerHTML = '';
      return;
    }

    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1], cur = points[i];
      const mx = (prev.x + cur.x) / 2;
      d += ` C ${mx} ${prev.y} ${mx} ${cur.y} ${cur.x} ${cur.y}`;
    }
    svg.innerHTML = `<path d="${d}" fill="none" stroke="#f43f5e" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.75"/>
    ${points.map(p => `<circle cx="${p.x}" cy="${p.y}" r="2" fill="#f59e0b" opacity="0.9"/>`).join('')}`;
  });
}

// ── 12. Render Prediction Audit ───────────────────────────────────────────────

function renderPredictionAudit(list) {
  const tf = MobileState.timeframe;
  let sess = null;
  if (window.TimeframeManager && typeof window.TimeframeManager.getStats === 'function') {
    sess = window.TimeframeManager.getStats(tf);
  }

  let total = 0, wins = 0, losses = 0, maxWin = 0, maxLoss = 0, curStreak = 0;

  if (sess) {
    total = sess.totalSettled || 0;
    wins = sess.correctCount || 0;
    losses = sess.wrongCount || 0;
    maxWin = sess.maxWinStreak || 0;
    maxLoss = sess.maxLossStreak || 0;
    curStreak = sess.curStreak || 0;
  } else {
    // Compute from local list strictly for rounds after auditResetPeriod that had live predictions
    const cutoff = MobileState.auditResetPeriod?.[tf] || localStorage.getItem(`wingo_audit_reset_${tf}`);
    const settled = (list || []).filter(r => {
      if (!r.aiTarget || r.aiCorrect === null || r.aiCorrect === undefined) return false;
      if (cutoff && String(r.period) <= String(cutoff)) return false;
      return true;
    });
    total = settled.length;
    wins = settled.filter(r => r.aiCorrect === true).length;
    losses = total - wins;

    let runW = 0, runL = 0;
    settled.forEach(r => {
      if (r.aiCorrect) { runW++; runL = 0; if (runW > maxWin) maxWin = runW; }
      else { runL++; runW = 0; if (runL > maxLoss) maxLoss = runL; }
    });
    curStreak = runW > 0 ? runW : -runL;
  }

  MobileState.auditStats = { total, wins, losses, maxWinStreak: maxWin, maxLossStreak: maxLoss, curStreak };

  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
  setText('auditWinRate', total > 0 ? `${winRate}%` : '—%');
  setText('auditTotal', `${total}`);
  setText('auditWins', `${wins}`);
  setText('auditLosses', `${losses}`);
  setText('auditMaxWinStreak', `${maxWin} W`);
  setText('auditMaxLossStreak', `${maxLoss} L`);

  const wr = $('auditWinRate');
  if (wr) wr.className = `text-base font-black ${winRate >= 60 ? 'text-emerald-400' : winRate >= 50 ? 'text-amber-300' : 'text-zinc-400'} tracking-tight`;

  // Update DhaniWin Assistant Minimalist Sequence Road
  if (typeof renderAssistantMiniRoad === 'function') {
    renderAssistantMiniRoad(list);
  }

  // High-Confidence Push Notification (>60% Win Rate)
  if (total >= 5 && winRate >= 60) {
    if (typeof checkAndSendBestTimeNotification === 'function') {
      checkAndSendBestTimeNotification(winRate, wins, total, tf);
    }
  }
}
window.renderPredictionAudit = renderPredictionAudit;

// ── 13. Render Adaptive AI Panel ──────────────────────────────────────────────

function renderAdaptiveAI(list) {
  if (!list || list.length === 0) return;
  const tf = MobileState.timeframe;
  const cutoff = MobileState.auditResetPeriod?.[tf] || localStorage.getItem(`wingo_audit_reset_${tf}`);

  // Filter strictly to rounds that had real live predictions AFTER the session reset cutoff
  const settled = list.filter(r => {
    if (r.paused || r.circuitBreakerPaused) return false;
    if (!r.aiTarget || r.aiCorrect === null || r.aiCorrect === undefined) return false;
    if (cutoff && cutoff !== 'SESSION_START' && String(r.period) <= String(cutoff)) return false;
    return true;
  });
  const last20 = settled.slice(-20);
  const l20Wins = last20.filter(r => r.aiCorrect === true).length;
  const l20Pct = last20.length > 0 ? ((l20Wins / last20.length) * 100).toFixed(1) : '—';

  let curStreak = 0, bestStreak = 0, runW = 0, runL = 0;
  settled.forEach(r => {
    if (r.aiCorrect) { runW++; runL = 0; if (runW > bestStreak) bestStreak = runW; }
    else { runL++; runW = 0; }
  });
  curStreak = runW > 0 ? runW : -runL;

  const curStreakEl = $('aiBentoCurrentStreak');
  if (curStreakEl) {
    if (settled.length === 0) {
      curStreakEl.textContent = '— Standby';
      curStreakEl.className = 'text-lg font-black text-zinc-400 mt-0.5 tracking-tight';
    } else if (curStreak > 0) {
      curStreakEl.textContent = `🔥 +${curStreak} Wins`;
      curStreakEl.className = 'text-lg font-black text-emerald-400 mt-0.5 tracking-tight';
    } else if (curStreak < 0) {
      curStreakEl.textContent = `❄️ ${curStreak} Losses`;
      curStreakEl.className = 'text-lg font-black text-rose-400 mt-0.5 tracking-tight';
    } else {
      curStreakEl.textContent = '— Neutral';
      curStreakEl.className = 'text-lg font-black text-zinc-300 mt-0.5 tracking-tight';
    }
  }

  const streakTypeEl = $('aiBentoStreakType');
  if (streakTypeEl) {
    streakTypeEl.textContent = settled.length === 0 ? 'Awaiting Live Round' : curStreak > 0 ? 'Winning Momentum' : curStreak < 0 ? 'Recovery Mode' : 'Standby';
  }

  const bestStreakEl = $('aiBentoBestStreak');
  if (bestStreakEl) bestStreakEl.textContent = settled.length === 0 ? '0 Wins' : `⭐ ${bestStreak} Wins`;

  const drawEl = $('aiBentoDrawdown');
  if (drawEl) {
    const drawdown = curStreak < 0 ? curStreak : 0;
    drawEl.textContent = settled.length === 0 ? '🛡️ Safe (0)' : `🛡️ ${drawdown < -3 ? 'High Risk' : 'Safe'} (${drawdown})`;
    drawEl.className = `text-lg font-black mt-0.5 tracking-tight ${drawdown < -3 ? 'text-rose-400' : 'text-sky-400'}`;
  }

  const accEl = $('aiBentoAccuracy');
  if (accEl) accEl.textContent = settled.length === 0 ? '—%' : `${l20Pct}%`;

  const ratioEl = $('aiBentoScoreRatio');
  if (ratioEl) ratioEl.textContent = settled.length === 0 ? '0W · 0L' : `${l20Wins}W · ${last20.length - l20Wins}L`;

  // Sequential Road (bead chain) - strictly real live settled predictions — FULL, no cap
  renderSequentialRoad(settled);

  // 8-Engine Neural Matrix
  renderNeuralMatrix(list);

  // Regime bar
  const bigRatio = list.slice(-20).filter(r => r.size === 'BIG').length / Math.min(20, list.length);
  const regBar = $('aiRegimeProgressBar');
  if (regBar) regBar.style.width = `${Math.round(bigRatio * 100)}%`;
  const regName = $('aiRegimeName');
  if (regName) regName.textContent = bigRatio > 0.6 ? '🐉 Dragon Trend (BIG)' : bigRatio < 0.4 ? '🐉 Dragon Trend (SMALL)' : '🌊 Oscillating (Chop)';
  const regScore = $('regimeScoreText');
  if (regScore) regScore.textContent = `${Math.round(Math.abs(bigRatio - 0.5) * 200)}% Strength`;
}
window.renderAdaptiveAI = renderAdaptiveAI;

function renderSequentialRoad(settled) {
  const road = $('aiSequenceRoad');
  if (!road) return;
  const badge = $('seqRoadCountBadge');

  if (!settled || settled.length === 0) {
    road.innerHTML = '<div class="text-zinc-500 text-[8.5px] py-2">Waiting for first live prediction...</div>';
    if (badge) badge.textContent = '0 Predictions';
    return;
  }
  if (badge) badge.textContent = `${settled.length} Predictions`;

  road.innerHTML = settled.map((r, idx) => {
    const isWin = r.aiCorrect === true;
    const dot = isWin
      ? `<div class="shrink-0 flex flex-col items-center cursor-pointer" onclick="selectSequenceBead(${idx})">
          <span class="w-4 h-4 rounded-full bg-emerald-500 border-2 border-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)] flex items-center justify-center text-[6px] font-black text-black">W</span>
          <span class="text-[6px] font-mono text-zinc-500 mt-0.5">${String(r.period).slice(-3)}</span>
        </div>`
      : `<div class="shrink-0 flex flex-col items-center cursor-pointer" onclick="selectSequenceBead(${idx})">
          <span class="w-4 h-4 rounded-full bg-rose-500 border-2 border-rose-400 flex items-center justify-center text-[6px] font-black text-white">L</span>
          <span class="text-[6px] font-mono text-zinc-500 mt-0.5">${String(r.period).slice(-3)}</span>
        </div>`;
    return dot;
  }).join('<div class="shrink-0 w-px h-3 bg-white/10 self-center mx-0.5"></div>');
}

function selectSequenceBead(idx) {
  const tf = MobileState.timeframe;
  const settled = (MobileState.historyByTf[tf] || []).filter(r => r.aiCorrect !== null && r.aiCorrect !== undefined);
  const r = settled[idx];
  if (!r) return;
  setText('detailPeriod', shortPeriodStr(r.period));
  setText('detailPred', r.aiTarget || '—');
  setText('detailActual', `${r.number} (${r.size})`);
  const badge = $('detailResultBadge');
  if (badge) {
    badge.textContent = r.aiCorrect ? 'WIN' : 'LOSS';
    badge.className = r.aiCorrect
      ? 'px-2 py-0.5 rounded font-black text-[7.5px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
      : 'px-2 py-0.5 rounded font-black text-[7.5px] bg-rose-500/20 text-rose-400 border border-rose-500/30';
  }
}
window.selectSequenceBead = selectSequenceBead;

function renderNeuralMatrix(list) {
  const matrixEl = $('aiMatrixList');
  if (!matrixEl) return;
  if (!list || list.length < 5) return;

  const engines = [
    { name: 'Trend Engine', signal: () => { const l = list.slice(-5); const cur = l[4].size; let s=1; for(let i=3;i>=0;i--){if(l[i].size===cur)s++;else break;} return s>=2?cur:(cur==='BIG'?'SMALL':'BIG'); }},
    { name: 'Sum Engine', signal: () => { const n = list.slice(-2); const s = (n[1].number + n[0].number) % 10; return s<=4?'SMALL':'BIG'; }},
    { name: 'Markov Chain', signal: () => { const last = list[list.length-1]; return last.size==='BIG'?'BIG':'SMALL'; }},
    { name: 'Dragon Rider', signal: () => { const l = list.slice(-4); const s = l.filter(r=>r.size===l[3].size).length; return s>=3?l[3].size:(l[3].size==='BIG'?'SMALL':'BIG'); }},
    { name: 'Entropy Filter', signal: () => { const b = list.slice(-10).filter(r=>r.size==='BIG').length; return b>6?'BIG':'SMALL'; }},
    { name: 'QuantAlgorithm', signal: () => { if(window.QuantAlgorithm&&typeof window.QuantAlgorithm.predictNextBet==='function'){try{const o=window.QuantAlgorithm.predictNextBet({history:list,balance:1000,lossStreak:0,timeframe:MobileState.timeframe});return o?.target||'BIG';}catch(e){}}return 'BIG'; }},
    { name: 'Fibonacci Harmonics', signal: () => { const n = list.slice(-8).map(r=>r.number); const s = n.reduce((a,b)=>a+b,0); return s % 2 === 0 ? 'BIG' : 'SMALL'; }},
    { name: 'ASI Supercomputer', signal: () => MobileState.activePrediction?.target || 'BIG' }
  ];

  let bigVotes = 0, smallVotes = 0;
  const rows = engines.map(e => {
    let sig = 'BIG';
    try { sig = e.signal(); } catch(ex) {}
    if (sig === 'BIG' || sig === 'GREEN') bigVotes++;
    else smallVotes++;
    const isUp = sig === 'BIG' || sig === 'GREEN';
    return `<div class="flex items-center justify-between py-1 border-b border-white/[0.04]">
      <span class="text-zinc-400 text-[8.5px]">${e.name}</span>
      <span class="font-bold text-[9px] ${isUp ? 'text-emerald-400' : 'text-sky-400'}">${sig}</span>
    </div>`;
  });

  matrixEl.innerHTML = rows.join('');

  const consensus = bigVotes > smallVotes ? `BIG (${bigVotes}/${engines.length})` : `SMALL (${smallVotes}/${engines.length})`;
  setText('matrixConsensusTag', `Consensus: ${consensus}`);
}

// ── 14. Render Digit Frequencies ──────────────────────────────────────────────

function renderDigitFrequencies(list) {
  const grid = $('digitFrequencyGrid');
  if (!grid) return;

  const counts = new Array(10).fill(0);
  const recent = list.slice(-100);
  recent.forEach(r => {
    const n = Number(r.number);
    if (n >= 0 && n <= 9) counts[n]++;
  });
  const max = Math.max(...counts, 1);

  grid.innerHTML = counts.map((c, i) => {
    const pct = Math.round((c / recent.length) * 100) || 0;
    const barPct = Math.round((c / max) * 100);
    const isGreen = [1,3,7,9].includes(i);
    const isViolet = i === 0 || i === 5;
    const colorClass = isViolet ? 'bg-purple-500' : isGreen ? 'bg-emerald-500' : 'bg-rose-500';
    const textClass = isViolet ? 'text-purple-300' : isGreen ? 'text-emerald-300' : 'text-rose-400';

    return `<div class="flex flex-col items-center p-1.5 rounded-xl bg-black/40 border border-white/[0.06]">
      <span class="text-[9px] font-black font-mono ${textClass}">${i}</span>
      <div class="w-full bg-white/5 rounded-full h-1 my-1 overflow-hidden">
        <div class="${colorClass} h-full rounded-full transition-all" style="width:${barPct}%"></div>
      </div>
      <span class="text-[7.5px] font-mono text-zinc-400">${pct}%</span>
    </div>`;
  }).join('');
}
window.renderDigitFrequencies = renderDigitFrequencies;

// ── 15. Centralized Round Settlement & Deduplication ─────────────────────────

function settleRoundOutcome(tf, period, number, size, color, cloudRow = null, universalState = null) {
  if (!period) return;
  const periodStr = String(period);

  if (!MobileState.lastCelebratedPeriodByTf) {
    MobileState.lastCelebratedPeriodByTf = { '30s': null, '1m': null, '3m': null, '5m': null };
  }

  // FIX 2026-10-30: The lock was set here at the start, burning it even
  // when the call had no authentic prediction. A later call with complete
  // data would hit the lock and return silently — no PnL, no celebration.
  // The lock is now set ONLY after hasAuthenticPrediction is confirmed
  // (see below). Calls without an authentic prediction do not consume it.

  // Fix round (RC5): normalize colour at entry exactly as the history
  // sync does — the cloud path can supply no colour, and the
  // evaluator must never misjudge GREEN-on-5 for want of it.
  if (!color) {
    const _n = Number(number);
    if (_n === 0) color = 'RED,VIOLET';
    else if (_n === 5) color = 'GREEN,VIOLET';
    else if (Number.isFinite(_n)) color = [1,3,7,9].includes(_n) ? 'GREEN' : 'RED';
  }
  // Fix round (RC4): the latest settled period per timeframe, so a
  // backgrounded pending sound can be dropped on foreground return
  // when it is no longer the latest settled round.
  if (!MobileState.lastSettledPeriodByTf) MobileState.lastSettledPeriodByTf = {};
  MobileState.lastSettledPeriodByTf[tf] = periodStr;

  let isWin = null;
  let target = null;
  let predType = 'SIZE';
  let targetSource = null;

  const isLocalSource = (MobileState.inchargeConfig?.predictionSource || 'LOCAL') === 'LOCAL';

  // Fix round (RC1) Priority 0: the GOVERNED pick wins. The governed
  // disposition (orb-bridge, keyed by this exact round) carries the
  // pick the ball actually showed; the arena scheduled pick below
  // comes from a different engine and routinely differs, so it must
  // never override the governed pick for the celebration. A
  // disposition with no pick (NO_PICK) leaves target unset here —
  // the governor-suppression check below already silences those
  // rounds, and nothing here may invent a pick for them.
  if (typeof window.__o101GovernedDisposition === 'function') {
    try {
      const _disp = window.__o101GovernedDisposition(tf, periodStr);
      // Fix round correction: the disposition pick is the gate's pick
      // STRING ('BIG'/'SMALL'/colour), not a {target} object — the
      // first RC1 cut read _disp.pick.target and never fired. Accept
      // both shapes so Priority 0 actually wins over the arena pick.
      const _dp = _disp ? _disp.pick : null;
      const _dt = typeof _dp === 'string' ? _dp : (_dp && _dp.target);
      if (_disp && _disp.decision === 'BET' && _dt) {
        target = String(_dt);
        predType = ['RED','GREEN','VIOLET'].includes(target) ? 'COLOR' : 'SIZE';
        targetSource = 'governed';
      }
    } catch(e) {}
  }

  // Priority 1 (for LOCAL mode): The local prediction that was generated, locked, and displayed to the user
  if (!target && isLocalSource) {
    const scheduled = (MobileState.scheduledPredictionsByPeriod?.[tf] || {})[periodStr];
    if (scheduled && scheduled.target) {
      target = scheduled.target;
      predType = scheduled.type || (['RED','GREEN','VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
      if (scheduled.won !== undefined && scheduled.won !== null) {
        isWin = !!scheduled.won;
      }
    }
    if (!target) {
      const active = MobileState.activePrediction;
      if (active && active.target) {
        const ap = String(active.period || '');
        if (ap === periodStr || ap.slice(-5) === periodStr.slice(-5)) {
          target = active.target;
          predType = active.type || (['RED','GREEN','VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
        }
      }
    }
  }

  // Priority 2: Universal State latest settlement (only if not LOCAL or target not found locally)
  if (!target && universalState && String(universalState.latestSettledPeriod) === periodStr) {
    if (universalState.latestSettledWon !== undefined && universalState.latestSettledWon !== null) {
      isWin = !!universalState.latestSettledWon;
    } else if (universalState.latestSettledResult) {
      isWin = (universalState.latestSettledResult === 'WIN');
    }
    if (universalState.latestSettledTarget) {
      target = universalState.latestSettledTarget;
      predType = universalState.latestSettledType || (['RED','GREEN','VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
    }
  }

  // Priority 3: Cloud row from live_history
  if (!target && cloudRow && (isWin === null || !target)) {
    if (cloudRow.aiCorrect !== undefined && cloudRow.aiCorrect !== null) {
      isWin = !!cloudRow.aiCorrect;
    } else if (cloudRow.result === 'WIN' || cloudRow.result === 'LOSS') {
      isWin = (cloudRow.result === 'WIN');
    }
    if (cloudRow.aiTarget) {
      target = target || cloudRow.aiTarget;
      predType = cloudRow.aiType || (['RED','GREEN','VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
    }
  }

  // Priority 4: Universal state inCharge history path
  if (!target && universalState && Array.isArray(universalState.inChargeHistoryPath)) {
    const entry = universalState.inChargeHistoryPath.find(p => String(p.period) === periodStr);
    if (entry) {
      if (isWin === null) isWin = !!entry.won;
      target = target || entry.predTarget;
      predType = entry.predType || (['RED','GREEN','VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
    }
  }

  // Priority 5: Scheduled prediction (fallback for cloud mode if not matched)
  if (!target) {
    const scheduled = (MobileState.scheduledPredictionsByPeriod?.[tf] || {})[periodStr];
    if (scheduled) {
      target = target || scheduled.target;
      predType = scheduled.type || (['RED','GREEN','VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
    }
  }

  // Priority 6: Active prediction if period matches
  if (!target) {
    const active = MobileState.activePrediction;
    if (active && active.target) {
      const ap = String(active.period || '');
      if (ap === periodStr || ap.slice(-5) === periodStr.slice(-5)) {
        target = target || active.target;
        predType = active.type || (['RED','GREEN','VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
      }
    }
  }

  // Priority 6: In-charge model replay
  if (isWin === null || !target) {
    const _hadTargetBeforeReplay = !!target;
    const models = (typeof getEffectiveModelList === 'function') ? getEffectiveModelList(tf) : [];
    const inCharge = models.find(m => m.name === MobileState.inChargeModel) || models[0];
    if (inCharge) {
      if (inCharge.predTarget) {
        target = target || inCharge.predTarget;
        predType = inCharge.predType || predType;
      } else if (typeof window.generateModelNextPrediction === 'function') {
        try {
          const history = MobileState.historyByTf[tf] || [];
          const histBefore = history.filter(r => String(r.period) < periodStr);
          const p = window.generateModelNextPrediction(inCharge, histBefore);
          if (p && p.predTarget) {
            target = target || p.predTarget;
            predType = p.predType || predType;
          }
        } catch(e) {}
      }
    }
  }

  // Evaluate correctness
  // Fix round (RC3): a target that came ONLY from the in-charge
  // replay above (or its models[0] fallback) was never displayed to
  // the user — it may still stamp the history row below, but it must
  // never drive a celebration banner or sound.
  if (!_hadTargetBeforeReplay && target) targetSource = 'replay';
  if (target && isWin === null) {
    isWin = !!evaluatePredictionCorrectness(target, number, size, color);
  }

  const hasAuthenticPrediction = !!(target && isWin !== null);
  if (!hasAuthenticPrediction) {
    // Cannot determine authentic prediction - do NOT manufacture a fake win
    target = null;
    isWin = null;
  }

  // FIX 2026-10-30: Deduplication lock is set ONLY when we have an
  // authentic prediction. A call without one does not burn the lock,
  // allowing a later call with complete data to proceed to PnL +
  // celebration. This fixes the "rain never shows" bug where the first
  // (incomplete) settlement call consumed the one-shot lock.
  if (hasAuthenticPrediction) {
    if (MobileState.lastCelebratedPeriodByTf[tf] === periodStr) return;
    MobileState.lastCelebratedPeriodByTf[tf] = periodStr;
  }

  // Governor disposition (orb-bridge, 2026-10-24): a round the governor
  // SKIPped — or an Auto-Pilot round with no FIRED bet — gets NO
  // win/loss treatment in this flow: no recovery-ledger movement, no
  // celebration banner / money rain, no win/loss sound. The history
  // row above still records the app's own raw outcome as data; only
  // the user-facing win/loss treatment is suppressed. When the
  // governor recorded no verdict for the round, nothing changes.
  const governorSuppressed = typeof window.__o101GovernorSuppresses === 'function'
    ? window.__o101GovernorSuppresses(tf, periodStr) === true : false;

  // Dispatch to Local Web Worker
  if (modelWorker) {
    modelWorker.postMessage({
      type: 'UPDATE_NEW_ROUND',
      data: {
        timeframe: tf,
        round: { period: periodStr, number, size, color }
      }
    });
  }

  // Read-only observation hook for Pattern Intelligence
  if (window.PatternIntelligence && typeof window.PatternIntelligence.onNewRound === 'function') {
    window.PatternIntelligence.onNewRound(tf, { period: periodStr, number, size, color });
    if (hasAuthenticPrediction) {
      window.PatternIntelligence.onModelPrediction(tf, periodStr, MobileState.inChargeModel, target, null);
    }
  }

  // Check if this round was skipped/paused by Circuit Breaker
  const wasPaused = !!(window.MobileBridgeState && (window.MobileBridgeState.circuitBreakerPauseRounds > 0));

  // Stamp history row with definitive in-charge prediction outcome
  const curHist = MobileState.historyByTf[tf] || [];
  // Verdict-sourcing (owner order 2026-10-30): the AI TARGET column must show
  // the GOVERNED verdict's pick, not the native in-charge prediction. Only
  // store verdictPick when targetSource is 'governed' (Priority 0).
  const isGovernedVerdict = (targetSource === 'governed');
  let existingRow = curHist.find(r => String(r.period) === periodStr);
  if (existingRow) {
    existingRow.number = number;
    existingRow.size = size;
    existingRow.color = color;
    if (hasAuthenticPrediction && !wasPaused) {
      existingRow.aiTarget = target;
      existingRow.aiType = predType;
      existingRow.aiModel = MobileState.inChargeModel;
      existingRow.aiCorrect = isWin;
      existingRow.result = isWin ? 'WIN' : 'LOSS';
      existingRow.paused = false;
      // Store the governed verdict pick separately. The render column reads
      // verdictPick, never a live re-computation. Null when not governed.
      if (isGovernedVerdict) {
        existingRow.verdictPick = target;
        existingRow.verdictPickType = predType;
        existingRow.verdictCorrect = isWin;
      }
      existingRow.circuitBreakerPaused = false;
    } else if (wasPaused) {
      existingRow.paused = true;
      existingRow.circuitBreakerPaused = true;
      existingRow.aiTarget = null;
      existingRow.aiCorrect = null;
      existingRow.result = null;
    }
  } else {
    curHist.push({
      period: periodStr, number, size, color,
      paused: wasPaused,
      circuitBreakerPaused: wasPaused,
      result: (hasAuthenticPrediction && !wasPaused) ? (isWin ? 'WIN' : 'LOSS') : null,
      aiTarget: (hasAuthenticPrediction && !wasPaused) ? target : null,
      aiType: (hasAuthenticPrediction && !wasPaused) ? predType : null,
      aiModel: (hasAuthenticPrediction && !wasPaused) ? MobileState.inChargeModel : null,
      aiCorrect: (hasAuthenticPrediction && !wasPaused) ? isWin : null,
      // Governed verdict pick: only set when the target came from the
      // governed disposition (Priority 0). The history column reads this,
      // never a native re-computation. Old rows (pre-fix) have null here
      // and render as "—".
      verdictPick: (hasAuthenticPrediction && !wasPaused && isGovernedVerdict) ? target : null,
      verdictPickType: (hasAuthenticPrediction && !wasPaused && isGovernedVerdict) ? predType : null,
      verdictCorrect: (hasAuthenticPrediction && !wasPaused && isGovernedVerdict) ? isWin : null
    });
    curHist.sort((a, b) => String(a.period).localeCompare(String(b.period)));
  }
  MobileState.historyByTf[tf] = curHist;
  try { localStorage.setItem(`quant_history_${tf}`, JSON.stringify(curHist.slice(-500))); } catch(e) {}
  if (!MobileState.scheduledPredictionsByPeriod) MobileState.scheduledPredictionsByPeriod = {};
  if (!MobileState.scheduledPredictionsByPeriod[tf]) MobileState.scheduledPredictionsByPeriod[tf] = {};
  if (hasAuthenticPrediction && !wasPaused) {
    MobileState.scheduledPredictionsByPeriod[tf][periodStr] = { target, type: predType, inChargeModel: MobileState.inChargeModel, won: isWin };
  }

  // Update TimeframeManager
  if (window.TimeframeManager && typeof window.TimeframeManager.recordSettledRound === 'function') {
    try { window.TimeframeManager.recordSettledRound(tf, periodStr, number, size, color); } catch(e) {}
  }

  // Resolve sim bot bet
  let simProfit = null;
  if (hasAuthenticPrediction && !wasPaused && MobileState.sim.running && MobileState.sim.pendingBet) {
    const bet = MobileState.sim.pendingBet;
    if (!bet.period || String(bet.period) === periodStr) {
      simProfit = isWin ? (bet.stake * 0.96) : -bet.stake;
      resolveSimBet(size, isWin);
    }
  }

  // Resolve Mobile DhaniWin Loss Recovery Martingale Progression & Max 3-Loss Circuit Breaker
  if (tf === MobileState.timeframe && window.MobileBridgeState && !governorSuppressed) {
    if (wasPaused) {
      // Round was paused by circuit breaker: do NOT alter PnL, do NOT alter wins/losses!
      MobileBridgeState.circuitBreakerPauseRounds--;
      if (MobileBridgeState.circuitBreakerPauseRounds <= 0) {
        MobileBridgeState.circuitBreakerPauseRounds = 0;
        MobileBridgeState.circuitBreakerActive = false;
        showToast('✅ Circuit Breaker cool-off complete. Betting resumed.', 'info');
      }
    } else if (hasAuthenticPrediction) {
      if (isWin) {
        MobileBridgeState.wins += 1;
        MobileBridgeState.consecutiveLosses = 0;
        const profit = MobileBridgeState.currentStake * 0.96;
        MobileBridgeState.sessionPnl += profit;
        MobileBridgeState.currentLevel = 0; // Win: Reset to Base level
        MobileBridgeState.currentStake = MobileBridgeState.baseStake || 2;
      } else if (isWin === false) {
        MobileBridgeState.losses += 1;
        MobileBridgeState.consecutiveLosses = (MobileBridgeState.consecutiveLosses || 0) + 1;
        MobileBridgeState.sessionPnl -= MobileBridgeState.currentStake;

        if (MobileBridgeState.consecutiveLosses >= 3) {
          // 🛡️ TRIP MAX 3-LOSS CIRCUIT BREAKER
          MobileBridgeState.circuitBreakerActive = true;
          MobileBridgeState.circuitBreakerPauseRounds = 2; // Pause betting for strictly 2 rounds (max 2-3)
          MobileBridgeState.currentLevel = 0; // Reset Martingale level strictly to Base
          // Preserve MobileBridgeState.baseStake intact!
          MobileBridgeState.currentStake = MobileBridgeState.baseStake || 2;
          MobileBridgeState.consecutiveLosses = 0;

          // Re-evaluate active champion model with anti-slump filter
          if (typeof determineOptimalArenaInChargeModel === 'function' && Array.isArray(window.ARENA_CANONICAL_MODELS)) {
            const reEval = determineOptimalArenaInChargeModel(window.ARENA_CANONICAL_MODELS, null, true);
            if (reEval?.model) {
              MobileState.activeChampionModel = reEval.model;
              if (typeof updatePredictionSourceUI === 'function') updatePredictionSourceUI();
            }
          }
          showToast('🛡️ 3-Loss Circuit Breaker Engaged! Max 3 losses reached. Betting paused for 2 rounds. Stake reset to Base ₹' + (MobileBridgeState.baseStake || 2) + '. Zero losses > 3 permitted.', 'warn');
        } else {
          MobileBridgeState.currentLevel = Math.min(2, (MobileBridgeState.currentLevel || 0) + 1); // Loss: Advance recovery tier (capped at Level 3 max)
          if (MobileBridgeState.consecutiveLosses === 2) {
            // Stage 3 Defense Consensus Shield engaged for critical 3rd round
            if (typeof determineOptimalArenaInChargeModel === 'function' && Array.isArray(window.ARENA_CANONICAL_MODELS)) {
              const reEval = determineOptimalArenaInChargeModel(window.ARENA_CANONICAL_MODELS, null, true);
              if (reEval?.model) {
                MobileState.activeChampionModel = reEval.model;
                if (typeof updatePredictionSourceUI === 'function') updatePredictionSourceUI();
              }
            }
            showToast('🛡️ Stage 3 Defense Active: Denoised consensus shield engaged for final recovery round!', 'info');
          }
        }
      }
    }

    // Remove auto-shake on round settlement
    const prepBtn = $('mobileBridgeToggleBtn');
    if (prepBtn) prepBtn.classList.remove('auto-bet-shake');
    const targetDisplay = $('mobileWebTargetDisplay');
    if (targetDisplay) targetDisplay.classList.remove('auto-bet-shake');

    if (typeof calculateAndRenderMobileStake === 'function') {
      calculateAndRenderMobileStake();
    }
    if (typeof renderMobileWalletStats === 'function') {
      renderMobileWalletStats();
    }
    // Check Take Profit / Stop Loss thresholds
    if (MobileBridgeState.sessionPnl >= MobileBridgeState.takeProfit) {
      if (typeof toggleMobileRealAutoBet === 'function') toggleMobileRealAutoBet(false);
      showToast(`🎉 Take Profit Reached (+₹${MobileBridgeState.sessionPnl.toFixed(2)})! Auto-Prep Stopped.`, 'success');
    } else if (MobileBridgeState.sessionPnl <= -MobileBridgeState.stopLoss) {
      if (typeof toggleMobileRealAutoBet === 'function') toggleMobileRealAutoBet(false);
      showToast(`🛑 Stop Loss Reached (-₹${Math.abs(MobileBridgeState.sessionPnl).toFixed(2)})! Auto-Prep Stopped.`, 'error');
    }
  }

  // Win/loss celebration: ONLY show popup and sound if settled timeframe is the active timeframe and there was an authentic prediction
  // Fix round (RC3): replay-only rounds never celebrate, even though
  // the history row above still records them.
  if (tf === MobileState.timeframe && hasAuthenticPrediction && !governorSuppressed && targetSource !== 'replay') {
    showWinLossCelebration(isWin, target, number, size, color, periodStr, simProfit, tf);
  }

  // Update individual model settlements
  updateIndividualModelSettlement(tf, periodStr, number, size, color, universalState);
}
window.settleRoundOutcome = settleRoundOutcome;

// ── 16. Win/Loss Celebration Banner ──────────────────────────────────────────

let _celebrationTimeout = null;

function calculateConsecutiveWinStreak(tf) {
  const hist = MobileState.historyByTf[tf || MobileState.timeframe] || [];
  let streak = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const row = hist[i];
    if (row.result === 'WIN' || row.aiCorrect === true) {
      streak++;
    } else if (row.result === 'LOSS' || row.aiCorrect === false) {
      break; // Strictly stops on first loss -> streak becomes 0
    }
  }
  return streak;
}
window.calculateConsecutiveWinStreak = calculateConsecutiveWinStreak;

function showWinLossCelebration(isWin, target, number, size, color, periodStr, simProfit, tf) {
  // CRITICAL REQUIREMENT 1: Only show popup/sound of currently selected game interval by user only
  const activeTf = MobileState.timeframe;
  if (tf && tf !== activeTf) return;
  if (!isWin && isWin !== false) return;

  // Task P (owner order 2026-10-26): reduced motion shows the
  // banner statically and skips the money rain (pure motion);
  // the banner content itself is information and still shows.
  const reduceMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bannerDrop = reduceMotion ? '' : 'o101-banner-drop ';

  // Fix round #2: celebrations are display feedback, never login-gated.

  // CRITICAL REQUIREMENT 2: Single-instance concurrency - strictly never show more than 1 celebration/sound at a time
  dismissCelebrationBanner();
  if (typeof dismissAppleMoneyRain === 'function') dismissAppleMoneyRain();
  if (typeof stopAllSoundEffects === 'function') stopAllSoundEffects();

  const banner = $('winLossCelebrationBanner');
  if (!banner) return;

  // Build standard Apple liquid glass top banner
  const iconBox = $('celebrationIconBox');
  const icon = $('celebrationIcon');
  const title = $('celebrationTitle');
  const subtext = $('celebrationSubtext');
  const pnlBadge = $('celebrationPnlBadge');
  const periodBadge = $('celebrationPeriodBadge');

  // Real consecutive win streak calculation - strictly resets to 0 on loss
  const currentStreak = calculateConsecutiveWinStreak(activeTf);

  if (isWin) {
    if (iconBox) iconBox.className = 'w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0 bg-emerald-500/20 text-emerald-400';
    if (icon) icon.className = 'fa-solid fa-trophy';
    if (title) { title.textContent = 'PREDICTION WON!'; title.className = 'text-xs font-black tracking-tight text-emerald-300'; }
    if (banner) banner.className = 'fixed top-14 left-3 right-3 z-[100002] ' + bannerDrop + 'max-w-md mx-auto';
    if (pnlBadge) {
      pnlBadge.textContent = currentStreak > 1 ? `🔥 ${currentStreak}W Streak` : `+1W`;
      pnlBadge.className = 'text-xs font-black text-emerald-400';
    }
    const winProfit = (window.MobileBridgeState && MobileBridgeState.currentStake) ? MobileBridgeState.currentStake * 0.96 : 2;
    // Trigger smooth, non-intrusive cinematic Apple money rain overlay (replaces old cheap fullscreen modal)
    if (!reduceMotion && typeof triggerAppleMoneyRain === 'function') {
      triggerAppleMoneyRain(winProfit, currentStreak);
    }
  } else {
    if (iconBox) iconBox.className = 'w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0 bg-rose-500/20 text-rose-400';
    if (icon) icon.className = 'fa-solid fa-xmark';
    if (title) { title.textContent = 'PREDICTION MISSED'; title.className = 'text-xs font-black tracking-tight text-rose-400'; }
    if (banner) banner.className = 'fixed top-14 left-3 right-3 z-[100002] ' + bannerDrop + 'max-w-md mx-auto';
    if (pnlBadge) {
      pnlBadge.textContent = `0W Streak (Reset)`;
      pnlBadge.className = 'text-xs font-black text-rose-400';
    }
    // Owner order 2026-10-30 ~01:21 IST: the dollar rain falls on LOSS
    // too — always on, top-down, for every governed settled bet.
    // Visual only; the governed sound authority is untouched.
    const lossStake = (window.MobileBridgeState && MobileBridgeState.currentStake) ? MobileBridgeState.currentStake : 0;
    if (!reduceMotion && typeof triggerAppleMoneyRain === 'function') {
      triggerAppleMoneyRain(lossStake, 0, false);
    }
  }

  if (subtext) {
    subtext.textContent = `Hit ${size} (#${number}) · Target was ${target}`;
  }
  if (periodBadge) {
    periodBadge.textContent = `#${shortPeriodStr(periodStr)}`;
  }

  // Sound & haptic (Only plays for active timeframe, strictly single-instance).
  // Fix round (RC4): ONE sound authority. When a governed disposition
  // exists for this period, System A (orb-bridge settleGovernedPick)
  // already owns the sound for governed BET rounds — the banner stays
  // silent here so the two systems can never double-play or kill each
  // other's sound. Only non-governed fallback rounds (no disposition)
  // sound from the banner, stamped with their period so a
  // backgrounded pending chime can be dropped as stale.
  let _hasGovernedDisposition = false;
  try { _hasGovernedDisposition = typeof window.__o101GovernedDisposition === 'function' && !!window.__o101GovernedDisposition(tf, periodStr); } catch(e) {}
  if (!_hasGovernedDisposition) playSoundEffect(isWin ? 'win' : 'loss', false, { period: periodStr, tf: tf || MobileState.timeframe });
  hapticFeedback(isWin ? [40, 20, 60] : [80]);

  // Auto-dismiss standard banner after 3.8s
  if (_celebrationTimeout) clearTimeout(_celebrationTimeout);
  _celebrationTimeout = setTimeout(() => dismissCelebrationBanner(), 3800);
}
window.showWinLossCelebration = showWinLossCelebration;

function dismissCelebrationBanner() {
  const banner = $('winLossCelebrationBanner');
  if (banner) banner.classList.add('hidden');
  if (_celebrationTimeout) { clearTimeout(_celebrationTimeout); _celebrationTimeout = null; }
}
window.dismissCelebrationBanner = dismissCelebrationBanner;

// ── 17. AI Target Box Animation (Hero Card) ───────────────────────────────────

let _animTimeout = null;

function triggerAITargetBoxAnimation(result, data) {
  const normalView = $('smartTargetNormalView');
  const animView = $('smartTargetResultAnimView');
  if (!animView || !normalView) return;

  const isWin = result === 'WIN';

  normalView.classList.add('hidden');
  animView.classList.remove('hidden');
  animView.style.display = 'flex';

  const dot = $('smartResultAnimDot');
  const header = $('smartResultAnimHeader');
  const titleBox = $('smartResultAnimTitleBox');
  const icon = $('smartResultAnimIcon');
  const text = $('smartResultAnimText');
  const sub = $('smartResultAnimSubText');

  if (dot) { dot.className = `w-1.5 h-1.5 rounded-full inline-block ${isWin ? 'bg-emerald-400' : 'bg-rose-400'}`; }
  if (header) { header.textContent = isWin ? 'PREDICTION WIN' : 'PREDICTION LOSS'; header.className = `text-[8px] font-sans uppercase font-black tracking-wider ${isWin ? 'text-emerald-400' : 'text-rose-400'}`; }
  if (icon) { icon.className = `text-sm ${isWin ? 'fa-solid fa-check-circle text-emerald-400' : 'fa-solid fa-times-circle text-rose-400'}`; }
  if (text) { text.textContent = `${data?.target || '?'} → ${data?.size || '?'} (#${data?.number ?? '?'})`; text.className = `${isWin ? 'text-emerald-300' : 'text-rose-300'}`; }
  if (sub) { sub.textContent = `Period #${shortPeriodStr(data?.period || '')}`; }

  if (_animTimeout) clearTimeout(_animTimeout);
  _animTimeout = setTimeout(() => {
    animView.classList.add('hidden');
    animView.style.display = 'none';
    normalView.classList.remove('hidden');
  }, 3000);
}
window.triggerAITargetBoxAnimation = triggerAITargetBoxAnimation;

// ── 18. Individual Model Settlement (All 53 Models) ───────────────────────────

function updateIndividualModelSettlement(tf, periodStr, number, size, color, universalState) {
  const models = (typeof getCanonicalModelsForTf === 'function') ? getCanonicalModelsForTf(tf) : [];
  if (!models || models.length === 0) return;

  const history = MobileState.historyByTf[tf] || [];
  const historyBefore = history.filter(r => String(r.period) < periodStr);

  models.forEach(model => {
    // Observer (system model): its pick is computed by
    // systems/observer.js from live store evidence, never by genFn —
    // scoring its catalog placeholder here would fake its record.
    // Its governed record lives in the orb-bridge store; skip.
    if (model && typeof model.id === 'string' && model.id.indexOf('observer-') === 0) return;
    // Each model individually predicts based on history BEFORE this round
    let pred = null;
    if (typeof model.predict === 'function') {
      try { pred = model.predict(historyBefore, models); } catch(e) {}
    } else if (typeof window.generateModelNextPrediction === 'function') {
      try { pred = window.generateModelNextPrediction(model, historyBefore); } catch(e) {}
    }

    // STRONG LOGIC (owner order 2026-10-30): only score a FRESH prediction
    // for THIS round. If the model did not predict (pred null, no target),
    // skip scoring entirely — never fabricate a 'BIG' or reuse a stale
    // target from a previous round. A null pick pauses the record.
    const freshTarget = pred ? (pred.predTarget || pred.target || null) : null;
    if (!freshTarget) {
      // No prediction for this round: do not touch wins/losses/total.
      // Still update the next-round display target if the model has one.
      if (typeof model.predict === 'function') {
        try {
          const nextPred = model.predict(history, models);
          if (nextPred) {
            model.predTarget = nextPred.predTarget || nextPred.target || model.predTarget;
            model.predType = nextPred.predType || nextPred.type || model.predType;
          }
        } catch(e) {}
      }
      return; // skip to next model
    }

    model.predTarget = freshTarget;
    model.predType = pred.predType || pred.type || model.predType || 'SIZE';
    model.conf = pred.conf !== undefined ? pred.conf : model.conf;

    const won = evaluatePredictionCorrectness(model.predTarget, number, size, color);
    model.totalEvaluated = (model.totalEvaluated || 0) + 1;

    if (won === true) {
      model.wins = (model.wins || 0) + 1;
      model.streak = (model.streak > 0 ? model.streak + 1 : 1);
      if (model.streak > (model.bestStreak || 0)) model.bestStreak = model.streak;
    } else if (won === false) {
      model.losses = (model.losses || 0) + 1;
      model.streak = (model.streak < 0 ? model.streak - 1 : -1);
    }

    model.winRate = model.totalEvaluated > 0 ? Number((model.wins / model.totalEvaluated).toFixed(4)) : 0;
    model.winRatePct = `${(model.winRate * 100).toFixed(1)}%`;

    if (!model.historyPath) model.historyPath = [];
    model.historyPath.unshift({ period: periodStr, won: won === true, predTarget: model.predTarget });
    if (model.historyPath.length > 20) model.historyPath.pop();

    // Phase 3D quarantine retirement (owner order 2026-10-27):
    // evaluateQuarantineLockup is GONE — no model is ever
    // quarantined on a loss streak anymore. (Blacklist machinery
    // lives elsewhere and is untouched: blacklist.js still governs.)

    // Predict NEXT round
    if (typeof model.predict === 'function') {
      try {
        const nextPred = model.predict(history, models);
        if (nextPred) {
          model.predTarget = nextPred.predTarget || nextPred.target || model.predTarget;
          model.predType = nextPred.predType || nextPred.type || model.predType;
        }
      } catch(e) {}
    }
  });

  // Phase 3D quarantine retirement: processShadowTrialRound is GONE
  // — no probation rounds run anymore (no quarantines exist).

  const isUserReset = !!localStorage.getItem(`quant_user_ai_reset_${tf}`);
  if (isUserReset) {
    const sessionMap = {};
    models.forEach(m => {
      const w = m.wins || 0;
      const l = m.losses || 0;
      const tot = w + l;
      sessionMap[m.name] = {
        wins: w,
        losses: l,
        totalEvaluated: tot,
        winRate: tot > 0 ? Number((w / tot).toFixed(4)) : 0,
        streak: m.streak || 0,
        bestStreak: m.bestStreak || 0,
        historyPath: (m.historyPath || []).slice(0, 10)
      };
    });
    try {
      localStorage.setItem(`quant_user_model_stats_${tf}`, JSON.stringify(sessionMap));
    } catch(e) {}
  }

  // Auto mode: pass leadership to top-ranking model
  if (MobileState.autoMode !== false) {
    const cloudState = MobileState.cloudUniversalState[tf];
    if (!cloudState?.inChargeModel) {
      if (typeof determineOptimalArenaInChargeModel === 'function') {
        const opt = determineOptimalArenaInChargeModel(models, null, true);
        if (opt?.model?.name) {
          MobileState.inChargeModel = opt.model.name;
          if (MobileState.inChargeByTf && tf) MobileState.inChargeByTf[tf] = opt.model.name;
        }
      } else {
        const sorted = [...models].sort((a, b) => (b.winRate || 0) - (a.winRate || 0));
        if (sorted[0]) {
          MobileState.inChargeModel = sorted[0].name;
          if (MobileState.inChargeByTf && tf) MobileState.inChargeByTf[tf] = sorted[0].name;
        }
      }
    }
  }

  renderModelRosterUI();
}
window.updateIndividualModelSettlement = updateIndividualModelSettlement;

// ── 19. Canonical 53-Model Registry ──────────────────────────────────────────

function getCanonicalModelsForTf(tf) {
  tf = tf || MobileState.timeframe;
  if (!MobileState.modelPools) MobileState.modelPools = {};
  if (MobileState.modelPools[tf] && MobileState.modelPools[tf].length > 0) {
    return MobileState.modelPools[tf];
  }

  // Use global ARENA_CANONICAL_MODELS if available
  let canon = [];
  if (typeof window !== 'undefined' && Array.isArray(window.ARENA_CANONICAL_MODELS) && window.ARENA_CANONICAL_MODELS.length > 0) {
    canon = window.ARENA_CANONICAL_MODELS.map(m => ({
      ...m,
      wins: m.wins || 0,
      losses: m.losses || 0,
      totalEvaluated: m.totalEvaluated || 0,
      winRate: m.winRate || 0,
      winRatePct: m.winRatePct || '0.0%',
      streak: m.streak || 0,
      bestStreak: m.bestStreak || 0,
      historyPath: m.historyPath || [],
      predTarget: m.predTarget || 'BIG',
      predType: m.predType || 'SIZE',
      conf: m.conf || 0.75
    }));
  } else {
    // Embedded fallback catalog (53 models)
    canon = _buildFallbackCatalog();
  }

  MobileState.modelPools[tf] = canon;
  return canon;
}
window.getCanonicalModelsForTf = getCanonicalModelsForTf;

function _buildFallbackCatalog() {
  const make = (id, name, cat, desc, predTarget, predType, conf) => ({
    id, name, cat, desc,
    wins: 0, losses: 0, totalEvaluated: 0,
    winRate: 0, winRatePct: '0.0%',
    streak: 0, bestStreak: 0,
    historyPath: [],
    predTarget: predTarget || 'BIG',
    predType: predType || 'SIZE',
    conf: conf || 0.75
  });

  return [
    // Fly (14)
    make('fly-01','Mushroom Body Spiking Net','fly','Drosophila olfactory associative memory reservoir','GREEN','COLOR',0.82),
    make('fly-02','Antennal Lobe Odor Glomeruli','fly','Frequency contrast enhancement via local interneurons','BIG','SIZE',0.79),
    make('fly-03','Central Complex Ring Neurons','fly','Phase-tracking direction vector for pattern sequences','RED','COLOR',0.76),
    make('fly-04','Neuromodulated DAN Plasticity','fly','Continuous online synaptic weight adaptation','SMALL','SIZE',0.81),
    make('fly-05','Octopaminergic High-Arousal','fly','High-gain volatility response during transitions','GREEN','COLOR',0.74),
    make('fly-06','Liquid State Machine (LSM)','fly','Recurrent echo state network memory reservoir','BIG','SIZE',0.77),
    make('fly-07','Fly STDP Plasticity','fly','Spike timing dependent adaptation','SMALL','SIZE',0.73),
    make('fly-08','Homeostatic Equilibrium','fly','Activity scaling baseline guard','BIG','SIZE',0.72),
    make('fly-09','Hebbian Associative Net','fly','Co-firing synaptic strengthener','GREEN','COLOR',0.71),
    make('fly-10','Lateral Inhibition Filter','fly','Glomerular contrast sharpener','RED','COLOR',0.70),
    make('fly-11','Synaptic Fatigue Modulator','fly','Habituation and novelty bias','BIG','SIZE',0.75),
    make('fly-12','Cross-Modal Binding Engine','fly','Size-color sensor fusion','SMALL','SIZE',0.73),
    make('fly-13','Predictive Coding Gateway','fly','Top-down sensory error minimization','BIG','SIZE',0.78),
    make('fly-14','Metaplasticity Regulator','fly','Plasticity of plasticity regulator','GREEN','COLOR',0.76),
    // Neural (12)
    make('neu-01','Perceptron Ensemble Core','neural','Multi-layer linear consensus','BIG','SIZE',0.80),
    make('neu-02','Deep LSTM Recurrent Cell','neural','Long-short memory gated units','SMALL','SIZE',0.83),
    make('neu-03','Multi-Head Attention Transformer','neural','Self-attention sequence encoder','BIG','SIZE',0.85),
    make('neu-04','Echo State Reservoir Net','neural','Recurrent liquid state memory','GREEN','COLOR',0.79),
    make('neu-05','Spiking Neuromorphic Engine','neural','Event-driven pulse integrator','BIG','SIZE',0.77),
    make('neu-06','Radial Basis Function (RBF)','neural','Gaussian kernel distance mapper','SMALL','SIZE',0.74),
    make('neu-07','Self-Organizing Kohonen Map','neural','Topological state clustering','BIG','SIZE',0.72),
    make('neu-08','Deep Q-Learner Agent','neural','Bellman optimality policy actor','SMALL','SIZE',0.78),
    make('neu-09','Convolutional Temporal Net','neural','1D causal dilation filter','BIG','SIZE',0.81),
    make('neu-10','Neural Mesh Consensus','neural','Dense graph-connected voting','BIG','SIZE',0.80),
    make('neu-11','ResNet Skip Connector','neural','Residual gradient highway','SMALL','SIZE',0.79),
    make('neu-12','ASI Supercomputer Meta-AI','neural','Deep hierarchical orchestrator','BIG','SIZE',0.90),
    // Classical (15)
    make('cla-01','Trend Velocity Vector','classical','Directional momentum tracker','BIG','SIZE',0.76),
    make('cla-02','Mean Reversion Scalper','classical','Equilibrium pull detector','SMALL','SIZE',0.74),
    make('cla-03','Breakout Surge Hunter','classical','Range escape impulse capturer','BIG','SIZE',0.77),
    make('cla-04','Support Resistance Pivot','classical','Horizontal boundary bounds','BIG','SIZE',0.73),
    make('cla-05','EMA 9/21 Exponential Cross','classical','Fast-slow moving average cross','SMALL','SIZE',0.75),
    make('cla-06','Bollinger Band Squeeze Break','classical','Volatility compression expansion','BIG','SIZE',0.74),
    make('cla-07','MACD Histogram Surge','classical','Moving average convergence/divergence','BIG','SIZE',0.72),
    make('cla-08','RSI Divergence Probe','classical','Relative strength extreme reversion','SMALL','SIZE',0.73),
    make('cla-09','Stochastic Oscillator Push','classical','High-low relative close momentum','BIG','SIZE',0.71),
    make('cla-10','Fibonacci Sequence Harmonics','classical','Golden ratio projection steps','SMALL','SIZE',0.70),
    make('cla-11','Candlestick Engulfing Probe','classical','Price action candle reversal','BIG','SIZE',0.72),
    make('cla-12','Price Action Pinbar Probe','classical','Rejection wick exhaustion','SMALL','SIZE',0.73),
    make('cla-13','Parabolic SAR Acceleration','classical','Stop and reverse tracking','BIG','SIZE',0.74),
    make('cla-14','Keltner Channel Momentum','classical','Average true range envelope','BIG','SIZE',0.75),
    make('cla-15','Dynamic Impulse Tracker','classical','Multi-bar directional force','SMALL','SIZE',0.76),
    // Statistical (7)
    make('sta-01','Markov 2nd-Order State Chain','statistical','State transition probability matrix','BIG','SIZE',0.78),
    make('sta-02','Bayesian Prior Estimator','statistical','Evidence based probability updater','SMALL','SIZE',0.77),
    make('sta-03','Poisson Distribution Filter','statistical','Discrete event arrival estimator','BIG','SIZE',0.73),
    make('sta-04','Gaussian Mixture Profiler','statistical','Multi-modal distribution density','BIG','SIZE',0.74),
    make('sta-05','Monte Carlo Random Walk','statistical','10000-path stochastic forecast','SMALL','SIZE',0.72),
    make('sta-06','Auto-Regressive AR(3) Model','statistical','Lag-3 linear auto-regression','BIG','SIZE',0.75),
    make('sta-07','Chi-Square Contingency Test','statistical','Independence hypothesis testing','SMALL','SIZE',0.70),
    // Meta (5)
    make('met-01','UCB-MAB Multi-Armed Bandit','meta','Upper confidence bound explorer','BIG','SIZE',0.80),
    make('met-02','Adaptive Weight Consensus','meta','Performance weighted voting','BIG','SIZE',0.82),
    make('met-03','Dynamic Regime Switcher','meta','Chop vs trend regime governor','SMALL','SIZE',0.78),
    make('met-04','Diversity Ensemble Voting','meta','Cross-paradigm uncorrelated mix','BIG','SIZE',0.83),
    make('met-05','Gods Eye Hyper Ensemble','meta','Universal consensus meta-director','BIG','SIZE',0.88)
  ];
}

function getEffectiveModelList(tf) {
  tf = tf || MobileState.timeframe;
  const isUserReset = !!localStorage.getItem(`quant_user_ai_reset_${tf}`);

  // 1. If User Session Reset is active -> strictly return isolated session model stats (starting at 0%)
  if (isUserReset) {
    const models = getCanonicalModelsForTf(tf);
    let sessionMap = null;
    try {
      const raw = localStorage.getItem(`quant_user_model_stats_${tf}`);
      if (raw) sessionMap = JSON.parse(raw);
    } catch(e) {}

    return models.map(localM => {
      const s = sessionMap ? (sessionMap[localM.name] || sessionMap[localM.id]) : null;
      const wins = s ? Number(s.wins || 0) : 0;
      const losses = s ? Number(s.losses || 0) : 0;
      const totalEvaluated = wins + losses;
      const winRate = totalEvaluated > 0 ? Number((wins / totalEvaluated).toFixed(4)) : 0;
      const streak = s ? Number(s.streak || 0) : 0;
      const bestStreak = s ? Number(s.bestStreak || 0) : 0;
      const historyPath = s ? (s.historyPath || []) : [];

      return {
        ...localM,
        wins,
        losses,
        totalEvaluated,
        winRate,
        winRatePct: `${(winRate * 100).toFixed(1)}%`,
        streak,
        bestStreak,
        historyPath
      };
    });
  }

  // 2. Global Benchmark Mode -> return full all-time worker or cloud ratings
  const isLocalSource = (MobileState.inchargeConfig?.predictionSource || 'LOCAL') === 'LOCAL';
  const workerStats = MobileState.workerStateByTf[tf]?.allModelStats;

  if (isLocalSource && Array.isArray(workerStats) && workerStats.length > 0) {
    return workerStats;
  }

  const models = getCanonicalModelsForTf(tf);
  const cloudState = MobileState.cloudUniversalState[tf];
  const cloudModels = cloudState?.leaderboard || cloudState?.modelsSummary || [];

  // Merge cloud leaderboard stats if available
  if (Array.isArray(cloudModels) && cloudModels.length > 0) {
    return models.map(localM => {
      const serverM = cloudModels.find(s => s.id === localM.id || s.name === localM.name);
      if (serverM) {
        return {
          ...localM,
          wins: serverM.wins !== undefined ? serverM.wins : localM.wins,
          losses: serverM.losses !== undefined ? serverM.losses : localM.losses,
          totalEvaluated: serverM.totalEvaluated !== undefined ? serverM.totalEvaluated : localM.totalEvaluated,
          winRate: serverM.winRate !== undefined ? serverM.winRate : localM.winRate,
          winRatePct: serverM.winRatePct || `${((serverM.winRate || 0) * 100).toFixed(1)}%`,
          streak: serverM.streak !== undefined ? serverM.streak : localM.streak,
          bestStreak: serverM.bestStreak !== undefined ? serverM.bestStreak : localM.bestStreak,
          predTarget: serverM.predTarget || localM.predTarget,
          predType: serverM.predType || localM.predType,
          conf: serverM.conf !== undefined ? serverM.conf : localM.conf,
          historyPath: serverM.historyPath || localM.historyPath
        };
      }
      return localM;
    });
  }

  return models;
}
window.getEffectiveModelList = getEffectiveModelList;

// ── 20. Model Roster UI ───────────────────────────────────────────────────────

let activeAlgoCategory = 'all';

// Analyse pagination (owner order 2026-10-27, corrected 12:56 IST):
// NO "See all" — two page buttons < > step through the roster 10
// models at a time, straight down. Page state is module-level so
// every re-render (cycle, filter, search) shows the current page;
// renderModelRosterUI clamps into range, so paging can never land
// on an empty page or past the ends. Filter/search/reset entry
// points reset to page 1 (the user expects the top of a new list).
let aiRosterPage = 1;
const AI_ROSTER_PAGE_SIZE = 10;
function rosterPrevPage() {
  if (aiRosterPage > 1) { aiRosterPage--; renderModelRosterUI(); }
}
function rosterNextPage() {
  aiRosterPage++; renderModelRosterUI(); // render clamps at the last page
}
window.rosterPrevPage = rosterPrevPage;
window.rosterNextPage = rosterNextPage;

function setMobileAlgoCategory(cat) {
  activeAlgoCategory = (cat || 'all').toLowerCase();
  document.querySelectorAll('.ai-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.id === `algoCat-${activeAlgoCategory}`);
  });
  aiRosterPage = 1;
  renderModelRosterUI();
}
window.setMobileAlgoCategory = setMobileAlgoCategory;

function filterModelRoster() {
  aiRosterPage = 1;
  renderModelRosterUI();
}
window.filterModelRoster = filterModelRoster;

function resetUserAIModelsWinRate() {
  const tf = MobileState.timeframe;
  const period = (typeof computeRTState === 'function') ? computeRTState(tf).periodStr : String(Date.now());
  localStorage.setItem(`quant_user_ai_reset_${tf}`, period);
  localStorage.setItem(`quant_user_model_stats_${tf}`, JSON.stringify({}));
  if (MobileState.modelPools) delete MobileState.modelPools[tf];

  if (MobileState.workerStateByTf && MobileState.workerStateByTf[tf]?.allModelStats) {
    MobileState.workerStateByTf[tf].allModelStats.forEach(m => {
      m.wins = 0;
      m.losses = 0;
      m.totalEvaluated = 0;
      m.winRate = 0;
      m.winRatePct = '0.0%';
      m.streak = 0;
      m.bestStreak = 0;
      m.historyPath = [];
    });
  }

  if (modelWorker) {
    modelWorker.postMessage({
      type: 'RESET_SESSION',
      data: { timeframe: tf }
    });
  }

  renderModelRosterUI();
  renderAuthoritativeAIPrediction(MobileState.historyByTf[tf] || []);
  showToast('✓ AI Model session win rates reset to 0%. Evaluating live from now.', 'success');
}
window.resetUserAIModelsWinRate = resetUserAIModelsWinRate;

function restoreGlobalAIStats() {
  const tf = MobileState.timeframe;
  localStorage.removeItem(`quant_user_ai_reset_${tf}`);
  localStorage.removeItem(`quant_user_model_stats_${tf}`);
  if (MobileState.modelPools) delete MobileState.modelPools[tf];

  if (modelWorker) {
    const hist = MobileState.historyByTf[tf] || [];
    if (hist.length > 0) {
      modelWorker.postMessage({
        type: 'INIT_24H_HISTORY',
        data: { timeframe: tf, history: hist, config: MobileState.inchargeConfig }
      });
    }
    modelWorker.postMessage({
      type: 'SET_CONFIG',
      data: { config: { ...MobileState.inchargeConfig, mode: 'WINNING_STREAK_OVERRIDE' }, timeframe: tf }
    });
  }

  renderModelRosterUI();
  renderAuthoritativeAIPrediction(MobileState.historyByTf[tf] || []);
  showToast('👑 Restored All-Time Global Benchmark Leaderboard.', 'success');
}
window.restoreGlobalAIStats = restoreGlobalAIStats;

function renderModelRosterUI() {
  const tf = MobileState.timeframe;
  const isUserReset = !!localStorage.getItem(`quant_user_ai_reset_${tf}`);

  const restoreBtn = $('restoreGlobalAIBtn');
  const resetBtn = $('resetAIWinRateBtn');

  if (restoreBtn && resetBtn) {
    restoreBtn.classList.remove('hidden');
    resetBtn.classList.remove('hidden');
    if (isUserReset) {
      resetBtn.className = 'px-2 py-0.5 rounded-lg text-[8px] font-mono font-bold transition flex items-center gap-1 bg-rose-500/25 text-rose-200 border border-rose-400/50 shadow-sm';
      resetBtn.innerHTML = '<i class="fa-solid fa-check text-[7px]"></i> Session 0%';

      restoreBtn.className = 'px-2 py-0.5 rounded-lg text-[8px] font-mono font-bold transition flex items-center gap-1 text-zinc-400 hover:text-purple-300 border border-transparent';
      restoreBtn.innerHTML = '<i class="fa-solid fa-earth-americas text-[7px]"></i> Global';
    } else {
      restoreBtn.className = 'px-2 py-0.5 rounded-lg text-[8px] font-mono font-bold transition flex items-center gap-1 bg-purple-500/25 text-purple-200 border border-purple-400/50 shadow-sm';
      restoreBtn.innerHTML = '<i class="fa-solid fa-check text-[7px]"></i> Global';

      resetBtn.className = 'px-2 py-0.5 rounded-lg text-[8px] font-mono font-bold transition flex items-center gap-1 text-zinc-400 hover:text-rose-300 border border-transparent';
      resetBtn.innerHTML = '<i class="fa-solid fa-rotate-left text-[7px]"></i> Reset 0%';
    }
  }

  const allModels = getEffectiveModelList(tf);

  const getWinRate = m => {
    if (m.winRate !== undefined) return Number(m.winRate);
    if (m.winRatePct) return parseFloat(m.winRatePct) / 100;
    return 0;
  };

  const inchargeMode = MobileState.inchargeConfig?.mode || 'WINNING_STREAK_OVERRIDE';
  const minStreak = Number(MobileState.inchargeConfig?.minStreak || 3);

  const calculateWilsonScore = (wins, total, z = 1.96) => {
    if (total <= 0) return 0;
    const p = wins / total;
    const n = total;
    const denominator = 1 + (z * z) / n;
    const centre = p + (z * z) / (2 * n);
    const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
    return Math.max(0, (centre - spread) / denominator);
  };

  // STRONG LOGIC (owner order 2026-10-30): rank by Wilson lower bound ONLY.
  // Minimum n=20 to display a win rate ("warming up" below that).
  // Models with zero evaluations show "no data" — never 0% or fabricated.
  const MIN_N_FOR_WR = 20;
  const getModelN = (m) => Number(isUserReset && m.sessionEvaluated !== undefined ? m.sessionEvaluated : (m.totalEvaluated || 0));
  const getModelWins = (m) => Number(isUserReset && m.sessionWins !== undefined ? m.sessionWins : (m.wins || 0));

  const calculateModelRating = (m) => {
    const total = getModelN(m);
    const wins = getModelWins(m);
    // Below min-n: rank at the bottom (Wilson=0), display shows "warming up".
    if (total < MIN_N_FOR_WR) return 0;
    return calculateWilsonScore(wins, total);
  };

  const sorted = [...allModels].sort((a, b) => {
    const ratingA = calculateModelRating(a);
    const ratingB = calculateModelRating(b);
    if (ratingB !== ratingA) return ratingB - ratingA;
    const sDiff = Number(b.streak || 0) - Number(a.streak || 0);
    if (sDiff !== 0) return sDiff;
    return (b.totalEvaluated || 0) - (a.totalEvaluated || 0);
  });

  // Auto-mode champion resolution
  let effectiveInCharge = MobileState.inChargeModel;
  if (MobileState.autoMode !== false && sorted.length > 0) {
    if (isUserReset) {
      effectiveInCharge = sorted[0].name;
    } else if (MobileState.inchargeConfig?.predictionSource === 'LOCAL' && MobileState.workerStateByTf[tf]?.activeIncharge?.model?.name) {
      effectiveInCharge = MobileState.workerStateByTf[tf].activeIncharge.model.name;
    } else {
      const cloudState = MobileState.cloudUniversalState[tf];
      effectiveInCharge = cloudState?.inChargeModel || sorted[0].name;
    }
    MobileState.inChargeModel = effectiveInCharge;
    if (MobileState.inChargeByTf && tf) MobileState.inChargeByTf[tf] = effectiveInCharge;
    const heroName = $('heroModelName');
    // Governed verdict owns the hero when locked — never overwrite it
    // with a native in-charge name (owner order 2026-10-30).
    if (heroName && !window.__o101Verdict) heroName.textContent = effectiveInCharge;
    const champName = $('aiChampionName');
    if (champName) champName.textContent = effectiveInCharge;
  }

  // Champion card stats
  const champModel = sorted.find(m => m.name === effectiveInCharge) || sorted[0];
  if (champModel) {
    // No-fabrication: when neither the native prediction nor the model
    // has a target, show '—' — never an invented 'BIG'.
    const activeTarget = MobileState.activePrediction?.target || champModel.predTarget || '—';
    const activeType = MobileState.activePrediction?.type || champModel.predType || '—';
    champModel.predTarget = activeTarget;
    champModel.predType = activeType;

    const champTargetBadge = $('aiChampionTargetBadge');
    if (champTargetBadge) {
      champTargetBadge.textContent = activeTarget;
      champTargetBadge.className = `px-2 py-0.5 rounded font-black text-[8.5px] border ${
        activeTarget === 'BIG' ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' :
        activeTarget === 'SMALL' ? 'bg-sky-500/20 text-sky-300 border-sky-500/30' :
        activeTarget === 'GREEN' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' :
        activeTarget === 'RED' ? 'bg-rose-500/20 text-rose-300 border-rose-500/30' :
        activeTarget === 'VIOLET' ? 'bg-violet-500/20 text-violet-300 border-violet-500/30' :
        'bg-white/5 text-zinc-400 border-white/10'
      }`;
    }

    const champTypeBadge = $('aiChampionTypeBadge');
    if (champTypeBadge) champTypeBadge.textContent = activeType;

    const champRate = $('aiChampionRate');
    if (champRate) champRate.textContent = champModel.winRatePct || `${(getWinRate(champModel) * 100).toFixed(1)}%`;

    const champStreak = $('aiChampionStreak');
    if (champStreak) {
      const s = Number(champModel.streak || 0);
      champStreak.textContent = s >= 0 ? `+${s} W` : `${s} L`;
      champStreak.className = s >= 0 ? 'text-emerald-300 font-bold' : 'text-rose-400 font-bold';
    }

    const champDesc = $('aiChampionDesc');
    if (champDesc) {
      if (inchargeMode === 'LAST_10_WIN_RATE') {
        const p = (champModel.historyPath || []).slice(0, 10);
        const lwr = p.length > 0 ? ((p.filter(x => x.won).length / p.length) * 100).toFixed(0) : '0';
        champDesc.textContent = `⚡ Last 10 Champion (${lwr}% WR in last 10)`;
      } else if (inchargeMode === 'LAST_20_WIN_RATE') {
        const p = (champModel.historyPath || []).slice(0, 20);
        const lwr = p.length > 0 ? ((p.filter(x => x.won).length / p.length) * 100).toFixed(0) : '0';
        champDesc.textContent = `📊 Last 20 Champion (${lwr}% WR in last 20)`;
      } else if (inchargeMode === 'HIGHEST_STREAK') {
        champDesc.textContent = `🔥 Streak Leader (+${champModel.streak || 0}W streak)`;
      } else {
        champDesc.textContent = isUserReset
          ? `Leading session model (${champModel.winRatePct || '0.0%'} WR · ${champModel.wins || 0}W / ${champModel.losses || 0}L)`
          : (champModel.desc || `Leading model (+${champModel.streak || 0}W streak)`);
      }
    }
  }

  // Filter list
  let displayList = sorted;
  if (activeAlgoCategory !== 'all') {
    displayList = displayList.filter(a => {
      const c = (a.cat || '').toLowerCase();
      return c === activeAlgoCategory || c.includes(activeAlgoCategory) || activeAlgoCategory.includes(c);
    });
  }

  const query = ($('modelSearchInput')?.value || '').toLowerCase().trim();
  if (query) {
    displayList = displayList.filter(a =>
      (a.name || '').toLowerCase().includes(query) ||
      (a.cat || '').toLowerCase().includes(query) ||
      (a.id || '').toLowerCase().includes(query)
    );
  }

  const countTag = $('algoCountTag');
  if (countTag) countTag.textContent = `${displayList.length} Models`;
  const countHead = $('algoCountHead');
  if (countHead) countHead.textContent = allModels.length;

  // Dynamic category counts (never hardcoded 101)
  const catCounts = {};
  allModels.forEach(m => {
    const c = (m.cat || 'AI').toLowerCase();
    catCounts[c] = (catCounts[c] || 0) + 1;
  });
  const catBtnMap = {
    'all': allModels.length,
    'fly': catCounts['fly'] || 0,
    'neural': catCounts['neural'] || 0,
    'classical': catCounts['classical'] || 0,
    'signal': catCounts['signal'] || 0,
    'chaos': catCounts['chaos'] || 0,
    'game': catCounts['game'] || 0,
    'pattern': catCounts['pattern'] || 0,
    'quantum': catCounts['quantum'] || 0,
    'meta': catCounts['meta'] || 0,
    'statistical': catCounts['statistical'] || 0,
  };
  Object.entries(catBtnMap).forEach(([key, count]) => {
    const btn = $(`algoCat-${key === 'all' ? 'all' : key.charAt(0).toUpperCase() + key.slice(1)}`);
    if (btn) {
      const label = btn.textContent.replace(/\s*\(\d+\)\s*$/, '');
      btn.textContent = `${label} (${count})`;
    }
  });

  const listEl = $('aiRosterList');
  if (!listEl) return;

  // Analyse pagination: clamp into range first (never an empty page,
  // never past the ends), then slice one page. Ranks stay GLOBAL
  // (pageOffset + idx + 1) — page 2 shows #11–#20, not #1–#10 again.
  const totalPages = Math.max(1, Math.ceil(displayList.length / AI_ROSTER_PAGE_SIZE));
  if (aiRosterPage > totalPages) aiRosterPage = totalPages;
  if (aiRosterPage < 1) aiRosterPage = 1;
  const pageOffset = (aiRosterPage - 1) * AI_ROSTER_PAGE_SIZE;
  const pageList = displayList.slice(pageOffset, pageOffset + AI_ROSTER_PAGE_SIZE);
  const updateRosterPager = () => {
    const label = $('aiRosterPageLabel');
    if (label) label.textContent = `Page ${aiRosterPage} of ${totalPages}`;
    const prevBtn = $('aiRosterPrevBtn');
    if (prevBtn) { prevBtn.disabled = aiRosterPage <= 1; prevBtn.classList.toggle('opacity-40', aiRosterPage <= 1); }
    const nextBtn = $('aiRosterNextBtn');
    if (nextBtn) { nextBtn.disabled = aiRosterPage >= totalPages; nextBtn.classList.toggle('opacity-40', aiRosterPage >= totalPages); }
  };

  if (displayList.length === 0) {
    listEl.innerHTML = '<div class="text-center text-zinc-500 py-6 text-[9px] font-mono">No algorithms match your query.</div>';
    updateRosterPager();
    return;
  }

  const curHist = MobileState.historyByTf[tf] || [];
  displayList.forEach(a => {
    if (a.name === effectiveInCharge && MobileState.activePrediction?.target) {
      a.predTarget = MobileState.activePrediction.target;
      a.predType = MobileState.activePrediction.type;
    } else if (typeof window.generateModelNextPrediction === 'function') {
      try {
        const p = window.generateModelNextPrediction(a, curHist, {
          streak: a.streak || 0,
          dopamine: a.dopamine || 0.5,
          lossPain: a.lossPain || 0.0
        });
        if (p && p.predTarget) {
          a.predTarget = p.predTarget;
          a.predType = p.predType;
        }
      } catch(e) {}
    }
  });

  listEl.innerHTML = pageList.map((a, idx) => {
    const isLead = effectiveInCharge === a.name;
    const streakNum = Number(a.streak || 0);
    const isWinStreak = streakNum >= 0;
    const streakStr = isWinStreak ? `+${streakNum}W` : `${streakNum}L`;
    const streakClass = isWinStreak
      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
      : 'bg-rose-500/15 text-rose-300 border border-rose-500/30';

    const dots = (a.historyPath || []).slice(0, 5);
    const dotsHtml = Array.from({ length: 5 }, (_, i) => {
      const h = dots[i];
      if (!h) return '<span class="w-1.5 h-1.5 rounded-full bg-white/10 inline-block"></span>';
      return h.won === true
        ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block shadow-[0_0_4px_rgba(52,211,153,0.5)]"></span>'
        : '<span class="w-1.5 h-1.5 rounded-full bg-rose-400 inline-block shadow-[0_0_4px_rgba(244,63,94,0.5)]"></span>';
    }).join('');

    // Phase 3D quarantine retirement: no lock state on cards anymore.
    const cardClass = isLead
      ? 'p-2.5 rounded-2xl bg-black/60 border border-emerald-500/40 shadow-[0_0_16px_rgba(52,211,153,0.12)]'
      : 'p-2.5 rounded-2xl bg-black/40 border border-white/[0.06] hover:border-white/[0.12] transition';

    const wr = (() => {
      const n = getModelN(a);
      const w = getModelWins(a);
      if (n === 0) return 'no data';
      if (n < MIN_N_FOR_WR) return 'warming up';
      const rawPct = ((w / n) * 100).toFixed(1);
      const wilsonPct = (calculateWilsonScore(w, n) * 100).toFixed(1);
      return `${rawPct}% (W ${wilsonPct}%)`;
    })();
    const wrDisplay = wr === 'no data' || wr === 'warming up'
      ? `<b class="text-zinc-500">${wr}</b>`
      : `<b class="text-emerald-400">${wr}</b>`;
    const tColor = a.predTarget === 'BIG' ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
      : a.predTarget === 'SMALL' ? 'bg-sky-500/20 text-sky-300 border-sky-500/30'
      : a.predTarget === 'GREEN' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
      : a.predTarget === 'RED' ? 'bg-rose-500/20 text-rose-300 border-rose-500/30'
      : a.predTarget === 'VIOLET' ? 'bg-violet-500/20 text-violet-300 border-violet-500/30'
      : 'bg-white/5 text-zinc-400 border-white/10';

    return `<div class="${cardClass} flex items-center justify-between font-mono text-[9px]">
      <div class="flex items-center gap-2 relative z-10">
        <span class="text-[8px] text-zinc-500 w-5 font-bold">#${pageOffset + idx + 1}</span>
        <div>
          <div class="flex items-center gap-1.5">
            <span class="font-bold text-white max-w-[150px] truncate">${a.name}</span>
            ${isLead ? '<span class="px-1.5 py-0.2 rounded bg-amber-400 text-black text-[7px] font-black font-mono">IN CHARGE</span>' : ''}
            <span class="px-1.5 py-0.2 rounded ${tColor} border text-[7px] font-black">${a.predTarget || '—'}</span>
          </div>
          <div class="flex items-center gap-1.5 mt-0.5 text-[8px] text-zinc-400">
            <span class="px-1 py-0.2 rounded bg-white/5 border-white/10 border uppercase">${a.cat || 'AI'}</span>
            <span>WR: ${wrDisplay} (${a.wins||0}W/${a.losses||0}L)</span>
            <div class="flex gap-0.5">${dotsHtml}</div>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-1.5 relative z-10">
        <span class="px-1.5 py-0.5 rounded text-[8px] font-black ${streakClass}">${isWinStreak ? '🔥 ' : '❄️ '}${streakStr}</span>
        <button onclick="setInChargeModel('${a.name.replace(/'/g, "\\'")}')"
          class="px-2 py-1 rounded-xl ${isLead ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/30'} text-[8px] font-black active:scale-95 transition">
          ${isLead ? 'Selected' : 'Select'}
        </button>
      </div>
    </div>`;
  }).join('');

  updateRosterPager();

}
window.renderModelRosterUI = renderModelRosterUI;



function setInChargeModel(name) {
  MobileState.inChargeModel = name;
  MobileState.autoMode = false;
  try { localStorage.setItem('quant_arena_auto', '0'); } catch(e) {}

  const btn = $('aiAutoModeBtn');
  const txt = $('aiAutoModeText');
  if (txt) txt.textContent = 'MANUAL LOCK';
  if (btn) btn.className = 'px-2 py-0.5 rounded-full font-mono text-[8px] font-black bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1 active:scale-95 transition';

  setText('aiChampionName', name);
  // Governed verdict owns the hero when locked — never overwrite it
  // with a native in-charge name (owner order 2026-10-30).
  if (!window.__o101Verdict) setText('heroModelName', name);

  renderModelRosterUI();
  renderAuthoritativeAIPrediction(MobileState.historyByTf[MobileState.timeframe] || []);
}
window.setInChargeModel = setInChargeModel;

function toggleMobileAutoMode() {
  MobileState.autoMode = !MobileState.autoMode;
  const btn = $('aiAutoModeBtn');
  const txt = $('aiAutoModeText');

  if (MobileState.autoMode) {
    try { localStorage.removeItem('quant_arena_auto'); } catch(e) {}
    if (txt) txt.textContent = 'AUTO: ON';
    if (btn) btn.className = 'px-2 py-0.5 rounded-full font-mono text-[8px] font-black bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1 active:scale-95 transition';
  } else {
    try { localStorage.setItem('quant_arena_auto', '0'); } catch(e) {}
    if (txt) txt.textContent = 'MANUAL LOCK';
    if (btn) btn.className = 'px-2 py-0.5 rounded-full font-mono text-[8px] font-black bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1 active:scale-95 transition';
  }
  renderModelRosterUI();
}
window.toggleMobileAutoMode = toggleMobileAutoMode;

// ── 21. Full-Featured TradingView Chart Engine ────────────────────────────────

let mobileTradingChartInstance = null;
let mobileTradingMainSeries = null;
let mobileTradingSMAIndicatorSeries = null;
let mobileTradingEMAIndicatorSeries = null;
let mobileTradingBBUpperSeries = null;
let mobileTradingBBMiddleSeries = null;
let mobileTradingBBLowerSeries = null;
let mobileTradingChartType = 'candles';
let mobileTradingIndicators = { sma: false, ema: false, bb: false };
let mobileTradingBarSpacing = 12;

function initChart() {
  const container = $('mobileChartContainer');
  if (!container || !window.LightweightCharts) return false;

  if (mobileTradingChartInstance) {
    try { mobileTradingChartInstance.remove(); } catch(e) {}
    mobileTradingChartInstance = null;
    mobileTradingMainSeries = null;
  }

  if (window._mobileChartResizeObserver) {
    try { window._mobileChartResizeObserver.disconnect(); } catch(e) {}
    window._mobileChartResizeObserver = null;
  }

  try {
    container.innerHTML = '';
    container._lastRenderSig = null;
    const LC = window.LightweightCharts;
    const width = container.clientWidth || Math.min(window.innerWidth - 28, 440);
    const height = container.clientHeight || 208;

    const chart = LC.createChart(container, {
      width, height,
      layout: {
        background: { color: '#09090b' },
        textColor: '#888888',
        fontSize: 10,
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif'
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' }
      },
      crosshair: {
        mode: LC.CrosshairMode ? LC.CrosshairMode.Normal : 0,
        vertLine: { color: 'rgba(245,158,11,0.6)', width: 1, style: 2 },
        horzLine: { color: 'rgba(245,158,11,0.6)', width: 1, style: 2 }
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        autoScale: true,
        scaleMargins: { top: 0.15, bottom: 0.15 }
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: true,
        secondsVisible: false,
        barSpacing: mobileTradingBarSpacing,
        minBarSpacing: 5,
        maxBarSpacing: 40,
        fixLeftEdge: false,
        fixRightEdge: false
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true }
    });

    chart.subscribeCrosshairMove(param => {
      if (!param.point || !mobileTradingMainSeries) return;
      const data = param.seriesData.get(mobileTradingMainSeries);
      if (data) {
        const open = data.open !== undefined ? data.open : data.value;
        const high = data.high !== undefined ? data.high : data.value;
        const low = data.low !== undefined ? data.low : data.value;
        const close = data.close !== undefined ? data.close : data.value;
        const isUp = close >= open;

        const elO = $('hudOpen'), elH = $('hudHigh'), elL = $('hudLow'), elC = $('hudClose'), elR = $('hudResult');
        if (elO) elO.textContent = Number(open).toFixed(1);
        if (elH) elH.textContent = Number(high).toFixed(1);
        if (elL) elL.textContent = Number(low).toFixed(1);
        if (elC) elC.textContent = Number(close).toFixed(1);
        if (elR) {
          if (MobileState.chartMode === 'winloss') {
            elR.textContent = isUp ? '✓ AI WIN' : '✗ AI LOSS';
            elR.className = isUp ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold';
          } else {
            elR.textContent = isUp ? '▲ BIG (UP)' : '▼ SMALL (DOWN)';
            elR.className = isUp ? 'text-amber-400 font-bold' : 'text-sky-400 font-bold';
          }
        }
      }
    });

    if (window.ResizeObserver) {
      let lastW = Math.round(width), lastH = Math.round(height);
      let roDebounce = null;
      const ro = new ResizeObserver(entries => {
        if (!entries?.[0] || !mobileTradingChartInstance) return;
        const { width: w, height: h } = entries[0].contentRect;
        const curW = Math.round(w);
        const curH = Math.round(h);
        if (curW > 0 && curH > 0 && (Math.abs(curW - lastW) >= 4 || Math.abs(curH - lastH) >= 4)) {
          if (roDebounce) clearTimeout(roDebounce);
          roDebounce = setTimeout(() => {
            if (mobileTradingChartInstance) {
              lastW = curW;
              lastH = curH;
              mobileTradingChartInstance.applyOptions({ width: curW, height: curH });
            }
          }, 60);
        }
      });
      ro.observe(container);
      window._mobileChartResizeObserver = ro;
    }

    mobileTradingChartInstance = chart;
    MobileState.chart = chart;
    rebuildMobileTradingSeries();
    return true;
  } catch(e) {
    console.warn('LightweightCharts init error:', e);
    return false;
  }
}
window.initChart = initChart;

function rebuildMobileTradingSeries() {
  if (!mobileTradingChartInstance || !window.LightweightCharts) return;
  const chart = mobileTradingChartInstance;
  const LC = window.LightweightCharts;

  [mobileTradingMainSeries, mobileTradingSMAIndicatorSeries, mobileTradingEMAIndicatorSeries,
   mobileTradingBBUpperSeries, mobileTradingBBMiddleSeries, mobileTradingBBLowerSeries].forEach(s => {
    if (s) { try { chart.removeSeries(s); } catch(e) {} }
  });
  mobileTradingMainSeries = mobileTradingSMAIndicatorSeries = mobileTradingEMAIndicatorSeries = null;
  mobileTradingBBUpperSeries = mobileTradingBBMiddleSeries = mobileTradingBBLowerSeries = null;

  const isWinLoss = MobileState.chartMode === 'winloss';

  if (mobileTradingChartType === 'hollow') {
    mobileTradingMainSeries = chart.addSeries(LC.CandlestickSeries, {
      upColor: '#09090b', downColor: '#ef5350',
      borderUpColor: '#10b981', borderDownColor: '#ef5350',
      wickUpColor: '#10b981', wickDownColor: '#ef5350'
    });
  } else if (mobileTradingChartType === 'bar') {
    mobileTradingMainSeries = chart.addSeries(LC.BarSeries, { upColor: '#10b981', downColor: '#ef5350' });
  } else if (mobileTradingChartType === 'line') {
    mobileTradingMainSeries = chart.addSeries(LC.LineSeries, { color: '#38bdf8', lineWidth: 2 });
  } else if (mobileTradingChartType === 'area') {
    mobileTradingMainSeries = chart.addSeries(LC.AreaSeries, {
      topColor: 'rgba(56,189,248,0.4)', bottomColor: 'rgba(56,189,248,0.0)',
      lineColor: '#38bdf8', lineWidth: 2
    });
  } else {
    mobileTradingMainSeries = chart.addSeries(LC.CandlestickSeries, {
      upColor: isWinLoss ? '#10b981' : '#26a69a',
      downColor: isWinLoss ? '#f43f5e' : '#ef5350',
      borderVisible: false,
      wickUpColor: isWinLoss ? '#10b981' : '#26a69a',
      wickDownColor: isWinLoss ? '#f43f5e' : '#ef5350'
    });
  }

  if (mobileTradingIndicators.sma) {
    mobileTradingSMAIndicatorSeries = chart.addSeries(LC.LineSeries, { color: '#38bdf8', lineWidth: 1.5, title: 'SMA 14' });
  }
  if (mobileTradingIndicators.ema) {
    mobileTradingEMAIndicatorSeries = chart.addSeries(LC.LineSeries, { color: '#f59e0b', lineWidth: 1.5, title: 'EMA 9' });
  }
  if (mobileTradingIndicators.bb) {
    mobileTradingBBMiddleSeries = chart.addSeries(LC.LineSeries, { color: '#a855f7', lineWidth: 1, title: 'BB Mid' });
    mobileTradingBBUpperSeries = chart.addSeries(LC.LineSeries, { color: '#10b981', lineWidth: 1, lineStyle: 2, title: 'BB Up' });
    mobileTradingBBLowerSeries = chart.addSeries(LC.LineSeries, { color: '#ef5350', lineWidth: 1, lineStyle: 2, title: 'BB Low' });
  }

  MobileState.candleSeries = mobileTradingMainSeries;

  const container = $('mobileChartContainer');
  if (container) container._lastRenderSig = null;

  const list = MobileState.historyByTf[MobileState.timeframe] || [];
  if (list.length > 0) renderChartData(list);
}

function setChartDisplayMode(mode) {
  if (mode !== 'candles' && mode !== 'winloss') mode = 'candles';
  MobileState.chartMode = mode;
  try { localStorage.setItem('quant_chart_mode', mode); } catch(e) {}

  const btnC = $('chartModeBtnCandles'), btnW = $('chartModeBtnWinLoss');
  if (btnC && btnW) {
    if (mode === 'candles') {
      btnC.className = 'px-1.5 py-0.5 rounded text-[8px] font-mono font-bold transition active:scale-95 bg-white/20 text-white shadow-sm';
      btnW.className = 'px-1.5 py-0.5 rounded text-[8px] font-mono font-bold transition active:scale-95 text-white/50 hover:text-white';
    } else {
      btnW.className = 'px-1.5 py-0.5 rounded text-[8px] font-mono font-bold transition active:scale-95 bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 shadow-sm';
      btnC.className = 'px-1.5 py-0.5 rounded text-[8px] font-mono font-bold transition active:scale-95 text-white/50 hover:text-white';
    }
  }
  rebuildMobileTradingSeries();
}
window.setChartDisplayMode = setChartDisplayMode;

function switchTradingChartType(type) {
  mobileTradingChartType = type || 'candles';
  rebuildMobileTradingSeries();
}
window.switchTradingChartType = switchTradingChartType;

function toggleTradingIndicator(ind) {
  if (mobileTradingIndicators[ind] !== undefined) {
    mobileTradingIndicators[ind] = !mobileTradingIndicators[ind];
    const btnId = ind === 'sma' ? 'btnMobileSMA' : ind === 'ema' ? 'btnMobileEMA' : 'btnMobileBB';
    const btn = $(btnId);
    if (btn) {
      if (mobileTradingIndicators[ind]) {
        btn.className = 'px-1.5 py-0.5 rounded bg-amber-500/25 text-amber-300 border border-amber-400/50 font-bold active:scale-95 transition';
      } else {
        btn.className = 'px-1.5 py-0.5 rounded bg-white/5 text-zinc-400 border border-white/5 hover:text-white active:scale-95 transition';
      }
    }
    rebuildMobileTradingSeries();
  }
}
window.toggleTradingIndicator = toggleTradingIndicator;

function tradingChartZoom(dir) {
  if (!mobileTradingChartInstance) return;
  mobileTradingBarSpacing = Math.max(5, Math.min(45, mobileTradingBarSpacing + (dir * 3)));
  mobileTradingChartInstance.timeScale().applyOptions({ barSpacing: mobileTradingBarSpacing });
}
window.tradingChartZoom = tradingChartZoom;

function tradingChartReset() {
  if (mobileTradingChartInstance) {
    try { mobileTradingChartInstance.timeScale().fitContent(); } catch(e) {}
  }
}
window.tradingChartReset = tradingChartReset;

function getDeterministicBarTime(periodStr, idx, tf) {
  const step = TF_SECONDS[tf] || 30;
  if (typeof periodStr === 'string' && periodStr.length >= 17) {
    const y = parseInt(periodStr.slice(0, 4), 10);
    const mo = parseInt(periodStr.slice(4, 6), 10) - 1;
    const d = parseInt(periodStr.slice(6, 8), 10);
    const pIdx = parseInt(periodStr.slice(13), 10);
    if (!isNaN(y) && !isNaN(mo) && !isNaN(d) && !isNaN(pIdx)) {
      return Math.floor(Date.UTC(y, mo, d) / 1000) + (pIdx * step);
    }
  }
  const pNum = parseInt(periodStr, 10);
  if (!isNaN(pNum) && pNum > 1000000000) {
    return 1700000000 + ((pNum % 1000000) * step);
  }
  return 1710000000 + (idx * step);
}

function renderChartData(list) {
  if (!list || list.length === 0) return;
  const container = $('mobileChartContainer');
  if (!container) return;

  if (!mobileTradingChartInstance || !mobileTradingMainSeries) {
    initChart();
    if (!mobileTradingChartInstance || !mobileTradingMainSeries) return;
  }

  const tf = MobileState.timeframe;
  const activeHist = list.slice(-50);
  const latestRow = activeHist[activeHist.length - 1];
  const renderSig = `${tf}_${activeHist.length}_${latestRow?.period}_${latestRow?.number}_${MobileState.chartMode}_${mobileTradingChartType}`;

  if (container._lastRenderSig === renderSig) {
    return; // Data has not changed; preserve existing zoom and pan state
  }
  container._lastRenderSig = renderSig;

  const isWinLoss = MobileState.chartMode === 'winloss';
  const candles = [];
  const markers = [];
  let prevClose = 0.0;
  let prevBarTime = 0;
  let bigCount = 0, smallCount = 0, currentStreak = 0, lastSize = '';

  for (let i = 0; i < activeHist.length; i++) {
    const r = activeHist[i];
    const isSizeBig = r.size === 'BIG' || (typeof r.number === 'number' && r.number >= 5);
    const num = (r.number !== undefined && r.number !== null) ? Number(r.number) : (isSizeBig ? 7 : 2);
    const color = r.color || (num === 0 || num === 5 ? 'violet' : [1,3,7,9].includes(num) ? 'green' : 'red');

    let isWin = false, hasPrediction = false;
    if (r.aiCorrect !== undefined && r.aiCorrect !== null) {
      hasPrediction = true;
      isWin = !!r.aiCorrect;
    } else if (r.result === 'WIN' || r.result === 'LOSS') {
      hasPrediction = true;
      isWin = (r.result === 'WIN');
    } else if (r.aiTarget) {
      hasPrediction = true;
      isWin = !!evaluatePredictionCorrectness(r.aiTarget, num, r.size, color);
    }

    const isUp = isWinLoss ? (hasPrediction ? isWin : isSizeBig) : isSizeBig;

    if (isSizeBig) bigCount++; else smallCount++;
    if (r.size === lastSize) currentStreak++; else { currentStreak = 1; lastSize = r.size; }

    const open = prevClose;
    let close, high, low;

    if (isWinLoss) {
      close = open + (isUp ? 1 : -1);
      high = isUp ? close + 0.2 : open + 0.2;
      low = isUp ? open - 0.2 : close - 0.2;
    } else {
      const delta = Math.max(1, isSizeBig ? (num >= 5 ? num - 4 : 1) : (num <= 4 ? 5 - num : 1));
      close = open + (isUp ? delta : -delta);
      high = isUp ? close + 0.4 : open + 0.2;
      low = isUp ? open - 0.2 : close - 0.4;
    }

    let candleTime = getDeterministicBarTime(r.period, i, tf);
    if (candleTime <= prevBarTime) {
      candleTime = prevBarTime + (TF_SECONDS[tf] || 30);
    }
    prevBarTime = candleTime;
    prevClose = close;
    candles.push({ time: candleTime, open, high, low, close });

    let markerColor = '#26a69a', markerShape = 'circle';
    let markerText = `${num} ${r.size ? r.size[0] : ''}`;

    if (isWinLoss) {
      if (hasPrediction) {
        markerColor = isWin ? '#10b981' : '#f43f5e';
        markerShape = isWin ? 'arrowUp' : 'arrowDown';
        markerText = isWin ? `W${num}` : `L${num}`;
      } else {
        markerColor = '#71717a'; markerShape = 'circle';
      }
    } else {
      if (color.includes('violet') || num === 0 || num === 5) { markerColor = '#c084fc'; markerShape = 'square'; }
      else if (color.includes('red') || [2,4,6,8].includes(num)) { markerColor = '#f43f5e'; }
      if (hasPrediction) markerText = `${num}${isWin ? '✓' : '✗'}`;
    }

    markers.push({ time: candleTime, position: isUp ? 'aboveBar' : 'belowBar', color: markerColor, shape: markerShape, text: markerText });
  }

  try {
    if (mobileTradingChartType === 'line' || mobileTradingChartType === 'area') {
      mobileTradingMainSeries.setData(candles.map(c => ({ time: c.time, value: c.close })));
    } else {
      mobileTradingMainSeries.setData(candles);
    }

    if (typeof window.LightweightCharts?.createSeriesMarkers === 'function') {
      window.LightweightCharts.createSeriesMarkers(mobileTradingMainSeries, markers);
    } else if (typeof mobileTradingMainSeries.setMarkers === 'function') {
      mobileTradingMainSeries.setMarkers(markers);
    }

    // SMA 14
    if (mobileTradingSMAIndicatorSeries && candles.length >= 14) {
      const smaData = []; let sum = 0;
      for (let i = 0; i < candles.length; i++) {
        sum += candles[i].close;
        if (i >= 14) sum -= candles[i - 14].close;
        if (i >= 13) smaData.push({ time: candles[i].time, value: Number((sum / 14).toFixed(2)) });
      }
      mobileTradingSMAIndicatorSeries.setData(smaData);
    }

    // EMA 9
    if (mobileTradingEMAIndicatorSeries && candles.length >= 9) {
      const emaData = []; const k = 2 / 10; let prev = candles[0].close;
      for (let i = 0; i < candles.length; i++) {
        prev = candles[i].close * k + prev * (1 - k);
        if (i >= 8) emaData.push({ time: candles[i].time, value: Number(prev.toFixed(2)) });
      }
      mobileTradingEMAIndicatorSeries.setData(emaData);
    }

    // Bollinger Bands
    if (mobileTradingBBMiddleSeries && mobileTradingBBUpperSeries && mobileTradingBBLowerSeries && candles.length >= 20) {
      const midData = [], upData = [], lowData = [];
      for (let i = 19; i < candles.length; i++) {
        const slice = candles.slice(i - 19, i + 1);
        const mean = slice.reduce((a, b) => a + b.close, 0) / 20;
        const sd = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b.close - mean, 2), 0) / 20);
        midData.push({ time: candles[i].time, value: Number(mean.toFixed(2)) });
        upData.push({ time: candles[i].time, value: Number((mean + 2 * sd).toFixed(2)) });
        lowData.push({ time: candles[i].time, value: Number((mean - 2 * sd).toFixed(2)) });
      }
      mobileTradingBBMiddleSeries.setData(midData);
      mobileTradingBBUpperSeries.setData(upData);
      mobileTradingBBLowerSeries.setData(lowData);
    }

    // Only auto-fit content on the initial render of this timeframe, never on background polling
    if (!window._chartFittedByTf) window._chartFittedByTf = {};
    if (!window._chartFittedByTf[tf]) {
      try {
        mobileTradingChartInstance.timeScale().fitContent();
        window._chartFittedByTf[tf] = true;
      } catch(e) {}
    }
  } catch(e) {
    console.warn('Chart render error:', e);
  }

  // Footer stats
  const total = (bigCount + smallCount) || 1;
  const bigPct = Math.round((bigCount / total) * 100);
  const smallPct = 100 - bigPct;
  const elNet = $('tradingNetPrice'), elBig = $('tradingBigPct'), elSml = $('tradingSmallPct'), elStrk = $('tradingActiveStreak');
  if (elNet) { elNet.textContent = prevClose >= 0 ? `+${prevClose.toFixed(1)}` : prevClose.toFixed(1); elNet.className = prevClose >= 0 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'; }
  if (elBig) elBig.textContent = `${bigPct}%`;
  if (elSml) elSml.textContent = `${smallPct}%`;
  if (elStrk) { elStrk.textContent = lastSize ? `${lastSize[0]}:${currentStreak}` : '—'; elStrk.className = lastSize === 'BIG' ? 'text-amber-400 font-bold' : 'text-sky-400 font-bold'; }

  // Chart TF label
  const tfLabel = $('chartTfLabel');
  if (tfLabel) tfLabel.textContent = `WinGo ${MobileState.timeframe.toUpperCase()}`;
}
window.renderChartData = renderChartData;

// ── 22. Simulation Bot ────────────────────────────────────────────────────────

function toggleSimBot() {
  MobileState.sim.running = !MobileState.sim.running;
  const btn = $('simBotToggleBtn');
  if (btn) {
    if (MobileState.sim.running) {
      btn.textContent = '⏹ STOP';
      btn.className = 'px-2.5 py-1 rounded-xl text-[9px] font-black uppercase tracking-wider bg-rose-500/20 text-rose-300 border border-rose-500/40 active:scale-95 transition';
    } else {
      btn.textContent = '▶ START';
      btn.className = 'px-2.5 py-1 rounded-xl text-[9px] font-black uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 active:scale-95 transition';
      MobileState.sim.pendingBet = null;
    }
  }
  if (MobileState.sim.running) {
    const active = MobileState.activePrediction;
    if (active && active.target && active.period) {
      initSimBet(active.target, active.period);
    }
  }
  updateSimUI();
}
window.toggleSimBot = toggleSimBot;

function initSimBet(target, period) {
  if (!MobileState.sim.running) return;
  if (MobileState.sim.pendingBet) return;

  const stake = MobileState.sim.stake;
  if (MobileState.sim.balance < stake) {
    MobileState.sim.running = false;
    toggleSimBot();
    return;
  }

  MobileState.sim.pendingBet = { target, period: String(period), stake };
  logSimEntry(`🔮 Placed ${target} · ₹${stake} · Period #${shortPeriodStr(period)}`);
}
window.initSimBet = initSimBet;

function resolveSimBet(size, isWin) {
  const bet = MobileState.sim.pendingBet;
  if (!bet) return;

  const profit = isWin ? (bet.stake * 0.96) : -bet.stake;
  MobileState.sim.balance += profit;
  MobileState.sim.pnl += profit;
  MobileState.sim.totalBets++;

  if (isWin) {
    MobileState.sim.wins++;
    MobileState.sim.stake = MobileState.sim.baseStake; // Reset after win
    MobileState.sim.level = 0;
    logSimEntry(`✅ WIN +₹${(bet.stake * 0.96).toFixed(2)} · Balance: ₹${MobileState.sim.balance.toFixed(0)}`, 'win');
  } else {
    MobileState.sim.losses++;
    MobileState.sim.level = Math.min(MobileState.sim.level + 1, 5);
    MobileState.sim.stake = MobileState.sim.baseStake * Math.pow(2, MobileState.sim.level); // Martingale
    logSimEntry(`❌ LOSS -₹${bet.stake.toFixed(2)} · Next: ₹${MobileState.sim.stake}`, 'loss');
  }

  MobileState.sim.pendingBet = null;
  updateSimUI();

  // Schedule next bet with next AI signal
  if (MobileState.sim.running) {
    const active = MobileState.activePrediction;
    if (active && active.target) {
      setTimeout(() => initSimBet(active.target, computeRTState(MobileState.timeframe).periodStr), 500);
    }
  }
}
window.resolveSimBet = resolveSimBet;

function updateSimUI() {
  const balEl = $('simBalanceVal');
  if (balEl) balEl.textContent = `₹${MobileState.sim.balance.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

  const pnl = MobileState.sim.pnl;
  const pnlEl = $('simPnlVal');
  if (pnlEl) {
    const pnlPct = ((pnl / 10000) * 100).toFixed(1);
    pnlEl.textContent = `${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(0)} (${pnlPct}%)`;
    pnlEl.className = `text-xl font-black font-mono ${pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
  }

  const stakeEl = $('simActiveStake');
  if (stakeEl) stakeEl.textContent = `₹${MobileState.sim.stake} (Level ${MobileState.sim.level})`;

  setText('simRoundsCount', String(MobileState.sim.totalBets));
}

function setSimBaseStake(val) {
  MobileState.sim.baseStake = Number(val);
  MobileState.sim.stake = MobileState.sim.baseStake;
  MobileState.sim.level = 0;
  // Persist so the Settings page's stake control and these chips share
  // one value (quant_sim_stake was previously written by Settings but
  // never read anywhere).
  try { localStorage.setItem('quant_sim_stake', String(MobileState.sim.baseStake)); } catch (e) {}
  updateSimUI();
}
window.setSimBaseStake = setSimBaseStake;

function resetSimBot() {
  MobileState.sim.running = false;
  MobileState.sim.balance = 10000;
  MobileState.sim.baseStake = 10;
  MobileState.sim.stake = 10;
  MobileState.sim.level = 0;
  MobileState.sim.pendingBet = null;
  MobileState.sim.totalBets = 0;
  MobileState.sim.wins = 0;
  MobileState.sim.losses = 0;
  MobileState.sim.pnl = 0;

  const btn = $('simBotToggleBtn');
  if (btn) { btn.textContent = '▶ START'; btn.className = 'px-2.5 py-1 rounded-xl text-[9px] font-black uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 active:scale-95 transition'; }

  const logEl = $('simLogList');
  if (logEl) logEl.innerHTML = '<div class="text-zinc-500 py-3 text-center">Bot is on standby. Click START to begin.</div>';

  updateSimUI();
}
window.resetSimBot = resetSimBot;

function logSimEntry(msg, type = 'info') {
  const logEl = $('simLogList');
  if (!logEl) return;
  const existingEmpty = logEl.querySelector('.text-zinc-500');
  if (existingEmpty) existingEmpty.remove();

  const color = type === 'win' ? 'text-emerald-400' : type === 'loss' ? 'text-rose-400' : 'text-zinc-300';
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  const entry = document.createElement('div');
  entry.className = `flex items-center justify-between py-1 border-b border-white/[0.04] ${color}`;
  entry.innerHTML = `<span>${msg}</span><span class="text-[7px] text-zinc-500 ml-2 shrink-0">${ts}</span>`;
  logEl.insertBefore(entry, logEl.firstChild);

  // Keep last 20 entries
  while (logEl.children.length > 20) logEl.removeChild(logEl.lastChild);
}

const DHANIWIN_INTERVAL_URLS = {
  '30s': 'https://dhaniwin44.com/WinGo/WinGo_30S',
  '1m':  'https://dhaniwin44.com/WinGo/WinGo_1M',
  '3m':  'https://dhaniwin44.com/WinGo/WinGo_3M',
  '5m':  'https://dhaniwin44.com/WinGo/WinGo_5M'
};
const DHANIWIN_REGISTRATION_URL = 'https://dhaniwin44.com/register?inviteCode=EEJKXQN&from=app';
const DHANIWIN_LOGIN_URL = 'https://dhaniwin44.com/login';
const DHANIWIN_HOME_URL = 'https://dhaniwin44.com/';

// ── DhaniWin transport: proxy vs direct ─────────────────────────────
// PIVOT: the game frame loads DhaniWin DIRECTLY and the APK injects
// the bridge natively into the frame (MainActivity), so a direct
// load DOES carry the bridge and CAN API-prove login + balance.
// The worker frame survives only as an explicit override
// (dhaniFrameUseProxy). Built-in DhaniWin URLs therefore stay
// direct by default; a user-customised entry URL (a mirror domain
// they chose) is left exactly as set, as before.
function proxifyDhaniUrl(url) {
  return window.DhaniTransport ? window.DhaniTransport.proxifyDhaniUrl(url, CF_WORKER_BASE) : url;
}
function unproxifyDhaniUrl(url) {
  return window.DhaniTransport ? window.DhaniTransport.unproxifyDhaniUrl(url, CF_WORKER_BASE) : url;
}
// PIVOT — direct frame default: the game frame loads DhaniWin
// DIRECTLY and the APK injects the bridge natively. The worker
// frame survives ONLY as an explicit override: localStorage
// 'o101_dhani_frame_proxy' === '1'. This key is separate from
// 'o101_dhani_transport' (which noteDhaniTransport overwrites on
// every load with the ACTUAL transport) so a direct load can never
// erase the override. No Settings UI: the override is a power-user
// escape hatch, never the default.
const DHANI_FRAME_PROXY_KEY = 'o101_dhani_frame_proxy';
function dhaniFrameUseProxy() {
  try { return localStorage.getItem(DHANI_FRAME_PROXY_KEY) === '1'; } catch (e) { return false; }
}
window.dhaniFrameUseProxy = dhaniFrameUseProxy;
// Interval deep links: direct by default (pivot); proxified only
// under the explicit proxy override, so the bridge is present on
// the WinGo pages themselves either way.
for (const tfKey of Object.keys(DHANIWIN_INTERVAL_URLS)) {
  if (dhaniFrameUseProxy()) DHANIWIN_INTERVAL_URLS[tfKey] = proxifyDhaniUrl(DHANIWIN_INTERVAL_URLS[tfKey]);
}

const DHANI_TRANSPORT_KEY = 'o101_dhani_transport';
const DHANI_PROXY_FAILED_KEY = 'o101_dhani_proxy_failed';
const DHANI_PROXY_LOAD_TIMEOUT_MS = 15000;
// After a proxied document finishes loading, the bridge gets this
// long to prove it is alive inside the page (its state publish /
// handshake). A browser DNS-error page also fires `load` — and never
// brings a bridge — so "load completed" alone is NOT proof the proxy
// worked. No bridge signal inside this window ⇒ the proxy route is
// treated as failed and the app falls back to the direct URL.
const DHANI_PROXY_BRIDGE_SIGNAL_MS = 5000;
let _dhaniProxyWatchdog = null;
let _dhaniBridgeSignalTimer = null;
let _dhaniProxyFallbackUsed = false;
let _dhaniIframeLoadHooked = false;
let _dhaniExpectedProxyUrl = null;
let _dhaniBridgeSeenForLoad = false;
let _dhaniProxyFailed = false;

function clearDhaniProxyWatchdog() {
  if (_dhaniProxyWatchdog) { clearTimeout(_dhaniProxyWatchdog); _dhaniProxyWatchdog = null; }
}
function clearDhaniBridgeSignalTimer() {
  if (_dhaniBridgeSignalTimer) { clearTimeout(_dhaniBridgeSignalTimer); _dhaniBridgeSignalTimer = null; }
}
function markDhaniProxyFailed(reason) {
  _dhaniProxyFailed = true;
  window.__o101DhaniProxyFailed = true;
  try { localStorage.setItem(DHANI_PROXY_FAILED_KEY, String(reason || 'failed')); } catch (e) {}
}
function clearDhaniProxyFailed() {
  _dhaniProxyFailed = false;
  window.__o101DhaniProxyFailed = false;
  try { localStorage.removeItem(DHANI_PROXY_FAILED_KEY); } catch (e) {}
}
// A live bridge message (handshake / heartbeat / user state) is the
// only proof the proxied page really carries the bridge. It cancels
// every pending fallback and clears any earlier proxy-failure record:
// the route demonstrably works now.
function noteDhaniBridgeSignal() {
  _dhaniBridgeSeenForLoad = true;
  clearDhaniProxyWatchdog();
  clearDhaniBridgeSignalTimer();
  if (_dhaniProxyFailed || window.__o101DhaniProxyFailed) clearDhaniProxyFailed();
}
window.noteDhaniBridgeSignal = noteDhaniBridgeSignal;
// One-shot fallback for a failed proxied DhaniWin load. When a
// worker base is configured, the fallback NEVER swaps to the direct
// URL: direct has no worker-host cookies, so the swap instantly
// kills the session and shows the login screen (case-1: "after
// loading it reloads and auto logout"). Instead it retries the
// proxied URL once (cache-busted so the retry really navigates);
// if the retry also brings no bridge signal, no further fallback
// fires (one-shot) and the honest error state below stands. A
// live bridge signal on the retry clears the failure record via
// noteDhaniBridgeSignal, as before. Without a worker base, direct
// is the only mode, so the old direct swap is kept exactly.
// Never fakes a bridge on any route.
function runDhaniProxyFallback(reason) {
  if (_dhaniProxyFallbackUsed) return;
  // Pivot guard: a direct frame must NEVER be "retried" onto the
  // proxy — that swap would drop the direct session and re-enter
  // the broken proxy path. Report honestly and stay put.
  if (window.__o101DhaniTransport === 'direct') {
    setMobileBridgeStatus(false, 'Direct DhaniWin load — bridge inactive · reopen the DhaniWin tab in the app');
    return;
  }
  const iframe = $('dhaniwinIframe');
  const expected = _dhaniExpectedProxyUrl || (iframe ? iframe.src : null);
  if (!expected) return;
  if (iframe && iframe.src !== expected) return; // user already navigated elsewhere
  _dhaniProxyFallbackUsed = true;
  clearDhaniProxyWatchdog();
  clearDhaniBridgeSignalTimer();
  markDhaniProxyFailed(reason);
  const hasWorkerBase = typeof CF_WORKER_BASE === 'string' && CF_WORKER_BASE.length > 0;
  if (hasWorkerBase) {
    // Proxied retry, one shot: same proxied URL plus a retry query
    // (inserted before any fragment) so assigning src really
    // navigates instead of no-op'ing on an identical URL. The load
    // listener is already hooked, so the retry load hides the
    // splash; no new watchdog is armed (noteDhaniTransport returns
    // early once the one-shot flag is set).
    const hashIdx = expected.indexOf('#');
    const base = hashIdx === -1 ? expected : expected.slice(0, hashIdx);
    const frag = hashIdx === -1 ? '' : expected.slice(hashIdx);
    const retry = base + (base.indexOf('?') === -1 ? '?' : '&') + 'o101retry=1' + frag;
    if (iframe) iframe.src = retry;
    const barText = $('mobileWebAddressBarText');
    if (barText) barText.textContent = retry;
    noteDhaniTransport(retry);
    setMobileBridgeStatus(false, 'Proxy load slow or failed — retried on the proxy · bridge inactive · login kept on the proxy route');
    return;
  }
  const direct = unproxifyDhaniUrl(expected);
  if (iframe) iframe.src = direct;
  const barText = $('mobileWebAddressBarText');
  if (barText) barText.textContent = direct;
  noteDhaniTransport(direct);
  setMobileBridgeStatus(false, 'Proxy unreachable — direct mode · game frame loads directly, bridge injected by the app');
}
window.runDhaniProxyFallback = runDhaniProxyFallback;
// ── DhaniWin loading overlay (fix round #6, visuals swapped round #10)
// The cross-origin iframe paints white for 3-4s while DhaniWin boots,
// and no app-side code can observe the page's inner paint. So the app
// covers its OWN surface (#dhaniwinLoadingOverlay in mobile.html,
// now the app's own 3-dot quantum-wave animation from
// #appleMinimalLoader on its black/90 blurred backdrop) from the moment
// a DhaniWin navigation starts until the iframe's real `load` event —
// never a guessed timer. After 8s the text turns into a slow-connection
// note (still not a success claim). The dismiss button uncovers the
// page early for this load only; the next navigation shows it again.
let _dhaniLoading = false;
let _dhaniLoadingSlowTimer = null;
function showDhaniLoadingOverlay() {
  _dhaniLoading = true;
  const txt = $('dhaniwinLoadingText');
  if (txt) txt.textContent = 'Loading DhaniWin…';
  const el = $('dhaniwinLoadingOverlay');
  if (el) el.classList.add('o101-loading-visible');
  if (_dhaniLoadingSlowTimer) clearTimeout(_dhaniLoadingSlowTimer);
  _dhaniLoadingSlowTimer = setTimeout(() => {
    _dhaniLoadingSlowTimer = null;
    if (!_dhaniLoading) return;
    const t = $('dhaniwinLoadingText');
    if (t) t.textContent = 'Still loading DhaniWin — slow connection…';
  }, 8000);
}
function hideDhaniLoadingOverlay() {
  _dhaniLoading = false;
  if (_dhaniLoadingSlowTimer) { clearTimeout(_dhaniLoadingSlowTimer); _dhaniLoadingSlowTimer = null; }
  const el = $('dhaniwinLoadingOverlay');
  if (el) el.classList.remove('o101-loading-visible');
}
window.showDhaniLoadingOverlay = showDhaniLoadingOverlay;
window.hideDhaniLoadingOverlay = hideDhaniLoadingOverlay;
function hookDhaniIframeLoad() {
  if (_dhaniIframeLoadHooked) return;
  const iframe = $('dhaniwinIframe');
  if (!iframe) return;
  _dhaniIframeLoadHooked = true;
  const dismiss = $('dhaniwinLoadingDismissBtn');
  if (dismiss) dismiss.addEventListener('click', () => { hideDhaniLoadingOverlay(); });
  iframe.addEventListener('load', () => {
    // A completed load ends the no-load watchdog, but it is not proof
    // of life: an error document (e.g. a DNS failure page) fires
    // `load` too and contains no bridge. While riding the proxy with
    // no bridge signal yet, give the bridge a short window to prove
    // itself; silence inside it means the proxy route failed.
    // Either way the document arrived: the loading splash clears on
    // this REAL signal (fix round #6), never on a guessed timer.
    hideDhaniLoadingOverlay();
    clearDhaniProxyWatchdog();
    if (_dhaniProxyFallbackUsed || _dhaniBridgeSeenForLoad) return;
    if (window.__o101DhaniTransport !== 'proxy') return;
    clearDhaniBridgeSignalTimer();
    _dhaniBridgeSignalTimer = setTimeout(() => {
      _dhaniBridgeSignalTimer = null;
      if (_dhaniBridgeSeenForLoad) return;
      runDhaniProxyFallback('no-bridge-signal');
    }, DHANI_PROXY_BRIDGE_SIGNAL_MS);
  });
  iframe.addEventListener('error', () => {
    // Hard load error on the embed: fail fast instead of waiting out
    // either timer. The splash clears so the owner sees the error
    // page itself, not a permanent loading screen.
    hideDhaniLoadingOverlay();
    if (_dhaniProxyFallbackUsed) return;
    if (window.__o101DhaniTransport !== 'proxy') return;
    runDhaniProxyFallback('load-error');
  });
}
// Record which transport a DhaniWin load uses, so the bridge
// diagnostic (this page + Settings) never implies verification is
// coming on a route where the bridge cannot exist.
function noteDhaniTransport(url) {
  if (typeof url !== 'string') return;
  const transport = window.DhaniTransport
    ? window.DhaniTransport.dhaniTransportForUrl(url, CF_WORKER_BASE)
    // Fallback when the transport module failed to load: any worker
    // URL is the proxy route (root-served since round 3, legacy
    // prefixed included), except the worker-native routes.
    : (url.indexOf(CF_WORKER_BASE) === 0
      && !url.slice(CF_WORKER_BASE.length).startsWith('/o101/')
      && !url.slice(CF_WORKER_BASE.length).startsWith('/proxy/dhaniapi/')
      && !url.slice(CF_WORKER_BASE.length).startsWith('/api/')
      ? 'proxy' : 'direct');
  if (transport !== 'proxy' && !/dhaniwin/i.test(url)) return; // not a DhaniWin load
  window.__o101DhaniTransport = transport;
  try { localStorage.setItem(DHANI_TRANSPORT_KEY, transport); } catch (e) {}
  // Every DhaniWin navigation gets the load listener (fix round #6:
  // it used to attach only on the proxy branch, so direct-mode loads
  // — the only mode left since the worker died — had no listener at
  // all) and the loading splash, which the `load` event clears.
  hookDhaniIframeLoad();
  showDhaniLoadingOverlay();
  if (transport === 'proxy') {
    clearDhaniProxyWatchdog();
    clearDhaniBridgeSignalTimer();
    if (_dhaniProxyFallbackUsed) return;
    _dhaniExpectedProxyUrl = url;
    _dhaniBridgeSeenForLoad = false;
    const expected = url;
    _dhaniProxyWatchdog = setTimeout(() => {
      _dhaniProxyWatchdog = null;
      const iframe = $('dhaniwinIframe');
      if (!iframe || iframe.src !== expected) return;
      // Proxied load never completed: fall back to the direct URL so
      // the game at least loads, and record the direct transport —
      // the diagnostic then states the bridge is inactive rather than
      // promising a verification that cannot happen on this route.
      runDhaniProxyFallback('load-timeout');
    }, DHANI_PROXY_LOAD_TIMEOUT_MS);
  } else {
    clearDhaniProxyWatchdog();
    clearDhaniBridgeSignalTimer();
  }
}
window.noteDhaniTransport = noteDhaniTransport;

function getDefaultDhaniUrl() {
  try {
    const custom = localStorage.getItem('custom_default_website_url');
    if (custom && typeof custom === 'string' && custom.trim().startsWith('http')) {
      return custom.trim();
    }
  } catch(e) {}
  return DHANIWIN_HOME_URL;
}
window.getDefaultDhaniUrl = getDefaultDhaniUrl;

// Fix round #3: the DhaniWin tab always opens the DhaniWin home URL.
// No login-state routing from our side — DhaniWin itself decides what
// to show (home for a live session, its own login page otherwise).
// That page is DhaniWin's own content, never our login UI.
function getDhaniEntryUrl() {
  const custom = getDefaultDhaniUrl();
  if (custom !== DHANIWIN_HOME_URL) {
    return custom;
  }
  // Pivot: direct by default; the worker frame is an explicit
  // override only, never the default.
  return dhaniFrameUseProxy() ? proxifyDhaniUrl(DHANIWIN_HOME_URL) : DHANIWIN_HOME_URL;
}
window.getDhaniEntryUrl = getDhaniEntryUrl;
window.DHANIWIN_HOME_URL = DHANIWIN_HOME_URL;

function handleDhaniSessionExpired(reason) {
  if (Date.now() < _authGracePeriodUntil) {
    console.log('[Auth Guard] Blocked false session-out event during post-login grace period:', reason);
    return;
  }
  markUserLoggedOut();
  // Status line only — never a login prompt, never a gate.
  setMobileBridgeStatus(false, reason || 'Session Expired');
}
window.handleDhaniSessionExpired = handleDhaniSessionExpired;


// ── Home tab: auto-hide top bar ────────────────────────────────────────────────
// Swipe/scroll UP hides our header, swipe/scroll DOWN shows it. The DhaniWin iframe is
// cross-origin, so gestures are read from our header + pull handle, and from optional
// DHANIWIN_SCROLL bridge messages. #tab-web's top follows the header so DhaniWin's own
// top bar (Login button) is never hidden underneath ours.
function setHomeHeaderHidden(hidden) {
  const onWeb = document.getElementById('tab-web')?.style.display !== 'none';
  document.body.classList.toggle('home-header-hidden', !!hidden && onWeb);
}
window.setHomeHeaderHidden = setHomeHeaderHidden;

// ── Phase 3C — top-bar scroll mode (owner order 2026-10-27) ──
// 'stay' (DEFAULT — key absent or anything but 'reopen'): scroll up NEVER
// reopens the top bar; the user taps the top-edge pull handle every time.
// 'reopen': old Task D behavior — scroll up restores the top bar.
// Read live on every scroll/gesture/bridge event so a settings change
// applies without a reload. The menu (dock) is NOT governed by this key:
// fix round (owner order 2026-10-27 ~12:03 IST, SUPERSEDES Phase 3C):
// scroll up NEVER brings the menu back — it returns ONLY on tapping
// the dock's bottom restore handle (the menu line).
const TOPBAR_SCROLL_KEY = 'o101_topbar_scroll';
function topBarStayHidden() {
  try { return localStorage.getItem(TOPBAR_SCROLL_KEY) !== 'reopen'; }
  catch (e) { return true; }
}

function initHomeHeaderAutoHide() {
  const header = document.querySelector('header.liquid-glass-header');
  if (!header) return;
  const syncHeight = () => document.documentElement.style.setProperty('--app-header-h', header.offsetHeight + 'px');
  syncHeight();
  window.addEventListener('resize', syncHeight);

  // Task D: the pull handle is visible whenever home-header-hidden is set.
  // Phase 3C: the handle moved OUT of #tab-web to body level (fixed, top
  // edge) so the manual top-bar reopen works on EVERY view — inside
  // #tab-web it was invisible whenever the web tab was hidden. setHomeHeaderHidden
  // is web-gated for HIDING, but unhiding (hidden=false) removes the class on
  // any tab, so showTopBar restores the bar everywhere. On Home the restore
  // also runs the Home chrome show path. Web behavior is untouched.
  const showTopBar = () => {
    setHomeHeaderHidden(false);
    if (document.getElementById('tab-home')?.style.display !== 'none') window.__o101ShowHomeChrome?.();
  };
  const attachSwipe = (el) => {
    let y0 = null;
    el.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (y0 === null) return;
      const dy = e.changedTouches[0].clientY - y0;
      y0 = null;
      if (dy < -18) setHomeHeaderHidden(true);
      else if (dy > 18) showTopBar();
    }, { passive: true });
  };
  attachSwipe(header);
  const handle = document.getElementById('homeHeaderPullHandle');
  if (handle) {
    attachSwipe(handle);
    handle.addEventListener('click', showTopBar);
  }
}

// ── Liquid-glass dock: scroll-driven hide/show (Phase 3C: down = fully hidden,
// up = smoothly back) & touch-dismiss ─────────────
function initDockAutoCompact() {
  const dock = document.getElementById('mobileBottomDock');
  if (!dock) return;

  let lastScrollY = window.scrollY || 0;
  const SCROLL_THRESHOLD = 6;

  const syncShield = () => {
    const shield = document.getElementById('dhaniwinTouchShield');
    if (!shield) return;
    const onWeb = document.getElementById('tab-web')?.style.display !== 'none';
    const isCompact = dock.classList.contains('dock-compact') || dock.classList.contains('dock-hidden');
    // When on DhaniWin tab and dock is full size: activate shield to capture touches/swipes anywhere on the view
    // When dock is compact or hidden: release shield completely (pointerEvents = 'none') so user plays the game freely!
    if (onWeb && !isCompact) {
      shield.style.pointerEvents = 'auto';
    } else {
      shield.style.pointerEvents = 'none';
    }
  };

  const compact = () => {
    dock.classList.remove('dock-hidden');
    dock.classList.add('dock-compact');
    document.body.classList.add('nav-compact');
    syncShield();
  };
  const expand = () => {
    dock.classList.remove('dock-hidden');
    dock.classList.remove('dock-compact');
    document.body.classList.remove('nav-compact');
    syncShield();
  };
  const hide = () => {
    dock.classList.add('dock-hidden');
    syncShield();
  };

  // ── Phase 3C — decoupled scroll chrome (replaces Task D's Home-only rule) ──
  // Scroll DOWN fully hides the top bar + dock on EVERY view (not compact);
  // scroll UP reopens NOTHING of the menu (owner order 2026-10-27 ~12:03
  // IST: the menu returns ONLY on tapping the dock's bottom restore
  // handle); the top bar reopens on scroll up ONLY in 'reopen' mode —
  // by default ('stay') it stays hidden until the user taps the
  // top-edge pull handle. Reuses home-header-hidden
  // (header translateY(-110%), 0.35s transition) and dock-hidden (off-screen +
  // opacity 0 + pointer-events none), so both transitions stay CSS-smoothed
  // and hidden chrome never intercepts touches. Governed content (predictions,
  // stakes, held candidates, ball panel, subtitle bubble) is never touched
  // here — only the header + dock classes move. The bet slip / confirm tap
  // lives in page content, not in the header or dock, so it stays fully
  // usable while chrome is hidden.
  const isHomeView = () => document.getElementById('tab-home')?.style.display !== 'none';
  const hideChrome = () => {
    dock.classList.remove('dock-compact');
    dock.classList.add('dock-hidden');
    document.body.classList.add('home-header-hidden');
    syncShield();
  };
  const showHomeChrome = () => {
    // Manual restore only (pull-handle tap): header + dock, every mode.
    expand();
    document.body.classList.remove('home-header-hidden');
  };
  // Scroll-up restore (fix round, owner order 2026-10-27 ~12:03 IST):
  // TOP-BAR ONLY — the dock/menu is deliberately NOT reopened here.
  // The top bar reopens only in 'reopen' mode; in 'stay' mode (default)
  // it stays hidden until the pull-handle tap. The menu returns ONLY
  // via the dock restore handle's own handlers (expand) below.
  const restoreOnScrollUp = () => {
    if (!topBarStayHidden()) document.body.classList.remove('home-header-hidden');
  };
  window.__o101ShowHomeChrome = showHomeChrome;

  // Expose methods on window for global access and bridge handlers
  window._dockSetCompact = (isCompact) => {
    if (isCompact) compact();
    else expand();
  };
  window._dockSetHidden = (isHidden) => {
    if (isHidden) hide();
    else expand();
  };
  window._dockExpand = expand;
  window._dockSyncShield = syncShield;

  // ── 1. Window scroll: scrolling down = chrome fully hidden, scrolling up =
  // menu stays hidden (tap the menu line to bring it back), top bar only
  // in 'reopen' mode ──
  // Phase 3C: the old elsewhere-compact behavior is replaced — scroll down
  // fully hides the dock on EVERY view, and scroll up never auto-reopens
  // the top bar by default (tap the top-edge handle instead). Fix round
  // (owner order 2026-10-27 ~12:03 IST): scroll up never returns the menu.
  window.addEventListener('scroll', () => {
    const y = window.scrollY || 0;

    // At top of screen: top bar only in 'reopen' mode; menu stays hidden.
    if (y <= 15) {
      restoreOnScrollUp();
      lastScrollY = y;
      return;
    }

    const delta = y - lastScrollY;
    if (delta > SCROLL_THRESHOLD) {
      // User scrolled DOWN → fully hide top bar + dock, every view.
      hideChrome();
    } else if (delta < -SCROLL_THRESHOLD) {
      // User scrolled UP → menu stays hidden; top bar per mode.
      restoreOnScrollUp();
    }

    lastScrollY = y;
  }, { passive: true });

  // ── 2. Global Viewport Touch & Swipe Gesture Engine ──
  // Swipe Down = fully hide chrome (Phase 3C), Swipe Up = top bar only in
  // 'reopen' mode (fix round: menu NEVER returns on scroll/swipe up),
  // Tap outside = compact dock (unchanged: a tap is not a scroll).
  let touchStartY = null;
  let touchStartX = null;
  let touchStartTime = 0;
  let touchMoved = false;

  const isProtectedElement = (target) => {
    if (!target || typeof target.closest !== 'function') return false;
    return !!target.closest('#dhaniwinFloatingOrb, #dhaniwinAssistantModal, #dhaniwinAssistantSheet, #mobileBottomDock, .assistant-resize-handle, #dockRestoreHandle');
  };

  const handleTouchStart = (clientY, clientX, target) => {
    if (isProtectedElement(target)) {
      touchStartY = null;
      touchStartX = null;
      return;
    }
    touchStartY = clientY;
    touchStartX = clientX;
    touchStartTime = Date.now();
    touchMoved = false;
  };

  const handleTouchMove = (clientY, clientX, target) => {
    if (touchStartY === null) return;
    if (isProtectedElement(target)) return;
    // Task D: on Home, scroll alone drives chrome. The gesture engine's
    // hideChrome() would otherwise fight the scroll listener mid-scroll — so
    // on Home, gestures never touch chrome. Everywhere else the engine mirrors
    // the scroll listener (Phase 3C: swipe down hides, swipe up restores dock).
    if (isHomeView()) return;

    const dy = clientY - touchStartY;
    const dx = clientX - (touchStartX || clientX);

    // Require predominantly vertical movement
    if (Math.abs(dy) < 10 || Math.abs(dy) < Math.abs(dx)) return;
    touchMoved = true;

    if (dy > 12) {
      // Swiping DOWN (finger drags down) -> Phase 3C: fully hide chrome
      // (same as scroll down), not compact.
      hideChrome();
      touchStartY = clientY;
    } else if (dy < -12) {
      // Swiping UP (finger moves up towards top) -> top bar only in
      // 'reopen' mode; the menu stays hidden (fix round 2026-10-27).
      restoreOnScrollUp();
      touchStartY = clientY;
    }
  };

  const handleTouchEnd = (target) => {
    if (touchStartY === null) return;
    const duration = Date.now() - touchStartTime;
    const moved = touchMoved;

    touchStartY = null;
    touchStartX = null;
    touchMoved = false;

    // Task D: on Home, chrome is scroll-driven only — a tap must not un-hide it.
    if (isHomeView()) return;

    // Clean tap outside dock/modal/orb across any tab/menu -> compact dock
    if (!moved && duration < 400 && !isProtectedElement(target)) {
      compact();
    }
  };

  // Attach to window & document
  document.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches[0]) handleTouchStart(e.touches[0].clientY, e.touches[0].clientX, e.target);
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches[0]) handleTouchMove(e.touches[0].clientY, e.touches[0].clientX, e.target);
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    handleTouchEnd(e.target);
  }, { passive: true });

  // ── 3. High-Fidelity Touch Shield for DhaniWin Embedded View ──
  // Captures touches and swipes anywhere over the embedded iframe when the dock is expanded.
  // Fix round (scroll-home, owner order 2026-10-27 ~11:55 IST): the old
  // shield compacted + released ON POINTERDOWN, so the same gesture's
  // pointermove was retargeted away and the shield's swipe handling
  // was dead code on touch devices — the first game-area swipe only
  // compacted, never hid chrome like Analyse. Now pointerdown records
  // the start ONLY; the gesture resolves on move/up: a vertical swipe
  // DOWN hides chrome fully (hideChrome, same as Analyse scroll down),
  // a swipe UP restores the top bar only in 'reopen' mode (the menu
  // NEVER returns on swipe up — owner order 2026-10-27 ~12:03 IST),
  // and a clean tap (no significant move) keeps the old tap path
  // (compact + release) so gameplay taps still reach the game.
  // Honest limit: on the website the cross-origin iframe swallows
  // every gesture after the shield releases, so only the FIRST swipe
  // after each dock-expand drives chrome here; full every-swipe
  // parity needs the APK bridge (DHANIWIN_SCROLL) or a new edge zone.
  const shield = document.getElementById('dhaniwinTouchShield');
  if (shield) {
    let sStartY = null;
    let sStartX = null;
    let sMoved = false;
    let sLastMoved = false;

    const onShieldDown = (clientY, clientX) => {
      sStartY = clientY;
      sStartX = clientX;
      sMoved = false;
    };

    const onShieldMove = (clientY, clientX) => {
      if (sStartY === null) return;
      const dy = clientY - sStartY;
      const dx = clientX - (sStartX || clientX);
      if (Math.abs(dy) < 8 || Math.abs(dy) < Math.abs(dx)) return;
      sMoved = true;
      if (dy > 10) {
        // Dragging DOWN -> fully hide chrome (same as scroll down).
        hideChrome();
        shield.style.pointerEvents = 'none';
      } else if (dy < -10) {
        // Dragging UP -> top bar only in 'reopen' mode; menu stays hidden.
        restoreOnScrollUp();
      }
    };

    const onShieldUp = () => {
      // Clean tap (no significant move) -> the old tap path: compact
      // + release so the next game tap reaches the iframe.
      if (sStartY !== null && !sMoved && !dock.classList.contains('dock-compact')) {
        compact();
        shield.style.pointerEvents = 'none';
      }
      sLastMoved = sMoved;
      sStartY = null;
      sStartX = null;
      sMoved = false;
    };

    shield.addEventListener('pointerdown', (e) => onShieldDown(e.clientY, e.clientX), { passive: true });
    shield.addEventListener('pointermove', (e) => onShieldMove(e.clientY, e.clientX), { passive: true });
    shield.addEventListener('pointerup', onShieldUp, { passive: true });
    shield.addEventListener('pointercancel', onShieldUp, { passive: true });

    shield.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches[0]) onShieldDown(e.touches[0].clientY, e.touches[0].clientX);
    }, { passive: true });
    shield.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches[0]) onShieldMove(e.touches[0].clientY, e.touches[0].clientX);
    }, { passive: true });
    shield.addEventListener('touchend', onShieldUp, { passive: true });
    shield.addEventListener('click', (e) => {
      // A click with no preceding move is a tap: same tap path as
      // pointerup. A click AFTER a swipe must not compact (the swipe
      // already resolved the gesture) — sLastMoved guards that.
      if (!sLastMoved && !dock.classList.contains('dock-compact')) {
        compact();
        shield.style.pointerEvents = 'none';
      }
    }, { passive: true });

    shield.addEventListener('wheel', (e) => {
      if (e.deltaY > 6) {
        // Phase 3C: wheel scroll down over the game view hides chrome fully.
        hideChrome();
        shield.style.pointerEvents = 'none';
      } else if (e.deltaY < -6) {
        // Wheel scroll up: top bar per mode; menu stays hidden.
        restoreOnScrollUp();
      }
    }, { passive: true });
  }

  // Initial shield state sync
  syncShield();

  // Window blur: when the user taps inside the cross-origin iframe, the parent window immediately loses focus (blurs)
  window.addEventListener('blur', () => {
    const onWeb = document.getElementById('tab-web')?.style.display !== 'none';
    if (onWeb) {
      // User touched/clicked inside the DhaniWin iframe -> compact dock
      compact();
    }
  });

  // Check activeElement change when user clicks/taps into iframe
  let lastActiveEl = null;
  setInterval(() => {
    const active = document.activeElement;
    if (active && active.id === 'dhaniwinIframe' && lastActiveEl !== active) {
      lastActiveEl = active;
      const onWeb = document.getElementById('tab-web')?.style.display !== 'none';
      if (onWeb) compact();
    } else if (active !== lastActiveEl) {
      lastActiveEl = active;
    }
  }, 250);

  // ── 4. Bottom Swipe-up / Tap Restore Handle ──
  // Fix round (owner order 2026-10-27 ~12:03 IST): this handle IS the
  // menu line — tapping it is the ONLY way the hidden menu returns.
  // Scroll/swipe up deliberately never calls expand() anymore.
  const restoreHandle = document.getElementById('dockRestoreHandle');
  if (restoreHandle) {
    restoreHandle.addEventListener('click', expand);
    restoreHandle.addEventListener('pointerdown', expand, { passive: true });

    let rStartY = null;
    restoreHandle.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches[0]) rStartY = e.touches[0].clientY;
    }, { passive: true });
    restoreHandle.addEventListener('touchmove', (e) => {
      if (rStartY !== null && e.touches && e.touches[0]) {
        const dy = e.touches[0].clientY - rStartY;
        if (dy < -6) { // Swipe UP from bottom strip
          expand();
          rStartY = null;
        }
      }
    }, { passive: true });
    restoreHandle.addEventListener('touchend', () => { rStartY = null; }, { passive: true });
  }

  // ── 5. Interacting with the dock itself always expands it ──
  ['touchstart', 'pointerdown', 'mouseenter'].forEach(ev =>
    dock.addEventListener(ev, expand, { passive: true })
  );
}

const _runDockInit = () => {
  try { initHomeHeaderAutoHide(); } catch(e) { console.warn('[HeaderAutoHide]', e); }
  try { initDockAutoCompact(); } catch(e) { console.warn('[DockCompact]', e); }
  try { initDhaniwinAssistantSheetGesture(); } catch(e) { console.warn('[SheetGesture]', e); }
};

// ── Bet-slip dock auto-hide (Addition 3, 2026-10-24) ───────────────
// The DhaniWin bet slip lives inside the iframe; the bridge watches
// it and posts O101_BETSLIP transitions (and carries betSlipOpen in
// its state publish for late joiners). While the slip is open, the
// bottom dock hides through the existing dock-hidden mechanism so
// it never covers the slip's Total/Cancel row. The dock can NEVER
// get stuck hidden: it restores on slip close, on an orb or
// restore-handle tap, on period rollover, or after a 90s failsafe —
// whichever comes first. On a direct (bridgeless) load nothing ever
// posts and the dock behaves exactly as before — degraded honestly.
let betSlipDockLock = false;
let betSlipPeriodAtHide = null;
let betSlipFailsafeTimer = null;
let betSlipGuardTimer = null;

function betSlipLatestPeriod() {
  try {
    const h = MobileState.historyByTf[MobileState.timeframe] || [];
    return h.length ? String(h[h.length - 1].period) : null;
  } catch (e) { return null; }
}

function hideDockForBetSlip() {
  if (typeof window._dockSetHidden === 'function') { window._dockSetHidden(true); return; }
  const dock = document.getElementById('mobileBottomDock');
  if (dock) dock.classList.add('dock-hidden');
  if (typeof window._dockSyncShield === 'function') window._dockSyncShield();
}

function restoreDockFromBetSlip() {
  if (betSlipFailsafeTimer) { clearTimeout(betSlipFailsafeTimer); betSlipFailsafeTimer = null; }
  if (betSlipGuardTimer) { clearInterval(betSlipGuardTimer); betSlipGuardTimer = null; }
  betSlipDockLock = false;
  betSlipPeriodAtHide = null;
  if (typeof window._dockExpand === 'function') window._dockExpand();
}

function setBetSlipDockHidden(open) {
  if (open) {
    if (betSlipDockLock) return; // one hide per opening
    betSlipDockLock = true;
    betSlipPeriodAtHide = betSlipLatestPeriod();
    hideDockForBetSlip();
    const failsafeMs = Number(window.__o101BetSlipFailsafeMs) > 0 ? Number(window.__o101BetSlipFailsafeMs) : 90000;
    betSlipFailsafeTimer = setTimeout(() => restoreDockFromBetSlip(), failsafeMs);
    // Guard: the scroll/gesture engine may re-expand the dock while
    // the slip is open — re-apply the hide; also watch for the
    // period-rollover restore.
    betSlipGuardTimer = setInterval(() => {
      if (!betSlipDockLock) return;
      const p = betSlipLatestPeriod();
      if (betSlipPeriodAtHide && p && p !== betSlipPeriodAtHide) { restoreDockFromBetSlip(); return; }
      const dock = document.getElementById('mobileBottomDock');
      if (dock && !dock.classList.contains('dock-hidden')) hideDockForBetSlip();
    }, 500);
  } else if (betSlipDockLock) {
    restoreDockFromBetSlip();
  }
}
window.setBetSlipDockHidden = setBetSlipDockHidden;

// Manual restores always win over the slip lock.
document.addEventListener('pointerdown', (e) => {
  if (!betSlipDockLock) return;
  const t = e.target;
  if (t && typeof t.closest === 'function' && t.closest('#dhaniwinFloatingOrb, #dockRestoreHandle')) {
    restoreDockFromBetSlip();
  }
}, { capture: true, passive: true });

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _runDockInit);
} else {
  _runDockInit();
}

function switchMobileTab(tab) {
  // Fix round #2: every tab is usable without login — no unlock modal gate.
  try { localStorage.setItem('active_mobile_tab', tab); } catch(e) {}

  ['home', 'ai', 'sim', 'web', 'pattern'].forEach(t => {
    const section = $(`tab-${t}`);
    if (section) section.style.display = t === tab ? 'block' : 'none';
  });

  document.querySelectorAll('.dock-btn').forEach(btn => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActive);
  });

  // Header auto-hide applies only to the Home (web) tab
  if (tab !== 'web') document.body.classList.remove('home-header-hidden');
  if (typeof window._dockSyncShield === 'function') window._dockSyncShield();

  // Lazy-init pattern view when pattern tab is shown
  if (tab === 'pattern') {
    if (window.patternViewInstance) {
      window.patternViewInstance.mount();
    } else if (window.PatternIntelligence && typeof window.PatternIntelligence.init === 'function') {
      window.PatternIntelligence.init().then(() => {
        if (window.patternViewInstance) window.patternViewInstance.mount();
      }).catch(e => console.warn('[PatternView] Lazy-init fallback failed:', e));
    }
  }

  // Lazy-init chart when home tab is shown
  if (tab === 'home') {
    setTimeout(() => {
      if (!mobileTradingChartInstance && $('mobileChartContainer')) {
        initChart();
        const list = MobileState.historyByTf[MobileState.timeframe] || [];
        if (list.length > 0) renderChartData(list);
      }
    }, 150);
  }

  // Manage DhaniWin Web View & Floating Assistant Orb (Shown on Home and Analyse tabs)
  const orb = $('dhaniwinFloatingOrb');
  if (tab === 'web' || tab === 'home') {
    if (orb) orb.style.display = 'block';
    if (typeof updateFloatingOrbUI === 'function') updateFloatingOrbUI();
    // Ball-below-Axo (owner order 2026-10-27): a tab return restores
    // the orb WITHOUT clamping today — a viewport shrink while on
    // another tab (where the resize handler early-returns on the
    // hidden orb) would show it at a stale, possibly off-screen
    // spot. Re-clamp on restore, so the face + ball below it are
    // always fully in view after a tab switch.
    if (typeof clampFloatingOrb === 'function') clampFloatingOrb();

    if (tab === 'web') {
      const iframe = $('dhaniwinIframe');
      if (iframe && (iframe.src === 'about:blank' || !iframe.src || iframe.src.includes('about:blank'))) {
        const targetUrl = getDhaniEntryUrl();
        try { history.pushState({ dhaniSentinel: true }, ''); } catch(e) {}
        iframe.src = targetUrl;
        noteDhaniTransport(targetUrl);
        const barText = $('mobileWebAddressBarText');
        if (barText) barText.textContent = targetUrl;
      }
    }
  } else {
    // Hidden on AI Adaptive, Pattern, and other tabs
    if (orb) orb.style.display = 'none';
    if (typeof toggleDhaniwinAssistantModal === 'function') toggleDhaniwinAssistantModal(false);
  }

  // Owner order 2026-10-30: widget states per tab.
  // - Analyse page (#tab-ai): widget ALWAYS in COMPACT mode. Never
  //   auto-open the full panel here. User can tap to expand.
  // - Homepage: hide the full widget, show only the minimal lime dot.
  try {
    const limeDot = $('axoLimeDot');
    const sheet = $('dhaniwinAssistantSheet');
    if (tab === 'ai') {
      // Analyse: compact mode. Close full panel if open, show orb in compact.
      if (typeof toggleDhaniwinAssistantModal === 'function') toggleDhaniwinAssistantModal(false);
      if (orb) {
        orb.style.display = 'block';
        // Force compact: set the data attribute for compact styling.
        if (sheet) sheet.setAttribute('data-axo-compact', '3');
      }
      if (limeDot) limeDot.style.display = 'none';
      if (typeof clampFloatingOrb === 'function') clampFloatingOrb();
    } else if (tab === 'home') {
      // Homepage: hide full widget, show only lime dot.
      if (typeof toggleDhaniwinAssistantModal === 'function') toggleDhaniwinAssistantModal(false);
      if (orb) orb.style.display = 'none';
      if (limeDot) limeDot.style.display = 'block';
    } else {
      // Other tabs: hide lime dot.
      if (limeDot) limeDot.style.display = 'none';
      // On web tab, orb is already shown above; ensure compact is cleared.
      if (tab === 'web' && sheet) sheet.removeAttribute('data-axo-compact');
    }
  } catch (e) { /* widget state must never break tab switch */ }

  // Bubble-tracks-Axo: anchor visibility changed (orb shown or
  // hidden) — the bubble tracks it or hides with it, never parks
  // at a stale spot.
  if (window.__smartBall && typeof window.__smartBall.repositionAxoBubble === 'function') window.__smartBall.repositionAxoBubble();
}
window.switchMobileTab = switchMobileTab;


function setMobileTimeframe(tf) {
  MobileState.timeframe = tf;
  try {
    localStorage.setItem('dhaniwin_last_interval', tf);
    // Keep the Settings page's Default Interval in sync both ways.
    localStorage.setItem('quant_default_tf', tf);
  } catch(e) {}

  if (window._chartFittedByTf) delete window._chartFittedByTf[tf];
  const container = $('mobileChartContainer');
  if (container) container._lastRenderSig = null;

  // Clear any existing win/loss celebration banner from prior timeframe
  dismissCelebrationBanner();

  // Reset any running AI target box animation back to normal view
  const normalView = $('smartTargetNormalView');
  const animView = $('smartTargetResultAnimView');
  if (normalView && animView) {
    animView.classList.add('hidden');
    animView.style.display = 'none';
    normalView.classList.remove('hidden');
  }

  // Update TF pill buttons
  ['30s', '1m', '3m', '5m'].forEach(t => {
    const btn = $(`tfBtn-${t}`);
    if (!btn) return;
    if (t === tf) {
      btn.className = 'tf-btn flex-1 py-1.5 rounded-xl font-mono text-[10.5px] font-black transition active:scale-95 bg-amber-500/25 text-amber-300 border border-amber-400/40 shadow-sm';
    } else {
      btn.className = 'tf-btn flex-1 py-1.5 rounded-xl font-mono text-[10.5px] font-black transition active:scale-95 text-white/50 hover:text-white hover:bg-white/5';
    }
  });

  // Render cached history if available
  const cached = MobileState.historyByTf[tf] || [];
  renderPredictionAudit(cached);
  renderHistoryTable(cached);
  renderMobileHistoryGraph(cached);
  renderDigitFrequencies(cached);
  renderChartData(cached);
  renderAdaptiveAI(cached);
  renderAuthoritativeAIPrediction(cached);
  renderModelRosterUI();
  if (typeof renderTfInchargeStrip === 'function') renderTfInchargeStrip();

  if (cached.length === 0) {
    // Trigger immediate fetch for this timeframe
    fetchLiveAPIResults(tf);
  }

  // Sync DhaniWin Web Tab Interval Pills
  ['30s', '1m', '3m', '5m'].forEach(t => {
    const wBtn = $(`webTf-${t}`);
    if (wBtn) {
      if (t === tf) {
        wBtn.className = 'flex-1 py-1.5 rounded-xl font-mono text-[10px] font-black transition active:scale-95 bg-amber-500/25 text-amber-300 border border-amber-400/40 shadow-sm';
      } else {
        wBtn.className = 'flex-1 py-1.5 rounded-xl font-mono text-[10px] font-black transition active:scale-95 text-white/50 hover:text-white hover:bg-white/5';
      }
    }
  });

  // Sync Ball Assistant Sheet Interval Badge & Pills
  const asstBadge = $('assistantIntervalBadge');
  if (asstBadge) {
    asstBadge.textContent = tf.toUpperCase();
  }
  ['30s', '1m', '3m', '5m'].forEach(t => {
    const aBtn = $(`asstTfBtn-${t}`);
    if (aBtn) {
      if (t === tf) {
        aBtn.className = 'flex-1 py-1 rounded-lg font-mono text-[8px] font-bold bg-amber-500/25 text-amber-300 border border-amber-500/40 transition active:scale-95 text-center';
      } else {
        aBtn.className = 'flex-1 py-1 rounded-lg font-mono text-[8px] font-bold bg-white/5 text-zinc-400 border border-white/5 transition active:scale-95 text-center';
      }
    }
  });

  // Synchronously route DhaniWin web view to matching interval.
  // The app navigates ONLY when no bridge is present for this load
  // (Fix 7b): with a live bridge, the bridge itself owns the
  // timeframe navigation (prefix-aware), and a second app-side
  // navigation per tap is a competing navigator that can drop the
  // prefix or double-load the frame. _dhaniBridgeSeenForLoad resets
  // on every loadMobileWebUrl call and is set by any bridge signal.
  const iframe = $('dhaniwinIframe');
  const targetUrl = DHANIWIN_INTERVAL_URLS[tf] || DHANIWIN_INTERVAL_URLS['30s'];
  if (iframe && !_dhaniBridgeSeenForLoad && (!iframe.src || !iframe.src.toLowerCase().includes(targetUrl.toLowerCase()))) {
    loadMobileWebUrl(targetUrl);
  }

  if (typeof postMobileBridge === 'function') {
    postMobileBridge({ type: 'WINGO_SWITCH_TIMEFRAME', timeframe: tf, timestamp: Date.now() });
    postMobileBridge({ type: 'UPDATE_BET_SETTINGS', stake: MobileBridgeState.currentStake, maxStake: MobileBridgeState.maxStakeCap, timeframe: tf });
  }

  updateISTClock();
}
window.setMobileTimeframe = setMobileTimeframe;

function setMobileTimeframeAndSyncBridge(tf) {
  setMobileTimeframe(tf);
  if (typeof playSoundEffect === 'function') playSoundEffect('click');
}
window.setMobileTimeframeAndSyncBridge = setMobileTimeframeAndSyncBridge;

// ── 24B. Settings Panel ────────────────────────────────────────────────────────

function toggleMobileSettings() {
  // Full-screen settings page only (half-sheet modal removed)
  window.location.href = 'settings.html';
}
window.toggleMobileSettings = toggleMobileSettings;

function updateSoundMuteUI() {
  const enabled = !!MobileState.soundEnabled;
  const icon = $('floatingSoundMuteIcon');
  const btn = $('floatingSoundMuteBtn');
  if (icon) {
    icon.className = enabled
      ? 'fa-solid fa-volume-high text-[11px] text-emerald-400 transition-colors'
      : 'fa-solid fa-volume-xmark text-[11px] text-rose-400 transition-colors';
  }
  if (btn) {
    btn.title = enabled ? 'Win/Loss Sound: Enabled (Tap to Mute)' : 'Win/Loss Sound: Muted (Tap to Unmute)';
    btn.classList.toggle('border-emerald-500/30', enabled);
    btn.classList.toggle('border-rose-500/30', !enabled);
  }
  const el = $('settingSoundEffects');
  if (el) el.checked = enabled;
}
window.updateSoundMuteUI = updateSoundMuteUI;

function toggleQuickSoundMute() {
  const next = !MobileState.soundEnabled;
  toggleSoundEffects(next);
  if (typeof showToast === 'function') {
    showToast(next ? '🔔 Win/Loss sounds enabled' : '🔕 Win/Loss sounds muted', next ? 'info' : 'warn');
  }
}
window.toggleQuickSoundMute = toggleQuickSoundMute;

function toggleSoundEffects(on) {
  MobileState.soundEnabled = !!on;
  try { localStorage.setItem('quant_sound', on ? '1' : '0'); } catch(e) {}
  updateSoundMuteUI();
  if (on) {
    playSoundEffect('win', true);
  }
}
window.toggleSoundEffects = toggleSoundEffects;

function toggleHaptics(on) {
  MobileState.hapticsEnabled = !!on;
  try { localStorage.setItem('quant_haptics', on ? '1' : '0'); } catch(e) {}
}
window.toggleHaptics = toggleHaptics;

function toggleOutsideNotifications(on) {
  MobileState.outsideNotif = !!on;
  // NOTE: No Notification API calls with balance/profit per spec
}
window.toggleOutsideNotifications = toggleOutsideNotifications;

// ── 24B. Background Execution, Wake Lock & Battery Keep-Alive Engine ─────────

let _bgAudioCtx = null;
let _bgAudioSource = null;
let _bgKeepAliveActive = false;
let _screenWakeLock = null;

function startBackgroundAudioKeepAlive() {
  if (_bgKeepAliveActive) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!_bgAudioCtx) {
      _bgAudioCtx = new AudioContextClass();
    }
    if (_bgAudioCtx.state === 'suspended') {
      _bgAudioCtx.resume();
    }
    // Generate a 2-second inaudible buffer that loops indefinitely
    // Keeps browser JS runtime and Web Worker active when backgrounded or locked
    const buffer = _bgAudioCtx.createBuffer(1, _bgAudioCtx.sampleRate * 2, _bgAudioCtx.sampleRate);
    _bgAudioSource = _bgAudioCtx.createBufferSource();
    _bgAudioSource.buffer = buffer;
    _bgAudioSource.loop = true;
    const gainNode = _bgAudioCtx.createGain();
    gainNode.gain.setValueAtTime(0.0001, _bgAudioCtx.currentTime); // Inaudible gain
    _bgAudioSource.connect(gainNode);
    gainNode.connect(_bgAudioCtx.destination);
    _bgAudioSource.start(0);
    _bgKeepAliveActive = true;
    console.log('[Background KeepAlive] Inaudible audio loop running (Anti-Throttling active).');
  } catch(e) {
    console.warn('[Background KeepAlive] AudioContext initialization failed:', e);
  }
  updateBackgroundKeepAliveUI();
}
window.startBackgroundAudioKeepAlive = startBackgroundAudioKeepAlive;

function stopBackgroundAudioKeepAlive() {
  _bgKeepAliveActive = false;
  if (_bgAudioSource) {
    try {
      _bgAudioSource.stop();
      _bgAudioSource.disconnect();
    } catch(e) {}
    _bgAudioSource = null;
  }
  if (_bgAudioCtx) {
    try { _bgAudioCtx.suspend(); } catch(e) {}
  }
  updateBackgroundKeepAliveUI();
  console.log('[Background KeepAlive] Paused.');
}
window.stopBackgroundAudioKeepAlive = stopBackgroundAudioKeepAlive;

function toggleBackgroundKeepAlive(on) {
  MobileState.bgKeepAliveEnabled = !!on;
  try { localStorage.setItem('quant_bg_keepalive', on ? '1' : '0'); } catch(e) {}
  if (on) {
    startBackgroundAudioKeepAlive();
    showToast('⚡ Background Keep-Alive Activated', 'success');
  } else {
    stopBackgroundAudioKeepAlive();
    showToast('⏸️ Background Keep-Alive Paused', 'info');
  }
  updateBackgroundKeepAliveUI();
}
window.toggleBackgroundKeepAlive = toggleBackgroundKeepAlive;

function updateBackgroundKeepAliveUI() {
  const toggle = $('settingBgKeepAlive');
  if (toggle) toggle.checked = !!MobileState.bgKeepAliveEnabled;
  const tag = $('bgKeepAliveStatusTag');
  if (tag) {
    if (MobileState.bgKeepAliveEnabled && _bgKeepAliveActive) {
      tag.textContent = 'ACTIVE';
      tag.className = 'text-[7.5px] font-mono font-bold px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    } else if (MobileState.bgKeepAliveEnabled) {
      tag.textContent = 'STANDBY';
      tag.className = 'text-[7.5px] font-mono font-bold px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30';
    } else {
      tag.textContent = 'PAUSED';
      tag.className = 'text-[7.5px] font-mono font-bold px-1.5 py-0.2 rounded bg-white/10 text-zinc-400 border border-white/10';
    }
  }
}

// ── Screen Wake Lock API ──
async function requestScreenWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      _screenWakeLock = await navigator.wakeLock.request('screen');
      _screenWakeLock.addEventListener('release', () => {
        _screenWakeLock = null;
        updateWakeLockUI();
      });
      console.log('[WakeLock] Screen Wake Lock granted.');
    } catch (err) {
      console.warn('[WakeLock] Request failed:', err);
    }
  }
  updateWakeLockUI();
}
window.requestScreenWakeLock = requestScreenWakeLock;

async function releaseScreenWakeLock() {
  if (_screenWakeLock) {
    try {
      await _screenWakeLock.release();
    } catch(e) {}
    _screenWakeLock = null;
  }
  updateWakeLockUI();
}
window.releaseScreenWakeLock = releaseScreenWakeLock;

function toggleWakeLock(on) {
  MobileState.wakeLockEnabled = !!on;
  try { localStorage.setItem('quant_wakelock', on ? '1' : '0'); } catch(e) {}
  if (on) {
    requestScreenWakeLock();
    showToast('🔆 Screen Always-On Enabled', 'success');
  } else {
    releaseScreenWakeLock();
    showToast('Display Sleep Restored', 'info');
  }
  updateWakeLockUI();
}
window.toggleWakeLock = toggleWakeLock;

function updateWakeLockUI() {
  const toggle = $('settingWakeLock');
  if (toggle) toggle.checked = !!MobileState.wakeLockEnabled;
  const tag = $('wakeLockStatusTag');
  if (tag) {
    if (_screenWakeLock) {
      tag.textContent = 'ACTIVE 🔆';
      tag.className = 'text-[7.5px] font-mono font-bold px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse';
    } else if (MobileState.wakeLockEnabled) {
      tag.textContent = 'READY';
      tag.className = 'text-[7.5px] font-mono font-bold px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20';
    } else {
      tag.textContent = 'OFF';
      tag.className = 'text-[7.5px] font-mono font-bold px-1.5 py-0.2 rounded bg-white/10 text-zinc-400 border border-white/10';
    }
  }
}

// Auto re-acquire Screen Wake Lock when tab becomes visible again
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      if (MobileState.wakeLockEnabled && !_screenWakeLock) {
        await requestScreenWakeLock();
      }
      // Also unlock audio if needed
      if (MobileState.bgKeepAliveEnabled) {
        if (_bgAudioCtx && _bgAudioCtx.state === 'suspended') {
          try { _bgAudioCtx.resume(); } catch(e) {}
        }
      }
      // Background audio throttling: play at most a single pending chime on refocus
      if (_pendingBgSound) {
        const pending = _pendingBgSound;
        _pendingBgSound = null;
        // RC4: drop a pending chime that is no longer the latest
        // settled round for its timeframe (backgrounded/stale round).
        const _latestForTf = pending.tf && MobileState.lastSettledPeriodByTf ? MobileState.lastSettledPeriodByTf[pending.tf] : null;
        if (!pending.period || !pending.tf || !_latestForTf || String(_latestForTf) === String(pending.period)) {
          playSoundEffect(pending.type, true);
        }
      }
    }
  });
}

// Gesture Audio Unlocker for Mobile Browsers
function unlockAudioOnGesture() {
  if (_bgAudioCtx && _bgAudioCtx.state === 'suspended') {
    try { _bgAudioCtx.resume(); } catch(e) {}
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('click', unlockAudioOnGesture, { passive: true });
  window.addEventListener('touchstart', unlockAudioOnGesture, { passive: true });
}

// ── Persistent Storage Protection ──
async function requestPersistentStorageAction() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persist();
      const tag = $('storagePersistStatusTag');
      const btn = $('btnRequestPersistStorage');
      if (isPersisted) {
        if (tag) {
          tag.textContent = 'PROTECTED ✓';
          tag.className = 'text-[7.5px] font-mono font-bold px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
        }
        if (btn) {
          btn.textContent = 'ENABLED';
          btn.className = 'px-2.5 py-1 rounded-xl bg-emerald-500/20 text-emerald-300 font-mono text-[8px] font-bold';
        }
        showToast('🛡️ Storage Permanently Protected Against OS Eviction', 'success');
      } else {
        showToast('Standard Browser Quota Active', 'info');
      }
      return isPersisted;
    } catch(e) {
      showToast('Storage API unavailable', 'warn');
    }
  }
  return false;
}
window.requestPersistentStorageAction = requestPersistentStorageAction;

async function checkPersistentStorageStatus() {
  if (navigator.storage && navigator.storage.persisted) {
    try {
      const isPersisted = await navigator.storage.persisted();
      const tag = $('storagePersistStatusTag');
      const btn = $('btnRequestPersistStorage');
      if (isPersisted) {
        if (tag) {
          tag.textContent = 'PROTECTED ✓';
          tag.className = 'text-[7.5px] font-mono font-bold px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
        }
        if (btn) {
          btn.textContent = 'ENABLED';
          btn.className = 'px-2.5 py-1 rounded-xl bg-emerald-500/20 text-emerald-300 font-mono text-[8px] font-bold';
        }
      }
    } catch(e) {}
  }
}

// ── Modals & Apple Onboarding Sheet ──

function openBatteryOptimizationGuide() {
  const modal = $('batteryGuideModal');
  if (modal) modal.classList.remove('hidden');
}
window.openBatteryOptimizationGuide = openBatteryOptimizationGuide;

function toggleBatteryGuideModal(show) {
  const modal = $('batteryGuideModal');
  if (!modal) return;
  if (show !== undefined) {
    if (show) modal.classList.remove('hidden');
    else modal.classList.add('hidden');
  } else {
    modal.classList.toggle('hidden');
  }
}
window.toggleBatteryGuideModal = toggleBatteryGuideModal;

function openBackgroundPermissionModal() {
  const modal = $('bgPermissionModal');
  if (modal) modal.classList.remove('hidden');
}
window.openBackgroundPermissionModal = openBackgroundPermissionModal;

function dismissBackgroundPermissionModal(userAgreed) {
  const modal = $('bgPermissionModal');
  if (modal) modal.classList.add('hidden');
  try {
    localStorage.setItem('quant_bg_permission_prompted', '1');
  } catch(e) {}
}
window.dismissBackgroundPermissionModal = dismissBackgroundPermissionModal;

function allowBackgroundRunAll(autoOpenSettings = false) {
  // 1. Enable background audio keep-alive
  toggleBackgroundKeepAlive(true);

  // 2. Enable screen wake lock
  toggleWakeLock(true);

  // 3. Request storage persistence
  requestPersistentStorageAction();

  // 4. Request outside notification permission if supported
  if (typeof Notification !== 'undefined') {
    if (Notification.permission !== 'granted') {
      try {
        Notification.requestPermission().then(perm => {
          if (perm === 'granted') {
            try { localStorage.setItem('quant_outside_notif', '1'); } catch(e) {}
          }
        });
      } catch(e) {}
    } else {
      try { localStorage.setItem('quant_outside_notif', '1'); } catch(e) {}
    }
  }

  // 5. Dismiss starting sheet
  dismissBackgroundPermissionModal(true);
  showToast('🚀 Background Execution & Anti-Sleep Active!', 'success');

  // 6. Auto-open settings if requested
  if (autoOpenSettings) {
    setTimeout(() => {
      window.location.href = 'settings.html';
    }, 450);
  }
}
window.allowBackgroundRunAll = allowBackgroundRunAll;

function checkAndPromptBackgroundPermission() {
  try {
    const alreadyPrompted = localStorage.getItem('quant_bg_permission_prompted') === '1';
    if (!alreadyPrompted) {
      openBackgroundPermissionModal();
    }
  } catch(e) {}
}
window.checkAndPromptBackgroundPermission = checkAndPromptBackgroundPermission;

function syncBackgroundSettingsUI() {
  updateBackgroundKeepAliveUI();
  updateWakeLockUI();
  checkPersistentStorageStatus();
}


function setBaseStakeOption(val) {
  document.querySelectorAll('.stake-opt-btn').forEach(b => {
    const isActive = b.id === `stakeBtn-${val}`;
    b.className = isActive
      ? 'stake-opt-btn px-2 py-0.5 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold'
      : 'stake-opt-btn px-2 py-0.5 rounded-lg bg-white/5 text-zinc-400 border border-white/5';
  });
  setSimBaseStake(val);
}
window.setBaseStakeOption = setBaseStakeOption;

// ── 25. Export & Data Utilities ───────────────────────────────────────────────

function exportAuditCSV() {
  const tf = MobileState.timeframe;
  const list = MobileState.historyByTf[tf] || [];
  if (list.length === 0) { showToast('No audit data to export.', 'warn'); return; }

  const rows = [['Period', 'Number', 'Size', 'Color', 'AI Target', 'AI Correct', 'Result']];
  list.forEach(r => {
    rows.push([r.period, r.number, r.size, r.color, r.aiTarget || '', r.aiCorrect !== null && r.aiCorrect !== undefined ? (r.aiCorrect ? 'YES' : 'NO') : '', r.result || '']);
  });

  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `quant_audit_${tf}_${Date.now()}.csv`;
  a.click();
}
window.exportAuditCSV = exportAuditCSV;

function exportLogsJSON() {
  const data = { historyByTf: MobileState.historyByTf, auditStats: MobileState.auditStats, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `quant_logs_${Date.now()}.json`;
  a.click();
}
window.exportLogsJSON = exportLogsJSON;

function clearAppCache() {
  if (!confirm('Clear all local caches and reset stats?')) return;
  ['30s', '1m', '3m', '5m'].forEach(tf => {
    try { localStorage.removeItem(`quant_history_${tf}`); } catch(e) {}
    try { localStorage.removeItem(`quant_user_ai_reset_${tf}`); } catch(e) {}
    try { localStorage.removeItem(`quant_user_model_stats_${tf}`); } catch(e) {}
  });
  MobileState.historyByTf = { '30s': [], '1m': [], '3m': [], '5m': [] };
  MobileState.modelPools = {};
  showToast('Cache cleared. Reloading...', 'success');
  setTimeout(() => location.reload(), 800);
}
window.clearAppCache = clearAppCache;

function resetMobileAudit(e) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  const tf = MobileState.timeframe;
  const list = MobileState.historyByTf[tf] || [];
  const latestPeriod = list.length > 0 ? String(list[list.length - 1].period) : 'RESET_NOW';

  if (!MobileState.auditResetPeriod) MobileState.auditResetPeriod = {};
  MobileState.auditResetPeriod[tf] = latestPeriod;
  try {
    localStorage.setItem(`wingo_audit_reset_${tf}`, latestPeriod);
  } catch(e) {}

  if (window.TimeframeManager && typeof window.TimeframeManager.resetAudit === 'function') {
    window.TimeframeManager.resetAudit(tf, latestPeriod);
  }

  // Clear live prediction tags on past rounds in memory so they are not recounted
  list.forEach(r => {
    r.aiTarget = null;
    r.aiType = null;
    r.aiCorrect = null;
    r.result = null;
  });

  MobileState.auditStats = { total: 0, wins: 0, losses: 0, maxWinStreak: 0, maxLossStreak: 0, curStreak: 0 };

  // Explicitly update DOM immediately on first click
  setText('auditWinRate', '—%');
  setText('auditTotal', '0');
  setText('auditWins', '0');
  setText('auditLosses', '0');
  setText('auditMaxWinStreak', '0 W');
  setText('auditMaxLossStreak', '0 L');
  const wr = $('auditWinRate');
  if (wr) wr.className = 'text-base font-black text-zinc-400 tracking-tight';

  const bentoAcc = $('aiBentoAccuracy');
  if (bentoAcc) bentoAcc.textContent = '—%';
  const bentoRatio = $('aiBentoScoreRatio');
  if (bentoRatio) bentoRatio.textContent = '0W · 0L';
  const curStreakEl = $('aiBentoCurrentStreak');
  if (curStreakEl) {
    curStreakEl.textContent = '— Standby';
    curStreakEl.className = 'text-lg font-black text-zinc-400 mt-0.5 tracking-tight';
  }
  const streakTypeEl = $('aiBentoStreakType');
  if (streakTypeEl) streakTypeEl.textContent = 'Awaiting Live Round';
  const bestStreakEl = $('aiBentoBestStreak');
  if (bestStreakEl) bestStreakEl.textContent = '0 Wins';
  const drawEl = $('aiBentoDrawdown');
  if (drawEl) {
    drawEl.textContent = '🛡️ Safe (0)';
    drawEl.className = 'text-lg font-black mt-0.5 tracking-tight text-sky-400';
  }

  renderPredictionAudit(list);
  renderAdaptiveAI(list);
  showToast('Accuracy audit reset to 0% for new session.', 'success');
}
window.resetMobileAudit = resetMobileAudit;

// ── 26. Real Auto-Bet & Iframe Controls ───────────────────────────────────────

function toggleRealAutoBet() {
  const btn = $('realAutoBetBtn');
  const isActive = btn && !btn.classList.contains('text-zinc-400');
  if (btn) {
    if (!isActive) {
      btn.textContent = 'ACTIVE';
      btn.className = 'px-2 py-0.5 rounded-full font-mono text-[8px] font-black bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 active:scale-95 transition';
    } else {
      btn.textContent = 'STANDBY';
      btn.className = 'px-2 py-0.5 rounded-full font-mono text-[8px] font-black bg-white/10 text-zinc-400 border border-white/10 active:scale-95 transition';
    }
  }
}
window.toggleRealAutoBet = toggleRealAutoBet;

function reloadWebIframe() {
  const iframe = $('dhaniwinIframe');
  if (iframe) { showDhaniLoadingOverlay(); iframe.src = iframe.src; }
}
window.reloadWebIframe = reloadWebIframe;

// ── DhaniWin web navigation (cross-origin iframe: use joint session history) ──
function dhaniWebBack() { try { history.back(); } catch(e) {} }
function dhaniWebForward() { try { history.forward(); } catch(e) {} }
function dhaniWebHome() {
  const iframe = $('dhaniwinIframe');
  if (iframe) { const targetUrl = getDhaniEntryUrl(); iframe.src = targetUrl; noteDhaniTransport(targetUrl); }
}
window.dhaniWebBack = dhaniWebBack;
window.dhaniWebForward = dhaniWebForward;
window.dhaniWebHome = dhaniWebHome;
// If Back walks past the first DhaniWin page we land on our sentinel entry: stay in app, reload DhaniWin home.
window.addEventListener('popstate', (e) => {
  const webTab = $('tab-web');
  if (e.state && e.state.dhaniSentinel && webTab && webTab.style.display !== 'none') {
    dhaniWebHome();
  }
});

// ── 27. PWA Installation ──────────────────────────────────────────────────────

let _pwaInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _pwaInstallPrompt = e;
  const btn = $('pwaInstallActionBtn');
  if (btn) btn.style.display = 'flex';
});

function triggerPWAInstall() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  if (isIOS) {
    toggleIOSInstallModal(true);
    return;
  }
  if (_pwaInstallPrompt) {
    _pwaInstallPrompt.prompt();
    _pwaInstallPrompt.userChoice.then(choice => {
      if (choice.outcome === 'accepted') {
        const btnText = $('pwaInstallBtnText');
        if (btnText) btnText.textContent = 'INSTALLED';
      }
      _pwaInstallPrompt = null;
    });
  }
}
window.triggerPWAInstall = triggerPWAInstall;

function toggleIOSInstallModal(show) {
  const modal = $('iosInstallModal');
  if (modal) { if (show) modal.classList.remove('hidden'); else modal.classList.add('hidden'); }
}
window.toggleIOSInstallModal = toggleIOSInstallModal;

// ── 28. Debug / Test Utilities ────────────────────────────────────────────────

window.testResultAnimation = function(type) {
  const { periodStr } = computeRTState(MobileState.timeframe);
  const isLoss = type === 'loss';
  const activeTarget = MobileState.activePrediction?.target || 'BIG';
  triggerAITargetBoxAnimation(isLoss ? 'LOSS' : 'WIN', {
    period: periodStr,
    number: isLoss ? 3 : 8,
    size: isLoss ? 'SMALL' : 'BIG',
    color: isLoss ? 'RED' : 'GREEN',
    target: activeTarget
  });
};

// ── 29. DhaniWin Real Loss Recovery & Semi-Auto Pre-Fill Engine ──────────────

const MobileBridgeState = {
  connected: false,
  enabled: false,
  baseStake: 2,
  multiplier: 2.0,
  maxStakeCap: 64,
  takeProfit: 100,
  stopLoss: 50,
  currentLevel: 0,
  currentStake: 2,
  lastPeriodDispatched: null,
  channel: null,
  externalWindow: null,
  retryAttemptedPeriod: null,
  userBalance: 0.00,
  sessionPnl: 0.00,
  totalBets: 0,
  wins: 0,
  losses: 0,
  consecutiveLosses: 0,
  circuitBreakerActive: false,
  circuitBreakerPauseRounds: 0,
  userId: null,
  authToken: null,
  riskMode: 'profitable',
  autoOptimizeBase: true,
  maxLevelCap: 3,
  circuitBreakerLossLimit: 3
};
window.MobileBridgeState = MobileBridgeState;

const RISK_MODES = {
  safe: {
    id: 'safe',
    name: 'SAFE',
    icon: '🛡️',
    baseFraction: 0.005, // 0.5% of balance (min ₹1)
    defaultBase: 1,
    multiplier: 1.5,
    maxLevel: 2,         // Max 2 steps
    stopLossPct: 0.15,
    takeProfitPct: 0.10,
    circuitBreakerLosses: 2,
    description: 'Capital Preservation • Low Drawdown'
  },
  profitable: {
    id: 'profitable',
    name: 'PROFITABLE',
    icon: '💰',
    baseFraction: 0.01,  // 1% of balance (min ₹2)
    defaultBase: 2,
    multiplier: 2.0,
    maxLevel: 3,         // Max 3 steps (1x, 2x, 4x)
    stopLossPct: 0.30,
    takeProfitPct: 0.25,
    circuitBreakerLosses: 3,
    description: 'Optimal Yield • Balanced Recovery'
  },
  risk: {
    id: 'risk',
    name: 'RISK',
    icon: '⚡',
    baseFraction: 0.025, // 2.5% of balance
    defaultBase: 5,
    multiplier: 2.2,
    maxLevel: 4,         // Max 4 steps
    stopLossPct: 0.50,
    takeProfitPct: 0.50,
    circuitBreakerLosses: 4,
    description: 'High Velocity • 4-Tier Recovery'
  },
  high_risk: {
    id: 'high_risk',
    name: 'HIGH RISK',
    icon: '🔥',
    baseFraction: 0.05,  // 5% of balance
    defaultBase: 10,
    multiplier: 2.5,
    maxLevel: 5,         // Max 5 steps
    stopLossPct: 0.70,
    takeProfitPct: 1.00,
    circuitBreakerLosses: 5,
    description: 'Maximum Aggression • Deep Ladder'
  }
};
window.RISK_MODES = RISK_MODES;

function setRiskMode(modeKey) {
  if (!RISK_MODES[modeKey]) modeKey = 'profitable';
  MobileBridgeState.riskMode = modeKey;
  try { localStorage.setItem('dhaniwin_risk_mode', modeKey); } catch(e) {}
  autoOptimizeBaseStake();
  updateRiskModeUI();
  if (typeof playSoundEffect === 'function') playSoundEffect('click');
}
window.setRiskMode = setRiskMode;

function toggleAutoOptimizeBase(forceState) {
  if (forceState !== undefined) {
    MobileBridgeState.autoOptimizeBase = !!forceState;
  } else {
    MobileBridgeState.autoOptimizeBase = !MobileBridgeState.autoOptimizeBase;
  }
  try { localStorage.setItem('dhaniwin_auto_optimize_base', MobileBridgeState.autoOptimizeBase ? '1' : '0'); } catch(e) {}
  autoOptimizeBaseStake();
  updateRiskModeUI();
  if (typeof playSoundEffect === 'function') playSoundEffect('click');
}
window.toggleAutoOptimizeBase = toggleAutoOptimizeBase;

function autoOptimizeBaseStake() {
  const modeKey = MobileBridgeState.riskMode || 'profitable';
  const mode = RISK_MODES[modeKey] || RISK_MODES.profitable;
  const balance = Number(MobileBridgeState.userBalance) || 0;

  if (MobileBridgeState.autoOptimizeBase && balance > 0) {
    const optimalBase = Math.max(1, Math.floor(balance * mode.baseFraction));
    MobileBridgeState.baseStake = optimalBase;
  } else if (!MobileBridgeState.baseStake || MobileBridgeState.baseStake < 1) {
    MobileBridgeState.baseStake = mode.defaultBase;
  }

  MobileBridgeState.multiplier = mode.multiplier;
  MobileBridgeState.maxLevelCap = mode.maxLevel;
  MobileBridgeState.circuitBreakerLossLimit = mode.circuitBreakerLosses;

  // SOLVENCY PROTECTION: Never let maximum ladder draw exceed available balance
  if (balance > 0) {
    let totalLadderCost = 0;
    for (let i = 0; i < mode.maxLevel; i++) {
      totalLadderCost += Math.round(MobileBridgeState.baseStake * Math.pow(mode.multiplier, i));
    }
    if (totalLadderCost > balance * 0.80) {
      const multSum = Array.from({length: mode.maxLevel}, (_, i) => Math.pow(mode.multiplier, i)).reduce((a, b) => a + b, 0);
      const safeMaxBase = Math.max(1, Math.floor((balance * 0.70) / (multSum || 1)));
      MobileBridgeState.baseStake = Math.min(MobileBridgeState.baseStake, safeMaxBase);
    }
  }

  calculateAndRenderMobileStake();
  updateRiskModeUI();
}
window.autoOptimizeBaseStake = autoOptimizeBaseStake;

function updateRiskModeUI() {
  const modeKey = MobileBridgeState.riskMode || 'profitable';
  ['safe', 'profitable', 'risk', 'high_risk'].forEach(m => {
    const btn = $('riskModeBtn-' + m);
    if (!btn) return;
    if (m === modeKey) {
      btn.className = 'py-1.5 rounded-xl font-mono text-[8.5px] font-bold border flex flex-col items-center justify-center transition active:scale-95 bg-amber-500/25 text-amber-300 border-amber-500/40 shadow-sm';
    } else {
      btn.className = 'py-1.5 rounded-xl font-mono text-[8.5px] font-bold border flex flex-col items-center justify-center transition active:scale-95 bg-white/5 text-zinc-400 border-white/5';
    }
  });

  const optBtn = $('autoOptimizeToggleBtn');
  if (optBtn) {
    if (MobileBridgeState.autoOptimizeBase) {
      optBtn.className = 'px-2 py-0.5 rounded-full font-mono text-[8px] font-bold border transition active:scale-95 bg-emerald-500/20 text-emerald-300 border-emerald-500/30';
      optBtn.textContent = '⚡ Auto-Base: ON';
    } else {
      optBtn.className = 'px-2 py-0.5 rounded-full font-mono text-[8px] font-bold border transition active:scale-95 bg-white/5 text-zinc-400 border-white/10';
      optBtn.textContent = '⚡ Auto-Base: OFF';
    }
  }

  const summary = $('riskModeSummary');
  if (summary) {
    const mode = RISK_MODES[modeKey] || RISK_MODES.profitable;
    summary.textContent = `Ladder: ${mode.maxLevel}L • Base: ₹${MobileBridgeState.baseStake} (${(mode.baseFraction * 100).toFixed(1)}%) • Mult: ${mode.multiplier}x`;
  }
}
window.updateRiskModeUI = updateRiskModeUI;

function initMobileDhaniWinBridge() {
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      MobileBridgeState.channel = new BroadcastChannel('dhaniwin_quant_channel');
      MobileBridgeState.channel.onmessage = (ev) => handleMobileBridgeMessage(ev.data);
    } catch(e) {
      console.warn('[Mobile Bridge] BroadcastChannel init error:', e);
    }
  }
  // Pivot origin allowlist: bridge state is accepted ONLY from the
  // app's own origin (self-posted orders) or a DhaniWin family
  // origin (the natively injected bridge in a direct frame) — never
  // '*' and never an unlisted origin. The BroadcastChannel path is
  // origin-scoped by the platform and needs no gate.
  window.addEventListener('message', (ev) => {
    if (ev && ev.data && typeof ev.data === 'object') {
      const origin = ev.origin;
      const selfOrigin = (typeof window !== 'undefined' && window.location) ? window.location.origin : null;
      const dhaniOrigin = window.DhaniTransport && typeof window.DhaniTransport.isDhaniwinOrigin === 'function'
        ? window.DhaniTransport.isDhaniwinOrigin(origin) : false;
      if (origin !== selfOrigin && !dhaniOrigin) return;
      handleMobileBridgeMessage(ev.data);
    }
  });

  // No credential purge here: older builds persisted the bridge's
  // raw session token under 'ar_token', but that leak is long gone —
  // the bridge now publishes a tokenPresent boolean only and never
  // stores a raw value, so there is nothing left to purge. And
  // 'ar_token' is DhaniWin's own live session key on the shared
  // origin (app page + DhaniWin frame share one localStorage), so
  // deleting it would kill a live login on every app boot. Login
  // state comes from the boolean flags + live bridge state; the user
  // ID comes from the bridge's published userId field (see the
  // DHANIWIN_USER_STATE branch in handleMobileBridgeMessage).

  // Restore saved risk mode & auto optimize preference
  try {
    const savedMode = localStorage.getItem('dhaniwin_risk_mode');
    if (savedMode && RISK_MODES[savedMode]) MobileBridgeState.riskMode = savedMode;
    const savedOpt = localStorage.getItem('dhaniwin_auto_optimize_base');
    if (savedOpt !== null) MobileBridgeState.autoOptimizeBase = savedOpt === '1';
  } catch(e) {}

  autoOptimizeBaseStake();
  updateRiskModeUI();
  calculateAndRenderMobileStake();
  renderMobileWalletStats();
  setupFloatingOrb();

  // Cross-origin iframe.src is not polled for session state, allowing the user to browse any DhaniWin page freely.
}



// Task O (connection resilience): the auto-bet-shake animation is
// added on DHANIWIN_BET_PREPARED and removed on confirmation /
// failure / cancellation / settlement — all bridge-message or cycle
// driven. When the app is backgrounded those drivers stall, so a
// shake staged before the gap can stick forever if its clearing
// message was missed while suspended. On every return to
// foreground, reconcile: if no bet is currently staged for the LIVE
// period, the shake is stale and comes off. This never clears a
// live staged bet (same period still live), and it never invents
// settlement — it only removes a visual class whose round is over.
function reconcileAutoShakeState() {
  try {
    const prepBtn = $('mobileBridgeToggleBtn');
    const targetDisplay = $('mobileWebTargetDisplay');
    if (!prepBtn && !targetDisplay) return;
    const dispatched = (typeof MobileBridgeState !== 'undefined' && MobileBridgeState.lastPeriodDispatched != null)
      ? String(MobileBridgeState.lastPeriodDispatched) : '';
    const live = (typeof MobileState !== 'undefined' && MobileState.activePrediction && MobileState.activePrediction.period != null)
      ? String(MobileState.activePrediction.period) : '';
    const stagedLive = dispatched !== '' && live !== '' && dispatched === live;
    if (!stagedLive) {
      if (prepBtn) prepBtn.classList.remove('auto-bet-shake');
      if (targetDisplay) targetDisplay.classList.remove('auto-bet-shake');
    }
  } catch (e) { /* reconcile must never break the app */ }
}
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconcileAutoShakeState();
  });
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pageshow', () => { reconcileAutoShakeState(); });
}

let _syncLogoutCount = 0;

function handleMobileBridgeMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  // Bridge-life proof for the proxy-failure fallback: any of the
  // bridge's own lifecycle/state messages means the bridge really is
  // running inside the embedded page, so no fallback may fire.
  if (msg.type === 'DHANIWIN_BRIDGE_HANDSHAKE' || msg.type === 'DHANIWIN_BRIDGE_HEARTBEAT' || msg.type === 'DHANIWIN_USER_STATE') {
    noteDhaniBridgeSignal();
  }
  // Bet-slip dock auto-hide (Addition 3): transitions from the
  // bridge's slip watcher, plus the state-sync field for late
  // joiners. Independent of the chain below.
  if (msg.type === 'O101_BETSLIP' && typeof msg.open === 'boolean') {
    setBetSlipDockHidden(msg.open);
  }
  if (msg.type === 'DHANIWIN_USER_STATE' && typeof msg.betSlipOpen === 'boolean') {
    setBetSlipDockHidden(msg.betSlipOpen);
  }
  // User ID from the bridge's published userId field (one of the 7
  // relayed state fields — an identifier, never a credential). This
  // replaces the old JWT-decode path, which is gone with the token.
  if (msg.type === 'DHANIWIN_USER_STATE' && msg.userId !== undefined && msg.userId !== null && String(msg.userId) !== '') {
    MobileBridgeState.userId = String(msg.userId);
    const uIdEl = $('mobileWebUserId');
    if (uIdEl) uIdEl.textContent = 'ID: ' + MobileBridgeState.userId;
  }
  if (msg.type === 'DHANIWIN_BRIDGE_HANDSHAKE' || msg.type === 'DHANIWIN_BRIDGE_HEARTBEAT') {
    setMobileBridgeStatus(true);
    if (msg.type === 'DHANIWIN_BRIDGE_HANDSHAKE') {
      postMobileBridge({ type: 'UPDATE_BET_SETTINGS', stake: MobileBridgeState.currentStake, maxStake: MobileBridgeState.maxStakeCap, timeframe: MobileState.timeframe });
      // Task O (connection resilience): a bridge (re)appearance is an
      // auto-connect moment — ask for a fresh wallet/API probe at
      // once instead of waiting for the bridge's 15s heartbeat.
      postMobileBridge({ type: 'DHANIWIN_REQUEST_SYNC', timestamp: Date.now() });
    }
  } else if (msg.type === 'DHANIWIN_TIMEFRAME_CHANGE' && msg.timeframe) {
    if (MobileState.timeframe !== msg.timeframe && ['30s', '1m', '3m', '5m'].includes(msg.timeframe)) {
      console.log('[Mobile] ⚡ Synced timeframe from embedded game:', msg.timeframe);
      setMobileTimeframe(msg.timeframe);
    }
  } else if (msg.type === 'DHANIWIN_BET_CONFIRMATION') {
    setMobileBridgeStatus(true, `Confirmed: ${msg.target} ₹${msg.stake}`);
    MobileBridgeState.totalBets += 1;
    const prepBtn = $('mobileBridgeToggleBtn');
    if (prepBtn) prepBtn.classList.remove('auto-bet-shake');
    const targetDisplay = $('mobileWebTargetDisplay');
    if (targetDisplay) targetDisplay.classList.remove('auto-bet-shake');
    renderMobileWalletStats();
  } else if (msg.type === 'DHANIWIN_BET_PREPARED') {
    MobileBridgeState.lastPeriodDispatched = String(msg.period || MobileBridgeState.lastPeriodDispatched || '');
    MobileBridgeState.retryAttemptedPeriod = null;
    setMobileBridgeStatus(true, `Ready: ${msg.target} ₹${msg.stake} • Tap Bet`);
    const prepBtn = $('mobileBridgeToggleBtn');
    if (prepBtn) prepBtn.classList.add('auto-bet-shake');
    const targetDisplay = $('mobileWebTargetDisplay');
    if (targetDisplay) targetDisplay.classList.add('auto-bet-shake');
  } else if (msg.type === 'DHANIWIN_BET_PREP_FAILED') {
    const failedPeriod = String(msg.period || '');
    if (failedPeriod === String(MobileBridgeState.lastPeriodDispatched || '')) {
      MobileBridgeState.lastPeriodDispatched = null;
    }
    const prepBtn = $('mobileBridgeToggleBtn');
    if (prepBtn) prepBtn.classList.remove('auto-bet-shake');
    const targetDisplay = $('mobileWebTargetDisplay');
    if (targetDisplay) targetDisplay.classList.remove('auto-bet-shake');
    setMobileBridgeStatus(false, msg.reason || 'Selection failed • Retry available');
    const activePeriod = String(MobileState.activePrediction?.period || '');
    if (MobileBridgeState.enabled && failedPeriod && failedPeriod === activePeriod && MobileBridgeState.retryAttemptedPeriod !== failedPeriod) {
      MobileBridgeState.retryAttemptedPeriod = failedPeriod;
      setTimeout(() => {
        if (MobileBridgeState.enabled && String(MobileState.activePrediction?.period || '') === failedPeriod) dispatchMobileBetOrder();
      }, 700);
    }
  } else if (msg.type === 'DHANIWIN_BET_CANCELLED') {
    const prepBtn = $('mobileBridgeToggleBtn');
    if (prepBtn) prepBtn.classList.remove('auto-bet-shake');
    const targetDisplay = $('mobileWebTargetDisplay');
    if (targetDisplay) targetDisplay.classList.remove('auto-bet-shake');
    setMobileBridgeStatus(true, msg.reason || 'Bet Cancelled (Lockout)');
  } else if (msg.type === 'DHANIWIN_USER_LOGGED_OUT' || msg.type === 'DHANIWIN_SESSION_OUT') {
    // Authoritative logouts (an explicit logout action/endpoint
    // observed by the bridge, flagged explicit:true) zero the grace
    // period and expire immediately. A heuristic logout message
    // (scrape session-out, transient auth-page view, explicit:false)
    // must NEVER zero the grace period: inside grace it is ignored
    // outright, and outside grace it expires through the grace guard
    // inside handleDhaniSessionExpired. Zeroing grace here previously
    // defeated that guard for every bridge logout message.
    // Nothing is locked behind login (fix round #3); this is state
    // reporting only. The reason strings are a legacy fallback for
    // bridge builds that predate the explicit flag.
    const authoritativeLogout = msg.explicit === true || msg.reason === 'Logout API call' || msg.reason === 'User clicked logout button';
    if (authoritativeLogout) {
      _authGracePeriodUntil = 0;
      try { sessionStorage.removeItem('dhaniwin_auth_grace_until'); } catch(e) {}
      markUserLoggedOut();
      handleDhaniSessionExpired(msg.reason || 'Session Expired');
    } else if (!isAuthGracePeriodActive()) {
      markUserLoggedOut();
      handleDhaniSessionExpired(msg.reason || 'Session Expired');
    }
  } else if (msg.type === 'DHANIWIN_SCROLL') {
    // Bridge convention:
    // msg.direction='up' = finger swiped up = content scrolled DOWN
    //   → Phase 3C: header hides, dock fully hides (no compact)
    // msg.direction='down' = finger swiped down = content scrolled UP
    //   → fix round (owner order 2026-10-27 ~12:03 IST): the menu
    //     stays hidden — it returns ONLY on the restore-handle tap.
    //     Header reopens only in 'reopen' mode (by default it stays
    //     hidden until the top-edge tap).
    const userScrolledDown = msg.direction === 'up';
    if (userScrolledDown) {
      setHomeHeaderHidden(true);
      if (typeof window._dockSetHidden === 'function') window._dockSetHidden(true);
    } else {
      // User scrolled UP: menu stays hidden (no _dockExpand here);
      // top bar per mode only.
      if (!topBarStayHidden()) setHomeHeaderHidden(false);
    }
  } else if (msg.type === 'DHANIWIN_TOUCH' || msg.type === 'DHANIWIN_PAGE_TAP') {
    // Touching anywhere inside the DhaniWin page makes the bottom dock compact
    if (typeof window._dockSetCompact === 'function') {
      window._dockSetCompact(true);
    } else if (typeof window._dockSetHidden === 'function') {
      window._dockSetHidden(true);
    }
  } else if (msg.type === 'DHANIWIN_AUTH_SUCCESS' || msg.type === 'DHANIWIN_LOGIN_DETECTED') {
    // Mark logged in via ALL keys and set 60s grace period
    markUserLoggedIn();
    try {
      localStorage.setItem('dhaniwin_user_has_logged_in_ever', '1');
      localStorage.setItem('dhaniwin_registered', '1');
    } catch(e) {}
    _authGracePeriodUntil = Date.now() + 60000;
    _syncLogoutCount = 0;
    // Bridge status line only — no login confirmation toast, no
    // unlock modal, no auth bar (fix round #3: login UI fully gone).
    // NOTE (Fix 0): this branch must NEVER reload the frame. The
    // bridge re-emits LOGIN_DETECTED on every new document (its
    // _wasLoggedInBefore starts false), so a reload here re-fires
    // this branch on every cycle — the 2-second verified /
    // not-logged-in loop with a blank frame. The bridge already
    // handles post-login routing (prefix-aware goHomeAfterLogin).
    setMobileBridgeStatus(true, 'Login Verified ✓');

  } else if (msg.type === 'DHANIWIN_USER_SYNC' || msg.type === 'DHANIWIN_REAL_BALANCE') {
    // Owner rule (balance-zero fix): a 0 balance never updates the
    // displayed figure — the previous balance (or blank, when none
    // was ever verified) stands while the search for an update goes
    // on. The login-state handling below still runs for the message.
    if (msg.balance !== null && msg.balance !== undefined && !isNaN(Number(msg.balance)) && Number(msg.balance) !== 0) {
      const prevBal = MobileBridgeState.userBalance;
      MobileBridgeState.userBalance = Number(msg.balance);
      const balEl = $('mobileWebBalance');
      if (balEl) balEl.textContent = '₹' + MobileBridgeState.userBalance.toFixed(2);
      if (MobileBridgeState.autoOptimizeBase && Math.abs(prevBal - MobileBridgeState.userBalance) > 0.05) {
        autoOptimizeBaseStake();
      }
    }

    const isAuthUrl = msg.url && (msg.url.toLowerCase().includes('/login') || msg.url.toLowerCase().includes('/register'));

    // Pending (Fix 5a) comes FIRST: while the bridge reports its
    // state as unproven, this sync changes nothing — it must never
    // revoke a login, and an auth-page flash inside the pending
    // window must not either. The legacy null/undefined branch
    // below still means "no change" for messages without the field.
    if (msg.pending) {
      _syncLogoutCount = 0;
    } else if (msg.isLoggedIn) {
      _syncLogoutCount = 0;
      markUserLoggedIn();
    } else if (msg.isLoggedIn === false || isAuthUrl) {
      // If bridge explicitly identifies user as not logged in or on auth pages, immediately revoke
      if (isUserLoggedIn() && !isAuthGracePeriodActive()) {
        _syncLogoutCount = 0;
        markUserLoggedOut();
        handleDhaniSessionExpired('Session Expired');
      }
    } else {
      _syncLogoutCount = 0;
    }

    // Presence only: the bridge reports tokenPresent (boolean) since
    // the credential fix — the app never reads, stores, or decodes
    // a raw session token. The boolean flags are the login truth.
    if (msg.tokenPresent && msg.isLoggedIn !== false && !isAuthUrl) {
      markUserLoggedIn();
      MobileBridgeState.authToken = true;
    }
    setMobileBridgeStatus(true);
  } else if (msg.type === 'INCHARGE_MODE_CHANGED' && msg.mode) {
    if (typeof setInchargeMode === 'function') {
      setInchargeMode(msg.mode);
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'quant_incharge_settings' && e.newValue) {
      try {
        const cfg = JSON.parse(e.newValue);
        if (cfg && cfg.mode && typeof setInchargeMode === 'function') {
          setInchargeMode(cfg.mode);
        }
      } catch(err) {}
    } else if (e.key === 'quant_sound') {
      MobileState.soundEnabled = e.newValue !== '0';
      if (typeof updateSoundMuteUI === 'function') updateSoundMuteUI();
    } else if (e.key === 'o101_axo_voice') {
      // Axo voice applies live: muting cancels any in-flight speech
      // at once and the sheet chip re-renders. orb-bridge also reads
      // the key itself at speak time, so the two stay in agreement.
      MobileState.axoVoiceEnabled = e.newValue !== '0';
      if (!MobileState.axoVoiceEnabled) { try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch(err) {} }
      if (window.__smartBall && typeof window.__smartBall.refreshAxoVoiceChip === 'function') window.__smartBall.refreshAxoVoiceChip();
    } else if (e.key === 'quant_haptics') {
      // Settings-page toggles apply live: these MobileState fields are
      // the live switches the vibrate/wake/keep-alive paths read.
      MobileState.hapticsEnabled = e.newValue !== '0';
    } else if (e.key === 'quant_wakelock') {
      MobileState.wakeLockEnabled = e.newValue === '1';
    } else if (e.key === 'quant_bg_keepalive') {
      MobileState.bgKeepAliveEnabled = e.newValue !== '0';
    } else if (e.key === 'o101_axo_mode') {
      // Axo mode applies live: orb-bridge reads the key at every
      // narration call, so the next event honours the switch.
      MobileState.axoMode = e.newValue === 'normal' ? 'normal' : 'ai';
      if (window.__smartBall && typeof window.__smartBall.refreshAxoModeChip === 'function') window.__smartBall.refreshAxoModeChip();
    }
  });
}

function setMobileBridgeStatus(connected, label) {
  MobileBridgeState.connected = connected;
  const dot = $('mobileBridgeDot');
  const lbl = $('mobileBridgeStatusLabel');
  if (dot) {
    dot.className = connected 
      ? 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block' 
      : 'w-2 h-2 rounded-full bg-amber-400 inline-block';
  }
  if (lbl) {
    lbl.textContent = label || (connected ? 'Bridge: Live (Ready)' : 'Bridge: Standby');
  }
}

function postMobileBridge(payload) {
  if (MobileBridgeState.channel) {
    try { MobileBridgeState.channel.postMessage(payload); } catch(e) {}
  }
  const iframe = $('dhaniwinIframe');
  if (iframe && iframe.contentWindow) {
    try { iframe.contentWindow.postMessage(payload, '*'); } catch(e) {}
  }
  if (MobileBridgeState.externalWindow && !MobileBridgeState.externalWindow.closed) {
    try { MobileBridgeState.externalWindow.postMessage(payload, '*'); } catch(e) {}
  }
  try { window.postMessage(payload, '*'); } catch(e) {}
}

function openMobileBridgeTab(event) {
  if (event) event.preventDefault();
  const iframe = $('dhaniwinIframe');
  const link = $('mobileWebExternalTabLink');
  const url = (iframe && iframe.src) || (link && link.href) || DHANIWIN_INTERVAL_URLS['30s'];
  const tab = window.open(url, 'dhaniwinQuantBridge');
  if (!tab) {
    setMobileBridgeStatus(false, 'Allow pop-ups to connect bridge');
    return false;
  }
  MobileBridgeState.externalWindow = tab;
  postMobileBridge({ type: 'UPDATE_BET_SETTINGS', stake: MobileBridgeState.currentStake, maxStake: MobileBridgeState.maxStakeCap, timeframe: MobileState.timeframe });
  return false;
}
window.openMobileBridgeTab = openMobileBridgeTab;

function setMobileDhaniWinTimeframe(tf) {
  setMobileTimeframe(tf);
}
window.setMobileDhaniWinTimeframe = setMobileDhaniWinTimeframe;

function updateMobileAutoBetSettings() {
  const baseEl = $('mobileWebBaseStake');
  const multEl = $('mobileWebMultiplier');
  const maxCapEl = $('mobileWebMaxStakeCap');
  const tpEl = $('mobileWebTakeProfit');
  const slEl = $('mobileWebStopLoss');

  if (baseEl) MobileBridgeState.baseStake = Math.max(1, Number(baseEl.value) || 2);
  if (multEl) MobileBridgeState.multiplier = Number(multEl.value) || 2.0;
  if (maxCapEl) MobileBridgeState.maxStakeCap = Math.max(1, Number(maxCapEl.value) || 64);
  if (tpEl) MobileBridgeState.takeProfit = Math.max(1, Number(tpEl.value) || 100);
  if (slEl) MobileBridgeState.stopLoss = Math.max(1, Number(slEl.value) || 50);

  calculateAndRenderMobileStake();
  postMobileBridge({ type: 'UPDATE_BET_SETTINGS', stake: MobileBridgeState.currentStake, maxStake: MobileBridgeState.maxStakeCap, timeframe: MobileState.timeframe });
}
window.updateMobileAutoBetSettings = updateMobileAutoBetSettings;

function calculateAndRenderMobileStake() {
  const maxLevels = MobileBridgeState.maxLevelCap || 3;
  const safeLevel = Math.min(maxLevels - 1, Math.max(0, MobileBridgeState.currentLevel || 0));
  MobileBridgeState.currentLevel = safeLevel;
  const unconstrainedStake = Math.round(MobileBridgeState.baseStake * Math.pow(MobileBridgeState.multiplier, safeLevel));
  // Don't double more than maxStakeCap
  let calculatedStake = Math.min(unconstrainedStake, MobileBridgeState.maxStakeCap);

  // Solvency Protection: Never let calculated stake exceed live scraped balance
  const balance = Number(MobileBridgeState.userBalance) || 0;
  if (balance > 0 && calculatedStake > balance) {
    calculatedStake = Math.max(1, Math.floor(balance));
  }

  MobileBridgeState.currentStake = calculatedStake;
  try { localStorage.setItem('dhaniwin_active_stake', String(MobileBridgeState.currentStake)); } catch(e) {}

  // Fix round (stake ownership): when the governor is active it
  // OWNS Base/Bet/Level (orb-bridge renderSignal, governed session
  // figures) — the legacy ladder must never overwrite them, or the
  // shown stake flips between the legacy figure and the governed
  // figure on every chip tap / settlement. Internal currentStake,
  // the localStorage write and the bridge broadcast below are
  // untouched (order paths unchanged); only the DOM writes yield.
  // Without a published governed verdict (governor absent), the
  // legacy figures remain the fallback display.
  const governedOwnsDisplays = typeof window !== 'undefined' && !!window.__o101Verdict;
  const stakeEl = governedOwnsDisplays ? null : $('mobileWebStakeDisplay');
  const lvlEl = governedOwnsDisplays ? null : $('mobileWebLevelBadge');
  const baseEl = governedOwnsDisplays ? null : $('assistantBaseStakeDisplay');
  if (stakeEl) stakeEl.textContent = '₹' + MobileBridgeState.currentStake;
  if (baseEl) baseEl.textContent = '₹' + MobileBridgeState.baseStake;
  if (lvlEl) {
    if (unconstrainedStake > MobileBridgeState.maxStakeCap) {
      lvlEl.textContent = `Level ${MobileBridgeState.currentLevel + 1} (Capped @ ₹${MobileBridgeState.maxStakeCap})`;
      lvlEl.className = 'text-[8px] font-mono font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30';
    } else {
      lvlEl.textContent = `Level ${MobileBridgeState.currentLevel + 1}` + (MobileBridgeState.currentLevel > 0 ? ` (Recovery x${MobileBridgeState.currentLevel})` : ' (Base)');
      lvlEl.className = MobileBridgeState.currentLevel > 0 
        ? 'text-[8px] font-mono font-bold px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 animate-pulse'
        : 'text-[8px] font-mono font-bold px-1.5 py-0.5 rounded bg-white/10 text-amber-300 border border-white/10';
    }
  }

  // Real-time broadcast to DhaniWin bridge iframe & BroadcastChannel
  postMobileBridge({
    type: 'UPDATE_BET_SETTINGS',
    stake: MobileBridgeState.currentStake,
    baseStake: MobileBridgeState.baseStake,
    level: MobileBridgeState.currentLevel,
    maxStake: MobileBridgeState.maxStakeCap,
    timeframe: MobileState.timeframe
  });

  if (typeof updateFloatingOrbUI === 'function') updateFloatingOrbUI();
  return MobileBridgeState.currentStake;
}
window.calculateAndRenderMobileStake = calculateAndRenderMobileStake;

function renderMobileWalletStats() {
  const pnlEl = $('mobileWebSessionPnl');
  const wrEl = $('mobileWebWinRate');
  if (pnlEl) {
    const isPos = MobileBridgeState.sessionPnl >= 0;
    pnlEl.textContent = (isPos ? '+₹' : '-₹') + Math.abs(MobileBridgeState.sessionPnl).toFixed(2);
    pnlEl.className = `text-sm font-black ${isPos ? 'text-emerald-400' : 'text-rose-400'}`;
  }
  if (wrEl) {
    const total = MobileBridgeState.wins + MobileBridgeState.losses;
    const pct = total > 0 ? Math.round((MobileBridgeState.wins / total) * 100) : 0;
    wrEl.textContent = `${total} (${total > 0 ? pct + '%' : '—%'})`;
  }
}
window.renderMobileWalletStats = renderMobileWalletStats;

function syncMobileUserWallet() {
  postMobileBridge({ type: 'DHANIWIN_REQUEST_SYNC', timestamp: Date.now() });
  setMobileBridgeStatus(MobileBridgeState.connected, 'Syncing Wallet...');
  setTimeout(() => {
    setMobileBridgeStatus(MobileBridgeState.connected);
  }, 1000);
}
window.syncMobileUserWallet = syncMobileUserWallet;

function stopAndResetMobileRecovery() {
  MobileBridgeState.currentLevel = 0;
  calculateAndRenderMobileStake();
  setMobileBridgeStatus(MobileBridgeState.connected, `⏹ Reset to Base (₹${MobileBridgeState.baseStake})`);
  if (typeof playSoundEffect === 'function') playSoundEffect('click');
}
window.stopAndResetMobileRecovery = stopAndResetMobileRecovery;

// ── Login is NOT a gate (fix round #2, owner's order) ─────────────
// The app is fully usable without login. The bridge login state is
// display-only (auth pill, status lines); it never blocks staging,
// firing, auto-prep, quick targets or stake chips. A real order
// still travels only through the DhaniWin page on the user's own
// tap, and DhaniWin itself refuses an order when its own session is
// absent — that real failure is shown, never a fake success. The
// "Ready" state still comes only from the bridge's
// DHANIWIN_BET_PREPARED ack, never from dispatch time. (This
// replaces the fix-round-2 VERIFIED gate: the owner found the gate
// itself caused bugs, and ordered it removed.)

function toggleMobileRealAutoBet(forceState) {
  // Fix round #2: arming auto-prep is never login-gated.
  if (forceState !== undefined) {
    MobileBridgeState.enabled = !!forceState;
  } else {
    MobileBridgeState.enabled = !MobileBridgeState.enabled;
  }
  const btn = $('mobileBridgeToggleBtn');
  const lbl = $('mobileBridgeStatusLabel');
  const dot = $('mobileBridgeDot');
  if (btn) {
    if (MobileBridgeState.enabled) {
      btn.className = 'w-full py-3.5 rounded-2xl font-mono text-xs font-black bg-rose-500/25 hover:bg-rose-500/35 text-rose-300 border border-rose-500/50 active:scale-95 transition shadow-[0_8px_24px_rgba(244,63,94,0.25)] flex items-center justify-center gap-2';
      if (lbl) lbl.textContent = '⏹ STOP AUTO-PREP & AUTO-SHAKE';
      if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-rose-400 animate-pulse';
      setMobileBridgeStatus(MobileBridgeState.connected, 'Auto-Prep Active');
      dispatchMobileBetOrder();
    } else {
      btn.className = 'w-full py-3.5 rounded-2xl font-mono text-xs font-black bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-300 border border-emerald-500/50 active:scale-95 transition shadow-[0_8px_24px_rgba(16,185,129,0.25)] flex items-center justify-center gap-2';
      if (lbl) lbl.textContent = '▶ ACTIVATE AUTO-PREP & AUTO-SHAKE';
      if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse';
      setMobileBridgeStatus(MobileBridgeState.connected, 'Standby');
    }
  }
  if (typeof updateFloatingOrbUI === 'function') updateFloatingOrbUI();
}
window.toggleMobileRealAutoBet = toggleMobileRealAutoBet;
window.toggleRealAutoBet = toggleMobileRealAutoBet;

function dispatchMobileBetOrder(targetOverride) {
  // Fix round #2: dispatch is never login-gated. The safety guards
  // below (circuit breaker, stop-loss / take-profit, solvency) all
  // still apply, and the status stays a neutral sent-state — the
  // "Ready" claim still comes only from the bridge's BET_PREPARED ack.
  // Check if 3-Loss Circuit Breaker is active / cool-off pause in progress
  if (MobileBridgeState.circuitBreakerPauseRounds > 0) {
    setMobileBridgeStatus(false, `🛡️ Circuit Breaker: Paused (${MobileBridgeState.circuitBreakerPauseRounds}R left)`);
    return;
  }

  // Strict Safety Guard: Under no conditions allow dispatch if consecutive losses reached limit
  const lossLimit = MobileBridgeState.circuitBreakerLossLimit || 3;
  if (MobileBridgeState.consecutiveLosses >= lossLimit) {
    MobileBridgeState.circuitBreakerActive = true;
    MobileBridgeState.circuitBreakerPauseRounds = 2;
    MobileBridgeState.currentLevel = 0;
    MobileBridgeState.currentStake = MobileBridgeState.baseStake || 2;
    MobileBridgeState.consecutiveLosses = 0;
    setMobileBridgeStatus(false, `🛡️ Circuit Breaker: Tripped on ${lossLimit} losses. Paused for 2R.`);
    return;
  }

  // Check if Stop Loss or Take Profit bounds were hit
  if (MobileBridgeState.sessionPnl >= MobileBridgeState.takeProfit) {
    toggleMobileRealAutoBet(false);
    showToast(`🎉 Take Profit Reached (+₹${MobileBridgeState.sessionPnl})! Auto-Prep Stopped.`, 'success');
    return;
  }
  if (MobileBridgeState.sessionPnl <= -MobileBridgeState.stopLoss) {
    toggleMobileRealAutoBet(false);
    showToast(`🛑 Stop Loss Reached (-₹${Math.abs(MobileBridgeState.sessionPnl)})! Auto-Prep Stopped.`, 'error');
    return;
  }

  const target = targetOverride || MobileState.activePrediction?.target || 'BIG';
  const history = MobileState.historyByTf[MobileState.timeframe] || [];
  const latestHistPeriod = history.length > 0 ? String(history[history.length - 1].period) : '';
  const period = String(MobileState.activePrediction?.period || latestHistPeriod || 'NEXT');

  // Avoid repeating identical dispatches unless overridden manually
  if (!targetOverride && MobileBridgeState.lastPeriodDispatched === period) return;
  if (!targetOverride) MobileBridgeState.lastPeriodDispatched = period;

  calculateAndRenderMobileStake();

  // Solvency Guard: Ensure user never runs out of money
  const balance = Number(MobileBridgeState.userBalance) || 0;
  if (balance > 0) {
    if (balance < 1) {
      toggleMobileRealAutoBet(false);
      setMobileBridgeStatus(false, '🛑 Insufficient Balance');
      showToast('⚠️ Balance is ₹0. Please deposit to continue auto-prep.', 'warn');
      return;
    }
    if (MobileBridgeState.currentStake > balance) {
      MobileBridgeState.currentStake = Math.max(1, Math.floor(balance));
    }
  }

  // No hero paint here: the governed render owns the hero surface,
  // and painting the target at dispatch time claimed a staged bet
  // before the bridge had acknowledged anything. The honest "Ready"
  // state arrives only via the bridge's DHANIWIN_BET_PREPARED ack.

  const orderPayload = {
    type: 'EXECUTE_REAL_BET',
    enabled: true,
    period: period,
    target: target,
    stake: MobileBridgeState.currentStake,
    maxStake: MobileBridgeState.maxStakeCap,
    manualConfirm: true, // Auto opens sheet and enters stake, leaves confirm button for user to tap
    timeframe: MobileState.timeframe,
    timestamp: Date.now()
  };

  postMobileBridge(orderPayload);
  // Neutral sent-state only. "Ready: … (Tap Bet)" is set exclusively
  // by the DHANIWIN_BET_PREPARED handler once the bridge has actually
  // staged the bet in the DhaniWin page — never at dispatch time.
  setMobileBridgeStatus(true, `Sent: ${target} ₹${MobileBridgeState.currentStake} — waiting for the bridge…`);
}
window.dispatchMobileBetOrder = dispatchMobileBetOrder;

function mobileQuickOpenTarget(target) {
  dispatchMobileBetOrder(target);
}
window.mobileQuickOpenTarget = mobileQuickOpenTarget;

function loadMobileWebUrl(url) {
  const iframe = $('dhaniwinIframe');
  const barText = $('mobileWebAddressBarText');
  const extLink = $('mobileWebExternalTabLink');
  let targetSrc = url || (typeof getDefaultDhaniUrl === 'function' ? getDefaultDhaniUrl() : DHANIWIN_HOME_URL);
  if (targetSrc === DHANIWIN_HOME_URL && typeof getDefaultDhaniUrl === 'function') {
    targetSrc = getDefaultDhaniUrl();
  }
  // The raw built-in home constant means "no custom URL set":
  // pivot default is DIRECT (the APK injects the bridge natively);
  // the proxy applies only under the explicit override. A custom
  // URL is never rewritten (see getDhaniEntryUrl).
  if (targetSrc === DHANIWIN_HOME_URL && dhaniFrameUseProxy()) targetSrc = proxifyDhaniUrl(targetSrc);
  if (iframe) iframe.src = targetSrc;
  noteDhaniTransport(targetSrc);
  if (barText) barText.textContent = targetSrc;
  if (extLink) extLink.href = targetSrc;
}
window.loadMobileWebUrl = loadMobileWebUrl;

function copyMobileBridgeScript() {
  const scriptUrl = window.location.origin + '/dhaniwin-bridge.js';
  const promptText = `// ==UserScript==\n// @name DhaniWin Quant AI Bridge\n// @match *://*dhaniwin*/*\n// ==/UserScript==\n// Direct script url: ${scriptUrl}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(promptText).then(() => {
      alert('✅ Bridge script link copied! Install into Tampermonkey or Kiwi Browser.');
    }).catch(() => {
      window.open(scriptUrl, '_blank');
    });
  } else {
    window.open(scriptUrl, '_blank');
  }
}
window.copyMobileBridgeScript = copyMobileBridgeScript;

// ── 29b. DhaniWin Minimalist Floating Assistant Controls ───────────────────────

function setAssistantBaseStake(amt) {
  // The sheet chips set the REAL base stake (they feed both the
  // governed ladder and the legacy dispatch). Fix round #2: a chip
  // tap is never login-gated — it just sets the base.
  const amount = Number(amt) || 2;
  MobileBridgeState.baseStake = amount;
  MobileBridgeState.currentLevel = 0; // Fresh base stake starts at Level 0
  [1, 2, 5, 10, 50, 100].forEach(chip => {
    const btn = $(`chipBtn-${chip}`);
    if (btn) {
      if (chip === amount) {
        btn.className = 'py-1 rounded-lg font-mono text-[8.5px] font-bold bg-amber-500/25 text-amber-300 border border-amber-500/40 active:scale-95 transition';
      } else {
        btn.className = 'py-1 rounded-lg font-mono text-[8.5px] font-bold bg-white/5 text-zinc-300 border border-white/5 active:scale-95 transition';
      }
    }
  });
  calculateAndRenderMobileStake();
  if (typeof updateFloatingOrbUI === 'function') updateFloatingOrbUI();
  if (typeof playSoundEffect === 'function') playSoundEffect('click');
  // Fix round (real-time base bet, owner order 2026-10-27 ~12:01 IST):
  // synchronously re-run the governed sync path (same functions the
  // cycle calls) so Base/Bet/pill/level update on the tap, not on the
  // next cycle tick. The legacy recompute above runs first and its
  // DOM writes already yield to a published governed verdict, so the
  // hook's governed figures are final. No-op when the module is absent.
  if (typeof window.__o101SyncBaseNow === 'function') {
    try { window.__o101SyncBaseNow(); } catch (e) { /* a tap must never break on sync */ }
  }
}
window.setAssistantBaseStake = setAssistantBaseStake;

function updateAssistantLossLimit(val) {
  const limit = Math.max(5, Number(val) || 100);
  MobileBridgeState.stopLoss = limit;
  const input = $('mobileWebStopLossLimit');
  if (input) input.value = limit;
}
window.updateAssistantLossLimit = updateAssistantLossLimit;

// ── Fix round 2026-10-24: full-history chunked road rendering ─────
// The history/sequence road used to hide behind render caps (8, 25,
// 30). Every road/table below now renders the FULL list, newest
// first, in chunks: the first chunk synchronously, the rest in
// idle-time slices, plus an immediate top-up when the user scrolls
// near the end — so a long history never janks and nothing is ever
// hidden behind a count. A re-render invalidates pending chunks via
// the container's generation token. This mirrors systems/historyRoad.js
// (fullRoadList / chunkList), the tested spec — a classic script
// cannot import that module, so the behaviour is implemented here.
function renderRoadCellsChunked(container, cellHtmlArray, opts) {
  if (!container) return;
  const chunkSize = (opts && opts.chunkSize) || 60;
  const onComplete = (opts && opts.onComplete) || null;
  const token = Number(container.dataset.roadToken || 0) + 1;
  container.dataset.roadToken = String(token);
  const alive = () => String(container.dataset.roadToken) === String(token);
  container.innerHTML = cellHtmlArray.slice(0, chunkSize).join('');
  let rendered = Math.min(chunkSize, cellHtmlArray.length);
  const finish = () => { if (onComplete) { try { onComplete(); } catch (e) {} } };
  if (rendered >= cellHtmlArray.length) { finish(); return; }
  const appendMore = () => {
    if (!alive() || rendered >= cellHtmlArray.length) return;
    const next = cellHtmlArray.slice(rendered, rendered + chunkSize);
    rendered += next.length;
    container.insertAdjacentHTML('beforeend', next.join(''));
    if (rendered >= cellHtmlArray.length) finish();
  };
  const pump = () => {
    if (!alive()) return;
    appendMore();
    if (rendered < cellHtmlArray.length) {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(pump, { timeout: 200 });
      else setTimeout(pump, 0);
    }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(pump, { timeout: 200 });
  else setTimeout(pump, 0);
  // Fast scrollers get the rest immediately at the scroll edge.
  container.onscroll = () => {
    if (container.scrollWidth - container.scrollLeft - container.clientWidth < 120) {
      while (rendered < cellHtmlArray.length) appendMore();
    }
  };
}
window.renderRoadCellsChunked = renderRoadCellsChunked;

// ── Fix round 2026-10-24: ball + sheet viewport clamping ──────────
// The floating ball (68px ring footprint + 32px prediction ball
// below the face = 106px tall) must never sit outside the viewport:
// clamped on load, on drag end, on resize and on orientation change.
// The module's window.__o101ClampBall (systems/orb-bridge.js) is the
// single source of truth when present; the inline math below is
// identical.
function clampBallRectFallback(rect) {
  // Fix round (face down, owner order 2026-10-27 ~12:00 IST): honour
  // the caller's topMargin (160 = below the PREDICTION WON banner zone
  // at top-14 + banner height, so the face is never covered by it);
  // the module clamp is the same math with the same parameter.
  const topMargin = Number.isFinite(rect.topMargin) ? rect.topMargin : 10;
  return {
    left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 68 - 8)),
    top: Math.min(Math.max(topMargin, rect.top), Math.max(topMargin, window.innerHeight - 106 - 12))
  };
}
function clampFloatingOrb() {
  const orb = $('dhaniwinFloatingOrb');
  if (!orb || orb.style.display === 'none') return;
  // Fix round (face down, owner order 2026-10-27 ~12:00 IST): the
  // 160px minimum top keeps the face below the PREDICTION WON banner
  // (fixed top-14) and fully inside the viewport — including a saved
  // top-right position restored from localStorage, which this clamp
  // pulls down into view on load. Ball-below-Axo (owner order
  // 2026-10-27): the 106px footprint covers the ring AND the 32px
  // ball below the face, so the ball stays in view too.
  const rect = orb.getBoundingClientRect();
  const clamp = window.__o101ClampBall || clampBallRectFallback;
  const next = clamp({ left: rect.left, top: rect.top, width: 68, height: 106, vw: window.innerWidth, vh: window.innerHeight, margin: 8, topMargin: 160, bottomMargin: 12 });
  orb.style.left = `${next.left}px`;
  orb.style.top = `${next.top}px`;
  orb.style.right = 'auto';
  orb.style.bottom = 'auto';
}
window.clampFloatingOrb = clampFloatingOrb;

// Bubble-tracks-Axo (owner order 2026-10-25): one rAF-throttled
// reposition queue shared by the orb drag, sheet drag, and sheet
// resize handlers, so the subtitle bubble follows Axo mid-gesture
// without a full sync (and its face re-render) on every move.
let __o101BubbleRepositionQueued = false;
function queueAxoBubbleReposition() {
  if (__o101BubbleRepositionQueued) return;
  __o101BubbleRepositionQueued = true;
  const run = () => {
    __o101BubbleRepositionQueued = false;
    if (window.__smartBall && typeof window.__smartBall.repositionAxoBubble === 'function') window.__smartBall.repositionAxoBubble();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else run();
}

// ── Pull-to-refresh (owner order 2026-10-25, Task C) ─────────────
// The owner could not refresh inside the app. Pulling down at the
// top of the main view shows a small spinner (no text) and, on
// release past the threshold, re-syncs live data:
//   1. syncMobileUserWallet() — posts DHANIWIN_REQUEST_SYNC to the
//      bridge, which clicks wallet refresh, scrapes DOM, and runs
//      its active wallet poll + session scrape (API-proven balance).
//   2. fetchLiveAPIResults(current timeframe) — the guarded live
//      history fetch (no-op while a fetch is already in flight).
// It NEVER reloads the document and NEVER touches governed session
// state: evaluated rounds (persisted model store), calibration
// records, ladder/session P&L, and the locked verdict all survive
// untouched, because neither leg resets anything — the history
// list itself is live data, replaced by fresh upstream rounds.
// Touch only (phone first): touches inside the DhaniWin iframe
// never reach this document, so a pull inside the game frame
// cannot trigger this — pull on the app's own views. Disabled
// while the assistant panel is open, and never hijacks taps on
// the orb, dock, sheet, resize handles, or form controls.
const O101_PULL_THRESHOLD = 64;
function refreshAppLiveData() {
  try { if (typeof syncMobileUserWallet === 'function') syncMobileUserWallet(); } catch (e) {}
  try {
    const p = fetchLiveAPIResults(MobileState.timeframe);
    return Promise.resolve(p).catch(() => {});
  } catch (e) { return Promise.resolve(); }
}
function initPullRefresh() {
  if (window.__o101PullRefreshInit) return;
  window.__o101PullRefreshInit = true;
  const spinner = document.getElementById('o101PullSpinner');
  if (!spinner) return;
  let pulling = false;
  let refreshing = false;
  let startY = 0;
  let startX = 0;
  let triggered = false;

  const visual = (dy) => {
    if (typeof window.__o101PullVisual === 'function') return window.__o101PullVisual(dy, O101_PULL_THRESHOLD);
    const pull = Math.max(0, dy || 0);
    const offset = Math.min(pull * 0.5, 56);
    return { offset, opacity: Math.min(1, offset / 56), shouldRefresh: pull >= O101_PULL_THRESHOLD };
  };
  const setSpinner = (offset, opacity, animate) => {
    spinner.style.transition = animate ? 'transform .22s ease, opacity .22s ease' : 'none';
    spinner.style.transform = `translate(-50%, ${offset}px)`;
    spinner.style.opacity = String(opacity);
    spinner.style.display = opacity > 0 ? 'flex' : 'none';
  };
  const modalOpen = () => {
    const modal = document.getElementById('dhaniwinAssistantModal');
    return !!(modal && !modal.classList.contains('hidden') && modal.classList.contains('sheet-open'));
  };
  const EXCLUDED = '#dhaniwinFloatingOrb, #dhaniwinAssistantModal, #mobileBottomDock, .assistant-resize-handle, button, a, input, select, textarea';

  document.addEventListener('touchstart', (e) => {
    if (refreshing || pulling || modalOpen()) return;
    if (window.scrollY !== 0) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    if (t.target && t.target.closest && t.target.closest(EXCLUDED)) return;
    pulling = true;
    triggered = false;
    startY = t.clientY;
    startX = t.clientX;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!pulling || refreshing) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const dy = t.clientY - startY;
    const dx = t.clientX - startX;
    if (Math.abs(dx) > Math.abs(dy)) { pulling = false; setSpinner(0, 0, true); return; }
    if (dy <= 0) { triggered = false; setSpinner(0, 0, false); return; }
    if (window.scrollY !== 0) { pulling = false; setSpinner(0, 0, true); return; }
    if (e.cancelable) e.preventDefault(); // suppress the browser's native pull-to-refresh while ours tracks
    const v = visual(dy);
    triggered = v.shouldRefresh;
    setSpinner(v.offset, v.opacity, false);
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!pulling) return;
    pulling = false;
    if (!triggered) { setSpinner(0, 0, true); return; }
    refreshing = true;
    setSpinner(44, 1, true);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      refreshing = false;
      setSpinner(0, 0, true);
    };
    // Spinner lifetime covers the history fetch plus a floor so the
    // bridge sync has a chance to land; bridge states re-render on
    // arrival after the spinner hides. Never spins forever.
    const minWait = new Promise(r => setTimeout(r, 600));
    Promise.all([refreshAppLiveData(), minWait]).then(finish);
    setTimeout(finish, 5000);
  }, { passive: true });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPullRefresh);
else initPullRefresh();

// Ball-below-Axo / auto-resize (owner order 2026-10-27): the opened
// sheet's top floor must clear the TOP-CENTER AVATAR, not just the
// sheet body. The avatar straddles the sheet's top edge
// (translate(-50%,-50%)): face 64px + name ~16px + badge ~16px ≈
// 99px tall, so ~50px overhangs above the sheet. The old 50px floor
// left the avatar's top at ~0 — touching (and on taller badge
// lines, clipped by) the viewport top edge. 64px leaves ≥14px of
// face clearance on every sheet path (clamp, open, preset, drag,
// resize) while the panel is open.
const AXO_SHEET_TOP_MIN = 64;

function clampAssistantSheetToViewport() {
  if (window.__assistantBoxBusy) return;
  const modal = $('dhaniwinAssistantModal');
  const sheet = $('dhaniwinAssistantSheet');
  if (!modal || !sheet) return;
  if (modal.classList.contains('hidden') || !modal.classList.contains('sheet-open')) return;
  const rect = sheet.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, rect.left));
  const top = Math.max(AXO_SHEET_TOP_MIN, Math.min(window.innerHeight - rect.height - 14, rect.top));
  sheet.style.left = `${left}px`;
  sheet.style.top = `${top}px`;
}
window.clampAssistantSheetToViewport = clampAssistantSheetToViewport;

// Task N: when the VIEWPORT shrinks (rotation, split screen), an
// open sheet taller than the viewport cap would strand its bottom
// rows off-screen — position clamping alone cannot fix that. Cap
// the height, then compact-fit tiers the content into the cap.
// This is the ONLY shrink path in the app: fitSheetToContent stays
// grow-only for user sizes (Task L premise intact), and this runs
// only on viewport resize/orientation, never mid-gesture (callers
// guard on __assistantBoxBusy).
function shrinkOpenSheetToViewport() {
  const modal = $('dhaniwinAssistantModal');
  const sheet = $('dhaniwinAssistantSheet');
  if (!modal || !sheet) return;
  if (modal.classList.contains('hidden') || !modal.classList.contains('sheet-open')) return;
  const cap = Math.max(220, window.innerHeight - 24);
  if ((sheet.offsetHeight || 0) <= cap) return;
  sheet.style.height = `${cap}px`;
  sheet.style.maxHeight = `${cap}px`;
  if (window.__smartBall && typeof window.__smartBall.fitSheetToContent === 'function') window.__smartBall.fitSheetToContent();
}
window.shrinkOpenSheetToViewport = shrinkOpenSheetToViewport;

function renderAssistantMiniRoad(list) {
  const container = $('assistantMiniRoad');
  if (!container || !list || list.length === 0) return;
  // FULL history, newest first — no count cap (fix round 2026-10-24).
  const display = [...list].reverse();
  const cells = display.map((r) => {
    const n = Number(r.number);
    let ballBg = 'ball-red';
    if (n === 0) ballBg = 'ball-split-0';
    else if (n === 5) ballBg = 'ball-split-5';
    else if (n === 1 || n === 3 || n === 7 || n === 9) ballBg = 'ball-green';

    const isWin = r.aiCorrect === true;
    const isLoss = r.aiCorrect === false;
    let badge = '';
    if (isWin) {
      badge = '<span class="absolute -bottom-1 -right-1 w-3 h-3 rounded-full bg-emerald-500 text-black text-[7px] font-black flex items-center justify-center">✓</span>';
    } else if (isLoss) {
      badge = '<span class="absolute -bottom-1 -right-1 w-3 h-3 rounded-full bg-rose-500 text-white text-[7px] font-black flex items-center justify-center">✗</span>';
    }

    return `<div class="relative flex flex-col items-center shrink-0">
      ${(window.ballImg && window.ballImg(n, 24, 'shadow-sm')) || `<div class="ball-3d ${ballBg} w-6 h-6 rounded-full flex items-center justify-center font-mono font-black text-[10px] text-white shadow-sm">
        ${n}
      </div>`}
      ${badge}
      <span class="text-[6.5px] font-mono text-zinc-500 mt-0.5">${String(r.period).slice(-3)}</span>
    </div>`;
  });
  renderRoadCellsChunked(container, cells);
}
window.renderAssistantMiniRoad = renderAssistantMiniRoad;

// ── 29c. Cinematic Apple Money Rain Celebration Overlay (Sleek, Fluid, Non-Intrusive) ─

let _moneyRainAnimId = null;
let _moneyRainTimeout = null;

function dismissAppleMoneyRain() {
  const container = $('appleMoneyRainContainer');
  if (container) {
    container.classList.add('hidden');
    container.style.opacity = '0';
  }
  if (_moneyRainAnimId) {
    cancelAnimationFrame(_moneyRainAnimId);
    _moneyRainAnimId = null;
  }
  if (_moneyRainTimeout) {
    clearTimeout(_moneyRainTimeout);
    _moneyRainTimeout = null;
  }
}
window.dismissAppleMoneyRain = dismissAppleMoneyRain;
window.dismissFullScreenWin = dismissAppleMoneyRain; // Legacy backward-compatibility

function triggerAppleMoneyRain(profit, streak, isWin = true) {
  dismissAppleMoneyRain();

  const container = $('appleMoneyRainContainer');
  const canvas = $('appleMoneyRainCanvas');
  const winTitle = $('appleMoneyWinTitle');
  const winBadge = $('appleMoneyWinBadge');
  const winPill = $('appleMoneyWinPill');
  const pillDot = $('appleMoneyPillDot');
  if (!container || !canvas) return;

  // Owner order 2026-10-30 ~01:21 IST: the dollar rain falls on LOSS
  // too (always on, top-down), not win-only anymore. Visual only —
  // the governed sound authority is untouched. The pill tints by
  // outcome so a loss never wears win-green.
  const amt = Number(profit);
  const pStr = isWin
    ? ((amt && amt > 0) ? `+₹${amt.toFixed(2)}` : '+₹2.00')
    : `-₹${(amt && amt > 0 ? amt : 0).toFixed(2)}`;
  const sStr = (isWin && streak > 1) ? ` • 🔥 ${streak}W` : '';
  if (winTitle) winTitle.textContent = isWin ? 'PREDICTION WON' : 'PREDICTION MISSED';
  if (winBadge) {
    winBadge.textContent = `${pStr}${sStr}`;
    winBadge.className = 'text-[10px] font-mono font-black px-2 py-0.5 rounded-full border ' +
      (isWin ? 'bg-emerald-500/25 text-emerald-300 border-emerald-500/40'
             : 'bg-rose-500/25 text-rose-300 border-rose-500/40');
  }
  if (winPill) {
    winPill.className = 'relative z-10 px-4 py-2 rounded-full bg-black/90 border flex items-center gap-2 transform scale-95 transition-all duration-300 pointer-events-auto cursor-pointer ' +
      (isWin ? 'border-emerald-500/40 shadow-[0_8px_32px_rgba(16,185,129,0.35)]'
             : 'border-rose-500/40 shadow-[0_8px_32px_rgba(244,63,94,0.35)]');
  }
  if (pillDot) {
    pillDot.className = 'w-2 h-2 rounded-full animate-pulse ' + (isWin ? 'bg-emerald-400' : 'bg-rose-400');
  }

  container.classList.remove('hidden');
  container.style.opacity = '1';

  // High-DPI canvas setup
  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Generate particles: realistic falling dollar bills (65%) and gold spinning coins (35%)
  const particles = [];
  const streakCount = Math.max(1, Number(streak) || 1);
  const baseCount = Math.min(36, Math.max(16, Math.floor(width / 11)));
  const numParticles = Math.min(120, Math.floor(baseCount + (streakCount - 1) * 8));

  for (let i = 0; i < numParticles; i++) {
    particles.push({
      type: Math.random() > 0.35 ? 'bill' : 'coin',
      x: Math.random() * width,
      y: -25 - Math.random() * (height * 0.7),
      vy: 2.2 + Math.random() * 3.2,
      vx: (Math.random() - 0.5) * 1.4,
      sway: 1.5 + Math.random() * 2.2,
      swaySpeed: 0.02 + Math.random() * 0.03,
      angle: Math.random() * Math.PI * 2,
      vAngle: (Math.random() - 0.5) * 0.06,
      w: 28 + Math.random() * 10,
      h: 15 + Math.random() * 6,
      r: 6 + Math.random() * 4,
      phase: Math.random() * Math.PI * 2,
      opacity: 0.88 + Math.random() * 0.12
    });
  }

  const startTime = Date.now();
  const DURATION = 3200;

  function renderFrame() {
    const elapsed = Date.now() - startTime;
    if (elapsed > DURATION) {
      dismissAppleMoneyRain();
      return;
    }

    let globalAlpha = 1;
    if (elapsed > DURATION - 700) {
      globalAlpha = (DURATION - elapsed) / 700;
    }

    ctx.clearRect(0, 0, width, height);

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.y += p.vy;
      p.x += Math.sin(p.phase) * p.sway + p.vx;
      p.phase += p.swaySpeed;
      p.angle += p.vAngle;

      ctx.save();
      ctx.globalAlpha = p.opacity * globalAlpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);

      if (p.type === 'bill') {
        // Draw crisp emerald banknote with subtle border
        ctx.fillStyle = '#065f46';
        ctx.strokeStyle = '#34d399';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(-p.w / 2, -p.h / 2, p.w, p.h, 3);
        } else {
          ctx.rect(-p.w / 2, -p.h / 2, p.w, p.h);
        }
        ctx.fill();
        ctx.stroke();

        ctx.strokeStyle = 'rgba(52, 211, 153, 0.6)';
        ctx.lineWidth = 0.8;
        ctx.strokeRect(-p.w / 2 + 2, -p.h / 2 + 2, p.w - 4, p.h - 4);

        ctx.fillStyle = '#a7f3d0';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('₹', 0, 0);
      } else {
        // Draw spinning gold coin
        ctx.fillStyle = '#f59e0b';
        ctx.strokeStyle = '#fde047';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(0, 0, p.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#78350f';
        ctx.font = 'bold 7px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('★', 0, 0);
      }

      ctx.restore();
    }

    _moneyRainAnimId = requestAnimationFrame(renderFrame);
  }

  _moneyRainAnimId = requestAnimationFrame(renderFrame);
}
window.triggerAppleMoneyRain = triggerAppleMoneyRain;
window.triggerFullScreenWinAnimation = triggerAppleMoneyRain; // Legacy backward-compatibility

// ── 29d. High-Confidence Push Notification (>60% Win Rate Alert) ─────────────

let _lastBestTimeNotifTime = 0;

function dismissOrRemoveBestTimeNotifCard() {
  const card = $('bestTimeNotifCard');
  if (card) {
    card.style.display = 'none';
    try { card.remove(); } catch(e) {}
  }
}
window.dismissOrRemoveBestTimeNotifCard = dismissOrRemoveBestTimeNotifCard;

async function requestBestTimeNotificationPermission() {
  if (!('Notification' in window)) {
    showToast('Push Notifications not supported on this device/browser', 'warn');
    return false;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      try { localStorage.setItem('best_time_notif_enabled', '1'); } catch(e) {}
      // Remove card from Analyse page immediately as requested
      dismissOrRemoveBestTimeNotifCard();
      showToast('🔔 High-Confidence alerts activated! We will notify you when Win Rate > 60%.', 'success');
      return true;
    } else {
      showToast('Notification permission was not granted.', 'info');
      return false;
    }
  } catch(e) {
    return false;
  }
}
window.requestBestTimeNotificationPermission = requestBestTimeNotificationPermission;

function checkAndSendBestTimeNotification(winRate, wins, total, tf) {
  const now = Date.now();
  if (now - _lastBestTimeNotifTime < 15 * 60 * 1000) return; // 15-minute cooldown
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    _lastBestTimeNotifTime = now;
    try {
      new Notification('🔥 01:01 High-Confidence Alert: Best Time to Bet!', {
        body: `AI Win Rate is currently ${winRate}% (${wins}/${total} wins) on WinGo ${tf.toUpperCase()}! Highly favorable conditions detected.`,
        icon: 'logo_0101.jpg',
        badge: 'logo_0101.jpg'
      });
    } catch(e) {}
  }
}
window.checkAndSendBestTimeNotification = checkAndSendBestTimeNotification;

// ── 30. Floating AssistiveTouch Circle Assistant & Draggable/Resizable Box Hub ──────────
let _assistantModalClosing = false;
let _assistantBoxPos = null;
let _assistantBoxSize = null;

// Apple Liquid Glass size presets
// Task K (owner order 2026-10-25): the compact preset used to be
// 230×280 — below the panel's then-340px content floor, so opening
// it would clip the no-scroll body. Compact is now 230×340: still
// the narrowest preset, tall enough for all four sections at tier
// 0. Task N keeps the preset heights: user resizes below them now
// compact instead of hitting a floor (see the resize path).
const ASSISTANT_SIZE_PRESETS = [
  { name: 'compact', width: 230, height: 340 },
  { name: 'normal',  width: 275, height: 360 },
  { name: 'large',   width: 325, height: 440 }
];

function cycleAssistantBoxSizePreset(e) {
  if (window.__assistantBoxBusy) return; // a drag/resize owns the sheet geometry right now
  if (e && e.stopPropagation) e.stopPropagation();
  const sheet = document.getElementById('dhaniwinAssistantSheet');
  if (!sheet) return;

  const curW = sheet.offsetWidth || 275;
  let nextPreset = ASSISTANT_SIZE_PRESETS[1]; // default to normal
  if (curW < 250) {
    nextPreset = ASSISTANT_SIZE_PRESETS[1]; // go normal
  } else if (curW < 300) {
    nextPreset = ASSISTANT_SIZE_PRESETS[2]; // go large
  } else {
    nextPreset = ASSISTANT_SIZE_PRESETS[0]; // go compact
  }

  const maxW = Math.max(200, window.innerWidth - 16);
  const maxH = Math.max(220, window.innerHeight - 60);
  // Task N: a preset floors only at the absolute 220px drag floor —
  // the old 340px content floor is gone. The compact fit
  // (fitSheetToContent, called below) tiers and grows to the
  // measured compacted need, so a preset never clips content and
  // a compact size stays compact. The viewport cap still wins on
  // short viewports.
  const contentFloor = 220;
  const targetW = Math.min(maxW, nextPreset.width);
  const targetH = Math.min(maxH, Math.max(contentFloor, nextPreset.height));

  sheet.style.transition = 'width 0.28s cubic-bezier(0.16, 1, 0.3, 1), height 0.28s cubic-bezier(0.16, 1, 0.3, 1), max-height 0.28s cubic-bezier(0.16, 1, 0.3, 1), transform 0.28s cubic-bezier(0.16, 1, 0.3, 1)';
  sheet.style.width = `${targetW}px`;
  sheet.style.height = `${targetH}px`;
  sheet.style.maxHeight = `${targetH}px`;
  // Task L: a preset must never clip content — grow to measured content if needed.
  if (window.__smartBall && typeof window.__smartBall.fitSheetToContent === 'function') window.__smartBall.fitSheetToContent();

  // Make sure it doesn't overflow screen bounds
  const rect = sheet.getBoundingClientRect();
  let left = rect.left;
  let top = rect.top;
  if (left + targetW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - targetW - 8);
  if (top + targetH > window.innerHeight - 12) top = Math.max(AXO_SHEET_TOP_MIN, window.innerHeight - targetH - 12);
  sheet.style.left = `${left}px`;
  sheet.style.top = `${top}px`;

  _assistantBoxSize = { width: targetW, height: targetH };
  _assistantBoxPos = { left, top };
  try {
    localStorage.setItem('dhaniwin_assistant_box_size', JSON.stringify(_assistantBoxSize));
    localStorage.setItem('dhaniwin_assistant_box_pos', JSON.stringify(_assistantBoxPos));
  } catch(err) {}
}
window.cycleAssistantBoxSizePreset = cycleAssistantBoxSizePreset;

function toggleDhaniwinAssistantModal(show) {
  if (window.__assistantBoxBusy) return; // never reposition the sheet mid-drag/resize
  const modal = $('dhaniwinAssistantModal');
  const sheet = $('dhaniwinAssistantSheet');
  const orb = $('dhaniwinFloatingOrb');
  if (!modal || !sheet) return;

  const isOpen = !modal.classList.contains('hidden') && modal.classList.contains('sheet-open') && modal.style.display !== 'none';
  const targetOpen = show === undefined ? !isOpen : Boolean(show);

  if (targetOpen) {
    _assistantModalClosing = false;

    // Restore saved custom size or fall back to responsive defaults
    if (!_assistantBoxSize) {
      try {
        const rawSize = localStorage.getItem('dhaniwin_assistant_box_size');
        if (rawSize) _assistantBoxSize = JSON.parse(rawSize);
      } catch(e) {}
    }
    // Owner order 2026-10-25 (UI batch): the panel opens SMALL by
    // default and the last resized size stays — the old path forced
    // minimums of 360×480, silently discarding a smaller saved size
    // on every reopen. resolveAxoPanelSize (orb-bridge, same rule,
    // one source of truth) with an inline fallback when the module
    // is absent.
    const _panelSize = (typeof window.__o101AxoPanelSize === 'function')
      ? window.__o101AxoPanelSize({ saved: _assistantBoxSize, vw: window.innerWidth, vh: window.innerHeight })
      : (function () {
          const maxW = Math.max(200, window.innerWidth - 16);
          const maxH = Math.max(220, window.innerHeight - 60);
          // Task N: same absolute floor as resolveAxoPanelSize
          // (orb-bridge) — the old 340px content floor is gone.
          // A saved compact size restores exactly; the post-open
          // compact fit grows to the measured compacted need when
          // content would otherwise clip. Inline fallback only;
          // the module rule wins whenever it is present.
          const contentFloor = 220;
          const num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null);
          const w = num(_assistantBoxSize && _assistantBoxSize.width);
          const h = num(_assistantBoxSize && _assistantBoxSize.height);
          return {
            width: Math.min(maxW, Math.max(200, w !== null ? w : 270)),
            height: Math.min(maxH, Math.max(contentFloor, h !== null ? h : 380))
          };
        })();
    const boxWidth = _panelSize.width;
    const boxHeight = _panelSize.height;

    // Fix round #4: the opened Axo is SMALL, Axofy-app pattern —
    // a circular avatar straddling the sheet's top-center edge,
    // never a giant overlay, never covering panel content. The
    // sheet's open class gives the header top clearance for the
    // name + prediction badge. Saved drag positions are ignored
    // on open (dragging after open still works); the size keeps
    // its saved value, clamped to the 200×220 absolute drag floor
    // (Task N: the old 340px content floor is gone — the post-open
    // compact fit grows to the measured compacted need instead).
    const orbRect = orb ? orb.getBoundingClientRect() : { left: window.innerWidth - 76, top: window.innerHeight - 150, width: 62, height: 62 };

    // Task G (owner order 2026-10-25): reopen starts from the ball's
    // LAST position — the window rests centered on the orb (not
    // viewport-centered), clamped to the same bounds the drag uses,
    // so the open morph travels from the ball to its own rest spot
    // and a close→reopen round-trip lands in the same place.
    const orbCenterX = orbRect.left + (orbRect.width || 62) / 2;
    const orbCenterY = orbRect.top + (orbRect.height || 62) / 2;
    const targetLeft = Math.max(8, Math.min(window.innerWidth - boxWidth - 8, Math.floor(orbCenterX - boxWidth / 2)));
    const targetTop = Math.max(AXO_SHEET_TOP_MIN, Math.min(window.innerHeight - boxHeight - 14, Math.floor(orbCenterY - boxHeight / 2)));

    // Task E: the window OPENS FROM the ball — it starts at the orb
    // rect (the ball's position and size) and animates rect + scale
    // to its rest rect, so it grows out of the ball's position. The
    // transition covers left/top/width/height for the travel; the
    // existing sheet-open scale/opacity morph composes on top.
    sheet.style.transition = 'left 0.28s cubic-bezier(0.16, 1, 0.3, 1), top 0.28s cubic-bezier(0.16, 1, 0.3, 1), width 0.28s cubic-bezier(0.16, 1, 0.3, 1), height 0.28s cubic-bezier(0.16, 1, 0.3, 1), max-height 0.28s cubic-bezier(0.16, 1, 0.3, 1), transform 0.32s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1), border-radius 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
    sheet.style.left = `${Math.floor(orbRect.left)}px`;
    sheet.style.top = `${Math.floor(orbRect.top)}px`;
    sheet.style.width = `${Math.floor(orbRect.width || 62)}px`;
    sheet.style.height = `${Math.floor(orbRect.height || 62)}px`;
    sheet.style.maxHeight = `${Math.floor(orbRect.height || 62)}px`;
    sheet.style.right = 'auto';
    sheet.style.bottom = 'auto';
    sheet.classList.add('axo-top-avatar-open');

    // The top-center avatar shows; the panel header carries no
    // face while open. The avatar is pointer-events none, so the
    // panel beneath stays fully interactive.
    const axoTop = $('axoTopAvatar');
    if (axoTop) axoTop.style.display = 'flex';
    const faceHost = $('axoFaceHost');
    if (faceHost) faceHost.style.display = 'none';

    // Calculate morph origin from ball center (morphs from the ball and back to the ball).
    // orbCenterX/Y were computed above for the ball-anchored rest rect (Task G).
    const originX = orbCenterX - targetLeft;
    const originY = orbCenterY - targetTop;
    sheet.style.transformOrigin = `${originX}px ${originY}px`;

    modal.classList.remove('hidden');
    modal.style.display = 'block';

    // Morph the orb: fade and shrink smoothly as the box expands
    if (orb) {
      orb.style.transition = 'transform 0.26s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease';
      orb.style.transform = 'scale(0.3)';
      orb.style.opacity = '0';
      orb.style.pointerEvents = 'none';
    }

    // Force browser reflow to guarantee smooth animation: the start
    // rect (at the ball) is flushed first, so the rest rect below
    // transitions instead of jumping.
    void sheet.offsetWidth;
    sheet.style.left = `${targetLeft}px`;
    sheet.style.top = `${targetTop}px`;
    sheet.style.width = `${boxWidth}px`;
    sheet.style.height = `${boxHeight}px`;
    sheet.style.maxHeight = `${boxHeight}px`;
    modal.classList.add('sheet-open');

    // The subtitle bubble stays outside the panel while it is open
    // (owner order 2026-10-25) — syncAxoSubtitleSurfaces anchors
    // it next to the top-center avatar.
    if (window.__smartBall && typeof window.__smartBall.syncAxoSubtitleSurfaces === 'function') window.__smartBall.syncAxoSubtitleSurfaces();

    // Bubble-tracks-Axo: the sheet morphs open — reposition once
    // it settles, so the bubble follows the avatar to its rest spot.
    // Task L: also fit the sheet to its measured content, so the
    // chip row can never be clipped by the resolved height.
    // Ball-below-Axo (owner order 2026-10-27): the open-settle path
    // re-clamps the sheet too — a fit that grows the sheet must
    // never strand the avatar (or the sheet) off-viewport after an
    // auto-resize / expand-compact transition.
    try {
      sheet.addEventListener('transitionend', function onSheetOpenSettled() { if (window.__smartBall && typeof window.__smartBall.repositionAxoBubble === 'function') window.__smartBall.repositionAxoBubble(); if (window.__smartBall && typeof window.__smartBall.fitSheetToContent === 'function') window.__smartBall.fitSheetToContent(); if (typeof clampAssistantSheetToViewport === 'function') clampAssistantSheetToViewport(); }, { once: true });
    } catch (e) {}

    // Update mini road on open
    const history = MobileState.historyByTf[MobileState.timeframe] || [];
    renderAssistantMiniRoad(history);
  } else {
    if (_assistantModalClosing) return;
    _assistantModalClosing = true;
    // Task G (owner order 2026-10-25): the ball takes the window's
    // LAST position — the orb glides to the sheet's last center
    // (clamped to the viewport, same 68×106 footprint the orb drag
    // uses) and that spot persists, so reopen starts there. The
    // collapse pivot moves to the new ball center BEFORE the
    // sheet-open class drops, so the window collapses into the
    // ball instead of toward its stale open-time origin.
    if (orb) {
      const sheetRect = sheet.getBoundingClientRect();
      const clamp = window.__o101ClampBall || clampBallRectFallback;
      const ballSpot = clamp({ left: sheetRect.left + sheetRect.width / 2 - 34, top: sheetRect.top + sheetRect.height / 2 - 53, width: 68, height: 106, vw: window.innerWidth, vh: window.innerHeight, margin: 8, topMargin: 160, bottomMargin: 12 });
      const ballCenterX = ballSpot.left + 34;
      const ballCenterY = ballSpot.top + 53;
      sheet.style.transformOrigin = `${ballCenterX - sheetRect.left}px ${ballCenterY - sheetRect.top}px`;
      orb.style.pointerEvents = 'auto';
      orb.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.24s ease, left 0.3s cubic-bezier(0.16, 1, 0.3, 1), top 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
      orb.style.left = `${ballSpot.left}px`;
      orb.style.top = `${ballSpot.top}px`;
      orb.style.right = 'auto';
      orb.style.bottom = 'auto';
      orb.style.transform = 'scale(1)';
      orb.style.opacity = '1';
      try {
        localStorage.setItem('dhaniwin_orb_pos', JSON.stringify({ left: ballSpot.left, top: ballSpot.top }));
      } catch (err) {}
    }
    modal.classList.remove('sheet-open');
    sheet.classList.remove('axo-top-avatar-open');

    // Panel closing: the top-center avatar goes away and the
    // header face returns, so the closed ball is Axo again.
    const axoTopClose = $('axoTopAvatar');
    if (axoTopClose) axoTopClose.style.display = 'none';
    const faceHostClose = $('axoFaceHost');
    if (faceHostClose) faceHostClose.style.display = '';

    setTimeout(() => {
      if (_assistantModalClosing) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
        _assistantModalClosing = false;
        // Panel fully closed: the floating subtitle may show again.
        if (window.__smartBall && typeof window.__smartBall.syncAxoSubtitleSurfaces === 'function') window.__smartBall.syncAxoSubtitleSurfaces();
        // Bubble-tracks-Axo: the orb morphs back over 0.3s —
        // reposition when it settles on its rest rect.
        try {
          if (orb) orb.addEventListener('transitionend', function onOrbCloseSettled() { if (window.__smartBall && typeof window.__smartBall.repositionAxoBubble === 'function') window.__smartBall.repositionAxoBubble(); }, { once: true });
        } catch (e) {}
      }
    }, 280);
  }
}
window.toggleDhaniwinAssistantModal = toggleDhaniwinAssistantModal;

// ── Draggable & Resizable Box Setup: Users can freely move & resize the assistant box ──
function initDhaniwinAssistantSheetDrag() {
  const header = document.getElementById('assistantSheetHeader');
  const sheet = document.getElementById('dhaniwinAssistantSheet');
  if (!header || !sheet) return;

  // Restore saved box position & size if present
  try {
    const rawPos = localStorage.getItem('dhaniwin_assistant_box_pos');
    if (rawPos) _assistantBoxPos = JSON.parse(rawPos);
    const rawSize = localStorage.getItem('dhaniwin_assistant_box_size');
    if (rawSize) _assistantBoxSize = JSON.parse(rawSize);
  } catch(e) {}

  // 1. HEADER DRAG LOGIC (Moving the box around)
  let isDraggingBox = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragInitialLeft = 0;
  let dragInitialTop = 0;

  const onDragDown = (e) => {
    // If user clicked buttons or resize handles, ignore header drag
    if (e.target.closest('button, .assistant-resize-handle')) return;
    isDraggingBox = true;
    window.__assistantBoxBusy = true;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragStartX = clientX;
    dragStartY = clientY;

    const rect = sheet.getBoundingClientRect();
    dragInitialLeft = rect.left;
    dragInitialTop = rect.top;
    sheet.style.transition = 'none';
  };

  const onDragMove = (e) => {
    if (!isDraggingBox) return;
    if (e.cancelable) e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;

    const boxWidth = sheet.offsetWidth || 270;
    const boxHeight = sheet.offsetHeight || 360;
    const newLeft = Math.max(8, Math.min(window.innerWidth - boxWidth - 8, dragInitialLeft + dx));
    const newTop = Math.max(AXO_SHEET_TOP_MIN, Math.min(window.innerHeight - boxHeight - 14, dragInitialTop + dy));

    sheet.style.left = `${newLeft}px`;
    sheet.style.top = `${newTop}px`;
    // Bubble-tracks-Axo: the top avatar rides the sheet's top edge.
    queueAxoBubbleReposition();
  };

  const onDragUp = () => {
    if (!isDraggingBox) return;
    isDraggingBox = false;
    window.__assistantBoxBusy = false;
    sheet.style.transition = 'transform 0.32s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1), border-radius 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
    const rect = sheet.getBoundingClientRect();
    _assistantBoxPos = { left: rect.left, top: rect.top };
    try {
      localStorage.setItem('dhaniwin_assistant_box_pos', JSON.stringify(_assistantBoxPos));
    } catch(err) {}
    queueAxoBubbleReposition();
  };

  header.addEventListener('touchstart', onDragDown, { passive: true });
  window.addEventListener('touchmove', onDragMove, { passive: false });
  window.addEventListener('touchend', onDragUp, { passive: true });

  header.addEventListener('mousedown', onDragDown);
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragUp);

  // Task G (owner order 2026-10-25): the AI is a drag handle — a
  // press-and-drag on the top avatar moves the whole window, using
  // exactly the header-drag machinery above. A tap without movement
  // starts and ends the drag with no move, so it does nothing (the
  // avatar has no tap action). Resize keeps its own zones: the
  // avatar's z-index beats the top-edge handle only inside the
  // avatar's own rect; edges/corners outside it still resize.
  const axoAvatar = document.getElementById('axoTopAvatar');
  if (axoAvatar) {
    axoAvatar.addEventListener('touchstart', onDragDown, { passive: true });
    axoAvatar.addEventListener('mousedown', onDragDown);
  }

  // 2. APPLE-LIKE INTERACTIVE RESIZE LOGIC (Touching in the edge or corner makes it bigger/smaller)
  let isResizing = false;
  let activeResizeDir = '';
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartW = 0;
  let resizeStartH = 0;
  let resizeStartL = 0;
  let resizeStartT = 0;

  const MIN_WIDTH = 200;
  const MIN_HEIGHT = 220;

  const onResizeStart = (dir, e) => {
    isResizing = true;
    window.__assistantBoxBusy = true;
    activeResizeDir = dir;
    sheet.classList.add('assistant-sheet-resizing');

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    resizeStartX = clientX;
    resizeStartY = clientY;

    const rect = sheet.getBoundingClientRect();
    resizeStartW = rect.width;
    resizeStartH = rect.height;
    resizeStartL = rect.left;
    resizeStartT = rect.top;

    sheet.style.transition = 'none';
    if (e.stopPropagation) e.stopPropagation();
    if (e.cancelable) e.preventDefault();
  };

  const onResizeMove = (e) => {
    if (!isResizing) return;
    if (e.cancelable) e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - resizeStartX;
    const dy = clientY - resizeStartY;

    const maxWidth = window.innerWidth - 16;
    const maxHeight = window.innerHeight - 60;
    // Task N (owner order 2026-10-26, "resizable to any size"): the
    // gesture floor is the plain 220px drag floor — the old 340px
    // content floor is GONE, so a resize may shrink to any size.
    // Fit is earned by compaction, not by blocking the gesture:
    // the live band below tightens the layout during the drag
    // (cheap, no measurement), and the settle pass on resize end
    // (fitSheetToContent: tier by measurement, then grow to the
    // measured compacted need) lands the sheet at the smallest
    // fully-visible size instead of clipping. Width keeps the
    // plain 200 drag floor; narrow widths tighten control padding
    // via the narrow flag (never a wrap, never a hidden control).
    const minH = MIN_HEIGHT;

    // Task N live-drag band mirror — same bands as the module's
    // AXO_COMPACT_BANDS (orb-bridge cannot be imported here):
    // ≥340 → 0, ≥300 → 1, ≥265 → 2, else 3. Approximation only;
    // the settle pass measures and corrects.
    const axoCompactBandMirror = (h) => (h >= 340 ? 0 : h >= 300 ? 1 : h >= 265 ? 2 : 3);

    let newW = resizeStartW;
    let newH = resizeStartH;
    let newL = resizeStartL;
    let newT = resizeStartT;

    // Horizontal adjustments
    if (activeResizeDir.includes('r')) {
      newW = Math.max(MIN_WIDTH, Math.min(maxWidth - resizeStartL, resizeStartW + dx));
    } else if (activeResizeDir.includes('l')) {
      const prospectiveW = resizeStartW - dx;
      if (prospectiveW >= MIN_WIDTH) {
        newW = prospectiveW;
        newL = Math.max(8, resizeStartL + dx);
      } else {
        newW = MIN_WIDTH;
        newL = resizeStartL + (resizeStartW - MIN_WIDTH);
      }
    }

    // Vertical adjustments
    if (activeResizeDir.includes('b')) {
      newH = Math.max(minH, Math.min(maxHeight - resizeStartT, resizeStartH + dy));
    } else if (activeResizeDir.includes('t')) {
      const prospectiveH = resizeStartH - dy;
      if (prospectiveH >= minH) {
        newH = prospectiveH;
        newT = Math.max(AXO_SHEET_TOP_MIN, resizeStartT + dy);
      } else {
        newH = minH;
        newT = resizeStartT + (resizeStartH - minH);
      }
    }

    // Apply dimensions to widget
    sheet.style.width = `${Math.round(newW)}px`;
    sheet.style.height = `${Math.round(newH)}px`;
    sheet.style.maxHeight = `${Math.round(newH)}px`;
    sheet.style.left = `${Math.round(newL)}px`;
    sheet.style.top = `${Math.round(newT)}px`;
    // Task N: live compaction during the gesture (band mirror, no
    // measurement) + narrow flag, so content tightens as the user
    // shrinks instead of clipping mid-drag. The settle pass on
    // resize end measures and corrects the tier.
    sheet.dataset.axoCompact = String(axoCompactBandMirror(newH));
    sheet.dataset.axoNarrow = newW < 240 ? '1' : '0';
    // Bubble-tracks-Axo: top/left-edge resizes move the avatar.
    queueAxoBubbleReposition();
  };

  const onResizeEnd = () => {
    if (!isResizing) return;
    isResizing = false;
    window.__assistantBoxBusy = false;
    sheet.classList.remove('assistant-sheet-resizing');
    sheet.style.transition = 'transform 0.32s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1), border-radius 0.3s cubic-bezier(0.16, 1, 0.3, 1)';

    // Task L + Task N: settle FIRST (tier by measurement, then grow
    // to the measured compacted need), then persist the SETTLED
    // rect — persisting before the settle would save a size the
    // sheet immediately grows out of, so reopen would restore a
    // clipping size and grow again on every open.
    if (window.__smartBall && typeof window.__smartBall.fitSheetToContent === 'function') window.__smartBall.fitSheetToContent();

    const rect = sheet.getBoundingClientRect();
    _assistantBoxSize = { width: Math.round(rect.width), height: Math.round(rect.height) };
    _assistantBoxPos = { left: Math.round(rect.left), top: Math.round(rect.top) };

    try {
      localStorage.setItem('dhaniwin_assistant_box_size', JSON.stringify(_assistantBoxSize));
      localStorage.setItem('dhaniwin_assistant_box_pos', JSON.stringify(_assistantBoxPos));
    } catch(err) {}
    queueAxoBubbleReposition();
  };

  // Bind handles
  const handles = sheet.querySelectorAll('.assistant-resize-handle');
  handles.forEach(h => {
    const dir = h.dataset.resize;
    if (!dir) return;

    h.addEventListener('touchstart', (e) => onResizeStart(dir, e), { passive: false });
    h.addEventListener('mousedown', (e) => onResizeStart(dir, e));
  });

  window.addEventListener('touchmove', onResizeMove, { passive: false });
  window.addEventListener('touchend', onResizeEnd, { passive: true });
  window.addEventListener('mousemove', onResizeMove);
  window.addEventListener('mouseup', onResizeEnd);
}
window.initDhaniwinAssistantSheetDrag = initDhaniwinAssistantSheetDrag;

let _dhaniwinTrueFullscreen = false;
function toggleDhaniWinTrueFullscreen() {
  _dhaniwinTrueFullscreen = !_dhaniwinTrueFullscreen;
  const dock = $('mobileBottomDock');
  const webSection = $('tab-web');
  const btn = $('btnTrueFullscreenToggle');

  if (_dhaniwinTrueFullscreen) {
    if (dock) dock.style.display = 'none';
    if (webSection) webSection.style.bottom = '0px';
    if (btn) {
      btn.textContent = '📱 Dock View';
      btn.className = 'flex-1 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold';
    }
    showToast('DhaniWin in True Fullscreen. Tap floating circle to return dock.', 'info');
  } else {
    if (dock) dock.style.display = 'block';
    if (webSection) webSection.style.bottom = '74px';
    if (btn) {
      btn.textContent = '📺 Full View';
      btn.className = 'flex-1 py-1 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 font-bold';
    }
  }
}
window.toggleDhaniWinTrueFullscreen = toggleDhaniWinTrueFullscreen;

function updateFloatingOrbUI() {
  const orb = $('dhaniwinFloatingOrb');
  if (!orb) return;

  const gate = MobileState.predictionGate || checkPredictionGateStatus(MobileState.timeframe, MobileState.historyByTf[MobileState.timeframe]);
  const isGateReady = gate.ready;

  // Governed verdict owns the ball's pick pill whenever the bridge
  // has published a lock (orb-bridge renderAxoOrb): the native
  // prediction must never overwrite Axo's governed pick. Without a
  // lock, the native prediction is the fallback text only — never a
  // className overwrite (the pill's positioning classes are sacred)
  // and never an emoji or glow (matte Axo ball).
  const pingEl = $('floatingOrbDotPing');
  const dotEl = $('floatingOrbDot');
  if (!window.__o101Verdict) {
    // Fix round (ball-only): even the no-governor fallback shows
    // only the ball, never verdict text — ballImg serves digits and
    // letter keys alike; text remains only if no ball renderer
    // exists (never a blank). Ball-below-Axo (owner order
    // 2026-10-27): 32px, matching the governed writer.
    const target = MobileState.activePrediction?.target || 'BIG';
    const targetEl = $('floatingOrbTarget');
    if (targetEl) {
      const ballHtml = (typeof window.ballImg === 'function') ? window.ballImg(String(target).toUpperCase(), 32, '') : '';
      if (ballHtml) {
        targetEl.innerHTML = ballHtml;
      } else {
        targetEl.textContent = target;
        targetEl.style.color = target === 'SMALL' ? '#bae6fd' : '#fde68a';
      }
    }
  }

  if (pingEl && dotEl) {
    if (isGateReady) {
      pingEl.className = 'absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-black animate-ping';
      dotEl.className = 'absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-black';
    } else {
      pingEl.className = 'hidden';
      dotEl.className = 'absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-amber-400 border-2 border-black';
    }
  }

  // The orb becomes visible on tab switch — clamp then, too, so a
  // restored position can never sit half off an edge on first sight.
  clampFloatingOrb();
  // Bubble-tracks-Axo: a clamp can move the orb — follow it.
  if (window.__smartBall && typeof window.__smartBall.repositionAxoBubble === 'function') window.__smartBall.repositionAxoBubble();
}
window.updateFloatingOrbUI = updateFloatingOrbUI;

function setupFloatingOrb() {
  const orb = $('dhaniwinFloatingOrb');
  if (!orb) return;

  // Restore saved position if available, then clamp: a position
  // saved on a wider viewport (or before the browser chrome settled)
  // must never leave the ball half off an edge. The same clamp runs
  // on resize / orientation change below.
  try {
    const rawPos = localStorage.getItem('dhaniwin_orb_pos');
    if (rawPos) {
      const pos = JSON.parse(rawPos);
      if (typeof pos.left === 'number' && typeof pos.top === 'number') {
        orb.style.left = `${pos.left}px`;
        orb.style.top = `${pos.top}px`;
        orb.style.right = 'auto';
        orb.style.bottom = 'auto';
      }
    }
  } catch(e) {}
  clampFloatingOrb();
  if (!window.__o101OrbClampListeners) {
    window.__o101OrbClampListeners = true;
    window.addEventListener('resize', () => { clampFloatingOrb(); clampAssistantSheetToViewport(); if (window.__smartBall && typeof window.__smartBall.syncAxoSubtitleSurfaces === 'function') window.__smartBall.syncAxoSubtitleSurfaces(); if (!window.__assistantBoxBusy) shrinkOpenSheetToViewport(); });
    window.addEventListener('orientationchange', () => {
      setTimeout(() => { clampFloatingOrb(); clampAssistantSheetToViewport(); if (window.__smartBall && typeof window.__smartBall.syncAxoSubtitleSurfaces === 'function') window.__smartBall.syncAxoSubtitleSurfaces(); if (!window.__assistantBoxBusy) shrinkOpenSheetToViewport(); }, 300);
    });
  }

  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let hasMoved = false;

  function onPointerDown(e) {
    isDragging = true;
    hasMoved = false;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startX = clientX;
    startY = clientY;

    const rect = orb.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    orb.style.transition = 'none';
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - startX;
    const dy = clientY - startY;

    // Small threshold (4px) to distinguish a crisp tap from an intentional move
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      hasMoved = true;
      if (e.cancelable && e.preventDefault) e.preventDefault();
      // Drag stays bounded: the ball can never leave the viewport.
      const clamp = window.__o101ClampBall || clampBallRectFallback;
      const next = clamp({ left: startLeft + dx, top: startTop + dy, width: 68, height: 106, vw: window.innerWidth, vh: window.innerHeight, margin: 8, topMargin: 160, bottomMargin: 12 });
      orb.style.left = `${next.left}px`;
      orb.style.top = `${next.top}px`;
      orb.style.right = 'auto';
      orb.style.bottom = 'auto';
      // Bubble-tracks-Axo: the subtitle follows the ball mid-drag.
      queueAxoBubbleReposition();
    }
  }

  function onPointerUp(e) {
    if (!isDragging) return;
    isDragging = false;
    orb.style.transition = 'transform 0.2s ease, left 0.3s cubic-bezier(0.25, 1, 0.5, 1), top 0.3s cubic-bezier(0.25, 1, 0.5, 1)';

    // Crisp single tap immediately toggles assistant modal without needing long-press
    if (!hasMoved) {
      if (e && e.stopPropagation) e.stopPropagation();
      toggleDhaniwinAssistantModal(true);
      return;
    }

    // Magnetic edge snap (left or right), still fully inside: the
    // right snap accounts for the 68px ring + 8px margin, and the
    // top clamp for the 106px footprint (ring + ball below) + margin.
    const rect = orb.getBoundingClientRect();
    const midX = window.innerWidth / 2;
    const clamp = window.__o101ClampBall || clampBallRectFallback;
    const snapped = clamp({ left: rect.left < midX ? 12 : window.innerWidth - 76, top: rect.top, width: 68, height: 106, vw: window.innerWidth, vh: window.innerHeight, margin: 8, topMargin: 160, bottomMargin: 12 });
    const targetLeft = snapped.left;
    const targetTop = snapped.top;

    orb.style.left = `${targetLeft}px`;
    orb.style.top = `${targetTop}px`;
    orb.style.right = 'auto';
    orb.style.bottom = 'auto';

    try {
      localStorage.setItem('dhaniwin_orb_pos', JSON.stringify({ left: targetLeft, top: targetTop }));
    } catch(err) {}

    // Bubble-tracks-Axo: reposition now at the snap target, and
    // once more when the 0.3s snap slide settles on the ball.
    queueAxoBubbleReposition();
    try {
      orb.addEventListener('transitionend', function onOrbSnapSettled() { queueAxoBubbleReposition(); }, { once: true });
    } catch (e) {}
  }

  orb.addEventListener('touchstart', onPointerDown, { passive: true });
  window.addEventListener('touchmove', onPointerMove, { passive: false });
  window.addEventListener('touchend', onPointerUp, { passive: true });

  orb.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);

  initDhaniwinAssistantSheetDrag();
  updateFloatingOrbUI();
}
window.setupFloatingOrb = setupFloatingOrb;

function dismissMinimalLoader() {
  const loader = $('appleMinimalLoader') || document.getElementById('appleMinimalLoader');
  if (loader && !loader.classList.contains('hidden') && loader.style.display !== 'none') {
    loader.style.opacity = '0';
    loader.style.pointerEvents = 'none';
    setTimeout(() => {
      loader.classList.add('hidden');
      loader.style.display = 'none';
    }, 280);
  }
}
window.dismissMinimalLoader = dismissMinimalLoader;

function switchToPCMode() {
  try {
    localStorage.setItem('quant_preferred_view', 'pc');
    sessionStorage.setItem('quant_force_pc', '1');
  } catch(e) {}
  window.location.href = 'index.html?mode=pc';
}
window.switchToPCMode = switchToPCMode;

let _mobileInitCalled = false;
function initMobileApp() {
  if (_mobileInitCalled) return;
  _mobileInitCalled = true;

  console.log('[Mobile] 01:01 initializing...');

  // Phase 3D quarantine release (owner order 2026-10-27): clear any
  // legacy quant_model_quarantine_<tf> stores so previously
  // quarantined models return to eligibility immediately. The
  // engine also clears on script load; this is the belt-and-braces
  // call at app boot (and the testable path).
  try {
    if (typeof ModelQuarantineEngine !== 'undefined' && typeof ModelQuarantineEngine.clearLegacyStores === 'function') {
      ModelQuarantineEngine.clearLegacyStores();
    }
  } catch (e) {}

  // Initialize Web Worker Compute Engine
  try { initModelWorker(); } catch(e) { console.warn('[Mobile] Worker init error:', e); }

  // Initialize DhaniWin Real Loss Recovery & Pre-Fill Bridge
  try { initMobileDhaniWinBridge(); } catch(e) { console.warn('[Mobile] Bridge init error:', e); }

  // Restore settings
  try {
    MobileState.soundEnabled = localStorage.getItem('quant_sound') !== '0';
    MobileState.axoVoiceEnabled = localStorage.getItem('o101_axo_voice') !== '0';
    MobileState.axoMode = localStorage.getItem('o101_axo_mode') === 'normal' ? 'normal' : 'ai';
    updateSoundMuteUI();
    MobileState.hapticsEnabled = localStorage.getItem('quant_haptics') !== '0';
    MobileState.autoMode = localStorage.getItem('quant_arena_auto') !== '0';
    MobileState.chartMode = localStorage.getItem('quant_chart_mode') || 'candles';
  } catch(e) {}

  // Backup wiring for the Axo voice mute button (axoVoiceChip): the inline
  // onclick="window.__smartBall.toggleAxoVoice()" is the primary path. This
  // listener is a fallback for mobile browsers where inline handlers fail,
  // plus it shows a toast so the user gets clear feedback.
  try {
    const voiceChip = document.getElementById('axoVoiceChip');
    if (voiceChip && !voiceChip.dataset.voiceBackupWired) {
      voiceChip.dataset.voiceBackupWired = '1';
      voiceChip.addEventListener('click', function() {
        setTimeout(function() {
          try {
            const hasHandler = window.__smartBall && typeof window.__smartBall.toggleAxoVoice === 'function';
            if (!hasHandler) {
              // Fallback: toggle directly when __smartBall isn't available.
              const wasMuted = localStorage.getItem('o101_axo_voice') === '0';
              localStorage.setItem('o101_axo_voice', wasMuted ? '1' : '0');
              if (!wasMuted) {
                try { if (window.speechSynthesis) { window.speechSynthesis.cancel(); } } catch (e) {}
              }
              if (window.__smartBall && typeof window.__smartBall.refreshAxoVoiceChip === 'function') {
                window.__smartBall.refreshAxoVoiceChip();
              } else {
                // Direct visual update if refresh isn't available.
                const icon = document.getElementById('axoVoiceChipIcon');
                const nowMuted = !wasMuted;
                if (icon) icon.className = 'fa-solid ' + (nowMuted ? 'fa-volume-xmark' : 'fa-volume-high') + ' pointer-events-none';
                voiceChip.classList.toggle('text-emerald-300', !nowMuted);
                voiceChip.classList.toggle('text-rose-300', nowMuted);
                voiceChip.classList.toggle('opacity-60', nowMuted);
                voiceChip.setAttribute('aria-pressed', nowMuted ? 'false' : 'true');
              }
            }
            const muted = localStorage.getItem('o101_axo_voice') === '0';
            if (typeof showToast === 'function') {
              showToast(muted ? 'Axo voice muted' : 'Axo voice on', muted ? 'warn' : 'info');
            }
          } catch (err) {}
        }, 60);
      });
    }
  } catch (e) {}

  // Update Prediction Engine & Incharge UI
  updatePredictionSourceUI();

  // Hydrate 24-hour rolling history in background
  ['30s', '1m', '3m', '5m'].forEach(tf => {
    hydrate24HourHistory(tf);
  });

  // Load cached history from localStorage, sanitizing past fake prediction stamps on refresh/reopening
  ['30s', '1m', '3m', '5m'].forEach(tf => {
    try {
      const raw = localStorage.getItem(`quant_history_${tf}`);
      if (raw) {
        const cached = JSON.parse(raw);
        if (Array.isArray(cached) && cached.length > 0) {
          // Keep real lottery draw outcomes, but remove past fake predictions so fresh session starts clean
          MobileState.historyByTf[tf] = cached.map(r => ({
            period: r.period,
            number: r.number,
            size: r.size,
            color: r.color,
            result: null,
            aiTarget: null,
            aiType: null,
            aiCorrect: null
          }));
        }
      }
    } catch(e) {}
  });

  // Apply any pending cloud data (from RTDB listeners that fired before mobile.js was ready)
  if (window._pendingCloudHistory) {
    Object.entries(window._pendingCloudHistory).forEach(([tfKey, val]) => {
      applyCloudHistory(tfKey, val);
    });
  }
  if (window._pendingUniversalCloudState) {
    Object.entries(window._pendingUniversalCloudState).forEach(([tfKey, state]) => {
      applyUniversalCloudState(tfKey, state);
    });
  }

  // Restart accuracy audit fresh at 0 on every page refresh/reopening across all intervals
  ['30s', '1m', '3m', '5m'].forEach(tf => {
    const cached = MobileState.historyByTf[tf] || [];
    const latestP = cached.length > 0 ? String(cached[cached.length - 1].period) : 'RELOAD_INIT';
    if (!MobileState.auditResetPeriod) MobileState.auditResetPeriod = {};
    MobileState.auditResetPeriod[tf] = latestP;
    try { localStorage.setItem(`wingo_audit_reset_${tf}`, latestP); } catch(e) {}

    if (window.TimeframeManager) {
      if (typeof window.TimeframeManager.setHistory === 'function' && cached.length > 0) {
        try { window.TimeframeManager.setHistory(tf, cached); } catch(e) {}
      }
      if (typeof window.TimeframeManager.resetAudit === 'function') {
        try { window.TimeframeManager.resetAudit(tf, latestP); } catch(e) {}
      }
    }
  });

  // Initialize chart & views
  setTimeout(() => {
    initChart();
    // Restore history view preference
    try {
      const savedHistView = localStorage.getItem('quant_mobile_hist_view');
      if (savedHistView === 'graph') {
        switchMobileHistoryView('graph');
      }
    } catch(e) {}
    // Initial render for default timeframe
    const tf = MobileState.timeframe;
    const initialList = MobileState.historyByTf[tf] || [];
    if (initialList.length > 0) {
      renderPredictionAudit(initialList);
      renderHistoryTable(initialList);
      renderMobileHistoryGraph(initialList);
      renderDigitFrequencies(initialList);
      renderChartData(initialList);
      renderAdaptiveAI(initialList);
      renderAuthoritativeAIPrediction(initialList);
      renderModelRosterUI();
    }

    const btnReset = $('btnResetMobileAudit');
    if (btnReset) {
      btnReset.addEventListener('click', (e) => {
        e.preventDefault();
        resetMobileAudit(e);
      });
      btnReset.addEventListener('touchend', (e) => {
        e.preventDefault();
        resetMobileAudit(e);
      }, { passive: false });
    }
  }, 200);

  // Start IST clock (polls every 500ms)
  updateISTClock();
  _istClockInterval = setInterval(updateISTClock, 500);

  // ── Smart boundary polling: only poll active timeframe; re-polls at round boundaries
  // This eliminates the 3s × 4 timeframe background spam (was ~115k req/day → now ~3k/day)
  const POLL_INTERVAL_ACTIVE = 8000;  // Poll active TF every 8s (not 3s) — much lighter
  let _smartPollTimer = null;

  function _startSmartPoll(tf) {
    if (_smartPollTimer) clearInterval(_smartPollTimer);
    fetchLiveAPIResults(tf);
    _smartPollTimer = setInterval(() => {
      fetchLiveAPIResults(MobileState.timeframe);
    }, POLL_INTERVAL_ACTIVE);
    MobileState.pollIntervalIds[tf] = _smartPollTimer;
  }

  // Patch setMobileTimeframe to restart poll on tab switch
  const _origSetTf = window.setMobileTimeframe;
  window.setMobileTimeframe = function(tf) {
    if (_origSetTf) _origSetTf(tf);
    _startSmartPoll(tf);
  };

  // Initial fetch for active timeframe only (staggered 200ms)
  setTimeout(() => _startSmartPoll(MobileState.timeframe), 200);

  // Seed Pattern Intelligence with any already-loaded history for all timeframes
  setTimeout(() => {
    ['30s', '1m', '3m', '5m'].forEach(tf => {
      const list = MobileState.historyByTf[tf] || [];
      if (list.length > 0 && window.PatternIntelligence) {
        try { window.PatternIntelligence.startBackfill(tf, list); } catch(e) {}
      }
    });
  }, 3000);

  // Register global applyCloudHistory / applyUniversalCloudState as window functions
  window.applyCloudHistory = applyCloudHistory;
  window.applyUniversalCloudState = applyUniversalCloudState;

  // Expose generateModelNextPrediction shim using QuantAlgorithm
  if (!window.generateModelNextPrediction) {
    window.generateModelNextPrediction = function(model, history) {
      if (!model) return null;
      // Use model's own predict function if defined
      if (typeof model.predict === 'function') {
        try { return model.predict(history || [], []); } catch(e) {}
      }
      // Use QuantAlgorithm fallback
      if (window.QuantAlgorithm && typeof window.QuantAlgorithm.predictNextBet === 'function' && history && history.length >= 5) {
        try {
          const out = window.QuantAlgorithm.predictNextBet({ history, balance: 1000, lossStreak: 0, timeframe: MobileState.timeframe });
          if (out && out.target) return { predTarget: out.target, predType: out.type || 'SIZE', conf: out.prob || 0.75 };
        } catch(e) {}
      }
      // Simple trend fallback based on model's default predTarget
      return { predTarget: model.predTarget || 'BIG', predType: model.predType || 'SIZE', conf: model.conf || 0.75 };
    };
  }

  // Default startup view: Home (DhaniWin Web), restoring last active tab if persisted
  const initialTab = localStorage.getItem('active_mobile_tab') || 'web';
  switchMobileTab(initialTab);

  // If user already allowed high-confidence alert or has granted permission, remove card from Analyse page
  if ((typeof Notification !== 'undefined' && Notification.permission === 'granted') || localStorage.getItem('best_time_notif_enabled') === '1') {
    dismissOrRemoveBestTimeNotifCard();
  }

  // Guaranteed safety dismissal for loader screen
  setTimeout(dismissMinimalLoader, 800);

  // Initialize background execution & keep-alive
  if (MobileState.bgKeepAliveEnabled) {
    startBackgroundAudioKeepAlive();
  }
  if (MobileState.wakeLockEnabled) {
    requestScreenWakeLock();
  }
  syncBackgroundSettingsUI();

  // Background execution settings synced quietly without auto-opening settings or modal
  // (Available on-demand when user configures background execution)

  console.log('[Mobile] Bootstrap complete. Polling active for 4 timeframes.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMobileApp);
} else {
  initMobileApp();
}

// Global safety timeout to dismiss loader in any condition
setTimeout(dismissMinimalLoader, 1200);

