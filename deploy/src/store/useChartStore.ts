import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { GameRound, ChartType, Timeframe, DataFeedMode } from '../types/game';
import { AnyIndicatorConfig, IndicatorId } from '../types/indicators';
import { generateMockRounds } from '../engine/mockDataGenerator';

const INITIAL_INDICATORS: AnyIndicatorConfig[] = [
  { id: 'sma', name: 'SMA (Simple Moving Avg)', category: 'overlay', enabled: false, color: '#2962ff', period: 14 },
  { id: 'ema', name: 'EMA (Exponential Moving Avg)', category: 'overlay', enabled: true, color: '#ff9800', period: 9 },
  { id: 'wma', name: 'WMA (Weighted Moving Avg)', category: 'overlay', enabled: false, color: '#e91e63', period: 14 },
  { id: 'rsi', name: 'RSI (Relative Strength)', category: 'oscillator', enabled: false, color: '#ab47bc', period: 14, overbought: 70, oversold: 30 },
  { id: 'macd', name: 'MACD (12, 26, 9)', category: 'oscillator', enabled: false, color: '#26a69a', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  { id: 'bollinger', name: 'Bollinger Bands', category: 'overlay', enabled: false, color: '#2962ff', period: 20, stdDev: 2, upperColor: '#26a69a', lowerColor: '#ef5350' },
  { id: 'maChannel', name: 'MA Channel', category: 'overlay', enabled: false, color: '#00bcd4', period: 20, deviation: 2.0 },
  { id: 'volumeHistogram', name: 'Big/Small Volume Histogram', category: 'volume', enabled: true, color: '#26a69a' },
  { id: 'streakCounter', name: 'Streak Counter Line', category: 'oscillator', enabled: false, color: '#ffeb3b' },
  { id: 'ratioOscillator', name: 'Big/Small Ratio Oscillator', category: 'oscillator', enabled: false, color: '#00e676', lookback: 20 }
];

export interface ChartStoreState {
  rounds: GameRound[];
  chartType: ChartType;
  timeframe: Timeframe;
  symbol: string;
  dataFeedMode: DataFeedMode;
  isRealtimeActive: boolean;
  theme: 'dark' | 'light';
  
  // Drawing state
  activeDrawingTool: string | null;
  drawingColor: string;
  drawingLineWidth: number;
  drawingsJson: string;

  // Indicators
  indicators: AnyIndicatorConfig[];

  // Modals
  isManualModalOpen: boolean;
  isIndicatorModalOpen: boolean;
  isSettingsModalOpen: boolean;

  // Actions
  setChartType: (chartType: ChartType) => void;
  setTimeframe: (timeframe: Timeframe) => void;
  setSymbol: (symbol: string) => void;
  setDataFeedMode: (mode: DataFeedMode) => void;
  setIsRealtimeActive: (active: boolean) => void;
  setTheme: (theme: 'dark' | 'light') => void;
  setRounds: (rounds: GameRound[]) => void;
  addRound: (round: GameRound) => void;
  resetToMockData: (count?: number) => void;

  setActiveDrawingTool: (tool: string | null) => void;
  setDrawingColor: (color: string) => void;
  setDrawingLineWidth: (width: number) => void;
  setDrawingsJson: (json: string) => void;

  toggleIndicator: (id: IndicatorId) => void;
  updateIndicator: (id: IndicatorId, updates: Partial<AnyIndicatorConfig>) => void;

  setManualModalOpen: (open: boolean) => void;
  setIndicatorModalOpen: (open: boolean) => void;
  setSettingsModalOpen: (open: boolean) => void;

  exportRoundsAsJson: () => string;
  exportRoundsAsCsv: () => string;
}

export const useChartStore = create<ChartStoreState>()(
  persist(
    (set, get) => ({
      rounds: generateMockRounds(1000, 30),
      chartType: 'candlestick',
      timeframe: '30s',
      symbol: 'WinGo 30s',
      dataFeedMode: 'mock',
      isRealtimeActive: false,
      theme: 'dark',

      activeDrawingTool: null,
      drawingColor: '#2962ff',
      drawingLineWidth: 2,
      drawingsJson: '[]',

      indicators: INITIAL_INDICATORS,

      isManualModalOpen: false,
      isIndicatorModalOpen: false,
      isSettingsModalOpen: false,

      setChartType: (chartType) => set({ chartType }),
      setTimeframe: (timeframe) => set({ timeframe }),
      setSymbol: (symbol) => set({ symbol }),
      setDataFeedMode: (dataFeedMode) => set({ dataFeedMode }),
      setIsRealtimeActive: (isRealtimeActive) => set({ isRealtimeActive }),
      setTheme: (theme) => set({ theme }),

      setRounds: (rounds) => set({ rounds }),
      addRound: (round) => {
        const current = get().rounds;
        // Keep up to 10,000 rounds smoothly
        const updated = current.length >= 10000 
          ? [...current.slice(1), round]
          : [...current, round];
        set({ rounds: updated });
      },
      resetToMockData: (count = 1000) => {
        const mock = generateMockRounds(count, 30);
        set({ rounds: mock, dataFeedMode: 'mock' });
      },

      setActiveDrawingTool: (activeDrawingTool) => set({ activeDrawingTool }),
      setDrawingColor: (drawingColor) => set({ drawingColor }),
      setDrawingLineWidth: (drawingLineWidth) => set({ drawingLineWidth }),
      setDrawingsJson: (drawingsJson) => set({ drawingsJson }),

      toggleIndicator: (id) => {
        const updated = get().indicators.map(ind => 
          ind.id === id ? { ...ind, enabled: !ind.enabled } : ind
        );
        set({ indicators: updated });
      },
      updateIndicator: (id, updates) => {
        const updated = get().indicators.map(ind => 
          ind.id === id ? { ...ind, ...updates } : ind
        );
        set({ indicators: updated as AnyIndicatorConfig[] });
      },

      setManualModalOpen: (isManualModalOpen) => set({ isManualModalOpen }),
      setIndicatorModalOpen: (isIndicatorModalOpen) => set({ isIndicatorModalOpen }),
      setSettingsModalOpen: (isSettingsModalOpen) => set({ isSettingsModalOpen }),

      exportRoundsAsJson: () => {
        return JSON.stringify(get().rounds, null, 2);
      },
      exportRoundsAsCsv: () => {
        const rounds = get().rounds;
        let csv = 'roundId,timestamp,number,color,size\n';
        rounds.forEach(r => {
          csv += `${r.roundId},${r.timestamp},${r.number},${r.color},${r.size}\n`;
        });
        return csv;
      }
    }),
    {
      name: 'prediction-trading-chart-storage',
      partialize: (state) => ({
        chartType: state.chartType,
        timeframe: state.timeframe,
        symbol: state.symbol,
        theme: state.theme,
        drawingColor: state.drawingColor,
        drawingLineWidth: state.drawingLineWidth,
        drawingsJson: state.drawingsJson,
        indicators: state.indicators
      })
    }
  )
);
