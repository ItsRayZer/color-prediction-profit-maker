// ==UserScript==
// @name         DhaniWin Quant AI Live Scraper & Auto-Bet Bridge
// @namespace    https://dhaniwin.99.com/
// @version      3.1
// @description  Scrapes live WinGo draws, auto-navigates to WinGo, and pre-selects bet amount & target color/size from Quant AI
// @match        *://*.dhaniwin44.com/*
// @match        *://*.dhaniwin.99.com/*
// @match        *://*.dhaniwin99.com/*
// @match        *://*.dhaniwin0.com/*
// @match        *://*.dhaniwin2.com/*
// @match        *://*dhaniwin*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function() {
  'use strict';
  console.log('%c[Quant AI Bridge] 🚀 Initializing DhaniWin Real Auto-Betting Engine v3.1...', 'color:#10b981;font-weight:bold;font-size:13px;');

  const channel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('dhaniwin_quant_channel') : null;
  let activeTimeframe = '30s';
  let lastDispatchedPeriod = null;
  const processingPeriods = new Set();
  let configuredStake = 2;
  let configuredMaxStake = 64;
  let hasAppBetSettings = false;

  // Intercept fetch & XHR to catch login/register responses instantly
  (function hookNetworkAuth() {
    try {
      const origFetch = window.fetch;
      if (origFetch) {
        window.fetch = async function(...args) {
          const response = await origFetch.apply(this, args);
          try {
            const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url || '').toLowerCase();
            if (url.includes('login') || url.includes('register')) {
              const clone = response.clone();
              clone.json().then(data => {
                if (data && (data.code === 0 || data.success || data.token || data.data?.token)) {
                  console.log('[Quant AI Bridge] 🎉 Auth API Success Detected!');
                  notifyApp({ type: 'DHANIWIN_AUTH_SUCCESS', data });
                  setTimeout(autoOpenWinGo, 600);
                }
              }).catch(() => {});
            }
          } catch(e) {}
          return response;
        };
      }
    } catch(e) {}
  })();

  // ── 1. Floating On-Screen HUD ────────────────────────────────────────────────
  function updateFloatingHud(statusText, color) {
    let hud = document.getElementById('quant-ai-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'quant-ai-hud';
      hud.style.cssText = 'position:fixed;bottom:75px;left:12px;right:12px;z-index:999999;background:rgba(12,8,25,0.96);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1.5px solid #10b981;border-radius:16px;padding:8px 14px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#fff;font-size:11px;font-weight:bold;box-shadow:0 12px 36px rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:space-between;pointer-events:none;transition:all 0.3s ease;';
      document.body.appendChild(hud);
    }
    const colorHex = color === 'amber' ? '#f59e0b' : color === 'rose' ? '#f43f5e' : '#10b981';
    hud.style.borderColor = colorHex;
    hud.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="width:8px;height:8px;border-radius:50%;background:${colorHex};box-shadow:0 0 10px ${colorHex};display:inline-block;"></span>
        <span style="letter-spacing:0.5px;color:#fff;">QUANT AI AUTO-BET</span>
      </div>
      <span style="color:${colorHex};font-size:10.5px;font-family:monospace;">${statusText}</span>
    `;
  }

  function notifyApp(msg) {
    if (channel) {
      try { channel.postMessage(msg); } catch(e) {}
    }
    if (window.opener) {
      try { window.opener.postMessage(msg, '*'); } catch(e) {}
    }
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage(msg, '*'); } catch(e) {}
    }
  }

  // Handshake & Heartbeat
  notifyApp({ type: 'DHANIWIN_BRIDGE_HANDSHAKE', status: 'READY', url: window.location.href });
  updateFloatingHud('Bridge Active • Ready for Signals', 'emerald');
  setInterval(() => {
    notifyApp({ type: 'DHANIWIN_BRIDGE_HEARTBEAT', timestamp: Date.now() });
  }, 2000);

  // ── 2. Safe Event Dispatcher (Multi-Phase Pointer & Touch Simulation) ──────
  function simulateClick(element) {
    if (!element) return;
    try { element.focus(); } catch(e) {}

    let clientX = 0, clientY = 0;
    try {
      const rect = element.getBoundingClientRect();
      clientX = rect.left + rect.width / 2;
      clientY = rect.top + rect.height / 2;
    } catch(e) {}

    // Pointer Events (Safe for mobile Vue/Vant and FastClick listeners)
    if (typeof PointerEvent !== 'undefined') {
      try {
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window, clientX, clientY, pointerId: 1, isPrimary: true, pressure: 0.5 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window, clientX, clientY, pointerId: 1, isPrimary: true }));
      } catch(e) {}
    }

    // Touch Events (Mobile Safari / Chrome touch triggers)
    if (typeof TouchEvent !== 'undefined') {
      try {
        const touch = new Touch({ identifier: Date.now(), target: element, clientX, clientY });
        element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
        element.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [touch] }));
      } catch(e) {}
    }

    // Mouse Events
    try {
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX, clientY }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX, clientY }));
    } catch(e) {}

    // Native Click
    if (typeof element.click === 'function') {
      try { element.click(); } catch(e) {}
    } else {
      try {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX, clientY }));
      } catch(e) {}
    }
  }

  // Resilient Async Element Waiter with MutationObserver & Polling Fallback
  function waitForElement(predicateFn, timeoutMs = 3500, intervalMs = 50) {
    return new Promise((resolve) => {
      const initial = predicateFn();
      if (initial) return resolve(initial);

      let observer = null;
      let timer = null;
      const startTime = Date.now();

      function check() {
        const el = predicateFn();
        if (el) {
          cleanup();
          return resolve(el);
        }
        if (Date.now() - startTime >= timeoutMs) {
          cleanup();
          return resolve(null);
        }
      }

      function cleanup() {
        if (observer) { try { observer.disconnect(); } catch(e) {} observer = null; }
        if (timer) { clearInterval(timer); timer = null; }
      }

      if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
        try {
          observer = new MutationObserver(check);
          observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true });
        } catch(e) {}
      }

      timer = setInterval(check, intervalMs);
    });
  }

  // ── 3. Aggressive In-App Popup Dismissal ─────────────────────────────────────
  function autoDismissInAppPopups() {
    // 1. Dialogs (Daily sign-in, notices, announcements)
    const dialogs = document.querySelectorAll('.van-dialog, [class*="dialog"], [class*="notice-modal"], [class*="announcement"]');
    dialogs.forEach(dlg => {
      // Guard: Never dismiss active bet sheet or stepper!
      if (dlg.querySelector('.van-stepper, input.van-stepper__input, .van-button--danger, [class*="stepper"]')) return;
      const btn = dlg.querySelector('.van-dialog__confirm, .van-popup__close-icon, [class*="close"], .van-button');
      if (btn) {
        try { simulateClick(btn); } catch(e) {}
      }
    });

    // 2. Standalone Floating Close Icons (unless inside a betting sheet)
    const closeIcons = document.querySelectorAll('.van-popup__close-icon, .van-icon-cross, [class*="close-icon"], .dialog-close, .notice-close');
    closeIcons.forEach(icon => {
      const parentPopup = icon.closest('.van-popup');
      if (parentPopup) {
        const isBetSheet = parentPopup.querySelector('.van-stepper, input.van-stepper__input') || (parentPopup.innerText || '').includes('Total amount');
        if (isBetSheet) return; // Keep betting sheet open!
      }
      try { simulateClick(icon); } catch(e) {}
    });
  }
  setInterval(autoDismissInAppPopups, 500);

  const INTERVAL_URL_MAP = {
    '30s': '/WinGo/WinGo_30S',
    '1m':  '/WinGo/WinGo_1M',
    '3m':  '/WinGo/WinGo_3M',
    '5m':  '/WinGo/WinGo_5M'
  };

  // ── 4. Auto-Navigate to WinGo Game & Timeframe Tab ───────────────────────────
  function autoOpenWinGo() {
    const href = window.location.href.toLowerCase();
    const isRegisterOrLogin = href.includes('/register') || href.includes('/login');
    let token = null;
    try {
      token = localStorage.getItem('ar_token') || sessionStorage.getItem('ar_token');
    } catch(e) {}

    // Only auto-navigate if logged in or past registration
    if (!isRegisterOrLogin || token) {
      const targetPath = INTERVAL_URL_MAP[activeTimeframe] || '/WinGo/WinGo_30S';
      const targetPathLower = targetPath.toLowerCase();

      // Check if we are already on this interval's URL
      if (!href.includes(targetPathLower)) {
        console.log('[Quant AI Bridge] 🚀 Direct Interval Routing ->', targetPath);
        updateFloatingHud(`Loading WinGo ${activeTimeframe.toUpperCase()}...`, 'amber');
        window.location.href = window.location.origin + targetPath;
        return;
      }

      // If already on the page, ensure correct tab is active
      switchTimerTab(activeTimeframe);
    }
  }
  setTimeout(autoOpenWinGo, 1200);
  setInterval(autoOpenWinGo, 3000);

  // Switch WinGo Timer Tab (30s, 1m, 3m, 5m)
  function switchTimerTab(tf) {
    if (tf) activeTimeframe = tf;
    const matchTerms = {
      '30s': ['30s', '30 sec', '30sec', 'win go 30s', 'wingo 30s'],
      '1m':  ['1min', '1 min', '1m', 'win go 1min', 'wingo 1m'],
      '3m':  ['3min', '3 min', '3m', 'win go 3min', 'wingo 3m'],
      '5m':  ['5min', '5 min', '5m', 'win go 5min', 'wingo 5m']
    };
    const targets = matchTerms[activeTimeframe] || [];

    // Find tab elements in WinGo header
    const tabElements = Array.from(document.querySelectorAll('.van-tab, [class*="tab"], .time-item, [class*="time"], div, button, span'));
    for (const el of tabElements) {
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (targets.some(t => txt === t || txt.startsWith(t) || txt === `win go ${t}`)) {
        // If not already active
        if (!el.classList.contains('van-tab--active') && !el.classList.contains('active')) {
          simulateClick(el);
          console.log('[Quant AI Bridge] ⏱️ Switched timer tab to:', activeTimeframe);
          updateFloatingHud(`Timeframe: ${activeTimeframe}`, 'emerald');
        }
        break;
      }
    }
  }

  // ── 5. Scrape User Session & Wallet Balance ──────────────────────────────────
  let _wasLoggedInBefore = false;
  function scrapeUserSession() {
    let token = null;
    try { token = localStorage.getItem('ar_token'); } catch(e) {}

    let balance = null;
    const candidates = document.querySelectorAll('.wallet-balance, .balance-num, [class*="balance"], [class*="money"], .amount, .van-nav-bar__title');
    for (const el of candidates) {
      const txt = (el.innerText || el.textContent || '').trim();
      const match = txt.match(/[₹$]?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
      if (match && Number(match[1]) > 0 && !txt.includes('%') && !txt.includes(':') && !txt.includes('#')) {
        balance = Number(match[1]);
        break;
      }
    }

    const href = window.location.href.toLowerCase();
    const isAuthPage = href.includes('/login') || href.includes('/register');
    const isWinGoPage = href.includes('/wingo/');
    const isLoggedIn = !isAuthPage && (balance !== null || token !== null || isWinGoPage);

    if (isLoggedIn && !_wasLoggedInBefore) {
      _wasLoggedInBefore = true;
      notifyApp({
        type: 'DHANIWIN_LOGIN_DETECTED',
        loggedIn: true,
        interval: activeTimeframe,
        timestamp: Date.now()
      });
    } else if (isAuthPage && _wasLoggedInBefore) {
      _wasLoggedInBefore = false;
      notifyApp({
        type: 'DHANIWIN_SESSION_OUT',
        url: window.location.href,
        timestamp: Date.now()
      });
    }

    notifyApp({
      type: 'DHANIWIN_USER_SYNC',
      token: token,
      balance: balance,
      isLoggedIn: isLoggedIn,
      url: window.location.href,
      timestamp: Date.now()
    });
  }
  setInterval(scrapeUserSession, 3000);

  // ── 6. Live Scraper: Monitors History Table ──────────────────────────────────
  let lastPeriodSeen = null;
  function scrapeDraws() {
    const candidates = document.querySelectorAll('tr, .van-row, [class*="record"], [class*="history-item"], [class*="item"]');
    for (const el of candidates) {
      const txt = el.innerText || el.textContent || '';
      const periodMatch = txt.match(/\b\d{10,20}\b/);
      if (periodMatch) {
        const period = periodMatch[0];
        if (period !== lastPeriodSeen) {
          lastPeriodSeen = period;
          const numMatch = txt.match(/\b([0-9])\b/);
          const num = numMatch ? Number(numMatch[1]) : null;
          if (num !== null) {
            const size = num >= 5 ? 'BIG' : 'SMALL';
            const color = [1,3,7,9,5].includes(num) ? 'GREEN' : 'RED';
            notifyApp({
              type: 'DHANIWIN_SCRAPED_RESULT',
              period,
              number: num,
              size,
              color,
              timestamp: Date.now()
            });
            console.log('[Quant AI Bridge] 📊 Scraped draw:', period, num, size, color);
          }
        }
        break;
      }
    }
  }
  setInterval(scrapeDraws, 800);

  // ── 7. Target Betting Button Locator (Isolates Betting Area) ─────────────────
  function findBettingContainer() {
    const containers = Array.from(document.querySelectorAll(
      '[class*="bet-box"], [class*="bet-wrap"], [class*="betting"], [class*="game-bet"], .bet-type, .bet-area, .c-row, .bet-con, [class*="bet_box"], .van-tabs__content, .content'
    ));
    for (const c of containers) {
      const txt = (c.innerText || c.textContent || '').toUpperCase();
      if ((txt.includes('BIG') && txt.includes('SMALL')) || (txt.includes('GREEN') && txt.includes('RED'))) {
        return c;
      }
    }
    return document.body;
  }

  function findTargetButton(target) {
    if (!target) return null;
    const tgt = String(target).trim().toUpperCase();
    const container = findBettingContainer();
    const candidates = Array.from(container.querySelectorAll('button, div, span, [role="button"], [class*="btn"], [class*="item"]')).filter(el => {
      // Exclude table rows, history, hud, assistant
      const isExcluded = el.closest('tr, table, [class*="record"], [class*="history"], [class*="hud"], #quant-ai-hud, [class*="assistant"], .van-popup');
      return !isExcluded && (el.offsetParent !== null || el.offsetWidth > 0);
    });

    const tgtLower = tgt.toLowerCase();

    // 1. Check data-type, data-bet, and specific class names
    let match = candidates.find(el => {
      const cls = (typeof el.className === 'string' ? el.className.toLowerCase() : '');
      const dtype = (el.getAttribute('data-type') || el.getAttribute('data-bet') || el.getAttribute('data-value') || '').toLowerCase();
      return dtype === tgtLower || cls.includes(`btn-${tgtLower}`) || cls.includes(`bet-${tgtLower}`) || cls.includes(`item-${tgtLower}`);
    });
    if (match) return match.closest('button, [role="button"], [class*="btn"], .van-col, .bet-item') || match;

    // 2. Exact or rate-appended text matching (e.g. "BIG 1.98", "BIG\n1.98", "BIG", "GREEN 2", "RED 2", "0")
    match = candidates.find(el => {
      const t = (el.innerText || el.textContent || '').trim().toUpperCase();
      if (t.includes('PREP') || t.includes('QUANT') || t.includes('READY') || t.includes('AUTO') || t.includes('TIME')) return false;

      // Single digit number matching (0-9)
      if (/^[0-9]$/.test(tgt)) {
        return t === tgt || new RegExp(`^${tgt}(\\s|\\n|$)`).test(t);
      }

      // Word matching for BIG, SMALL, GREEN, RED, VIOLET
      return new RegExp(`^${tgt}(\\s|\\n|$)|^\\s*${tgt}\\b`).test(t);
    });
    if (match) return match.closest('button, [role="button"], [class*="btn"], .van-col, .bet-item') || match;

    // 3. Fallback whole-page search (strictly excluding tables and HUD)
    const all = Array.from(document.querySelectorAll('button, div, span, [role="button"]')).filter(el => {
      return !el.closest('tr, table, [class*="record"], [class*="history"], #quant-ai-hud, [class*="assistant"]');
    });
    match = all.find(el => {
      const t = (el.innerText || el.textContent || '').trim().toUpperCase();
      return (t === tgt || new RegExp(`^${tgt}(\\s|\\n|$)`).test(t)) && !t.includes('PREP') && !t.includes('QUANT');
    });
    return match ? (match.closest('button, [role="button"], [class*="btn"]') || match) : null;
  }

  // ── 8. Vue 2/3 Reactive Input Setter & Stepper Adjuster ───────────────────────
  function setNativeInputValue(input, val) {
    if (!input) return;
    try {
      input.focus();
      const proto = Object.getPrototypeOf(input);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(input, String(val));
      } else {
        input.value = String(val);
      }
    } catch(e) {
      input.value = String(val);
    }
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
  }

  function adjustStepperStake(activePopup, desiredStake) {
    if (!activePopup) return false;
    const targetStake = Math.max(1, Number(desiredStake) || 2);

    // 1. Select the ₹1 base unit chip (excludes stepper +/- buttons and any element inside .van-stepper)
    const chips = Array.from(activePopup.querySelectorAll('.van-button, div, span, [role="button"], button'));
    const chip1 = chips.find(el => {
      const t = (el.innerText || el.textContent || '').trim().replace(/\s/g, '');
      return (t === '1' || t === '₹1' || t === '1.00') &&
        !el.classList.contains('van-stepper__plus') &&
        !el.classList.contains('van-stepper__minus') &&
        !el.closest('.van-stepper');
    });
    if (chip1) {
      const isActive = chip1.classList.contains('active') || chip1.classList.contains('van-button--primary') ||
                       chip1.classList.contains('cur') || chip1.classList.contains('selected');
      if (!isActive) simulateClick(chip1);
    }

    // 2. Find stepper input and +/- buttons (prioritise van-stepper__input)
    const stepperInput = activePopup.querySelector(
      'input.van-stepper__input, input.amount-input, .van-stepper input, input[type="tel"], input[type="number"]'
    );
    const plusBtn  = activePopup.querySelector('.van-stepper__plus,  [class*="stepper__plus"]');
    const minusBtn = activePopup.querySelector('.van-stepper__minus, [class*="stepper__minus"]');

    if (stepperInput) {
      // BEST METHOD: bypass Vue reactivity lock via native HTMLInputElement prototype setter
      try {
        const proto = Object.getPrototypeOf(stepperInput);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
                     Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (desc && desc.set) {
          desc.set.call(stepperInput, String(targetStake));
        } else {
          stepperInput.value = String(targetStake);
        }
      } catch(e) { stepperInput.value = String(targetStake); }

      // Fire Vue's expected event chain to sync v-model
      ['focus', 'input', 'change', 'blur'].forEach(evtName => {
        try { stepperInput.dispatchEvent(new Event(evtName, { bubbles: true, composed: true })); } catch(e) {}
      });

      // Check immediately if value didn't stick (e.g. locked/readonly input)
      const immediateVal = parseInt(stepperInput.value, 10) || 0;
      const diff = targetStake - immediateVal;
      if (Math.abs(diff) > 0 && Math.abs(diff) <= 100) {
        const btn = diff > 0 ? plusBtn : minusBtn;
        if (btn) {
          for (let i = 0; i < Math.abs(diff); i++) {
            simulateClick(btn);
          }
        }
      }

    } else if (plusBtn) {
      // No text input at all — reset to 1 via minus, then step up
      if (minusBtn) {
        for (let i = 0; i < 50; i++) simulateClick(minusBtn);
      }
      for (let i = 0; i < Math.min(targetStake - 1, 100); i++) {
        simulateClick(plusBtn);
      }
    }

    // 3. Auto-check Terms Checkbox (required before DhaniWin allows confirm)
    const checkboxes = activePopup.querySelectorAll('.van-checkbox, input[type="checkbox"]');
    checkboxes.forEach(cb => {
      const isChecked = cb.classList.contains('van-checkbox--checked') || cb.checked;
      if (!isChecked) simulateClick(cb);
    });

    return !!(stepperInput || plusBtn);
  }

  async function selectAndVerifyStake(activePopup, desiredStake) {
    const targetStake = Math.max(1, Number(desiredStake) || 2);
    const startedAt = Date.now();
    const deadline = startedAt + 3500;
    const stepperOnlyWaitMs = Math.min(3300, 850 + Math.max(0, targetStake - 1) * 35);
    let attemptedAdjustment = false;
    let stepperControlsSeen = false;

    while (Date.now() < deadline) {
      const popup = findActiveBetPopup() || activePopup;
      const input = popup.querySelector('input.van-stepper__input, input.amount-input, .van-stepper input, input[type="tel"], input[type="number"]');
      if (input) {
        const actual = Number(String(input.value || '').replace(/[^\d.]/g, ''));
        if (Number.isFinite(actual) && Math.abs(actual - targetStake) < 0.01) return true;
        if (!attemptedAdjustment) {
          attemptedAdjustment = adjustStepperStake(popup, targetStake);
        }
      } else {
        const hasStepper = popup.querySelector('.van-stepper__plus, [class*="stepper__plus"]');
        if (!hasStepper) return false;
        stepperControlsSeen = true;
        if (!attemptedAdjustment) attemptedAdjustment = adjustStepperStake(popup, targetStake);
        if (Date.now() - startedAt >= stepperOnlyWaitMs) return attemptedAdjustment && stepperControlsSeen;
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    return false;
  }


  function findActiveBetPopup() {
    const popups = Array.from(document.querySelectorAll(
      '.van-popup, [class*="popup"], [class*="sheet"], [class*="drawer"], [role="dialog"]'
    )).filter(p => {
      if (p.id === 'quant-ai-hud' || p.closest('#quant-ai-hud') || p.id === 'dhaniwinAssistantModal' || p.id === 'fullScreenWinModal') return false;
      const isVisible = p.offsetParent !== null && window.getComputedStyle(p).display !== 'none' && window.getComputedStyle(p).visibility !== 'hidden';
      if (!isVisible) return false;
      // Must contain stepper, stake, or bet amount
      const hasStepperOrAmount = p.querySelector('.van-stepper, input.van-stepper__input, [class*="stepper"]') ||
        (p.innerText || p.textContent || '').includes('Total amount') ||
        (p.innerText || p.textContent || '').includes('Balance') ||
        (p.innerText || p.textContent || '').includes('Confirm');
      return hasStepperOrAmount;
    });
    return popups.length > 0 ? popups[popups.length - 1] : null;
  }

  function isRoundLockingSoon() {
    const countEls = Array.from(document.querySelectorAll('.time-box, [class*="countdown"], [class*="clock"], .van-count-down, .time-item, [class*="time"]'));
    for (const el of countEls) {
      const txt = (el.innerText || el.textContent || '').trim();
      if (/\b00:0[0-4]\b/.test(txt)) return true;
    }
    return false;
  }

  // ── 9. Core Auto-Betting Engine ─────────────────────────────────────────────
  async function executeRealBet(order) {
    if (!order || !order.target) return;
    const period = String(order.period || '');
    if (period && (period === lastDispatchedPeriod || processingPeriods.has(period))) return false;

    // 1. Guard against round lockout (< 5s left in active round)
    if (isRoundLockingSoon()) {
      console.log('[Quant AI Bridge] ⏳ Round is locking in <5s! Holding bet for the next round.');
      updateFloatingHud('⏳ Round Locked (<5s) • Waiting Next', 'amber');
      return false;
    }
    if (period) processingPeriods.add(period);

    // 2. Auto-close any stale popups/drawers left from previous missed rounds
    const stalePopups = document.querySelectorAll('.van-overlay, .van-popup__close-icon, [class*="overlay"], [class*="mask"]');
    stalePopups.forEach(el => {
      try { simulateClick(el); } catch(e) {}
    });

    const target = order.target.toUpperCase();
    const maxStake = Number(order.maxStake) || 999999;
    const requestedStake = Math.max(1, Number(order.stake) || 2);
    const stake = Math.min(requestedStake, maxStake);

    console.log('%c[Quant AI Bridge] ⚡ AUTO-PREPARING BET:', 'color:#f59e0b;font-weight:bold;', target, '₹' + stake);
    updateFloatingHud(`Selecting: ${target} ₹${stake}...`, 'amber');

    // 3. Wait for betting button to be rendered in DOM
    const btn = await waitForElement(() => findTargetButton(target), 3200, 50);
    if (!btn) {
      console.warn('[Quant AI Bridge] ❌ Bet button for ' + target + ' not found in DOM!');
      updateFloatingHud(`Btn ${target} Not Found`, 'rose');
      if (period) processingPeriods.delete(period);
      notifyApp({ type: 'DHANIWIN_BET_PREP_FAILED', period, target, reason: `Bet button ${target} not found` });
      return false;
    }

    console.log('[Quant AI Bridge] 🎯 Clicking bet button for:', target, btn);
    simulateClick(btn);

    // 4. Wait for popup sheet to mount and become visible
    const activePopup = await waitForElement(() => findActiveBetPopup(), 3000, 50);
    if (!activePopup) {
      if (period) processingPeriods.delete(period);
      updateFloatingHud('Bet amount sheet not found', 'rose');
      notifyApp({ type: 'DHANIWIN_BET_PREP_FAILED', period, target, reason: 'Bet amount sheet not found' });
      return false;
    }

    // 5. Adjust stake in popup
    const stakeSelected = await selectAndVerifyStake(activePopup, stake);
    const currentPopup = findActiveBetPopup() || activePopup;
    if (!stakeSelected) {
      if (period) processingPeriods.delete(period);
      updateFloatingHud(`Stake ₹${stake} not selected • Retry`, 'rose');
      notifyApp({ type: 'DHANIWIN_BET_PREP_FAILED', period, target, stake, reason: `Could not verify stake ₹${stake}` });
      return false;
    }
    if (period) {
      processingPeriods.delete(period);
      lastDispatchedPeriod = period;
    }

    // 6. Highlight Confirm Button for User Manual Click (STRICTLY MANUAL)
    setTimeout(() => {
      const buttons = Array.from(currentPopup.querySelectorAll('button, [role="button"], .van-button, [class*="submit"], [class*="confirm"]'));
      const confirmBtn = buttons.find(el => {
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        return (
          t.includes('confirm') ||
          t.includes('place bet') ||
          t.includes('bet now') ||
          t.includes('presale') ||
          (el.className && typeof el.className === 'string' && (el.className.includes('van-button--danger') || el.className.includes('submit') || el.className.includes('confirm')))
        );
      }) || Array.from(currentPopup.querySelectorAll('.van-button--danger, .van-button--primary, button[type="submit"]')).find(el => !el.disabled);

      if (confirmBtn && !confirmBtn.disabled && confirmBtn.getAttribute('aria-disabled') !== 'true') {
        if (order.manualConfirm === true) {
          confirmBtn.style.outline = '3px solid #10b981';
          confirmBtn.style.boxShadow = '0 0 32px rgba(16, 185, 129, 0.95)';
          confirmBtn.style.transform = 'scale(1.04)';
          confirmBtn.style.transition = 'all 0.25s ease';
          updateFloatingHud(`👉 TAP BET NOW: ${target} ₹${stake}`, 'emerald');
          notifyApp({ type: 'DHANIWIN_BET_PREPARED', period, target, stake, timestamp: Date.now() });

          confirmBtn.addEventListener('click', function onUserConfirm() {
            updateFloatingHud(`✅ Bet Placed: ${target} ₹${stake}`, 'emerald');
            notifyApp({ type: 'DHANIWIN_BET_CONFIRMATION', success: true, period, target, stake, timestamp: Date.now() });
          }, { once: true });
        } else {
          simulateClick(confirmBtn);
          updateFloatingHud(`✅ Bet Placed: ${target} ₹${stake}`, 'emerald');
          notifyApp({ type: 'DHANIWIN_BET_CONFIRMATION', success: true, period, target, stake, timestamp: Date.now() });
        }
      } else {
        if (period) lastDispatchedPeriod = null;
        updateFloatingHud(`Confirm button not found for ₹${stake}`, 'rose');
        notifyApp({ type: 'DHANIWIN_BET_PREP_FAILED', period, target, stake, reason: 'Confirm button not found' });
      }
    }, 400);
    return true;
  }

  // Expose automation suite for testing and verification
  if (typeof window !== 'undefined') {
    window.__QuantBridgeAutomation = {
      simulateClick,
      waitForElement,
      findBettingContainer,
      findTargetButton,
      adjustStepperStake,
      findActiveBetPopup,
      isRoundLockingSoon,
      executeRealBet
    };
  }

  // ── 10. Signal Receiver (Cross-Window & BroadcastChannel) ────────────────────
  function handleIncomingOrder(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'UPDATE_BET_SETTINGS') {
      const nextStake = Number(msg.stake);
      const nextMaxStake = Number(msg.maxStake);
      if (Number.isFinite(nextStake) && nextStake > 0) configuredStake = nextStake;
      if (Number.isFinite(nextMaxStake) && nextMaxStake > 0) configuredMaxStake = nextMaxStake;
      hasAppBetSettings = true;
      if (msg.timeframe && INTERVAL_URL_MAP[msg.timeframe]) activeTimeframe = msg.timeframe;
    } else if (msg.type === 'WINGO_SWITCH_TIMEFRAME') {
      activeTimeframe = msg.timeframe;
      const targetPath = INTERVAL_URL_MAP[msg.timeframe] || '/WinGo/WinGo_30S';
      if (!window.location.href.toLowerCase().includes(targetPath.toLowerCase())) {
        console.log('[Quant AI Bridge] Switching interval page to:', targetPath);
        window.location.href = window.location.origin + targetPath;
      } else {
        switchTimerTab(msg.timeframe);
      }
    } else if (msg.type === 'EXECUTE_REAL_BET' && msg.enabled) {
      executeRealBet(msg);
    }
  }

  if (channel) channel.onmessage = (ev) => handleIncomingOrder(ev.data);
  window.addEventListener('message', (ev) => handleIncomingOrder(ev.data));

  // ── 11. Cloud Universal Brain Standalone Realtime Poller ─────────────────────
  // Connects directly to Firebase RTDB — works even without BroadcastChannel
  let lastCloudPeriod = null;
  async function pollCloudPrediction() {
    try {
      const url = `https://zer0one-376d1-default-rtdb.asia-southeast1.firebasedatabase.app/universal_state/${activeTimeframe}.json`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const state = await resp.json();
      if (!state || !state.target) return;

      const p = String(state.targetPeriod || state.period || '');
      if (!p) return;
      if (p === lastCloudPeriod) return; // Already handled this round

      // The app and DhaniWin run on different origins, so their localStorage is isolated.
      let stake = configuredStake;
      let maxStake = configuredMaxStake;
      try {
        const s = localStorage.getItem('dhaniwin_active_stake');
        if (s && Number(s) > 0) stake = Number(s);
        const ms = localStorage.getItem('dhaniwin_max_stake');
        if (ms && Number(ms) > 0) maxStake = Number(ms);
      } catch(e) {}
      if (hasAppBetSettings) {
        stake = configuredStake;
        maxStake = configuredMaxStake;
      }

      // Skip low-confidence predictions if confidence is provided
      const rawConfidence = state.targetConfidence !== undefined ? state.targetConfidence : state.conf;
      const confidence = rawConfidence === undefined ? undefined : (Number(rawConfidence) > 1 ? Number(rawConfidence) / 100 : Number(rawConfidence));
      if (confidence !== undefined && confidence < 0.55) {
        console.log(`[Quant AI Bridge] ⚠️ Skipping low-confidence prediction: ${state.target} conf=${confidence}`);
        updateFloatingHud(`⚠️ Skipped (Low Conf ${Math.round(confidence * 100)}%)`, 'amber');
        return;
      }

      updateFloatingHud(`🧠 Cloud Signal: ${state.target} ₹${stake}`, 'emerald');
      const prepared = await executeRealBet({
        target: state.target,
        period: p,
        stake: stake,
        maxStake: maxStake,
        manualConfirm: true,
        timeframe: activeTimeframe,
        conf: confidence
      });
      if (prepared) lastCloudPeriod = p;
    } catch(e) {}
  }

  // Adaptive polling: 1.5s for fast 30s rounds, 2.5s for slower intervals
  function startAdaptivePoller() {
    let lastTf = activeTimeframe;
    let pollTimer = null;
    function getInterval() { return activeTimeframe === '30s' ? 1500 : 2500; }
    function scheduleNext() {
      pollTimer = setTimeout(async () => {
        await pollCloudPrediction();
        // If timeframe changed, restart with new interval
        if (activeTimeframe !== lastTf) { lastTf = activeTimeframe; }
        scheduleNext();
      }, getInterval());
    }
    scheduleNext();
  }
  startAdaptivePoller();

  // Report scroll direction to the host app (drives its Home top-bar auto-hide).
  // 'up' = finger swipes up (content advances), 'down' = finger swipes down.
  (function startScrollReporter() {
    let lastY = window.scrollY || 0;
    let lastDir = null;
    const report = (dir) => {
      if (dir === lastDir) return;
      lastDir = dir;
      notifyApp({ type: 'DHANIWIN_SCROLL', direction: dir, timestamp: Date.now() });
    };
    window.addEventListener('scroll', () => {
      const y = window.scrollY || 0;
      if (Math.abs(y - lastY) < 12) return;
      report(y > lastY ? 'up' : 'down');
      lastY = y;
    }, { passive: true });
    let ty = null;
    window.addEventListener('touchstart', (e) => { ty = e.touches[0].clientY; }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (ty === null) return;
      const dy = e.touches[0].clientY - ty;
      if (Math.abs(dy) > 24) { report(dy < 0 ? 'up' : 'down'); ty = e.touches[0].clientY; }
    }, { passive: true });
  })();

})();


