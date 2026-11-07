/**
 * Analyse-page fake-data fixes (owner order 2026-11-07).
 *
 * The owner's 01:37 screenshots showed:
 *  - History "AI TARGET & RESULT" all dashes while a live signal existed.
 *  - Leaderboard "WR: no data (20W/7L)" and a streak-sorted ranking.
 *  - Leaderboard #1 (Bayesian) different from the hero in-charge (Hebbian).
 *  - "Session 0%" as a hardcoded label, accuracy 0/0/0, digit frequency
 *    labelled "Last 100 Rounds" over 10 draws.
 *  - A tap in the DhaniWin area only compacted the dock instead of
 *    fully hiding top + bottom.
 *
 * Each test below pins the exact code fix for one of those.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

const mobileJs = fs.readFileSync(new URL('../mobile.js', import.meta.url), 'utf8');
const mobileHtml = fs.readFileSync(new URL('../mobile.html', import.meta.url), 'utf8');

describe('history verdict survives the fetch tick', () => {
  it('assigns the new list BEFORE settling, so the stamp lands in the live list', () => {
    const fnStart = mobileJs.indexOf('async function fetchLiveAPIResults(tfOverride)');
    assert.ok(fnStart !== -1, 'fetchLiveAPIResults must exist');
    // Window covers the persisted-verdict loader + map + assign + settle.
    // (Grew 12000 -> 14000 when the settled-verdict restoration was added.)
    const body = mobileJs.slice(fnStart, fnStart + 14000);
    const assignAt = body.indexOf('MobileState.historyByTf[tf] = processedList;');
    const settleAt = body.indexOf('settleRoundOutcome(');
    assert.ok(assignAt !== -1, 'list assignment must exist in the fetch');
    assert.ok(settleAt !== -1, 'settlement call must exist in the fetch');
    assert.ok(assignAt < settleAt, 'assignment must come before settlement (else the stamp is thrown away)');
  });
});

describe('leaderboard reads one record, not two', () => {
  it('session branch sets sessionEvaluated/sessionWins from the session map', () => {
    const branchStart = mobileJs.indexOf('if (isUserReset) {', mobileJs.indexOf('function getEffectiveModelList'));
    assert.ok(branchStart !== -1, 'session branch must exist');
    const body = mobileJs.slice(branchStart, branchStart + 2500);
    assert.ok(body.includes('sessionEvaluated: totalEvaluated'), 'WR gate must read the session-map total');
    assert.ok(body.includes('sessionWins: wins'), 'WR gate must read the session-map wins');
  });

  it('session streak prefers the worker live sessionStreak', () => {
    const branchStart = mobileJs.indexOf('if (isUserReset) {', mobileJs.indexOf('function getEffectiveModelList'));
    const body = mobileJs.slice(branchStart, branchStart + 2500);
    assert.ok(body.includes('localM.sessionStreak'), 'session streak must come from the live session counter');
  });

  it('IN CHARGE badge follows the governed verdict driver', () => {
    const fnStart = mobileJs.indexOf('function renderModelRosterUI()');
    assert.ok(fnStart !== -1, 'renderModelRosterUI must exist');
    const body = mobileJs.slice(fnStart, fnStart + 12000);
    assert.ok(body.includes('window.__o101Verdict.driverName'), 'badge must read the governed verdict driver');
    assert.ok(body.includes('effectiveInCharge = window.__o101Verdict.driverName'), 'verdict driver must win the badge');
  });

  it('no hardcoded Session/Reset percent labels', () => {
    assert.ok(!mobileJs.includes('Session 0%'), 'Session 0% must not be hardcoded');
    assert.ok(!mobileJs.includes('Reset 0%'), 'Reset 0% must not be hardcoded');
    assert.ok(!mobileHtml.includes('Reset 0%'), 'static Reset 0% must be gone');
    const fnStart = mobileJs.indexOf('function renderModelRosterUI()');
    const body = mobileJs.slice(fnStart, fnStart + 4000);
    assert.ok(body.includes('sessVerdicts'), 'session label must be computed from settled verdicts');
  });

  it('Game pill counts game_theory models (not 0)', () => {
    const fnStart = mobileJs.indexOf('function renderModelRosterUI()');
    const body = mobileJs.slice(fnStart, fnStart + 12000);
    assert.ok(body.includes("catCounts['game_theory']"), 'Game count must include game_theory models');
  });

  it('static category pills show true catalog counts (first paint)', () => {
    for (const [label, count] of [['All', 142], ['Fly', 18], ['Neural', 16], ['Classical', 19], ['Signal', 15], ['Chaos', 13], ['Game', 13], ['Pattern', 14], ['Quantum', 9], ['Meta', 10], ['Statistical', 12]]) {
      assert.ok(mobileHtml.includes(`${label} (${count})`), `static pill must say ${label} (${count})`);
    }
    assert.ok(!mobileHtml.includes('All (101)'), 'stale All (101) must be gone');
  });
});

describe('accuracy counts the governed signal', () => {
  it('renderPredictionAudit counts verdictPick/verdictCorrect, not TimeframeManager stats', () => {
    const fnStart = mobileJs.indexOf('function renderPredictionAudit(list)');
    assert.ok(fnStart !== -1, 'renderPredictionAudit must exist');
    const body = mobileJs.slice(fnStart, fnStart + 2500);
    assert.ok(body.includes('r.verdictPick'), 'accuracy must count governed verdict picks');
    assert.ok(body.includes('r.verdictCorrect'), 'accuracy must count governed verdict outcomes');
    assert.ok(!body.includes('TimeframeManager.getStats'), 'accuracy must not read native-prediction stats');
  });
});

describe('digit frequency label is honest', () => {
  it('says Last 10 Draws, never Last 100 Rounds', () => {
    assert.ok(mobileHtml.includes('Last 10 Draws'), 'label must say Last 10 Draws');
    assert.ok(!mobileHtml.includes('Last 100 Rounds'), 'Last 100 Rounds must be gone');
  });
});

describe('hide chrome fully on a game-area tap', () => {
  it('shield tap path fully hides chrome (not compact)', () => {
    const shieldStart = mobileJs.indexOf('High-Fidelity Touch Shield');
    assert.ok(shieldStart !== -1, 'shield section must exist');
    const body = mobileJs.slice(shieldStart, shieldStart + 6000);
    assert.ok(body.includes('hideChrome();'), 'shield tap must fully hide chrome');
    const upStart = body.indexOf('const onShieldUp');
    assert.ok(upStart !== -1, 'onShieldUp must exist');
    assert.ok(body.slice(upStart, upStart + 700).includes('hideChrome()'), 'clean tap must hide chrome fully');
  });

  it('window blur on the web tab hides chrome (tap inside the cross-origin frame)', () => {
    assert.ok(mobileJs.includes("window.addEventListener('blur'"), 'blur listener must exist');
    const blurAt = mobileJs.indexOf("window.addEventListener('blur'");
    const body = mobileJs.slice(blurAt, blurAt + 600);
    assert.ok(body.includes("tab-web"), 'blur hide must be web-tab only');
    assert.ok(body.includes('hideChrome()'), 'blur must hide chrome');
  });

  it('both restore lines exist', () => {
    assert.ok(mobileHtml.includes('id="dockRestoreHandle"'), 'bottom restore line must exist');
    assert.ok(mobileHtml.includes('id="homeHeaderPullHandle"'), 'top restore line must exist');
  });
});
