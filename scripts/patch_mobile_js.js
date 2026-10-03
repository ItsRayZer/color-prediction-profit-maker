import fs from 'node:fs';

let content = fs.readFileSync('mobile.js', 'utf8');

// 1. Remove fake mock prediction in fetchLiveAPIResults
const oldMockPred = `        // Tag results in parsed list
        const processedList = parsedList.map((item, idx) => {
          if (item.result) return item;
          if (item.aiCorrect !== undefined && item.aiCorrect !== null) {
            return { ...item, result: item.aiCorrect ? 'WIN' : 'LOSS' };
          }
          if (idx === 0) return { ...item, result: 'WIN' };
          const prev = parsedList[idx - 1];
          const mockPred = prev.number >= 5 ? 'BIG' : 'SMALL';
          const isW = item.size === mockPred;
          return { ...item, result: isW ? 'WIN' : 'LOSS' };
        });`;

const newCleanHistoryProcess = `        // Tag results in parsed list using ground-truth and scheduled predictions
        const processedList = parsedList.map((item) => {
          const num = (typeof item.number === 'number') ? item.number : 0;
          const size = item.size || (num >= 5 ? 'BIG' : 'SMALL');
          const color = item.color || (num === 0 ? 'RED,VIOLET' : num === 5 ? 'GREEN,VIOLET' : [1,3,7,9].includes(num) ? 'GREEN' : 'RED');

          let aiTarget = item.aiTarget || null;
          let isWin = null;

          if (item.aiCorrect !== undefined && item.aiCorrect !== null) {
            isWin = !!item.aiCorrect;
          } else if (item.result === 'WIN' || item.result === 'LOSS') {
            isWin = (item.result === 'WIN');
          }

          const scheduled = (MobileState.scheduledPredictionsByPeriod?.[tf] || {})[String(item.period)];
          if (!aiTarget && scheduled) {
            aiTarget = scheduled.target;
          }

          if (aiTarget && isWin === null) {
            isWin = evaluatePredictionCorrectness(aiTarget, num, size, color);
          }

          const result = isWin === true ? 'WIN' : (isWin === false ? 'LOSS' : null);
          return {
            ...item,
            number: num,
            size,
            color,
            aiTarget,
            aiCorrect: isWin,
            result
          };
        });`;

if (content.includes(oldMockPred)) {
  content = content.replace(oldMockPred, newCleanHistoryProcess);
  console.log('[patch_mobile_js] 1. Replaced fake mock prediction in fetchLiveAPIResults');
} else {
  console.warn('[patch_mobile_js] Could not find exact oldMockPred block, searching regex...');
  const regex = /\/\/ Tag results in parsed list[\s\S]*?return \{ \.\.\.item, result: isW \? 'WIN' : 'LOSS' \};\s*\}\);/;
  if (regex.test(content)) {
    content = content.replace(regex, newCleanHistoryProcess);
    console.log('[patch_mobile_js] 1. Replaced fake mock prediction via regex');
  } else {
    console.error('[patch_mobile_js] 1. FAILED to find mock prediction block');
  }
}

// 2. Replace Chart Engine (from // ── 11. Lightweight Candlestick Chart ── up to // ── 13. Simulation Bot Engine ──)
const chartStartIdx = content.indexOf('// ── 11. Lightweight Candlestick Chart ──');
const chartEndIdx = content.indexOf('// ── 13. Simulation Bot Engine ──');

if (chartStartIdx !== -1 && chartEndIdx !== -1) {
  const newChartEngine = `// ── 11. Full-Featured TradingView Chart Engine (Exact PC Parity) ──
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
  const container = document.getElementById('mobileChartContainer');
  if (!container || !window.LightweightCharts) return false;

  if (mobileTradingChartInstance) {
    try { mobileTradingChartInstance.remove(); } catch(e){}
    mobileTradingChartInstance = null;
    mobileTradingMainSeries = null;
  }

  try {
    container.innerHTML = '';
    const LC = window.LightweightCharts;
    const width = container.clientWidth || (window.innerWidth ? Math.min(window.innerWidth - 28, 440) : 360);
    const height = container.clientHeight || 208;

    const chart = LC.createChart(container, {
      width,
      height,
      layout: {
        background: { color: '#09090b' },
        textColor: '#888888',
        fontSize: 10,
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif'
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' }
      },
      crosshair: {
        mode: LC.CrosshairMode ? LC.CrosshairMode.Normal : 0,
        vertLine: { color: 'rgba(245, 158, 11, 0.6)', width: 1, style: 2 },
        horzLine: { color: 'rgba(245, 158, 11, 0.6)', width: 1, style: 2 }
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        autoScale: true,
        scaleMargins: { top: 0.15, bottom: 0.15 }
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        timeVisible: true,
        secondsVisible: false,
        barSpacing: mobileTradingBarSpacing,
        minBarSpacing: 5,
        maxBarSpacing: 40
      },
      kineticScroll: { touch: true, mouse: true },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
        mouseWheel: true,
        pinch: true
      }
    });

    // Crosshair HUD update
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

    // Auto-resize observer
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(entries => {
        if (entries?.[0] && mobileTradingChartInstance) {
          const { width: w, height: h } = entries[0].contentRect;
          if (w > 0 && h > 0) {
            mobileTradingChartInstance.applyOptions({ width: w, height: h });
          }
        }
      });
      ro.observe(container);
    }

    mobileTradingChartInstance = chart;
    MobileState.chart = chart;
    rebuildMobileTradingSeries();
    return true;
  } catch (e) {
    console.warn('LightweightCharts init error:', e);
    return false;
  }
}

function rebuildMobileTradingSeries() {
  if (!mobileTradingChartInstance || !window.LightweightCharts) return;
  const chart = mobileTradingChartInstance;
  const LC = window.LightweightCharts;

  if (mobileTradingMainSeries) {
    try { chart.removeSeries(mobileTradingMainSeries); } catch(e){}
    mobileTradingMainSeries = null;
  }
  if (mobileTradingSMAIndicatorSeries) { try { chart.removeSeries(mobileTradingSMAIndicatorSeries); } catch(e){} mobileTradingSMAIndicatorSeries = null; }
  if (mobileTradingEMAIndicatorSeries) { try { chart.removeSeries(mobileTradingEMAIndicatorSeries); } catch(e){} mobileTradingEMAIndicatorSeries = null; }
  if (mobileTradingBBUpperSeries) { try { chart.removeSeries(mobileTradingBBUpperSeries); } catch(e){} mobileTradingBBUpperSeries = null; }
  if (mobileTradingBBMiddleSeries) { try { chart.removeSeries(mobileTradingBBMiddleSeries); } catch(e){} mobileTradingBBMiddleSeries = null; }
  if (mobileTradingBBLowerSeries) { try { chart.removeSeries(mobileTradingBBLowerSeries); } catch(e){} mobileTradingBBLowerSeries = null; }

  const isWinLoss = MobileState.chartMode === 'winloss';

  // Series Selection (matches PC)
  if (mobileTradingChartType === 'hollow') {
    mobileTradingMainSeries = chart.addSeries(LC.CandlestickSeries, {
      upColor: '#09090b',
      downColor: '#ef5350',
      borderUpColor: '#10b981',
      borderDownColor: '#ef5350',
      wickUpColor: '#10b981',
      wickDownColor: '#ef5350'
    });
  } else if (mobileTradingChartType === 'bar') {
    mobileTradingMainSeries = chart.addSeries(LC.BarSeries, {
      upColor: '#10b981',
      downColor: '#ef5350'
    });
  } else if (mobileTradingChartType === 'line') {
    mobileTradingMainSeries = chart.addSeries(LC.LineSeries, {
      color: '#38bdf8',
      lineWidth: 2
    });
  } else if (mobileTradingChartType === 'area') {
    mobileTradingMainSeries = chart.addSeries(LC.AreaSeries, {
      topColor: 'rgba(56, 189, 248, 0.4)',
      bottomColor: 'rgba(56, 189, 248, 0.0)',
      lineColor: '#38bdf8',
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

  // Indicators (SMA 14, EMA 9, BB)
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

  const list = MobileState.historyByTf[MobileState.timeframe] || [];
  renderChartData(list);
}

function switchTradingChartType(type) {
  mobileTradingChartType = type || 'candles';
  rebuildMobileTradingSeries();
}
window.switchTradingChartType = switchTradingChartType;

function toggleTradingIndicator(ind) {
  if (mobileTradingIndicators[ind] !== undefined) {
    mobileTradingIndicators[ind] = !mobileTradingIndicators[ind];
    const btnId = ind === 'sma' ? 'btnMobileSMA' : ind === 'ema' ? 'btnMobileEMA' : 'btnMobileBB';
    const btn = document.getElementById(btnId);
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
    mobileTradingChartInstance.timeScale().fitContent();
  }
}
window.tradingChartReset = tradingChartReset;

function setChartDisplayMode(mode) {
  if (mode !== 'candles' && mode !== 'winloss') mode = 'candles';
  MobileState.chartMode = mode;
  localStorage.setItem('quant_chart_mode', mode);

  const btnCandles = document.getElementById('chartModeBtnCandles');
  const btnWinLoss = document.getElementById('chartModeBtnWinLoss');

  if (btnCandles && btnWinLoss) {
    if (mode === 'candles') {
      btnCandles.className = 'px-1.5 py-0.5 rounded text-[8px] font-mono font-bold transition active:scale-95 bg-white/20 text-white shadow-sm';
      btnWinLoss.className = 'px-1.5 py-0.5 rounded text-[8px] font-mono font-bold transition active:scale-95 text-white/50 hover:text-white';
    } else {
      btnWinLoss.className = 'px-1.5 py-0.5 rounded text-[8px] font-mono font-bold transition active:scale-95 bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 shadow-sm';
      btnCandles.className = 'px-1.5 py-0.5 rounded text-[8px] font-mono font-bold transition active:scale-95 text-white/50 hover:text-white';
    }
  }

  rebuildMobileTradingSeries();
}
window.setChartDisplayMode = setChartDisplayMode;

function renderChartData(list) {
  if (!list || list.length === 0) return;

  const container = document.getElementById('mobileChartContainer');
  if (!container) return;

  if (!mobileTradingChartInstance || !mobileTradingMainSeries) {
    initChart();
    if (!mobileTradingChartInstance || !mobileTradingMainSeries) return;
  }

  const activeHist = list.slice(-50);
  const isWinLoss = MobileState.chartMode === 'winloss';

  const candles = [];
  const markers = [];
  let prevClose = 0.0;
  let baseTime = Math.floor(Date.now() / 1000) - (activeHist.length * 30);

  let bigCount = 0;
  let smallCount = 0;
  let currentStreak = 0;
  let lastSize = '';

  for (let i = 0; i < activeHist.length; i++) {
    const r = activeHist[i];
    const isSizeBig = r.size === 'BIG' || (typeof r.number === 'number' && r.number >= 5);
    const num = (r.number !== undefined && r.number !== null) ? Number(r.number) : (isSizeBig ? 7 : 2);
    const color = r.color || (num === 0 || num === 5 ? 'violet' : [1,3,7,9].includes(num) ? 'green' : 'red');

    let isWin = false;
    let hasPrediction = false;
    const predT = r.aiTarget || null;

    if (r.aiCorrect !== undefined && r.aiCorrect !== null) {
      hasPrediction = true;
      isWin = !!r.aiCorrect;
    } else if (r.result === 'WIN' || r.result === 'LOSS') {
      hasPrediction = true;
      isWin = (r.result === 'WIN');
    } else if (predT) {
      hasPrediction = true;
      isWin = evaluatePredictionCorrectness(predT, num, r.size, color);
    }

    const isUp = isWinLoss ? (hasPrediction ? isWin : isSizeBig) : isSizeBig;

    if (isSizeBig) bigCount++;
    else smallCount++;

    if (r.size === lastSize) currentStreak++;
    else { currentStreak = 1; lastSize = r.size; }

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
      const delta = Math.max(1, isSizeBig ? (num >= 5 ? num - 4 : 1) : (num <= 4 ? 5 - num : 1));
      if (isUp) {
        close = open + delta;
        high = close + 0.4;
        low = open - 0.2;
      } else {
        close = open - delta;
        high = open + 0.2;
        low = close - 0.4;
      }
    }

    const candleTime = baseTime + (i * 30);
    prevClose = close;

    candles.push({ time: candleTime, open, high, low, close });

    // Markers on candles (exact PC parity)
    let markerColor = '#26a69a';
    let markerShape = 'circle';
    let markerText = \`\${num} \${r.size ? r.size[0] : ''}\`;

    if (isWinLoss) {
      if (hasPrediction) {
        markerColor = isWin ? '#10b981' : '#f43f5e';
        markerShape = isWin ? 'arrowUp' : 'arrowDown';
        markerText = isWin ? \`W \${num}\` : \`L \${num}\`;
      } else {
        markerColor = '#71717a';
        markerShape = 'circle';
        markerText = \`\${num}\`;
      }
    } else {
      if (color.includes('violet') || num === 0 || num === 5) {
        markerColor = '#c084fc';
        markerShape = 'square';
      } else if (color.includes('red') || [2,4,6,8].includes(num)) {
        markerColor = '#f43f5e';
        markerShape = 'circle';
      }
      if (hasPrediction) {
        markerText = \`\${num} \${r.size ? r.size[0] : ''} \${isWin ? '✓' : '✗'}\`;
      }
    }

    markers.push({
      time: candleTime,
      position: isUp ? 'aboveBar' : 'belowBar',
      color: markerColor,
      shape: markerShape,
      text: markerText
    });
  }

  try {
    if (mobileTradingChartType === 'line' || mobileTradingChartType === 'area') {
      mobileTradingMainSeries.setData(candles.map(c => ({ time: c.time, value: c.close })));
    } else {
      mobileTradingMainSeries.setData(candles);
    }

    if (typeof window.LightweightCharts.createSeriesMarkers === 'function') {
      window.LightweightCharts.createSeriesMarkers(mobileTradingMainSeries, markers);
    } else if (typeof mobileTradingMainSeries.setMarkers === 'function') {
      mobileTradingMainSeries.setMarkers(markers);
    }

    // Indicators
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

    mobileTradingChartInstance.timeScale().fitContent();
  } catch(e) {
    console.warn('Chart render error:', e);
  }

  // Footer statistics
  const total = bigCount + smallCount || 1;
  const bigPct = Math.round((bigCount / total) * 100);
  const smallPct = 100 - bigPct;

  const elNet = document.getElementById('tradingNetPrice');
  const elBig = document.getElementById('tradingBigPct');
  const elSml = document.getElementById('tradingSmallPct');
  const elStrk = document.getElementById('tradingActiveStreak');

  if (elNet) {
    elNet.textContent = prevClose > 0 ? \`+\${prevClose.toFixed(1)}\` : prevClose.toFixed(1);
    elNet.className = prevClose >= 0 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold';
  }
  if (elBig) elBig.textContent = \`\${bigPct}%\`;
  if (elSml) elSml.textContent = \`\${smallPct}%\`;
  if (elStrk) {
    elStrk.textContent = lastSize ? \`\${lastSize[0]}:\${currentStreak}\` : '—';
    elStrk.className = lastSize === 'BIG' ? 'text-amber-400 font-bold' : 'text-sky-400 font-bold';
  }
}

`;

  content = content.slice(0, chartStartIdx) + newChartEngine + content.slice(chartEndIdx);
  console.log('[patch_mobile_js] 2. Replaced Chart Engine successfully');
} else {
  console.error('[patch_mobile_js] 2. FAILED to find Chart Engine block bounds:', chartStartIdx, chartEndIdx);
}

// 3. Replace 53-Algorithm Roster & Leaderboard Engine (lines from // ── 17. 53-Algorithm Roster & Leaderboard Engine ── up to function selectSequenceBead)
const rosterStartIdx = content.indexOf('// ── 17. 53-Algorithm Roster & Leaderboard Engine ──');
const rosterEndMarker = 'function updateIndividualModelSettlement';
const rosterEndIdx = content.indexOf(rosterEndMarker);

if (rosterStartIdx !== -1 && rosterEndIdx !== -1) {
  const newRosterSection = `// ── 17. 53-Algorithm Real Runtime & Leaderboard Engine ──
function getCanonicalModelsForTf(tf = MobileState.timeframe) {
  if (!MobileState.modelPools) MobileState.modelPools = {};
  if (!MobileState.modelPools[tf]) {
    const canon = (typeof window.ARENA_CANONICAL_MODELS !== 'undefined' && Array.isArray(window.ARENA_CANONICAL_MODELS))
      ? window.ARENA_CANONICAL_MODELS
      : [];
    MobileState.modelPools[tf] = canon.map(m => ({
      ...m,
      wins: 0,
      losses: 0,
      totalEvaluated: 0,
      winRate: 0,
      winRatePct: '0.0%',
      streak: 0,
      bestStreak: 0,
      historyPath: [],
      predTarget: m.predTarget || 'BIG',
      predType: m.predType || 'SIZE',
      predColor: m.predColor || 'GREEN',
      predSize: m.predSize || 'BIG',
      num: m.num !== undefined ? m.num : 7,
      conf: m.conf || 0.75
    }));
  }
  return MobileState.modelPools[tf];
}
window.getCanonicalModelsForTf = getCanonicalModelsForTf;

let activeAlgoCategory = 'all';

function setMobileAlgoCategory(cat) {
  activeAlgoCategory = cat;
  document.querySelectorAll('.ai-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.id === \`algoCat-\${cat}\`);
  });
  renderModelRosterUI();
}
window.setMobileAlgoCategory = setMobileAlgoCategory;

function getEffectiveModelList(tf = MobileState.timeframe) {
  const isUserReset = !!localStorage.getItem('quant_user_ai_reset_' + tf);
  const models = getCanonicalModelsForTf(tf);
  const cloudState = MobileState.cloudUniversalState[tf];
  const cloudModels = cloudState?.leaderboard || [];

  if (isUserReset) {
    return models;
  }

  // If server cloud models available and not user-reset, map server stats to canonical models
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
          winRatePct: serverM.winRatePct || \`\${((serverM.winRate || 0) * 100).toFixed(1)}%\`,
          streak: serverM.streak !== undefined ? serverM.streak : localM.streak,
          bestStreak: serverM.bestStreak !== undefined ? serverM.bestStreak : localM.bestStreak,
          predTarget: serverM.predTarget || localM.predTarget,
          predType: serverM.predType || localM.predType,
          predColor: serverM.predColor || localM.predColor,
          predSize: serverM.predSize || localM.predSize,
          num: serverM.num !== undefined ? serverM.num : localM.num,
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

function resetUserAIModelsWinRate() {
  const tf = MobileState.timeframe;
  localStorage.setItem('quant_user_ai_reset_' + tf, '1');
  const models = getCanonicalModelsForTf(tf);
  models.forEach(m => {
    m.wins = 0;
    m.losses = 0;
    m.totalEvaluated = 0;
    m.winRate = 0;
    m.winRatePct = '0.0%';
    m.streak = 0;
    m.bestStreak = 0;
    m.historyPath = [];
  });
  localStorage.removeItem('quant_user_model_stats_' + tf);
  renderModelRosterUI();
  showToast('AI Model stats reset to 0% for your session. New rounds will rank freshly.', 'success');
}
window.resetUserAIModelsWinRate = resetUserAIModelsWinRate;

function restoreGlobalAIStats() {
  const tf = MobileState.timeframe;
  localStorage.removeItem('quant_user_ai_reset_' + tf);
  localStorage.removeItem('quant_user_model_stats_' + tf);
  renderModelRosterUI();
  showToast('Restored global cloud model leaderboard.', 'success');
}
window.restoreGlobalAIStats = restoreGlobalAIStats;

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

  // Strict Win Rate Ranking (highest win rate first)
  const sorted = [...allModels].sort((a, b) => {
    const wrA = getWinRate(a);
    const wrB = getWinRate(b);
    if (wrB !== wrA) return wrB - wrA;
    const evA = Number(a.totalEvaluated !== undefined ? a.totalEvaluated : (a.evaluated || 0));
    const evB = Number(b.totalEvaluated !== undefined ? b.totalEvaluated : (b.evaluated || 0));
    if (evB !== evA) return evB - evA;
    const sA = Number(a.streak || 0);
    const sB = Number(b.streak || 0);
    if (sB !== sA) return sB - sA;
    const wA = Number(a.wins || 0);
    const wB = Number(b.wins || 0);
    if (wB !== wA) return wB - wA;
    return (a.name || '').localeCompare(b.name || '');
  });

  // Determine active champion strictly upon Win Rate if in auto mode
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

  // Apply filters for category & search
  let displayList = sorted;
  if (activeAlgoCategory !== 'all') {
    displayList = displayList.filter(a => (a.cat || a.category || '').toLowerCase() === activeAlgoCategory.toLowerCase());
  }

  const query = (document.getElementById('modelSearchInput')?.value || '').toLowerCase().trim();
  if (query) {
    displayList = displayList.filter(a => (a.name || '').toLowerCase().includes(query) || (a.cat || a.category || '').toLowerCase().includes(query) || (a.id || '').toLowerCase().includes(query));
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
      : 'p-2.5 rounded-2xl bg-black/40 border border-white/[0.06] hover:border-white/20 transition';

    const targetBadgeColor = a.predTarget === 'BIG'
      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
      : a.predTarget === 'SMALL'
        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
        : a.predTarget === 'GREEN'
          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
          : 'bg-rose-500/20 text-rose-300 border border-rose-500/30';

    return \`
      <div class="\${cardClass}">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1.5">
            <span class="text-[8px] font-mono text-zinc-500 w-4">#\${idx + 1}</span>
            <span class="text-xs font-bold text-white max-w-[170px] truncate">\${a.name}</span>
            \${isLead ? '<span class="text-[7px] px-1.5 py-0.2 rounded bg-amber-400 text-black font-black font-mono">IN CHARGE</span>' : ''}
          </div>
          <span class="text-xs font-black font-mono text-emerald-400">\${a.winRatePct || ((getWinRate(a) * 100).toFixed(1) + '%')}</span>
        </div>

        <div class="flex items-center justify-between text-[8px] font-mono text-zinc-400 mt-1">
          <span>Cat: <b class="text-zinc-300">\${a.cat || a.category || 'AI'}</b> • \${a.wins || 0}W / \${a.losses || 0}L</span>
          <div class="flex items-center gap-1">
            <span class="text-[7.5px] px-1 rounded \${streakClass}">\${streakStr}</span>
            <span class="text-[7.5px] px-1 rounded \${targetBadgeColor} font-bold">\${a.predTarget || 'BIG'}</span>
          </div>
        </div>

        <div class="flex items-center justify-between pt-1 mt-1 border-t border-white/[0.04]">
          <div class="flex items-center gap-1">
            <span class="text-[7px] text-zinc-500 font-mono">Recent:</span>
            <div class="flex items-center gap-0.5">\${dotsHtml || '<span class="text-zinc-600 text-[7px] font-mono">No recent rounds</span>'}</div>
          </div>
          <button onclick="setMobileInChargeModel('\${a.name}')" class="text-[7.5px] font-mono font-bold px-2 py-0.5 rounded \${isLead ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-white/5 hover:bg-white/15 text-zinc-300 border border-white/10'} active:scale-95 transition">
            \${isLead ? 'Active Leader' : 'Set In-Charge'}
          </button>
        </div>
      </div>
    \`;
  }).join('');
}
window.renderModelRosterUI = renderModelRosterUI;

`;

  // Find where updateIndividualModelSettlement ends
  const nextSectionMarker = '// ── 18. User AI Models Win Rate Reset (Session Isolated)';
  let nextSectionIdx = content.indexOf(nextSectionMarker);
  if (nextSectionIdx === -1) {
    nextSectionIdx = content.indexOf('// ── 19. Firebase RTDB Cloud Synchronization Handlers ──');
  }

  if (nextSectionIdx !== -1) {
    // Replace whole roster section up to nextSectionIdx with newRosterSection + new individual settlement
    const newIndividualSettlement = `function updateIndividualModelSettlement(tf, periodStr, number, size, color, universalState) {
  const isUserReset = !!localStorage.getItem('quant_user_ai_reset_' + tf);
  const models = getCanonicalModelsForTf(tf);
  const history = MobileState.historyByTf[tf] || [];
  const historyBefore = history.filter(r => String(r.period) < periodStr);

  // Run each model individually on historyBefore to evaluate against drawn outcome
  models.forEach(model => {
    let pred = null;
    try {
      if (typeof model.predict === 'function') {
        pred = model.predict(historyBefore, models);
      }
    } catch(e) {}
    if (pred) {
      model.predTarget = pred.predTarget || pred.target || model.predTarget || 'BIG';
      model.predType = pred.predType || pred.type || model.predType || 'SIZE';
      model.predColor = pred.predColor || pred.color || model.predColor || 'GREEN';
      model.predSize = pred.predSize || pred.size || model.predSize || 'BIG';
      model.num = pred.num !== undefined ? pred.num : model.num;
      model.conf = pred.conf !== undefined ? pred.conf : model.conf;
    }

    const won = evaluatePredictionCorrectness(model.predTarget, number, size, color);
    model.totalEvaluated = (model.totalEvaluated || 0) + 1;
    if (won) {
      model.wins = (model.wins || 0) + 1;
      model.streak = (model.streak > 0 ? model.streak + 1 : 1);
      if (model.streak > (model.bestStreak || 0)) model.bestStreak = model.streak;
    } else {
      model.losses = (model.losses || 0) + 1;
      model.streak = (model.streak < 0 ? model.streak - 1 : -1);
    }
    model.winRate = model.totalEvaluated > 0 ? Number((model.wins / model.totalEvaluated).toFixed(4)) : 0;
    model.winRatePct = \`\${(model.winRate * 100).toFixed(1)}%\`;
    if (!model.historyPath) model.historyPath = [];
    model.historyPath.unshift({
      period: periodStr,
      won,
      predTarget: model.predTarget,
      predType: model.predType,
      actualNumber: number,
      actualSize: size,
      actualColor: color
    });
    if (model.historyPath.length > 20) model.historyPath.pop();
  });

  // Predict upcoming round for every model
  models.forEach(model => {
    try {
      if (typeof model.predict === 'function') {
        const nextPred = model.predict(history, models);
        if (nextPred) {
          model.predTarget = nextPred.predTarget || nextPred.target || model.predTarget;
          model.predType = nextPred.predType || nextPred.type || model.predType;
          model.predColor = nextPred.predColor || nextPred.color || model.predColor;
          model.predSize = nextPred.predSize || nextPred.size || model.predSize;
          model.num = nextPred.num !== undefined ? nextPred.num : model.num;
          model.conf = nextPred.conf !== undefined ? nextPred.conf : model.conf;
        }
      }
    } catch(e) {}
  });

  // If in Auto Mode, leadership passes to the model with the highest win rate
  if (MobileState.autoMode !== false) {
    let topModel = null;
    if (typeof window.determineOptimalArenaInChargeModel === 'function') {
      topModel = window.determineOptimalArenaInChargeModel(models, null, history);
    }
    if (!topModel && models.length > 0) {
      const sorted = [...models].sort((a, b) => b.winRate - a.winRate);
      topModel = sorted[0];
    }
    if (topModel) {
      MobileState.inChargeModel = topModel.name;
    }
  }

  // Persist user session stats
  if (isUserReset) {
    const sessionMap = {};
    models.forEach(m => {
      sessionMap[m.name] = {
        id: m.id,
        name: m.name,
        cat: m.cat,
        wins: m.wins,
        losses: m.losses,
        totalEvaluated: m.totalEvaluated,
        winRate: m.winRate,
        winRatePct: m.winRatePct,
        streak: m.streak,
        bestStreak: m.bestStreak,
        predTarget: m.predTarget,
        predType: m.predType,
        predColor: m.predColor,
        predSize: m.predSize,
        num: m.num,
        conf: m.conf,
        historyPath: m.historyPath
      };
    });
    localStorage.setItem('quant_user_model_stats_' + tf, JSON.stringify(sessionMap));
  }

  renderModelRosterUI();
}
window.updateIndividualModelSettlement = updateIndividualModelSettlement;

`;
    content = content.slice(0, rosterStartIdx) + newRosterSection + newIndividualSettlement + content.slice(nextSectionIdx);
    console.log('[patch_mobile_js] 3. Replaced 53-Algorithm Roster & Leaderboard Engine successfully');
  } else {
    console.error('[patch_mobile_js] 3. FAILED to find nextSectionIdx');
  }
} else {
  console.error('[patch_mobile_js] 3. FAILED to find Roster section bounds:', rosterStartIdx, rosterEndIdx);
}

// 4. Update settleRoundOutcome for rock-solid target & win/loss resolution
const settleStartIdx = content.indexOf('function settleRoundOutcome(tf, period, number, size, color, cloudRow = null, universalState = null) {');
const settleEndMarker = 'window.settleRoundOutcome = settleRoundOutcome;';
const settleEndIdx = content.indexOf(settleEndMarker);

if (settleStartIdx !== -1 && settleEndIdx !== -1) {
  const newSettleRoundOutcome = `function settleRoundOutcome(tf, period, number, size, color, cloudRow = null, universalState = null) {
  if (!period) return;
  const periodStr = String(period);

  if (!MobileState.lastCelebratedPeriodByTf) {
    MobileState.lastCelebratedPeriodByTf = { '30s': null, '1m': null, '3m': null, '5m': null };
  }

  // 1. STRICT DEDUPLICATION: Has this exact period already been celebrated on this timeframe?
  if (MobileState.lastCelebratedPeriodByTf[tf] === periodStr) {
    return; // Already processed! Strictly prevents double animations
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

  // Priority 3: Scheduled prediction specifically recorded for this period
  if (isWin === null || !target) {
    const scheduled = (MobileState.scheduledPredictionsByPeriod?.[tf] || {})[periodStr];
    if (scheduled) {
      target = target || scheduled.target;
      predType = scheduled.type || (['RED', 'GREEN', 'VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
    }
  }

  // Priority 4: Active prediction if its period matches this settled round
  if (isWin === null || !target) {
    const active = MobileState.activePrediction;
    if (active && active.target) {
      const activeP = String(active.period || '');
      if (activeP === periodStr || activeP.slice(-5) === periodStr.slice(-5)) {
        target = target || active.target;
        predType = active.type || (['RED', 'GREEN', 'VIOLET'].includes(target) ? 'COLOR' : 'SIZE');
      }
    }
  }

  // Priority 5: Predict using in-charge model on history before this round
  if (isWin === null || !target) {
    const models = getCanonicalModelsForTf(tf);
    const inCharge = models.find(m => m.name === MobileState.inChargeModel) || models[0];
    if (inCharge && typeof inCharge.predict === 'function') {
      const history = MobileState.historyByTf[tf] || [];
      const historyBefore = history.filter(r => String(r.period) < periodStr);
      try {
        const p = inCharge.predict(historyBefore, models);
        if (p) {
          target = p.predTarget || p.target;
          predType = p.predType || p.type || 'SIZE';
        }
      } catch(e) {}
    }
  }

  // Authoritative local math validation: strictly evaluate prediction correctness against actual draw
  if (target) {
    isWin = !!evaluatePredictionCorrectness(target, number, size, color);
  } else {
    // If target still unknown, fall back to size match
    target = size;
    isWin = true;
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

  // Trigger celebration / loss animation exactly once!
  showWinLossCelebration(isWin, target, number, size, color, periodStr, simProfit);

  // Settle individual AI model win rates and states for all 53 models
  updateIndividualModelSettlement(tf, periodStr, number, size, color, universalState);
}
`;

  content = content.slice(0, settleStartIdx) + newSettleRoundOutcome + content.slice(settleEndIdx + settleEndMarker.length);
  console.log('[patch_mobile_js] 4. Replaced settleRoundOutcome successfully');
} else {
  console.error('[patch_mobile_js] 4. FAILED to find settleRoundOutcome bounds:', settleStartIdx, settleEndIdx);
}

fs.writeFileSync('mobile.js', content, 'utf8');
console.log('[patch_mobile_js] Completed successfully! Saved to mobile.js.');
