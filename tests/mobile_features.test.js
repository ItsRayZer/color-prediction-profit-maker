import test from 'node:test';
import assert from 'node:assert/strict';

test('Mobile Interval Popup & State Isolation', async (t) => {
  // Mock MobileState
  const MobileState = {
    timeframe: '30s',
    historyByTf: {
      '30s': [{ period: '20261002100010001', number: 8, size: 'BIG', color: 'RED' }],
      '1m':  [{ period: '20261002100020001', number: 3, size: 'SMALL', color: 'GREEN' }]
    }
  };

  let celebrationCalls = [];
  function showWinLossCelebration(isWin, target, number, size, color, periodStr, simProfit, tf) {
    celebrationCalls.push({ tf, periodStr, isWin });
  }

  function simulateSettle(tf, periodStr, isWin) {
    if (tf === MobileState.timeframe) {
      showWinLossCelebration(isWin, 'BIG', 8, 'BIG', 'RED', periodStr, null, tf);
    }
  }

  await t.test('settle in background 1m timeframe does NOT trigger celebration when on 30s', () => {
    celebrationCalls = [];
    simulateSettle('1m', '20261002100020002', true);
    assert.equal(celebrationCalls.length, 0, 'Should not trigger celebration for background timeframe');
  });

  await t.test('settle in active 30s timeframe DOES trigger celebration', () => {
    celebrationCalls = [];
    simulateSettle('30s', '20261002100010002', true);
    assert.equal(celebrationCalls.length, 1, 'Should trigger celebration for active timeframe');
    assert.equal(celebrationCalls[0].tf, '30s');
  });

  await t.test('switching active timeframe to 1m isolates celebrations to 1m only', () => {
    MobileState.timeframe = '1m';
    celebrationCalls = [];
    // 30s settles in background
    simulateSettle('30s', '20261002100010003', true);
    assert.equal(celebrationCalls.length, 0, '30s celebration should be suppressed when 1m is active');

    // 1m settles
    simulateSettle('1m', '20261002100020003', true);
    assert.equal(celebrationCalls.length, 1, '1m celebration should fire when 1m is active');
    assert.equal(celebrationCalls[0].tf, '1m');
  });
});

test('Sequential Prediction Road Ball Styling & Ordering', async (t) => {
  const BALL_COLOR_CLASSES = [
    'ball-split-0', 'ball-green', 'ball-red', 'ball-green', 'ball-red',
    'ball-split-5', 'ball-red', 'ball-green', 'ball-red', 'ball-green'
  ];

  function getBallBg(n) {
    if (n === 0) return 'ball-split-0';
    if (n === 5) return 'ball-split-5';
    if (n === 1 || n === 3 || n === 7 || n === 9) return 'ball-green';
    return 'ball-red';
  }

  await t.test('0 and 5 have mixed split colors', () => {
    assert.equal(getBallBg(0), 'ball-split-0');
    assert.equal(getBallBg(5), 'ball-split-5');
    assert.equal(BALL_COLOR_CLASSES[0], 'ball-split-0');
    assert.equal(BALL_COLOR_CLASSES[5], 'ball-split-5');
  });

  await t.test('1, 3, 7, 9 are green and 2, 4, 6, 8 are red', () => {
    [1, 3, 7, 9].forEach(n => assert.equal(getBallBg(n), 'ball-green'));
    [2, 4, 6, 8].forEach(n => assert.equal(getBallBg(n), 'ball-red'));
  });

  await t.test('Universal ordering: newest on LEFT (index 0), older to RIGHT', () => {
    // Array in chronological order (oldest to newest)
    const list = [
      { period: '1001', number: 2 },
      { period: '1002', number: 5 },
      { period: '1003', number: 0 },
      { period: '1004', number: 7 } // newest
    ];

    // Reversing gives leftmost index 0 = newest
    const display = [...list].reverse();
    assert.equal(display[0].period, '1004', 'Leftmost ball must be the newest round');
    assert.equal(display[0].number, 7);
    assert.equal(display[1].period, '1003');
    assert.equal(display[display.length - 1].period, '1001', 'Rightmost ball must be the oldest round');
  });
});

test('Mobile Draw History View Switching (Table vs Graph)', async (t) => {
  let activeView = 'table';
  function switchView(mode) {
    activeView = mode;
    return activeView;
  }

  assert.equal(activeView, 'table');
  assert.equal(switchView('graph'), 'graph');
  assert.equal(switchView('table'), 'table');
});

test('Real Win Streak Calculation and Loss Reset (No Fake Demo Data)', async (t) => {
  function calculateConsecutiveWinStreak(history) {
    let streak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const row = history[i];
      if (row.result === 'WIN' || row.aiCorrect === true) {
        streak++;
      } else if (row.result === 'LOSS' || row.aiCorrect === false) {
        break; // Strictly resets on loss
      }
    }
    return streak;
  }

  await t.test('Streak is 0 when latest outcome was a loss', () => {
    const hist = [
      { period: '1', result: 'WIN' },
      { period: '2', result: 'WIN' },
      { period: '3', result: 'LOSS' }
    ];
    assert.equal(calculateConsecutiveWinStreak(hist), 0, 'Streak must strictly be 0 after a loss');
  });

  await t.test('Streak increments on consecutive wins and ignores historical past losses', () => {
    const hist = [
      { period: '1', result: 'LOSS' },
      { period: '2', result: 'WIN' },
      { period: '3', result: 'WIN' },
      { period: '4', result: 'WIN' }
    ];
    assert.equal(calculateConsecutiveWinStreak(hist), 3, 'Streak should be exactly 3');
  });

  await t.test('Streak resets to 0 immediately when a new round loses', () => {
    const hist = [
      { period: '1', result: 'WIN' },
      { period: '2', result: 'WIN' },
      { period: '3', result: 'WIN' },
      { period: '4', result: 'LOSS' }
    ];
    assert.equal(calculateConsecutiveWinStreak(hist), 0, 'Streak must immediately reset to 0 upon a loss');
  });
});

test('Sound Effects Debounce & Interruption Protection', async (t) => {
  let playedSounds = [];
  let lastSoundTimestamp = 0;

  function mockPlaySoundEffect(type, currentTimeMs) {
    if (type === 'win' || type === 'loss') {
      if (lastSoundTimestamp && (currentTimeMs - lastSoundTimestamp < 1800)) {
        return false; // Throttled / suppressed duplicate sound
      }
      lastSoundTimestamp = currentTimeMs;
    }
    playedSounds.push({ type, timestamp: currentTimeMs });
    return true;
  }

  await t.test('Rapid succession win/loss sounds are throttled to prevent cacophony', () => {
    playedSounds = [];
    lastSoundTimestamp = 0;

    // First win sound plays
    const res1 = mockPlaySoundEffect('win', 1000);
    assert.equal(res1, true);
    assert.equal(playedSounds.length, 1);

    // Second sound triggers 200ms later (e.g. from race condition or overlapping events)
    const res2 = mockPlaySoundEffect('loss', 1200);
    assert.equal(res2, false, 'Rapid second sound must be suppressed');
    assert.equal(playedSounds.length, 1);

    // Another sound triggers 500ms later
    const res3 = mockPlaySoundEffect('win', 1500);
    assert.equal(res3, false, 'Sound within 1800ms cooldown must be suppressed');
    assert.equal(playedSounds.length, 1);

    // Sound after 2000ms plays normally
    const res4 = mockPlaySoundEffect('win', 3000);
    assert.equal(res4, true);
    assert.equal(playedSounds.length, 2);
  });
});

test('Strict Round-Locking of Predictions (No Mid-Round Glitching)', async (t) => {
  const scheduledPredictions = {};

  function getOrLockPrediction(tf, periodStr, generatorFn) {
    if (!scheduledPredictions[tf]) scheduledPredictions[tf] = {};
    if (scheduledPredictions[tf][periodStr]?.target) {
      return scheduledPredictions[tf][periodStr]; // Return locked prediction
    }
    const fresh = generatorFn();
    scheduledPredictions[tf][periodStr] = fresh;
    return fresh;
  }

  let counter = 0;
  // Flapping generator that would normally toggle between BIG and SMALL on every call
  const flappingGenerator = () => {
    counter++;
    return { target: counter % 2 === 1 ? 'BIG' : 'SMALL', conf: 0.85 };
  };

  const roundPeriod = '20261003100050100';
  const firstPred = getOrLockPrediction('30s', roundPeriod, flappingGenerator);
  assert.equal(firstPred.target, 'BIG');

  // Consecutive calls during the same round (simulating polling, worker messages, clock ticks)
  for (let i = 0; i < 10; i++) {
    const lockedPred = getOrLockPrediction('30s', roundPeriod, flappingGenerator);
    assert.equal(lockedPred.target, 'BIG', `Prediction must remain locked on BIG for round ${roundPeriod}`);
  }

  // Next round advances: new prediction is generated and locked
  const nextRoundPeriod = '20261003100050101';
  const nextPred = getOrLockPrediction('30s', nextRoundPeriod, flappingGenerator);
  assert.equal(nextPred.target, 'SMALL');

  // Remains locked for the new round
  for (let i = 0; i < 5; i++) {
    const lockedNext = getOrLockPrediction('30s', nextRoundPeriod, flappingGenerator);
    assert.equal(lockedNext.target, 'SMALL', `Prediction must remain locked on SMALL for round ${nextRoundPeriod}`);
  }
});

test('Single-Instance Win/Loss Concurrency & Non-Win/Loss Sound Suppression', async (t) => {
  let activeAudio = null;
  let playedCount = 0;
  let lastTimestamp = 0;
  let isAuth = true;

  function mockStopAllSoundEffects() {
    if (activeAudio) {
      activeAudio.paused = true;
      activeAudio = null;
    }
  }

  function mockPlaySoundEffect(type, nowMs) {
    if (type !== 'win' && type !== 'loss') return false; // Strictly only win and loss
    if (!isAuth) return false; // Suppressed before login
    if (nowMs - lastTimestamp < 2000) return false; // Throttled

    lastTimestamp = nowMs;
    mockStopAllSoundEffects(); // Enforces strictly 1 sound at a time

    activeAudio = { type, paused: false };
    playedCount++;
    return true;
  }

  await t.test('Non-win/loss sounds like "click" are rejected and produce no sound', () => {
    const res = mockPlaySoundEffect('click', 1000);
    assert.equal(res, false, 'Click sound must be ignored completely');
    assert.equal(activeAudio, null);
    assert.equal(playedCount, 0);
  });

  await t.test('Win/loss sounds cancel any previous playing audio before starting new', () => {
    const res1 = mockPlaySoundEffect('win', 2000);
    assert.equal(res1, true);
    assert.equal(activeAudio?.type, 'win');

    // 2500ms later (after cooldown), next sound plays and terminates previous
    const res2 = mockPlaySoundEffect('loss', 4500);
    assert.equal(res2, true);
    assert.equal(activeAudio?.type, 'loss');
    assert.equal(playedCount, 2);
  });

  await t.test('Win/loss sounds are strictly suppressed when user is not logged in', () => {
    isAuth = false;
    const res = mockPlaySoundEffect('win', 8000);
    assert.equal(res, false, 'Must not play sound when user is not confirmed logged in');
    isAuth = true;
  });
});

test('Floating Assistant Orb Silence & Action Handling', async (t) => {
  let modalToggled = false;
  let soundTriggered = false;

  function mockToggleModal() {
    modalToggled = !modalToggled;
  }

  function mockOrbTap(hasMoved) {
    if (!hasMoved) {
      mockToggleModal();
      // Notice: No playSoundEffect call!
    }
  }

  await t.test('Tapping the floating ball toggles the assistant modal with zero sound', () => {
    modalToggled = false;
    soundTriggered = false;

    mockOrbTap(false); // tap without drag
    assert.equal(modalToggled, true, 'Modal should be toggled');
    assert.equal(soundTriggered, false, 'No sound must ever play on orb tap');
  });

  await t.test('Dragging the floating ball does not toggle modal or play sound', () => {
    modalToggled = false;
    mockOrbTap(true); // drag
    assert.equal(modalToggled, false, 'Dragging should not open modal');
  });
});

test('High-Confidence Notification Card Removal from Analyse Page', async (t) => {
  let cardRemoved = false;
  const mockCard = {
    style: { display: 'flex' },
    remove: () => { cardRemoved = true; }
  };

  function dismissOrRemoveCard() {
    mockCard.style.display = 'none';
    mockCard.remove();
  }

  await t.test('Granting permission or enabling alert completely removes the card from DOM', () => {
    cardRemoved = false;
    dismissOrRemoveCard();
    assert.equal(mockCard.style.display, 'none');
    assert.equal(cardRemoved, true, 'Card must be removed from Analyse page');
  });
});

test('Bottom Navigation 3-Tab Dock Configuration', async (t) => {
  const dockTabs = ['web', 'home', 'ai']; // Simulation is removed

  await t.test('Dock contains exactly 3 tabs: Home, Analyse, and AI Adaptive', () => {
    assert.equal(dockTabs.length, 3, 'Must contain exactly 3 navigation tabs');
    assert.ok(dockTabs.includes('web'), 'Home (Web) must be present');
    assert.ok(dockTabs.includes('home'), 'Analyse must be present');
    assert.ok(dockTabs.includes('ai'), 'AI Adaptive must be present');
    assert.equal(dockTabs.includes('sim'), false, 'Simulation tab must be removed');
  });
});

test('Smart Auth Routing & Session Persistence', async (t) => {
  const urlMap = {
    '30s': 'https://dhaniwin44.com/WinGo/WinGo_30S',
    '1m':  'https://dhaniwin44.com/WinGo/WinGo_1M',
    '3m':  'https://dhaniwin44.com/WinGo/WinGo_3M',
    '5m':  'https://dhaniwin44.com/WinGo/WinGo_5M'
  };
  const regUrl = 'https://dhaniwin44.com/register?inviteCode=EEJKXQN&from=app';

  function resolveStartupUrl(isLoggedIn, lastInterval) {
    if (isLoggedIn) {
      return urlMap[lastInterval] || urlMap['30s'];
    }
    return regUrl;
  }

  await t.test('Unauthenticated user receives registration URL on startup', () => {
    const url = resolveStartupUrl(false, '30s');
    assert.equal(url, regUrl);
  });

  await t.test('Authenticated user automatically loads last selected interval (e.g. 1M)', () => {
    const url = resolveStartupUrl(true, '1m');
    assert.equal(url, 'https://dhaniwin44.com/WinGo/WinGo_1M');
  });

  await t.test('Authenticated user with 5M interval loads 5M WinGo page', () => {
    const url = resolveStartupUrl(true, '5m');
    assert.equal(url, 'https://dhaniwin44.com/WinGo/WinGo_5M');
  });

  await t.test('Session timeout / logout switches back to registration URL', () => {
    let loggedIn = true;
    // Session out event received
    loggedIn = false;
    const url = resolveStartupUrl(loggedIn, '1m');
    assert.equal(url, regUrl, 'Must revert to registration on session timeout');
  });
});

test('Background Run, Wake Lock & Battery Optimization Workflow', async (t) => {
  const mockStorage = new Map();
  const localStorageMock = {
    getItem: (k) => mockStorage.get(k) || null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
    removeItem: (k) => mockStorage.delete(k)
  };

  const MobileState = {
    bgKeepAliveEnabled: true,
    wakeLockEnabled: false
  };

  let audioPlaying = false;
  let wakeLockActive = false;
  let permissionModalVisible = false;
  let batteryGuideVisible = false;

  function toggleBackgroundKeepAlive(on) {
    MobileState.bgKeepAliveEnabled = !!on;
    localStorageMock.setItem('quant_bg_keepalive', on ? '1' : '0');
    audioPlaying = !!on;
  }

  function toggleWakeLock(on) {
    MobileState.wakeLockEnabled = !!on;
    localStorageMock.setItem('quant_wakelock', on ? '1' : '0');
    wakeLockActive = !!on;
  }

  function checkAndPromptBackgroundPermission() {
    const alreadyPrompted = localStorageMock.getItem('quant_bg_permission_prompted') === '1';
    if (!alreadyPrompted) {
      permissionModalVisible = true;
    }
  }

  function allowBackgroundRunAll() {
    toggleBackgroundKeepAlive(true);
    toggleWakeLock(true);
    permissionModalVisible = false;
    localStorageMock.setItem('quant_bg_permission_prompted', '1');
  }

  function dismissBackgroundPermissionModal() {
    permissionModalVisible = false;
    localStorageMock.setItem('quant_bg_permission_prompted', '1');
  }

  function toggleBatteryGuideModal(show) {
    batteryGuideVisible = !!show;
  }

  await t.test('First launch triggers starting permission prompt', () => {
    checkAndPromptBackgroundPermission();
    assert.equal(permissionModalVisible, true, 'Starting permission sheet should be presented on first launch');
  });

  await t.test('allowBackgroundRunAll activates Keep-Alive, Wake Lock, and marks prompted', () => {
    allowBackgroundRunAll();
    assert.equal(MobileState.bgKeepAliveEnabled, true, 'Keep-alive should be enabled');
    assert.equal(audioPlaying, true, 'Silent audio loop should be active');
    assert.equal(MobileState.wakeLockEnabled, true, 'Wake lock should be enabled');
    assert.equal(wakeLockActive, true, 'Screen wake lock should be active');
    assert.equal(permissionModalVisible, false, 'Modal should be dismissed');
    assert.equal(localStorageMock.getItem('quant_bg_permission_prompted'), '1');
    assert.equal(localStorageMock.getItem('quant_bg_keepalive'), '1');
    assert.equal(localStorageMock.getItem('quant_wakelock'), '1');
  });

  await t.test('Subsequent launches do not re-prompt starting sheet', () => {
    permissionModalVisible = false;
    checkAndPromptBackgroundPermission();
    assert.equal(permissionModalVisible, false, 'Should not re-prompt once user configured');
  });

  await t.test('User can toggle Keep-Alive and Wake Lock independently in Settings', () => {
    toggleBackgroundKeepAlive(false);
    assert.equal(MobileState.bgKeepAliveEnabled, false);
    assert.equal(audioPlaying, false);
    assert.equal(localStorageMock.getItem('quant_bg_keepalive'), '0');

    toggleWakeLock(false);
    assert.equal(MobileState.wakeLockEnabled, false);
    assert.equal(wakeLockActive, false);
    assert.equal(localStorageMock.getItem('quant_wakelock'), '0');
  });

  await t.test('Battery guide modal can be opened and dismissed', () => {
    toggleBatteryGuideModal(true);
    assert.equal(batteryGuideVisible, true);
    toggleBatteryGuideModal(false);
    assert.equal(batteryGuideVisible, false);
  });
});

test('R1: Tab Navigation, Persistence & Dock Compaction Rules', async (t) => {
  const mockStorage = new Map();
  const localStorageMock = {
    getItem: (k) => mockStorage.get(k) || null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
    removeItem: (k) => mockStorage.delete(k)
  };

  function getInitialStartupTab() {
    return localStorageMock.getItem('active_mobile_tab') || 'web';
  }

  function switchMobileTabMock(tabId) {
    localStorageMock.setItem('active_mobile_tab', tabId);
    return tabId;
  }

  function shouldAutoCompactDock(currentTab, isScrolledDown) {
    if (currentTab !== 'home' && currentTab !== 'web') {
      return false; // Leave dock expanded on non-home tabs
    }
    return Boolean(isScrolledDown);
  }

  await t.test('Default startup tab is web (Home DhaniWin) when no preference stored', () => {
    assert.equal(getInitialStartupTab(), 'web');
  });

  await t.test('Switching tab persists active tab to localStorage', () => {
    switchMobileTabMock('analyse');
    assert.equal(getInitialStartupTab(), 'analyse');
    switchMobileTabMock('web');
    assert.equal(getInitialStartupTab(), 'web');
  });

  await t.test('Dock compaction triggers only on Home/Web tab when scrolling down', () => {
    assert.equal(shouldAutoCompactDock('web', true), true);
    assert.equal(shouldAutoCompactDock('web', false), false);
    assert.equal(shouldAutoCompactDock('analyse', true), false, 'Non-home tabs should keep dock expanded');
    assert.equal(shouldAutoCompactDock('chart', true), false, 'Non-home tabs should keep dock expanded');
  });
});

test('R2: Floating Assistant Orb & Dynamic Countdown Ring Logic', async (t) => {
  const CIRCUMFERENCE = 2 * Math.PI * 30; // 188.495...

  function computeOrbRingState(secsLeft, secsTotal = 30) {
    const fraction = Math.max(0, Math.min(1, secsLeft / secsTotal));
    const offset = CIRCUMFERENCE * (1 - fraction);
    let color = '#34c759'; // Emerald green
    if (secsLeft <= 5) {
      color = '#ef4444'; // Neon red
    } else if (secsLeft <= 10) {
      color = '#f59e0b'; // Amber
    }
    return {
      offset: Number(offset.toFixed(2)),
      color,
      fraction: Number(fraction.toFixed(3))
    };
  }

  await t.test('Ring circumference is approx 188.5 for radius 30', () => {
    assert.ok(Math.abs(CIRCUMFERENCE - 188.495) < 0.01);
  });

  await t.test('Color is emerald green when > 10s remaining', () => {
    const s25 = computeOrbRingState(25, 30);
    assert.equal(s25.color, '#34c759');
    const s11 = computeOrbRingState(11, 30);
    assert.equal(s11.color, '#34c759');
  });

  await t.test('Color is amber when 6s to 10s remaining', () => {
    const s10 = computeOrbRingState(10, 30);
    assert.equal(s10.color, '#f59e0b');
    const s6 = computeOrbRingState(6, 30);
    assert.equal(s6.color, '#f59e0b');
  });

  await t.test('Color is neon red when <= 5s remaining', () => {
    const s5 = computeOrbRingState(5, 30);
    assert.equal(s5.color, '#ef4444');
    const s1 = computeOrbRingState(1, 30);
    assert.equal(s1.color, '#ef4444');
    const s0 = computeOrbRingState(0, 30);
    assert.equal(s0.color, '#ef4444');
  });

  await t.test('Stroke offset smoothly progresses from 0 at start to CIRCUMFERENCE at 0s', () => {
    const start = computeOrbRingState(30, 30);
    assert.equal(start.offset, 0);
    const half = computeOrbRingState(15, 30);
    assert.ok(Math.abs(half.offset - (CIRCUMFERENCE / 2)) < 0.1);
    const end = computeOrbRingState(0, 30);
    assert.ok(Math.abs(end.offset - CIRCUMFERENCE) < 0.1);
  });
});

test('R3: Win Streak Dollar Rain Particle Scaling & Audio Throttling', async (t) => {
  function computeRainParticles(width, streak) {
    const baseCount = Math.min(36, Math.max(16, Math.floor(width / 11)));
    const streakCount = Math.max(1, Number(streak) || 1);
    return Math.min(120, Math.floor(baseCount + (streakCount - 1) * 8));
  }

  let playedSounds = [];
  let pendingBgSound = null;
  let documentHidden = false;

  function playSound(type) {
    if (documentHidden) {
      pendingBgSound = type;
      return false;
    }
    playedSounds.push(type);
    return true;
  }

  function onRefocus() {
    if (pendingBgSound) {
      const soundToPlay = pendingBgSound;
      pendingBgSound = null;
      playedSounds.push(soundToPlay);
    }
  }

  await t.test('Dollar rain particle count scales up with win streak and clamps at 120', () => {
    const width = 390; // Typical mobile screen width -> baseCount = 35
    const p1 = computeRainParticles(width, 1);
    assert.equal(p1, 35, 'Streak 1 should equal base count');

    const p3 = computeRainParticles(width, 3);
    assert.equal(p3, 35 + 2 * 8, 'Streak 3 should add 16 particles');

    const p8 = computeRainParticles(width, 8);
    assert.equal(p8, 35 + 7 * 8, 'Streak 8 should add 56 particles');

    const p20 = computeRainParticles(width, 20);
    assert.equal(p20, 120, 'High streak should clamp to 120 max particles');
  });

  await t.test('Audio management suppresses sounds in background and plays at most single chime on refocus', () => {
    playedSounds = [];
    pendingBgSound = null;
    documentHidden = false;

    // Normal foreground play
    playSound('win');
    assert.equal(playedSounds.length, 1);

    // Switch to background
    documentHidden = true;
    playSound('win');
    playSound('win');
    playSound('win');
    assert.equal(playedSounds.length, 1, 'No new sounds should play while document is hidden');
    assert.equal(pendingBgSound, 'win', 'Should store at most a single pending chime');

    // Refocus
    documentHidden = false;
    onRefocus();
    assert.equal(playedSounds.length, 2, 'Exactly one single chime played on refocus');
    assert.equal(pendingBgSound, null, 'Pending sound should be cleared');
  });
});

test('R4: Max 3-Loss Circuit Breaker & Bet Dispatch Guard', async (t) => {
  const state = {
    consecutiveLosses: 0,
    circuitBreakerActive: false,
    circuitBreakerPauseRounds: 0,
    currentStake: 2,
    currentLevel: 0
  };

  function settleOutcome(isWin) {
    if (isWin) {
      state.consecutiveLosses = 0;
      state.circuitBreakerActive = false;
      state.circuitBreakerPauseRounds = 0;
      state.currentStake = 2;
      state.currentLevel = 0;
    } else {
      state.consecutiveLosses += 1;
      if (state.consecutiveLosses >= 3) {
        state.circuitBreakerActive = true;
        state.circuitBreakerPauseRounds = 2;
        state.currentStake = 2;
        state.currentLevel = 0;
      } else {
        state.currentLevel += 1;
        state.currentStake = state.currentStake * 2;
      }
    }

    return { ...state };
  }

  function advanceRoundCooloff() {
    if (state.circuitBreakerPauseRounds > 0) {
      state.circuitBreakerPauseRounds -= 1;
      if (state.circuitBreakerPauseRounds === 0) {
        state.circuitBreakerActive = false;
        state.consecutiveLosses = 0;
      }
    }
  }

  function canDispatchBetOrder() {
    return state.circuitBreakerPauseRounds === 0;
  }

  await t.test('Consecutive loss 1 and 2 advance martingale stake without tripping breaker', () => {
    settleOutcome(false);
    assert.equal(state.consecutiveLosses, 1);
    assert.equal(state.circuitBreakerActive, false);
    assert.equal(canDispatchBetOrder(), true);

    settleOutcome(false);
    assert.equal(state.consecutiveLosses, 2);
    assert.equal(state.circuitBreakerActive, false);
    assert.equal(canDispatchBetOrder(), true);
  });

  await t.test('3rd consecutive loss trips circuit breaker: pauses 2 rounds, resets stake to base ₹2, blocks orders', () => {
    settleOutcome(false);
    assert.equal(state.consecutiveLosses, 3);
    assert.equal(state.circuitBreakerActive, true);
    assert.equal(state.circuitBreakerPauseRounds, 2);
    assert.equal(state.currentStake, 2, 'Stake must reset to base ₹2');
    assert.equal(state.currentLevel, 0, 'Level must reset to 0');
    assert.equal(canDispatchBetOrder(), false, 'Bet dispatch must be blocked during pause');
  });

  await t.test('Circuit breaker cool-off decrements per round and unblocks orders after 2 rounds', () => {
    advanceRoundCooloff();
    assert.equal(state.circuitBreakerPauseRounds, 1);
    assert.equal(canDispatchBetOrder(), false);

    advanceRoundCooloff();
    assert.equal(state.circuitBreakerPauseRounds, 0);
    assert.equal(state.circuitBreakerActive, false);
    assert.equal(canDispatchBetOrder(), true, 'Bet dispatch must resume once cool-off finishes');
  });
});

test('R5: Post-Login Grace Period & Custom API Endpoints Fallback', async (t) => {
  let mockNow = 100000;
  let authGracePeriodUntil = 0;
  const mockSessionStorage = new Map();

  function isAuthGracePeriodActive() {
    if (mockNow < authGracePeriodUntil) return true;
    const raw = mockSessionStorage.get('dhaniwin_auth_grace_until');
    if (raw && mockNow < Number(raw)) return true;
    return false;
  }

  function markUserLoggedIn() {
    authGracePeriodUntil = mockNow + 15000;
    mockSessionStorage.set('dhaniwin_auth_grace_until', String(authGracePeriodUntil));
  }

  const DEFAULT_TF_UPSTREAM_URLS = {
    '30s': 'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json',
    '1m':  'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json',
    '3m':  'https://draw.ar-lottery01.com/WinGo/WinGo_3M/GetHistoryIssuePage.json',
    '5m':  'https://draw.ar-lottery01.com/WinGo/WinGo_5M/GetHistoryIssuePage.json'
  };

  const mockLocalStorage = new Map();
  function getApiEndpoint(tf) {
    try {
      const raw = mockLocalStorage.get('quant_custom_api_endpoints');
      if (raw) {
        const endpoints = JSON.parse(raw);
        if (endpoints && endpoints[tf] && typeof endpoints[tf] === 'string' && endpoints[tf].trim().length > 0) {
          return endpoints[tf].trim();
        }
      }
    } catch(e) {}
    return DEFAULT_TF_UPSTREAM_URLS[tf] || DEFAULT_TF_UPSTREAM_URLS['30s'];
  }

  await t.test('Post-login grace period stays active for 15s protecting against false session expiration', () => {
    assert.equal(isAuthGracePeriodActive(), false);
    markUserLoggedIn();
    assert.equal(isAuthGracePeriodActive(), true);

    // 10s elapsed
    mockNow += 10000;
    assert.equal(isAuthGracePeriodActive(), true, 'Still in 15s grace window');

    // 16s elapsed
    mockNow += 6000;
    assert.equal(isAuthGracePeriodActive(), false, 'Grace window expired after 15s');
  });

  await t.test('Custom API endpoints return custom mirror when set, and fall back to locked defaults', () => {
    assert.equal(getApiEndpoint('30s'), DEFAULT_TF_UPSTREAM_URLS['30s']);
    assert.equal(getApiEndpoint('1m'), DEFAULT_TF_UPSTREAM_URLS['1m']);

    // Set custom mirror for 30s
    mockLocalStorage.set('quant_custom_api_endpoints', JSON.stringify({
      '30s': 'https://custom-mirror.example.com/wingo_30s.json'
    }));
    assert.equal(getApiEndpoint('30s'), 'https://custom-mirror.example.com/wingo_30s.json');
    assert.equal(getApiEndpoint('1m'), DEFAULT_TF_UPSTREAM_URLS['1m'], '1m should still use locked default');

    // Restore defaults
    mockLocalStorage.delete('quant_custom_api_endpoints');
    assert.equal(getApiEndpoint('30s'), DEFAULT_TF_UPSTREAM_URLS['30s'], '30s should revert to locked default');
  });
});

test('Buy Me a Coffee Daily Popup, Suppression & Supporter Settings Sync', async (t) => {
  const mockStorage = new Map();
  let mockTime = 1791100000000;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  function getTodayString(t = mockTime) {
    return new Date(t).toISOString().slice(0, 10);
  }

  function isCoffeePaidActive() {
    try {
      const until = Number(mockStorage.get('coffee_paid_until') || 0);
      if (until) {
        return mockTime < until;
      }
      return mockStorage.get('coffee_paid_date') === getTodayString();
    } catch(e) {
      return false;
    }
  }

  function isCoffeePaidToday() {
    return isCoffeePaidActive();
  }

  function recordCoffeePayment(paymentId) {
    const today = getTodayString();
    const validUntil = mockTime + SEVEN_DAYS_MS;
    mockStorage.set('coffee_paid_date', today);
    mockStorage.set('coffee_paid_until', String(validUntil));
    const info = {
      date: today,
      validUntil: validUntil,
      validUntilFormatted: 'Oct 11',
      days: 7,
      paymentId: String(paymentId || 'pay_test'),
      time: '02:30 PM'
    };
    mockStorage.set('coffee_paid_info', JSON.stringify(info));
  }

  let modalOpened = false;
  function openCoffeeModal() {
    modalOpened = true;
  }

  function checkCoffeeSupportPopup() {
    if (isCoffeePaidActive()) {
      return false;
    }
    openCoffeeModal();
    return true;
  }

  function checkPaymentFromUrl(searchQuery) {
    const params = new URLSearchParams(searchQuery);
    const paymentId = params.get('razorpay_payment_id') || params.get('payment_id');
    const paySuccess = params.get('pay_success') === 'true';
    if (paymentId || paySuccess) {
      recordCoffeePayment(paymentId || 'pay_success_test');
      return true;
    }
    return false;
  }

  function getSettingsBadgeAndStatus() {
    if (isCoffeePaidActive()) {
      const info = JSON.parse(mockStorage.get('coffee_paid_info') || '{}');
      const until = Number(mockStorage.get('coffee_paid_until') || info.validUntil || 0);
      let daysLeft = 7;
      if (until > mockTime) {
        daysLeft = Math.max(1, Math.ceil((until - mockTime) / (24 * 60 * 60 * 1000)));
      }
      return {
        badgeText: `PAID SUPPORTER (${daysLeft} DAYS LEFT)`,
        badgeClass: 'tag-active',
        isMuted: true,
        supportedAt: info.time,
        daysLeft: daysLeft
      };
    }
    return {
      badgeText: 'COMMUNITY FUNDED',
      badgeClass: 'tag-warning',
      isMuted: false,
      supportedAt: null,
      daysLeft: 0
    };
  }

  await t.test('Unpaid user triggers coffee popup on refresh/open', () => {
    mockStorage.clear();
    modalOpened = false;
    const triggered = checkCoffeeSupportPopup();
    assert.equal(triggered, true);
    assert.equal(modalOpened, true, 'Modal should open on refresh when unpaid');
    assert.equal(isCoffeePaidActive(), false);
  });

  await t.test('Buying coffee activates 7-day suppression: modal won\'t come again for a while', () => {
    modalOpened = false;
    recordCoffeePayment('pay_demo_999');
    assert.equal(isCoffeePaidActive(), true);

    // Immediate refresh
    assert.equal(checkCoffeeSupportPopup(), false);
    assert.equal(modalOpened, false);

    // Fast-forward 3 days into future
    mockTime += 3 * 24 * 60 * 60 * 1000;
    assert.equal(isCoffeePaidActive(), true, 'Still active on Day 3');
    assert.equal(checkCoffeeSupportPopup(), false, 'Suppressed on Day 3');

    // Fast-forward to 6th day (almost 7 days)
    mockTime += 3 * 24 * 60 * 60 * 1000;
    assert.equal(isCoffeePaidActive(), true, 'Still active on Day 6');
    assert.equal(checkCoffeeSupportPopup(), false, 'Suppressed on Day 6');
  });

  await t.test('After 7-day cooldown expires, popup shows again on refresh until supported', () => {
    modalOpened = false;
    // Fast-forward 2 more days (Day 8 total)
    mockTime += 2 * 24 * 60 * 60 * 1000;
    assert.equal(isCoffeePaidActive(), false, 'Expired after 7 days');

    const triggered = checkCoffeeSupportPopup();
    assert.equal(triggered, true);
    assert.equal(modalOpened, true, 'Popup appears again after 7 days');
  });

  await t.test('Redirect back from Razorpay checkout with URL params automatically activates 7-day supporter status', () => {
    mockStorage.clear();
    mockTime = 1791100000000;
    assert.equal(isCoffeePaidActive(), false);

    const recorded = checkPaymentFromUrl('?razorpay_payment_id=pay_live_abc123');
    assert.equal(recorded, true);
    assert.equal(isCoffeePaidActive(), true);
    const info = JSON.parse(mockStorage.get('coffee_paid_info'));
    assert.equal(info.paymentId, 'pay_live_abc123');
  });

  await t.test('Settings UI reflects PAID SUPPORTER (7 DAYS LEFT) and popup muted status when paid', () => {
    recordCoffeePayment('pay_verified_777');
    const status = getSettingsBadgeAndStatus();
    assert.equal(status.badgeText, 'PAID SUPPORTER (7 DAYS LEFT)');
    assert.equal(status.isMuted, true);
    assert.equal(status.supportedAt, '02:30 PM');
    assert.equal(status.daysLeft, 7);
  });

  await t.test('Settings UI reflects COMMUNITY FUNDED when unpaid', () => {
    mockStorage.clear();
    const status = getSettingsBadgeAndStatus();
    assert.equal(status.badgeText, 'COMMUNITY FUNDED');
    assert.equal(status.isMuted, false);
  });
});

test('Dhani Login Verification, Registration First-Time, Refresh Persistence & App Unlock', async (t) => {
  const storage = new Map();
  const mockStorage = {
    getItem: (k) => storage.get(k) || null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear()
  };

  const DHANIWIN_HOME_URL = 'https://dhaniwin44.com/';
  const DHANIWIN_LOGIN_URL = 'https://dhaniwin44.com/login';
  const DHANIWIN_REGISTRATION_URL = 'https://dhaniwin44.com/register?inviteCode=EEJKXQN&from=app';

  function isUserLoggedIn() {
    return mockStorage.getItem('dhaniwin_is_logged_in') === 'true' ||
           mockStorage.getItem('dhaniwin_logged_in') === '1' ||
           !!mockStorage.getItem('ar_token');
  }

  function getDhaniEntryUrl() {
    if (isUserLoggedIn()) return DHANIWIN_HOME_URL;
    return mockStorage.getItem('dhaniwin_registered') === '1' ? DHANIWIN_LOGIN_URL : DHANIWIN_REGISTRATION_URL;
  }

  function markUserLoggedIn() {
    mockStorage.setItem('dhaniwin_is_logged_in', 'true');
    mockStorage.setItem('dhaniwin_logged_in', '1');
    mockStorage.setItem('dhaniwin_registered', '1');
  }

  let unlockModalVisible = false;
  let activeTab = 'web';

  function switchMobileTab(tab) {
    if (tab !== 'web' && !isUserLoggedIn()) {
      unlockModalVisible = true;
      return false;
    }
    activeTab = tab;
    unlockModalVisible = false;
    return true;
  }

  await t.test('First-time unregistered user gets registration URL', () => {
    mockStorage.clear();
    assert.equal(isUserLoggedIn(), false);
    assert.equal(getDhaniEntryUrl(), DHANIWIN_REGISTRATION_URL, 'First time user redirected to registration');
  });

  await t.test('Unauthenticated user cannot access prediction menus; Unlock 01:01 modal opens', () => {
    mockStorage.clear();
    unlockModalVisible = false;
    const canSwitchHome = switchMobileTab('home');
    assert.equal(canSwitchHome, false);
    assert.equal(unlockModalVisible, true, 'Unlock 01:01 modal triggered for Analyse');

    const canSwitchAi = switchMobileTab('ai');
    assert.equal(canSwitchAi, false);
    assert.equal(unlockModalVisible, true, 'Unlock 01:01 modal triggered for AI');

    const canSwitchPattern = switchMobileTab('pattern');
    assert.equal(canSwitchPattern, false);
    assert.equal(unlockModalVisible, true, 'Unlock 01:01 modal triggered for Pattern');
  });

  await t.test('Dhani login verification unlocks full app, prediction menus, and shows Dhani home', () => {
    markUserLoggedIn();
    assert.equal(isUserLoggedIn(), true);
    assert.equal(getDhaniEntryUrl(), DHANIWIN_HOME_URL, 'Logged in user lands on Dhani home page');

    const switchedAnalyse = switchMobileTab('home');
    assert.equal(switchedAnalyse, true);
    assert.equal(activeTab, 'home');
    assert.equal(unlockModalVisible, false, 'Modal closed and Analyse accessible');

    const switchedAi = switchMobileTab('ai');
    assert.equal(switchedAi, true);
    assert.equal(activeTab, 'ai');

    const switchedPattern = switchMobileTab('pattern');
    assert.equal(switchedPattern, true);
    assert.equal(activeTab, 'pattern');
  });

  await t.test('Page refresh maintains login state and does NOT log user out or show registration again', () => {
    // Simulate browser refresh: storage persists in localStorage
    assert.equal(isUserLoggedIn(), true, 'User is still logged in after reload');
    assert.equal(getDhaniEntryUrl(), DHANIWIN_HOME_URL, 'Still points to Dhani home, never registration');

    const canAccessAi = switchMobileTab('ai');
    assert.equal(canAccessAi, true, 'Prediction menus remain unlocked across refresh');
  });
});

