import React from 'react';
import { 
  BarChart2, 
  CandlestickChart, 
  LineChart, 
  Activity, 
  Maximize2, 
  Camera, 
  Download, 
  Database, 
  Edit3, 
  Radio, 
  Settings, 
  RefreshCw,
  Layers,
  ExternalLink,
  Sun,
  Moon
} from 'lucide-react';
import { useChartStore } from '../../store/useChartStore';
import { ChartType, Timeframe, DataFeedMode } from '../../types/game';

interface TopToolbarProps {
  onCaptureScreenshot: () => void;
}

export const TopToolbar: React.FC<TopToolbarProps> = ({ onCaptureScreenshot }) => {
  const {
    chartType,
    setChartType,
    timeframe,
    setTimeframe,
    symbol,
    setSymbol,
    dataFeedMode,
    setDataFeedMode,
    isRealtimeActive,
    setIsRealtimeActive,
    indicators,
    setIndicatorModalOpen,
    setManualModalOpen,
    setSettingsModalOpen,
    resetToMockData,
    exportRoundsAsCsv,
    exportRoundsAsJson,
    theme,
    setTheme
  } = useChartStore();

  const activeIndicatorsCount = indicators.filter(i => i.enabled).length;

  const handleDownloadData = () => {
    const csv = exportRoundsAsCsv();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `${symbol.replace(/\s+/g, '_')}_data.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleToggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => console.error(err));
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(err => console.error(err));
      }
    }
  };

  const symbols = ['WinGo 30s', 'WinGo 1m', 'WinGo 3m', 'WinGo 5m'];
  const timeframes: Timeframe[] = ['30s', '1m', '3m', '5m', '10m'];
  const chartTypes: { id: ChartType; label: string; icon: React.ReactNode }[] = [
    { id: 'candlestick', label: 'Candles', icon: <CandlestickChart size={15} /> },
    { id: 'bar', label: 'Bars', icon: <BarChart2 size={15} /> },
    { id: 'line', label: 'Line', icon: <LineChart size={15} /> },
    { id: 'area', label: 'Area', icon: <Activity size={15} /> },
    { id: 'baseline', label: 'Baseline', icon: <Activity size={15} /> },
    { id: 'hollow', label: 'Hollow', icon: <CandlestickChart size={15} className="opacity-70" /> }
  ];

  return (
    <header className="h-12 bg-[#1e222d] border-b border-[#2a2e39] flex items-center justify-between px-3 text-xs text-[#d1d4dc] select-none z-30">
      {/* Left: Symbol, Timeframes, Chart Types */}
      <div className="flex items-center space-x-2">
        {/* Logo / Brand */}
        <div className="flex items-center space-x-1.5 font-bold text-sm tracking-wide text-white mr-2">
          <span className="w-2.5 h-2.5 rounded-sm bg-[#2962ff]"></span>
          <span>PREDICTION</span>
          <span className="text-[#26a69a] text-[10px] uppercase font-mono px-1.5 py-0.5 bg-[#26a69a]/10 rounded border border-[#26a69a]/30">PRO</span>
        </div>

        {/* Symbol Dropdown */}
        <div className="relative">
          <select 
            value={symbol} 
            onChange={(e) => setSymbol(e.target.value)}
            className="bg-[#131722] hover:bg-[#2a2e39] border border-[#2a2e39] text-white font-semibold rounded px-2.5 py-1 outline-none cursor-pointer text-xs"
          >
            {symbols.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="h-4 w-[1px] bg-[#2a2e39]" />

        {/* Timeframes */}
        <div className="flex items-center space-x-1">
          {timeframes.map(tf => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`px-2 py-1 rounded transition-colors font-medium ${
                timeframe === tf 
                  ? 'bg-[#2962ff] text-white' 
                  : 'hover:bg-[#2a2e39] text-[#787b86]'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>

        <div className="h-4 w-[1px] bg-[#2a2e39]" />

        {/* Chart Types */}
        <div className="flex items-center space-x-1">
          {chartTypes.map(ct => (
            <button
              key={ct.id}
              onClick={() => setChartType(ct.id)}
              title={ct.label}
              className={`flex items-center space-x-1 px-2 py-1 rounded transition-colors ${
                chartType === ct.id 
                  ? 'bg-[#2a2e39] text-white font-medium border border-[#363a45]' 
                  : 'hover:bg-[#2a2e39]/60 text-[#787b86]'
              }`}
            >
              {ct.icon}
              <span className="hidden lg:inline">{ct.label}</span>
            </button>
          ))}
        </div>

        <div className="h-4 w-[1px] bg-[#2a2e39]" />

        {/* Indicators Trigger */}
        <button
          onClick={() => setIndicatorModalOpen(true)}
          className="flex items-center space-x-1.5 px-2.5 py-1 rounded hover:bg-[#2a2e39] transition-colors border border-[#2a2e39] text-[#d1d4dc]"
        >
          <Layers size={14} className="text-[#2962ff]" />
          <span className="font-medium">Indicators</span>
          {activeIndicatorsCount > 0 && (
            <span className="px-1.5 py-0.2 bg-[#2962ff] text-white rounded-full text-[10px] font-bold">
              {activeIndicatorsCount}
            </span>
          )}
        </button>
      </div>

      {/* Right: Data Feed Modes, Actions, Navigation */}
      <div className="flex items-center space-x-2">
        {/* Data Modes */}
        <div className="flex items-center bg-[#131722] p-0.5 rounded border border-[#2a2e39]">
          <button
            onClick={() => {
              setDataFeedMode('mock');
              setIsRealtimeActive(false);
            }}
            className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] ${
              dataFeedMode === 'mock' ? 'bg-[#2a2e39] text-white font-medium' : 'text-[#787b86] hover:text-white'
            }`}
            title="Use 1,000+ generated mock rounds"
          >
            <Database size={12} />
            <span>Mock</span>
          </button>
          <button
            onClick={() => {
              setDataFeedMode('manual');
              setManualModalOpen(true);
            }}
            className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] ${
              dataFeedMode === 'manual' ? 'bg-[#2a2e39] text-white font-medium' : 'text-[#787b86] hover:text-white'
            }`}
            title="Manual multi-line entry"
          >
            <Edit3 size={12} />
            <span>Manual</span>
          </button>
          <button
            onClick={() => {
              setDataFeedMode('realtime');
              setIsRealtimeActive(!isRealtimeActive);
            }}
            className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] ${
              isRealtimeActive 
                ? 'bg-[#26a69a]/20 text-[#26a69a] border border-[#26a69a]/40 font-medium' 
                : 'text-[#787b86] hover:text-white'
            }`}
            title="Live WebSocket or 5s simulation ticking"
          >
            <Radio size={12} className={isRealtimeActive ? 'animate-pulse text-[#26a69a]' : ''} />
            <span>{isRealtimeActive ? 'Live 5s' : 'Real-time'}</span>
          </button>
        </div>

        {/* Reset Mock */}
        <button
          onClick={() => resetToMockData(1000)}
          title="Regenerate 1000 Mock Rounds"
          className="p-1.5 hover:bg-[#2a2e39] rounded text-[#787b86] hover:text-white transition-colors"
        >
          <RefreshCw size={14} />
        </button>

        {/* Export Data */}
        <button
          onClick={handleDownloadData}
          title="Export Rounds as CSV"
          className="p-1.5 hover:bg-[#2a2e39] rounded text-[#787b86] hover:text-white transition-colors"
        >
          <Download size={14} />
        </button>

        {/* Screenshot Button */}
        <button
          onClick={onCaptureScreenshot}
          title="Take Chart Screenshot"
          className="p-1.5 hover:bg-[#2a2e39] rounded text-[#787b86] hover:text-white transition-colors"
        >
          <Camera size={14} />
        </button>

        {/* Fullscreen */}
        <button
          onClick={handleToggleFullscreen}
          title="Toggle Fullscreen"
          className="p-1.5 hover:bg-[#2a2e39] rounded text-[#787b86] hover:text-white transition-colors"
        >
          <Maximize2 size={14} />
        </button>

        {/* Theme Toggle */}
        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title="Toggle Dark/Light Mode"
          className="p-1.5 hover:bg-[#2a2e39] rounded text-[#787b86] hover:text-white transition-colors"
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>

        {/* Settings Modal */}
        <button
          onClick={() => setSettingsModalOpen(true)}
          title="Chart Settings"
          className="p-1.5 hover:bg-[#2a2e39] rounded text-[#787b86] hover:text-white transition-colors"
        >
          <Settings size={14} />
        </button>

        <div className="h-4 w-[1px] bg-[#2a2e39]" />

        {/* Switch to Mobile Terminal Button */}
        <a
          href="/terminal.html"
          title="Open Dhaniwin Mobile Terminal"
          className="flex items-center space-x-1 px-2.5 py-1 rounded bg-[#27194a] hover:bg-[#382468] text-[#fbc531] font-semibold border border-[#fbc531]/30 transition-colors text-[11px]"
        >
          <span>Terminal</span>
          <ExternalLink size={11} />
        </a>
      </div>
    </header>
  );
};
