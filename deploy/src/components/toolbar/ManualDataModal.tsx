import React, { useState } from 'react';
import { X, Edit3, CheckCircle, AlertCircle, FileText } from 'lucide-react';
import { useChartStore } from '../../store/useChartStore';
import { parseManualInput } from '../../engine/mockDataGenerator';

const SAMPLE_INPUT = `red-big
green-small
violet-big
red-small
green-big
green-big
red-big
violet-small
red-small
green-small
red-big
green-big`;

export const ManualDataModal: React.FC = () => {
  const { isManualModalOpen, setManualModalOpen, setRounds, setDataFeedMode } = useChartStore();
  const [inputText, setInputText] = useState(SAMPLE_INPUT);
  const [status, setStatus] = useState<string | null>(null);

  if (!isManualModalOpen) return null;

  const handleApply = () => {
    try {
      const parsed = parseManualInput(inputText);
      if (parsed.length === 0) {
        setStatus('Please enter at least 1 valid result line.');
        return;
      }
      setRounds(parsed);
      setDataFeedMode('manual');
      setStatus(`Successfully plotted ${parsed.length} connected rounds!`);
      setTimeout(() => {
        setManualModalOpen(false);
        setStatus(null);
      }, 700);
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#1e222d] border border-[#2a2e39] rounded-lg w-full max-w-lg overflow-hidden shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#2a2e39]">
          <div className="flex items-center space-x-2">
            <Edit3 size={16} className="text-[#26a69a]" />
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">Manual Data Entry</h2>
          </div>
          <button 
            onClick={() => setManualModalOpen(false)}
            className="text-[#787b86] hover:text-white transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3">
          <div className="text-xs text-[#787b86] leading-relaxed">
            Enter one round result per line. Formats supported:
            <span className="text-[#d1d4dc] font-mono block mt-1">
              • color-size (e.g. <span className="text-[#ef5350]">red-big</span>, <span className="text-[#26a69a]">green-small</span>, <span className="text-[#ab47bc]">violet-big</span>)<br/>
              • or number (e.g. <span className="text-white">7 green big</span>, <span className="text-white">0 violet small</span>)
            </span>
          </div>

          <textarea
            rows={10}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="red-big&#10;green-small&#10;violet-big..."
            className="w-full bg-[#131722] border border-[#2a2e39] rounded p-3 font-mono text-xs text-white placeholder-[#787b86] outline-none focus:border-[#2962ff] resize-none"
          />

          {status && (
            <div className={`p-2 rounded text-xs flex items-center space-x-2 ${
              status.startsWith('Error') 
                ? 'bg-[#ef5350]/20 text-[#ef5350] border border-[#ef5350]/40' 
                : 'bg-[#26a69a]/20 text-[#26a69a] border border-[#26a69a]/40'
            }`}>
              {status.startsWith('Error') ? <AlertCircle size={14} /> : <CheckCircle size={14} />}
              <span>{status}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-3 border-t border-[#2a2e39] bg-[#181b24]">
          <button
            onClick={() => setInputText(SAMPLE_INPUT)}
            className="flex items-center space-x-1 text-xs text-[#787b86] hover:text-white transition-colors"
          >
            <FileText size={13} />
            <span>Load Sample Data</span>
          </button>

          <div className="flex space-x-2">
            <button
              onClick={() => setManualModalOpen(false)}
              className="px-3 py-1.5 text-xs text-[#787b86] hover:text-white rounded hover:bg-[#2a2e39] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              className="px-4 py-1.5 bg-[#26a69a] hover:bg-[#208a7f] text-white text-xs font-semibold rounded transition-colors"
            >
              Plot to Chart
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
