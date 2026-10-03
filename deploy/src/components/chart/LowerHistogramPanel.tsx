import React, { useState } from 'react';
import { GameRound } from '../../types/game';
import { AnyIndicatorConfig } from '../../types/indicators';

interface LowerHistogramPanelProps {
  rounds: GameRound[];
  indicators: AnyIndicatorConfig[];
}

export const LowerHistogramPanel: React.FC<LowerHistogramPanelProps> = ({ rounds, indicators }) => {
  const [hoveredRound, setHoveredRound] = useState<GameRound | null>(null);

  const displayRounds = rounds.slice(-60); // Show recent 60 rounds in lower histogram

  return (
    <div className="h-28 bg-[#181b24] border-t border-[#2a2e39] flex flex-col select-none relative">
      {/* Header with info & tooltip */}
      <div className="h-6 px-3 flex items-center justify-between border-b border-[#2a2e39]/60 text-[11px] text-[#787b86]">
        <div className="flex items-center space-x-3">
          <span className="font-semibold text-[#d1d4dc] flex items-center space-x-1">
            <span className="w-2 h-2 rounded-full bg-[#26a69a]" />
            <span>Volume / Result Histogram</span>
          </span>
          <span className="text-[10px]">
            Green: BIG | Red: SMALL | Violet: Overlay
          </span>
        </div>

        {/* Hover metadata display */}
        {hoveredRound ? (
          <div className="flex items-center space-x-2 font-mono text-[11px]">
            <span className="text-white font-bold">Round #{hoveredRound.roundId}</span>
            <span>Ball: <b className="text-white">{hoveredRound.number}</b></span>
            <span className={hoveredRound.size === 'big' ? 'text-[#26a69a] font-bold' : 'text-[#ef5350] font-bold'}>
              {hoveredRound.size.toUpperCase()}
            </span>
            <span className="capitalize" style={{
              color: hoveredRound.color === 'violet' ? '#ab47bc' : hoveredRound.color === 'red' ? '#ef5350' : '#26a69a'
            }}>
              {hoveredRound.color}
            </span>
          </div>
        ) : (
          <span className="text-[10px] text-[#787b86] italic">Hover bars to view round details</span>
        )}
      </div>

      {/* Bar Histogram Visualization */}
      <div className="flex-1 flex items-end px-3 py-1 space-x-1 overflow-hidden">
        {displayRounds.map((r, i) => {
          const isBig = r.size.toLowerCase() === 'big';
          const isViolet = r.color === 'violet';
          const heightPercent = isBig ? 85 : 55;

          return (
            <div
              key={`${r.roundId}-${i}`}
              onMouseEnter={() => setHoveredRound(r)}
              onMouseLeave={() => setHoveredRound(null)}
              className="flex-1 min-w-[5px] max-w-[16px] h-full flex flex-col justify-end items-center group cursor-pointer relative"
            >
              {/* Violet marker indicator on top */}
              {isViolet && (
                <div className="w-1.5 h-1.5 bg-[#ab47bc] rotate-45 mb-1 rounded-sm shadow-sm" />
              )}

              {/* Main Volume Bar */}
              <div
                style={{ height: `${heightPercent}%` }}
                className={`w-full rounded-t-sm transition-all duration-150 ${
                  isBig 
                    ? 'bg-[#26a69a]/80 group-hover:bg-[#26a69a]' 
                    : 'bg-[#ef5350]/80 group-hover:bg-[#ef5350]'
                }`}
              />

              {/* Ball Number Tag */}
              <span className="text-[9px] font-mono text-[#787b86] group-hover:text-white mt-0.5">
                {r.number}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
