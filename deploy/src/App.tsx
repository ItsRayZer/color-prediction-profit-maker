import React, { useRef, useState, useEffect } from 'react';
import { TopToolbar } from './components/toolbar/TopToolbar';
import { DrawingToolbar } from './components/chart/DrawingToolbar';
import { TradingChart, TradingChartHandle } from './components/chart/TradingChart';
import { LowerHistogramPanel } from './components/chart/LowerHistogramPanel';
import { SideStatsPanel } from './components/stats/SideStatsPanel';
import { IndicatorModal } from './components/toolbar/IndicatorModal';
import { ManualDataModal } from './components/toolbar/ManualDataModal';
import { SettingsModal } from './components/toolbar/SettingsModal';
import { useChartStore } from './store/useChartStore';
import { LiveFeedAdapter } from './engine/websocketAdapter';
import { calculateGameStats } from './engine/candleCalculator';
import { GameStats } from './types/game';

export default function App() {
  const chartHandleRef = useRef<TradingChartHandle>(null);
  const { 
    rounds, 
    addRound, 
    indicators, 
    isRealtimeActive, 
    timeframe,
    theme 
  } = useChartStore();

  const [liveStats, setLiveStats] = useState<GameStats>(() => calculateGameStats(rounds));

  // Compute live game stats whenever rounds change
  useEffect(() => {
    setLiveStats(calculateGameStats(rounds));
  }, [rounds]);

  // Real-time 5s live simulation or WebSocket subscription
  useEffect(() => {
    if (!isRealtimeActive) return;

    const adapter = new LiveFeedAdapter();
    const sub = adapter.start((newRound) => {
      addRound(newRound);
    }, 5000);

    return () => {
      sub.unsubscribe();
    };
  }, [isRealtimeActive, addRound]);

  return (
    <div className={`w-screen h-screen flex flex-col ${theme === 'dark' ? 'bg-[#131722] text-[#d1d4dc]' : 'bg-[#f0f3fa] text-[#131722]'} overflow-hidden select-none font-sans`}>
      {/* Top Application Toolbar */}
      <TopToolbar 
        onCaptureScreenshot={() => chartHandleRef.current?.captureScreenshot()} 
      />

      {/* Main Workspace: Left Drawing Tools + Center Charts + Right Analytics */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Left Floating Drawing Toolbar */}
        <DrawingToolbar
          onUndo={() => chartHandleRef.current?.undoDrawing()}
          onRedo={() => chartHandleRef.current?.redoDrawing()}
          onClearAll={() => chartHandleRef.current?.clearAllDrawings()}
          onDeleteSelected={() => chartHandleRef.current?.deleteSelectedDrawing()}
          onExportJson={() => chartHandleRef.current?.exportDrawingsJson()}
          onImportJson={() => chartHandleRef.current?.importDrawingsJson()}
        />

        {/* Center Canvas Area: Trading Chart & Lower Volume/Result Histogram */}
        <main className="flex-1 flex flex-col h-full overflow-hidden relative">
          <div className="flex-1 relative w-full h-full">
            <TradingChart
              ref={chartHandleRef}
              onStatsUpdate={(s) => setLiveStats(s)}
            />
          </div>

          {/* Lower Histogram Panel */}
          <LowerHistogramPanel 
            rounds={rounds} 
            indicators={indicators} 
          />
        </main>

        {/* Right Side Stats & History Panel */}
        <SideStatsPanel 
          stats={liveStats} 
          rounds={rounds} 
        />
      </div>

      {/* Modals & Dialogs */}
      <IndicatorModal />
      <ManualDataModal />
      <SettingsModal />
    </div>
  );
}
