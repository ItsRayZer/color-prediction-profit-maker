/**
 * functions/_axo-ai-core.js — the Axo AI hop CORE (framework-free).
 * ═══════════════════════════════════════════════════════════════
 * ALL the contract logic for /api/axo-ai lives here, once:
 * request JSON in → { status, body } out. No framework globals —
 * the two thin adapters feed it in:
 *
 *   deploy/functions/api/axo-ai.js  Cloudflare Pages (PRODUCTION)
 *   deploy/api/axo-ai.js            Vercel (preview sandbox twin)
 *
 * Contract: POST { system, user, event, payload } — the prompt
 * pair the client built from the PLAN.md §7 shapes — calls NVIDIA
 * Nemotron with the owner's key and returns ONLY the model's
 * display text: { text }. It cannot influence a verdict: it
 * returns text, the client renders text, end of story.
 *
 * The key comes from the ZEROONE_API_KEY env var of whichever
 * host runs the adapter, read server-side only. It never appears
 * in any client file, response or log. When unset the hop answers
 * 503 { error: 'ai_unavailable' } and the client falls back to
 * its governed templates silently — the app behaves identically,
 * minus the AI phrasing.
 */

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const MAX_BODY_BYTES = 16384;
const MAX_SYSTEM_CHARS = 2000;
const MAX_USER_CHARS = 6000;
const MAX_TEXT_CHARS = 320;
const UPSTREAM_TIMEOUT_MS = 12000;
const EVENTS = new Set(['REGIME', 'SESSION_END', 'QUESTION']);

/** Clean a model reply into display text, or null when unusable. */
function sanitizeText(raw) {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > MAX_TEXT_CHARS) {
    const cut = text.slice(0, MAX_TEXT_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    text = (lastSpace > 120 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return text || null;
}

/**
 * Handle one hop request.
 * @param {{ method?: string, body?: unknown, env?: object, fetchImpl?: Function }} input
 *   body may be a raw string or an already-parsed object (adapters
 *   normalise anything else to a string before calling).
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleAxoAiRequest({ method = 'POST', body = null, env = {}, fetchImpl = null } = {}) {
  const fail = (status, error) => ({ status, body: { error } });

  if (method !== 'POST') return fail(405, 'method_not_allowed');

  const key = env ? env.ZEROONE_API_KEY : null;
  if (!key) return fail(503, 'ai_unavailable');

  // Normalise the body to text. Byte length via TextEncoder so
  // this runs identically on Node and on Cloudflare Workers.
  let bodyText;
  if (body === null || body === undefined) bodyText = '';
  else if (typeof body === 'string') bodyText = body;
  else {
    try { bodyText = JSON.stringify(body); } catch (e) { return fail(400, 'bad_body'); }
  }
  if (new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) return fail(413, 'too_large');

  let data;
  try { data = JSON.parse(bodyText); } catch (e) { return fail(400, 'bad_json'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(400, 'bad_shape');

  // Only the plan's prompt shapes pass through: a known event, a
  // bounded system prompt and a bounded user prompt. Nothing else
  // in the body is forwarded anywhere.
  const { system, user, event } = data;
  if (!EVENTS.has(event)) return fail(400, 'bad_event');
  if (typeof system !== 'string' || !system.trim() || system.length > MAX_SYSTEM_CHARS) return fail(400, 'bad_system');
  if (typeof user !== 'string' || !user.trim() || user.length > MAX_USER_CHARS) return fail(400, 'bad_user');

  const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) return fail(502, 'ai_upstream');

  let resp;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, UPSTREAM_TIMEOUT_MS) : null;
  try {
    resp = await fetchFn(NVIDIA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        max_tokens: 220,
        temperature: 0.4
      }),
      signal: ctrl ? ctrl.signal : undefined
    });
  } catch (e) {
    return fail(502, 'ai_upstream');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!resp || resp.ok === false) return fail(502, 'ai_upstream');

  let content = null;
  try {
    const j = await resp.json();
    const choice = j && Array.isArray(j.choices) ? j.choices[0] : null;
    content = choice && choice.message ? choice.message.content : null;
  } catch (e) { /* unparseable upstream body → empty */ }
  const text = sanitizeText(content);
  if (!text) return fail(502, 'ai_empty');
  return { status: 200, body: { text } };
}
