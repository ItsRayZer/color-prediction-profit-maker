export type IndicatorId = 
  | 'sma' 
  | 'ema' 
  | 'wma' 
  | 'rsi' 
  | 'macd' 
  | 'bollinger' 
  | 'maChannel' 
  | 'volumeHistogram' 
  | 'streakCounter' 
  | 'ratioOscillator';

export interface BaseIndicatorConfig {
  id: IndicatorId;
  name: string;
  category: 'overlay' | 'oscillator' | 'volume';
  enabled: boolean;
  color: string;
  period?: number;
}

export interface SMAConfig extends BaseIndicatorConfig {
  id: 'sma';
  period: number;
}

export interface EMAConfig extends BaseIndicatorConfig {
  id: 'ema';
  period: number;
}

export interface WMAConfig extends BaseIndicatorConfig {
  id: 'wma';
  period: number;
}

export interface RSIConfig extends BaseIndicatorConfig {
  id: 'rsi';
  period: number;
  overbought: number;
  oversold: number;
}

export interface MACDConfig extends BaseIndicatorConfig {
  id: 'macd';
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
}

export interface BollingerConfig extends BaseIndicatorConfig {
  id: 'bollinger';
  period: number;
  stdDev: number;
  upperColor: string;
  lowerColor: string;
}

export interface MAChannelConfig extends BaseIndicatorConfig {
  id: 'maChannel';
  period: number;
  deviation: number;
}

export interface VolumeHistogramConfig extends BaseIndicatorConfig {
  id: 'volumeHistogram';
}

export interface StreakCounterConfig extends BaseIndicatorConfig {
  id: 'streakCounter';
}

export interface RatioOscillatorConfig extends BaseIndicatorConfig {
  id: 'ratioOscillator';
  lookback: number;
}

export type AnyIndicatorConfig = 
  | SMAConfig 
  | EMAConfig 
  | WMAConfig 
  | RSIConfig 
  | MACDConfig 
  | BollingerConfig 
  | MAChannelConfig 
  | VolumeHistogramConfig 
  | StreakCounterConfig 
  | RatioOscillatorConfig;
