/**
 * =============================================================================
 * mobile.js  –  01:01 Quant AI (Mobile Orchestrator)
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
  timeframe: '30s',
  historyByTf: { '30s': [], '1m': [], '3m': [], '5m': [] },
  activePrediction: { period: null, target: null, type: 'SIZE', inChargeModel: null },
  scheduledPredictionsByPeriod: {},
  lastCelebratedPeriodByTf: { '30s': null, '1m': null, '3m': null, '5m': null },
  inChargeModel: null,
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
    baseStake: 10,
    stake: 10,
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
    if (localStorage.getItem('ar_token')) return true;
  } catch(e) {}
  return false;
}
window.isUserLoggedIn = isUserLoggedIn;

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
  if (typeof updateDhaniAuthBar === 'function') updateDhaniAuthBar();
}
window.markUserLoggedIn = markUserLoggedIn;

// Clear all login keys (only on confirmed session-out)
function markUserLoggedOut() {
  try {
    localStorage.removeItem('dhaniwin_is_logged_in');
    localStorage.removeItem('dhaniwin_logged_in');
    localStorage.removeItem('ar_token');
  } catch(e) {}
  try {
    if (window.MobileBridgeState) {
      window.MobileBridgeState.authToken = null;
      window.MobileBridgeState.userId = null;
    }
    const uIdEl = document.getElementById('mobileWebUserId');
    if (uIdEl) uIdEl.textContent = 'ID: --';
  } catch(e) {}
  if (typeof updateDhaniAuthBar === 'function') updateDhaniAuthBar();
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

let _pendingBgSound = null;

function playSoundEffect(type, force = false) {
  // CRITICAL REQUIREMENT 1: Only 'win' and 'loss' have associated sounds. Ignore 'click' or any other type completely!
  if (type !== 'win' && type !== 'loss') return;
  if (!MobileState.soundEnabled && !force) return;

  // Background audio throttling: suppress continuous chimes when backgrounded; queue at most a single chime
  if (!force && typeof document !== 'undefined' && document.hidden) {
    _pendingBgSound = type;
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
  if (t === 'GREEN') return col.includes('GREEN') || [1,3,7,9].includes(num);
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
  if (periodEl) periodEl.textContent = periodStr.slice(-6) || periodStr;

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
  if (assistPeriod) assistPeriod.textContent = '#' + (periodStr.slice(-5) || periodStr);

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

const CF_WORKER_BASE = 'https://wingo-edge-sync.itsrayzer.workers.dev';

const DEFAULT_TF_UPSTREAM_URLS = {
  '30s': 'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json',
  '1m':  'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json',
  '3m':  'https://draw.ar-lottery01.com/WinGo/WinGo_3M/GetHistoryIssuePage.json',
  '5m':  'https://draw.ar-lottery01.com/WinGo/WinGo_5M/GetHistoryIssuePage.json'
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

async function fetchLiveHistoryFromDirectAPI(tf) {
  // ── Source 1: Direct Upstream Lottery Feed (ar-lottery01.com — active live round data) ──
  try {
    const upstreamUrl = `${TF_UPSTREAM_URLS[tf] || TF_UPSTREAM_URLS['30s']}?pageNo=1&_=${Date.now()}`;
    const raw = await _fetchWithTimeout(upstreamUrl, 4000);
    const list = _parseRawList(raw);
    if (list.length > 0) return list;
  } catch (e) {
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

      if (isWin === null && (item.result === 'WIN' || item.result === 'LOSS')) {
        isWin = (item.result === 'WIN');
      }

      if (isPastRoundBeforeCutoff) {
        // Strict isolation: historical rounds before the session cutoff never carry live prediction outcomes
        aiTarget = null;
        isWin = null;
      } else {
        // 1. Check if this period was already settled in the current live session
        const existingInSession = currentList.find(c => String(c.period) === String(item.period));
        if (existingInSession && existingInSession.aiTarget) {
          aiTarget = existingInSession.aiTarget;
          if (existingInSession.aiCorrect !== null && existingInSession.aiCorrect !== undefined) {
            isWin = existingInSession.aiCorrect;
          }
        }

        // 2. Check scheduled predictions for rounds that were actively scheduled in this session
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
        aiCorrect: hasRealPrediction ? isWin : null
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
      renderHeroSequentialBallRoad(processedList);
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
    renderHeroSequentialBallRoad(list);
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
    const heroName = $('heroModelName');
    if (heroName) heroName.textContent = state.inChargeModel;
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

function renderAuthoritativeAIPrediction(list, forceRecompute = false) {
  const tf = MobileState.timeframe;
  const { periodStr } = computeRTState(tf);

  // ── STRICT ROUND-LOCK: PREVENT PREDICTION FLAPPING/GLITCHING IN THE SAME ROUND ──
  // If a prediction is already locked for this timeframe & period, strictly preserve it!
  if (!forceRecompute && MobileState.scheduledPredictionsByPeriod?.[tf]?.[periodStr]) {
    const locked = MobileState.scheduledPredictionsByPeriod[tf][periodStr];
    if (locked && locked.target) {
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
      const sorted = [...effectiveModels].sort((a, b) => {
        const wrA = Number(a.winRate !== undefined ? a.winRate : (parseFloat(a.winRatePct) / 100 || 0));
        const wrB = Number(b.winRate !== undefined ? b.winRate : (parseFloat(b.winRatePct) / 100 || 0));
        if (wrB !== wrA) return wrB - wrA;
        return (b.streak || 0) - (a.streak || 0);
      });
      inChargeName = sorted[0]?.name || inChargeName;
    }
  }
  if (!inChargeName && effectiveModels.length > 0) {
    inChargeName = effectiveModels[0].name;
  }
  MobileState.inChargeModel = inChargeName;

  // 2. Identify the authoritative In-Charge Model object
  const champModel = effectiveModels.find(m => m.name === inChargeName || m.id === inChargeName) || effectiveModels[0];

  // === SINGLE SOURCE OF TRUTH ===
  // THE AI TARGET IS STRICTLY AND 100% SYNCHRONIZED WITH THE IN-CHARGE MODEL'S PREDICTION
  let target = null;
  let predType = 'SIZE';
  let conf = 0.82;

  // Direct Execution: Calculate fresh prediction for in-charge champion on latest draw sequence
  if (champModel && typeof window.generateModelNextPrediction === 'function') {
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

function _updateAllPredictionUI(target, predType, conf, inChargeName, periodStr, list) {
  const isColor = ['RED','GREEN','VIOLET'].includes(target);
  const confPct = Math.round((conf || 0.82) * 100);

  // Hero signal badge
  const heroSignal = $('heroSignalBadge');
  if (heroSignal) {
    heroSignal.textContent = target || 'CALCULATING...';
    heroSignal.className = `text-2xl font-black tracking-tight ${
      target === 'BIG' ? 'text-amber-300' :
      target === 'SMALL' ? 'text-sky-300' :
      target === 'GREEN' ? 'text-emerald-400' :
      target === 'RED' ? 'text-rose-400' : 'text-white'
    }`;
  }

  const heroType = $('heroTypeBadge');
  if (heroType) heroType.textContent = predType || 'SIZE';

  const heroConf = $('heroConfVal');
  if (heroConf) {
    heroConf.textContent = `${confPct}%`;
    heroConf.className = confPct >= 75 ? 'text-emerald-400 font-black' : 'text-amber-400 font-black';
  }

  const heroModel = $('heroModelName');
  if (heroModel) heroModel.textContent = inChargeName || 'Auto Champion';

  // AI Champion card target badge
  const champTarget = $('aiChampionTargetBadge');
  if (champTarget) {
    champTarget.textContent = target || 'CALCULATING';
    champTarget.className = `px-2 py-0.5 rounded font-black text-[8.5px] border ${
      target === 'BIG' ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' :
      target === 'SMALL' ? 'bg-sky-500/20 text-sky-300 border-sky-500/30' :
      target === 'GREEN' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' :
      target === 'RED' ? 'bg-rose-500/20 text-rose-300 border-rose-500/30' :
      'bg-amber-500/20 text-amber-300 border-amber-500/30'
    }`;
  }

  const champType = $('aiChampionTypeBadge');
  if (champType) champType.textContent = predType || 'SIZE';

  // Sequential Prediction Road (Balls with mixed colors for 0,5, newest on left)
  renderHeroSequentialBallRoad(list);
  // DhaniWin Web Tab Target & Auto-Prep Sync
  const webTargetEl = $('mobileWebTargetDisplay');
  if (webTargetEl && target) {
    webTargetEl.textContent = target;
    webTargetEl.className = `text-2xl font-black ${
      target === 'BIG' ? 'text-amber-300' :
      target === 'SMALL' ? 'text-sky-300' :
      target === 'GREEN' ? 'text-emerald-400' :
      target === 'RED' ? 'text-rose-400' : 'text-white'
    }`;
  }
  const assistConf = $('assistantConfBadge');
  if (assistConf) {
    assistConf.textContent = `${confPct}%`;
  }
  if (typeof updateFloatingOrbUI === 'function') {
    updateFloatingOrbUI();
  }
  if (window.MobileBridgeState && MobileBridgeState.enabled && target) {
    if (typeof dispatchMobileBetOrder === 'function') {
      dispatchMobileBetOrder();
    }
  }

  // Sim bot: place next bet
  if (MobileState.sim.running && !MobileState.sim.pendingBet) {
    initSimBet(target, periodStr);
  }
}

function renderHeroSequentialBallRoad(list) {
  const container = $('heroSequentialBallRoad');
  if (!container) return;

  if (!list || list.length === 0) {
    container.innerHTML = '<div class="text-[8px] text-zinc-500 font-mono py-1 px-2">Awaiting draw data...</div>';
    return;
  }

  // Universal ordering: NEW results are at LEFT, OLD results to RIGHT
  const display = [...list].reverse().slice(0, 25);

  container.innerHTML = display.map((r, idx) => {
    const n = Number(r.number);
    let ballBg = 'ball-red';
    if (n === 0) ballBg = 'ball-split-0';
    else if (n === 5) ballBg = 'ball-split-5';
    else if (n === 1 || n === 3 || n === 7 || n === 9) ballBg = 'ball-green';

    const isNewest = idx === 0;
    const periodShort = String(r.period).slice(-4);

    return `<div class="flex flex-col items-center gap-0.5 shrink-0" title="Period #${r.period} - Num ${n} (${r.size})">
      <div class="relative">
        <div class="ball-3d ${ballBg} w-6 h-6 rounded-full flex items-center justify-center font-mono font-black text-[10.5px] text-white shadow-sm ${isNewest ? 'ring-2 ring-amber-400 ring-offset-1 ring-offset-black' : ''}">
          ${n}
        </div>
        ${isNewest ? '<span class="absolute -top-1 -right-1 flex h-2 w-2"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span></span>' : ''}
      </div>
      <span class="text-[7px] font-mono text-zinc-500 font-semibold">${periodShort}</span>
    </div>`;
  }).join('');
}
window.renderHeroSequentialBallRoad = renderHeroSequentialBallRoad;

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

  // Show most recent first
  const display = [...list].reverse().slice(0, 30);

  tbody.innerHTML = display.map(r => {
    const isWin = r.aiCorrect === true || r.result === 'WIN';
    const isLoss = r.aiCorrect === false || r.result === 'LOSS';
    const hasResult = r.aiTarget && (r.aiCorrect !== null && r.aiCorrect !== undefined);

    const numColor = (r.number === 0 || r.number === 5) ? 'text-purple-400' :
      [1,3,7,9].includes(r.number) ? 'text-emerald-400' : 'text-rose-400';

    const sizeColor = r.size === 'BIG' ? 'text-amber-300' : 'text-sky-300';

    let resultBadge = '';
    if (hasResult) {
      resultBadge = isWin
        ? `<span class="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[7px] font-black">✓ ${r.aiTarget}</span>`
        : `<span class="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 border border-rose-500/30 text-[7px] font-black">✗ ${r.aiTarget}</span>`;
    } else {
      resultBadge = `<span class="text-zinc-600 text-[7px]">—</span>`;
    }

    return `<tr class="hover:bg-white/[0.02] transition">
      <td class="py-1.5 px-1 font-mono text-[8.5px] text-zinc-400">${String(r.period).slice(-6)}</td>
      <td class="py-1.5 px-1 font-mono font-black ${numColor}">${r.number}</td>
      <td class="py-1.5 px-1 font-mono font-bold ${sizeColor}">${r.size}</td>
      <td class="py-1.5 px-1 font-mono text-[8px] text-zinc-400">${r.color ? r.color.split(',')[0] : '—'}</td>
      <td class="py-1.5 px-1 text-right">${resultBadge}</td>
    </tr>`;
  }).join('');
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

  // Show recent rounds: newest on top, like PC number road
  const display = [...list].reverse().slice(0, 30);
  const COLS = 'grid-template-columns:46px repeat(10,1fr) 20px 20px';

  container.innerHTML = display.map((row, idx) => {
    const n = Number(row.number);
    const periodShort = String(row.period).slice(-4);

    // 10 ball cells
    const balls = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => {
      if (i === n) {
        return `<div class="flex items-center justify-center">
          <div class="ball-3d ${BALL_COLOR_CLASSES[n] || 'ball-red'} w-4 h-4 rounded-full flex items-center justify-center font-black text-[8px] text-white shadow-sm">${n}</div>
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
  }).join('');

  // Draw connector SVG
  drawMobileGraphConnector(display);
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

  // Sequential Road (bead chain) - strictly real live settled predictions
  renderSequentialRoad(settled.slice(-25));

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
  setText('detailPeriod', String(r.period).slice(-6));
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

  // STRICT DEDUPLICATION - Lock immediately to prevent concurrent re-entry
  if (MobileState.lastCelebratedPeriodByTf[tf] === periodStr) return;
  MobileState.lastCelebratedPeriodByTf[tf] = periodStr;

  let isWin = null;
  let target = null;
  let predType = 'SIZE';

  // Priority 1: Universal State latest settlement
  if (universalState && String(universalState.latestSettledPeriod) === periodStr) {
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

  // Priority 2: Cloud row from live_history
  if (cloudRow && (isWin === null || !target)) {
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

  // Priority 3: Universal state inCharge history path
  if ((isWin === null || !target) && universalState && Array.isArray(universalState.inChargeHistoryPath)) {
    const entry = universalState.inChargeHistoryPath.find(p => String(p.period) === periodStr);
    if (entry) {
      if (isWin === null) isWin = !!entry.won;
      target = target || entry.predTarget;
      predType = entry.predType || (['RED','GREEN','VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
    }
  }

  // Priority 4: Scheduled prediction
  if (isWin === null || !target) {
    const scheduled = (MobileState.scheduledPredictionsByPeriod?.[tf] || {})[periodStr];
    if (scheduled) {
      target = target || scheduled.target;
      predType = scheduled.type || (['RED','GREEN','VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
    }
  }

  // Priority 5: Active prediction if period matches
  if (isWin === null || !target) {
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
  if (target && isWin === null) {
    isWin = !!evaluatePredictionCorrectness(target, number, size, color);
  }

  const hasAuthenticPrediction = !!(target && isWin !== null);
  if (!hasAuthenticPrediction) {
    // Cannot determine authentic prediction - do NOT manufacture a fake win
    target = null;
    isWin = null;
  }

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

  // Stamp history row with definitive in-charge prediction outcome
  const curHist = MobileState.historyByTf[tf] || [];
  let existingRow = curHist.find(r => String(r.period) === periodStr);
  if (existingRow) {
    existingRow.number = number;
    existingRow.size = size;
    existingRow.color = color;
    if (hasAuthenticPrediction) {
      existingRow.aiTarget = target;
      existingRow.aiType = predType;
      existingRow.aiModel = MobileState.inChargeModel;
      existingRow.aiCorrect = isWin;
      existingRow.result = isWin ? 'WIN' : 'LOSS';
    }
  } else {
    curHist.push({
      period: periodStr, number, size, color,
      result: hasAuthenticPrediction ? (isWin ? 'WIN' : 'LOSS') : null,
      aiTarget: hasAuthenticPrediction ? target : null,
      aiType: hasAuthenticPrediction ? predType : null,
      aiModel: hasAuthenticPrediction ? MobileState.inChargeModel : null,
      aiCorrect: hasAuthenticPrediction ? isWin : null
    });
    curHist.sort((a, b) => String(a.period).localeCompare(String(b.period)));
  }
  MobileState.historyByTf[tf] = curHist;
  try { localStorage.setItem(`quant_history_${tf}`, JSON.stringify(curHist.slice(-500))); } catch(e) {}
  if (!MobileState.scheduledPredictionsByPeriod) MobileState.scheduledPredictionsByPeriod = {};
  if (!MobileState.scheduledPredictionsByPeriod[tf]) MobileState.scheduledPredictionsByPeriod[tf] = {};
  if (hasAuthenticPrediction) {
    MobileState.scheduledPredictionsByPeriod[tf][periodStr] = { target, type: predType, inChargeModel: MobileState.inChargeModel, won: isWin };
  }

  // Update TimeframeManager
  if (window.TimeframeManager && typeof window.TimeframeManager.recordSettledRound === 'function') {
    try { window.TimeframeManager.recordSettledRound(tf, periodStr, number, size, color); } catch(e) {}
  }

  // Resolve sim bot bet
  let simProfit = null;
  if (hasAuthenticPrediction && MobileState.sim.running && MobileState.sim.pendingBet) {
    const bet = MobileState.sim.pendingBet;
    if (!bet.period || String(bet.period) === periodStr) {
      simProfit = isWin ? (bet.stake * 0.96) : -bet.stake;
      resolveSimBet(size, isWin);
    }
  }

  // Resolve Mobile DhaniWin Loss Recovery Martingale Progression & Max 3-Loss Circuit Breaker
  if (hasAuthenticPrediction && tf === MobileState.timeframe && window.MobileBridgeState) {
    let isFreshTrip = false;
    if (isWin) {
      MobileBridgeState.wins += 1;
      MobileBridgeState.consecutiveLosses = 0;
      const profit = MobileBridgeState.currentStake * 0.96;
      MobileBridgeState.sessionPnl += profit;
      MobileBridgeState.currentLevel = 0; // Win: Reset to Base ₹2
    } else if (isWin === false) {
      MobileBridgeState.losses += 1;
      MobileBridgeState.consecutiveLosses = (MobileBridgeState.consecutiveLosses || 0) + 1;
      MobileBridgeState.sessionPnl -= MobileBridgeState.currentStake;

      if (MobileBridgeState.consecutiveLosses >= 3) {
        // 🛡️ TRIP MAX 3-LOSS CIRCUIT BREAKER
        MobileBridgeState.circuitBreakerActive = true;
        MobileBridgeState.circuitBreakerPauseRounds = 2; // Pause betting for 2 rounds
        MobileBridgeState.currentLevel = 0; // Reset Martingale level strictly to Base
        MobileBridgeState.currentStake = MobileBridgeState.baseStake || 2; // Reset stake to base (₹2)
        MobileBridgeState.consecutiveLosses = 0;
        isFreshTrip = true;

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
          // Pre-emptive hot-swap: Swap away from any slumping model before final recovery round
          if (typeof determineOptimalArenaInChargeModel === 'function' && Array.isArray(window.ARENA_CANONICAL_MODELS)) {
            const reEval = determineOptimalArenaInChargeModel(window.ARENA_CANONICAL_MODELS, null, true);
            if (reEval?.model) {
              MobileState.activeChampionModel = reEval.model;
              if (typeof updatePredictionSourceUI === 'function') updatePredictionSourceUI();
            }
          }
          showToast('🛡️ Stage 3 Defense Active: Denoised consensus engaged for final recovery round!', 'info');
        }
      }
    }

    // Handle cool-off countdown on subsequent rounds
    if (MobileBridgeState.circuitBreakerPauseRounds > 0 && !isFreshTrip) {
      MobileBridgeState.circuitBreakerPauseRounds--;
      if (MobileBridgeState.circuitBreakerPauseRounds === 0) {
        MobileBridgeState.circuitBreakerActive = false;
        showToast('✅ Circuit Breaker cool-off complete. Betting resumed.', 'info');
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
  if (tf === MobileState.timeframe && hasAuthenticPrediction) {
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

  // CRITICAL REQUIREMENT 2: Never show win/loss animations or sounds before login/registration is confirmed!
  if (!isUserLoggedIn()) {
    console.log('[Win/Loss Celebration] Suppressed: User is not logged in / verified yet.');
    return;
  }


  // CRITICAL REQUIREMENT 3: Single-instance concurrency - strictly never show more than 1 celebration/sound at a time
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
    if (banner) banner.className = 'fixed top-14 left-3 right-3 z-[9998] animate-in slide-in-from-top duration-300 max-w-md mx-auto';
    if (pnlBadge) {
      pnlBadge.textContent = currentStreak > 1 ? `🔥 ${currentStreak}W Streak` : `+1W`;
      pnlBadge.className = 'text-xs font-black text-emerald-400';
    }
    const winProfit = (window.MobileBridgeState && MobileBridgeState.currentStake) ? MobileBridgeState.currentStake * 0.96 : 2;
    // Trigger smooth, non-intrusive cinematic Apple money rain overlay (replaces old cheap fullscreen modal)
    if (typeof triggerAppleMoneyRain === 'function') {
      triggerAppleMoneyRain(winProfit, currentStreak);
    }
  } else {
    if (iconBox) iconBox.className = 'w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0 bg-rose-500/20 text-rose-400';
    if (icon) icon.className = 'fa-solid fa-xmark';
    if (title) { title.textContent = 'PREDICTION MISSED'; title.className = 'text-xs font-black tracking-tight text-rose-400'; }
    if (banner) banner.className = 'fixed top-14 left-3 right-3 z-[9998] animate-in slide-in-from-top duration-300 max-w-md mx-auto';
    if (pnlBadge) {
      pnlBadge.textContent = `0W Streak (Reset)`;
      pnlBadge.className = 'text-xs font-black text-rose-400';
    }
  }

  if (subtext) {
    subtext.textContent = `Hit ${size} (#${number}) · Target was ${target}`;
  }
  if (periodBadge) {
    periodBadge.textContent = `#${String(periodStr).slice(-5)}`;
  }

  // Sound & haptic (Only plays for active timeframe, strictly single-instance)
  playSoundEffect(isWin ? 'win' : 'loss');
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
  if (sub) { sub.textContent = `Period #${String(data?.period || '').slice(-5)}`; }

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
    // Each model individually predicts based on history BEFORE this round
    let pred = null;
    if (typeof model.predict === 'function') {
      try { pred = model.predict(historyBefore, models); } catch(e) {}
    } else if (typeof window.generateModelNextPrediction === 'function') {
      try { pred = window.generateModelNextPrediction(model, historyBefore); } catch(e) {}
    }

    if (pred) {
      model.predTarget = pred.predTarget || pred.target || model.predTarget || 'BIG';
      model.predType = pred.predType || pred.type || model.predType || 'SIZE';
      model.conf = pred.conf !== undefined ? pred.conf : model.conf;
    }

    const won = evaluatePredictionCorrectness(model.predTarget || 'BIG', number, size, color);
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
      const sorted = [...models].sort((a, b) => (b.winRate || 0) - (a.winRate || 0));
      if (sorted[0]) MobileState.inChargeModel = sorted[0].name;
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

function setMobileAlgoCategory(cat) {
  activeAlgoCategory = (cat || 'all').toLowerCase();
  document.querySelectorAll('.ai-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.id === `algoCat-${activeAlgoCategory}`);
  });
  renderModelRosterUI();
}
window.setMobileAlgoCategory = setMobileAlgoCategory;

function filterModelRoster() {
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

  const getLastNWinRate = (m, n) => {
    const p = (m.historyPath || []).slice(0, n);
    if (p.length === 0) return 0;
    return p.filter(x => x.won).length / p.length;
  };

  const sorted = [...allModels].sort((a, b) => {
    if (inchargeMode === 'LAST_10_WIN_RATE') {
      const wrA = getLastNWinRate(a, 10);
      const wrB = getLastNWinRate(b, 10);
      if (wrB !== wrA) return wrB - wrA;
      const sDiff = Number(b.streak || 0) - Number(a.streak || 0);
      if (sDiff !== 0) return sDiff;
      return getWinRate(b) - getWinRate(a);
    }
    if (inchargeMode === 'LAST_20_WIN_RATE') {
      const wrA = getLastNWinRate(a, 20);
      const wrB = getLastNWinRate(b, 20);
      if (wrB !== wrA) return wrB - wrA;
      const sDiff = Number(b.streak || 0) - Number(a.streak || 0);
      if (sDiff !== 0) return sDiff;
      return getWinRate(b) - getWinRate(a);
    }
    if (inchargeMode === 'HIGHEST_STREAK') {
      const sDiff = Number(b.streak || 0) - Number(a.streak || 0);
      if (sDiff !== 0) return sDiff;
      return getWinRate(b) - getWinRate(a);
    }
    if (inchargeMode === 'SESSION_WIN_RATE') {
      const wrA = a.sessionWinRate !== undefined ? Number(a.sessionWinRate) : getWinRate(a);
      const wrB = b.sessionWinRate !== undefined ? Number(b.sessionWinRate) : getWinRate(b);
      if (wrB !== wrA) return wrB - wrA;
      return (Number(b.streak || 0)) - (Number(a.streak || 0));
    }
    if (inchargeMode === 'SESSION_STREAK_OVERRIDE') {
      const sA = Number(a.sessionStreak !== undefined ? a.sessionStreak : a.streak || 0);
      const sB = Number(b.sessionStreak !== undefined ? b.sessionStreak : b.streak || 0);
      const elA = sA >= minStreak;
      const elB = sB >= minStreak;
      if (elA && !elB) return -1;
      if (!elA && elB) return 1;
      if (elA && elB && sB !== sA) return sB - sA;
      return getWinRate(b) - getWinRate(a);
    }
    if (inchargeMode === 'WINNING_STREAK_OVERRIDE') {
      const sA = Number(a.streak || 0);
      const sB = Number(b.streak || 0);
      const elA = sA >= minStreak;
      const elB = sB >= minStreak;
      if (elA && !elB) return -1;
      if (!elA && elB) return 1;
      if (elA && elB && sB !== sA) return sB - sA;
      const wrDiff = getWinRate(b) - getWinRate(a);
      if (wrDiff !== 0) return wrDiff;
      return (b.totalEvaluated || 0) - (a.totalEvaluated || 0);
    }
    // Default / OVERALL_WIN_RATE
    const wrDiff = getWinRate(b) - getWinRate(a);
    if (wrDiff !== 0) return wrDiff;
    const evDiff = (b.totalEvaluated || 0) - (a.totalEvaluated || 0);
    if (evDiff !== 0) return evDiff;
    return (b.streak || 0) - (a.streak || 0);
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
    const heroName = $('heroModelName');
    if (heroName) heroName.textContent = effectiveInCharge;
    const champName = $('aiChampionName');
    if (champName) champName.textContent = effectiveInCharge;
  }

  // Champion card stats
  const champModel = sorted.find(m => m.name === effectiveInCharge) || sorted[0];
  if (champModel) {
    const activeTarget = MobileState.activePrediction?.target || champModel.predTarget || 'BIG';
    const activeType = MobileState.activePrediction?.type || champModel.predType || 'SIZE';
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
        'bg-amber-500/20 text-amber-300 border-amber-500/30'
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

  const listEl = $('aiRosterList');
  if (!listEl) return;

  if (displayList.length === 0) {
    listEl.innerHTML = '<div class="text-center text-zinc-500 py-6 text-[9px] font-mono">No algorithms match your query.</div>';
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

  listEl.innerHTML = displayList.map((a, idx) => {
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

    const cardClass = isLead
      ? 'p-2.5 rounded-2xl bg-black/60 border border-emerald-500/40 shadow-[0_0_16px_rgba(52,211,153,0.12)]'
      : 'p-2.5 rounded-2xl bg-black/40 border border-white/[0.06] hover:border-white/[0.12] transition';

    const wr = a.winRatePct || `${(getWinRate(a) * 100).toFixed(1)}%`;
    const tColor = a.predTarget === 'BIG' ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
      : a.predTarget === 'SMALL' ? 'bg-sky-500/20 text-sky-300 border-sky-500/30'
      : a.predTarget === 'GREEN' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
      : 'bg-rose-500/20 text-rose-300 border-rose-500/30';

    return `<div class="${cardClass} flex items-center justify-between font-mono text-[9px]">
      <div class="flex items-center gap-2">
        <span class="text-[8px] text-zinc-500 w-5 font-bold">#${idx+1}</span>
        <div>
          <div class="flex items-center gap-1.5">
            <span class="font-bold text-white max-w-[150px] truncate">${a.name}</span>
            ${isLead ? '<span class="px-1.5 py-0.2 rounded bg-amber-400 text-black text-[7px] font-black font-mono">IN CHARGE</span>' : ''}
            <span class="px-1.5 py-0.2 rounded ${tColor} border text-[7px] font-black">${a.predTarget || 'BIG'}</span>
          </div>
          <div class="flex items-center gap-1.5 mt-0.5 text-[8px] text-zinc-400">
            <span class="px-1 py-0.2 rounded bg-white/5 border border-white/10 uppercase">${a.cat || 'AI'}</span>
            <span>WR: <b class="text-emerald-400">${wr}</b> (${a.wins||0}W/${a.losses||0}L)</span>
            <div class="flex gap-0.5">${dotsHtml}</div>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="px-1.5 py-0.5 rounded text-[8px] font-black ${streakClass}">${isWinStreak ? '🔥 ' : '❄️ '}${streakStr}</span>
        <button onclick="setInChargeModel('${a.name.replace(/'/g, "\\'")}')"
          class="px-2 py-1 rounded-xl ${isLead ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/30'} text-[8px] font-black active:scale-95 transition">
          ${isLead ? 'Selected' : 'Select'}
        </button>
      </div>
    </div>`;
  }).join('');
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
  setText('heroModelName', name);

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
  logSimEntry(`🔮 Placed ${target} · ₹${stake} · Period #${String(period).slice(-5)}`);
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

// ── Per-user DhaniWin auth flow (no personal credentials anywhere) ──────────────
// Active session → user's last interval; returning user → Login; new user → Register.
function getDhaniEntryUrl() {
  if (isUserLoggedIn()) {
    const tf = localStorage.getItem('dhaniwin_last_interval') || MobileState.timeframe || '30s';
    return DHANIWIN_INTERVAL_URLS[tf] || DHANIWIN_INTERVAL_URLS['30s'];
  }
  return localStorage.getItem('dhaniwin_registered') === '1' ? DHANIWIN_LOGIN_URL : DHANIWIN_REGISTRATION_URL;
}
window.getDhaniEntryUrl = getDhaniEntryUrl;

function handleDhaniSessionExpired(reason) {
  if (Date.now() < _authGracePeriodUntil) {
    console.log('[Auth Guard] Blocked false session-out event during post-login grace period:', reason);
    return;
  }
  markUserLoggedOut();
  setMobileBridgeStatus(false, reason || 'Session Expired • Please Login');
  showToast('⚠️ Session expired. Please log in again.', 'warn');
  loadMobileWebUrl(getDhaniEntryUrl());
  showDhaniAuthBar(true);
}
window.handleDhaniSessionExpired = handleDhaniSessionExpired;

let _dhaniAuthBarDismissed = false;
function updateDhaniAuthBar() {
  const bar = document.getElementById('dhaniAuthBar');
  if (!bar) return;
  const loggedIn = isUserLoggedIn();
  const onWeb = document.getElementById('tab-web')?.style.display !== 'none';
  bar.style.display = (!loggedIn && onWeb && !_dhaniAuthBarDismissed) ? 'flex' : 'none';
  const txt = document.getElementById('dhaniAuthBarText');
  if (txt) txt.textContent = localStorage.getItem('dhaniwin_registered') === '1' ? 'Logged out' : 'Not logged in';
  const acct = document.getElementById('headerAccountIcon');
  if (acct) acct.className = loggedIn ? 'fa-solid fa-user-check text-xs text-emerald-300' : 'fa-solid fa-right-to-bracket text-xs text-sky-300';
}
window.updateDhaniAuthBar = updateDhaniAuthBar;

function showDhaniAuthBar(force) {
  if (force) _dhaniAuthBarDismissed = false;
  updateDhaniAuthBar();
}
function dismissDhaniAuthBar() { _dhaniAuthBarDismissed = true; updateDhaniAuthBar(); }
window.dismissDhaniAuthBar = dismissDhaniAuthBar;

function openDhaniLogin() {
  if (typeof switchMobileTab === 'function') switchMobileTab('web');
  loadMobileWebUrl(DHANIWIN_LOGIN_URL);
}
function openDhaniRegister() {
  if (typeof switchMobileTab === 'function') switchMobileTab('web');
  loadMobileWebUrl(DHANIWIN_REGISTRATION_URL);
}
// User confirms they've logged in inside DhaniWin (needed because the cross-origin
// iframe cannot be inspected without the bridge script).
function confirmDhaniLoggedIn() {
  markUserLoggedIn();
  const tf = localStorage.getItem('dhaniwin_last_interval') || MobileState.timeframe || '30s';
  loadMobileWebUrl(DHANIWIN_INTERVAL_URLS[tf] || DHANIWIN_INTERVAL_URLS['30s']);
  showToast('✅ Opening your WinGo interval', 'success');
}
function openDhaniAccountMenu() {
  if (isUserLoggedIn()) {
    if (confirm('Log out / switch DhaniWin account?')) {
      markUserLoggedOut();
      openDhaniLogin();
      showDhaniAuthBar(true);
    }
  } else {
    showDhaniAuthBar(true);
    openDhaniLogin();
  }
}
window.openDhaniLogin = openDhaniLogin;
window.openDhaniRegister = openDhaniRegister;
window.confirmDhaniLoggedIn = confirmDhaniLoggedIn;
window.openDhaniAccountMenu = openDhaniAccountMenu;

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

function initHomeHeaderAutoHide() {
  const header = document.querySelector('header.liquid-glass-header');
  if (!header) return;
  const syncHeight = () => document.documentElement.style.setProperty('--app-header-h', header.offsetHeight + 'px');
  syncHeight();
  window.addEventListener('resize', syncHeight);

  const attachSwipe = (el) => {
    let y0 = null;
    el.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (y0 === null) return;
      const dy = e.changedTouches[0].clientY - y0;
      y0 = null;
      if (dy < -18) setHomeHeaderHidden(true);
      else if (dy > 18) setHomeHeaderHidden(false);
    }, { passive: true });
  };
  attachSwipe(header);
  const handle = document.getElementById('homeHeaderPullHandle');
  if (handle) {
    attachSwipe(handle);
    handle.addEventListener('click', () => setHomeHeaderHidden(false));
  }
}

// ── Liquid-glass dock: scroll-driven compact (down=small, up=big) ─────────────
function initDockAutoCompact() {
  const dock = document.getElementById('mobileBottomDock');
  if (!dock) return;

  let lastScrollY = window.scrollY;
  const SCROLL_THRESHOLD = 8;

  const compact = () => {
    dock.classList.add('dock-compact');
    document.body.classList.add('nav-compact');
  };
  const expand = () => {
    dock.classList.remove('dock-compact');
    document.body.classList.remove('nav-compact');
  };

  // ── Window scroll: scrolling down = compact on Home tab (or all tabs if configured) ──
  window.addEventListener('scroll', () => {
    const onWeb = document.getElementById('tab-web')?.style.display !== 'none';
    const allowAll = localStorage.getItem('dock_compact_all_tabs') === '1';
    if (!onWeb && !allowAll) {
      expand();
      return;
    }

    const y = window.scrollY;

    // At top of the screen: always restore full normal menu
    if (y <= 20) {
      expand();
      lastScrollY = y;
      return;
    }

    const delta = y - lastScrollY;
    if (delta > SCROLL_THRESHOLD && y > 60) {
      // User scrolled DOWN → make menu compact
      compact();
    } else if (delta < -SCROLL_THRESHOLD) {
      // User scrolled UP → make menu back to normal
      expand();
    }

    lastScrollY = y;
  }, { passive: true });

  // ── Tap outside bottom dock on Home tab compacts dock ──
  document.addEventListener('pointerdown', (e) => {
    const onWeb = document.getElementById('tab-web')?.style.display !== 'none';
    const allowAll = localStorage.getItem('dock_compact_all_tabs') === '1';
    if (!onWeb && !allowAll) return;
    const dockEl = document.getElementById('mobileBottomDock');
    if (!dockEl) return;
    if (dockEl.contains(e.target)) return;
    const orb = document.getElementById('dhaniwinFloatingOrb');
    if (orb && orb.contains(e.target)) return;
    const modal = document.getElementById('dhaniwinAssistantModal');
    if (modal && !modal.classList.contains('hidden') && modal.contains(e.target)) return;
    compact();
  }, { passive: true });

  // ── Touching the dock itself always expands it back to normal ──
  ['touchstart', 'pointerdown', 'mouseenter'].forEach(ev =>
    dock.addEventListener(ev, expand, { passive: true })
  );
}

// Expose for DHANIWIN_SCROLL bridge messages
window._dockSetCompact = (isCompact) => {
  const dock = document.getElementById('mobileBottomDock');
  if (!dock) return;
  isCompact ? dock.classList.add('dock-compact') : dock.classList.remove('dock-compact');
};

const _runDockInit = () => {
  try { initHomeHeaderAutoHide(); } catch(e) { console.warn('[HeaderAutoHide]', e); }
  try { initDockAutoCompact(); } catch(e) { console.warn('[DockCompact]', e); }
  try { updateDhaniAuthBar(); } catch(e) {}
  try { initCoffeeSupportPopup(); } catch(e) { console.warn('[CoffeePopup]', e); }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _runDockInit);
} else {
  _runDockInit();
}

function switchMobileTab(tab) {
  try { localStorage.setItem('active_mobile_tab', tab); } catch(e) {}

  ['home', 'ai', 'sim', 'web', 'pattern'].forEach(t => {
    const section = $(`tab-${t}`);
    if (section) section.style.display = t === tab ? 'block' : 'none';
  });

  document.querySelectorAll('.dock-btn').forEach(btn => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActive);
  });

  // Non-home tabs stay full size unless configured in settings
  if (tab !== 'web' && localStorage.getItem('dock_compact_all_tabs') !== '1') {
    const dock = document.getElementById('mobileBottomDock');
    if (dock) {
      dock.classList.remove('dock-compact');
      document.body.classList.remove('nav-compact');
    }
  }

  // Header auto-hide applies only to the Home (web) tab
  if (tab !== 'web') document.body.classList.remove('home-header-hidden');
  updateDhaniAuthBar();

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

  // Manage DhaniWin Web View & Floating Assistant Orb
  const orb = $('dhaniwinFloatingOrb');
  if (tab === 'web') {
    if (orb) orb.style.display = 'block';
    if (typeof updateFloatingOrbUI === 'function') updateFloatingOrbUI();

    const iframe = $('dhaniwinIframe');
    if (iframe && (iframe.src === 'about:blank' || !iframe.src || iframe.src.includes('about:blank'))) {
      const targetUrl = getDhaniEntryUrl();
      iframe.src = targetUrl;
      const barText = $('mobileWebAddressBarText');
      if (barText) barText.textContent = targetUrl;
    }
  } else {
    if (orb) orb.style.display = 'none';
    if (typeof toggleDhaniwinAssistantModal === 'function') toggleDhaniwinAssistantModal(false);
  }
}
window.switchMobileTab = switchMobileTab;

function setMobileTimeframe(tf) {
  MobileState.timeframe = tf;
  try {
    localStorage.setItem('dhaniwin_last_interval', tf);
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
  renderHeroSequentialBallRoad(cached);
  renderDigitFrequencies(cached);
  renderChartData(cached);
  renderAdaptiveAI(cached);
  renderAuthoritativeAIPrediction(cached);
  renderModelRosterUI();

  if (cached.length === 0) {
    // Trigger immediate fetch for this timeframe
    fetchLiveAPIResults(tf);
  }

  // Sync DhaniWin Web Tab Interval Pills & Notify Bridge
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

  // Synchronously route DhaniWin web view to matching interval
  const iframe = $('dhaniwinIframe');
  const targetUrl = DHANIWIN_INTERVAL_URLS[tf] || DHANIWIN_INTERVAL_URLS['30s'];
  if (iframe && (!iframe.src || !iframe.src.toLowerCase().includes(targetUrl.toLowerCase()))) {
    loadMobileWebUrl(targetUrl);
  }

  if (typeof postMobileBridge === 'function') {
    postMobileBridge({ type: 'WINGO_SWITCH_TIMEFRAME', timeframe: tf, timestamp: Date.now() });
  }

  updateISTClock();
}
window.setMobileTimeframe = setMobileTimeframe;

// ── 24A. Buy Me a Coffee Support Modal & Razorpay Integration ─────────────────

const RAZORPAY_CHECKOUT_URL = 'https://rzp.io/rzp/bFsHIaS';

function openRazorpayCheckout() {
  window.open(RAZORPAY_CHECKOUT_URL, '_blank', 'noopener,noreferrer');
}
window.openRazorpayCheckout = openRazorpayCheckout;

function openCoffeeSupportModal() {
  const modal = $('coffeeSupportModal');
  if (!modal) return;
  modal.classList.remove('opacity-0', 'pointer-events-none');
  modal.classList.add('opacity-100', 'pointer-events-auto');
}
window.openCoffeeSupportModal = openCoffeeSupportModal;

function closeCoffeeSupportModal(agreed) {
  const modal = $('coffeeSupportModal');
  if (!modal) return;
  modal.classList.remove('opacity-100', 'pointer-events-auto');
  modal.classList.add('opacity-0', 'pointer-events-none');
}
window.closeCoffeeSupportModal = closeCoffeeSupportModal;

const COFFEE_SUPPORTER_DURATION_DAYS = 7;
const COFFEE_SUPPORTER_DURATION_MS = COFFEE_SUPPORTER_DURATION_DAYS * 24 * 60 * 60 * 1000;

function isCoffeePaidActive() {
  try {
    const until = Number(localStorage.getItem('coffee_paid_until') || 0);
    if (until && Date.now() < until) {
      return true;
    }
    const today = new Date().toLocaleDateString('en-CA');
    if (localStorage.getItem('coffee_paid_date') === today) {
      return true;
    }
    return false;
  } catch(e) {
    return false;
  }
}
window.isCoffeePaidActive = isCoffeePaidActive;

function isCoffeePaidToday() {
  return isCoffeePaidActive();
}
window.isCoffeePaidToday = isCoffeePaidToday;

function recordCoffeePayment(paymentId) {
  try {
    const today = new Date().toLocaleDateString('en-CA');
    const validUntil = Date.now() + COFFEE_SUPPORTER_DURATION_MS;
    const validUntilFormatted = new Date(validUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    
    localStorage.setItem('coffee_paid_date', today);
    localStorage.setItem('coffee_paid_until', String(validUntil));
    const info = {
      date: today,
      validUntil: validUntil,
      validUntilFormatted: validUntilFormatted,
      days: COFFEE_SUPPORTER_DURATION_DAYS,
      paymentId: String(paymentId || ('pay_' + Math.random().toString(36).substring(2, 10))),
      time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true })
    };
    localStorage.setItem('coffee_paid_info', JSON.stringify(info));
    closeCoffeeSupportModal(true);
    if (typeof syncCoffeeSettingsUI === 'function') syncCoffeeSettingsUI();
    showToast(`💛 Thank you for your support! Popup won't come again for a while (until ${validUntilFormatted}).`, 'success');
    if (typeof triggerWinConfetti === 'function') triggerWinConfetti();
  } catch(e) {}
}
window.recordCoffeePayment = recordCoffeePayment;

function confirmCoffeePaidPrompt() {
  const ans = prompt('Enter your Razorpay Payment ID or UPI Reference (or tap OK to confirm support):', 'pay_');
  if (ans !== null) {
    const cleanId = ans.trim();
    recordCoffeePayment(cleanId.length > 4 ? cleanId : ('pay_confirm_' + Date.now().toString(36)));
  }
}
window.confirmCoffeePaidPrompt = confirmCoffeePaidPrompt;

function dismissCoffeeSupportModalToday() {
  closeCoffeeSupportModal(false);
}
window.dismissCoffeeSupportModalToday = dismissCoffeeSupportModalToday;

function initCoffeeSupportPopup() {
  try {
    // If user paid, it won't come again for a while!
    if (isCoffeePaidActive()) {
      return;
    }
    // Otherwise, show on every refresh after smooth 1.8s delay
    setTimeout(() => {
      if (!isCoffeePaidActive()) {
        openCoffeeSupportModal();
      }
    }, 1800);
  } catch(e) {}
}
window.initCoffeeSupportPopup = initCoffeeSupportPopup;

function checkCoffeePaymentUrl() {
  try {
    const search = window.location.search;
    if (!search) return;
    const params = new URLSearchParams(search);
    const paymentId = params.get('razorpay_payment_id') || params.get('payment_id') || params.get('tx_id');
    const paySuccess = params.get('pay_success') === 'true' || params.get('razorpay_payment_link_status') === 'paid';
    if (paymentId || paySuccess) {
      recordCoffeePayment(paymentId);
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  } catch(e) {}
}
window.checkCoffeePaymentUrl = checkCoffeePaymentUrl;

function syncCoffeeSettingsUI() {
  const badge = $('settingsCoffeeBadge');
  const body = $('settingsCoffeeBody');
  if (!body) return;

  const isPaid = isCoffeePaidActive();
  if (isPaid) {
    let info = { time: 'Recently', paymentId: 'Verified' };
    try {
      const raw = localStorage.getItem('coffee_paid_info');
      if (raw) info = JSON.parse(raw);
    } catch(e) {}

    const until = Number(localStorage.getItem('coffee_paid_until') || info.validUntil || 0);
    let remainingDaysStr = '7 Days';
    if (until > Date.now()) {
      const daysLeft = Math.max(1, Math.ceil((until - Date.now()) / (24 * 60 * 60 * 1000)));
      remainingDaysStr = `${daysLeft} Day${daysLeft > 1 ? 's' : ''}`;
    }

    if (badge) {
      badge.textContent = `PAID SUPPORTER (${remainingDaysStr.toUpperCase()} LEFT)`;
      badge.className = 'text-[7.5px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold uppercase';
    }

    body.innerHTML = `
      <div class="w-full p-3.5 rounded-2xl bg-gradient-to-r from-emerald-500/15 via-amber-500/10 to-transparent border border-emerald-400/30 space-y-2">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
              <i class="fa-solid fa-circle-check text-xs"></i>
              <span>Supporter Active (${remainingDaysStr} Left)</span>
            </div>
            <p class="text-[9px] text-zinc-300 mt-0.5">
              Thank you for buying a coffee! This popup won't come again for a while${info.validUntilFormatted ? ` (muted until ${info.validUntilFormatted})` : ''}.
            </p>
          </div>
          <span class="text-lg">💛</span>
        </div>
        <div class="flex items-center justify-between pt-1 border-t border-white/[0.08] text-[8.5px] font-mono text-zinc-400">
          <span>Supported at ${info.time || 'Recently'} IST</span>
          <a href="${RAZORPAY_CHECKOUT_URL}" target="_blank" rel="noopener noreferrer" class="text-amber-300 hover:underline">
            Support Again ☕
          </a>
        </div>
      </div>
    `;
  } else {
    if (badge) {
      badge.textContent = 'COMMUNITY FUNDED';
      badge.className = 'text-[7.5px] font-mono px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300 border border-amber-400/30 font-bold uppercase';
    }

    body.innerHTML = `
      <p class="text-[10.5px] text-zinc-300 leading-relaxed font-normal">
        We operate 101 AI prediction models, 24/7 cloud sync, and real-time IST telemetry with zero subscriptions and zero ads. If you enjoy the app, consider supporting with a coffee! 💛
      </p>

      <div class="w-full space-y-2 pt-0.5">
        <a href="${RAZORPAY_CHECKOUT_URL}" target="_blank" rel="noopener noreferrer" class="w-full py-3 px-4 rounded-2xl bg-gradient-to-r from-amber-400 via-orange-400 to-amber-500 hover:from-amber-300 hover:to-orange-400 text-black font-extrabold text-sm tracking-tight flex items-center justify-between shadow-lg shadow-amber-500/20 transition active:scale-[0.98] border border-amber-300/40 cursor-pointer">
          <div class="flex items-center gap-2">
            <span class="text-lg">☕</span>
            <span class="font-black text-xs uppercase tracking-wider">Buy Me a Coffee</span>
          </div>
          <div class="flex items-center gap-1 text-[10px] font-mono font-bold bg-black/15 px-2.5 py-0.5 rounded-full text-black">
            <span>From ₹18</span>
            <i class="fa-solid fa-arrow-up-right-from-square text-[8.5px]"></i>
          </div>
        </a>

        <!-- Quick Tiers -->
        <div class="w-full grid grid-cols-3 gap-1.5 text-[9px] font-mono">
          <a href="${RAZORPAY_CHECKOUT_URL}" target="_blank" rel="noopener noreferrer" class="py-1.5 px-1 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-amber-300 font-bold transition flex items-center justify-center gap-1 active:scale-95">
            <span>☕ ₹18</span>
          </a>
          <a href="${RAZORPAY_CHECKOUT_URL}" target="_blank" rel="noopener noreferrer" class="py-1.5 px-1 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-amber-300 font-bold transition flex items-center justify-center gap-1 active:scale-95">
            <span>🍛 ₹278</span>
          </a>
          <a href="${RAZORPAY_CHECKOUT_URL}" target="_blank" rel="noopener noreferrer" class="py-1.5 px-1 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-amber-300 font-bold transition flex items-center justify-center gap-1 active:scale-95">
            <span>❤️ Any</span>
          </a>
        </div>

        <p class="text-[8.5px] font-mono text-amber-300/80 text-center tracking-tight pt-0.5">
          ✨ After buying a coffee, this won't come again for a while (7 days)
        </p>

        <div class="flex items-center justify-between pt-1 border-t border-white/[0.06] text-[8px] font-mono text-zinc-400">
          <button type="button" onclick="confirmCoffeePaidPrompt()" class="text-amber-300 hover:underline">
            Already supported? Confirm
          </button>
          <span>🔒 Secure UPI / Cards / Razorpay</span>
        </div>
      </div>
    `;
  }
}
window.syncCoffeeSettingsUI = syncCoffeeSettingsUI;

// ── 24B. Settings Panel ────────────────────────────────────────────────────────

function toggleMobileSettings() {
  const modal = $('mobileSettingsModal');
  if (modal) {
    modal.classList.toggle('hidden');
    if (!modal.classList.contains('hidden')) {
      if (typeof syncBackgroundSettingsUI === 'function') syncBackgroundSettingsUI();
      if (typeof syncCoffeeSettingsUI === 'function') syncCoffeeSettingsUI();
    }
  }
}
window.toggleMobileSettings = toggleMobileSettings;

function toggleSoundEffects(on) {
  MobileState.soundEnabled = !!on;
  try { localStorage.setItem('quant_sound', on ? '1' : '0'); } catch(e) {}
  const el = $('settingSoundEffects');
  if (el) el.checked = !!on;
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
        const soundToPlay = _pendingBgSound;
        _pendingBgSound = null;
        playSoundEffect(soundToPlay, true);
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
  if (iframe) { iframe.src = iframe.src; }
}
window.reloadWebIframe = reloadWebIframe;

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
  authToken: null
};
window.MobileBridgeState = MobileBridgeState;

function initMobileDhaniWinBridge() {
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      MobileBridgeState.channel = new BroadcastChannel('dhaniwin_quant_channel');
      MobileBridgeState.channel.onmessage = (ev) => handleMobileBridgeMessage(ev.data);
    } catch(e) {
      console.warn('[Mobile Bridge] BroadcastChannel init error:', e);
    }
  }
  window.addEventListener('message', (ev) => {
    if (ev && ev.data && typeof ev.data === 'object') {
      handleMobileBridgeMessage(ev.data);
    }
  });

  // Restore saved token if available in storage
  try {
    const savedToken = localStorage.getItem('ar_token');
    if (savedToken) {
      MobileBridgeState.authToken = savedToken;
      const parts = savedToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1]));
        if (payload.TenantAccount || payload.UserId) {
          MobileBridgeState.userId = payload.TenantAccount || payload.UserId;
          const uIdEl = $('mobileWebUserId');
          if (uIdEl) uIdEl.textContent = 'ID: ' + MobileBridgeState.userId;
        }
      }
    }
  } catch(e) {}

  calculateAndRenderMobileStake();
  renderMobileWalletStats();
  setupFloatingOrb();

  // ── IFRAME URL MONITOR: Auto-detect login/logout by watching the iframe URL ──
  // This is the most reliable auth detection — no bridge messages required.
  let _lastIframeSrc = '';
  let _iframeWasOnWinGo = false;
  let _sessionOutCount = 0; // Require 3 consecutive checks before clearing session
  setInterval(() => {
    try {
      const iframe = $('dhaniwinIframe');
      if (!iframe || !iframe.src) return;
      const src = iframe.src.toLowerCase();
      if (src === _lastIframeSrc) return; // No change
      _lastIframeSrc = src;

      const isWinGoPage = src.includes('/wingo/') || src.includes('wingo_');
      const isAuthPage = src.includes('/login') || src.includes('/register');

      if (isWinGoPage) {
        // NOTE: cross-origin iframe.src is only the URL WE assigned — it does not prove
        // a live session (DhaniWin may have redirected internally to /login). Never
        // auto-mark login from it.
        _sessionOutCount = 0;
        _iframeWasOnWinGo = true;
      } else if (isAuthPage && _iframeWasOnWinGo) {
        // Do not expire if within post-login grace period
        if (Date.now() < _authGracePeriodUntil) {
          _sessionOutCount = 0;
          return;
        }
        _sessionOutCount++;
        if (_sessionOutCount >= 4) {
          // Confirmed session expired
          _sessionOutCount = 0;
          _iframeWasOnWinGo = false;
          handleDhaniSessionExpired('Session Expired • Please Login');
          console.log('[Mobile Bridge] Session-out confirmed from iframe URL redirect.');
        }
      } else {
        _sessionOutCount = 0;
      }
    } catch(e) {}
  }, 2000);
}



let _syncLogoutCount = 0;

function handleMobileBridgeMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'DHANIWIN_BRIDGE_HANDSHAKE' || msg.type === 'DHANIWIN_BRIDGE_HEARTBEAT') {
    setMobileBridgeStatus(true);
    if (msg.type === 'DHANIWIN_BRIDGE_HANDSHAKE') {
      postMobileBridge({ type: 'UPDATE_BET_SETTINGS', stake: MobileBridgeState.currentStake, maxStake: MobileBridgeState.maxStakeCap, timeframe: MobileState.timeframe });
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
  } else if (msg.type === 'DHANIWIN_SESSION_OUT') {
    // Suppress during post-login transition
    if (isAuthGracePeriodActive()) return;
    handleDhaniSessionExpired('Session Expired • Please Login');
  } else if (msg.type === 'DHANIWIN_SCROLL') {
    // Bridge convention: msg.direction='up' = content moved upward = user scrolled DOWN
    //   → header hides (already was: setHomeHeaderHidden(msg.direction === 'up'))
    //   → dock compacts (scrolling down = compact)
    // msg.direction='down' = content moved downward = user scrolled UP
    //   → header shows, dock expands
    const userScrolledDown = msg.direction === 'up';
    setHomeHeaderHidden(userScrolledDown);
    if (typeof window._dockSetCompact === 'function') window._dockSetCompact(userScrolledDown);
  } else if (msg.type === 'DHANIWIN_AUTH_SUCCESS' || msg.type === 'DHANIWIN_LOGIN_DETECTED') {
    // Mark logged in via ALL keys and set 15s grace period
    markUserLoggedIn();
    _authGracePeriodUntil = Date.now() + 15000;
    _syncLogoutCount = 0;
    setMobileBridgeStatus(true, 'Login Verified ✓');
    showToast('🎉 Login Confirmed! Opening your WinGo interval...', 'success');
    // ISSUE 3 FIX: Load the user's LAST selected interval immediately
    const lastTf = localStorage.getItem('dhaniwin_last_interval') || MobileState.timeframe || '30s';
    const targetUrl = DHANIWIN_INTERVAL_URLS[lastTf] || DHANIWIN_INTERVAL_URLS['30s'];
    // Store the timeframe in MobileState too so the entire app syncs
    MobileState.timeframe = lastTf;
    localStorage.setItem('dhaniwin_last_interval', lastTf);
    loadMobileWebUrl(targetUrl);

  } else if (msg.type === 'DHANIWIN_USER_SYNC') {
    if (msg.balance !== null && msg.balance !== undefined && !isNaN(Number(msg.balance))) {
      MobileBridgeState.userBalance = Number(msg.balance);
      const balEl = $('mobileWebBalance');
      if (balEl) balEl.textContent = '₹' + MobileBridgeState.userBalance.toFixed(2);
    }
    if (msg.isLoggedIn) {
      _syncLogoutCount = 0;
      markUserLoggedIn();
    } else if (msg.isLoggedIn === false && msg.url && (msg.url.toLowerCase().includes('/login') || msg.url.toLowerCase().includes('/register'))) {
      if (Date.now() >= _authGracePeriodUntil && isUserLoggedIn()) {
        _syncLogoutCount = (_syncLogoutCount || 0) + 1;
        if (_syncLogoutCount >= 3) {
          _syncLogoutCount = 0;
          handleDhaniSessionExpired('Session Expired');
        }
      }
    } else {
      _syncLogoutCount = 0;
    }
    if (msg.token) {
      markUserLoggedIn();
      try { localStorage.setItem('ar_token', msg.token); } catch(e) {}
      if (!MobileBridgeState.authToken) {
        MobileBridgeState.authToken = msg.token;
        try {
          const parts = msg.token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(atob(parts[1]));
            if (payload.TenantAccount || payload.UserId) {
              MobileBridgeState.userId = payload.TenantAccount || payload.UserId;
              const uIdEl = $('mobileWebUserId');
              if (uIdEl) uIdEl.textContent = 'ID: ' + MobileBridgeState.userId;
            }
          }
        } catch(e) {}
      }
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
      const soundCb = $('settingSoundEffects');
      if (soundCb) soundCb.checked = MobileState.soundEnabled;
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
  const url = (iframe && iframe.src) || (link && link.href) || 'https://dhaniwin44.com/WinGo/WinGo_30S';
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
  // STRICT REQUIREMENT: Maximum 3 levels allowed (Level 1 = 1x, Level 2 = 2x, Level 3 = 4x).
  // Under NO circumstances may multiplier or stake advance to Level 4 (> 3 consecutive losses)!
  const safeLevel = Math.min(2, Math.max(0, MobileBridgeState.currentLevel || 0));
  MobileBridgeState.currentLevel = safeLevel;
  const unconstrainedStake = Math.round(MobileBridgeState.baseStake * Math.pow(MobileBridgeState.multiplier, safeLevel));
  // Don't double more than maxStakeCap
  MobileBridgeState.currentStake = Math.min(unconstrainedStake, MobileBridgeState.maxStakeCap);
  try { localStorage.setItem('dhaniwin_active_stake', String(MobileBridgeState.currentStake)); } catch(e) {}

  const stakeEl = $('mobileWebStakeDisplay');
  const lvlEl = $('mobileWebLevelBadge');
  if (stakeEl) stakeEl.textContent = '₹' + MobileBridgeState.currentStake;
  if (lvlEl) {
    if (unconstrainedStake > MobileBridgeState.maxStakeCap) {
      lvlEl.textContent = `Level ${MobileBridgeState.currentLevel + 1} (Capped @ ₹${MobileBridgeState.maxStakeCap})`;
      lvlEl.className = 'text-[8px] font-mono font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30';
    } else {
      lvlEl.textContent = `Level ${MobileBridgeState.currentLevel + 1}` + (MobileBridgeState.currentLevel > 0 ? ` (Loss x${MobileBridgeState.currentLevel})` : ' (Base)');
      lvlEl.className = MobileBridgeState.currentLevel > 0 
        ? 'text-[8px] font-mono font-bold px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 animate-pulse'
        : 'text-[8px] font-mono font-bold px-1.5 py-0.5 rounded bg-white/10 text-amber-300 border border-white/10';
    }
  }
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

function toggleMobileRealAutoBet(forceState) {
  if (forceState !== undefined) {
    MobileBridgeState.enabled = !!forceState;
  } else {
    MobileBridgeState.enabled = !MobileBridgeState.enabled;
  }
  const btn = $('mobileBridgeToggleBtn');
  if (btn) {
    if (MobileBridgeState.enabled) {
      btn.className = 'px-2.5 py-1 rounded-lg font-mono text-[8.5px] font-black bg-rose-500/25 text-rose-300 border border-rose-500/40 active:scale-95 transition shadow';
      btn.textContent = '⏹ STOP PREP';
      setMobileBridgeStatus(MobileBridgeState.connected, 'Auto-Prep Active');
      dispatchMobileBetOrder();
    } else {
      btn.className = 'px-2.5 py-1 rounded-lg font-mono text-[8.5px] font-black bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 active:scale-95 transition shadow';
      btn.textContent = '▶ ACTIVATE PREP';
      setMobileBridgeStatus(MobileBridgeState.connected, 'Standby');
    }
  }
}
window.toggleMobileRealAutoBet = toggleMobileRealAutoBet;
window.toggleRealAutoBet = toggleMobileRealAutoBet;

function dispatchMobileBetOrder(targetOverride) {
  // Check if 3-Loss Circuit Breaker is active / cool-off pause in progress
  if (MobileBridgeState.circuitBreakerPauseRounds > 0) {
    setMobileBridgeStatus(false, `🛡️ Circuit Breaker: Paused (${MobileBridgeState.circuitBreakerPauseRounds}R left)`);
    return;
  }

  // Strict Safety Guard: Under no conditions allow dispatch if consecutive losses reached 3
  if (MobileBridgeState.consecutiveLosses >= 3) {
    MobileBridgeState.circuitBreakerActive = true;
    MobileBridgeState.circuitBreakerPauseRounds = 2;
    MobileBridgeState.currentLevel = 0;
    MobileBridgeState.currentStake = MobileBridgeState.baseStake || 2;
    MobileBridgeState.consecutiveLosses = 0;
    setMobileBridgeStatus(false, `🛡️ Circuit Breaker: Tripped on 3 losses. Paused for 2R.`);
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

  const targetEl = $('mobileWebTargetDisplay');
  if (targetEl) {
    targetEl.textContent = target;
    targetEl.className = `text-lg font-black ${
      target === 'BIG' ? 'text-amber-300' :
      target === 'SMALL' ? 'text-sky-300' :
      target === 'GREEN' ? 'text-emerald-400' :
      target === 'RED' ? 'text-rose-400' : 'text-white'
    }`;
  }

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
  setMobileBridgeStatus(true, `👉 Ready: ${target} ₹${MobileBridgeState.currentStake} (Tap Bet)`);
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
  if (iframe) iframe.src = url;
  if (barText) barText.textContent = url;
  if (extLink) extLink.href = url;
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
  const amount = Number(amt) || 2;
  MobileBridgeState.baseStake = amount;
  [1, 2, 5, 10, 50, 100].forEach(chip => {
    const btn = $(`chipBtn-${chip}`);
    if (btn) {
      if (chip === amount) {
        btn.className = 'py-1 rounded-lg font-mono text-[9.5px] font-bold bg-amber-500/25 text-amber-300 border border-amber-500/40 active:scale-95';
      } else {
        btn.className = 'py-1 rounded-lg font-mono text-[9.5px] font-bold bg-white/5 text-zinc-300 border border-white/5 active:scale-95';
      }
    }
  });
  calculateAndRenderMobileStake();
  if (typeof playSoundEffect === 'function') playSoundEffect('click');
}
window.setAssistantBaseStake = setAssistantBaseStake;

function updateAssistantLossLimit(val) {
  const limit = Math.max(5, Number(val) || 100);
  MobileBridgeState.stopLoss = limit;
  const input = $('mobileWebStopLossLimit');
  if (input) input.value = limit;
}
window.updateAssistantLossLimit = updateAssistantLossLimit;

function renderAssistantMiniRoad(list) {
  const container = $('assistantMiniRoad');
  if (!container || !list || list.length === 0) return;
  const display = [...list].reverse().slice(0, 8);
  container.innerHTML = display.map((r) => {
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
      <div class="ball-3d ${ballBg} w-6 h-6 rounded-full flex items-center justify-center font-mono font-black text-[10px] text-white shadow-sm">
        ${n}
      </div>
      ${badge}
      <span class="text-[6.5px] font-mono text-zinc-500 mt-0.5">${String(r.period).slice(-3)}</span>
    </div>`;
  }).join('');
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

function triggerAppleMoneyRain(profit, streak) {
  dismissAppleMoneyRain();

  const container = $('appleMoneyRainContainer');
  const canvas = $('appleMoneyRainCanvas');
  const winTitle = $('appleMoneyWinTitle');
  const winBadge = $('appleMoneyWinBadge');
  if (!container || !canvas) return;

  const pStr = (profit && profit > 0) ? `+₹${Number(profit).toFixed(2)}` : '+₹2.00';
  const sStr = streak > 1 ? ` • 🔥 ${streak}W` : '';
  if (winTitle) winTitle.textContent = 'PREDICTION WON';
  if (winBadge) winBadge.textContent = `${pStr}${sStr}`;

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

// ── 30. Floating AssistiveTouch Circle Assistant & Modal Hub ──────────────────

function toggleDhaniwinAssistantModal(show) {
  const modal = $('dhaniwinAssistantModal');
  if (!modal) return;
  if (show === undefined) {
    modal.classList.toggle('hidden');
  } else if (show) {
    modal.classList.remove('hidden');
  } else {
    modal.classList.add('hidden');
  }
}
window.toggleDhaniwinAssistantModal = toggleDhaniwinAssistantModal;

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

  const target = MobileState.activePrediction?.target || 'BIG';
  const targetEl = $('floatingOrbTarget');
  const stakeEl = $('floatingOrbStake');
  const iconEl = $('floatingOrbIcon');
  const ringEl = $('floatingOrbRing');
  const pingEl = $('floatingOrbDotPing');
  const dotEl = $('floatingOrbDot');

  if (targetEl) targetEl.textContent = target;
  if (stakeEl) stakeEl.textContent = '₹' + MobileBridgeState.currentStake;

  let shadowColor = 'rgba(16,185,129,0.55)';
  let targetClass = 'text-amber-300';
  let icon = '🎯';

  if (target === 'BIG') {
    targetClass = 'text-amber-300';
    shadowColor = 'rgba(245,158,11,0.6)';
    icon = '▲';
  } else if (target === 'SMALL') {
    targetClass = 'text-sky-300';
    shadowColor = 'rgba(56,189,248,0.6)';
    icon = '▼';
  } else if (target === 'GREEN') {
    targetClass = 'text-emerald-300';
    shadowColor = 'rgba(16,185,129,0.6)';
    icon = '🟢';
  } else if (target === 'RED') {
    targetClass = 'text-rose-300';
    shadowColor = 'rgba(244,63,94,0.6)';
    icon = '🔴';
  }

  if (targetEl) targetEl.className = `text-[8.5px] font-black font-mono leading-tight ${targetClass}`;
  if (iconEl) iconEl.textContent = icon;
  if (ringEl) ringEl.style.boxShadow = `0 4px 24px ${shadowColor}`;

  if (pingEl && dotEl) {
    if (MobileBridgeState.enabled) {
      pingEl.className = 'absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-black animate-ping';
      dotEl.className = 'absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-black';
    } else {
      pingEl.className = 'hidden';
      dotEl.className = 'absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-amber-400 border-2 border-black';
    }
  }
}
window.updateFloatingOrbUI = updateFloatingOrbUI;

function setupFloatingOrb() {
  const orb = $('dhaniwinFloatingOrb');
  if (!orb) return;

  // Restore saved position if available
  try {
    const rawPos = localStorage.getItem('dhaniwin_orb_pos');
    if (rawPos) {
      const pos = JSON.parse(rawPos);
      if (typeof pos.left === 'number' && typeof pos.top === 'number') {
        orb.style.left = `${Math.min(window.innerWidth - 66, Math.max(10, pos.left))}px`;
        orb.style.top = `${Math.min(window.innerHeight - 80, Math.max(10, pos.top))}px`;
        orb.style.right = 'auto';
        orb.style.bottom = 'auto';
      }
    }
  } catch(e) {}

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

    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      hasMoved = true;
    }

    if (hasMoved) {
      if (e.cancelable && e.preventDefault) e.preventDefault();
      const newLeft = Math.max(8, Math.min(window.innerWidth - 64, startLeft + dx));
      const newTop = Math.max(10, Math.min(window.innerHeight - 76, startTop + dy));
      orb.style.left = `${newLeft}px`;
      orb.style.top = `${newTop}px`;
      orb.style.right = 'auto';
      orb.style.bottom = 'auto';
    }
  }

  function onPointerUp(e) {
    if (!isDragging) return;
    isDragging = false;
    orb.style.transition = 'transform 0.2s ease, left 0.3s cubic-bezier(0.25, 1, 0.5, 1), top 0.3s cubic-bezier(0.25, 1, 0.5, 1)';

    if (!hasMoved) {
      // Tap detected: toggle assistant modal silently (no sound on floating ball)
      toggleDhaniwinAssistantModal();
      return;
    }

    // Magnetic edge snap (left or right)
    const rect = orb.getBoundingClientRect();
    const midX = window.innerWidth / 2;
    const targetLeft = rect.left < midX ? 12 : window.innerWidth - 68;
    const targetTop = Math.max(14, Math.min(window.innerHeight - 84, rect.top));

    orb.style.left = `${targetLeft}px`;
    orb.style.top = `${targetTop}px`;
    orb.style.right = 'auto';
    orb.style.bottom = 'auto';

    try {
      localStorage.setItem('dhaniwin_orb_pos', JSON.stringify({ left: targetLeft, top: targetTop }));
    } catch(e) {}
  }

  orb.addEventListener('touchstart', onPointerDown, { passive: true });
  window.addEventListener('touchmove', onPointerMove, { passive: false });
  window.addEventListener('touchend', onPointerUp, { passive: true });

  orb.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);

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

  console.log('[Mobile] 01:01 Quant AI initializing...');

  // Initialize Web Worker Compute Engine
  try { initModelWorker(); } catch(e) { console.warn('[Mobile] Worker init error:', e); }

  // Initialize DhaniWin Real Loss Recovery & Pre-Fill Bridge
  try { initMobileDhaniWinBridge(); } catch(e) { console.warn('[Mobile] Bridge init error:', e); }

  // Restore settings
  try {
    MobileState.soundEnabled = localStorage.getItem('quant_sound') !== '0';
    const soundCb = $('settingSoundEffects');
    if (soundCb) soundCb.checked = MobileState.soundEnabled;
    MobileState.hapticsEnabled = localStorage.getItem('quant_haptics') !== '0';
    MobileState.autoMode = localStorage.getItem('quant_arena_auto') !== '0';
    MobileState.chartMode = localStorage.getItem('quant_chart_mode') || 'candles';
  } catch(e) {}

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
      renderHeroSequentialBallRoad(initialList);
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
  checkCoffeePaymentUrl();
  syncCoffeeSettingsUI();

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

