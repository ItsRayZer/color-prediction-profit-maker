import React from 'react';
import { X, Sliders, Shield, Palette } from 'lucide-react';
import { useChartStore } from '../../store/useChartStore';

export const SettingsModal: React.FC = () => {
  const { isSettingsModalOpen, setSettingsModalOpen, drawingColor, setDrawingColor, drawingLineWidth, setDrawingLineWidth } = useChartStore();

  if (!isSettingsModalOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#1e222d] border border-[#2a2e39] rounded-lg w-full max-w-md overflow-hidden shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#2a2e39]">
          <div className="flex items-center space-x-2">
            <Sliders size={16} className="text-[#2962ff]" />
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">Chart & Drawing Settings</h2>
          </div>
          <button 
            onClick={() => setSettingsModalOpen(false)}
            className="text-[#787b86] hover:text-white transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 text-xs">
          {/* Default Drawing Color */}
          <div className="flex items-center justify-between">
            <span className="text-[#d1d4dc] font-medium">Default Drawing Color</span>
            <div className="flex items-center space-x-2">
              <input
                type="color"
                value={drawingColor}
                onChange={(e) => setDrawingColor(e.target.value)}
                className="w-7 h-7 rounded border border-[#2a2e39] bg-transparent cursor-pointer"
              />
              <span className="font-mono text-[11px] text-[#787b86]">{drawingColor}</span>
            </div>
          </div>

          {/* Line Width */}
          <div className="flex items-center justify-between">
            <span className="text-[#d1d4dc] font-medium">Line Width ({drawingLineWidth}px)</span>
            <div className="flex items-center space-x-2">
              {[1, 2, 3, 4].map(w => (
                <button
                  key={w}
                  onClick={() => setDrawingLineWidth(w)}
                  className={`w-6 h-6 rounded flex items-center justify-center font-bold text-[10px] ${
                    drawingLineWidth === w ? 'bg-[#2962ff] text-white' : 'bg-[#131722] text-[#787b86] hover:text-white'
                  }`}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>

          <div className="h-[1px] bg-[#2a2e39]" />

          {/* Game Rules Info */}
          <div className="bg-[#131722] p-3 rounded border border-[#2a2e39] space-y-2 text-[#787b86]">
            <div className="flex items-center space-x-1 text-white font-medium">
              <Shield size={13} className="text-[#26a69a]" />
              <span>TradingView Prediction System</span>
            </div>
            <p className="text-[11px] leading-relaxed">
              • BIG = +1 price movement (bullish green candle)<br/>
              • SMALL = -1 price movement (bearish red candle)<br/>
              • Next candle always opens strictly at previous close.<br/>
              • Markers display ball number with color (Red, Green, Violet).
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-[#2a2e39] bg-[#181b24] flex justify-end">
          <button
            onClick={() => setSettingsModalOpen(false)}
            className="px-4 py-1.5 bg-[#2962ff] hover:bg-[#1e4bd8] text-white font-medium rounded text-xs transition-colors"
          >
            Save & Close
          </button>
        </div>
      </div>
    </div>
  );
};
