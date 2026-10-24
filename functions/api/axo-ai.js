/**
 * functions/api/axo-ai.js — Cloudflare Pages adapter for the Axo
 * AI hop (PRODUCTION: 0one.pages.dev serves the deploy/ tree, and
 * Pages routes POST /api/axo-ai to this function).
 * ═══════════════════════════════════════════════════════════════
 * Thin wrapper over the framework-free core in
 * ../_axo-ai-core.js — all contract logic lives there, once. The
 * Vercel preview runs the twin adapter (deploy/api/axo-ai.js); the
 * client only ever calls the same-origin path /api/axo-ai.
 *
 * The key comes from the Pages project's environment variable
 * ZEROONE_API_KEY (context.env), server-side only — it never
 * ships in client code. Unset → the core answers 503 and Axo
 * runs on governed templates.
 */

import { handleAxoAiRequest } from '../_axo-ai-core.js';

export async function onRequest(context) {
  let bodyText = '';
  try { bodyText = await context.request.text(); } catch (e) { bodyText = ''; }
  const out = await handleAxoAiRequest({
    method: context.request.method,
    body: bodyText,
    env: context.env || {}
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { 'Content-Type': 'application/json' }
  });
}
