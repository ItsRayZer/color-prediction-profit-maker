import React, { useState } from 'react';
import { 
  TrendingUp, 
  TrendingDown, 
  Flame, 
  Award, 
  Zap, 
  History, 
  PieChart as PieChartIcon,
  ChevronRight,
  ChevronLeft
} from 'lucide-react';
import { GameStats, GameRound } from '../../types/game';

interface SideStatsPanelProps {
  stats: GameStats;
  rounds: GameRound[];
}

export const SideStatsPanel: React.FC<SideStatsPanelProps> = ({ stats, rounds }) => {
  const [collapsed, setCollapsed] = useState(false);

  const recent20 = rounds.slice(-20).reverse();
  const totalRounds = (stats.bigCount + stats.smallCount) || 1;
  const bigPercent = ((stats.bigCount / totalRounds) * 100).toFixed(1);
  const smallPercent = ((stats.smallCount / totalRounds) * 100).toFixed(1);

  if (collapsed) {
    return (
      <div className="w-8 bg-[#1e222d] border-l border-[#2a2e39] flex flex-col items-center py-3 text-[#787b86]">
        <button 
          onClick={() => setCollapsed(false)}
          title="Expand Analytics Panel"
          className="p-1 hover:text-white hover:bg-[#2a2e39] rounded"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="text-[10px] uppercase font-bold tracking-widest text-[#787b86] [writing-mode:vertical-lr] rotate-180 mt-6">
          Analytics & History
        </span>
      </div>
    );
  }

  return (
    <aside className="w-72 bg-[#1e222d] border-l border-[#2a2e39] flex flex-col h-full overflow-y-auto text-xs text-[#d1d4dc] select-none z-10">
      {/* Header */}
      <div className="h-10 px-3 border-b border-[#2a2e39] flex items-center justify-between bg-[#181b24]">
        <div className="flex items-center space-x-2">
          <Award size={15} className="text-[#fbc531]" />
          <h3 className="font-bold text-white uppercase tracking-wider text-[11px]">Game Analytics</h3>
        </div>
        <button 
          onClick={() => setCollapsed(true)}
          title="Collapse Panel"
          className="text-[#787b86] hover:text-white p-1 rounded hover:bg-[#2a2e39]"
        >
          <ChevronRight size={15} />
        </button>
      </div>

      <div className="p-3 space-y-4">
        {/* Live Snapshot Card */}
        <div className="bg-[#131722] p-3 rounded-lg border border-[#2a2e39] space-y-2.5">
          <div className="flex justify-between items-center text-[11px] text-[#787b86]">
            <span>Current Round</span>
            <span className="font-mono text-white font-bold">#{stats.currentRound}</span>
          </div>

          <div className="flex justify-between items-center">
            <span className="text-[#787b86]">Continuous Price:</span>
            <span className={`font-mono text-base font-bold flex items-center space-x-1 ${
              stats.currentPrice >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'
            }`}>
              {stats.currentPrice >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
              <span>{stats.currentPrice > 0 ? `+${stats.currentPrice}` : stats.currentPrice}</span>
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="bg-[#1e222d] p-2 rounded border border-[#2a2e39]/80">
              <div className="text-[10px] text-[#787b86]">Last Result</div>
              <div className={`font-bold text-sm ${stats.lastResult === 'BIG' ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
                {stats.lastResult}
              </div>
            </div>
            <div className="bg-[#1e222d] p-2 rounded border border-[#2a2e39]/80">
              <div className="text-[10px] text-[#787b86]">Ball Colour</div>
              <div className="font-bold text-sm capitalize flex items-center space-x-1" style={{
                color: stats.lastBallColor === 'violet' ? '#ab47bc' : stats.lastBallColor === 'red' ? '#ef5350' : '#26a69a'
              }}>
                <span className="w-2 h-2 rounded-full inline-block" style={{
                  backgroundColor: stats.lastBallColor === 'violet' ? '#ab47bc' : stats.lastBallColor === 'red' ? '#ef5350' : '#26a69a'
                }} />
                <span>{stats.lastBallColor}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Current Active Streak */}
        <div className="bg-gradient-to-r from-[#2962ff]/10 to-[#1e222d] p-3 rounded-lg border border-[#2962ff]/30 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Flame size={18} className="text-[#ff9800] animate-pulse" />
            <div>
              <div className="text-[10px] text-[#787b86] uppercase font-semibold">Active Streak</div>
              <div className="font-bold text-white text-sm">
                {stats.currentStreak.count}x {stats.currentStreak.type}
              </div>
            </div>
          </div>
          <span className="px-2 py-0.5 rounded bg-[#2962ff] text-white font-mono font-bold text-xs">
            HOT
          </span>
        </div>

        {/* Big vs Small Distribution */}
        <div className="space-y-2">
          <div className="flex justify-between text-[11px] font-medium">
            <span className="text-[#26a69a]">BIG: {stats.bigCount} ({bigPercent}%)</span>
            <span className="text-[#ef5350]">SMALL: {stats.smallCount} ({smallPercent}%)</span>
          </div>
          <div className="w-full h-2 bg-[#131722] rounded-full overflow-hidden flex">
            <div 
              style={{ width: `${bigPercent}%` }} 
              className="bg-[#26a69a] h-full transition-all duration-300"
            />
            <div 
              style={{ width: `${smallPercent}%` }} 
              className="bg-[#ef5350] h-full transition-all duration-300"
            />
          </div>
        </div>

        {/* Colour Breakdown */}
        <div className="bg-[#131722] p-3 rounded-lg border border-[#2a2e39] space-y-2">
          <div className="text-[11px] font-semibold text-[#787b86] uppercase">Color Distribution</div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-[#1e222d] p-1.5 rounded border border-[#ef5350]/30">
              <div className="text-[10px] text-[#ef5350] font-semibold">RED</div>
              <div className="font-mono font-bold text-white">{stats.redCount}</div>
            </div>
            <div className="bg-[#1e222d] p-1.5 rounded border border-[#26a69a]/30">
              <div className="text-[10px] text-[#26a69a] font-semibold">GREEN</div>
              <div className="font-mono font-bold text-white">{stats.greenCount}</div>
            </div>
            <div className="bg-[#1e222d] p-1.5 rounded border border-[#ab47bc]/30">
              <div className="text-[10px] text-[#ab47bc] font-semibold">VIOLET</div>
              <div className="font-mono font-bold text-white">{stats.violetCount}</div>
            </div>
          </div>
        </div>

        {/* Max Streaks Records */}
        <div className="bg-[#131722] p-3 rounded-lg border border-[#2a2e39] space-y-2">
          <div className="text-[11px] font-semibold text-[#787b86] uppercase">Historical Max Streaks</div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="flex justify-between p-1.5 rounded bg-[#1e222d]">
              <span className="text-[#787b86]">Max BIG:</span>
              <span className="font-bold text-[#26a69a]">{stats.maxBigStreak}x</span>
            </div>
            <div className="flex justify-between p-1.5 rounded bg-[#1e222d]">
              <span className="text-[#787b86]">Max SMALL:</span>
              <span className="font-bold text-[#ef5350]">{stats.maxSmallStreak}x</span>
            </div>
            <div className="flex justify-between p-1.5 rounded bg-[#1e222d]">
              <span className="text-[#787b86]">Max RED:</span>
              <span className="font-bold text-[#ef5350]">{stats.maxRedStreak}x</span>
            </div>
            <div className="flex justify-between p-1.5 rounded bg-[#1e222d]">
              <span className="text-[#787b86]">Max GREEN:</span>
              <span className="font-bold text-[#26a69a]">{stats.maxGreenStreak}x</span>
            </div>
          </div>
        </div>

        {/* Recent 20-Round Stream */}
        <div className="space-y-2">
          <div className="flex items-center space-x-1.5 text-[11px] font-semibold text-[#787b86] uppercase">
            <History size={13} />
            <span>Recent 20 Rounds</span>
          </div>

          <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
            {recent20.map((r) => {
              const isBig = r.size === 'big';
              return (
                <div 
                  key={r.roundId}
                  className="flex items-center justify-between p-1.5 rounded bg-[#131722] hover:bg-[#2a2e39]/60 border border-[#2a2e39]/40 text-[11px]"
                >
                  <div className="flex items-center space-x-2">
                    <span 
                      className="w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px] text-white shadow-sm"
                      style={{
                        backgroundColor: r.color === 'violet' ? '#ab47bc' : r.color === 'red' ? '#ef5350' : '#26a69a'
                      }}
                    >
                      {r.number}
                    </span>
                    <span className="font-mono text-[#787b86]">#{String(r.roundId).slice(-4)}</span>
                  </div>

                  <div className="flex items-center space-x-2">
                    <span className={`font-bold uppercase text-[10px] px-1.5 py-0.2 rounded ${
                      isBig ? 'bg-[#26a69a]/20 text-[#26a69a]' : 'bg-[#ef5350]/20 text-[#ef5350]'
                    }`}>
                      {r.size}
                    </span>
                    <span className="text-[#787b86] capitalize text-[10px]">{r.color}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
};
