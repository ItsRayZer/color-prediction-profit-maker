import test from 'node:test';
import assert from 'node:assert/strict';
import { InchargeEngine, INCHARGE_MODES, wilsonLowerBound, ucb1Score, breakEvenWinRate, DEFAULT_INCHARGE_CONFIG } from '../systems/inchargeEngine.js';
import { CalibrationTracker, expectedCalibrationError } from '../systems/calibration.js';
import { evaluateSignalGate, breakEvenWinRate as gateBreakeven } from '../systems/signalGate.js';
import { BlacklistManager, assessModel } from '../systems/blacklist.js';

test('v2 InchargeEngine: Wilson ranking, floors, streak gate, UCB', async (t) => {
  await t.test('Wilson lower bound punishes small samples', () => {
    const perfect3 = wilsonLowerBound(3, 3);
    const proven = wilsonLowerBound(580, 1000);
    assert.ok(proven > perfect3, `proven 580/1000 (${proven}) must beat perfect 3/3 (${perfect3})`);
    assert.equal(wilsonLowerBound(0, 0), 0);
    assert.ok(Math.abs(breakEvenWinRate(0.96) - 0.5102) < 0.001);
  });

  await t.test('Defaults carry the v2 floors', () => {
    assert.equal(DEFAULT_INCHARGE_CONFIG.minStreak, 5);
    assert.equal(DEFAULT_INCHARGE_CONFIG.minBaseEvaluated, 200);
    assert.ok(Math.abs(DEFAULT_INCHARGE_CONFIG.minWinRate - 0.5102) < 0.001);
  });

  await t.test('Base champion is chosen by Wilson, not raw win rate', () => {
    const engine = new InchargeEngine({ mode: INCHARGE_MODES.OVERALL_WIN_RATE });
    const models = [
      { id: 'lucky', name: 'Lucky 3/3', winRate: 1.0, wins: 3, totalEvaluated: 3, streak: 0 },
      { id: 'proven', name: 'Proven 580/1000', winRate: 0.58, wins: 580, totalEvaluated: 1000, streak: 0 },
      { id: 'mid', name: 'Mid 60/100', winRate: 0.60, wins: 60, totalEvaluated: 100, streak: 0 }
    ];
    const decision = engine.evaluateIncharge(models);
    assert.equal(decision.model.id, 'proven');
  });

  await t.test('A 3-win streak no longer overrides by default; a real 5-streak with form does', () => {
    const base = { id: 'base', name: 'Base', winRate: 0.58, wins: 580, totalEvaluated: 1000, streak: 0 };
    const hot3 = { id: 'hot3', name: 'Hot3', winRate: 0.56, wins: 280, totalEvaluated: 500, streak: 3 };
    const engine = new InchargeEngine({ mode: INCHARGE_MODES.WINNING_STREAK_OVERRIDE });
    let d = engine.evaluateIncharge([base, hot3]);
    assert.equal(d.model.id, 'base');
    assert.notEqual(d.state, 'STREAK_OVERRIDE');

    const hot5 = { ...hot3, id: 'hot5', name: 'Hot5', streak: 5, recentWinRate: 0.62, recentEvaluated: 100 };
    const engine2 = new InchargeEngine({ mode: INCHARGE_MODES.WINNING_STREAK_OVERRIDE });
    d = engine2.evaluateIncharge([base, hot5]);
    assert.equal(d.state, 'STREAK_OVERRIDE');
    assert.equal(d.model.id, 'hot5');
  });

  await t.test('Streak override is blocked when recent form is below the breakeven floor', () => {
    const base = { id: 'base', name: 'Base', winRate: 0.58, wins: 580, totalEvaluated: 1000, streak: 0 };
    const fake = { id: 'fake', name: 'FakeHot', winRate: 0.52, wins: 260, totalEvaluated: 500, streak: 6, recentWinRate: 0.44, recentEvaluated: 100 };
    const engine = new InchargeEngine({ mode: INCHARGE_MODES.WINNING_STREAK_OVERRIDE });
    const d = engine.evaluateIncharge([base, fake]);
    assert.equal(d.model.id, 'base');
  });

  await t.test('Explicit minStreak config is still respected (overridable)', () => {
    const models = [
      { id: 'champ', name: 'Champ', winRate: 0.85, wins: 85, totalEvaluated: 100, streak: 1 },
      { id: 'streaker', name: 'Streaker', winRate: 0.70, wins: 35, totalEvaluated: 50, streak: 4 }
    ];
    const engine = new InchargeEngine({ mode: INCHARGE_MODES.WINNING_STREAK_OVERRIDE, minStreak: 3, minEvaluated: 10 });
    const d = engine.evaluateIncharge(models);
    assert.equal(d.state, 'STREAK_OVERRIDE');
    assert.equal(d.model.id, 'streaker');
  });

  await t.test('UCB_RANKING uses real UCB1 exploration, not plain win rate', () => {
    // Direct score check: equal win rates, the less-explored arm scores higher.
    assert.ok(ucb1Score(0.55, 20, 1020) > ucb1Score(0.55, 1000, 1020));
    assert.equal(ucb1Score(0.5, 0, 100), Infinity);

    const engine = new InchargeEngine({ mode: INCHARGE_MODES.UCB_RANKING });
    const models = [
      { id: 'exploited', name: 'Exploited', winRate: 0.56, wins: 560, totalEvaluated: 1000, streak: 0 },
      { id: 'explorer', name: 'Explorer', winRate: 0.54, wins: 11, totalEvaluated: 20, streak: 0 }
    ];
    const ranked = engine.rankModels(models);
    assert.equal(ranked[0].id, 'explorer', 'UCB bonus must lift the under-explored model');
    const d = engine.evaluateIncharge(models);
    assert.equal(d.model.id, 'explorer');
  });

  await t.test('Recency blend can lift a model whose recent form is strong', () => {
    const engine = new InchargeEngine({ mode: INCHARGE_MODES.OVERALL_WIN_RATE });
    const models = [
      { id: 'stale', name: 'Stale', winRate: 0.57, wins: 570, totalEvaluated: 1000, streak: 0, recentWinRate: 0.40, recentEvaluated: 100 },
      { id: 'fresh', name: 'Fresh', winRate: 0.56, wins: 560, totalEvaluated: 1000, streak: 0, recentWinRate: 0.72, recentEvaluated: 100 }
    ];
    const ranked = engine.rankModels(models);
    assert.equal(ranked[0].id, 'fresh');
  });

  await t.test('Blacklisted models are excluded from selection', () => {
    const engine = new InchargeEngine({ mode: INCHARGE_MODES.OVERALL_WIN_RATE });
    const models = [
      { id: 'best', name: 'Best', winRate: 0.62, wins: 620, totalEvaluated: 1000, streak: 0 },
      { id: 'second', name: 'Second', winRate: 0.57, wins: 570, totalEvaluated: 1000, streak: 0 }
    ];
    const d = engine.evaluateIncharge(models, { blacklist: new Set(['best']) });
    assert.equal(d.model.id, 'second');
    assert.equal(d.blacklistedExcluded, 1);
  });
});

test('v2 CalibrationTracker', async (t) => {
  await t.test('ECE is near zero for well calibrated predictions and high for overconfident ones', () => {
    const good = new CalibrationTracker();
    for (let i = 0; i < 100; i++) good.record(0.6, i < 60);
    assert.ok(good.expectedCalibrationError() < 0.05);
    assert.equal(good.isCalibrated(), true);

    const bad = new CalibrationTracker();
    for (let i = 0; i < 100; i++) bad.record(0.95, i < 50);
    assert.ok(bad.expectedCalibrationError() > 0.3);
    assert.equal(bad.isCalibrated(), false);
  });

  await t.test('Platt correction pulls overconfident probabilities toward reality', () => {
    const tr = new CalibrationTracker();
    for (let i = 0; i < 200; i++) tr.record(0.9, i % 2 === 0); // says 90%, wins 50%
    const corrected = tr.calibrate(0.9);
    assert.ok(corrected < 0.75, `corrected ${corrected} should be far below 0.9`);
    assert.ok(corrected > 0.25);
  });

  await t.test('Too little data is never "calibrated"', () => {
    const tr = new CalibrationTracker();
    for (let i = 0; i < 10; i++) tr.record(0.6, true);
    assert.equal(tr.isCalibrated(), false);
    assert.equal(expectedCalibrationError([{ prob: 0.5, won: true }, { prob: 0.5, won: false }]), 0);
  });

  await t.test('Buckets expose stated vs observed', () => {
    const tr = new CalibrationTracker();
    for (let i = 0; i < 50; i++) tr.record(0.55, i < 25);
    const b = tr.getBuckets().find(x => x.count > 0);
    assert.ok(b && Math.abs(b.observedRate - 0.5) < 0.001);
  });
});

test('v2 SignalGate: BET only on a real, calibrated, agreed edge', async (t) => {
  const calibrated = { isCalibrated: true, ece: 0.02, count: 300 };
  const strongModel = { id: 'm', name: 'M', totalEvaluated: 500, winRate: 0.6 };

  await t.test('BET when every check passes', () => {
    const g = evaluateSignalGate({
      pick: 'GREEN', model: strongModel, calibratedProb: 0.58,
      calibration: calibrated,
      contenders: [{ pick: 'GREEN' }, { pick: 'GREEN' }, { pick: 'GREEN' }]
    });
    assert.equal(g.decision, 'BET');
    assert.ok(Math.abs(g.breakEven - gateBreakeven(0.96)) < 1e-9);
  });

  await t.test('SKIP on thin edge below breakeven + margin', () => {
    const g = evaluateSignalGate({ pick: 'GREEN', model: strongModel, calibratedProb: 0.52, calibration: calibrated });
    assert.equal(g.decision, 'SKIP');
    assert.match(g.reason, /Edge too thin/);
  });

  await t.test('SKIP on small sample even with a big probability', () => {
    const g = evaluateSignalGate({ pick: 'GREEN', model: { id: 's', totalEvaluated: 12 }, calibratedProb: 0.9, calibration: calibrated });
    assert.equal(g.decision, 'SKIP');
    assert.match(g.reason, /Sample too small/);
  });

  await t.test('SKIP when top models disagree', () => {
    const g = evaluateSignalGate({
      pick: 'GREEN', model: strongModel, calibratedProb: 0.6, calibration: calibrated,
      contenders: [{ pick: 'GREEN' }, { pick: 'RED' }, { pick: 'GREEN' }]
    });
    assert.equal(g.decision, 'SKIP');
    assert.match(g.reason, /disagree/);
  });

  await t.test('SKIP when confidence is uncalibrated or missing', () => {
    let g = evaluateSignalGate({ pick: 'GREEN', model: strongModel, calibratedProb: 0.6, calibration: { isCalibrated: false, ece: 0.4, count: 300 } });
    assert.equal(g.decision, 'SKIP');
    assert.match(g.reason, /uncalibrated/);
    g = evaluateSignalGate({ pick: 'GREEN', model: strongModel, calibratedProb: 0.6 });
    assert.equal(g.decision, 'SKIP');
  });

  await t.test('SKIP when there is no pick at all', () => {
    const g = evaluateSignalGate({ model: strongModel, calibration: calibrated });
    assert.equal(g.decision, 'SKIP');
  });

  await t.test('Agreement check ignores blacklisted contenders supplied by the caller', () => {
    const mgr = new BlacklistManager();
    const badModel = { id: 'bad', name: 'Bad', winRate: 0.40, wins: 400, totalEvaluated: 1000 };
    mgr.update([badModel]);
    assert.equal(mgr.isBlacklisted('bad'), true);
    const contenders = mgr.filterEligible([{ id: 'a', pick: 'GREEN' }, { id: 'bad', pick: 'RED' }, { id: 'c', pick: 'GREEN' }]);
    const g = evaluateSignalGate({ pick: 'GREEN', model: strongModel, calibratedProb: 0.58, calibration: calibrated, contenders });
    assert.equal(g.decision, 'BET');
  });
});

test('v2 Blacklist: trigger, exclusion, shadow reinstatement', async (t) => {
  await t.test('Floor breach after min sample blacklists; small samples do not', () => {
    const weak = { id: 'weak', name: 'Weak', winRate: 0.47, wins: 470, totalEvaluated: 1000 };
    const a = assessModel(weak);
    assert.equal(a.status, 'BLACKLISTED');
    assert.ok(a.wilson < a.floor);

    const young = { id: 'young', name: 'Young', winRate: 0.40, wins: 40, totalEvaluated: 100 };
    assert.equal(assessModel(young).status, 'ACTIVE');

    const strong = { id: 'strong', name: 'Strong', winRate: 0.60, wins: 600, totalEvaluated: 1000 };
    assert.equal(assessModel(strong).status, 'ACTIVE');
  });

  await t.test('Recent-form collapse blacklists even with a decent overall record', () => {
    const fading = { id: 'fade', name: 'Fading', winRate: 0.58, wins: 580, totalEvaluated: 1000, recentWinRate: 0.40, recentEvaluated: 100 };
    const a = assessModel(fading);
    assert.equal(a.status, 'BLACKLISTED');
    assert.match(a.reasons.join(' '), /Recent-form collapse/);
  });

  await t.test('Manager lists reasons/samples and filters pools', () => {
    const mgr = new BlacklistManager();
    const weak = { id: 'weak', name: 'Weak', winRate: 0.47, wins: 470, totalEvaluated: 1000 };
    const strong = { id: 'strong', name: 'Strong', winRate: 0.60, wins: 600, totalEvaluated: 1000 };
    const res = mgr.update([weak, strong]);
    assert.equal(res.blacklisted.length, 1);
    const entry = mgr.list()[0];
    assert.equal(entry.id, 'weak');
    assert.equal(entry.samples, 1000);
    assert.ok(entry.reason.length > 10);
    assert.ok(entry.shadowStatus.includes('Shadow'));
    assert.deepEqual(mgr.filterEligible([weak, strong]).map(m => m.id), ['strong']);
  });

  await t.test('Reinstatement when live shadow-updated stats recover', () => {
    const mgr = new BlacklistManager();
    const weak = { id: 'weak', name: 'Weak', winRate: 0.47, wins: 470, totalEvaluated: 1000 };
    mgr.update([weak]);
    assert.equal(mgr.isBlacklisted('weak'), true);
    // Shadow evaluation keeps running; the model's combined record recovers.
    const recovered = { id: 'weak', name: 'Weak', winRate: 0.56, wins: 1400, totalEvaluated: 2500, recentWinRate: 0.58, recentEvaluated: 100 };
    const res = mgr.update([recovered]);
    assert.equal(mgr.isBlacklisted('weak'), false);
    assert.ok(res.reinstated.includes('weak'));
  });

  await t.test('Reinstatement via recorded shadow results alone', () => {
    const mgr = new BlacklistManager();
    const borderline = { id: 'edge', name: 'Edge', winRate: 0.50, wins: 100, totalEvaluated: 200 };
    mgr.update([borderline]);
    assert.equal(mgr.isBlacklisted('edge'), true);
    // Baseline Wilson (100/200) is just under the floor; a long winning
    // shadow run must push the combined bound over it.
    let reinstated = false;
    for (let i = 0; i < 400 && !reinstated; i++) reinstated = mgr.recordShadowResult('edge', true);
    assert.equal(reinstated, true);
    assert.equal(mgr.isBlacklisted('edge'), false);
  });
});
