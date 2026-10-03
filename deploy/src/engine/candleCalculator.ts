import { Time, SeriesMarker } from 'lightweight-charts';
import { GameRound, CandleData, GameStats, GameColor, StreakInfo } from '../types/game';

/**
 * Transforms an array of GameRounds into strictly continuous OHLC candles
 * and TradingView series markers.
 *
 * Continuous Candlestick Rules:
 * - First candle opens at 0.0.
 * - Every subsequent candle opens strictly at previous.close.
 * - BIG = close = open + 1 (Bullish green).
 * - SMALL = close = open - 1 (Bearish red).
 * - High = max(open, close), Low = min(open, close).
 */
export function calculateCandles(rounds: GameRound[]): {
  candles: CandleData[];
  markers: SeriesMarker<Time>[];
  stats: GameStats;
} {
  const candles: CandleData[] = [];
  const markers: SeriesMarker<Time>[] = [];

  if (!rounds || rounds.length === 0) {
    return {
      candles: [],
      markers: [],
      stats: createDefaultStats()
    };
  }

  let prevClose = 0;
  let lastTimestamp = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const isBig = r.size.toLowerCase() === 'big';
    const open = prevClose;
    const close = isBig ? open + 1 : open - 1;
    const high = Math.max(open, close);
    const low = Math.min(open, close);

    // Lightweight charts requires strictly increasing timestamps
    let timeSeconds = Math.floor(r.timestamp / 1000);
    if (timeSeconds <= lastTimestamp) {
      timeSeconds = lastTimestamp + 1;
    }
    lastTimestamp = timeSeconds;

    const candle: CandleData = {
      time: timeSeconds as unknown as Time,
      open,
      high,
      low,
      close,
      roundId: r.roundId,
      number: r.number,
      color: r.color,
      size: r.size
    };
    candles.push(candle);
    prevClose = close;

    // Create ball marker
    let markerColor = '#26a69a'; // green
    let markerShape: 'circle' | 'square' | 'arrowUp' | 'arrowDown' = 'circle';

    if (r.color === 'red') {
      markerColor = '#ef5350';
      markerShape = 'circle';
    } else if (r.color === 'violet') {
      markerColor = '#ab47bc';
      markerShape = 'square'; // Diamond/square for violet
    } else {
      markerColor = '#26a69a';
      markerShape = 'circle';
    }

    markers.push({
      time: timeSeconds as unknown as Time,
      position: isBig ? 'belowBar' : 'aboveBar',
      color: markerColor,
      shape: markerShape,
      text: `${r.number}`
    });
  }

  const stats = calculateGameStats(rounds, prevClose);

  return { candles, markers, stats };
}

/**
 * Computes live game statistics including streaks, counts, and cumulative score.
 */
export function calculateGameStats(rounds: GameRound[], currentPrice: number = 0): GameStats {
  if (!rounds || rounds.length === 0) {
    return createDefaultStats();
  }

  let bigCount = 0;
  let smallCount = 0;
  let redCount = 0;
  let greenCount = 0;
  let violetCount = 0;

  let currentStreakType: 'BIG' | 'SMALL' | 'RED' | 'GREEN' = 'BIG';
  let currentStreakCount = 0;

  let maxBigStreak = 0;
  let maxSmallStreak = 0;
  let maxRedStreak = 0;
  let maxGreenStreak = 0;

  let tempBigStreak = 0;
  let tempSmallStreak = 0;
  let tempRedStreak = 0;
  let tempGreenStreak = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const isBig = r.size.toLowerCase() === 'big';

    if (isBig) {
      bigCount++;
      tempBigStreak++;
      if (tempBigStreak > maxBigStreak) maxBigStreak = tempBigStreak;
      tempSmallStreak = 0;
    } else {
      smallCount++;
      tempSmallStreak++;
      if (tempSmallStreak > maxSmallStreak) maxSmallStreak = tempSmallStreak;
      tempBigStreak = 0;
    }

    if (r.color === 'red') {
      redCount++;
      tempRedStreak++;
      if (tempRedStreak > maxRedStreak) maxRedStreak = tempRedStreak;
      tempGreenStreak = 0;
    } else if (r.color === 'green') {
      greenCount++;
      tempGreenStreak++;
      if (tempGreenStreak > maxGreenStreak) maxGreenStreak = tempGreenStreak;
      tempRedStreak = 0;
    } else {
      violetCount++;
      // violet can act as either or break pure color streak
      tempRedStreak = 0;
      tempGreenStreak = 0;
    }

    // Check streak at the end
    if (i === rounds.length - 1) {
      if (isBig && tempBigStreak > 0) {
        currentStreakType = 'BIG';
        currentStreakCount = tempBigStreak;
      } else if (!isBig && tempSmallStreak > 0) {
        currentStreakType = 'SMALL';
        currentStreakCount = tempSmallStreak;
      }
    }
  }

  const last = rounds[rounds.length - 1];

  return {
    currentRound: last.roundId,
    currentPrice,
    lastResult: last.size.toUpperCase() as 'BIG' | 'SMALL',
    lastBallColor: last.color,
    bigCount,
    smallCount,
    redCount,
    greenCount,
    violetCount,
    currentStreak: {
      type: currentStreakType,
      count: currentStreakCount
    },
    maxBigStreak,
    maxSmallStreak,
    maxRedStreak,
    maxGreenStreak,
    cumulativeScore: currentPrice
  };
}

function createDefaultStats(): GameStats {
  return {
    currentRound: 0,
    currentPrice: 0,
    lastResult: '-',
    lastBallColor: '-',
    bigCount: 0,
    smallCount: 0,
    redCount: 0,
    greenCount: 0,
    violetCount: 0,
    currentStreak: { type: 'BIG', count: 0 },
    maxBigStreak: 0,
    maxSmallStreak: 0,
    maxRedStreak: 0,
    maxGreenStreak: 0,
    cumulativeScore: 0
  };
}
