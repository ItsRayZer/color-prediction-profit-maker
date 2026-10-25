// ==UserScript==
// @name         DhaniWin Quant AI Live Scraper & Auto-Bet Bridge
// @namespace    https://dhaniwin.99.com/
// @version      3.3
// @description  Scrapes live WinGo draws, auto-navigates to WinGo, and pre-selects bet amount & target color/size from Quant AI. v3.3: one-time Tampermonkey install — auto-runs on DhaniWin pages with NO per-session tap and NO second tab. It runs inside the 01.01 app's own DhaniWin iframe too (no @noframes BY DESIGN: the iframe is how the app and the bridge talk — state up via parent postMessage, orders down via the iframe window). v3.2: publishes an API-proven user state (login + exact balance) on channel/postMessage and actively re-queries the learned wallet endpoint with the live session. NOTE: the bridge also attempts an RTDB publish, but live RTDB rules currently deny even reads (proven 2026-10-25), so postMessage through the app's iframe window is the working transport — never RTDB.
// @match        *://*.dhaniwin44.com/*
// @match        *://*.dhaniwin.99.com/*
// @match        *://*.dhaniwin99.com/*
// @match        *://*.dhaniwin0.com/*
// @match        *://*.dhaniwin2.com/*
// @match        *://*dhaniwin*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
// INSTALL (one time, then fully automatic — no bookmarklet tap, no second
// DhaniWin tab, no second login):
//   1. Install Tampermonkey (Firefox for Android, or Kiwi Browser —
//      Brave for Android does not run userscript extensions).
//   2. In Tampermonkey, install from URL: <this app's origin>/dhaniwin-bridge.user.js
//      (the same file, served with the .user.js name Tampermonkey detects;
//      Tampermonkey checks that same URL for updates, so no @updateURL is needed).
//   3. Open the 01.01 app and switch to the DhaniWin tab. The script
//      auto-runs inside the app's DhaniWin iframe, the bridge HUD shows
//      "Bridge Active", and the app shows VERIFIED + exact balance.
//      Orders travel back down through the same iframe window, so
//      Auto-Pilot staging + firing works from the one tab.
// ROTATED DOMAINS: the @match list covers the dhaniwin family, including
// any host containing "dhaniwin". If DhaniWin rotates to a hostname with
// NO "dhaniwin" in it, the script stops matching: add one line
//   // @match  *://<the-new-host>/*
// and reinstall. The bridge itself never changes for a rotation.
// SECURITY (unchanged): the bridge reads DhaniWin's own APIs with the
// page's own session (same-origin, like the page itself) and relays ONLY
// the 7 state fields. It NEVER publishes, logs, or stores any raw cookie,
// token, API key, or session value — only a boolean "token present" flag.
(function() {
  'use strict';
  // Idempotence guard: the bridge must never run twice on one page
  // (bookmarklet tap + userscript, or a double tap, would otherwise
  // double every interval/listener). A second load is a no-op.
  if (window.__o101BridgeLoaded) return;
  window.__o101BridgeLoaded = true;
  console.log('%c[Quant AI Bridge] 🚀 Initializing DhaniWin Real Auto-Betting Engine v3.1...', 'color:#10b981;font-weight:bold;font-size:13px;');

  const channel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('dhaniwin_quant_channel') : null;
  let activeTimeframe = '30s';
  let lastDispatchedPeriod = null;
  const processingPeriods = new Set();
  let configuredStake = 2;
  let configuredMaxStake = 64;
  let hasAppBetSettings = false;
  let _justLoggedInGrace = 0;
  let _lastScrapedBalance = null;

  // Native fetch captured BEFORE the interception hook below replaces
  // window.fetch. The bridge's own calls (RTDB publish, active wallet
  // re-query) use this so they never intercept themselves.
  const _nativeFetch = (typeof window !== 'undefined' && typeof window.fetch === 'function')
    ? window.fetch.bind(window) : null;
  const RTDB_BASE_URL = 'https://zer0one-376d1-default-rtdb.asia-southeast1.firebasedatabase.app';
  const LEARNED_ENDPOINT_KEY = 'o101_learned_wallet_endpoint_v1';

  // [O101-STATE-CORE-BEGIN]
  // ── User State core (PURE — no DOM, no storage, no network) ────────
  // The bridge is the only component that can see the real DhaniWin
  // account, so it is the only truth source for login + balance.
  // Login proof rule: a session token present in page storage AND an
  // authenticated wallet/user API payload that actually succeeded.
  // A token alone is NOT proof; a number scraped off the page is NOT
  // an exact balance. Balances keep their provenance: 'api' (from the
  // site's own authenticated API payload — the exact figure) vs 'dom'
  // (scraped from the page, labelled "from page"). The session token
  // itself is NEVER part of the built state.
  function extractUserIdFromJson(data, depth = 0) {
    if (!data || typeof data !== 'object' || depth > 3) return null;
    // Round 3: bare `id` is NOT an identity key — every object has
    // an id (round ids, bet ids, period ids), so an id-only payload
    // must not verify a login. Real user keys (userid, uid,
    // memberid, …) still count, and a payload with a real userId
    // and no balance still proves login (balance unknown, never 0).
    const idKeys = ['userid', 'user_id', 'uid', 'memberid', 'member_id', 'tenantaccount', 'accountid'];
    for (const k of Object.keys(data)) {
      const lk = k.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (idKeys.includes(lk)) {
        const v = data[k];
        if (typeof v === 'number' && Number.isFinite(v)) return String(v);
        if (typeof v === 'string' && v.trim() !== '' && v.length <= 32) return v.trim();
      }
    }
    const subKeys = ['data', 'result', 'payload', 'body', 'userInfo', 'user_info', 'user', 'member', 'account'];
    for (const sk of subKeys) {
      if (data[sk] && typeof data[sk] === 'object') {
        const nested = extractUserIdFromJson(data[sk], depth + 1);
        if (nested !== null) return nested;
      }
    }
    return null;
  }

  // Decide how the session token rides on a balance-bearing request,
  // from the request's own headers (list of [name, value] pairs as the
  // page itself sent them). Only the header NAME and scheme are kept —
  // never the token value.
  function detectTokenAttachment(headerPairs) {
    const pairs = Array.isArray(headerPairs) ? headerPairs : [];
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const name = String(pair[0] || '');
      const value = String(pair[1] || '');
      const ln = name.toLowerCase();
      if (ln === 'authorization' || ln === 'x-token' || ln === 'access-token' || ln === 'auth-token' || ln === 'token' || ln.includes('auth') || ln.includes('token')) {
        return { mode: 'header', headerName: name, scheme: /^bearer\s/i.test(value) ? 'Bearer' : '' };
      }
    }
    return { mode: 'cookie' };
  }

  function createUserStateTracker() {
    const t = {
      tokenPresent: false,
      onAuthPage: false,
      apiProven: false,
      lastProofAt: null,       // last authenticated API payload (intercept or active)
      apiBalance: null,
      apiBalanceAt: null,
      domBalance: null,
      domBalanceAt: null,
      userId: null,
      endpoint: null,          // learned balance-bearing request descriptor (no token value)
      pollAuthFailed: false,   // active re-query got 401/403/auth-error
      pollEmptyCount: 0,       // consecutive active re-queries with no balance in payload
      explicitLogoutAt: null,
      graceActive: false,      // bridge post-login grace is active (set by the scrape each tick): while true, a transient auth-page view must not downgrade the state (Fix 5e)
      createdAt: Date.now(),   // bridge-eval time: origin for the fresh-document pending window
      everConfirmed: false,  // token + API proof have both held (the hold requires this, not bare apiProven: a payload alone, with no token ever seen, is not a confirmed login)

      noteToken(present, now) {
        t.tokenPresent = !!present;
        if (present && t.apiProven) t.everConfirmed = true;
      },
      noteAuthPage(isAuth) { t.onAuthPage = !!isAuth; },
      // Called by the scrape each tick with the effective post-login
      // grace state (bridge grace + stored grace). While grace is
      // active, auth-page evidence is transient (a redirect flash,
      // an SPA /login flicker) and must not break a hold or force
      // isLoggedIn false (Fix 5e).
      noteGrace(active) { t.graceActive = !!active; },
      noteLogout(now) {
        t.explicitLogoutAt = now;
        t.apiProven = false;
        t.apiBalance = null;
        t.apiBalanceAt = null;
        t.pollAuthFailed = false;
        t.everConfirmed = false;
      },
      noteApiPayload(payload, now) {
        // An authenticated wallet/user payload succeeded: this IS the
        // login proof. Round 3 overwrite discipline: the balance is
        // stored ONLY when the caller declares it qualified
        // (payload.balanceQualified === true) AND it is a finite
        // number ≥ 0. An unqualified value (generic-0, failed-op,
        // proof-only) NEVER overwrites, and NEVER clears, an
        // existing strict balance — it leaves apiBalance untouched
        // while still setting proof, flags and identity. Undefined
        // balanceQualified means NOT qualified (fail-safe): every
        // caller must pass it explicitly.
        // Owner rule (balance-zero fix): an extracted balance of
        // exactly 0 is NEVER stored — not over a previous nonzero
        // figure, and not as a first figure either. A 0 keeps the
        // old balance displayed (or unknown when nothing was ever
        // verified) while proof still lands and the poll keeps
        // searching for a real update. Edge, ordered explicitly by
        // the owner: if the real balance genuinely becomes 0, the
        // app keeps showing the last nonzero figure and keeps
        // searching — there is NO consecutive-zeros override and no
        // other exception to this rule.
        t.apiProven = true;
        t.lastProofAt = now;
        t.pollAuthFailed = false;
        t.pollEmptyCount = 0;
        if (t.tokenPresent) t.everConfirmed = true;
        if (payload && payload.balanceQualified === true && payload.balance !== null && payload.balance !== undefined && Number.isFinite(Number(payload.balance)) && Number(payload.balance) >= 0 && Number(payload.balance) !== 0) {
          t.apiBalance = Number(payload.balance);
          t.apiBalanceAt = now;
        }
        if (payload && payload.userId) t.userId = String(payload.userId);
      },
      noteDomBalance(balance, now) {
        if (balance === null || balance === undefined || !Number.isFinite(Number(balance))) return;
        // Owner rule (balance-zero fix): a 0 scraped from the page
        // is never stored — it must not displace an API-verified
        // figure, and with no verified figure it must not become a
        // displayed ₹0 either (unknown stands instead).
        if (Number(balance) === 0) return;
        t.domBalance = Number(balance);
        t.domBalanceAt = now;
      },
      noteEndpoint(desc) {
        if (!desc || !desc.url) return;
        t.endpoint = {
          url: String(desc.url),
          method: String(desc.method || 'GET').toUpperCase(),
          tokenMode: desc.tokenMode === 'header' ? 'header' : 'cookie',
          headerName: desc.headerName ? String(desc.headerName) : null,
          scheme: desc.scheme ? String(desc.scheme) : ''
        };
      },
      noteActivePoll(result, now) {
        if (!result) return;
        if (result.verdict === 'ok') {
          // Round 3: the poll threads balanceQualified through, so
          // an unqualified replay value can prove the session
          // without overwriting a verified balance.
          t.noteApiPayload({ balance: result.balance, balanceQualified: result.balanceQualified === true, userId: result.userId }, now);
        } else if (result.verdict === 'auth') {
          // The session itself rejected the re-query: logged out.
          // NOTE: the active poll no longer uses this branch (Fix 8:
          // it calls notePollAuthFailure instead, which must never
          // set explicitLogoutAt). This branch is kept for a future
          // intercepted-auth verdict, where an observed 401 on real
          // page traffic is stronger evidence than a replay failure.
          t.pollAuthFailed = true;
          t.apiProven = false;
          t.explicitLogoutAt = now;
        } else if (result.verdict === 'empty') {
          t.pollEmptyCount += 1;
        }
      },
      // A failed ACTIVE re-query is diagnostic ONLY (Fix 8, Grok
      // refinement): it switches the poll channel to intercept-only
      // (fetchMode) but must NEVER set explicitLogoutAt and must
      // NEVER downgrade the login state — a replay can fail on a
      // live session (stale endpoint, transient rejection), and
      // only authoritative signals (explicit logout, auth page,
      // intercepted proof) flip isLoggedIn. Only an explicit
      // logout action/endpoint (noteLogout) sets explicitLogoutAt.
      notePollAuthFailure(now) {
        t.pollAuthFailed = true;
      },
      // Keep-previous-state (Fix 5, refined — no fixed count): a
      // confirmed (token + API proof) state never flips on an
      // uncertain scrape, at ANY document age. No N-count: the boot
      // false repeats 2-3 ticks before the first wallet payload
      // (which would beat a small N). Only authoritative signals
      // break the hold: an auth page OUTSIDE grace, or an effective
      // explicit logout. An auth page DURING grace is transient and
      // does not break the hold (Fix 5e). A failed replay is
      // diagnostic only (Fix 8) and never breaks the hold. Genuine
      // session death still flips via the authoritative channels
      // (explicit logout, or DhaniWin itself routing to /login and
      // clearing its token).
      hysteresisHolds(isAuthPageNow) {
        if (isAuthPageNow && !t.graceActive) return false;
        if (t.explicitLogoutAt !== null && (t.lastProofAt === null || t.explicitLogoutAt > t.lastProofAt)) return false;
        return t.everConfirmed;
      },
      fetchMode() {
        if (!t.endpoint) return t.apiProven ? 'intercept' : 'pending';
        if (t.pollAuthFailed || t.pollEmptyCount >= 3) return 'intercept';
        return 'active';
      },
      isLoggedIn() {
        // A held confirmed state still counts as logged in.
        if (t.hysteresisHolds(t.onAuthPage)) return true;
        // An auth page forces false ONLY outside grace (Fix 5e): a
        // transient /login flash during post-login grace must not
        // downgrade a state the tracker otherwise holds.
        if ((t.onAuthPage && !t.graceActive) || !t.tokenPresent || !t.apiProven) return false;
        if (t.explicitLogoutAt !== null && (t.lastProofAt === null || t.explicitLogoutAt > t.lastProofAt)) return false;
        return true;
      },
      buildState(now) {
        let balance = null;
        let balanceSource = null;
        const apiFresh = t.apiBalance !== null && t.apiBalanceAt !== null && (now - t.apiBalanceAt) <= 45000;
        if (apiFresh) { balance = t.apiBalance; balanceSource = 'api'; }
        else if (t.domBalance !== null) { balance = t.domBalance; balanceSource = 'dom'; }
        else if (t.apiBalance !== null) { balance = t.apiBalance; balanceSource = 'api'; }
        // Fresh-document pending (Fix 5a, refined): a token is
        // present but no wallet payload has proven it yet and the
        // document is young — the state is UNKNOWN, flagged with
        // pending:true. isLoggedIn is NEVER published as null: it
        // carries the previous confirmed value (the hold/seed, or
        // false when nothing was ever confirmed), and every
        // consumer must check pending FIRST and treat a pending
        // state as "no change", never as logged-out. Authoritative
        // failures never pend: a non-superseded explicit logout
        // (ties go negative, as in the verifier) or a poll 401/403
        // still reads false with pending:false.
        // Auth-page detection alone never clears the proven flag
        // (Grok grace rule): noteAuthPage only flips the computed
        // value, and during post-login grace the scrape returns
        // before noting anything at all.
        const logoutSuperseded = t.explicitLogoutAt === null || (t.lastProofAt !== null && t.explicitLogoutAt < t.lastProofAt);
        const isLoggedIn = t.isLoggedIn();
        // The age window is [0, 8000): a synthetic clock behind
        // createdAt (unit tests with fixed timestamps) must not read
        // as "young" — only a genuinely young document pends.
        const docAge = now - t.createdAt;
        const pending = !!(t.tokenPresent && !t.apiProven && logoutSuperseded && !t.pollAuthFailed && docAge >= 0 && docAge < 8000);
        return {
          isLoggedIn,
          pending,
          balance,
          balanceSource,
          apiProven: t.apiProven,
          fetchMode: t.fetchMode(),
          userId: t.userId,
          // Addition 3: lets a late-loading parent app sync the
          // bet-slip dock state from the regular state publish.
          betSlipOpen: !!t.betSlipOpen
        };
      }
    };
    return t;
  }
  // [O101-STATE-CORE-END]

  // [O101-BETSLIP-START]
  // Bet-slip detection (pure; unit-tested against a DOM fixture).
  // The WinGo bet slip is the bottom sheet carrying the
  // Amount/Quantity selectors and the Total Amount row. Structurally:
  // a VISIBLE popup/sheet/dialog (never our own HUD or modals)
  // containing a stepper or the "Total amount" text — the same
  // signature the bet engine itself uses to recognise the slip
  // (findActiveBetPopup; the bet-sheet check in
  // autoDismissInAppPopups).
  function createBetSlipDetector(doc, win) {
    const POPUP_SELECTOR = '.van-popup, [class*="popup"], [class*="sheet"], [class*="drawer"], [role="dialog"]';
    function isSlipPopup(p) {
      if (!p) return false;
      if (p.id === 'quant-ai-hud' || p.id === 'dhaniwinAssistantModal' || p.id === 'fullScreenWinModal') return false;
      if (typeof p.closest === 'function' && p.closest('#quant-ai-hud')) return false;
      const style = win.getComputedStyle(p);
      if (p.offsetParent === null || style.display === 'none' || style.visibility === 'hidden') return false;
      if (p.querySelector('.van-stepper, input.van-stepper__input, [class*="stepper"]')) return true;
      const text = p.innerText || p.textContent || '';
      return text.includes('Total amount');
    }
    function detectBetSlipOpen() {
      const popups = doc.querySelectorAll(POPUP_SELECTOR);
      for (const p of popups) { if (isSlipPopup(p)) return true; }
      return false;
    }
    return { detectBetSlipOpen, isSlipPopup };
  }
  // Edge-triggered transition watcher over the detector: check()
  // fires onTransition exactly once per open/close transition;
  // re-checks with no state change fire nothing.
  function createBetSlipWatcher(detector, onTransition) {
    let open = false;
    return {
      check() {
        const next = !!detector.detectBetSlipOpen();
        if (next === open) return false;
        open = next;
        onTransition(open);
        return true;
      },
      isOpen() { return open; }
    };
  }
  // [O101-BETSLIP-END]

  const _userState = createUserStateTracker();
  // Restore a previously learned wallet endpoint (URL + method + how
  // the token attaches — never a token value) so active polling can
  // start immediately on the next visit.
  try {
    const savedEp = localStorage.getItem(LEARNED_ENDPOINT_KEY);
    if (savedEp) _userState.noteEndpoint(JSON.parse(savedEp));
  } catch (e) {}

  // Cross-document state seed (Fix 5b): a bare pending flag on a
  // young document is not enough, because every new document
  // starts with no memory — "keep previous" needs a previous to
  // keep. On each publish the bridge persists {isLoggedIn,
  // apiProven, ts} to sessionStorage (same tab, same origin, so
  // the app page and the frame share it); a new document seeds
  // its tracker from that entry when a token is present, the
  // document is not an auth page, and ts is under ~120s old.
  // Balance is deliberately NOT seeded: a stale figure must never
  // present as an exact balance — only the login flags carry over,
  // and the next real payload re-proves the figure.
  const USER_STATE_SEED_KEY = 'o101_user_state_seed_v1';
  try {
    const rawSeed = sessionStorage.getItem(USER_STATE_SEED_KEY);
    if (rawSeed) {
      const seed = JSON.parse(rawSeed);
      const hrefLower = (window.location.href || '').toLowerCase();
      const onAuthPage = hrefLower.includes('/login') || hrefLower.includes('/register');
      const tokenNow = readSessionToken();
      const seedAge = seed && typeof seed.ts === 'number' ? Date.now() - seed.ts : -1;
      if (!onAuthPage && tokenNow && seedAge >= 0 && seedAge < 120000 && seed.apiProven) {
        _userState.apiProven = true;
        _userState.lastProofAt = seed.ts;
        _userState.tokenPresent = true;
        if (seed.isLoggedIn) _userState.everConfirmed = true;
      }
    }
  } catch (e) {}

  function persistLearnedEndpoint() {
    try {
      if (_userState.endpoint) localStorage.setItem(LEARNED_ENDPOINT_KEY, JSON.stringify(_userState.endpoint));
    } catch (e) {}
  }

  function readSessionToken() {
    try {
      return localStorage.getItem('ar_token') || localStorage.getItem('token')
        || localStorage.getItem('accessToken') || localStorage.getItem('authorization') || null;
    } catch (e) { return null; }
  }

  // ── 0. Real Balance Engine (Network XHR/Fetch Interception + DOM Scanner) ────
  // Wallet balance keys (Fix 9, tightened round 3): a balance number
  // counts ONLY when found under one of these keys via the subKeys
  // traversal below. Generic keys (amount, coin, money, realmoney)
  // NEVER count — the old extractor scanned top-level keys in
  // document order, so {data:{amount:0, wallet:{balance:67.45}}}
  // returned 0 by shadowing and a nested zero wallet inside a
  // user-info payload displayed as an exact ₹0. The presence-only
  // gate (hasWalletSpecificKey) is DELETED: a key merely existing
  // (e.g. `wallet` holding an object) proved nothing. The proof is
  // now "strict extraction is non-null" — a real number under a
  // wallet key — plus the error gate and the zero-provenance rule
  // in onApiWalletPayload.
  const WALLET_BALANCE_KEYS = ['balance', 'userbalance', 'user_balance', 'availablebalance', 'available_balance', 'wallet', 'userwallet', 'user_wallet', 'walletbalance', 'wallet_balance', 'totalbalance', 'total_balance'];

  // Strict balance extraction (round 3): at each visited object
  // (depth ≤ 5), a WALLET_BALANCE_KEYS key holding a finite number
  // ≥ 0 (numeric strings coerced after stripping commas) is the
  // value; a wallet key holding a non-number is skipped as a value
  // but still recursed into when it is a subKey. Recursion goes
  // ONLY through subKeys — never arbitrary keys, never
  // amount/coin/money. Shallowest depth wins (level-first
  // traversal), so {data:{amount:0, wallet:{balance:67.45}}}
  // returns 67.45, {amount:0} alone returns null, and
  // {data:{user:{wallet:{balance:0}}}} returns a strict 0 (whose
  // display is then decided by the zero-provenance rule, not here).
  function extractBalanceFromJson(data, depth = 0) {
    if (!data || typeof data !== 'object' || depth > 5) return null;

    // 1. Wallet keys at the current level, in document order.
    for (const k of Object.keys(data)) {
      const lowerKey = k.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (WALLET_BALANCE_KEYS.includes(lowerKey)) {
        const val = data[k];
        if (typeof val === 'number' && Number.isFinite(val) && val >= 0) return val;
        if (typeof val === 'string' && val.trim() !== '') {
          const num = Number(val.replace(/,/g, '').trim());
          if (Number.isFinite(num) && num >= 0) return num;
        }
      }
    }

    // 2. Recurse ONLY through wrapper keys.
    const subKeys = ['data', 'result', 'payload', 'body', 'userInfo', 'user_info', 'user', 'wallet', 'wallets', 'member', 'account'];
    for (const sk of subKeys) {
      if (data[sk] && typeof data[sk] === 'object') {
        const nested = extractBalanceFromJson(data[sk], depth + 1);
        if (nested !== null) return nested;
      }
    }

    return null;
  }

  // Normalise fetch/XHR headers (Headers instance, pair array, or
  // plain object) into [name, value] pairs for token-attachment
  // detection. Values are inspected in-memory only, never stored.
  function headerPairsFrom(headers) {
    const pairs = [];
    try {
      if (!headers) return pairs;
      if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
        headers.forEach((v, k) => pairs.push([k, v]));
      } else if (Array.isArray(headers)) {
        for (const p of headers) if (Array.isArray(p) && p.length >= 2) pairs.push([String(p[0]), String(p[1])]);
      } else if (typeof headers === 'object') {
        for (const k of Object.keys(headers)) pairs.push([k, String(headers[k])]);
      }
    } catch (e) {}
    return pairs;
  }

  // Round 3 error-body gate (shared by the payload handler and the
  // active poll — the two must never drift apart): a body code of
  // 401/403 (coerced, so string "401"/"403" count) or a non-empty
  // auth-flavoured message (token/unauthor/login/session/expired/
  // re-login, regardless of the success field) means the session is
  // NOT proven by this payload. A bare success:false with a
  // non-auth message does NOT block: an authenticated response to a
  // failed operation still proves the session is alive (it just
  // carries no balance — see the failed-op decoupling below).
  function isAuthErrorBody(data) {
    const errCode = (data.code !== undefined ? data.code : data.status);
    if (Number(errCode) === 401 || Number(errCode) === 403) return true;
    const errMsg = String(data.msg || data.message || '');
    if (errMsg !== '' && /token|unauthor|login|session|expired|re-login/i.test(errMsg)) return true;
    return false;
  }

  // Round 3 zero-provenance test: a strict 0 counts as a DISPLAYABLE
  // balance only when the request URL itself looks like a wallet
  // read (contains wallet|balance). A strict 0 from a user-info /
  // money / financial / ar-lottery URL sustains LOGIN PROOF but
  // must not set a displayed balance, be learned, or refresh a
  // replay — otherwise a nested zero wallet inside a user-info
  // boot payload (the most likely false-₹0 shape) displays as an
  // exact ₹0 and is replayed every 20s while the real wallet
  // endpoint never fires.
  function urlHasWalletOrBalance(url) {
    if (typeof url !== 'string') return false;
    const u = url.toLowerCase();
    return u.includes('wallet') || u.includes('balance');
  }

  // One authenticated wallet/user API payload: login proof for the
  // tracker, legacy notification for the app, and — when it came
  // from a qualified balance-bearing request — the endpoint to learn
  // for session-powered active re-query. Round 3 order (each step
  // returns before any state it must not touch):
  // (1) non-object → return; (2) strict extraction + userId; both
  // absent → return; (3) !httpOk → return (no proof at all);
  // (4) error body → return (no proof); (5) success === false →
  // proof-only (balance null): a failed operation's 0 must never
  // overwrite apiBalance; (6) otherwise balanceQualified =
  // strictBal non-null AND (strictBal > 0 OR wallet|balance URL);
  // noteApiPayload with balanceQualified — the tracker itself never
  // stores a 0 (owner rule), so a qualified 0 proves login and is
  // learned for replay but displays nothing; (7) qualified nonzero
  // → display notification; (8) learning only when qualified AND a real
  // request URL AND not a firebase URL; (9) publish.
  function onApiWalletPayload(data, via, reqDesc, httpOk) {
    if (!data || typeof data !== 'object') return;
    const strictBal = extractBalanceFromJson(data);
    const userId = extractUserIdFromJson(data);
    if (strictBal === null && !userId) return;
    if (!httpOk) return;
    if (isAuthErrorBody(data)) return;
    if (data.success === false) {
      _userState.noteApiPayload({ balance: null, balanceQualified: false, userId }, Date.now());
      publishUserState('api-payload');
      return;
    }
    const balanceQualified = strictBal !== null
      && (strictBal > 0 || urlHasWalletOrBalance(reqDesc && reqDesc.url));
    _userState.noteApiPayload({ balance: balanceQualified ? strictBal : null, balanceQualified, userId }, Date.now());
    if (balanceQualified) onRealBalanceDetected(strictBal, via);
    if (balanceQualified && reqDesc && reqDesc.url && !String(reqDesc.url).includes('firebasedatabase.app')) {
      const att = detectTokenAttachment(reqDesc.headerPairs || []);
      _userState.noteEndpoint({
        url: String(reqDesc.url),
        method: reqDesc.method || 'GET',
        tokenMode: att.mode,
        headerName: att.headerName || null,
        scheme: att.scheme || ''
      });
      persistLearnedEndpoint();
    }
    publishUserState('api-payload');
  }

  function onRealBalanceDetected(balance, source) {
    if (typeof balance !== 'number' || isNaN(balance) || balance < 0) return;
    // Owner rule (balance-zero fix): a 0 is never notified to the
    // app — no DHANIWIN_REAL_BALANCE, no USER_SYNC balance. The old
    // displayed figure stands and the search for an update goes on.
    if (balance === 0) return;
    if (_lastScrapedBalance === balance) return;
    _lastScrapedBalance = balance;
    console.log(`%c[RealBalanceEngine] 💰 Scraped real balance: ₹${balance.toFixed(2)} (via ${source})`, 'color:#10b981;font-weight:bold;');
    notifyApp({
      type: 'DHANIWIN_REAL_BALANCE',
      balance: balance,
      source: source,
      timestamp: Date.now()
    });
    notifyApp({
      type: 'DHANIWIN_USER_SYNC',
      balance: balance,
      isLoggedIn: true,
      url: window.location.href,
      timestamp: Date.now()
    });
  }

  function scrapeRealBalanceFromDOM() {
    const selectors = [
      '.wallet-balance',
      '.balance-num',
      '[class*="wallet-num"]',
      '[class*="wallet_num"]',
      '[class*="balance_num"]',
      '[class*="user-money"]',
      '[class*="wallet-money"]',
      '.van-nav-bar__title',
      '[class*="money"]',
      '[class*="balance"]',
      '[class*="amount"]',
      '[class*="asset"]'
    ];
    const elements = Array.from(document.querySelectorAll(selectors.join(','))).filter(el => {
      if (el.closest('#quant-ai-hud, #dhaniwinAssistantModal, [class*="stepper"], .time-box, [class*="countdown"]')) return false;
      return el.offsetParent !== null;
    });

    for (const el of elements) {
      const txt = (el.innerText || el.textContent || '').trim();
      if (txt.includes(':') || txt.includes('%') || txt.includes('#') || txt.length > 35) continue;
      // Exclude period issue numbers (e.g. 2026100510005)
      if (/^[0-9]{8,}$/.test(txt)) continue;
      const match = txt.match(/(?:[₹$]|Rs\.?)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i) ||
                    txt.match(/^([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)$/);
      if (match && match[1]) {
        const num = Number(match[1].replace(/,/g, ''));
        if (Number.isFinite(num) && num >= 0) {
          return num;
        }
      }
    }

    // Secondary DOM fallback: inspect elements preceded by Balance/Wallet labels
    const allLabels = Array.from(document.querySelectorAll('span, div, p, b')).filter(el => {
      if (el.closest('#quant-ai-hud, #dhaniwinAssistantModal, .time-box')) return false;
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      return (t === 'balance' || t === 'wallet' || t === 'wallet balance' || t === 'total assets') && el.offsetParent !== null;
    });
    for (const lbl of allLabels) {
      const parent = lbl.parentElement;
      if (parent) {
        const numTxt = (parent.innerText || parent.textContent || '').replace(lbl.innerText, '').trim();
        const m = numTxt.match(/(?:[₹$]|Rs\.?)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i) ||
                  numTxt.match(/([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/);
        if (m && m[1]) {
          const num = Number(m[1].replace(/,/g, ''));
          if (Number.isFinite(num) && num >= 0) return num;
        }
      }
    }

    return null;
  }

  // Logout-URL test (Fix 5f): match whole PATH SEGMENTS only —
  // logout, signout, loginout, or loginoff (DhaniWin's real
  // /Home/LoginOff endpoint). The old bare-substring match fired
  // on any URL containing 'exit' (e.g. an exit-survey link) and
  // would nuke a live session's logout reporting; a query value
  // mentioning logout must not match either, so only the path
  // part (before ?/#) is segmented.
  function isLogoutRequestUrl(urlLower) {
    const path = String(urlLower || '').split('?')[0].split('#')[0];
    return path.split('/').some(seg => seg === 'logout' || seg === 'signout' || seg === 'loginout' || seg === 'loginoff');
  }

  // Intercept fetch & XHR to catch login/register, logout, AND wallet balance responses instantly
  (function hookNetworkAuth() {
    try {
      const origFetch = window.fetch;
      if (origFetch) {
        window.fetch = async function(...args) {
          // Describe THIS request (raw URL for endpoint learning,
          // method, header pairs) before it is sent.
          let _reqDesc = null;
          try {
            const rawUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            const init = (args[1] && typeof args[1] === 'object') ? args[1] : {};
            const method = init.method || (args[0] && args[0].method) || 'GET';
            const hdrs = init.headers || (args[0] && args[0].headers) || null;
            _reqDesc = { url: rawUrl, method, headerPairs: headerPairsFrom(hdrs) };
          } catch(e) {}
          try {
            const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url || '').toLowerCase();
            // Intercept logout calls immediately (path-segment match, Fix 5f)
            if (isLogoutRequestUrl(url)) {
              console.log('[Quant AI Bridge] 🚪 Logout API call intercepted:', url);
              _wasLoggedInBefore = false;
              try { sessionStorage.removeItem('o101_bridge_was_logged_in'); } catch (e) {}
              _justLoggedInGrace = 0;
              _userState.noteLogout(Date.now());
              // NOTE: never delete 'ar_token' here. It is DhaniWin's
              // own live session key on the shared origin; DhaniWin's
              // logout call invalidates the session server-side and
              // owns its token storage. Deleting it would destroy a
              // live session on any mis-matched URL.
              try { sessionStorage.removeItem('dhaniwin_auth_grace_until'); } catch(e) {}
              notifyApp({
                type: 'DHANIWIN_USER_LOGGED_OUT',
                url: window.location.href,
                reason: 'Logout API call',
                explicit: true,
                timestamp: Date.now()
              });
              publishUserState('logout-api');
            }
          } catch(e) {}

          const response = await origFetch.apply(this, args);
          try {
            const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url || '').toLowerCase();
            if (url.includes('firebasedatabase.app')) {
              // The bridge's own RTDB traffic (and the app's sync
              // reads) must never be mistaken for wallet payloads.
              return response;
            }
            if (url.includes('login') || url.includes('register')) {
              const clone = response.clone();
              clone.json().then(data => {
                if (data && (data.code === 0 || data.success || data.token || data.data?.token)) {
                  console.log('[Quant AI Bridge] 🎉 Auth API Success Detected!');
                  _justLoggedInGrace = Date.now() + 15000;
                  try { sessionStorage.setItem('dhaniwin_auth_grace_until', String(_justLoggedInGrace)); } catch(e) {}
                  _wasLoggedInBefore = true;
                  try { sessionStorage.setItem('o101_bridge_was_logged_in', '1'); } catch (e) {}
                  _sessionOutNotified = false;
                  notifyApp({ type: 'DHANIWIN_AUTH_SUCCESS', data });
                  setTimeout(goHomeAfterLogin, 600);
                  // A wallet endpoint may already be learned: prove the
                  // session actively instead of waiting for page traffic.
                  setTimeout(() => { activeWalletPoll(); }, 900);
                }
              }).catch(() => {});
            }

            // Real Balance Scraper: Intercept any wallet, user info, or balance JSON payload
            if (url.includes('wallet') || url.includes('user') || url.includes('balance') || url.includes('money') || url.includes('financial') || url.includes('ar-lottery')) {
              const clone = response.clone();
              clone.json().then(data => {
                onApiWalletPayload(data, 'fetch-api', _reqDesc, response.ok);
              }).catch(() => {});
            }
          } catch(e) {}
          return response;
        };
      }
    } catch(e) {}

    // Also Hook XMLHttpRequest for legacy or Axios requests inside DhaniWin
    try {
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._reqUrl = (typeof url === 'string') ? url : '';
        this._reqMethod = method || 'GET';
        this._o101HeaderPairs = [];
        return origOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        try {
          if (!Array.isArray(this._o101HeaderPairs)) this._o101HeaderPairs = [];
          this._o101HeaderPairs.push([String(name), String(value)]);
        } catch(e) {}
        return origSetHeader.call(this, name, value);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
          try {
            const urlLower = (this._reqUrl || '').toLowerCase();
            if (urlLower.includes('firebasedatabase.app')) return;
            if (urlLower.includes('wallet') || urlLower.includes('user') || urlLower.includes('balance') || urlLower.includes('money') || urlLower.includes('financial')) {
              const parsed = JSON.parse(this.responseText);
              onApiWalletPayload(parsed, 'xhr-api', {
                url: this._reqUrl,
                method: this._reqMethod || 'GET',
                headerPairs: this._o101HeaderPairs || []
              }, this.status >= 200 && this.status < 300);
            }
          } catch(e) {}
        });
        return origSend.apply(this, args);
      };
    } catch(e) {}
  })();

  // Intercept clicks on any Logout / Sign Out button inside DhaniWin
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', (e) => {
      try {
        const target = e.target?.closest ? e.target.closest('button, a, div, span') : null;
        if (!target) return;
        const txt = (target.innerText || target.textContent || '').trim().toLowerCase();
        const isLogout = txt === 'logout' || txt === 'log out' || txt === 'sign out' || txt === '退出' ||
                         String(target.className || '').toLowerCase().includes('logout');
        if (isLogout) {
          console.log('[Quant AI Bridge] 🚪 User clicked logout button in DhaniWin UI');
          _wasLoggedInBefore = false;
          try { sessionStorage.removeItem('o101_bridge_was_logged_in'); } catch (e) {}
          _justLoggedInGrace = 0;
          _userState.noteLogout(Date.now());
          // NOTE: never delete 'ar_token' here — it is DhaniWin's own
          // live session key on the shared origin; DhaniWin's logout
          // owns its token. Reporting the logout is enough.
          try { sessionStorage.removeItem('dhaniwin_auth_grace_until'); } catch(e) {}
          notifyApp({
            type: 'DHANIWIN_USER_LOGGED_OUT',
            url: window.location.href,
            reason: 'User clicked logout button',
            explicit: true,
            timestamp: Date.now()
          });
          publishUserState('logout-click');
        }
      } catch(e) {}
    }, true);
  }

  // ── 1. Floating On-Screen HUD ────────────────────────────────────────────────
  function updateFloatingHud(statusText, color) {
    let hud = document.getElementById('quant-ai-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'quant-ai-hud';
      hud.style.cssText = 'position:fixed;bottom:75px;left:12px;right:12px;z-index:999999;background:rgba(12,8,25,0.96);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1.5px solid #10b981;border-radius:16px;padding:8px 14px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#fff;font-size:11px;font-weight:bold;box-shadow:0 12px 36px rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:space-between;pointer-events:none;transition:all 0.3s ease;';
      const style = document.createElement('style');
      style.textContent = `@keyframes autoBetShake { 0%, 100% { transform: scale(1.04) translateX(0); } 20%, 60% { transform: scale(1.05) translateX(-4px); } 40%, 80% { transform: scale(1.05) translateX(4px); } }`;
      if (document.head) document.head.appendChild(style);
      else if (document.body) document.body.appendChild(style);
      if (document.body) document.body.appendChild(hud);
    }
    const colorHex = color === 'amber' ? '#f59e0b' : color === 'rose' ? '#f43f5e' : '#10b981';
    hud.style.borderColor = colorHex;
    hud.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="width:8px;height:8px;border-radius:50%;background:${colorHex};box-shadow:0 0 10px ${colorHex};display:inline-block;"></span>
        <span style="letter-spacing:0.5px;color:#fff;">QUANT AI AUTO-BET</span>
      </div>
      <span style="color:${colorHex};font-size:10.5px;font-family:monospace;">${statusText}</span>
    `;
  }

  function notifyApp(msg) {
    if (channel) {
      try { channel.postMessage(msg); } catch(e) {}
    }
    if (window.opener) {
      try { window.opener.postMessage(msg, '*'); } catch(e) {}
    }
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage(msg, '*'); } catch(e) {}
    }
  }

  // Handshake & Heartbeat
  notifyApp({ type: 'DHANIWIN_BRIDGE_HANDSHAKE', status: 'READY', url: window.location.href });
  updateFloatingHud('Bridge Active • Ready for Signals', 'emerald');
  window.addEventListener('pointerdown', () => notifyApp({ type: 'DHANIWIN_PAGE_TAP' }), { passive: true });
  setInterval(() => {
    notifyApp({ type: 'DHANIWIN_BRIDGE_HEARTBEAT', timestamp: Date.now() });
  }, 2000);

  // ── 2. Safe Event Dispatcher (Multi-Phase Pointer & Touch Simulation) ──────
  function simulateClick(element) {
    if (!element) return;
    try { element.focus(); } catch(e) {}

    let clientX = 0, clientY = 0;
    try {
      const rect = element.getBoundingClientRect();
      clientX = rect.left + rect.width / 2;
      clientY = rect.top + rect.height / 2;
    } catch(e) {}

    // Pointer Events (Safe for mobile Vue/Vant and FastClick listeners)
    if (typeof PointerEvent !== 'undefined') {
      try {
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window, clientX, clientY, pointerId: 1, isPrimary: true, pressure: 0.5 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window, clientX, clientY, pointerId: 1, isPrimary: true }));
      } catch(e) {}
    }

    // Touch Events (Mobile Safari / Chrome touch triggers)
    if (typeof TouchEvent !== 'undefined') {
      try {
        const touch = new Touch({ identifier: Date.now(), target: element, clientX, clientY });
        element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
        element.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [touch] }));
      } catch(e) {}
    }

    // Mouse Events
    try {
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX, clientY }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX, clientY }));
    } catch(e) {}

    // Native Click
    if (typeof element.click === 'function') {
      try { element.click(); } catch(e) {}
    } else {
      try {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX, clientY }));
      } catch(e) {}
    }
  }

  // Resilient Async Element Waiter with MutationObserver & Polling Fallback
  function waitForElement(predicateFn, timeoutMs = 3500, intervalMs = 50) {
    return new Promise((resolve) => {
      const initial = predicateFn();
      if (initial) return resolve(initial);

      let observer = null;
      let timer = null;
      const startTime = Date.now();

      function check() {
        const el = predicateFn();
        if (el) {
          cleanup();
          return resolve(el);
        }
        if (Date.now() - startTime >= timeoutMs) {
          cleanup();
          return resolve(null);
        }
      }

      function cleanup() {
        if (observer) { try { observer.disconnect(); } catch(e) {} observer = null; }
        if (timer) { clearInterval(timer); timer = null; }
      }

      if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
        try {
          observer = new MutationObserver(check);
          observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true });
        } catch(e) {}
      }

      timer = setInterval(check, intervalMs);
    });
  }

  // ── 3. Aggressive In-App Popup Dismissal ─────────────────────────────────────
  function autoDismissInAppPopups() {
    // 1. Dialogs (Daily sign-in, notices, announcements)
    const dialogs = document.querySelectorAll('.van-dialog, [class*="dialog"], [class*="notice-modal"], [class*="announcement"]');
    dialogs.forEach(dlg => {
      // Guard: Never dismiss active bet sheet or stepper!
      if (dlg.querySelector('.van-stepper, input.van-stepper__input, .van-button--danger, [class*="stepper"]')) return;
      const btn = dlg.querySelector('.van-dialog__confirm, .van-popup__close-icon, [class*="close"], .van-button');
      if (btn) {
        try { simulateClick(btn); } catch(e) {}
      }
    });

    // 2. Standalone Floating Close Icons (unless inside a betting sheet)
    const closeIcons = document.querySelectorAll('.van-popup__close-icon, .van-icon-cross, [class*="close-icon"], .dialog-close, .notice-close');
    closeIcons.forEach(icon => {
      const parentPopup = icon.closest('.van-popup');
      if (parentPopup) {
        const isBetSheet = parentPopup.querySelector('.van-stepper, input.van-stepper__input') || (parentPopup.innerText || '').includes('Total amount');
        if (isBetSheet) return; // Keep betting sheet open!
      }
      try { simulateClick(icon); } catch(e) {}
    });
  }
  setInterval(autoDismissInAppPopups, 500);

  const INTERVAL_URL_MAP = {
    '30s': '/WinGo/WinGo_30S',
    '1m':  '/WinGo/WinGo_1M',
    '3m':  '/WinGo/WinGo_3M',
    '5m':  '/WinGo/WinGo_5M'
  };

  // ── 4. Post-login routing (root-canonical since round 3 — user may browse any DhaniWin page) ──
  // After a fresh login/register success, land on the DhaniWin home page once.
  // Round 3 — ROOT-CANONICAL (replaces the round-2 prefix-aware
  // logic; do not leave both): home is always origin + '/'.
  // Origin-relative construction is correct on the worker root
  // and on direct dhaniwin44.com loads alike (pivot default).
  // The guard (href must
  // contain /login or /register) means this fires at most once per
  // login, and origin-relative construction means it can never
  // escape to a non-worker host.
  function goHomeAfterLogin() {
    const href = window.location.href.toLowerCase();
    if (href.includes('/login') || href.includes('/register')) {
      window.location.href = window.location.origin + '/';
    }
  }

  // Only keep the timer tab in sync when the user is ALREADY on a WinGo page. Never navigate.
  function autoOpenWinGo() {
    const href = window.location.href.toLowerCase();
    if (href.includes('/wingo/')) switchTimerTab(activeTimeframe);
  }
  setTimeout(autoOpenWinGo, 1500);

  // Switch WinGo Timer Tab (30s, 1m, 3m, 5m)
  function switchTimerTab(tf) {
    if (tf) activeTimeframe = tf;
    const matchTerms = {
      '30s': ['30s', '30 sec', '30sec', 'win go 30s', 'wingo 30s'],
      '1m':  ['1min', '1 min', '1m', 'win go 1min', 'wingo 1m'],
      '3m':  ['3min', '3 min', '3m', 'win go 3min', 'wingo 3m'],
      '5m':  ['5min', '5 min', '5m', 'win go 5min', 'wingo 5m']
    };
    const targets = matchTerms[activeTimeframe] || [];

    // Find tab elements in WinGo header
    const tabElements = Array.from(document.querySelectorAll('.van-tab, [class*="tab"], .time-item, [class*="time"], div, button, span'));
    for (const el of tabElements) {
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (targets.some(t => txt === t || txt.startsWith(t) || txt === `win go ${t}`)) {
        // If not already active
        if (!el.classList.contains('van-tab--active') && !el.classList.contains('active')) {
          simulateClick(el);
          console.log('[Quant AI Bridge] ⏱️ Switched timer tab to:', activeTimeframe);
          updateFloatingHud(`Timeframe: ${activeTimeframe}`, 'emerald');
        }
        break;
      }
    }
  }

  // ── 5. Scrape User Session & Wallet Balance ──────────────────────────────────
  // LOGIN_DETECTED is edge-triggered per SESSION, not per document
  // (Fix 5c): the flag persists in sessionStorage, so a fresh
  // document does not re-send LOGIN_DETECTED, re-arm the app grace,
  // or re-run the replay — which used to keep the grace
  // permanently on and defeat real logout detection. Every path
  // that clears the flag also clears the stored key, so a genuine
  // re-login after a logout still fires exactly once.
  let _wasLoggedInBefore = false;
  try { _wasLoggedInBefore = sessionStorage.getItem('o101_bridge_was_logged_in') === '1'; } catch (e) {}
  // LOGGED_OUT fires once per transition (Fix 5g): while the page
  // sits on /login after grace, the 1.5s tick must not re-emit it.
  let _sessionOutNotified = false;
  // Late-injection recovery (pivot): native APK injection lands
  // after page load, so the fetch hook may have missed the SPA boot
  // calls and activeWalletPoll has no learned endpoint to replay.
  // When a scrape tick finds a live token with no learned endpoint
  // and no API proof yet, nudge the SPA to re-fetch once (refresh
  // button click — the same nudge the app's sync request uses) and
  // re-run poll + scrape after the refetch lands. Once per
  // document; never a login proof by itself — proof still comes
  // only from an intercepted/poll payload through the strict gate,
  // and the state stays pending/unknown until then.
  let _lateInjectionRecoveryAttempted = false;
  function findWalletRefreshButton() {
    return document.querySelector('.van-icon-replay, [class*="refresh"], [class*="reload"], .wallet-refresh, .refresh-btn');
  }
  function maybeRecoverLateInjection() {
    if (_lateInjectionRecoveryAttempted) return false;
    _lateInjectionRecoveryAttempted = true;
    if (_userState.endpoint) return false;
    try { const btn = findWalletRefreshButton(); if (btn) btn.click(); } catch (e) {}
    setTimeout(() => { activeWalletPoll(); scrapeUserSession(); }, 1500);
    return true;
  }

  function scrapeUserSession() {
    const href = window.location.href.toLowerCase();
    const isAuthPage = href.includes('/login') || href.includes('/register');

    // Check for explicit "Login" / "Register" prompts in header or navigation
    const hasAuthPrompts = Array.from(document.querySelectorAll('button, a, span, div')).some(el => {
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      return (t === 'login' || t === 'register' || t === 'sign in') && el.offsetParent !== null;
    });

    let token = null;
    if (!isAuthPage) {
      try { token = localStorage.getItem('ar_token'); } catch(e) {}
    }
    // NOTE: on an auth page the token is simply not READ for login
    // detection — it is never deleted. The frame can land on /login
    // transiently (redirects, SPA flashes) while a session is still
    // alive, and deleting here would destroy that live session.

    let balance = _lastScrapedBalance;
    if (balance === null) {
      balance = scrapeRealBalanceFromDOM();
      if (balance !== null) {
        _lastScrapedBalance = balance;
        // Page-scraped figure: recorded as DOM provenance, never as
        // an exact (API) balance.
        _userState.noteDomBalance(balance, Date.now());
      }
    }

    // A user is only logged in if:
    // 1. Not on an auth page (/login, /register)
    // 2. AND no visible login prompt is displayed
    // 3. AND (balance is confirmed, or token exists)
    // (Fix 5: the old WinGo-page requirement falsely reported
    // session-out on non-WinGo pages with balance still pending.)
    const rawLoggedIn = !isAuthPage && !hasAuthPrompts && (balance !== null || token !== null);
    // Effective post-login grace for this tick (bridge grace +
    // stored grace, whichever runs longer). The tracker is told
    // before any state is computed, so an auth-page flash during
    // grace neither breaks the hold nor forces false (Fix 5e).
    let storedGrace = 0;
    try { storedGrace = Number(sessionStorage.getItem('dhaniwin_auth_grace_until')) || 0; } catch (e) {}
    const effectiveGrace = Math.max(_justLoggedInGrace, storedGrace);
    _userState.noteGrace(Date.now() < effectiveGrace);
    // Keep-previous-state (Fix 5, refined): a merely-uncertain scrape
    // must never flip a confirmed state to logged-out, at ANY
    // document age — no fixed count of failed validations. The
    // effective value holds the previous confirmed state through
    // transient failures; only an authoritative signal flips it
    // (auth page after grace, API 401/403, explicit logout).
    // During grace the function returns early below, so no
    // downgrade notification can be observed inside grace (Grok
    // grace rule: only an explicit logout may clear proven state
    // during grace; auth-page detection alone never clears the
    // apiProven flag).
    let isLoggedIn = rawLoggedIn || _userState.hysteresisHolds(isAuthPage);
    // An explicit logout that no later proof superseded keeps the
    // scrape logged-out even if DhaniWin's token lingers for a
    // tick before it clears it — otherwise the next tick
    // re-detects login from the stale token and the app flaps
    // back to logged-in right after a real logout. A later proof
    // (wallet payload after a re-login) supersedes automatically.
    if (_userState.explicitLogoutAt !== null && (_userState.lastProofAt === null || _userState.explicitLogoutAt > _userState.lastProofAt)) {
      isLoggedIn = false;
    }

    if (isLoggedIn && !_wasLoggedInBefore) {
      _wasLoggedInBefore = true;
      try { sessionStorage.setItem('o101_bridge_was_logged_in', '1'); } catch (e) {}
      _sessionOutNotified = false;
      _justLoggedInGrace = Date.now() + 15000;
      try { sessionStorage.setItem('dhaniwin_auth_grace_until', String(_justLoggedInGrace)); } catch(e) {}
      notifyApp({
        type: 'DHANIWIN_LOGIN_DETECTED',
        loggedIn: true,
        interval: activeTimeframe,
        timestamp: Date.now()
      });
      // Login just detected: actively prove it against the learned
      // wallet endpoint instead of waiting for incidental traffic.
      setTimeout(() => { activeWalletPoll(); }, 400);
    } else if (!isLoggedIn && (_wasLoggedInBefore || isAuthPage)) {
      // Do not fire session-out during post-login grace transition
      if (Date.now() < effectiveGrace) {
        return;
      }
      _wasLoggedInBefore = false;
      try { sessionStorage.removeItem('o101_bridge_was_logged_in'); } catch (e) {}
      // NOTE: report the session-out only — never delete 'ar_token'.
      // A scrape misread (slow load, transient auth prompt) must not
      // destroy a live session; the next tick re-detects login if
      // the session is actually alive. Heuristic logout: explicit
      // is false, so the app never zeroes its grace on this (Fix
      // 5d) — only a real logout action/endpoint may do that.
      // Emitted once per transition (Fix 5g), not every tick.
      if (!_sessionOutNotified) {
        _sessionOutNotified = true;
        notifyApp({
          type: 'DHANIWIN_USER_LOGGED_OUT',
          url: window.location.href,
          reason: isAuthPage ? 'On login page' : 'Logged out on DhaniWin',
          explicit: false,
          timestamp: Date.now()
        });
      }
    }

    // Feed the truth tracker (legacy USER_SYNC below keeps its exact
    // legacy semantics for the app's own UI; the published user state
    // is the strict, API-proven layer).
    _userState.noteToken(!isAuthPage && !!token, Date.now());
    _userState.noteAuthPage(isAuthPage);
    const tickState = publishUserState('tick');

    notifyApp({
      type: 'DHANIWIN_USER_SYNC',
      tokenPresent: isLoggedIn ? !!token : false,
      balance: balance,
      isLoggedIn: isLoggedIn,
      // Pending (Fix 5a): while the state is unproven, the app
      // must treat this sync as "no change", never as logged-out.
      pending: !!(tickState && tickState.pending),
      url: window.location.href,
      timestamp: Date.now()
    });
    // Late-injection recovery: a live token with no learned endpoint
    // and no API proof yet means the hook missed the boot calls —
    // nudge once (per document) so the next SPA fetch can be
    // intercepted and learned. A DOM balance, when scraped, stays
    // 'from page' provenance; an exact balance still needs the
    // strict API gate, and a missing proof stays unknown, never 0.
    if (token && !_userState.endpoint && !_userState.apiProven) maybeRecoverLateInjection();
  }
  // Run immediately and every 1.5s for instant login/logout responsiveness
  scrapeUserSession();
  setInterval(scrapeUserSession, 1500);

  // ── 6. Live Scraper: Monitors History Table ──────────────────────────────────
  let lastPeriodSeen = null;
  function scrapeDraws() {
    const candidates = document.querySelectorAll('tr, .van-row, [class*="record"], [class*="history-item"], [class*="item"]');
    for (const el of candidates) {
      const txt = el.innerText || el.textContent || '';
      const periodMatch = txt.match(/\b\d{10,20}\b/);
      if (periodMatch) {
        const period = periodMatch[0];
        if (period !== lastPeriodSeen) {
          lastPeriodSeen = period;
          const numMatch = txt.match(/\b([0-9])\b/);
          const num = numMatch ? Number(numMatch[1]) : null;
          if (num !== null) {
            const size = num >= 5 ? 'BIG' : 'SMALL';
            const color = [1,3,7,9,5].includes(num) ? 'GREEN' : 'RED';
            notifyApp({
              type: 'DHANIWIN_SCRAPED_RESULT',
              period,
              number: num,
              size,
              color,
              timestamp: Date.now()
            });
            console.log('[Quant AI Bridge] 📊 Scraped draw:', period, num, size, color);
          }
        }
        break;
      }
    }
  }
  setInterval(scrapeDraws, 800);

  // ── 7. Target Betting Button Locator (Isolates Betting Area) ─────────────────
  function findBettingContainer() {
    const containers = Array.from(document.querySelectorAll(
      '[class*="bet-box"], [class*="bet-wrap"], [class*="betting"], [class*="game-bet"], .bet-type, .bet-area, .c-row, .bet-con, [class*="bet_box"], .van-tabs__content, .content'
    ));
    for (const c of containers) {
      const txt = (c.innerText || c.textContent || '').toUpperCase();
      if ((txt.includes('BIG') && txt.includes('SMALL')) || (txt.includes('GREEN') && txt.includes('RED'))) {
        return c;
      }
    }
    return document.body;
  }

  function findTargetButton(target) {
    if (!target) return null;
    const tgt = String(target).trim().toUpperCase();
    const container = findBettingContainer();
    const candidates = Array.from(container.querySelectorAll('button, div, span, [role="button"], [class*="btn"], [class*="item"], .van-col')).filter(el => {
      // Exclude table rows, history, hud, assistant
      const isExcluded = el.closest('tr, table, [class*="record"], [class*="history"], [class*="hud"], #quant-ai-hud, [class*="assistant"], .van-popup');
      return !isExcluded && (el.offsetParent !== null || el.offsetWidth > 0);
    });

    const tgtLower = tgt.toLowerCase();

    // 1. Check data-type, data-bet, and specific class names
    let match = candidates.find(el => {
      const cls = (typeof el.className === 'string' ? el.className.toLowerCase() : '');
      const dtype = (el.getAttribute('data-type') || el.getAttribute('data-bet') || el.getAttribute('data-value') || '').toLowerCase();
      return dtype === tgtLower || cls.includes(`btn-${tgtLower}`) || cls.includes(`bet-${tgtLower}`) || cls.includes(`item-${tgtLower}`) || cls.includes(`type-${tgtLower}`);
    });
    if (match) return match.closest('button, [role="button"], [class*="btn"], .van-col, .bet-item') || match;

    // 2. Exact or rate-appended text matching (e.g. "BIG 1.98", "BIG\n1.98", "BIG", "GREEN 2", "RED 2", "0")
    match = candidates.find(el => {
      const t = (el.innerText || el.textContent || '').trim().toUpperCase();
      if (t.includes('PREP') || t.includes('QUANT') || t.includes('READY') || t.includes('AUTO') || t.includes('TIME')) return false;

      // Single digit number matching (0-9)
      if (/^[0-9]$/.test(tgt)) {
        return t === tgt || new RegExp(`^${tgt}(\\s|\\n|$)`).test(t);
      }

      // Word matching for BIG, SMALL, GREEN, RED, VIOLET
      return new RegExp(`^${tgt}(\\s|\\n|$)|^\\s*${tgt}\\b`).test(t) || t === tgt;
    });
    if (match) return match.closest('button, [role="button"], [class*="btn"], .van-col, .bet-item') || match;

    // 3. Fallback whole-page search (strictly excluding tables and HUD)
    const all = Array.from(document.querySelectorAll('button, div, span, [role="button"], .van-col')).filter(el => {
      return !el.closest('tr, table, [class*="record"], [class*="history"], #quant-ai-hud, [class*="assistant"]');
    });
    match = all.find(el => {
      const t = (el.innerText || el.textContent || '').trim().toUpperCase();
      return (t === tgt || new RegExp(`^${tgt}(\\s|\\n|$)`).test(t)) && !t.includes('PREP') && !t.includes('QUANT');
    });
    return match ? (match.closest('button, [role="button"], [class*="btn"], .van-col, .bet-item') || match) : null;
  }

  // ── 8. Vue 2/3 Reactive Input Setter & Stepper Adjuster ───────────────────────
  function setNativeInputValue(input, val) {
    if (!input) return;
    try {
      input.focus();
      const proto = Object.getPrototypeOf(input);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(input, String(val));
      } else {
        input.value = String(val);
      }
    } catch(e) {
      input.value = String(val);
    }
    ['focus', 'input', 'change', 'blur'].forEach(evtName => {
      try { input.dispatchEvent(new Event(evtName, { bubbles: true, composed: true })); } catch(e) {}
    });
  }

  function adjustStepperStake(activePopup, desiredStake) {
    if (!activePopup) return false;
    const targetStake = Math.max(1, Number(desiredStake) || 2);

    // 1. Select the ₹1 base unit chip (excludes stepper +/- buttons and any element inside .van-stepper)
    const chips = Array.from(activePopup.querySelectorAll('.van-button, div, span, [role="button"], button'));
    const chip1 = chips.find(el => {
      const t = (el.innerText || el.textContent || '').trim().replace(/\s/g, '');
      return (t === '1' || t === '₹1' || t === '1.00') &&
        !el.classList.contains('van-stepper__plus') &&
        !el.classList.contains('van-stepper__minus') &&
        !el.closest('.van-stepper');
    });
    if (chip1) {
      const isActive = chip1.classList.contains('active') || chip1.classList.contains('van-button--primary') ||
                       chip1.classList.contains('cur') || chip1.classList.contains('selected');
      if (!isActive) simulateClick(chip1);
    }

    // 2. Check for exact multiplier / quick stake buttons (e.g. X1, X2, X5, X10, X50, X100 or ₹2, ₹5, etc.)
    const quickButtons = chips.filter(el => {
      const t = (el.innerText || el.textContent || '').trim().toUpperCase();
      return (t === `X${targetStake}` || t === `${targetStake}` || t === `₹${targetStake}`) && !el.closest('.van-stepper');
    });
    if (quickButtons.length > 0) {
      simulateClick(quickButtons[0]);
    }

    // 3. Find stepper input and +/- buttons (prioritise van-stepper__input)
    const stepperInput = activePopup.querySelector(
      'input.van-stepper__input, input.amount-input, .van-stepper input, input[type="tel"], input[type="number"]'
    );
    const plusBtn  = activePopup.querySelector('.van-stepper__plus,  [class*="stepper__plus"], [class*="plus"]');
    const minusBtn = activePopup.querySelector('.van-stepper__minus, [class*="stepper__minus"], [class*="minus"]');

    if (stepperInput) {
      setNativeInputValue(stepperInput, targetStake);

      // Check immediately if value didn't stick (e.g. locked/readonly input)
      const immediateVal = parseInt(stepperInput.value, 10) || 0;
      const diff = targetStake - immediateVal;
      if (Math.abs(diff) > 0 && Math.abs(diff) <= 100) {
        const btn = diff > 0 ? plusBtn : minusBtn;
        if (btn) {
          for (let i = 0; i < Math.abs(diff); i++) {
            simulateClick(btn);
          }
        }
      }

    } else if (plusBtn) {
      // No text input at all — reset to 1 via minus, then step up
      if (minusBtn) {
        for (let i = 0; i < 50; i++) simulateClick(minusBtn);
      }
      for (let i = 0; i < Math.min(targetStake - 1, 100); i++) {
        simulateClick(plusBtn);
      }
    }

    // 4. Auto-check Terms Checkbox (required before DhaniWin allows confirm)
    const checkboxes = activePopup.querySelectorAll('.van-checkbox, input[type="checkbox"]');
    checkboxes.forEach(cb => {
      const isChecked = cb.classList.contains('van-checkbox--checked') || cb.checked;
      if (!isChecked) simulateClick(cb);
    });

    return !!(stepperInput || plusBtn || quickButtons.length > 0);
  }

  async function selectAndVerifyStake(activePopup, desiredStake) {
    const targetStake = Math.max(1, Number(desiredStake) || 2);
    const startedAt = Date.now();
    const deadline = startedAt + 3500;
    const stepperOnlyWaitMs = Math.min(3300, 850 + Math.max(0, targetStake - 1) * 35);
    let attemptedAdjustment = false;
    let stepperControlsSeen = false;

    while (Date.now() < deadline) {
      const popup = findActiveBetPopup() || activePopup;
      const input = popup.querySelector('input.van-stepper__input, input.amount-input, .van-stepper input, input[type="tel"], input[type="number"]');
      if (input) {
        const actual = Number(String(input.value || '').replace(/[^\d.]/g, ''));
        if (Number.isFinite(actual) && Math.abs(actual - targetStake) < 0.01) return true;
        if (!attemptedAdjustment) {
          attemptedAdjustment = adjustStepperStake(popup, targetStake);
        }
      } else {
        const hasStepper = popup.querySelector('.van-stepper__plus, [class*="stepper__plus"]');
        if (!hasStepper) {
          // If popup already open and Terms checked, accept adjustment attempt
          if (attemptedAdjustment) return true;
        } else {
          stepperControlsSeen = true;
        }
        if (!attemptedAdjustment) attemptedAdjustment = adjustStepperStake(popup, targetStake);
        if (Date.now() - startedAt >= stepperOnlyWaitMs) return attemptedAdjustment;
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    return attemptedAdjustment;
  }


  function findActiveBetPopup() {
    const popups = Array.from(document.querySelectorAll(
      '.van-popup, [class*="popup"], [class*="sheet"], [class*="drawer"], [role="dialog"]'
    )).filter(p => {
      if (p.id === 'quant-ai-hud' || p.closest('#quant-ai-hud') || p.id === 'dhaniwinAssistantModal' || p.id === 'fullScreenWinModal') return false;
      const isVisible = p.offsetParent !== null && window.getComputedStyle(p).display !== 'none' && window.getComputedStyle(p).visibility !== 'hidden';
      if (!isVisible) return false;
      // Must contain stepper, stake, or bet amount
      const hasStepperOrAmount = p.querySelector('.van-stepper, input.van-stepper__input, [class*="stepper"]') ||
        (p.innerText || p.textContent || '').includes('Total amount') ||
        (p.innerText || p.textContent || '').includes('Balance') ||
        (p.innerText || p.textContent || '').includes('Confirm');
      return hasStepperOrAmount;
    });
    return popups.length > 0 ? popups[popups.length - 1] : null;
  }

  function isRoundLockingSoon() {
    const countEls = Array.from(document.querySelectorAll('.time-box, [class*="countdown"], [class*="clock"], .van-count-down, .time-item, [class*="time"]'));
    for (const el of countEls) {
      const txt = (el.innerText || el.textContent || '').trim();
      if (/\b00:0[0-4]\b/.test(txt)) return true;
    }
    return false;
  }

  // ── 9. Core Auto-Betting Engine ─────────────────────────────────────────────
  async function executeRealBet(order) {
    if (!order || !order.target) return;
    const period = String(order.period || '');
    if (period && (period === lastDispatchedPeriod || processingPeriods.has(period))) return false;

    // 1. Guard against round lockout (< 5s left in active round)
    if (isRoundLockingSoon()) {
      console.log('[Quant AI Bridge] ⏳ Round is locking in <5s! Holding bet for the next round.');
      updateFloatingHud('⏳ Round Locked (<5s) • Waiting Next', 'amber');
      return false;
    }
    if (period) processingPeriods.add(period);

    // 2. Auto-close any stale popups/drawers left from previous missed rounds
    const stalePopups = document.querySelectorAll('.van-overlay, .van-popup__close-icon, [class*="overlay"], [class*="mask"]');
    stalePopups.forEach(el => {
      try { simulateClick(el); } catch(e) {}
    });

    const target = order.target.toUpperCase();
    const maxStake = Number(order.maxStake) || 999999;
    const requestedStake = Math.max(1, Number(order.stake) || 2);
    const stake = Math.min(requestedStake, maxStake);

    console.log('%c[Quant AI Bridge] ⚡ AUTO-PREPARING BET:', 'color:#f59e0b;font-weight:bold;', target, '₹' + stake);
    updateFloatingHud(`Selecting: ${target} ₹${stake}...`, 'amber');

    // 3. Wait for betting button to be rendered in DOM
    const btn = await waitForElement(() => findTargetButton(target), 3200, 50);
    if (!btn) {
      console.warn('[Quant AI Bridge] ❌ Bet button for ' + target + ' not found in DOM!');
      updateFloatingHud(`Btn ${target} Not Found`, 'rose');
      if (period) processingPeriods.delete(period);
      notifyApp({ type: 'DHANIWIN_BET_PREP_FAILED', period, target, reason: `Bet button ${target} not found` });
      return false;
    }

    console.log('[Quant AI Bridge] 🎯 Clicking bet button for:', target, btn);
    simulateClick(btn);

    // 4. Wait for popup sheet to mount and become visible
    const activePopup = await waitForElement(() => findActiveBetPopup(), 3000, 50);
    if (!activePopup) {
      if (period) processingPeriods.delete(period);
      updateFloatingHud('Bet amount sheet not found', 'rose');
      notifyApp({ type: 'DHANIWIN_BET_PREP_FAILED', period, target, reason: 'Bet amount sheet not found' });
      return false;
    }

    // 5. Adjust stake in popup
    const stakeSelected = await selectAndVerifyStake(activePopup, stake);
    const currentPopup = findActiveBetPopup() || activePopup;
    if (!stakeSelected) {
      if (period) processingPeriods.delete(period);
      updateFloatingHud(`Stake ₹${stake} not selected • Retry`, 'rose');
      notifyApp({ type: 'DHANIWIN_BET_PREP_FAILED', period, target, stake, reason: `Could not verify stake ₹${stake}` });
      return false;
    }
    if (period) {
      processingPeriods.delete(period);
      lastDispatchedPeriod = period;
    }

    // 6. Highlight Confirm Button for User Manual Click (STRICTLY MANUAL)
    setTimeout(() => {
      const buttons = Array.from(currentPopup.querySelectorAll('button, [role="button"], .van-button, [class*="submit"], [class*="confirm"]'));
      const confirmBtn = buttons.find(el => {
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        return (
          t.includes('confirm') ||
          t.includes('place bet') ||
          t.includes('bet now') ||
          t.includes('presale') ||
          (el.className && typeof el.className === 'string' && (el.className.includes('van-button--danger') || el.className.includes('submit') || el.className.includes('confirm')))
        );
      }) || Array.from(currentPopup.querySelectorAll('.van-button--danger, .van-button--primary, button[type="submit"]')).find(el => !el.disabled);

      if (confirmBtn && !confirmBtn.disabled && confirmBtn.getAttribute('aria-disabled') !== 'true') {
        if (order.manualConfirm === true) {
          confirmBtn.style.outline = '3px solid #10b981';
          confirmBtn.style.boxShadow = '0 0 32px rgba(16, 185, 129, 0.95)';
          confirmBtn.style.animation = 'autoBetShake 0.65s ease-in-out infinite';
          confirmBtn.classList.add('auto-bet-shake');
          confirmBtn.style.transform = 'scale(1.04)';
          confirmBtn.style.transition = 'all 0.25s ease';
          updateFloatingHud(`👉 TAP BET NOW: ${target} ₹${stake}`, 'emerald');
          notifyApp({ type: 'DHANIWIN_BET_PREPARED', period, target, stake, timestamp: Date.now() });

          // Tactical haptic vibration on supported devices
          if (typeof navigator !== 'undefined' && navigator.vibrate) {
            try { navigator.vibrate([120, 80, 120]); } catch(e) {}
          }

          // Safety Lockout Monitor: if user doesn't confirm before <5s remaining, cancel & close sheet
          let userConfirmed = false;
          let lockoutCheckInterval = setInterval(() => {
            if (userConfirmed) {
              clearInterval(lockoutCheckInterval);
              return;
            }
            if (isRoundLockingSoon()) {
              clearInterval(lockoutCheckInterval);
              console.log('[Quant AI Bridge] ⚠️ Lockout window reached (<5s)! Auto-cancelling unconfirmed bet.');
              updateFloatingHud('⏳ Lockout (<5s) • Bet Cancelled', 'amber');
              const closeIcon = currentPopup.querySelector('.van-popup__close-icon, .van-icon-cross, [class*="close-icon"], .dialog-close');
              if (closeIcon) {
                simulateClick(closeIcon);
              } else {
                const overlay = document.querySelector('.van-overlay');
                if (overlay) simulateClick(overlay);
              }
              confirmBtn.style.animation = '';
              confirmBtn.classList.remove('auto-bet-shake');
              notifyApp({ type: 'DHANIWIN_BET_CANCELLED', period, target, stake, reason: 'Round lockout (<5s)' });
            }
          }, 300);

          confirmBtn.addEventListener('click', function onUserConfirm() {
            userConfirmed = true;
            clearInterval(lockoutCheckInterval);
            confirmBtn.style.animation = '';
            confirmBtn.classList.remove('auto-bet-shake');
            updateFloatingHud(`✅ Bet Placed: ${target} ₹${stake}`, 'emerald');
            notifyApp({ type: 'DHANIWIN_BET_CONFIRMATION', success: true, period, target, stake, timestamp: Date.now() });
          }, { once: true });
        } else {
          simulateClick(confirmBtn);
          updateFloatingHud(`✅ Bet Placed: ${target} ₹${stake}`, 'emerald');
          notifyApp({ type: 'DHANIWIN_BET_CONFIRMATION', success: true, period, target, stake, timestamp: Date.now() });
        }
      } else {
        if (period) lastDispatchedPeriod = null;
        updateFloatingHud(`Confirm button not found for ₹${stake}`, 'rose');
        notifyApp({ type: 'DHANIWIN_BET_PREP_FAILED', period, target, stake, reason: 'Confirm button not found' });
      }
    }, 400);
    return true;
  }

  // Expose automation suite for testing and verification
  if (typeof window !== 'undefined') {
    window.__QuantBridgeAutomation = {
      simulateClick,
      waitForElement,
      findBettingContainer,
      findTargetButton,
      adjustStepperStake,
      findActiveBetPopup,
      isRoundLockingSoon,
      executeRealBet
    };
  }

  // ── 10. Signal Receiver (Cross-Window & BroadcastChannel) ────────────────────
  function handleIncomingOrder(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'UPDATE_BET_SETTINGS') {
      const nextStake = Number(msg.stake);
      const nextMaxStake = Number(msg.maxStake);
      if (Number.isFinite(nextStake) && nextStake > 0) configuredStake = nextStake;
      if (Number.isFinite(nextMaxStake) && nextMaxStake > 0) configuredMaxStake = nextMaxStake;
      hasAppBetSettings = true;
      if (msg.timeframe && INTERVAL_URL_MAP[msg.timeframe]) activeTimeframe = msg.timeframe;
    } else if (msg.type === 'WINGO_SWITCH_TIMEFRAME') {
      activeTimeframe = msg.timeframe;
      const targetPath = INTERVAL_URL_MAP[msg.timeframe] || '/WinGo/WinGo_30S';
      if (!window.location.href.toLowerCase().includes(targetPath.toLowerCase())) {
        console.log('[Quant AI Bridge] Switching interval page to:', targetPath);
        // Round 3 — ROOT-CANONICAL (replaces the round-2
        // prefix-aware logic; do not leave both): the timeframe
        // page lives at origin + targetPath (targetPath is
        // root-absolute), on worker-root and direct hosts alike.
        // The href guard above already handles legacy prefixed
        // pages by falling through to switchTimerTab.
        window.location.href = window.location.origin + targetPath;
      } else {
        switchTimerTab(msg.timeframe);
      }
    } else if (msg.type === 'EXECUTE_REAL_BET' && msg.enabled) {
      executeRealBet(msg);
    } else if (msg.type === 'DHANIWIN_REQUEST_SYNC') {
      console.log('[Quant AI Bridge] 🔄 Sync requested by app — probing wallet API & DOM...');
      const refreshBtn = findWalletRefreshButton();
      if (refreshBtn) simulateClick(refreshBtn);
      const domBal = scrapeRealBalanceFromDOM();
      if (domBal !== null) {
        _userState.noteDomBalance(domBal, Date.now());
        onRealBalanceDetected(domBal, 'dom-sync');
      }
      // Actively re-query the learned wallet endpoint too — the app
      // asked for a sync, so give it the API-proven answer, not just
      // whatever the page happens to show.
      activeWalletPoll();
      scrapeUserSession();
    } else if (msg.type === 'DHANIWIN_REQUEST_AUTH_CHECK') {
      console.log('[Quant AI Bridge] 🔍 Auth check requested by app...');
      const authResult = performRealAuthInspection();
      notifyApp({
        type: 'DHANIWIN_AUTH_CHECK_RESULT',
        loggedIn: authResult.loggedIn,
        user: authResult.user,
        balance: authResult.balance,
        reason: authResult.reason,
        timestamp: Date.now()
      });
    }
  }

  function performRealAuthInspection() {
    let token = null;
    let userId = null;
    try {
      token = localStorage.getItem('token') || sessionStorage.getItem('token') || localStorage.getItem('authorization') || localStorage.getItem('accessToken');
      userId = localStorage.getItem('userId') || localStorage.getItem('user_id') || sessionStorage.getItem('userId');
    } catch(e) {}

    const domBal = scrapeRealBalanceFromDOM();
    const hasLogoutBtn = !!document.querySelector('.logout-btn, button[class*="logout"], [class*="login-out"], [class*="loginout"]');
    const isLoginPage = window.location.pathname.toLowerCase().includes('/login') || window.location.pathname.toLowerCase().includes('/register');
    const hasPasswordInput = !!document.querySelector('input[type="password"]');

    if (isLoginPage || hasPasswordInput) {
      return { loggedIn: false, reason: 'User is currently on the login or registration page' };
    }

    if (token || (domBal !== null && domBal >= 0) || hasLogoutBtn || userId) {
      return {
        loggedIn: true,
        user: userId || 'verified_member',
        balance: domBal !== null ? domBal : null
      };
    }

    return { loggedIn: false, reason: 'No active session token or member profile detected' };
  }

  // ── 12. User State Engine: publish + session-powered active polling ──
  // The published state is how the app KNOWS login + exact balance
  // instead of guessing: it goes out on every transport the bridge has
  // (BroadcastChannel + window postMessage via notifyApp, and Firebase
  // RTDB /user_state following the codebase's plain-.json convention —
  // written on change plus a 15s heartbeat so its freshness is
  // provable). The state NEVER contains the session token.
  //
  // ACTIVE POLLING: interception alone is passive — it only learns
  // the balance when the page happens to call the wallet API. So the
  // bridge also RE-QUERIES the learned balance-bearing endpoint from
  // inside this page, with the user's already-logged-in session (the
  // same data path Telegram bots use with an account token, minus any
  // password: no credential is ever collected or stored — the query
  // rides the live session/cookies of this very page, and when the
  // token rides in a header it is read fresh from page storage at
  // query time and never leaves this page's context). A successful
  // authenticated response is both the exact balance AND the login
  // proof. A 401/403/auth-error response is a logged-out signal and
  // drops the bridge back to interception-only until a fresh
  // intercepted wallet call succeeds again.
  let _userStateSeq = 0;
  let _lastRtdbPutKey = '';
  let _lastRtdbPutAt = 0;

  function publishUserState(reason) {
    try {
      const st = _userState.buildState(Date.now());
      const payload = { type: 'DHANIWIN_USER_STATE', ...st, ts: Date.now(), seq: ++_userStateSeq };
      notifyApp(payload);
      // Cross-document seed (Fix 5b): persist the login flags for
      // the next document in this tab session. Balance is not
      // seeded (see the seed block above).
      try { sessionStorage.setItem(USER_STATE_SEED_KEY, JSON.stringify({ isLoggedIn: st.isLoggedIn, apiProven: st.apiProven, ts: Date.now() })); } catch (e) {}
      const key = JSON.stringify([st.isLoggedIn, st.balance, st.balanceSource, st.apiProven, st.fetchMode, st.userId, st.betSlipOpen]);
      const now = Date.now();
      if (key !== _lastRtdbPutKey || now - _lastRtdbPutAt >= 15000) {
        _lastRtdbPutKey = key;
        _lastRtdbPutAt = now;
        rtdbPutUserState(st, payload.ts, payload.seq);
      }
      return st;
    } catch (e) { return null; }
  }

  function rtdbPutUserState(st, ts, seq) {
    if (!_nativeFetch) return;
    try {
      _nativeFetch(`${RTDB_BASE_URL}/user_state.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...st, ts, seq })
      }).catch(() => {});
    } catch (e) {}
  }

  let _activePollInFlight = false;
  async function activeWalletPoll() {
    const desc = _userState.endpoint;
    if (!desc || !_nativeFetch || _activePollInFlight) return;
    if (_userState.pollAuthFailed) return; // intercept-only until a fresh intercepted success re-arms
    // Fix 8 (Grok refinement): replay only GET endpoints. Header
    // mode requires a header name (and a live token, checked below);
    // cookie mode MAY replay with credentials included — the cookie
    // IS the credential there, so disabling cookie-mode replay
    // outright would drop the poll for cookie sessions. A POST
    // replay sends no body and is never valid. In BOTH modes a
    // failed replay is diagnostic only (notePollAuthFailure): it
    // never sets explicitLogoutAt and never downgrades the login
    // state.
    if (desc.method !== 'GET' || (desc.tokenMode === 'header' && !desc.headerName)) return;
    _activePollInFlight = true;
    try {
      const headers = {};
      if (desc.tokenMode === 'header' && desc.headerName) {
        const token = readSessionToken();
        if (!token) return; // no live session to power the query
        headers[desc.headerName] = (desc.scheme ? desc.scheme + ' ' : '') + token;
      }
      const resp = await _nativeFetch(desc.url, { method: desc.method, headers, credentials: 'include' });
      if (resp.status === 401 || resp.status === 403) {
        // Failed replay: intercept-only from here, never a logout.
        _userState.notePollAuthFailure(Date.now());
        publishUserState('poll-auth-fail');
        return;
      }
      let data = null;
      try { data = await resp.json(); } catch (e) {}
      if (data && typeof data === 'object') {
        // Round 3: the SAME fixed error gate as the payload handler
        // (coerced codes, auth message regardless of success) —
        // a failed replay is diagnostic only, never a logout.
        if (isAuthErrorBody(data)) {
          _userState.notePollAuthFailure(Date.now());
          publishUserState('poll-auth-fail');
          return;
        }
        // Round 3 failed-op decoupling: success:false (non-auth)
        // proves the session is alive but carries no balance — it
        // must not overwrite a verified balance via the poll.
        if (data.success === false) {
          _userState.noteActivePoll({ verdict: 'ok', balance: null, balanceQualified: false, userId: extractUserIdFromJson(data) }, Date.now());
          publishUserState('poll-ok');
          return;
        }
        // Round 3: strict extraction + the same zero-provenance
        // test as the payload handler, against the learned
        // endpoint's own URL. An unqualified replay value (e.g. a
        // user-info endpoint returning strict 0) proves the
        // session but refreshes NO displayed balance.
        const strictBal = extractBalanceFromJson(data);
        const userId = extractUserIdFromJson(data);
        if (strictBal !== null || userId) {
          const balanceQualified = strictBal !== null
            && (strictBal > 0 || urlHasWalletOrBalance(desc.url));
          _userState.noteActivePoll({ verdict: 'ok', balance: balanceQualified ? strictBal : null, balanceQualified, userId }, Date.now());
          if (balanceQualified) onRealBalanceDetected(strictBal, 'active-poll');
          publishUserState('poll-ok');
          return;
        }
      }
      _userState.noteActivePoll({ verdict: 'empty' }, Date.now());
      publishUserState('poll-empty');
    } catch (e) {
      // Network error is NOT a logout signal; interception remains
      // the source until the endpoint answers again.
    } finally {
      _activePollInFlight = false;
    }
  }

  setInterval(() => publishUserState('heartbeat'), 15000);
  setInterval(() => { activeWalletPoll(); }, 20000);
  setTimeout(() => publishUserState('init'), 1200);

  // ── Bet-slip watcher → parent dock auto-hide (Addition 3) ──────
  // The slip lives in THIS page; the parent app's bottom dock floats
  // over its Total/Cancel row. A debounced MutationObserver watches
  // for the slip's open/close transitions and posts exactly one
  // O101_BETSLIP message per transition; the current state also
  // rides the regular state publish (betSlipOpen) so a late-loading
  // parent can sync. A slow interval backstop catches transitions
  // that mutate nothing observable.
  const _betSlipDetector = createBetSlipDetector(document, window);
  const _betSlipWatcher = createBetSlipWatcher(_betSlipDetector, (open) => {
    _userState.betSlipOpen = open;
    try { notifyApp({ type: 'O101_BETSLIP', open, ts: Date.now() }); } catch (e) {}
    publishUserState('betslip');
  });
  let _betSlipDebounce = null;
  function checkBetSlip() {
    try { _betSlipWatcher.check(); } catch (e) {}
  }
  try {
    const _betSlipObserver = new MutationObserver(() => {
      if (_betSlipDebounce) return;
      _betSlipDebounce = setTimeout(() => { _betSlipDebounce = null; checkBetSlip(); }, 150);
    });
    _betSlipObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  } catch (e) {}
  setInterval(checkBetSlip, 2000);
  setTimeout(checkBetSlip, 1500);

  if (channel) channel.onmessage = (ev) => handleIncomingOrder(ev.data);
  window.addEventListener('message', (ev) => handleIncomingOrder(ev.data));

  // ── 11. Cloud Universal Brain Standalone Realtime Poller ─────────────────────
  // Connects directly to Firebase RTDB — works even without BroadcastChannel
  let lastCloudPeriod = null;
  async function pollCloudPrediction() {
    try {
      const url = `https://zer0one-376d1-default-rtdb.asia-southeast1.firebasedatabase.app/universal_state/${activeTimeframe}.json`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const state = await resp.json();
      if (!state || !state.target) return;

      const p = String(state.targetPeriod || state.period || '');
      if (!p) return;
      if (p === lastCloudPeriod) return; // Already handled this round

      // The app and DhaniWin run on different origins, so their localStorage is isolated.
      let stake = configuredStake;
      let maxStake = configuredMaxStake;
      try {
        const s = localStorage.getItem('dhaniwin_active_stake');
        if (s && Number(s) > 0) stake = Number(s);
        const ms = localStorage.getItem('dhaniwin_max_stake');
        if (ms && Number(ms) > 0) maxStake = Number(ms);
      } catch(e) {}
      if (hasAppBetSettings) {
        stake = configuredStake;
        maxStake = configuredMaxStake;
      }

      // Skip low-confidence predictions if confidence is provided
      const rawConfidence = state.targetConfidence !== undefined ? state.targetConfidence : state.conf;
      const confidence = rawConfidence === undefined ? undefined : (Number(rawConfidence) > 1 ? Number(rawConfidence) / 100 : Number(rawConfidence));
      if (confidence !== undefined && confidence < 0.55) {
        console.log(`[Quant AI Bridge] ⚠️ Skipping low-confidence prediction: ${state.target} conf=${confidence}`);
        updateFloatingHud(`⚠️ Skipped (Low Conf ${Math.round(confidence * 100)}%)`, 'amber');
        return;
      }

      updateFloatingHud(`🧠 Cloud Signal: ${state.target} ₹${stake}`, 'emerald');
      const prepared = await executeRealBet({
        target: state.target,
        period: p,
        stake: stake,
        maxStake: maxStake,
        manualConfirm: true,
        timeframe: activeTimeframe,
        conf: confidence
      });
      if (prepared) lastCloudPeriod = p;
    } catch(e) {}
  }

  // Adaptive polling: 1.5s for fast 30s rounds, 2.5s for slower intervals
  function startAdaptivePoller() {
    let lastTf = activeTimeframe;
    let pollTimer = null;
    function getInterval() { return activeTimeframe === '30s' ? 1500 : 2500; }
    function scheduleNext() {
      pollTimer = setTimeout(async () => {
        await pollCloudPrediction();
        // If timeframe changed, restart with new interval
        if (activeTimeframe !== lastTf) { lastTf = activeTimeframe; }
        scheduleNext();
      }, getInterval());
    }
    scheduleNext();
  }
  startAdaptivePoller();

  // Report scroll direction to the host app (drives its Home top-bar auto-hide and dock restoration).
  // 'up' = finger swipes up (content advances down), 'down' = finger swipes down (user scrolls UP).
  (function startScrollReporter() {
    let lastY = window.scrollY || 0;
    let lastDir = null;
    let lastReportTime = 0;

    const report = (dir) => {
      const now = Date.now();
      // Allow reporting if direction changed, OR if scrolling UP ('down') repeatedly after a brief throttle
      if (dir === lastDir && dir !== 'down' && (now - lastReportTime < 500)) return;
      if (dir === 'down' && (now - lastReportTime < 80)) return; // Light throttle on fast scroll-ups
      lastDir = dir;
      lastReportTime = now;
      notifyApp({ type: 'DHANIWIN_SCROLL', direction: dir, timestamp: now });
    };

    window.addEventListener('scroll', (e) => {
      const target = e.target === document ? window : (e.target || window);
      const y = target.scrollY !== undefined ? target.scrollY : (target.scrollTop || 0);
      if (Math.abs(y - lastY) < 8) return;
      report(y > lastY ? 'up' : 'down');
      lastY = y;
    }, { capture: true, passive: true });

    let ty = null;
    window.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches[0]) {
        ty = e.touches[0].clientY;
      }
      lastDir = null; // Always allow the next swipe gesture to be reported
    }, { capture: true, passive: true });

    window.addEventListener('touchmove', (e) => {
      if (ty === null || !e.touches || !e.touches[0]) return;
      const dy = e.touches[0].clientY - ty;
      if (Math.abs(dy) > 12) {
        report(dy < 0 ? 'up' : 'down');
        ty = e.touches[0].clientY;
      }
    }, { capture: true, passive: true });
  })();

  // Report touch/tap anywhere inside DhaniWin to dismiss/hide the floating main menu
  (function startTouchReporter() {
    let touchStartY = null;
    let touchStartX = null;
    let isScrolling = false;

    window.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches[0]) {
        touchStartY = e.touches[0].clientY;
        touchStartX = e.touches[0].clientX;
      }
      isScrolling = false;
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (touchStartY !== null && e.touches && e.touches[0]) {
        const dy = Math.abs(e.touches[0].clientY - touchStartY);
        const dx = Math.abs(e.touches[0].clientX - (touchStartX || 0));
        if (dy > 12 || dx > 12) {
          isScrolling = true;
        }
      }
    }, { passive: true });

    window.addEventListener('touchend', () => {
      if (!isScrolling) {
        notifyApp({ type: 'DHANIWIN_TOUCH', timestamp: Date.now() });
      }
      touchStartY = null;
      touchStartX = null;
      isScrolling = false;
    }, { passive: true });

    // Also support pointer/mouse clicks
    window.addEventListener('click', () => {
      notifyApp({ type: 'DHANIWIN_TOUCH', timestamp: Date.now() });
    }, { passive: true });
  })();

})();


