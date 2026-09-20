import { Time, SeriesMarkerPosition, SeriesMarkerShape } from 'lightweight-charts';

export type GameColor = 'red' | 'green' | 'violet';
export type GameSize = 'big' | 'small';

export interface GameRound {
  roundId: number;
  timestamp: number;
  number: number;
  color: GameColor;
  size: GameSize;
}

export interface CandleData {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  roundId: number;
  number: number;
  color: GameColor;
  size: GameSize;
}

export interface BallMarker {
  time: Time;
  position: SeriesMarkerPosition;
  color: string;
  shape: SeriesMarkerShape;
  text: string;
  id?: string;
}

export type ChartType = 'candlestick' | 'bar' | 'line' | 'area' | 'baseline' | 'hollow';
export type Timeframe = '30s' | '1m' | '3m' | '5m' | '10m';
export type DataFeedMode = 'mock' | 'manual' | 'realtime';

export interface StreakInfo {
  type: 'BIG' | 'SMALL' | 'RED' | 'GREEN';
  count: number;
}

export interface GameStats {
  currentRound: number;
  currentPrice: number;
  lastResult: 'BIG' | 'SMALL' | '-';
  lastBallColor: GameColor | '-';
  bigCount: number;
  smallCount: number;
  redCount: number;
  greenCount: number;
  violetCount: number;
  currentStreak: StreakInfo;
  maxBigStreak: number;
  maxSmallStreak: number;
  maxRedStreak: number;
  maxGreenStreak: number;
  cumulativeScore: number;
}
