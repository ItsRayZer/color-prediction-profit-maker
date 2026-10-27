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
 * Recovery stake S = w x max(base, L / 0.96), CEIL to whole Rs, min 1.
 * base = session base bet (already graduated-scaled by syncSessionBase;
 * the ledger weight applies on top — design's "base" is the session
 * base). L = tracked loss (>= 0). W = driver Wilson (null -> 0.25x).
 * Exact bets do not exist (O4) — callers must never size an exact
 * stake through this path while exact bets are locked.
 */
export function ledgerStake(base, L, W, type) {
  const b = Number.isFinite(base) && base > 0 ? base : 1;
  const l = Number.isFinite(L) && L > 0 ? L : 0;
  const w = ledgerWeight(W, type);
  return Math.max(1, Math.ceil(w * Math.max(b, l / LEDGER_PAYOUT)));
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
 *  portion of this stake (what a win on this stake would recover). */
export function ledgerLineFor(L, stake) {
  const before = Number.isFinite(L) && L > 0 ? L : 0;
  const s = Number.isFinite(stake) && stake > 0 ? stake : 0;
  const rec = recoveryIfWin(before, s);
  const recText = rec === Math.floor(rec) ? String(rec) : rec.toFixed(2);
  const lText = before === Math.floor(before) ? String(before) : before.toFixed(2);
  return `Ledger \u20B9${lText} \u00B7 this stake recovers \u20B9${recText}`;
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
 * One-call resize: given session base, tracked loss, driver Wilson and
 * type, returns { stake, weight, levelIndex, over } where over is the
 * overBalanceInfo against a known balance (or null). The cycle's
 * ledger resize step uses this; settlement uses ledgerStake directly
 * with the post-settlement ledger.
 */
export function ledgerResize(base, L, W, type, knownBalance) {
  const stake = ledgerStake(base, L, W, type);
  return {
    stake,
    weight: ledgerWeight(W, type),
    levelIndex: ledgerLevelIndex(stake, base),
    over: overBalanceInfo(stake, knownBalance),
  };
}
