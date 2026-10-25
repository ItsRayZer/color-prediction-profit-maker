/**
 * axo-ai.js — Axo AI narration layer (DISPLAY ONLY, ships DARK).
 * ═══════════════════════════════════════════════════════════════
 * The AI phrases, labels and summarises. It never decides: this
 * module imports nothing, mutates nothing, and its output is written
 * by the caller to exactly one display element. Verdicts, stakes,
 * gates, sessions and every SPOKEN line stay governed/local
 * (systems/predictBot.js templates) — voice has zero network latency
 * and zero hallucination surface by construction.
 *
 * ENDPOINT: the same-origin server hop at /api/axo-ai (deploy/api/
 * axo-ai.js) holds the NVIDIA key server-side (env ZEROONE_API_KEY)
 * — the key never appears in client JS, this file included. When
 * the hop is missing, unconfigured (503) or failing, `narrate()`
 * returns the local text silently, exactly as if the layer were
 * dark. The owner's Normal mode (o101_axo_mode) bypasses this
 * client entirely — zero AI calls, governed templates only.
 *
 * Call discipline: event-triggered only (BET lock → regime label,
 * session end → summary, user question). Never per tick, never on
 * SKIP. One in-flight call max; 6s timeout; any failure, timeout or
 * garbage response falls back to the local text silently.
 */

export const AXO_AI_ENDPOINT = '/api/axo-ai';
export const AXO_AI_TIMEOUT_MS = 6000;

export const AXO_AI_SYSTEM_PROMPT = 'You are Axo, the voice of a colour-trading assistant. Reply in one or two short plain-English sentences that could be read aloud. Use ONLY the numbers given; never invent a number, a result, or a reason. Never promise profit. Never tell the user to bet, skip, raise, or lower a stake. If the data is missing, say what is missing.';

const EVENT_USER_PREFIX = {
  REGIME: payload => `Event: REGIME. Data: ${JSON.stringify(payload)}. In one short sentence, name the market regime (streaky, choppy, or balanced) and why, using only the data.`,
  SESSION_END: payload => `Event: SESSION_END. Data: ${JSON.stringify(payload)}. In two short sentences, summarise the session: what the engine did, the final P&L given, and the ladder state. Nothing else.`,
  QUESTION: (payload, question) => `Event: QUESTION. User asked: "${question}". Data: ${JSON.stringify(payload)}. Answer in one or two short sentences using only the data; if the data cannot answer, say so.`
};

/** The exact prompt pair for an event (PLAN.md §7 shapes). Pure. */
export function buildAxoPrompt(event, payload, question = null) {
  const make = EVENT_USER_PREFIX[event];
  const user = make ? make(payload || {}, question) : `Event: ${event}. Data: ${JSON.stringify(payload || {})}.`;
  return { system: AXO_AI_SYSTEM_PROMPT, user };
}

const numOrNull = v => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
const strOrNull = (v, cap = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : null);

/**
 * Whitelist the payload to EXACTLY the governed fields the AI may
 * see (PLAN.md §7). Anything else in the input — tokens, user
 * identity, raw bridge payloads — is dropped here, structurally.
 * Returns a fresh object; the input is never mutated.
 */
export function buildAxoPayload(input = {}) {
  const pf = input.patternFiring && typeof input.patternFiring === 'object' ? input.patternFiring : null;
  const tr = input.trend && typeof input.trend === 'object' ? input.trend : null;
  const results = Array.isArray(input.lastResults)
    ? input.lastResults.slice(-10).map(r => {
        const n = numOrNull(r);
        if (n !== null) return n;
        return r === 'BIG' || r === 'SMALL' ? r : null;
      }).filter(r => r !== null)
    : [];
  return {
    event: strOrNull(input.event, 40),
    timeframe: strOrNull(input.timeframe, 10),
    period: input.period !== null && input.period !== undefined ? String(input.period).slice(0, 40) : null,
    verdict: strOrNull(input.verdict, 10),
    target: strOrNull(input.target, 10),
    stake: numOrNull(input.stake),
    ladderStep: numOrNull(input.ladderStep),
    gateReason: strOrNull(input.gateReason),
    conflictReason: strOrNull(input.conflictReason),
    leaderModel: strOrNull(input.leaderModel, 80),
    leaderWilsonLB: numOrNull(input.leaderWilsonLB),
    leaderFirings: numOrNull(input.leaderFirings),
    patternFiring: pf ? { name: strOrNull(pf.name, 80), hitRate: numOrNull(pf.hitRate), firings: numOrNull(pf.firings) } : null,
    trend: tr ? { type: strOrNull(tr.type, 10), length: numOrNull(tr.length) } : null,
    sessionPnL: numOrNull(input.sessionPnL),
    settledCount: numOrNull(input.settledCount),
    verifiedBalance: numOrNull(input.verifiedBalance),
    lastResults: results
  };
}

const inr = n => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '₹0';
  return '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
};
const sizeOf = r => (r === 'BIG' || r === 'SMALL' ? r : (Number(r) >= 5 ? 'BIG' : 'SMALL'));

/**
 * Local regime label — the offline readout used whenever the AI is
 * dark, busy or failed. Built only from the recent settled results
 * and the trend the engine already computed.
 */
export function localRegimeLabel(lastResults = [], trend = null) {
  const sizes = (Array.isArray(lastResults) ? lastResults : []).slice(-10).map(sizeOf);
  const n = sizes.length;
  if (trend && trend.type && Number(trend.length) >= 4) {
    return { label: 'streaky', line: `Regime: streaky — ${trend.type} has run ${Number(trend.length)} in a row.` };
  }
  if (n >= 6) {
    let alternations = 0;
    for (let i = 1; i < n; i++) if (sizes[i] !== sizes[i - 1]) alternations++;
    if (alternations >= Math.ceil((n - 1) * 0.7)) {
      return { label: 'choppy', line: `Regime: choppy — the last ${n} results keep flipping with no run holding.` };
    }
  }
  return { label: 'balanced', line: n ? `Regime: balanced — no run or chop pattern stands out in the last ${n} results.` : 'Regime: balanced — no settled results to read yet.' };
}

/** Local session-end summary — the offline fallback text. */
export function localSessionSummary(payload = {}) {
  const p = buildAxoPayload(payload);
  const rounds = p.settledCount !== null ? `${p.settledCount} governed rounds settled` : 'the governed rounds are settled';
  const pnl = p.sessionPnL !== null ? `session P&L ${p.sessionPnL < 0 ? '-' : '+'}${inr(p.sessionPnL)}` : 'session P&L not recorded';
  const ladder = p.ladderStep !== null ? `ladder finished at step ${p.ladderStep + 1}` : 'ladder state not recorded';
  return `Session summary: ${rounds}; ${pnl}; ${ladder}.`;
}

/** Clean an AI reply into display text, or null when unusable. */
export function sanitizeAiText(raw) {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > 320) {
    const cut = text.slice(0, 320);
    const lastSpace = cut.lastIndexOf(' ');
    text = (lastSpace > 120 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return text || null;
}

/** Pull the message text out of a hop response (object or string). */
export function extractAiText(data) {
  if (typeof data === 'string') return sanitizeAiText(data);
  if (!data || typeof data !== 'object') return null;
  if (typeof data.text === 'string') return sanitizeAiText(data.text);
  if (typeof data.message === 'string') return sanitizeAiText(data.message);
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  if (choice) {
    if (choice.message && typeof choice.message.content === 'string') return sanitizeAiText(choice.message.content);
    if (typeof choice.text === 'string') return sanitizeAiText(choice.text);
  }
  return null;
}

export class AxoAiClient {
  constructor({ endpoint = AXO_AI_ENDPOINT, fetchImpl = null, timeoutMs = AXO_AI_TIMEOUT_MS } = {}) {
    this.endpoint = endpoint || null;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
    this.inflight = false;
  }

  get configured() { return !!this.endpoint; }

  /**
   * Narrate one event. `local` is the offline text (string or
   * function returning one) used whenever the AI is dark, busy,
   * slow or wrong. NEVER throws; NEVER returns anything but display
   * text plus its source.
   */
  async narrate({ event, payload = {}, question = null, local = null } = {}) {
    const localText = () => {
      try { return typeof local === 'function' ? local() : local; } catch (e) { return null; }
    };
    if (!this.endpoint) return { text: localText(), source: 'local' };
    const safePayload = buildAxoPayload({ ...payload, event });
    const key = `${event}:${safePayload.period || ''}:${question || ''}`;
    if (this.cache.has(key)) return { text: this.cache.get(key), source: 'ai' };
    if (this.inflight) return { text: localText(), source: 'local' };
    this.inflight = true;
    try {
      const prompt = buildAxoPrompt(event, safePayload, question);
      const data = await this._request(prompt, safePayload);
      const text = extractAiText(data);
      if (text) {
        this.cache.set(key, text);
        if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value);
        return { text, source: 'ai' };
      }
    } catch (e) { /* any failure → local, silently */ }
    finally { this.inflight = false; }
    return { text: localText(), source: 'local' };
  }

  async _request(prompt, payload) {
    const fetchFn = this.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) throw new Error('no fetch available');
    const body = JSON.stringify({ system: prompt.system, user: prompt.user, event: payload.event, payload });
    let timer = null;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('axo-ai timeout')), this.timeoutMs); });
    try {
      const attempt = (async () => {
        const resp = await fetchFn(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body
        });
        if (!resp) throw new Error('empty response');
        if (resp.ok === false) throw new Error('hop status ' + resp.status);
        if (typeof resp.json === 'function') {
          try { return await resp.json(); } catch (e) { /* fall through to text */ }
        }
        if (typeof resp.text === 'function') return await resp.text();
        return resp;
      })();
      return await Promise.race([attempt, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
