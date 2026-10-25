/**
 * DhaniWin transport helpers (pure — no DOM, no storage, no network).
 * ================================================================
 * The login/balance bridge (dhaniwin-bridge.js) only runs inside the
 * DhaniWin page when that page is served through the Cloudflare edge
 * proxy: the worker appends <script src="/dhaniwin-bridge.js"> to
 * proxied HTML. Loading DhaniWin DIRECTLY therefore means no bridge
 * ever runs — no API-proven user state, no verified login, no exact
 * balance. These helpers rewrite the app's built-in DhaniWin URLs
 * onto the worker and classify a URL's transport so the app can stay
 * honest about which route is in use.
 *
 * Round 3 — ROOT-SERVING: the DhaniWin SPA's route table is
 * root-absolute (/, /login, /main, /wallet/recharge, … with a
 * catch-all redirecting to /404), so a prefixed document path can
 * never match a route and renders the empty router view. Proxified
 * URLs are therefore WORKER-ROOT URLs (worker host + DhaniWin path,
 * no prefix). Legacy prefixed URLs still unproxify and still count
 * as proxy transport, and the worker 302s legacy prefixed DOCUMENT
 * navigations to root — so no stored URL breaks.
 *
 * PIVOT (direct default): the proxy path is abandoned — the game
 * frame loads DhaniWin DIRECTLY and the APK injects the bridge
 * natively into the frame. proxifyDhaniUrl is kept ONLY for the
 * explicit proxy override (mobile.js: dhaniFrameUseProxy) and for
 * legacy stored URLs; NOTHING in the default path calls it anymore.
 * The origin allowlist below is the cross-origin message boundary:
 * the app accepts bridge state ONLY from these DhaniWin origins
 * (plus its own origin, checked by the caller) — never '*'.
 *
 * Loaded as a classic script before mobile.js (window.DhaniTransport)
 * and unit-tested in Node via vm (same pattern as systems/balls.js).
 */
(function (global) {
  'use strict';

  var DHANIWIN_ORIGIN = 'https://dhaniwin44.com';
  // DhaniWin family origins (worker FAMILY_HOSTS, as origins): the
  // ONLY cross-origin senders the app accepts bridge state from.
  // Exact match — a look-alike host (dhaniwin44.com.evil.com) or a
  // different scheme (http) never matches. Kept in sync with the
  // duplicate list in systems/orb-bridge.js (same rule, module
  // load-order safe) — update both together.
  var DHANIWIN_FAMILY_ORIGINS = [
    'https://dhaniwin44.com',
    'https://dhaniwin.99.com',
    'https://dhaniwin99.com',
    'https://dhaniwin0.com',
    'https://dhaniwin2.com'
  ];

  function isDhaniwinOrigin(origin) {
    if (typeof origin !== 'string') return false;
    for (var i = 0; i < DHANIWIN_FAMILY_ORIGINS.length; i++) {
      if (origin === DHANIWIN_FAMILY_ORIGINS[i]) return true;
    }
    return false;
  }
  // Legacy prefix only: kept exported so old stored URLs (and the
  // worker's legacy-document redirect) keep working. NEW proxified
  // URLs never use it — they are worker-root URLs (round 3).
  var PROXY_PATH = '/proxy/dhaniwin';

  function isOriginBoundary(ch) {
    return ch === undefined || ch === '/' || ch === '?' || ch === '#';
  }

  // Exact-segment test for a worker-root path exclusion: '/o101x'
  // is NOT the app route, '/apix' is NOT the results API.
  function isExcludedRootPath(rest) {
    return rest === '/o101' || rest.indexOf('/o101/') === 0
      || rest === '/proxy/dhaniapi' || rest.indexOf('/proxy/dhaniapi/') === 0
      || rest === '/api' || rest.indexOf('/api/') === 0;
  }

  /**
   * Rewrite a built-in DhaniWin URL onto the worker at its ROOT.
   * Only URLs on the DhaniWin origin itself are rewritten — any other
   * URL (including user-customised entry URLs on mirror domains, and
   * URLs already on the worker) is returned untouched.
   */
  function proxifyDhaniUrl(url, workerBase) {
    if (typeof url !== 'string' || typeof workerBase !== 'string' || !workerBase) return url;
    var base = workerBase.replace(/\/+$/, '');
    if (url === DHANIWIN_ORIGIN) return base + '/';
    if (url.indexOf(DHANIWIN_ORIGIN) === 0 && isOriginBoundary(url.charAt(DHANIWIN_ORIGIN.length))) {
      return base + url.slice(DHANIWIN_ORIGIN.length);
    }
    return url;
  }

  /** Inverse of proxifyDhaniUrl (used by the load-failure fallback).
   * Worker-root DhaniWin URLs map back to the DhaniWin origin, EXCEPT
   * the app route (/o101/), the API route (/proxy/dhaniapi/) and the
   * results API (/api/), which are worker-native and returned
   * unchanged. Legacy prefixed URLs map back the same way. */
  function unproxifyDhaniUrl(url, workerBase) {
    if (typeof url !== 'string' || typeof workerBase !== 'string' || !workerBase) return url;
    var base = workerBase.replace(/\/+$/, '');
    var prefix = base + PROXY_PATH;
    if (url === prefix || url === prefix + '/') return DHANIWIN_ORIGIN + '/';
    if (url.indexOf(prefix) === 0 && isOriginBoundary(url.charAt(prefix.length))) {
      return DHANIWIN_ORIGIN + url.slice(prefix.length);
    }
    if (url === base) return DHANIWIN_ORIGIN + '/';
    if (url.indexOf(base) === 0 && isOriginBoundary(url.charAt(base.length))) {
      var rest = url.slice(base.length);
      if (isExcludedRootPath(rest)) return url;
      return DHANIWIN_ORIGIN + rest;
    }
    return url;
  }

  /** 'proxy' when the URL rides the worker (root or legacy prefixed
   * form), else 'direct'. Worker-native routes (/o101/, the API
   * route, /api/) are never a DhaniWin frame load. */
  function dhaniTransportForUrl(url, workerBase) {
    if (typeof url !== 'string' || typeof workerBase !== 'string' || !workerBase) return 'direct';
    var base = workerBase.replace(/\/+$/, '');
    if (url === base) return 'proxy';
    if (url.indexOf(base) !== 0 || !isOriginBoundary(url.charAt(base.length))) return 'direct';
    var rest = url.slice(base.length);
    if (isExcludedRootPath(rest)) return 'direct';
    return 'proxy';
  }

  var api = {
    DHANIWIN_ORIGIN: DHANIWIN_ORIGIN,
    DHANIWIN_FAMILY_ORIGINS: DHANIWIN_FAMILY_ORIGINS,
    isDhaniwinOrigin: isDhaniwinOrigin,
    PROXY_PATH: PROXY_PATH,
    proxifyDhaniUrl: proxifyDhaniUrl,
    unproxifyDhaniUrl: unproxifyDhaniUrl,
    dhaniTransportForUrl: dhaniTransportForUrl
  };

  global.DhaniTransport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
