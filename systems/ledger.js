/**
 * systems/ledger.js — Recovery Ledger (Phase 3E, owner-approved design
 * ~/workspace/0101-v2/analysis/model-bench-trend-design.md §11, owner
 * 2026-10-27 ~10:44 IST "Yes start").
 *
 * SOLE STAKE AUTHORITY. The ledger SUBSUMES the session ladder: the
 * 3D ladder-doubling code is REPLACED by ledger sizing, not layered
 * under it. Running both would double-count losses (ladder progression
 * + ledger growth on the same loss). settle()/replanSession() in
 * bankroll.js still keep session bookkeeping (balance, P&L, loss-run
 * counter); the STAKE figure they compute is overwritten by the ledger
 * figure before any display, staging, or persistence — see
 * orb-bridge.js (ledger resize step + settlement block). The doubling
 * figure never reaches display, staging, or storage.
 *
 * Model: one ledger per type (COLOR, SIZE; exact stays empty while
 * exact bets are locked under O4). Tracks ALL app-staged settled loss
 * money, across sessions. Loss adds the exact stake staked; a win
 * subtracts the exact profit (0.96 x stake, colour/size). The ledger
 * floors at 0 — excess profit is profit, never a negative ledger.
 * Resets ONLY when profit covers it, or by the owner's explicit reset
 * (Settings, with confirmation). Never on reload, session end, date
 * change, or app update. Manual DhaniWin-surface bets are NOT in it
 * (the app cannot see them) and display says so.
 *
 * Confidence-weighted recovery stake (exact function, §11.2/§11.4):
 *   w = 0.25 + 0.75 x clamp((W - R) / (W_top - R), 0, 1)
 *   S = w x max(base, L / 0.96), CEIL to whole Rs, min Rs 1.
 * W = the bet driver's Wilson lower bound (defended chance); R = the
 * type's bar (colour/size 53.02% = breakeven 1/1.96 + 2% margin; exact
 * 13.34% PROPOSAL, payout unverified — exact ledger stays empty until
 * O4 closes). W_top = 75% (colour/size) / 30% (exact proposal).
 * Below bar -> 0.25x floor, never 0x under no-skip.
 * Worked (base Rs 10, L = Rs 100): W 60% -> Rs 51 (win leaves Rs 51.04);
 * at bar -> Rs 27 (leaves Rs 74.08); 75%+ -> Rs 105 (clears + Rs 0.80).
 *
 * Ruin math (§11.5, honest limit): each failed recovery grows the
 * ledger x2.0417 (L' = L + L/0.96). Unbounded recovery against a
 * finite balance cannot be guaranteed. Over-balance is DISPLAYED
 * (required + shortfall + capped stake); the user decides — never a
 * silent reduction, never a SKIP/STOP.
 *
 * Storage keys: o101_ledger_v1_<TYPE> (localStorage, same family as
 * o101_session_v1_<TYPE>). Pure functions take no storage; the store
 * helpers take a storage object (null-safe: memory no-op).
 */

/** Profit multiple for colour/size (pinned Phase 3A: lose-then-win at
 *  base B nets +0.92B; lose-lose-win +0.84B). Exact multiple is NOT
 *  verified (O4 open) — do NOT use this constant for exact bets. */
export const LEDGER_PAYOUT = 0.96;

/** Per-type bar R (the bar a Wilson bound is measured against). */
export function barFor(type) {
  if (type === 'NUMBER') return 1 / (1 + 7.82); // 11.34% PROPOSAL, O4 open
  return 1 / 1.96 + 0.02; // colour/size: 51.02% + 2% margin = 53.02%
}

/** Per-type W_top for the weighting curve (exact is a proposal). */
export function topFor(type) {
  return type === 'NUMBER' ? 0.30 : 0.75;
}

export function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/**
 * Confidence weight w for a Wilson bound W (0..1) on a type.
 * Null/NaN W (no pool entry) -> 0.25 floor. Below bar -> 0.25 floor.
 * At bar -> 0.25; 55% -> 0.32; 60% -> 0.49; 65% -> 0.66; >=75% -> 1.00
 * (colour/size; exact uses its proposal bar/top).
 */
export function ledgerWeight(W, type) {
  if (!Number.isFinite(W)) return 0.25;
  const R = barFor(type);
  const Wtop = topFor(type);
  return 0.25 + 0.75 * clamp01((W - R) / (Wtop - R));
}

/**
 * Recovery stake — REDESIGNED (owner order 2026-10-30 ~01:06 IST).
 * Explicit doubling ladder with a high-chance gate, never-₹0 floor
 * and never-zero-balance guard. This SUPERSEDES the Phase 3E
 * weight-throttled sizing (S = w x max(base, L/0.96)) per the owner's
 * explicit word on the stake system. New signature:
 * ledgerStake(base, lossRun, W) — base = session base bet (≥ ₹1),
 * lossRun = consecutive losses (0-based int), W = driver's Wilson
 * lower bound (null/NaN = not high chance). The Recovery Ledger's
 * loss-money record (L) keeps updating as bookkeeping; it no longer
 * sizes stakes. See ladderStake / stakeWithGuards / the plan doc
 * ~/workspace/0101-v2/analysis/stake-redesign-plan.md.
 */
export function ledgerStake(base, lossRun, W) {
  return ladderStake(base, lossRun, W).stake;
}

/**
 * Ledger update on a staged settled bet. Loss: L += stake. Win:
 * L = max(0, L - 0.96 x stake). Returns { L, recovered, left } where
 * recovered = the profit applied to the ledger on a win (0 on loss),
 * left = L after the update. Exact payout must be its VERIFIED
 * multiple — callers pass payout only when O4 has closed; the default
 * is the colour/size 0.96.
 */
export function applyLedgerResult(L, stake, won, payout = LEDGER_PAYOUT) {
  const before = Number.isFinite(L) && L > 0 ? L : 0;
  const s = Number.isFinite(stake) && stake > 0 ? stake : 0;
  if (!won) return { L: before + s, recovered: 0, left: before + s };
  const profit = payout * s;
  const after = Math.max(0, before - profit);
  return { L: after, recovered: before - after, left: after };
}

/** Profit a win on this stake would apply to the ledger (display). */
export function recoveryIfWin(L, stake, payout = LEDGER_PAYOUT) {
  const before = Number.isFinite(L) && L > 0 ? L : 0;
  const s = Number.isFinite(stake) && stake > 0 ? stake : 0;
  return Math.min(before, payout * s);
}

/** Display ledger line for the hero detail: tracked loss + recovery
 *  portion of this stake (what a win on this stake would recover).
 *  Owner order 2026-10-27: ONE short line only ("Ledger ₹X ·
 *  recovers ₹Y") — the old "this stake recovers" wording is gone. */
export function ledgerLineFor(L, stake) {
  const before = Number.isFinite(L) && L > 0 ? L : 0;
  const s = Number.isFinite(stake) && stake > 0 ? stake : 0;
  const rec = recoveryIfWin(before, s);
  const recText = rec === Math.floor(rec) ? String(rec) : rec.toFixed(2);
  const lText = before === Math.floor(before) ? String(before) : before.toFixed(2);
  return `Ledger \u20B9${lText} \u00B7 recovers \u20B9${recText}`;
}

/** Derived ladder level index for display continuity: log2(S/base),
 *  rounded to the nearest rung, floored at 0. S = base -> 0 (Level 1).
 *  The session loss-run counter is bookkeeping only; display uses this.
 */
export function ledgerLevelIndex(S, base) {
  if (!Number.isFinite(S) || !Number.isFinite(base) || S <= 0 || base <= 0) return 0;
  return Math.max(0, Math.round(Math.log2(S / base)));
}

/** Over-balance display (never silent, never blocking): required stake
 *  vs a known finite positive balance. Returns null when the balance
 *  is unknown (balance-free chip sessions get no invented shortfall)
 *  or the required stake fits. { required, shortfall, capped }. */
export function overBalanceInfo(required, knownBalance) {
  const r = Number.isFinite(required) && required > 0 ? required : 0;
  const b = Number.isFinite(knownBalance) && knownBalance > 0 ? knownBalance : null;
  if (b === null || r <= b) return null;
  return { required: r, shortfall: r - b, capped: b };
}

// ---- Persistence (storage null-safe) ----

export function ledgerKey(type) {
  return `o101_ledger_v1_${String(type || 'COLOR').toUpperCase()}`;
}

export function loadLedger(storage, type) {
  try {
    if (!storage) return 0;
    const raw = storage.getItem(ledgerKey(type));
    const v = raw === null ? 0 : Number(raw);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch (e) { return 0; }
}

export function saveLedger(storage, type, L) {
  try {
    if (!storage) return;
    const v = Number.isFinite(L) && L > 0 ? L : 0;
    storage.setItem(ledgerKey(type), String(v));
  } catch (e) { /* storage unavailable: ledger stays in-memory only */ }
}

/** Owner's explicit reset (Settings, with confirmation in the UI). */
export function resetLedger(storage, type) {
  try { if (storage) storage.removeItem(ledgerKey(type)); } catch (e) { /* ignore */ }
}

/**
 * One-call resize — REDESIGNED (owner order 2026-10-30 ~01:06 IST).
 * Given session base, consecutive-loss run, driver Wilson, type and a
 * known balance, returns { stake, required, level, levelIndex, gated,
 * weight, over } where level is the 1-based display level (1..6),
 * levelIndex the 0-based index (kept for existing readers), gated is
 * true when the high-chance gate held the stake at base, weight is
 * the ledger weight (display context only — it no longer sizes the
 * stake), and over is the required/shortfall/capped triple (or null).
 * The stake is NEVER ₹0; over-balance is never silent.
 */
export function ledgerResize(base, lossRun, W, type, knownBalance) {
  const { stake, gated } = ladderStake(base, lossRun, W);
  const guards = stakeWithGuards(stake, knownBalance);
  const k = Math.max(0, Math.floor(Number(lossRun) || 0));
  const level = gated ? 1 : Math.min(k, LADDER_LEVELS - 1) + 1;
  return {
    stake: guards.stake,
    required: guards.required,
    level,
    levelIndex: level - 1,
    gated,
    weight: ledgerWeight(W, type),
    over: guards.shortfall !== null
      ? { required: guards.required, shortfall: guards.shortfall, capped: guards.capped }
      : null,
  };
}

// ── Stake ladder redesign (owner order 2026-10-30 ~01:06 IST) ────────
// Explicit doubling ladder with a high-chance gate, never-₹0 floor and
// never-zero-balance guard. Honest limits (see the plan doc): doubling
// changes variance, not EV (EV ≈ −2% of stake at noise); the gate
// concentrates deep rungs where the measured chance is strongest.

/** Doubling levels: base × 2^0 … base × 2^5 (5–6 levels per spec). */
export const LADDER_LEVELS = 6;
/** "High chance": driver's Wilson lower bound ≥ 60% (7 pts above the
 *  53.02% bar; Kelly-positive territory at 0.96 payout). Tunable on
 *  the owner's word. */
export const HIGH_CHANCE_WILSON = 0.60;
/** The gate engages at 5 consecutive losses (the 6th bet): doubling
 *  continues only on high chance, otherwise the stake falls back to
 *  base — shown plainly, never ₹0, never a stop. */
export const DOUBLING_GATE_LOSSES = 5;
/** NEVER show stake ₹0 (owner order): hard floor on every stake. */
export const MIN_STAKE = 1;
/** Never-zero-balance: this fraction of a known balance is never
 *  staked (min ₹1). Tunable on the owner's word. */
export const RESERVE_FRACTION = 0.10;

/** True when the driver's Wilson bound clears the high-chance bar. */
export function isHighChance(W) {
  return Number.isFinite(W) && W >= HIGH_CHANCE_WILSON;
}

/**
 * Raw doubling stake for a loss run (pure). Returns { stake, gated }.
 * k = 0..4: unconditional doubling (base × 2^k). k ≥ 5: double (held
 * at 32×, exposure capped) only on high chance, else base. The
 * loss-run counter keeps counting past 6 — the STAKE never grows
 * past level 6. A win resets k to 0 (session bookkeeping). Never ₹0.
 */
export function ladderStake(base, lossRun, W) {
  const b = Math.max(MIN_STAKE, Math.floor(Number(base) || MIN_STAKE));
  const k = Math.max(0, Math.floor(Number(lossRun) || 0));
  if (k >= DOUBLING_GATE_LOSSES && !isHighChance(W)) return { stake: b, gated: true };
  const kEff = Math.min(k, LADDER_LEVELS - 1);
  return { stake: Math.max(MIN_STAKE, b * Math.pow(2, kEff)), gated: false };
}

/**
 * Never-zero-balance cap: the largest stake that keeps at least the
 * reserve in the balance. Null when the balance is unknown or ≤ ₹1
 * (no invented figures).
 */
export function neverZeroCap(balance) {
  const b = Number(balance);
  if (!Number.isFinite(b) || b <= 1) return null;
  const reserve = Math.max(1, Math.round(b * RESERVE_FRACTION));
  const cap = Math.floor(b - reserve);
  return cap >= MIN_STAKE ? cap : null;
}

/**
 * Apply the balance guards to a required stake (pure). Returns
 * { stake, required, shortfall, capped }: stake is what the app
 * stages/displays (NEVER ₹0); required is the ungated figure;
 * shortfall/capped are null when everything fits. Unknown balance →
 * no cap, no shortfall invented. Over-balance is never silent and
 * never blocks — the user confirms each bet with the per-bet tap.
 */
export function stakeWithGuards(required, balance) {
  const r = Math.max(MIN_STAKE, Math.ceil(Number(required) || MIN_STAKE));
  const b = Number(balance);
  if (!Number.isFinite(b) || b <= 0) {
    return { stake: r, required: r, shortfall: null, capped: null };
  }
  if (b < 1) {
    // Dust balance: the ₹1 floor still stages, but the gap vs the
    // real balance is shown plainly — never silent, never ₹0.
    return { stake: r, required: r, shortfall: Math.round((r - b) * 100) / 100, capped: Math.round(b * 100) / 100 };
  }
  const cap = neverZeroCap(b);
  const effCap = cap !== null ? cap : Math.max(MIN_STAKE, Math.floor(b));
  if (r <= effCap) return { stake: r, required: r, shortfall: null, capped: null };
  return {
    stake: effCap,
    required: r,
    shortfall: Math.round((r - effCap) * 100) / 100,
    capped: effCap,
  };
}

/**
 * Sizing-balance precedence (pure, testable): fresh verified bridge
 * balance (ground truth) → typed balance (the user's explicit input
 * this session) → none. A stale number never beats the user's typed
 * input; nothing is invented when neither exists.
 */
export function pickSizingBalance({ verified = null, verifiedFresh = false, typed = null } = {}) {
  const v = Number(verified);
  if (verifiedFresh && Number.isFinite(v) && v > 0) return v;
  const t = Number(typed);
  if (Number.isFinite(t) && t > 0) return t;
  return null;
}

/**
 * Balance-ask trigger (pure, testable): ask on reload when there is
 * no fresh verified balance and no typed balance, unless the user
 * already dismissed the ask this session.
 */
export function shouldAskBalance({ verifiedFresh = false, typed = null, dismissed = false } = {}) {
  if (dismissed) return false;
  if (verifiedFresh) return false;
  const t = Number(typed);
  if (Number.isFinite(t) && t > 0) return false;
  return true;
}

// ── Long-term P&L tracking (owner order 2026-10-30 ~01:06 IST) ───────
// Cumulative NET profit/loss per type, persisted across sessions.
// Updated on every staged settled bet: win → +0.96×stake, loss →
// −stake. Can go negative (honest). Reset ONLY by the owner's explicit
// Settings reset — never on reload, session end, date change, or app
// update. Manual DhaniWin-surface bets are invisible to the app and
// are NOT in it (the P&L box title says so).

export function pnlKey(type) {
  return `o101_pnl_v1_${String(type || 'COLOR').toUpperCase()}`;
}

export function loadPnl(storage, type) {
  try {
    if (!storage) return 0;
    const raw = storage.getItem(pnlKey(type));
    if (raw === null) return 0;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
  } catch (e) { return 0; }
}

export function savePnl(storage, type, v) {
  try {
    if (!storage) return;
    const n = Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0;
    storage.setItem(pnlKey(type), String(n));
  } catch (e) { /* storage unavailable: P&L stays in-memory only */ }
}

export function applyPnlResult(pnl, stake, won, payout = LEDGER_PAYOUT) {
  const p = Number.isFinite(Number(pnl)) ? Number(pnl) : 0;
  const s = Number.isFinite(Number(stake)) && Number(stake) > 0 ? Number(stake) : 0;
  return Math.round((p + (won ? s * payout : -s)) * 100) / 100;
}

/** Long-term total across types (NUMBER stays 0 while exact is locked). */
export function totalPnl(storage) {
  return Math.round(
    (loadPnl(storage, 'COLOR') + loadPnl(storage, 'SIZE') + loadPnl(storage, 'NUMBER')) * 100
  ) / 100;
}

/** Owner's explicit reset (Settings, with confirmation in the UI). */
export function resetPnl(storage, type) {
  try { if (storage) storage.removeItem(pnlKey(type)); } catch (e) { /* ignore */ }
}

/** P&L box text: +₹X profit / −₹X loss / ₹0 — minimal, signed. */
export function pnlBoxText(total) {
  const t = Number.isFinite(Number(total)) ? Math.round(Number(total) * 100) / 100 : 0;
  const a = Math.abs(t);
  const abs = a === Math.floor(a) ? String(a) : a.toFixed(2);
  if (t > 0) return `+\u20B9${abs}`;
  if (t < 0) return `-\u20B9${abs}`;
  return `\u20B90`;
}
