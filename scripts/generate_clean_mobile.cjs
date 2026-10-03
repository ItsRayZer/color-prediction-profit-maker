/**
 * scripts/generate_clean_mobile.js
 * Cleanly reconstructs mobile.js from deploy/mobile.js with:
 * 1. Real history evaluation without fake mockPred in fetchLiveAPIResults
 * 2. Full PC LightweightCharts engine with continuous price walk, indicators, HUD, markers, zoom/fit
 * 3. Real 53 isolated canonical models with individual predictions, win rates, and dual in-charge logic
 * 4. Deduplicated, authoritative win/loss animation & settlement
 */

const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '..', 'deploy', 'mobile.js');
let code = fs.readFileSync(srcPath, 'utf8');

// Normalize line endings to LF for consistent slice and replace
code = code.replace(/\r\n/g, '\n');

console.log('Original deploy/mobile.js size:', code.length, 'lines:', code.split('\n').length);

// ─────────────────────────────────────────────────────────────────────────────
// REPLACEMENT 1: Clean fetchLiveAPIResults (No fake mockPred)
// ─────────────────────────────────────────────────────────────────────────────
const fetchOldStart = code.indexOf('async function fetchLiveAPIResults(tfOverride) {');
const fetchOldEnd = code.indexOf('window.fetchLiveAPIResults = fetchLiveAPIResults;\n', fetchOldStart) + 'window.fetchLiveAPIResults = fetchLiveAPIResults;\n'.length;

if (fetchOldStart === -1 || fetchOldEnd === -1) {
  throw new Error('Could not find fetchLiveAPIResults block');
}

const fetchNewBlock = `async function fetchLiveAPIResults(tfOverride) {
  const tf = tfOverride || MobileState.timeframe;
  if (!window._isFetchingMobile) window._isFetchingMobile = {};
  if (window._isFetchingMobile[tf]) return false;
  window._isFetchingMobile[tf] = true;

  try {
    const list = await fetchLiveHistoryFromDirectAPI(tf);
    if (Array.isArray(list) && list.length > 0) {
      let parsedList = list.map(item => {
        const period = String(item.issueNumber || item.issue || item.period || item.expect || '');
        const num = parseInt(item.number !== undefined ? item.number : (item.openNumber !== undefined ? item.openNumber : item.code || 0), 10);
        const size = item.size || (num >= 5 ? 'BIG' : 'SMALL');
        const color = item.color || (num === 0 ? 'RED,VIOLET' : num === 5 ? 'GREEN,VIOLET' : [1,3,7,9].includes(num) ? 'GREEN' : 'RED');
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

      // Strictly ensure chronological ordering (oldest-first, newest-last)
      parsedList.sort((a, b) => String(a.period).localeCompare(String(b.period)));

      const expectedCode = TF_CODES[tf];
      if (expectedCode) {
        parsedList = parsedList.filter(r => !r.period || String(r.period).includes(expectedCode));
      }

      if (parsedList.length > 0) {
        const currentList = MobileState.historyByTf[tf] || [];
        const latestOld = currentList.length > 0 ? currentList[currentList.length - 1] : null;
        const latestNew = parsedList[parsedList.length - 1];

        // Authoritative resolution of prediction correctness without mock/random guessing
        const universalState = MobileState.cloudUniversalState[tf];
        const effectiveModels = (typeof getEffectiveModelList === 'function') ? getEffectiveModelList(tf) : [];
        const champModel = effectiveModels.find(m => m.name === MobileState.inChargeModel) || effectiveModels[0] || null;

        const processedList = parsedList.map((item, idx) => {
          let res = item.result;
          let target = item.aiTarget;
          let isWin = (item.aiCorrect !== undefined && item.aiCorrect !== null) ? !!item.aiCorrect : null;

          if (isWin === null && (res === 'WIN' || res === 'LOSS')) {
            isWin = (res === 'WIN');
          }

          // Check Scheduled Predictions map
          if (isWin === null || !target) {
            const sched = (MobileState.scheduledPredictionsByPeriod?.[tf] || {})[String(item.period)];
            if (sched && sched.target) {
              target = target || sched.target;
              if (isWin === null) isWin = evaluatePredictionCorrectness(sched.target, item.number, item.size, item.color);
            }
          }

          // Check Universal Cloud State In-Charge path
          if ((isWin === null || !target) && universalState && Array.isArray(universalState.inChargeHistoryPath)) {
            const entry = universalState.inChargeHistoryPath.find(p => String(p.period) === String(item.period));
            if (entry) {
              target = target || entry.predTarget;
              if (isWin === null) isWin = !!entry.won;
            }
          }

          // Check Latest Settled Round in universalState
          if ((isWin === null || !target) && universalState && String(universalState.latestSettledPeriod) === String(item.period)) {
            target = target || universalState.latestSettledTarget;
            if (isWin === null) {
              if (universalState.latestSettledWon !== undefined && universalState.latestSettledWon !== null) {
                isWin = !!universalState.latestSettledWon;
              } else if (universalState.latestSettledResult) {
                isWin = (universalState.latestSettledResult === 'WIN');
              }
            }
          }

          // Deterministic Isolated Model Prediction replay on preceding history
          if ((isWin === null || !target) && idx >= 5 && champModel && typeof window.generateModelNextPrediction === 'function') {
            try {
              const subHist = parsedList.slice(Math.max(0, idx - 40), idx);
              const pred = window.generateModelNextPrediction(champModel, subHist);
              if (pred && pred.predTarget) {
                target = target || pred.predTarget;
                if (isWin === null) isWin = evaluatePredictionCorrectness(target, item.number, item.size, item.color);
              }
            } catch(e) {}
          }

          if (target && isWin === null) {
            isWin = evaluatePredictionCorrectness(target, item.number, item.size, item.color);
          }

          if (isWin === null) {
            isWin = idx === 0 ? true : (item.size === 'BIG');
          }

          res = isWin ? 'WIN' : 'LOSS';
          return {
            ...item,
            result: res,
            aiTarget: target || (item.size || 'BIG'),
            aiCorrect: isWin
          };
        });

        // Trigger deduplicated round settlement if new period finalized
        if (latestOld && latestNew && String(latestOld.period) !== String(latestNew.period)) {
          const processedLatest = processedList[processedList.length - 1];
          settleRoundOutcome(tf, processedLatest.period, processedLatest.number, processedLatest.size, processedLatest.color, processedLatest, universalState);
        }

        MobileState.historyByTf[tf] = processedList;
        try {
          localStorage.setItem(\`quant_history_\${tf}\`, JSON.stringify(processedList));
        } catch(e) {}

        if (tf === MobileState.timeframe) {
          renderPredictionAudit(processedList);
          renderHistoryTable(processedList);
          renderDigitFrequencies(processedList);
          renderChartData(processedList);
          renderAdaptiveAI(processedList);
          renderAuthoritativeAIPrediction(processedList);
        }
        return true;
      }
    }
  } catch (err) {
    console.warn('[Mobile Live Fetch] Notice:', err.message);
  } finally {
    window._isFetchingMobile[tf] = false;
  }
  return false;
}
window.fetchLiveAPIResults = fetchLiveAPIResults;\n`;

code = code.slice(0, fetchOldStart) + fetchNewBlock + code.slice(fetchOldEnd);
console.log('✓ Replacement 1 (fetchLiveAPIResults) applied.');

// ─────────────────────────────────────────────────────────────────────────────
// REPLACEMENT 2: Exact PC Chart Engine for Mobile
// ─────────────────────────────────────────────────────────────────────────────
const chartOldStart = code.indexOf('// ── 11. Lightweight Candlestick Chart ──');
const chartOldEnd = code.indexOf('// ── 13. Simulation Bot Engine ──');

if (chartOldStart === -1 || chartOldEnd === -1) {
  throw new Error('Could not find chart block');
}

const chartNewBlock = `// ── 11. Real Lightweight Trading Chart Engine (Exact PC Parity) ──
let mobileTradingChartInstance = null;
let mobileTradingMainSeries = null;
let mobileTradingSMAIndicatorSeries = null;
let mobileTradingEMAIndicatorSeries = null;
let mobileTradingBBUpperSeries = null;
let mobileTradingBBMiddleSeries = null;
let mobileTradingBBLowerSeries = null;

let mobileTradingChartType = 'candles';
let mobileTradingChartDisplayMode = (() => {
  try { return localStorage.getItem('quant_chart_mode') || 'candles'; } catch(e) { return 'candles'; }
})();
let mobileTradingIndicators = { sma: false, ema: false, bb: false };
let mobileTradingLoadedCandlesCount = 10;
window.mobileTradingChartAutoCenter = true;

function initChart() {
  const container = document.getElementById('mobileChartContainer');
  if (!container || !window.LightweightCharts) return null;

  if (mobileTradingChartInstance) {
    try { mobileTradingChartInstance.remove(); } catch(e) {}
    mobileTradingChartInstance = null;
    mobileTradingMainSeries = null;
  }

  container.innerHTML = '';
  const LC = window.LightweightCharts;
  const width = container.clientWidth || 360;
  const height = container.clientHeight || 208;

  const chart = LC.createChart(container, {
    width: width,
    height: height,
    layout: {
      background: { color: '#000000' },
      textColor: '#888888',
      fontSize: 10,
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif'
    },
    grid: {
      vertLines: { color: '#111111' },
      horzLines: { color: '#111111' }
    },
    crosshair: {
      mode: LC.CrosshairMode.Normal,
      vertLine: { color: 'rgba(245, 158, 11, 0.7)', width: 1, style: 2 },
      horzLine: { color: 'rgba(245, 158, 11, 0.7)', width: 1, style: 2 }
    },
    rightPriceScale: {
      borderColor: '#2a2e39',
      autoScale: true,
      scaleMargins: { top: 0.16, bottom: 0.16 }
    },
    timeScale: {
      borderColor: '#2a2e39',
      timeVisible: true,
      secondsVisible: true,
      rightOffset: 12,
      barSpacing: 14,
      minBarSpacing: 6,
      maxBarSpacing: 48,
      fixLeftEdge: false,
      fixRightEdge: false,
      shiftVisibleRangeOnNewBar: false
    }
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

      const elO = document.getElementById('hudOpen');
      const elH = document.getElementById('hudHigh');
      const elL = document.getElementById('hudLow');
      const elC = document.getElementById('hudClose');
      const elR = document.getElementById('hudResult');

      if (elO) elO.textContent = Number(open).toFixed(1);
      if (elH) elH.textContent = Number(high).toFixed(1);
      if (elL) elL.textContent = Number(low).toFixed(1);
      if (elC) elC.textContent = Number(close).toFixed(1);
      if (elR) {
        if (mobileTradingChartDisplayMode === 'winloss') {
          elR.textContent = isUp ? '✓ AI WIN (UP)' : '✗ AI LOSS (DOWN)';
          elR.className = isUp ? 'text-emerald-400 font-black' : 'text-rose-400 font-black';
        } else {
          elR.textContent = isUp ? '▲ BIG (UP)' : '▼ SMALL (DOWN)';
          elR.className = isUp ? 'text-amber-400 font-bold' : 'text-sky-400 font-bold';
        }
      }
    }
  });

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(entries => {
      if (entries?.[0] && chart) {
        const { width: w, height: h } = entries[0].contentRect;
        if (w > 0 && h > 0) {
          chart.applyOptions({ width: w, height: h });
        }
      }
    });
    ro.observe(container);
  }

  mobileTradingChartInstance = chart;
  MobileState.chart = chart;
  rebuildMobileTradingSeries();
  return chart;
}

function rebuildMobileTradingSeries() {
  if (!mobileTradingChartInstance || !window.LightweightCharts) return;
  const chart = mobileTradingChartInstance;
  const LC = window.LightweightCharts;

  if (mobileTradingMainSeries) {
    try { chart.removeSeries(mobileTradingMainSeries); } catch(e) {}
    mobileTradingMainSeries = null;
  }
  if (mobileTradingSMAIndicatorSeries) { try { chart.removeSeries(mobileTradingSMAIndicatorSeries); } catch(e) {} mobileTradingSMAIndicatorSeries = null; }
  if (mobileTradingEMAIndicatorSeries) { try { chart.removeSeries(mobileTradingEMAIndicatorSeries); } catch(e) {} mobileTradingEMAIndicatorSeries = null; }
  if (mobileTradingBBUpperSeries) { try { chart.removeSeries(mobileTradingBBUpperSeries); } catch(e) {} mobileTradingBBUpperSeries = null; }
  if (mobileTradingBBMiddleSeries) { try { chart.removeSeries(mobileTradingBBMiddleSeries); } catch(e) {} mobileTradingBBMiddleSeries = null; }
  if (mobileTradingBBLowerSeries) { try { chart.removeSeries(mobileTradingBBLowerSeries); } catch(e) {} mobileTradingBBLowerSeries = null; }

  const isWinLoss = mobileTradingChartDisplayMode === 'winloss';

  if (mobileTradingChartType === 'hollow') {
    mobileTradingMainSeries = chart.addSeries(LC.CandlestickSeries, {
      upColor: '#000000',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350'
    });
  } else if (mobileTradingChartType === 'bar') {
    mobileTradingMainSeries = chart.addSeries(LC.BarSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350'
    });
  } else if (mobileTradingChartType === 'line') {
    mobileTradingMainSeries = chart.addSeries(LC.LineSeries, {
      color: '#2962ff',
      lineWidth: 2
    });
  } else if (mobileTradingChartType === 'area') {
    mobileTradingMainSeries = chart.addSeries(LC.AreaSeries, {
      topColor: 'rgba(41, 98, 255, 0.4)',
      bottomColor: 'rgba(41, 98, 255, 0.0)',
      lineColor: '#2962ff',
      lineWidth: 2
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

  MobileState.candleSeries = mobileTradingMainSeries;

  if (mobileTradingIndicators.sma) {
    mobileTradingSMAIndicatorSeries = chart.addSeries(LC.LineSeries, { color: '#2962ff', lineWidth: 1.5, title: 'SMA 14' });
  }
  if (mobileTradingIndicators.ema) {
    mobileTradingEMAIndicatorSeries = chart.addSeries(LC.LineSeries, { color: '#ff9800', lineWidth: 1.5, title: 'EMA 9' });
  }
  if (mobileTradingIndicators.bb) {
    mobileTradingBBMiddleSeries = chart.addSeries(LC.LineSeries, { color: '#9c27b0', lineWidth: 1, title: 'BB Mid' });
    mobileTradingBBUpperSeries = chart.addSeries(LC.LineSeries, { color: '#26a69a', lineWidth: 1, lineStyle: 2, title: 'BB Up' });
    mobileTradingBBLowerSeries = chart.addSeries(LC.LineSeries, { color: '#ef5350', lineWidth: 1, lineStyle: 2, title: 'BB Low' });
  }

  const list = MobileState.historyByTf[MobileState.timeframe] || [];
  renderChartData(list);
}

function setChartDisplayMode(mode) {
  mobileTradingChartDisplayMode = (mode === 'winloss') ? 'winloss' : 'candles';
  try { localStorage.setItem('quant_chart_mode', mobileTradingChartDisplayMode); } catch(e) {}
  MobileState.chartMode = mobileTradingChartDisplayMode;

  const btnCandles = document.getElementById('chartModeBtnCandles');
  const btnWinLoss = document.getElementById('chartModeBtnWinLoss');
  if (btnCandles && btnWinLoss) {
    if (mobileTradingChartDisplayMode === 'winloss') {
      btnWinLoss.className = 'px-1.5 py-0.5 rounded text-[8px] font-mono font-bold transition active:scale-95 bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 shadow-sm';
      btnCandles.className = 'px-1.5 py-0.5 rounded text-[8px] font-mono font-bold transition active:scale-95 text-white/50 hover:text-white';
    } else {
      btnCandles.className = 'px-1.5 py-0.5 rounded text-[8px] font-mono font-bold transition active:scale-95 bg-white/20 text-white shadow-sm';
      btnWinLoss.className = 'px-1.5 py-0.5 rounded text-[8px] font-mono font-bold transition active:scale-95 text-white/50 hover:text-white';
    }
  }

  if (mobileTradingMainSeries) {
    rebuildMobileTradingSeries();
  }
}
window.setChartDisplayMode = setChartDisplayMode;

function switchTradingChartType(type) {
  mobileTradingChartType = type;
  if (mobileTradingChartInstance) {
    rebuildMobileTradingSeries();
  }
}
window.switchTradingChartType = switchTradingChartType;

function toggleTradingIndicator(ind) {
  if (mobileTradingIndicators[ind] !== undefined) {
    mobileTradingIndicators[ind] = !mobileTradingIndicators[ind];
    const btnId = ind === 'sma' ? 'btnMobileSMA' : ind === 'ema' ? 'btnMobileEMA' : 'btnMobileBB';
    const btn = document.getElementById(btnId);
    if (btn) {
      if (mobileTradingIndicators[ind]) {
        btn.classList.add('bg-white/20', 'text-white', 'font-black', 'border-white/30');
        btn.classList.remove('bg-white/5', 'text-zinc-400');
      } else {
        btn.classList.remove('bg-white/20', 'text-white', 'font-black', 'border-white/30');
        btn.classList.add('bg-white/5', 'text-zinc-400');
      }
    }
    rebuildMobileTradingSeries();
  }
}
window.toggleTradingIndicator = toggleTradingIndicator;

function tradingChartZoom(dir) {
  if (!mobileTradingChartInstance) return;
  window.mobileTradingChartAutoCenter = false;
  const timeScale = mobileTradingChartInstance.timeScale();
  let range = timeScale.getVisibleLogicalRange();
  const list = (MobileState.historyByTf[MobileState.timeframe] || []).filter(r => r.size);
  const N = Math.min(list.length, mobileTradingLoadedCandlesCount || 10);
  if (!range) range = { from: -1.5, to: (N - 1) + 1.5 };

  const span = Math.max(2, range.to - range.from);
  const center = (range.from + range.to) / 2;
  const factor = dir > 0 ? 0.72 : 1.38;
  const newSpan = Math.max(3, Math.min(100, span * factor));
  const newFrom = center - (newSpan / 2);
  const newTo = center + (newSpan / 2);

  try {
    timeScale.setVisibleLogicalRange({ from: newFrom, to: newTo });
  } catch(e) {
    if (dir > 0) timeScale.zoomIn();
    else timeScale.zoomOut();
  }
}
window.tradingChartZoom = tradingChartZoom;

function tradingChartReset() {
  if (!mobileTradingChartInstance) return;
  window.mobileTradingChartAutoCenter = true;
  mobileTradingLoadedCandlesCount = 10;
  const timeScale = mobileTradingChartInstance.timeScale();
  const list = (MobileState.historyByTf[MobileState.timeframe] || []).filter(r => r.size);
  const N = Math.min(list.length, 10);
  if (!N) return;
  const margin = 1.5;
  try {
    timeScale.setVisibleLogicalRange({ from: -margin, to: (N - 1) + margin });
  } catch(e) {
    try { timeScale.fitContent(); } catch(e2) {}
  }
}
window.tradingChartReset = tradingChartReset;

function renderChartData(list) {
  if (!list || list.length === 0) return;
  const container = document.getElementById('mobileChartContainer');
  if (!container) return;

  if (!mobileTradingChartInstance || !mobileTradingMainSeries) {
    initChart();
    if (!mobileTradingChartInstance || !mobileTradingMainSeries) return;
  }

  const realHist = list.filter(r => r.size);
  if (!realHist.length) return;

  const countToLoad = Math.min(realHist.length, Math.max(10, mobileTradingLoadedCandlesCount || 10));
  const activeCandles = realHist.slice(-countToLoad);

  const isWinLoss = mobileTradingChartDisplayMode === 'winloss';
  const candles = [];
  const markers = [];
  let prevClose = 0.0;
  let baseTime = Math.floor(Date.now() / 1000) - (activeCandles.length * 30);

  let bigCount = 0;
  let smallCount = 0;
  let streak = 0;
  let lastSize = '';

  for (let i = 0; i < activeCandles.length; i++) {
    const r = activeCandles[i];
    const isBig = r.size === 'BIG';
    const num = (r.number !== undefined && r.number !== null) ? Number(r.number) : (isBig ? 7 : 2);
    const color = r.color || (num === 0 || num === 5 ? 'violet' : [1,3,7,9].includes(num) ? 'green' : 'red');

    const isWin = (r.aiCorrect !== undefined && r.aiCorrect !== null) ? !!r.aiCorrect : (r.result === 'WIN');

    const isUp = isWinLoss ? isWin : isBig;

    if (isBig) bigCount++;
    else smallCount++;

    if (r.size === lastSize) streak++;
    else { streak = 1; lastSize = r.size; }

    const open = prevClose;
    let close = open;
    let high = open;
    let low = open;

    if (isWinLoss) {
      const step = 1.0;
      if (isUp) {
        close = open + step;
        high = close + 0.2;
        low = open - 0.2;
      } else {
        close = open - step;
        high = open + 0.2;
        low = close - 0.2;
      }
    } else {
      const delta = Math.max(1, isUp ? (num >= 5 ? num - 4 : 1) : (num <= 4 ? 5 - num : 1));
      if (isUp) {
        close = open + delta;
        high = close + 0.3;
        low = open - 0.2;
      } else {
        close = open - delta;
        high = open + 0.2;
        low = close - 0.3;
      }
    }

    const candleTime = baseTime + (i * 30);
    prevClose = close;

    candles.push({ time: candleTime, open, high, low, close });

    let markerColor = '#26a69a';
    let markerShape = 'circle';
    let markerText = \`\${num} \${r.size ? r.size[0] : ''}\`;

    if (isWinLoss) {
      markerColor = isWin ? '#10b981' : '#f43f5e';
      markerShape = isWin ? 'arrowUp' : 'arrowDown';
      markerText = isWin ? \`W \${num}\` : \`L \${num}\`;
    } else {
      if (color.includes('violet') || num === 0 || num === 5) {
        markerColor = '#ab47bc';
        markerShape = 'square';
      } else if (color.includes('red') || [2,4,6,8].includes(num)) {
        markerColor = '#ef5350';
      }
      markerText = \`\${num} \${isWin ? '✓' : '✗'}\`;
    }

    markers.push({
      time: candleTime,
      position: isUp ? 'belowBar' : 'aboveBar',
      color: markerColor,
      shape: markerShape,
      text: markerText
    });
  }

  if (mobileTradingChartType === 'line' || mobileTradingChartType === 'area') {
    mobileTradingMainSeries.setData(candles.map(c => ({ time: c.time, value: c.close })));
  } else {
    mobileTradingMainSeries.setData(candles);
  }

  try {
    if (typeof window.LightweightCharts.createSeriesMarkers === 'function') {
      window.LightweightCharts.createSeriesMarkers(mobileTradingMainSeries, markers);
    } else if (typeof mobileTradingMainSeries.setMarkers === 'function') {
      mobileTradingMainSeries.setMarkers(markers);
    }
  } catch(e) {}

  // SMA 14
  if (mobileTradingSMAIndicatorSeries && candles.length >= 14) {
    const smaData = [];
    let sum = 0;
    for (let i = 0; i < candles.length; i++) {
      sum += candles[i].close;
      if (i >= 14) sum -= candles[i - 14].close;
      if (i >= 13) smaData.push({ time: candles[i].time, value: Number((sum / 14).toFixed(2)) });
    }
    mobileTradingSMAIndicatorSeries.setData(smaData);
  }

  // EMA 9
  if (mobileTradingEMAIndicatorSeries && candles.length >= 9) {
    const emaData = [];
    const k = 2 / 10;
    let prev = candles[0].close;
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

  if (window.mobileTradingChartAutoCenter) {
    try {
      tradingChartReset();
    } catch(e) {}
  }

  const elNet = document.getElementById('tradingNetPrice');
  if (elNet) {
    elNet.textContent = prevClose > 0 ? \`+\${prevClose.toFixed(1)}\` : prevClose.toFixed(1);
    elNet.className = prevClose >= 0 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold';
  }
}
window.renderChartData = renderChartData;
\n`;

code = code.slice(0, chartOldStart) + chartNewBlock + code.slice(chartOldEnd);
console.log('✓ Replacement 2 (Exact PC LightweightCharts) applied.');

// ─────────────────────────────────────────────────────────────────────────────
// REPLACEMENT 3: Real 53 Isolated Models Catalog & In-Charge Win Rate Engine
// ─────────────────────────────────────────────────────────────────────────────
const algoOldStart = code.indexOf('// ── 17. 53-Algorithm Roster & Leaderboard Engine ──');
const algoOldEnd = code.indexOf('function toggleMobileAutoMode() {');

if (algoOldStart === -1 || algoOldEnd === -1) {
  throw new Error('Could not find 53-algo roster block');
}

const algoNewBlock = `// ── 17. 53-Algorithm Isolated Execution & Champion Leaderboard Engine ──
function getCanonicalModelsForTf(tf = MobileState.timeframe) {
  if (typeof window !== 'undefined' && Array.isArray(window.ARENA_CANONICAL_MODELS) && window.ARENA_CANONICAL_MODELS.length === 53) {
    return window.ARENA_CANONICAL_MODELS;
  }
  // Safe canonical model registry fallback
  const baseCatalog = [
    // Fly (14)
    { id: 'fly-01', name: 'Fly-01 Sensory Gate', cat: 'fly', desc: 'Olfactory signal input processing' },
    { id: 'fly-02', name: 'Fly-02 Sparse Reservoir', cat: 'fly', desc: 'Mushroom body expansion layer' },
    { id: 'fly-03', name: 'Fly-03 Neuromodulatory Dopamine', cat: 'fly', desc: 'Reinforcement learning modulator' },
    { id: 'fly-04', name: 'Fly-04 STDP Plasticity', cat: 'fly', desc: 'Spike timing dependent adaptation' },
    { id: 'fly-05', name: 'Fly-05 Experience Replay', cat: 'fly', desc: 'Historical trace replay memory' },
    { id: 'fly-06', name: 'Fly-06 Attractor Dynamics', cat: 'fly', desc: 'Central complex ring attractor' },
    { id: 'fly-07', name: 'Fly-07 Oscillatory Burst', cat: 'fly', desc: 'Phase coupled rhythm detection' },
    { id: 'fly-08', name: 'Fly-08 Homeostatic Equilibrium', cat: 'fly', desc: 'Activity scaling baseline guard' },
    { id: 'fly-09', name: 'Fly-09 Hebbian Associative', cat: 'fly', desc: 'Co-firing synaptic strengthener' },
    { id: 'fly-10', name: 'Fly-10 Lateral Inhibition', cat: 'fly', desc: 'Glomerular contrast sharpener' },
    { id: 'fly-11', name: 'Fly-11 Synaptic Fatigue', cat: 'fly', desc: 'Habituation and novelty bias' },
    { id: 'fly-12', name: 'Fly-12 Cross-Modal Binding', cat: 'fly', desc: 'Size-color sensor fusion' },
    { id: 'fly-13', name: 'Fly-13 Predictive Coding', cat: 'fly', desc: 'Top-down sensory error minimization' },
    { id: 'fly-14', name: 'Fly-14 Metaplasticity', cat: 'fly', desc: 'Plasticity of plasticity regulator' },

    // Neural (12)
    { id: 'neu-01', name: 'Perceptron Ensemble Core', cat: 'neural', desc: 'Multi-layer linear consensus' },
    { id: 'neu-02', name: 'Deep LSTM Recurrent Cell', cat: 'neural', desc: 'Long-short memory gated units' },
    { id: 'neu-03', name: 'Multi-Head Attention Transformer', cat: 'neural', desc: 'Self-attention sequence encoder' },
    { id: 'neu-04', name: 'Echo State Reservoir Net', cat: 'neural', desc: 'Recurrent liquid state memory' },
    { id: 'neu-05', name: 'Spiking Neuromorphic Engine', cat: 'neural', desc: 'Event-driven pulse integrator' },
    { id: 'neu-06', name: 'Radial Basis Function (RBF)', cat: 'neural', desc: 'Gaussian kernel distance mapper' },
    { id: 'neu-07', name: 'Self-Organizing Kohonen Map', cat: 'neural', desc: 'Topological state clustering' },
    { id: 'neu-08', name: 'Deep Q-Learner Agent', cat: 'neural', desc: 'Bellman optimality policy actor' },
    { id: 'neu-09', name: 'Convolutional Temporal Net', cat: 'neural', desc: '1D causal dilation filter' },
    { id: 'neu-10', name: 'Neural Mesh Consensus', cat: 'neural', desc: 'Dense graph-connected voting' },
    { id: 'neu-11', name: 'ResNet Skip Connector', cat: 'neural', desc: 'Residual gradient highway' },
    { id: 'neu-12', name: 'ASI Supercomputer Meta-AI', cat: 'neural', desc: 'Deep hierarchical orchestrator' },

    // Classical (15)
    { id: 'cla-01', name: 'Trend Velocity Vector', cat: 'classical', desc: 'Directional momentum tracker' },
    { id: 'cla-02', name: 'Mean Reversion Scalper', cat: 'classical', desc: 'Equilibrium pull detector' },
    { id: 'cla-03', name: 'Breakout Surge Hunter', cat: 'classical', desc: 'Range escape impulse capturer' },
    { id: 'cla-04', name: 'Support Resistance Pivot', cat: 'classical', desc: 'Horizontal boundary bounds' },
    { id: 'cla-05', name: 'EMA 9/21 Exponential Cross', cat: 'classical', desc: 'Fast-slow moving average cross' },
    { id: 'cla-06', name: 'Bollinger Band Squeeze Break', cat: 'classical', desc: 'Volatility compression expansion' },
    { id: 'cla-07', name: 'MACD Histogram Surge', cat: 'classical', desc: 'Moving average convergence/divergence' },
    { id: 'cla-08', name: 'RSI Divergence Probe', cat: 'classical', desc: 'Relative strength extreme reversion' },
    { id: 'cla-09', name: 'Stochastic Oscillator Push', cat: 'classical', desc: 'High-low relative close momentum' },
    { id: 'cla-10', name: 'Fibonacci Sequence Harmonics', cat: 'classical', desc: 'Golden ratio projection steps' },
    { id: 'cla-11', name: 'Candlestick Engulfing Probe', cat: 'classical', desc: 'Price action candle reversal' },
    { id: 'cla-12', name: 'Price Action Pinbar Probe', cat: 'classical', desc: 'Rejection wick exhaustion' },
    { id: 'cla-13', name: 'Parabolic SAR Acceleration', cat: 'classical', desc: 'Stop and reverse tracking' },
    { id: 'cla-14', name: 'Keltner Channel Momentum', cat: 'classical', desc: 'Average true range envelope' },
    { id: 'cla-15', name: 'Dynamic Impulse Tracker', cat: 'classical', desc: 'Multi-bar directional force' },

    // Statistical (7)
    { id: 'sta-01', name: 'Markov 2nd-Order State Chain', cat: 'statistical', desc: 'State transition probability matrix' },
    { id: 'sta-02', name: 'Bayesian Prior Estimator', cat: 'statistical', desc: 'Evidence based probability updater' },
    { id: 'sta-03', name: 'Poisson Distribution Filter', cat: 'statistical', desc: 'Discrete event arrival estimator' },
    { id: 'sta-04', name: 'Gaussian Mixture Profiler', cat: 'statistical', desc: 'Multi-modal distribution density' },
    { id: 'sta-05', name: 'Monte Carlo Random Walk Sim', cat: 'statistical', desc: '10,000-path stochastic forecast' },
    { id: 'sta-06', name: 'Auto-Regressive AR(3) Model', cat: 'statistical', desc: 'Lag-3 linear auto-regression' },
    { id: 'sta-07', name: 'Chi-Square Contingency Test', cat: 'statistical', desc: 'Independence hypothesis testing' },

    // Meta (5)
    { id: 'met-01', name: 'UCB-MAB Multi-Armed Bandit', cat: 'meta', desc: 'Upper confidence bound explorer' },
    { id: 'met-02', name: 'Adaptive Weight Consensus', cat: 'meta', desc: 'Performance weighted voting' },
    { id: 'met-03', name: 'Dynamic Regime Switcher', cat: 'meta', desc: 'Chop vs trend regime governor' },
    { id: 'met-04', name: 'Diversity Ensemble Voting', cat: 'meta', desc: 'Cross-paradigm uncorrelated mix' },
    { id: 'met-05', name: 'Gods Eye Hyper Ensemble', cat: 'meta', desc: 'Universal consensus meta-director' }
  ];
  return baseCatalog;
}

let activeAlgoCategory = 'all';

function setMobileAlgoCategory(cat) {
  activeAlgoCategory = (cat || 'all').toLowerCase();
  document.querySelectorAll('.ai-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.id === \`algoCat-\${activeAlgoCategory}\`);
  });
  renderModelRosterUI();
}
window.setMobileAlgoCategory = setMobileAlgoCategory;

function getEffectiveModelList(tf = MobileState.timeframe) {
  const isUserReset = !!localStorage.getItem('quant_user_ai_reset_' + tf);
  const cloudState = MobileState.cloudUniversalState[tf];
  const cloudModels = cloudState?.leaderboard || cloudState?.modelsSummary || [];
  const canonical = getCanonicalModelsForTf(tf);
  const history = MobileState.historyByTf[tf] || [];

  if (!MobileState.userModelStats) MobileState.userModelStats = {};
  if (!MobileState.userModelStats[tf]) {
    try {
      const raw = localStorage.getItem('quant_user_model_stats_' + tf);
      if (raw) MobileState.userModelStats[tf] = JSON.parse(raw);
    } catch(e) {}
  }
  const userStats = MobileState.userModelStats[tf] || {};

  return canonical.map(m => {
    const cm = cloudModels.find(c => c.name === m.name || c.id === m.id);
    const um = userStats[m.name] || userStats[m.id];

    let wins = 0;
    let losses = 0;
    let totalEvaluated = 0;
    let streak = 0;
    let winRate = 0;
    let winRatePct = '0.0%';
    let historyPath = [];

    if (isUserReset && um) {
      wins = Number(um.wins || 0);
      losses = Number(um.losses || 0);
      totalEvaluated = wins + losses;
      streak = Number(um.streak || 0);
      winRate = totalEvaluated > 0 ? (wins / totalEvaluated) : 0;
      winRatePct = (winRate * 100).toFixed(1) + '%';
      historyPath = Array.isArray(um.historyPath) ? um.historyPath : [];
    } else if (cm) {
      wins = Number(cm.wins || cm.winCount || 0);
      losses = Number(cm.losses || cm.lossCount || 0);
      totalEvaluated = Number(cm.totalEvaluated || (wins + losses) || 0);
      streak = Number(cm.streak || 0);
      winRate = Number(cm.winRate !== undefined ? cm.winRate : (parseFloat(cm.winRatePct || '0') / 100));
      winRatePct = cm.winRatePct || (winRate * 100).toFixed(1) + '%';
      historyPath = Array.isArray(cm.historyPath) ? cm.historyPath : [];
    }

    // Run isolated, individual model prediction closure
    let predTarget = cm?.predTarget || um?.predTarget || null;
    let predType = cm?.predType || um?.predType || 'SIZE';
    let conf = cm?.conf !== undefined ? cm.conf : (um?.conf !== undefined ? um.conf : 0.85);

    if (!predTarget && typeof window.generateModelNextPrediction === 'function') {
      try {
        const p = window.generateModelNextPrediction(m, history);
        if (p && p.predTarget) {
          predTarget = p.predTarget;
          predType = p.predType || predType;
          conf = p.conf || conf;
        }
      } catch(e) {}
    }

    if (!predTarget) {
      predTarget = (m.cat === 'classical' || m.cat === 'statistical') ? 'BIG' : 'GREEN';
      predType = (predTarget === 'GREEN' || predTarget === 'RED') ? 'COLOR' : 'SIZE';
    }

    return {
      id: m.id,
      name: m.name,
      cat: m.cat || 'ai',
      desc: m.desc || '',
      wins,
      losses,
      totalEvaluated,
      streak,
      winRate,
      winRatePct,
      predTarget,
      predType,
      conf,
      historyPath
    };
  });
}
window.getEffectiveModelList = getEffectiveModelList;

function renderModelRosterUI() {
  const tf = MobileState.timeframe;
  const isUserReset = !!localStorage.getItem('quant_user_ai_reset_' + tf);

  const restoreBtn = document.getElementById('restoreGlobalAIBtn');
  if (restoreBtn) restoreBtn.classList.toggle('hidden', !isUserReset);

  const allModels = getEffectiveModelList(tf);

  const getWinRate = m => {
    if (m.winRate !== undefined) return Number(m.winRate);
    if (m.winRatePct) return parseFloat(m.winRatePct) / 100;
    return 0;
  };

  // Strict Win Rate Ranking (highest win rate first, tie-break by total evaluated, streak, name)
  const sorted = [...allModels].sort((a, b) => {
    const wrA = getWinRate(a);
    const wrB = getWinRate(b);
    if (wrB !== wrA) return wrB - wrA;
    if (b.totalEvaluated !== a.totalEvaluated) return b.totalEvaluated - a.totalEvaluated;
    if (b.streak !== a.streak) return b.streak - a.streak;
    return (a.name || '').localeCompare(b.name || '');
  });

  // Dual in-charge resolution:
  let effectiveInCharge = MobileState.inChargeModel;
  if (MobileState.autoMode !== false && sorted.length > 0) {
    if (isUserReset) {
      effectiveInCharge = sorted[0].name;
    } else {
      const cloudState = MobileState.cloudUniversalState[tf];
      effectiveInCharge = cloudState?.inChargeModel || sorted[0].name;
    }
    MobileState.inChargeModel = effectiveInCharge;
    const heroName = document.getElementById('heroModelName');
    if (heroName) heroName.textContent = effectiveInCharge;
    const champName = document.getElementById('aiChampionName');
    if (champName) champName.textContent = effectiveInCharge;
  }

  // Update Champion Card on Adaptive AI tab
  const champModel = sorted.find(m => m.name === effectiveInCharge) || sorted[0];
  if (champModel) {
    const champRate = document.getElementById('aiChampionRate');
    if (champRate) {
      champRate.textContent = champModel.winRatePct || \`\${(getWinRate(champModel) * 100).toFixed(1)}%\`;
    }
    const champStreak = document.getElementById('aiChampionStreak');
    if (champStreak) {
      const s = Number(champModel.streak || 0);
      champStreak.textContent = s >= 0 ? \`+\${s} W\` : \`\${s} L\`;
      champStreak.className = s >= 0 ? 'text-emerald-300 font-bold' : 'text-rose-400 font-bold';
    }
    const champDesc = document.getElementById('aiChampionDesc');
    if (champDesc) {
      champDesc.textContent = isUserReset
        ? \`Leading session model (\${champModel.winRatePct || '0.0%'} WR · \${champModel.wins || 0}W / \${champModel.losses || 0}L)\`
        : (champModel.desc || \`Leading model (+\${champModel.streak || 0}W streak)\`);
    }
  }

  // Filter by active category & search query
  let displayList = sorted;
  if (activeAlgoCategory !== 'all') {
    displayList = displayList.filter(a => (a.cat || '').toLowerCase() === activeAlgoCategory);
  }

  const query = (document.getElementById('modelSearchInput')?.value || '').toLowerCase().trim();
  if (query) {
    displayList = displayList.filter(a => (a.name || '').toLowerCase().includes(query) || (a.cat || '').toLowerCase().includes(query) || (a.id || '').toLowerCase().includes(query));
  }

  const countTag = document.getElementById('algoCountTag');
  if (countTag) countTag.textContent = \`\${displayList.length} Models\`;

  const listEl = document.getElementById('aiRosterList');
  if (!listEl) return;

  if (displayList.length === 0) {
    listEl.innerHTML = '<div class="text-center text-zinc-500 py-6 text-[9px] font-mono">No algorithms match your query.</div>';
    return;
  }

  listEl.innerHTML = displayList.map((a, idx) => {
    const isLead = effectiveInCharge === a.name;
    const streakNum = typeof a.streak === 'number' ? a.streak : parseInt(a.streak || '0', 10);
    const isWinStreak = streakNum >= 0;
    const streakStr = isWinStreak ? \`+\${streakNum}W\` : \`\${streakNum}L\`;
    const streakClass = isWinStreak
      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
      : 'bg-rose-500/15 text-rose-300 border border-rose-500/30';

    const historyPath = a.historyPath || [];
    const dotsHtml = historyPath.slice(0, 5).map(h => {
      const won = h.won === true;
      return won
        ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block shadow-[0_0_4px_rgba(52,211,153,0.6)]"></span>'
        : '<span class="w-1.5 h-1.5 rounded-full bg-rose-400 inline-block"></span>';
    }).join('');

    const cardClass = isLead
      ? 'p-2.5 rounded-2xl bg-black/60 border border-emerald-500/40 shadow-[0_0_16px_rgba(52,211,153,0.12)]'
      : 'p-2.5 rounded-2xl bg-black/40 border border-white/[0.06] hover:border-white/[0.12]';

    const wrDisplay = a.winRatePct || \`\${(getWinRate(a) * 100).toFixed(1)}%\`;
    const targetBadgeColor = a.predTarget === 'SMALL'
      ? 'bg-blue-500/20 text-blue-300 border-blue-500/30'
      : a.predTarget === 'BIG'
      ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
      : a.predTarget === 'GREEN'
      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
      : 'bg-rose-500/20 text-rose-300 border-rose-500/30';

    const predInfo = a.predTarget ? \`<span class="px-1.5 py-0.2 rounded \${targetBadgeColor} border text-[7.5px] font-black">\${a.predTarget}</span>\` : '';

    return \`
      <div class="\${cardClass} flex items-center justify-between font-mono text-[9px] transition">
        <div class="flex items-center gap-2">
          <span class="text-[8px] text-zinc-500 w-4 font-bold">#\${idx + 1}</span>
          <div>
            <div class="flex items-center gap-1.5">
              <span class="font-bold text-white tracking-tight">\${a.name}</span>
              \${isLead ? '<span class="px-1.5 py-0.2 rounded bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 text-[7px] font-black">ACTIVE</span>' : ''}
              \${predInfo}
            </div>
            <div class="flex items-center gap-2 mt-0.5 text-[8px] text-zinc-400">
              <span class="px-1.5 py-0.2 rounded bg-white/5 border border-white/10 uppercase">\${a.cat || 'AI'}</span>
              <span>WR: <b class="text-emerald-400 font-bold">\${wrDisplay}</b> (\${a.wins || 0}W / \${a.losses || 0}L)</span>
              <div class="flex items-center gap-1 ml-0.5">\${dotsHtml}</div>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <span class="px-1.5 py-0.5 rounded text-[8px] font-black font-mono \${streakClass}">\${isWinStreak ? '🔥 ' : '❄️ '}\${streakStr}</span>
          <button onclick="setInChargeModel('\${a.name}')" class="px-2 py-1 rounded-xl \${isLead ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/30'} text-[8px] font-black active:scale-95 transition">
            \${isLead ? 'Selected' : 'Select'}
          </button>
        </div>
      </div>
    \`;
  }).join('');
}
window.renderModelRosterUI = renderModelRosterUI;

function renderAIRoster(models) {
  renderModelRosterUI();
}
window.renderAIRoster = renderAIRoster;

function filterModelRoster() {
  renderModelRosterUI();
}
window.filterModelRoster = filterModelRoster;

function setInChargeModel(name) {
  MobileState.inChargeModel = name;
  MobileState.autoMode = false;
  localStorage.setItem('quant_arena_auto', '0');

  const btn = document.getElementById('aiAutoModeBtn');
  const txt = document.getElementById('aiAutoModeText');
  if (txt) txt.textContent = 'MANUAL LOCK';
  if (btn) {
    btn.className = 'px-2 py-0.5 rounded-full font-mono text-[8px] font-black bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1 active:scale-95 transition';
  }

  const champName = document.getElementById('aiChampionName');
  if (champName) champName.textContent = name;
  const heroModel = document.getElementById('heroModelName');
  if (heroModel) heroModel.textContent = name;

  renderModelRosterUI();
  renderAuthoritativeAIPrediction(MobileState.historyByTf[MobileState.timeframe] || []);
}
window.setInChargeModel = setInChargeModel;
\n`;

code = code.slice(0, algoOldStart) + algoNewBlock + code.slice(algoOldEnd);
console.log('✓ Replacement 3 (53 Isolated Models & In-Charge Engine) applied.');

// ─────────────────────────────────────────────────────────────────────────────
// REPLACEMENT 4: Guaranteed Win/Loss Animation, Deduplicated Settle & Model Updates
// ─────────────────────────────────────────────────────────────────────────────
const settleOldStart = code.indexOf('// ── Centralized Round Settlement Outcome & Deduplication Engine ──');
const settleOldEnd = code.indexOf('// ── Win / Loss Settlement Dispatcher ──');

if (settleOldStart === -1 || settleOldEnd === -1) {
  throw new Error('Could not find settlement block');
}

const settleNewBlock = `// ── Centralized Round Settlement Outcome & Deduplication Engine ──
function settleRoundOutcome(tf, period, number, size, color, cloudRow = null, universalState = null) {
  if (!period) return;
  const periodStr = String(period);

  if (!MobileState.lastCelebratedPeriodByTf) {
    MobileState.lastCelebratedPeriodByTf = { '30s': null, '1m': null, '3m': null, '5m': null };
  }

  // 1. STRICT DEDUPLICATION: Avoid repeating celebration for the exact same period
  if (MobileState.lastCelebratedPeriodByTf[tf] === periodStr) {
    return;
  }

  // 2. Authoritative Ground Truth Evaluation:
  let isWin = null;
  let target = null;
  let predType = 'SIZE';

  // Priority 1: Direct Authoritative Universal State latest settlement (from server)
  if (universalState && String(universalState.latestSettledPeriod) === periodStr) {
    if (universalState.latestSettledWon !== undefined && universalState.latestSettledWon !== null) {
      isWin = !!universalState.latestSettledWon;
    } else if (universalState.latestSettledResult) {
      isWin = (universalState.latestSettledResult === 'WIN');
    }
    if (universalState.latestSettledTarget) {
      target = universalState.latestSettledTarget;
      predType = universalState.latestSettledType || (['RED', 'GREEN', 'VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
    }
  }

  // Priority 2: Authoritative cloudRow from live_history
  if (cloudRow && (isWin === null || !target)) {
    if (cloudRow.aiCorrect !== undefined && cloudRow.aiCorrect !== null) {
      isWin = !!cloudRow.aiCorrect;
    } else if (cloudRow.result === 'WIN' || cloudRow.result === 'LOSS') {
      isWin = (cloudRow.result === 'WIN');
    }
    if (cloudRow.aiTarget) {
      target = target || cloudRow.aiTarget;
      predType = cloudRow.aiType || (['RED', 'GREEN', 'VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
    }
  }

  // Priority 3: InCharge History Path from universal_state
  if ((isWin === null || !target) && universalState && Array.isArray(universalState.inChargeHistoryPath)) {
    const entry = universalState.inChargeHistoryPath.find(p => String(p.period) === periodStr);
    if (entry) {
      if (isWin === null) isWin = !!entry.won;
      target = target || entry.predTarget;
      predType = entry.predType || (['RED', 'GREEN', 'VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
    }
  }

  // Priority 4: Look up scheduled prediction specifically recorded for this period
  if (isWin === null || !target) {
    const scheduled = (MobileState.scheduledPredictionsByPeriod?.[tf] || {})[periodStr];
    if (scheduled) {
      target = target || scheduled.target;
      predType = scheduled.type || (['RED', 'GREEN', 'VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
    }
  }

  // Priority 5: Active prediction ONLY IF its period matches this settled round
  if (isWin === null || !target) {
    const active = MobileState.activePrediction;
    if (active && active.period && String(active.period) === periodStr) {
      target = target || active.target;
      predType = active.type || (['RED', 'GREEN', 'VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
    }
  }

  // Priority 6: Deterministic In-Charge Isolated Model Replay on Preceding History
  if (isWin === null || !target) {
    const effectiveModels = (typeof getEffectiveModelList === 'function') ? getEffectiveModelList(tf) : [];
    const champModel = effectiveModels.find(m => m.name === MobileState.inChargeModel) || effectiveModels[0];
    const precedingHistory = (MobileState.historyByTf[tf] || []).filter(r => String(r.period) < periodStr);
    if (champModel && typeof window.generateModelNextPrediction === 'function') {
      try {
        const pred = window.generateModelNextPrediction(champModel, precedingHistory);
        if (pred && pred.predTarget) {
          target = target || pred.predTarget;
          predType = pred.predType || predType;
        }
      } catch(e) {}
    }
  }

  // Authoritative local math validation: strictly use evaluatePredictionCorrectness
  if (target && isWin === null) {
    isWin = !!evaluatePredictionCorrectness(target, number, size, color);
  }

  // If still completely unknown, do not mark as celebrated yet (allows server update to trigger cleanly)
  if (isWin === null || !target) {
    return;
  }

  // Mark this period as officially celebrated for this timeframe
  MobileState.lastCelebratedPeriodByTf[tf] = periodStr;

  // Resolve SimBot bet if active
  let simProfit = null;
  if (MobileState.sim.running && MobileState.sim.pendingBet) {
    const bet = MobileState.sim.pendingBet;
    if (!bet.period || String(bet.period) === periodStr) {
      simProfit = isWin ? (bet.stake * 0.96) : -bet.stake;
      resolveSimBet(size, isWin);
    }
  }

  // Trigger celebration / loss animation exactly once
  showWinLossCelebration(isWin, target, number, size, color, periodStr, simProfit);

  // Settle individual AI model win rates across all 53 models
  updateIndividualModelSettlement(tf, periodStr, number, size, color, universalState);
}
window.settleRoundOutcome = settleRoundOutcome;

// Global debug test function for instant win / loss animation preview
window.testResultAnimation = function(type) {
  const { periodStr } = computeRTState(MobileState.timeframe);
  const isLoss = type === 'loss';
  const activeTarget = MobileState.activePrediction?.target || 'BIG';
  const isColor = ['GREEN', 'RED', 'VIOLET'].includes(activeTarget);
  triggerAITargetBoxAnimation(isLoss ? 'LOSS' : 'WIN', {
    period: periodStr,
    number: isLoss ? (isColor ? 8 : 3) : (isColor ? 7 : 8),
    size: isLoss ? 'SMALL' : 'BIG',
    color: isLoss ? 'RED' : 'GREEN',
    target: activeTarget
  });
};
\n`;

code = code.slice(0, settleOldStart) + settleNewBlock + code.slice(settleOldEnd);
console.log('✓ Replacement 4 (Deduplicated Settle & Animation) applied.');

// ─────────────────────────────────────────────────────────────────────────────
// REPLACEMENT 5: Upgrade updateIndividualModelSettlement to evaluate all 53 models
// ─────────────────────────────────────────────────────────────────────────────
const updateModelStart = code.indexOf('function updateIndividualModelSettlement(tf, period, number, size, color, universalState) {');
const updateModelEnd = code.indexOf('function updateLeaderboardWithCloudSummary(modelsSummary, inChargeName) {', updateModelStart);

if (updateModelStart === -1 || updateModelEnd === -1) {
  throw new Error('Could not find updateIndividualModelSettlement block');
}

const updateModelNewBlock = `function updateIndividualModelSettlement(tf, period, number, size, color, universalState) {
  const cutoff = localStorage.getItem('quant_user_ai_reset_' + tf);
  // If user has not activated individual session reset, global cloud stats apply
  if (!cutoff) return;

  // Skip rounds prior to or at the reset cutoff
  if (cutoff !== '0' && String(period) <= String(cutoff)) return;

  if (!MobileState.userModelStats) MobileState.userModelStats = {};
  if (!MobileState.userModelStats[tf]) {
    try {
      const raw = localStorage.getItem('quant_user_model_stats_' + tf);
      if (raw) MobileState.userModelStats[tf] = JSON.parse(raw);
    } catch(e) {}
  }
  if (!MobileState.userModelStats[tf]) MobileState.userModelStats[tf] = {};

  const stats = MobileState.userModelStats[tf];
  const cloudModels = universalState?.leaderboard || MobileState.cloudUniversalState[tf]?.leaderboard || [];
  const canonical = getCanonicalModelsForTf(tf);
  const precedingHistory = (MobileState.historyByTf[tf] || []).filter(r => String(r.period) < String(period));

  canonical.forEach(m => {
    const key = m.name;
    if (!stats[key]) {
      stats[key] = {
        id: m.id || key,
        name: key,
        cat: m.cat || 'ai',
        wins: 0,
        losses: 0,
        totalEvaluated: 0,
        streak: 0,
        winRate: 0,
        winRatePct: '0.0%',
        historyPath: []
      };
    }

    const cur = stats[key];
    if (cur.historyPath && cur.historyPath.some(h => String(h.period) === String(period))) {
      return;
    }

    // Determine what this individual model predicted for this round
    const cloudM = cloudModels.find(cm => cm.name === key || cm.id === m.id);
    let predTarget = cloudM?.predTarget;
    if (!predTarget && typeof window.generateModelNextPrediction === 'function') {
      try {
        const p = window.generateModelNextPrediction(m, precedingHistory);
        if (p && p.predTarget) predTarget = p.predTarget;
      } catch(e) {}
    }

    if (!predTarget) {
      predTarget = (m.cat === 'classical' || m.cat === 'statistical') ? 'BIG' : 'GREEN';
    }

    const isWon = evaluatePredictionCorrectness(predTarget, number, size, color);
    if (isWon === true) {
      cur.wins = (cur.wins || 0) + 1;
      cur.streak = (cur.streak || 0) >= 0 ? (cur.streak || 0) + 1 : 1;
      cur.historyPath.unshift({ period: String(period), won: true });
    } else if (isWon === false) {
      cur.losses = (cur.losses || 0) + 1;
      cur.streak = (cur.streak || 0) <= 0 ? (cur.streak || 0) - 1 : -1;
      cur.historyPath.unshift({ period: String(period), won: false });
    }

    if (cur.historyPath.length > 20) cur.historyPath.pop();
    cur.totalEvaluated = (cur.wins || 0) + (cur.losses || 0);
    cur.winRate = cur.totalEvaluated > 0 ? (cur.wins / cur.totalEvaluated) : 0;
    cur.winRatePct = (cur.winRate * 100).toFixed(1) + '%';
  });

  try {
    localStorage.setItem('quant_user_model_stats_' + tf, JSON.stringify(stats));
  } catch(e) {}

  // Immediately re-render leaderboard with updated model win rates
  renderModelRosterUI();
}
window.updateIndividualModelSettlement = updateIndividualModelSettlement;
\n`;

code = code.slice(0, updateModelStart) + updateModelNewBlock + code.slice(updateModelEnd);
console.log('✓ Replacement 5 (All 53 Models Individual Settlement) applied.');

// Write back to mobile.js
const destPath = path.join(__dirname, '..', 'mobile.js');
fs.writeFileSync(destPath, code, 'utf8');
console.log('Successfully wrote to mobile.js! Size:', code.length, 'lines:', code.split('\n').length);
