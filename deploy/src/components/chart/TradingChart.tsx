import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { 
  createChart, 
  IChartApi, 
  ISeriesApi, 
  Time,
  CandlestickSeries,
  BarSeries,
  LineSeries,
  AreaSeries,
  BaselineSeries,
  CrosshairMode,
  createSeriesMarkers
} from 'lightweight-charts';
import { DrawingManager, getToolRegistry } from 'lightweight-charts-drawing';
import { useChartStore } from '../../store/useChartStore';
import { CandleData, ChartType } from '../../types/game';
import { calculateCandles } from '../../engine/candleCalculator';
import { 
  calculateSMA, 
  calculateEMA, 
  calculateWMA, 
  calculateBollingerBands, 
  calculateMAChannel,
  calculateStreakLine 
} from '../../engine/indicatorEngine';

export interface TradingChartHandle {
  captureScreenshot: () => void;
  undoDrawing: () => void;
  redoDrawing: () => void;
  clearAllDrawings: () => void;
  deleteSelectedDrawing: () => void;
  exportDrawingsJson: () => void;
  importDrawingsJson: () => void;
}

interface TradingChartProps {
  onStatsUpdate?: (stats: any) => void;
}

export const TradingChart = forwardRef<TradingChartHandle, TradingChartProps>(({ onStatsUpdate }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<any> | null>(null);
  const drawingManagerRef = useRef<DrawingManager | null>(null);
  const indicatorSeriesRef = useRef<ISeriesApi<any>[]>([]);
  const markersPrimitiveRef = useRef<any>(null);

  const {
    rounds,
    chartType,
    theme,
    indicators,
    activeDrawingTool,
    drawingColor,
    drawingLineWidth,
    drawingsJson,
    setDrawingsJson
  } = useChartStore();

  const [crosshairData, setCrosshairData] = useState<{
    roundId?: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    size?: string;
    number?: number;
    color?: string;
  } | null>(null);

  // Expose methods for toolbar actions
  useImperativeHandle(ref, () => ({
    captureScreenshot: () => {
      if (!containerRef.current) return;
      const canvases = containerRef.current.querySelectorAll('canvas');
      if (canvases.length === 0) return;

      // Merge canvases to take clean snapshot
      const firstCanvas = canvases[0];
      const mergedCanvas = document.createElement('canvas');
      mergedCanvas.width = firstCanvas.width;
      mergedCanvas.height = firstCanvas.height;
      const ctx = mergedCanvas.getContext('2d');
      if (!ctx) return;

      canvases.forEach(c => {
        ctx.drawImage(c, 0, 0);
      });

      const dataUrl = mergedCanvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = `prediction_chart_${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
    },
    undoDrawing: () => {
      // Drawing manager handles undo if implemented, or we remove last drawing
      if (drawingManagerRef.current) {
        const drawings = drawingManagerRef.current.getAllDrawings();
        if (drawings && drawings.length > 0) {
          const last = drawings[drawings.length - 1];
          drawingManagerRef.current.removeDrawing(last.id);
        }
      }
    },
    redoDrawing: () => {
      // placeholder for redo
    },
    clearAllDrawings: () => {
      if (drawingManagerRef.current) {
        drawingManagerRef.current.clearAll();
      }
    },
    deleteSelectedDrawing: () => {
      if (drawingManagerRef.current) {
        const sel = drawingManagerRef.current.getSelectedDrawing();
        if (sel) {
          drawingManagerRef.current.removeDrawing(sel.id);
        }
      }
    },
    exportDrawingsJson: () => {
      if (drawingManagerRef.current) {
        const json = drawingManagerRef.current.exportDrawings();
        const blob = new Blob([typeof json === 'string' ? json : JSON.stringify(json, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `chart_drawings_${Date.now()}.json`;
        link.href = url;
        link.click();
      }
    },
    importDrawingsJson: () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = (e: any) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const content = event.target?.result as string;
            const parsed = JSON.parse(content);
            if (drawingManagerRef.current) {
              const registry = getToolRegistry();
              drawingManagerRef.current.importDrawings(parsed, (type: string, data: any) => {
                return (registry as any).createDrawing ? (registry as any).createDrawing(type, data.id, data.anchors, data.style, data.options) : null;
              });
            }
          } catch (err) {
            console.error('Failed to import drawings JSON:', err);
          }
        };
        reader.readAsText(file);
      };
      input.click();
    }
  }));

  // Initialize Lightweight Charts and Drawing Manager
  useEffect(() => {
    if (!containerRef.current) return;

    const isDark = theme === 'dark';
    const bgColor = isDark ? '#131722' : '#ffffff';
    const textColor = isDark ? '#d1d4dc' : '#131722';
    const gridColor = isDark ? '#2a2e39' : '#f0f3fa';

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: {
        background: { color: bgColor },
        textColor: textColor,
        fontSize: 11,
        fontFamily: 'Inter, -apple-system, sans-serif'
      },
      grid: {
        vertLines: { color: gridColor },
        horzLines: { color: gridColor }
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: '#758696',
          width: 1,
          style: 3,
          labelBackgroundColor: '#2962ff'
        },
        horzLine: {
          color: '#758696',
          width: 1,
          style: 3,
          labelBackgroundColor: '#2962ff'
        }
      },
      rightPriceScale: {
        borderColor: gridColor,
        autoScale: true,
        scaleMargins: {
          top: 0.1,
          bottom: 0.1
        }
      },
      timeScale: {
        borderColor: gridColor,
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 12,
        barSpacing: 8,
        minBarSpacing: 3
      }
    });

    chartRef.current = chart;

    // Drawing Manager Initialization
    const dm = new DrawingManager();
    drawingManagerRef.current = dm;

    // Resize Observer for 100% responsiveness
    const resizeObserver = new ResizeObserver(entries => {
      if (entries.length === 0 || !entries[0].contentRect) return;
      const { width, height } = entries[0].contentRect;
      chart.applyOptions({ width, height });
    });
    resizeObserver.observe(containerRef.current);

    // Crosshair move handler
    chart.subscribeCrosshairMove(param => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > containerRef.current!.clientWidth ||
        param.point.y < 0 ||
        param.point.y > containerRef.current!.clientHeight
      ) {
        setCrosshairData(null);
      } else {
        if (seriesRef.current) {
          const data: any = param.seriesData.get(seriesRef.current);
          if (data) {
            setCrosshairData({
              open: data.open !== undefined ? data.open : data.value,
              high: data.high !== undefined ? data.high : data.value,
              low: data.low !== undefined ? data.low : data.value,
              close: data.close !== undefined ? data.close : data.value,
              size: data.close > data.open ? 'BIG' : 'SMALL'
            });
          }
        }
      }
    });

    return () => {
      resizeObserver.disconnect();
      if (drawingManagerRef.current) {
        try {
          drawingManagerRef.current.detach();
        } catch {}
      }
      chart.remove();
      chartRef.current = null;
    };
  }, [theme]);

  // Update Series Type & Candles Data
  useEffect(() => {
    if (!chartRef.current) return;

    const chart = chartRef.current;

    // Clear existing series and indicators
    indicatorSeriesRef.current.forEach(s => chart.removeSeries(s));
    indicatorSeriesRef.current = [];

    if (seriesRef.current) {
      if (drawingManagerRef.current && drawingManagerRef.current.isAttached()) {
        try {
          drawingManagerRef.current.detach();
        } catch {}
      }
      chart.removeSeries(seriesRef.current);
      seriesRef.current = null;
    }

    // Calculate candles & markers from rounds
    const { candles, markers, stats } = calculateCandles(rounds);
    if (onStatsUpdate) {
      onStatsUpdate(stats);
    }

    // Create Main Series based on active chartType
    let mainSeries: ISeriesApi<any>;

    if (chartType === 'candlestick') {
      mainSeries = chart.addSeries(CandlestickSeries, {
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350'
      });
      mainSeries.setData(candles);
    } else if (chartType === 'hollow') {
      mainSeries = chart.addSeries(CandlestickSeries, {
        upColor: '#131722',
        downColor: '#ef5350',
        borderUpColor: '#26a69a',
        borderDownColor: '#ef5350',
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350'
      });
      mainSeries.setData(candles);
    } else if (chartType === 'bar') {
      mainSeries = chart.addSeries(BarSeries, {
        upColor: '#26a69a',
        downColor: '#ef5350'
      });
      mainSeries.setData(candles);
    } else if (chartType === 'line') {
      mainSeries = chart.addSeries(LineSeries, {
        color: '#2962ff',
        lineWidth: 2
      });
      mainSeries.setData(candles.map(c => ({ time: c.time, value: c.close })));
    } else if (chartType === 'area') {
      mainSeries = chart.addSeries(AreaSeries, {
        topColor: 'rgba(41, 98, 255, 0.4)',
        bottomColor: 'rgba(41, 98, 255, 0.0)',
        lineColor: '#2962ff',
        lineWidth: 2
      });
      mainSeries.setData(candles.map(c => ({ time: c.time, value: c.close })));
    } else { // baseline
      mainSeries = chart.addSeries(BaselineSeries, {
        baseValue: { type: 'price', price: 0 },
        topFillColor1: 'rgba(38, 166, 154, 0.28)',
        topFillColor2: 'rgba(38, 166, 154, 0.05)',
        topLineColor: '#26a69a',
        bottomFillColor1: 'rgba(239, 83, 80, 0.05)',
        bottomFillColor2: 'rgba(239, 83, 80, 0.28)',
        bottomLineColor: '#ef5350',
        lineWidth: 2
      });
      mainSeries.setData(candles.map(c => ({ time: c.time, value: c.close })));
    }

    seriesRef.current = mainSeries;

    // Attach Ball Markers to series using createSeriesMarkers
    if (markers.length > 0) {
      try {
        markersPrimitiveRef.current = createSeriesMarkers(mainSeries, markers);
      } catch (err) {
        console.warn('Marker attachment note:', err);
      }
    }

    // Attach Drawing Manager to newly created series
    if (drawingManagerRef.current && containerRef.current) {
      try {
        drawingManagerRef.current.attach(chart, mainSeries, containerRef.current);
      } catch (err) {
        console.warn('DrawingManager attach note:', err);
      }
    }

    // Apply Active Overlay Indicators
    indicators.forEach(ind => {
      if (!ind.enabled) return;

      if (ind.id === 'sma') {
        const smaData = calculateSMA(candles, ind as any);
        const s = chart.addSeries(LineSeries, { color: ind.color, lineWidth: 2, title: `SMA ${ind.period}` });
        s.setData(smaData);
        indicatorSeriesRef.current.push(s);
      } else if (ind.id === 'ema') {
        const emaData = calculateEMA(candles, ind as any);
        const s = chart.addSeries(LineSeries, { color: ind.color, lineWidth: 2, title: `EMA ${ind.period}` });
        s.setData(emaData);
        indicatorSeriesRef.current.push(s);
      } else if (ind.id === 'wma') {
        const wmaData = calculateWMA(candles, ind as any);
        const s = chart.addSeries(LineSeries, { color: ind.color, lineWidth: 2, title: `WMA ${ind.period}` });
        s.setData(wmaData);
        indicatorSeriesRef.current.push(s);
      } else if (ind.id === 'bollinger') {
        const bb = calculateBollingerBands(candles, ind as any);
        const sMid = chart.addSeries(LineSeries, { color: ind.color, lineWidth: 1, title: 'BB Mid' });
        const sUp = chart.addSeries(LineSeries, { color: (ind as any).upperColor || '#26a69a', lineWidth: 1, lineStyle: 2, title: 'BB Upper' });
        const sLow = chart.addSeries(LineSeries, { color: (ind as any).lowerColor || '#ef5350', lineWidth: 1, lineStyle: 2, title: 'BB Lower' });
        sMid.setData(bb.middle);
        sUp.setData(bb.upper);
        sLow.setData(bb.lower);
        indicatorSeriesRef.current.push(sMid, sUp, sLow);
      } else if (ind.id === 'maChannel') {
        const mac = calculateMAChannel(candles, ind as any);
        const sUp = chart.addSeries(LineSeries, { color: ind.color, lineWidth: 1, lineStyle: 1, title: 'Channel High' });
        const sLow = chart.addSeries(LineSeries, { color: ind.color, lineWidth: 1, lineStyle: 1, title: 'Channel Low' });
        sUp.setData(mac.upper);
        sLow.setData(mac.lower);
        indicatorSeriesRef.current.push(sUp, sLow);
      } else if (ind.id === 'streakCounter') {
        const strk = calculateStreakLine(candles);
        const s = chart.addSeries(LineSeries, { color: ind.color, lineWidth: 1, title: 'Streak' });
        s.setData(strk);
        indicatorSeriesRef.current.push(s);
      }
    });

    // Auto-scroll to newest candle
    chart.timeScale().scrollToRealTime();

  }, [rounds, chartType, indicators]);

  // Sync active drawing tool with DrawingManager
  useEffect(() => {
    if (drawingManagerRef.current && drawingManagerRef.current.isAttached()) {
      try {
        drawingManagerRef.current.setActiveTool(activeDrawingTool as any);
      } catch (err) {
        console.warn('Error setting active drawing tool:', err);
      }
    }
  }, [activeDrawingTool]);

  return (
    <div className="relative w-full h-full flex flex-col bg-[#131722] overflow-hidden select-none">
      {/* Dynamic Candle Tooltip / HUD bar */}
      <div className="absolute top-2 left-3 z-10 pointer-events-none flex items-center space-x-3 text-[11px] font-mono bg-[#1e222d]/80 backdrop-blur px-2.5 py-1 rounded border border-[#2a2e39]/60">
        <span className="font-bold text-white flex items-center space-x-1">
          <span className="w-2 h-2 rounded-full bg-[#2962ff]" />
          <span>CONNECTED PREDICTION OHLC</span>
        </span>
        {crosshairData ? (
          <div className="flex items-center space-x-2 text-[#d1d4dc]">
            <span>O: <b className="text-white">{crosshairData.open}</b></span>
            <span>H: <b className="text-[#26a69a]">{crosshairData.high}</b></span>
            <span>L: <b className="text-[#ef5350]">{crosshairData.low}</b></span>
            <span>C: <b className="text-white">{crosshairData.close}</b></span>
            <span className={`px-1 rounded text-[10px] font-bold ${
              crosshairData.size === 'BIG' ? 'bg-[#26a69a]/20 text-[#26a69a]' : 'bg-[#ef5350]/20 text-[#ef5350]'
            }`}>
              {crosshairData.size}
            </span>
          </div>
        ) : (
          <span className="text-[#787b86]">Move cursor over chart for candle details</span>
        )}
      </div>

      {/* Main Chart Canvas Container */}
      <div ref={containerRef} className="w-full flex-1" />
    </div>
  );
});

TradingChart.displayName = 'TradingChart';
