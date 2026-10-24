/**
 * api/axo-ai.js — Vercel adapter for the Axo AI hop (PREVIEW only).
 * ═══════════════════════════════════════════════════════════════
 * Thin wrapper over the framework-free core in
 * functions/_axo-ai-core.js — all contract logic lives there, once.
 * Production runs the Cloudflare Pages twin
 * (deploy/functions/api/axo-ai.js); this adapter exists so the
 * Vercel preview sandbox can exercise the same hop. The client
 * only ever calls the same-origin path /api/axo-ai.
 *
 * Reads the key from process.env.ZEROONE_API_KEY at invocation.
 */

import { handleAxoAiRequest } from '../functions/_axo-ai-core.js';

export function createAxoAiHandler({ env = {}, fetchImpl = null } = {}) {
  return async function axoAiHandler(req, res) {
    let raw = req ? req.body : null;
    if (raw !== null && raw !== undefined && typeof raw !== 'string' && typeof raw !== 'object') {
      raw = String(raw); // e.g. a Buffer body → utf8 string
    } else if (raw !== null && raw !== undefined && typeof raw === 'object' && typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) {
      raw = raw.toString('utf8');
    }
    const out = await handleAxoAiRequest({
      method: req ? req.method : 'POST',
      body: raw,
      env,
      fetchImpl
    });
    if (res && typeof res.status === 'function' && typeof res.json === 'function') {
      return res.status(out.status).json(out.body);
    }
    res.statusCode = out.status;
    if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(out.body));
  };
}

export default createAxoAiHandler({ env: typeof process !== 'undefined' ? process.env : {} });
