import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleAxoAiRequest } from '../functions/_axo-ai-core.js';
import { createAxoAiHandler } from '../api/axo-ai.js';
import { onRequest as pagesOnRequest } from '../functions/api/axo-ai.js';

/**
 * tests/axo_ai_function.test.js — the /api/axo-ai hop: ONE core
 * (functions/_axo-ai-core.js) + two thin adapters — Cloudflare
 * Pages (production, functions/api/axo-ai.js) and Vercel (preview
 * twin, api/axo-ai.js). The contract suite runs against the core
 * with a mocked env + mocked upstream fetch (no network, no real
 * key); both adapters then get smoke-tested over the same core.
 * Pins: missing env → 503 (upstream never called); 200 path
 * returns only display text, trimmed + capped; upstream errors →
 * non-200; oversized/invalid bodies rejected; the key reaches
 * upstream as a Bearer header and never appears in a response.
 */

const KEY = 'test-key-never-a-real-one';
const GOOD_BODY = {
  system: 'You are Axo.',
  user: '{"event":"REGIME","payload":{"period":"P9"}}',
  event: 'REGIME',
  payload: { period: 'P9' }
};

function upstream(text, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok, status, json: async () => ({ choices: [{ message: { content: text } }] }) };
  };
  return { fetchImpl, calls };
}

const core = (over = {}) => handleAxoAiRequest({ method: 'POST', body: JSON.stringify(GOOD_BODY), env: { ZEROONE_API_KEY: KEY }, ...over });

test('core — missing env key answers 503 and never calls upstream', async () => {
  const { fetchImpl, calls } = upstream('hello');
  const out = await handleAxoAiRequest({ method: 'POST', body: JSON.stringify(GOOD_BODY), env: {}, fetchImpl });
  assert.equal(out.status, 503);
  assert.deepEqual(out.body, { error: 'ai_unavailable' });
  assert.equal(calls.length, 0, 'no upstream call without a key');
});

test('core — 200 path returns only display text, trimmed and capped', async () => {
  const { fetchImpl, calls } = upstream('  ' + 'word '.repeat(200));
  const out = await core({ fetchImpl });
  assert.equal(out.status, 200);
  assert.deepEqual(Object.keys(out.body), ['text'], 'the response is text and nothing else');
  assert.ok(out.body.text.length <= 320, 'display text is length-capped');
  assert.equal(out.body.text, out.body.text.trim());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer ' + KEY);
  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.model, 'nvidia/nemotron-3-ultra-550b-a55b');
  assert.deepEqual(sent.messages, [
    { role: 'system', content: GOOD_BODY.system },
    { role: 'user', content: GOOD_BODY.user }
  ]);
  assert.ok(!JSON.stringify(out.body).includes(KEY), 'the key never appears in a response');
});

test('core — upstream error and upstream garbage both become non-200', async () => {
  assert.equal((await core({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) })).status, 502);
  assert.equal((await core({ fetchImpl: async () => { throw new Error('network down'); } })).status, 502);
  assert.equal((await core({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }) })).status, 502);
});

test('core — oversized and invalid bodies are rejected before any upstream call', async () => {
  const { fetchImpl, calls } = upstream('x');
  const env = { ZEROONE_API_KEY: KEY };
  assert.equal((await handleAxoAiRequest({ method: 'POST', body: JSON.stringify({ ...GOOD_BODY, user: 'u'.repeat(20000) }), env, fetchImpl })).status, 413, 'oversized body → 413');
  assert.equal((await handleAxoAiRequest({ method: 'POST', body: '{not json', env, fetchImpl })).status, 400, 'invalid JSON → 400');
  assert.equal((await handleAxoAiRequest({ method: 'POST', body: JSON.stringify({ ...GOOD_BODY, event: 'WHATEVER' }), env, fetchImpl })).status, 400, 'unknown event shape → 400');
  assert.equal((await handleAxoAiRequest({ method: 'POST', body: JSON.stringify({ system: 's', event: 'REGIME' }), env, fetchImpl })).status, 400, 'missing user prompt → 400');
  assert.equal((await handleAxoAiRequest({ method: 'GET', body: '', env, fetchImpl })).status, 405, 'non-POST → 405');
  assert.equal(calls.length, 0, 'rejected requests never reach upstream');
});

test('core — a pre-parsed object body is accepted', async () => {
  const { fetchImpl } = upstream('Parsed fine.');
  const out = await core({ body: GOOD_BODY, fetchImpl });
  assert.equal(out.status, 200);
  assert.equal(out.body.text, 'Parsed fine.');
});

test('vercel adapter — (req, res) delegates to the same core', async () => {
  const mockRes = () => {
    const res = { code: null, body: null, status(c) { res.code = c; return res; }, json(o) { res.body = o; return res; } };
    return res;
  };
  const { fetchImpl } = upstream('Via Vercel.');
  const handler = createAxoAiHandler({ env: { ZEROONE_API_KEY: KEY }, fetchImpl });
  const res = mockRes();
  await handler({ method: 'POST', body: JSON.stringify(GOOD_BODY) }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.text, 'Via Vercel.');

  const dark = createAxoAiHandler({ env: {}, fetchImpl });
  const res2 = mockRes();
  await dark({ method: 'POST', body: JSON.stringify(GOOD_BODY) }, res2);
  assert.equal(res2.code, 503, 'no env key → 503 through the adapter too');
});

test('pages adapter — onRequest(context) delegates to the same core', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Via Pages.' } }] }) });
  try {
    const ctx = {
      request: { method: 'POST', text: async () => JSON.stringify(GOOD_BODY) },
      env: { ZEROONE_API_KEY: KEY }
    };
    const resp = await pagesOnRequest(ctx);
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { text: 'Via Pages.' });

    const darkCtx = { request: { method: 'POST', text: async () => JSON.stringify(GOOD_BODY) }, env: {} };
    const darkResp = await pagesOnRequest(darkCtx);
    assert.equal(darkResp.status, 503, 'no env key → 503 through the Pages adapter too');
    assert.deepEqual(await darkResp.json(), { error: 'ai_unavailable' });

    const getCtx = { request: { method: 'GET', text: async () => '' }, env: { ZEROONE_API_KEY: KEY } };
    assert.equal((await pagesOnRequest(getCtx)).status, 405, 'non-POST → 405');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('hop — source hygiene: the key is read from env only, never hard-coded or logged', () => {
  for (const rel of ['../functions/_axo-ai-core.js', '../api/axo-ai.js', '../functions/api/axo-ai.js']) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.ok(!/nvapi-[A-Za-z0-9]/.test(src), `no NVIDIA key material in ${rel}`);
    assert.ok(!src.includes('console.log'), `nothing is logged in ${rel} (a key can never leak via logs)`);
  }
  const coreSrc = readFileSync(new URL('../functions/_axo-ai-core.js', import.meta.url), 'utf8');
  assert.ok(coreSrc.includes('ZEROONE_API_KEY'), 'the env var name is the only key reference');
  assert.ok(coreSrc.includes('handleAxoAiRequest'), 'the core is the single contract implementation');
  const vercelSrc = readFileSync(new URL('../api/axo-ai.js', import.meta.url), 'utf8');
  const pagesSrc = readFileSync(new URL('../functions/api/axo-ai.js', import.meta.url), 'utf8');
  assert.ok(vercelSrc.includes("from '../functions/_axo-ai-core.js'"), 'the Vercel adapter imports the core (no duplicated logic)');
  assert.ok(pagesSrc.includes("from '../_axo-ai-core.js'"), 'the Pages adapter imports the core (no duplicated logic)');
});
