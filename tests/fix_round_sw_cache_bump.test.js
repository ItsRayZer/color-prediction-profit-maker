/**
 * Service worker cache-bump tests (owner order 2026-11-06).
 *
 * The phone kept showing the OLD app after production deployed the
 * fix: blur still there, predictions stuck, profit not updating. Root
 * cause: sw.js serves static assets cache-FIRST from its precache, so
 * an installed worker never picks up new files until its CACHE_NAME
 * changes. Bumping the name forces install -> precache fresh files ->
 * delete the old cache on activate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

const swSrc = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

describe('service worker cache bump', () => {
  it('uses the current cache name (v12, bumped 2026-11-07)', () => {
    assert.ok(swSrc.includes("const CACHE_NAME = '0101-pwa-cache-v12'"), 'CACHE_NAME must be v12');
    assert.ok(!swSrc.includes('0101-pwa-cache-v10'), 'no stale v10 reference may remain');
  });

  it('precaches the app files a bump must refresh', () => {
    for (const asset of ['/mobile.html', '/mobile.js', '/mobile.css', '/']) {
      assert.ok(swSrc.includes(`'${asset}'`), `precache must include ${asset}`);
    }
  });

  it('activate deletes every cache that is not current', () => {
    assert.ok(swSrc.includes('caches.delete(key)'), 'activate must delete old caches');
    assert.ok(swSrc.includes('key !== CACHE_NAME'), 'activate must keep only the current cache');
  });

  it('installs skip waiting so the new worker takes over', () => {
    assert.ok(swSrc.includes('skipWaiting()'), 'new worker must skip waiting');
    assert.ok(swSrc.includes('clients.claim()'), 'new worker must claim clients');
  });
});
