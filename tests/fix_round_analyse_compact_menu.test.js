/**
 * Analyse page compact menu (owner order 2026-11-07) + SW update hardening.
 *
 * - On the Analyse tab ('ai') the menu (dock) stays COMPACT (slim
 *   icons-only pill); leaving Analyse restores the full menu.
 * - A hidden dock is never forced back by a tab switch; the bottom
 *   line is the only way it returns.
 * - The bottom line restores COMPACT on Analyse, full everywhere else.
 * - SW registration uses updateViaCache: 'none' so a new ship reaches
 *   the phone on the next open instead of waiting out a cached sw.js.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

const mobileSrc = fs.readFileSync(new URL('../mobile.js', import.meta.url), 'utf8');
const mobileHtml = fs.readFileSync(new URL('../mobile.html', import.meta.url), 'utf8');
const swSrc = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

describe('Analyse compact menu', () => {
  it('switching to Analyse compacts the dock', () => {
    const fn = mobileSrc.slice(mobileSrc.indexOf('function switchMobileTab(tab)'));
    const body = fn.slice(0, fn.indexOf('  // Lazy-init pattern view'));
    assert.ok(body.includes("if (tab === 'ai')"), 'Analyse branch must exist');
    assert.ok(body.includes("window._dockSetCompact(true)"), 'Analyse must compact the dock');
    assert.ok(body.includes("dockEl.classList.add('dock-compact')"), 'fallback must add dock-compact');
  });

  it('leaving Analyse restores the full menu', () => {
    const fn = mobileSrc.slice(mobileSrc.indexOf('function switchMobileTab(tab)'));
    const body = fn.slice(0, fn.indexOf('  // Lazy-init pattern view'));
    assert.ok(body.includes("window._dockSetCompact(false)"), 'leaving Analyse must expand the dock');
    assert.ok(body.includes("dockEl.classList.remove('dock-compact')"), 'fallback must remove dock-compact');
  });

  it('a hidden dock is never forced back by a tab switch', () => {
    const fn = mobileSrc.slice(mobileSrc.indexOf('function switchMobileTab(tab)'));
    const body = fn.slice(0, fn.indexOf('  // Lazy-init pattern view'));
    assert.ok(body.includes("!dockEl.classList.contains('dock-hidden')"), 'hidden dock must be left alone');
  });

  it('the bottom line restores compact on Analyse, full elsewhere', () => {
    const block = mobileSrc.slice(mobileSrc.indexOf('const restoreDock = '));
    assert.ok(block.includes("document.getElementById('tab-ai')"), 'restore must be tab-aware');
    assert.ok(block.includes('compact()'), 'restore on Analyse must compact');
    assert.ok(block.includes('else expand()'), 'restore elsewhere must expand');
    assert.ok(mobileSrc.includes("restoreHandle.addEventListener('click', restoreDock)"), 'line tap must use restoreDock');
    assert.ok(mobileSrc.includes("restoreHandle.addEventListener('pointerdown', restoreDock"), 'line pointerdown must use restoreDock');
    assert.ok(!mobileSrc.includes("restoreHandle.addEventListener('click', expand)"), 'line must not call expand directly');
  });
});

describe('SW update hardening', () => {
  it('registers the worker with updateViaCache none', () => {
    assert.ok(mobileHtml.includes("navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })"), 'registration must bypass the HTTP cache on update checks');
  });

  it('cache name matches the app build version (Round 29: was a stale v12 pin)', () => {
    // The old pin ('CACHE_NAME must be v12') went stale at the v13 ship
    // and failed the suite; the version is pinned once, in
    // O101_BUILD_VERSION, and every other test cross-checks it.
    const build = mobileSrc.match(/const O101_BUILD_VERSION = (\d+)/);
    assert.ok(build, 'mobile.js must define O101_BUILD_VERSION');
    assert.ok(swSrc.includes(`const CACHE_NAME = '0101-pwa-cache-v${build[1]}'`), 'CACHE_NAME must match O101_BUILD_VERSION');
    assert.ok(!swSrc.includes('0101-pwa-cache-v10'), 'no stale v10 reference may remain');
  });
});
