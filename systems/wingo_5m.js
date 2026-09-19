/**
 * ===========================================================================
 * WinGo 5-Minute System (Modular Timeframe Engine)
 * ===========================================================================
 */
(function(global) {
  'use strict';

  const WinGo5mSystem = {
    id: '5m',
    label: 'WinGo 5M',
    duration: 300, // seconds
    periodCode: '10003',
    totalPeriodsPerDay: 288,
    apiEndpoint: 'https://draw.ar-lottery01.com/WinGo/WinGo_5M/GetHistoryIssuePage.json',
    proxyPath: '/api-wingo/WinGo/WinGo_5M/GetHistoryIssuePage.json',

    /**
     * Compute current period and remaining seconds strictly in real time
     * @param {Date} [nowUtc] - UTC Date object (defaults to current UTC time)
     */
    computeRealTimeState(nowUtc, offsetSeconds = 0) {
      const now = new Date((nowUtc || new Date()).getTime() + (Number(offsetSeconds) || 0) * 1000);
      const totalSecUtc = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
      const elapsed = totalSecUtc % this.duration;
      const secsLeft = Math.max(0, (this.duration - 1) - elapsed);
      const periodIdx = Math.floor(totalSecUtc / this.duration) + 1;

      const y = now.getUTCFullYear();
      const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
      const d = String(now.getUTCDate()).padStart(2, '0');
      const periodStr = String(y) + mo + d + this.periodCode + String(periodIdx).padStart(4, '0');

      return {
        secsLeft,
        periodStr,
        periodIdx,
        duration: this.duration
      };
    },

    /**
     * Validate if an issue/period string belongs to 5m
     */
    matchesPeriod(periodStr) {
      return String(periodStr).includes(this.periodCode);
    },

    /**
     * Filter and clean history specifically for this timeframe
     */
    filterHistory(list) {
      if (!Array.isArray(list)) return [];
      return list.filter(r => !r.period || this.matchesPeriod(r.period));
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WinGo5mSystem;
  } else {
    global.WinGo5mSystem = WinGo5mSystem;
    if (!global.WIN_GO_SYSTEMS) global.WIN_GO_SYSTEMS = {};
    global.WIN_GO_SYSTEMS['5m'] = WinGo5mSystem;
  }
})(typeof window !== 'undefined' ? window : globalThis);
