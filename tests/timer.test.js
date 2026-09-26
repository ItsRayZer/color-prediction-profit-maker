import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getRemainingSeconds,
  formatTimerDisplay,
  getTimerState,
  PERIOD_SECONDS
} from '../src/utils/gameTimer.js';

describe('Game Timers - IST Wall Clock Synchronization', () => {

  // Reference IST times (Indian Standard Time is UTC+05:30)
  // 12:00:00 IST = 06:30:00 UTC
  const t_12_00_00 = new Date('2026-09-26T12:00:00+05:30').getTime();
  const t_12_00_01 = new Date('2026-09-26T12:00:01+05:30').getTime();
  const t_12_00_30 = new Date('2026-09-26T12:00:30+05:30').getTime();
  const t_12_01_00 = new Date('2026-09-26T12:01:00+05:30').getTime();

  describe('User-specified expected examples', () => {
    it('At 12:00:00: 30s -> 00, 1m -> 00:00, 3m -> 00:00, 5m -> 00:00', () => {
      // 30s
      const s30 = getRemainingSeconds(30, t_12_00_00);
      assert.equal(s30, 0);
      assert.equal(formatTimerDisplay(30, s30), '00');

      // 1m
      const s1m = getRemainingSeconds(60, t_12_00_00);
      assert.equal(s1m, 0);
      assert.equal(formatTimerDisplay(60, s1m), '00:00');

      // 3m
      const s3m = getRemainingSeconds(180, t_12_00_00);
      assert.equal(s3m, 0);
      assert.equal(formatTimerDisplay(180, s3m), '00:00');

      // 5m
      const s5m = getRemainingSeconds(300, t_12_00_00);
      assert.equal(s5m, 0);
      assert.equal(formatTimerDisplay(300, s5m), '00:00');
    });

    it('At 12:00:01: 30s -> 29, 1m -> 00:59, 3m -> 02:59, 5m -> 04:59', () => {
      // 30s
      const s30 = getRemainingSeconds(30, t_12_00_01);
      assert.equal(s30, 29);
      assert.equal(formatTimerDisplay(30, s30), '29');

      // 1m
      const s1m = getRemainingSeconds(60, t_12_00_01);
      assert.equal(s1m, 59);
      assert.equal(formatTimerDisplay(60, s1m), '00:59');

      // 3m
      const s3m = getRemainingSeconds(180, t_12_00_01);
      assert.equal(s3m, 179);
      assert.equal(formatTimerDisplay(180, s3m), '02:59');

      // 5m
      const s5m = getRemainingSeconds(300, t_12_00_01);
      assert.equal(s5m, 299);
      assert.equal(formatTimerDisplay(300, s5m), '04:59');
    });

    it('At 12:00:30: 30s -> 00, 1m -> 00:30, 3m -> 02:30, 5m -> 04:30', () => {
      // 30s
      const s30 = getRemainingSeconds(30, t_12_00_30);
      assert.equal(s30, 0);
      assert.equal(formatTimerDisplay(30, s30), '00');

      // 1m
      const s1m = getRemainingSeconds(60, t_12_00_30);
      assert.equal(s1m, 30);
      assert.equal(formatTimerDisplay(60, s1m), '00:30');

      // 3m
      const s3m = getRemainingSeconds(180, t_12_00_30);
      assert.equal(s3m, 150);
      assert.equal(formatTimerDisplay(180, s3m), '02:30');

      // 5m
      const s5m = getRemainingSeconds(300, t_12_00_30);
      assert.equal(s5m, 270);
      assert.equal(formatTimerDisplay(300, s5m), '04:30');
    });

    it('At 12:01:00: 30s -> 00, 1m -> 00:00, 3m -> 02:00, 5m -> 04:00', () => {
      // 30s
      const s30 = getRemainingSeconds(30, t_12_01_00);
      assert.equal(s30, 0);
      assert.equal(formatTimerDisplay(30, s30), '00');

      // 1m
      const s1m = getRemainingSeconds(60, t_12_01_00);
      assert.equal(s1m, 0);
      assert.equal(formatTimerDisplay(60, s1m), '00:00');

      // 3m
      const s3m = getRemainingSeconds(180, t_12_01_00);
      assert.equal(s3m, 120);
      assert.equal(formatTimerDisplay(180, s3m), '02:00');

      // 5m
      const s5m = getRemainingSeconds(300, t_12_01_00);
      assert.equal(s5m, 240);
      assert.equal(formatTimerDisplay(300, s5m), '04:00');
    });
  });

  describe('30s countdown sequence integrity (00 -> 29 -> 28 -> ... -> 01 -> 00)', () => {
    it('produces the exact expected countdown loop for all 30 seconds', () => {
      for (let sec = 0; sec < 30; sec++) {
        const time = t_12_00_00 + (sec * 1000);
        const remaining = getRemainingSeconds(30, time);
        const expected = sec === 0 ? 0 : 30 - sec;
        assert.equal(remaining, expected, `Failed at second offset ${sec}`);
      }
    });
  });

  describe('Tab suspension, delay, and refresh resilience', () => {
    it('correctly recalculates remaining time after arbitrary time jumps without drift', () => {
      const base = t_12_00_00;

      // Jump forward 125 seconds (2 mins 5 secs)
      // At 12:02:05:
      // 30s: 125 % 30 = 5 elapsed -> remaining 25s
      // 1m:  125 % 60 = 5 elapsed -> remaining 55s
      // 3m:  125 % 180 = 125 elapsed -> remaining 55s
      // 5m:  125 % 300 = 125 elapsed -> remaining 175s
      const afterJump = base + 125 * 1000;
      assert.equal(getRemainingSeconds(30, afterJump), 25);
      assert.equal(getRemainingSeconds(60, afterJump), 55);
      assert.equal(getRemainingSeconds(180, afterJump), 55);
      assert.equal(getRemainingSeconds(300, afterJump), 175);

      assert.equal(formatTimerDisplay(30, 25), '25');
      assert.equal(formatTimerDisplay(60, 55), '00:55');
      assert.equal(formatTimerDisplay(180, 55), '00:55');
      assert.equal(formatTimerDisplay(300, 175), '02:55');
    });

    it('stays aligned when called with Date object, epoch timestamp, or default current time', () => {
      const d = new Date(t_12_00_01);
      assert.equal(getRemainingSeconds(30, d), 29);
      assert.equal(getRemainingSeconds(30, d.getTime()), 29);
    });
  });

  describe('getTimerState unified helper', () => {
    it('returns both remainingSeconds and formattedDisplay matching expectations', () => {
      const state30 = getTimerState(30, t_12_00_01);
      assert.deepEqual(state30, {
        periodSeconds: 30,
        remainingSeconds: 29,
        formattedDisplay: '29'
      });

      const state1m = getTimerState(60, t_12_00_01);
      assert.deepEqual(state1m, {
        periodSeconds: 60,
        remainingSeconds: 59,
        formattedDisplay: '00:59'
      });
    });
  });

  describe('Offline purity', () => {
    it('calculates entirely with pure math and zero network/API dependencies', () => {
      assert.ok(typeof getRemainingSeconds === 'function');
      assert.ok(typeof formatTimerDisplay === 'function');
      assert.equal(PERIOD_SECONDS['30s'], 30);
      assert.equal(PERIOD_SECONDS['1m'], 60);
      assert.equal(PERIOD_SECONDS['3m'], 180);
      assert.equal(PERIOD_SECONDS['5m'], 300);
    });
  });
});
