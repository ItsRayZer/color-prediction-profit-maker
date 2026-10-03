import { Time } from 'lightweight-charts';
import { CandleData } from '../types/game';
import { 
  SMAConfig, 
  EMAConfig, 
  WMAConfig, 
  RSIConfig, 
  MACDConfig, 
  BollingerConfig, 
  MAChannelConfig,
  RatioOscillatorConfig 
} from '../types/indicators';

export interface LinePoint {
  time: Time;
  value: number;
}

export interface HistogramPoint {
  time: Time;
  value: number;
  color?: string;
}

/**
 * Calculates Simple Moving Average (SMA)
 */
export function calculateSMA(data: CandleData[], config: SMAConfig): LinePoint[] {
  const result: LinePoint[] = [];
  const period = config.period || 14;

  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i].close;
    if (i >= period) {
      sum -= data[i - period].close;
    }
    if (i >= period - 1) {
      result.push({
        time: data[i].time,
        value: Number((sum / period).toFixed(2))
      });
    }
  }
  return result;
}

/**
 * Calculates Exponential Moving Average (EMA)
 */
export function calculateEMA(data: CandleData[], config: EMAConfig): LinePoint[] {
  const result: LinePoint[] = [];
  const period = config.period || 14;
  if (data.length < period) return result;

  const multiplier = 2 / (period + 1);

  // Initial SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i].close;
  }
  let prevEMA = sum / period;
  result.push({
    time: data[period - 1].time,
    value: Number(prevEMA.toFixed(2))
  });

  for (let i = period; i < data.length; i++) {
    const currentClose = data[i].close;
    prevEMA = (currentClose - prevEMA) * multiplier + prevEMA;
    result.push({
      time: data[i].time,
      value: Number(prevEMA.toFixed(2))
    });
  }
  return result;
}

/**
 * Calculates Weighted Moving Average (WMA)
 */
export function calculateWMA(data: CandleData[], config: WMAConfig): LinePoint[] {
  const result: LinePoint[] = [];
  const period = config.period || 14;
  if (data.length < period) return result;

  const weightDenominator = (period * (period + 1)) / 2;

  for (let i = period - 1; i < data.length; i++) {
    let weightedSum = 0;
    for (let j = 0; j < period; j++) {
      const weight = j + 1;
      weightedSum += data[i - period + 1 + j].close * weight;
    }
    result.push({
      time: data[i].time,
      value: Number((weightedSum / weightDenominator).toFixed(2))
    });
  }
  return result;
}

/**
 * Calculates Relative Strength Index (RSI)
 */
export function calculateRSI(data: CandleData[], config: RSIConfig): LinePoint[] {
  const result: LinePoint[] = [];
  const period = config.period || 14;
  if (data.length <= period) return result;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = data[i].close - data[i - 1].close;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  const firstRS = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const firstRSI = avgLoss === 0 ? 100 : 100 - (100 / (1 + firstRS));
  result.push({
    time: data[period].time,
    value: Number(firstRSI.toFixed(2))
  });

  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i].close - data[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));

    result.push({
      time: data[i].time,
      value: Number(rsi.toFixed(2))
    });
  }

  return result;
}

/**
 * Calculates MACD (Line, Signal, Histogram)
 */
export function calculateMACD(data: CandleData[], config: MACDConfig): {
  macdLine: LinePoint[];
  signalLine: LinePoint[];
  histogram: HistogramPoint[];
} {
  const fastPeriod = config.fastPeriod || 12;
  const slowPeriod = config.slowPeriod || 26;
  const signalPeriod = config.signalPeriod || 9;

  const fastEMA = calculateEMA(data, { id: 'ema', name: 'Fast EMA', category: 'overlay', enabled: true, color: '', period: fastPeriod });
  const slowEMA = calculateEMA(data, { id: 'ema', name: 'Slow EMA', category: 'overlay', enabled: true, color: '', period: slowPeriod });

  const slowMap = new Map<string, number>();
  slowEMA.forEach(p => slowMap.set(String(p.time), p.value));

  const macdLine: LinePoint[] = [];
  fastEMA.forEach(f => {
    const slowVal = slowMap.get(String(f.time));
    if (slowVal !== undefined) {
      macdLine.push({
        time: f.time,
        value: Number((f.value - slowVal).toFixed(2))
      });
    }
  });

  // Signal line = EMA of MACD line
  const signalLine: LinePoint[] = [];
  if (macdLine.length >= signalPeriod) {
    const mult = 2 / (signalPeriod + 1);
    let sum = 0;
    for (let i = 0; i < signalPeriod; i++) {
      sum += macdLine[i].value;
    }
    let prevSig = sum / signalPeriod;
    signalLine.push({ time: macdLine[signalPeriod - 1].time, value: Number(prevSig.toFixed(2)) });

    for (let i = signalPeriod; i < macdLine.length; i++) {
      prevSig = (macdLine[i].value - prevSig) * mult + prevSig;
      signalLine.push({ time: macdLine[i].time, value: Number(prevSig.toFixed(2)) });
    }
  }

  const sigMap = new Map<string, number>();
  signalLine.forEach(s => sigMap.set(String(s.time), s.value));

  const histogram: HistogramPoint[] = [];
  macdLine.forEach(m => {
    const sigVal = sigMap.get(String(m.time));
    if (sigVal !== undefined) {
      const histVal = Number((m.value - sigVal).toFixed(2));
      histogram.push({
        time: m.time,
        value: histVal,
        color: histVal >= 0 ? '#26a69a' : '#ef5350'
      });
    }
  });

  return { macdLine, signalLine, histogram };
}

/**
 * Calculates Bollinger Bands (Middle, Upper, Lower)
 */
export function calculateBollingerBands(data: CandleData[], config: BollingerConfig): {
  middle: LinePoint[];
  upper: LinePoint[];
  lower: LinePoint[];
} {
  const period = config.period || 20;
  const stdDev = config.stdDev || 2;
  const middle = calculateSMA(data, { id: 'sma', name: 'SMA', category: 'overlay', enabled: true, color: '', period });

  const upper: LinePoint[] = [];
  const lower: LinePoint[] = [];

  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    const mean = slice.reduce((acc, curr) => acc + curr.close, 0) / period;
    const variance = slice.reduce((acc, curr) => acc + Math.pow(curr.close - mean, 2), 0) / period;
    const sd = Math.sqrt(variance);

    upper.push({
      time: data[i].time,
      value: Number((mean + stdDev * sd).toFixed(2))
    });
    lower.push({
      time: data[i].time,
      value: Number((mean - stdDev * sd).toFixed(2))
    });
  }

  return { middle, upper, lower };
}

/**
 * Calculates Moving Average Channel
 */
export function calculateMAChannel(data: CandleData[], config: MAChannelConfig): {
  upper: LinePoint[];
  lower: LinePoint[];
} {
  const period = config.period || 20;
  const deviation = config.deviation || 2.0;
  const sma = calculateSMA(data, { id: 'sma', name: 'SMA', category: 'overlay', enabled: true, color: '', period });

  const upper: LinePoint[] = [];
  const lower: LinePoint[] = [];

  sma.forEach(p => {
    upper.push({ time: p.time, value: Number((p.value + deviation).toFixed(2)) });
    lower.push({ time: p.time, value: Number((p.value - deviation).toFixed(2)) });
  });

  return { upper, lower };
}

/**
 * Calculates Big/Small Ratio Oscillator (% of BIGs in rolling window, centered around 50)
 */
export function calculateRatioOscillator(data: CandleData[], config: RatioOscillatorConfig): LinePoint[] {
  const result: LinePoint[] = [];
  const lookback = config.lookback || 20;

  for (let i = lookback - 1; i < data.length; i++) {
    const slice = data.slice(i - lookback + 1, i + 1);
    const bigs = slice.filter(d => d.size.toLowerCase() === 'big').length;
    const ratio = (bigs / lookback) * 100;
    result.push({
      time: data[i].time,
      value: Number(ratio.toFixed(1))
    });
  }

  return result;
}

/**
 * Calculates Streak Counter line
 */
export function calculateStreakLine(data: CandleData[]): LinePoint[] {
  const result: LinePoint[] = [];
  let currentStreak = 0;
  let lastSize = '';

  data.forEach(d => {
    if (d.size === lastSize) {
      currentStreak++;
    } else {
      currentStreak = 1;
      lastSize = d.size;
    }
    result.push({
      time: d.time,
      value: d.size === 'big' ? currentStreak : -currentStreak
    });
  });

  return result;
}
