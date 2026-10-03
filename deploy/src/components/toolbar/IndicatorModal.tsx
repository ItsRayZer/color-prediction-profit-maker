import React, { useState } from 'react';
import { X, Search, Sliders, Check } from 'lucide-react';
import { useChartStore } from '../../store/useChartStore';
import { IndicatorId, AnyIndicatorConfig } from '../../types/indicators';

export const IndicatorModal: React.FC = () => {
  const { 
    isIndicatorModalOpen, 
    setIndicatorModalOpen, 
    indicators, 
    toggleIndicator, 
    updateIndicator 
  } = useChartStore();

  const [search, setSearch] = useState('');
  const [selectedIndId, setSelectedIndId] = useState<IndicatorId | null>('sma');

  if (!isIndicatorModalOpen) return null;

  const filtered = indicators.filter(ind => 
    ind.name.toLowerCase().includes(search.toLowerCase()) ||
    ind.id.toLowerCase().includes(search.toLowerCase())
  );

  const selectedInd = indicators.find(i => i.id === selectedIndId) || indicators[0];

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#1e222d] border border-[#2a2e39] rounded-lg w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[80vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#2a2e39]">
          <div className="flex items-center space-x-2">
            <Sliders size={16} className="text-[#2962ff]" />
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">Indicators & Metrics</h2>
          </div>
          <button 
            onClick={() => setIndicatorModalOpen(false)}
            className="text-[#787b86] hover:text-white transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search Bar */}
        <div className="p-3 border-b border-[#2a2e39]">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-2.5 text-[#787b86]" />
            <input
              type="text"
              placeholder="Search indicators (e.g., SMA, RSI, Bollinger)..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-[#131722] border border-[#2a2e39] rounded pl-9 pr-3 py-1.5 text-xs text-white placeholder-[#787b86] outline-none focus:border-[#2962ff]"
            />
          </div>
        </div>

        {/* Two Column Content */}
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 divide-x divide-[#2a2e39] overflow-hidden">
          {/* Left: Indicator List */}
          <div className="overflow-y-auto p-2 space-y-1">
            {filtered.map(ind => (
              <div
                key={ind.id}
                onClick={() => setSelectedIndId(ind.id)}
                className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${
                  selectedIndId === ind.id 
                    ? 'bg-[#2a2e39] text-white border border-[#363a45]' 
                    : 'hover:bg-[#2a2e39]/50 text-[#d1d4dc]'
                }`}
              >
                <div className="flex items-center space-x-2">
                  <span 
                    className="w-2.5 h-2.5 rounded-full" 
                    style={{ backgroundColor: ind.color }}
                  />
                  <div>
                    <div className="text-xs font-medium">{ind.name}</div>
                    <div className="text-[10px] text-[#787b86] uppercase font-mono">{ind.category}</div>
                  </div>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleIndicator(ind.id);
                  }}
                  className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                    ind.enabled
                      ? 'bg-[#26a69a] text-white'
                      : 'bg-[#131722] text-[#787b86] border border-[#2a2e39] hover:text-white'
                  }`}
                >
                  {ind.enabled ? 'ACTIVE' : 'ADD'}
                </button>
              </div>
            ))}
          </div>

          {/* Right: Parameter Config */}
          <div className="p-4 overflow-y-auto bg-[#181b24] text-xs">
            {selectedInd ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-[#2a2e39] pb-2">
                  <div>
                    <div className="font-bold text-white text-sm">{selectedInd.name}</div>
                    <div className="text-[#787b86] text-[11px]">Category: {selectedInd.category}</div>
                  </div>
                  <button
                    onClick={() => toggleIndicator(selectedInd.id)}
                    className={`px-3 py-1 rounded font-bold text-xs ${
                      selectedInd.enabled
                        ? 'bg-[#ef5350] hover:bg-[#d32f2f] text-white'
                        : 'bg-[#26a69a] hover:bg-[#208a7f] text-white'
                    }`}
                  >
                    {selectedInd.enabled ? 'Disable' : 'Enable Indicator'}
                  </button>
                </div>

                {/* Period parameter if exists */}
                {'period' in selectedInd && (
                  <div className="space-y-1">
                    <label className="text-[#787b86] font-medium">Period Length:</label>
                    <input
                      type="number"
                      min={2}
                      max={200}
                      value={(selectedInd as any).period || 14}
                      onChange={(e) => updateIndicator(selectedInd.id, { period: Number(e.target.value) })}
                      className="w-full bg-[#131722] border border-[#2a2e39] rounded px-2.5 py-1.5 text-white outline-none focus:border-[#2962ff]"
                    />
                  </div>
                )}

                {/* Bollinger StdDev */}
                {'stdDev' in selectedInd && (
                  <div className="space-y-1">
                    <label className="text-[#787b86] font-medium">Standard Deviations:</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0.5"
                      max="5"
                      value={(selectedInd as any).stdDev || 2}
                      onChange={(e) => updateIndicator(selectedInd.id, { stdDev: Number(e.target.value) })}
                      className="w-full bg-[#131722] border border-[#2a2e39] rounded px-2.5 py-1.5 text-white outline-none focus:border-[#2962ff]"
                    />
                  </div>
                )}

                {/* MACD Parameters */}
                {'fastPeriod' in selectedInd && (
                  <div className="space-y-3">
                    <div>
                      <label className="text-[#787b86]">Fast EMA Period:</label>
                      <input
                        type="number"
                        value={(selectedInd as any).fastPeriod || 12}
                        onChange={(e) => updateIndicator(selectedInd.id, { fastPeriod: Number(e.target.value) })}
                        className="w-full bg-[#131722] border border-[#2a2e39] rounded px-2.5 py-1 text-white outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[#787b86]">Slow EMA Period:</label>
                      <input
                        type="number"
                        value={(selectedInd as any).slowPeriod || 26}
                        onChange={(e) => updateIndicator(selectedInd.id, { slowPeriod: Number(e.target.value) })}
                        className="w-full bg-[#131722] border border-[#2a2e39] rounded px-2.5 py-1 text-white outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[#787b86]">Signal Period:</label>
                      <input
                        type="number"
                        value={(selectedInd as any).signalPeriod || 9}
                        onChange={(e) => updateIndicator(selectedInd.id, { signalPeriod: Number(e.target.value) })}
                        className="w-full bg-[#131722] border border-[#2a2e39] rounded px-2.5 py-1 text-white outline-none"
                      />
                    </div>
                  </div>
                )}

                {/* Color picker */}
                <div className="space-y-1">
                  <label className="text-[#787b86] font-medium">Plot Color:</label>
                  <div className="flex items-center space-x-2">
                    <input
                      type="color"
                      value={selectedInd.color}
                      onChange={(e) => updateIndicator(selectedInd.id, { color: e.target.value })}
                      className="w-8 h-8 rounded border border-[#2a2e39] bg-transparent cursor-pointer"
                    />
                    <span className="font-mono text-[11px] text-[#d1d4dc]">{selectedInd.color}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center text-[#787b86] py-10">Select an indicator to edit settings</div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end p-3 border-t border-[#2a2e39] bg-[#1e222d]">
          <button
            onClick={() => setIndicatorModalOpen(false)}
            className="px-4 py-1.5 bg-[#2962ff] hover:bg-[#1e4bd8] text-white font-medium rounded text-xs transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
