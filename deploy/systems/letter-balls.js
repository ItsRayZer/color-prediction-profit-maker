/* Phase 3B letter balls — HAND-WRITTEN (not generated: scripts/gen-balls.py
 * only handles the 0–9 PNG masters). Owner order 2026-10-27: BIG gets a
 * yellow/gold ball with "B", SMALL a blue ball with "S", colours their
 * own colour with the first letter (GREEN "G", RED "R", VIOLET "V"),
 * in the same glossy game-ball design language as systems/balls.js.
 * Runtime-rendered SVG data URIs (no new PNG assets, no new pipeline):
 * the sphere is a radial gradient from a light shade (top-left) to a
 * dark shade (bottom-right) plus a white gloss highlight, with the
 * letter in bold white. The matte-panel rule does NOT apply to these
 * balls — the owner explicitly ordered game-style glossy balls.
 * Load AFTER systems/balls.js in mobile.html: this module wraps
 * window.ballImg so one call serves digits (original PNGs) and
 * letter keys (SVG spheres). Unknown keys return '' — callers MUST
 * fall back to plain text, never a blank (same contract as balls.js).
 */
(function (global) {
  'use strict';
  var LETTER_BALLS = {
    BIG: { letter: 'B', base: '#f5b301', light: '#ffd83d', dark: '#b97e00' },
    SMALL: { letter: 'S', base: '#3b82f6', light: '#60a5fa', dark: '#1d4ed8' },
    GREEN: { letter: 'G', base: '#22c55e', light: '#4ade80', dark: '#15803d' },
    RED: { letter: 'R', base: '#ef4444', light: '#f87171', dark: '#b91c1c' },
    VIOLET: { letter: 'V', base: '#8b5cf6', light: '#a78bfa', dark: '#6d28d9' }
  };

  function letterBallSvg(key) {
    var spec = LETTER_BALLS[key];
    if (!spec) return '';
    var gid = 'o101lb-' + key.toLowerCase();
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
      + '<defs><radialGradient id="' + gid + '" cx="35%" cy="30%" r="75%">'
      + '<stop offset="0%" stop-color="' + spec.light + '"/>'
      + '<stop offset="55%" stop-color="' + spec.base + '"/>'
      + '<stop offset="100%" stop-color="' + spec.dark + '"/>'
      + '</radialGradient></defs>'
      + '<circle cx="64" cy="64" r="60" fill="url(#' + gid + ')"/>'
      + '<ellipse cx="44" cy="32" rx="24" ry="13" fill="#ffffff" opacity="0.55" transform="rotate(-25 44 32)"/>'
      + '<text x="64" y="88" font-family="Arial, Helvetica, sans-serif" font-size="64" font-weight="900" fill="#ffffff" stroke="rgba(0,0,0,0.25)" stroke-width="2" text-anchor="middle">' + spec.letter + '</text>'
      + '</svg>';
  }

  function letterBallImg(key, sizePx, cls) {
    var svg = letterBallSvg(key);
    if (!svg) return '';
    var size = Number(sizePx) || 24;
    var uri = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    var clsAttr = cls ? ' ' + cls : '';
    return '<img src="' + uri + '" width="' + size + '" height="' + size + '"'
      + ' class="ball-3d rounded-full object-cover shrink-0 inline-block align-middle' + clsAttr + '"'
      + ' style="width:' + size + 'px;height:' + size + 'px;" draggable="false" alt="' + key + '" data-ball="' + key + '">';
  }

  global.letterBallImg = letterBallImg;
  global.LETTER_BALLS = LETTER_BALLS;

  // Wrap the digit ballImg from balls.js (loaded first): digits keep
  // their PNGs, letter keys render as SVG spheres. If balls.js is
  // absent, ballImg is just the letter renderer.
  if (typeof global.ballImg === 'function') {
    var origBallImg = global.ballImg;
    global.ballImg = function (key, sizePx, cls) {
      var out = origBallImg(key, sizePx, cls);
      if (out) return out;
      return letterBallImg(key, sizePx, cls);
    };
  } else {
    global.ballImg = letterBallImg;
  }
})(typeof window !== 'undefined' ? window : globalThis);
