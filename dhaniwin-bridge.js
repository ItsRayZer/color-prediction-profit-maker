// ==UserScript==
// @name         DhaniWin Quant AI Live Scraper & Auto-Bet Bridge
// @namespace    https://dhaniwin.99.com/
// @version      2.0
// @description  Scrapes live WinGo draws, syncs timers, and executes automated bets from Quant AI Prediction
// @match        *://*.dhaniwin.99.com/*
// @match        *://*.dhaniwin99.com/*
// @match        *://*dhaniwin*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function() {
  'use strict';
  console.log('%c[Quant AI Bridge] 🚀 Initializing DhaniWin Real Auto-Betting Engine v2.0...', 'color:#10b981;font-weight:bold;font-size:12px;');

  const channel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('dhaniwin_quant_channel') : null;

  // Floating On-Screen HUD on DhaniWin
  function updateFloatingHud(statusText, color) {
    let hud = document.getElementById('quant-ai-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'quant-ai-hud';
      hud.style.cssText = 'position:fixed;bottom:75px;left:12px;right:12px;z-index:999999;background:rgba(12,8,25,0.94);backdrop-filter:blur(10px);border:1.5px solid #10b981;border-radius:16px;padding:8px 14px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#fff;font-size:11px;font-weight:bold;box-shadow:0 12px 36px rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:space-between;pointer-events:none;transition:all 0.3s ease;';
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

  // 1. Initial Handshake
  notifyApp({ type: 'DHANIWIN_BRIDGE_HANDSHAKE', status: 'READY', url: window.location.href });
  updateFloatingHud('Connected & Ready (Listening for Signals)', 'emerald');

  // Heartbeat every 2s
  setInterval(() => {
    notifyApp({ type: 'DHANIWIN_BRIDGE_HEARTBEAT', timestamp: Date.now() });
  }, 2000);

  // 2. Auto-Navigate to WinGo if on main lobby
  function autoOpenWinGo() {
    if (window.location.hash.includes('wingo') || window.location.pathname.includes('wingo')) return;
    const links = Array.from(document.querySelectorAll('a, button, div, span'));
    const winGoBtn = links.find(el => {
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      return txt === 'wingo' || txt === 'win go' || (txt.includes('win') && txt.includes('go'));
    });
    if (winGoBtn) {
      console.log('[Quant AI Bridge] Auto-navigating to WinGo...');
      simulateClick(winGoBtn);
      updateFloatingHud('Navigating to WinGo...', 'amber');
    }
  }
  setTimeout(autoOpenWinGo, 1500);

  // 3. Switch Timer Tab (30s, 1m, 3m, 5m)
  function switchTimerTab(tf) {
    const labels = {
      '30s': ['30s', '30 sec', '30sec', 'win go 30s'],
      '1m':  ['1min', '1 min', '1m', 'win go 1min'],
      '3m':  ['3min', '3 min', '3m', 'win go 3min'],
      '5m':  ['5min', '5 min', '5m', 'win go 5min']
    };
    const targets = labels[tf] || [];
    const elements = Array.from(document.querySelectorAll('div, button, span, li, p'));
    for (const el of elements) {
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (targets.some(t => txt === t || txt.includes(t))) {
        simulateClick(el);
        console.log('[Quant AI Bridge] Timer switched to:', tf);
        updateFloatingHud(`Timeframe: ${tf}`, 'emerald');
        break;
      }
    }
  }

  // 4. Live Scraper: Continuously monitors history table
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
            console.log('[Quant AI Bridge] Scraped draw:', period, num, size, color);
          }
        }
        break;
      }
    }
  }
  setInterval(scrapeDraws, 800);

  // Helper: Dispatch touch, pointer, and click events
  function simulateClick(element) {
    if (!element) return;
    ['pointerdown', 'touchstart', 'mousedown', 'mouseup', 'touchend', 'click'].forEach(evtType => {
      try {
        const evt = new MouseEvent(evtType, { bubbles: true, cancelable: true, view: window });
        element.dispatchEvent(evt);
      } catch (e) {
        try {
          const touch = new Event(evtType, { bubbles: true });
          element.dispatchEvent(touch);
        } catch (e2) {}
      }
    });
    if (typeof element.click === 'function') {
      try { element.click(); } catch(e) {}
    }
  }

  // Helper: Find target bet button
  function findTargetButton(target) {
    const tgt = String(target).trim().toUpperCase();
    const all = Array.from(document.querySelectorAll('button, div, span, [role="button"], [class*="btn"]'));
    
    // Exact text match
    let match = all.find(el => {
      const t = (el.innerText || el.textContent || '').trim().toUpperCase();
      return t === tgt;
    });
    if (match) return match;

    // Attribute or class match
    const tgtLower = tgt.toLowerCase();
    match = document.querySelector(`[data-type="${tgtLower}"], [data-bet="${tgtLower}"], .btn-${tgtLower}, .${tgtLower}-btn, .bet-${tgtLower}`);
    if (match) return match;

    // Starts with target
    match = all.find(el => {
      const t = (el.innerText || el.textContent || '').trim().toUpperCase();
      return t.startsWith(tgt);
    });
    return match;
  }

  // 5. Signal Receiver & Real Auto-Bet Executor
  function handleIncomingOrder(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'WINGO_SWITCH_TIMEFRAME') {
      switchTimerTab(msg.timeframe);
    } else if (msg.type === 'EXECUTE_REAL_BET' && msg.enabled) {
      executeRealBet(msg);
    }
  }

  if (channel) channel.onmessage = (ev) => handleIncomingOrder(ev.data);
  window.addEventListener('message', (ev) => handleIncomingOrder(ev.data));

  // Core Auto-Betting Engine
  function executeRealBet(order) {
    const target = (order.target || '').toUpperCase();
    const stake = Math.max(1, Number(order.stake) || 10);
    console.log('%c[Quant AI Bridge] ⚡ EXECUTING REAL BET:', 'color:#f59e0b;font-weight:bold;', target, '₹' + stake);
    updateFloatingHud(`Placing Bet: ${target} ₹${stake}...`, 'amber');

    const btn = findTargetButton(target);
    if (!btn) {
      console.warn('[Quant AI Bridge] ❌ Bet button for ' + target + ' not found!');
      updateFloatingHud(`Btn ${target} Not Found`, 'rose');
      return;
    }

    // Step 1: Click the target bet button to open sheet
    simulateClick(btn);

    // Step 2: In popup, adjust stake and click confirm
    setTimeout(() => {
      const popups = document.querySelectorAll('.van-popup, [class*="popup"], [class*="dialog"], [class*="sheet"], [class*="drawer"], [role="dialog"], body');
      const activePopup = Array.from(popups).reverse().find(p => p.offsetParent !== null) || document.body;

      // Enter stake into stepper input
      const inputs = activePopup.querySelectorAll('input.van-stepper__input, input[type="number"], input[type="tel"], input.amount-input, input[class*="input"]');
      if (inputs.length > 0) {
        const input = inputs[0];
        input.value = stake;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
      }

      // Ensure agree checkbox is checked if present
      const checkboxes = activePopup.querySelectorAll('.van-checkbox, input[type="checkbox"]');
      checkboxes.forEach(cb => {
        if (!cb.classList.contains('van-checkbox--checked') && !cb.checked) {
          simulateClick(cb);
        }
      });

      // Step 3: Click Confirm / Bet button
      setTimeout(() => {
        const buttons = Array.from(activePopup.querySelectorAll('button, div, span, [role="button"]'));
        const confirmBtn = buttons.find(el => {
          const t = (el.innerText || el.textContent || '').trim().toLowerCase();
          return (
            t.includes('total amount') ||
            t.includes('confirm') ||
            t.includes('bet') ||
            t.includes('presale') ||
            (el.className && typeof el.className === 'string' && (el.className.includes('van-button--danger') || el.className.includes('submit') || el.className.includes('confirm')))
          );
        });

        if (confirmBtn) {
          simulateClick(confirmBtn);
          console.log('%c[Quant AI Bridge] ✅ Bet Confirm Clicked! Target: ' + target + ', Stake: ₹' + stake, 'color:#10b981;font-weight:bold;');
          updateFloatingHud(`✅ Bet Placed: ${target} ₹${stake}`, 'emerald');
          notifyApp({
            type: 'DHANIWIN_BET_CONFIRMATION',
            success: true,
            period: order.period,
            target: target,
            stake: stake,
            timestamp: Date.now()
          });
        } else {
          // Fallback to primary button
          const primaryBtn = activePopup.querySelector('.van-button--danger, .van-button--primary, button[type="submit"]');
          if (primaryBtn) {
            simulateClick(primaryBtn);
            updateFloatingHud(`✅ Bet Placed: ${target} ₹${stake}`, 'emerald');
            notifyApp({
              type: 'DHANIWIN_BET_CONFIRMATION',
              success: true,
              period: order.period,
              target: target,
              stake: stake,
              timestamp: Date.now()
            });
          }
        }
      }, 250);
    }, 300);
  }
})();
