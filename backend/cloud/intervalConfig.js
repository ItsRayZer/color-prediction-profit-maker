/**
 * Interval & Source Configuration System
 * ======================================
 * Supports all existing intervals (30s, 1m, 3m, 5m) and allows
 * dynamic addition of future intervals without redesign.
 */

export const INTERVAL_CONFIGS = {
  '30s': {
    id: '30s',
    name: 'WinGo 30 Seconds',
    code: '10005',
    durationSec: 30,
    pollIntervalMs: 2500,
    urlBase: 'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json',
    enabled: true
  },
  '1m': {
    id: '1m',
    name: 'WinGo 1 Minute',
    code: '10001',
    durationSec: 60,
    pollIntervalMs: 4000,
    urlBase: 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json',
    enabled: true
  },
  '3m': {
    id: '3m',
    name: 'WinGo 3 Minutes',
    code: '10002',
    durationSec: 180,
    pollIntervalMs: 7000,
    urlBase: 'https://draw.ar-lottery01.com/WinGo/WinGo_3M/GetHistoryIssuePage.json',
    enabled: true
  },
  '5m': {
    id: '5m',
    name: 'WinGo 5 Minutes',
    code: '10003',
    durationSec: 300,
    pollIntervalMs: 10000,
    urlBase: 'https://draw.ar-lottery01.com/WinGo/WinGo_5M/GetHistoryIssuePage.json',
    enabled: true
  }
};

export function registerIntervalConfig(config) {
  if (!config.id || !config.code || !config.urlBase) {
    throw new Error('Interval config must provide id, code, and urlBase');
  }
  INTERVAL_CONFIGS[config.id] = {
    durationSec: 60,
    pollIntervalMs: 5000,
    enabled: true,
    ...config
  };
  return INTERVAL_CONFIGS[config.id];
}

export function computeNextPeriod(currentPeriod) {
  if (!currentPeriod) return '';
  try {
    const s = String(currentPeriod).trim();
    const prefix = s.slice(0, -4);
    const suffix = parseInt(s.slice(-4), 10);
    if (isNaN(suffix)) return '';
    return `${prefix}${String(suffix + 1).padStart(4, '0')}`;
  } catch (e) {
    return '';
  }
}

export function getColorForNumber(num) {
  const n = parseInt(num, 10);
  if (n === 0) return 'red,violet';
  if (n === 5) return 'green,violet';
  return [1, 3, 7, 9].includes(n) ? 'green' : 'red';
}

export function getSizeForNumber(num) {
  const n = parseInt(num, 10);
  return n >= 5 ? 'BIG' : 'SMALL';
}
