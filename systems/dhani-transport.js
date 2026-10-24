/**
 * DhaniWin transport helpers (pure — no DOM, no storage, no network).
 * ================================================================
 * The login/balance bridge (dhaniwin-bridge.js) only runs inside the
 * DhaniWin page when that page is served through the Cloudflare edge
 * proxy: the worker (cloudflare-worker/worker.js) appends
 * <script src="/dhaniwin-bridge.js"> to proxied HTML on the
 * /proxy/dhaniwin route. Loading DhaniWin DIRECTLY therefore means no
 * bridge ever runs — no API-proven user state, no verified login, no
 * exact balance. These helpers rewrite the app's built-in DhaniWin
 * URLs onto the proxy route and classify a URL's transport so the app
 * can stay honest about which route is in use.
 *
 * Loaded as a classic script before mobile.js (window.DhaniTransport)
 * and unit-tested in Node via vm (same pattern as systems/balls.js).
 */
(function (global) {
  'use strict';

  var DHANIWIN_ORIGIN = 'https://dhaniwin44.com';
  var PROXY_PATH = '/proxy/dhaniwin';

  function isOriginBoundary(ch) {
    return ch === undefined || ch === '/' || ch === '?' || ch === '#';
  }

  /**
   * Rewrite a built-in DhaniWin URL onto the worker proxy route.
   * Only URLs on the DhaniWin origin itself are rewritten — any other
   * URL (including user-customised entry URLs on mirror domains) is
   * returned untouched.
   */
  function proxifyDhaniUrl(url, workerBase) {
    if (typeof url !== 'string' || typeof workerBase !== 'string' || !workerBase) return url;
    if (url === DHANIWIN_ORIGIN) return workerBase + PROXY_PATH + '/';
    if (url.indexOf(DHANIWIN_ORIGIN) === 0 && isOriginBoundary(url.charAt(DHANIWIN_ORIGIN.length))) {
      return workerBase + PROXY_PATH + url.slice(DHANIWIN_ORIGIN.length);
    }
    return url;
  }

  /** Inverse of proxifyDhaniUrl (used by the load-failure fallback). */
  function unproxifyDhaniUrl(url, workerBase) {
    if (typeof url !== 'string' || typeof workerBase !== 'string' || !workerBase) return url;
    var prefix = workerBase + PROXY_PATH;
    if (url === prefix || url === prefix + '/') return DHANIWIN_ORIGIN + '/';
    if (url.indexOf(prefix) === 0 && isOriginBoundary(url.charAt(prefix.length))) {
      return DHANIWIN_ORIGIN + url.slice(prefix.length);
    }
    return url;
  }

  /** 'proxy' when the URL rides the worker proxy route, else 'direct'. */
  function dhaniTransportForUrl(url, workerBase) {
    if (typeof url !== 'string' || typeof workerBase !== 'string' || !workerBase) return 'direct';
    return url.indexOf(workerBase + PROXY_PATH) === 0 ? 'proxy' : 'direct';
  }

  var api = {
    DHANIWIN_ORIGIN: DHANIWIN_ORIGIN,
    PROXY_PATH: PROXY_PATH,
    proxifyDhaniUrl: proxifyDhaniUrl,
    unproxifyDhaniUrl: unproxifyDhaniUrl,
    dhaniTransportForUrl: dhaniTransportForUrl
  };

  global.DhaniTransport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
