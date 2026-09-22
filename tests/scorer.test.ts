import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { JevScorer, validateScores, jevConfigFromEnv } from '../src/scorer.js';
import type { ScoringInput } from '../src/scorer.js';

const input: ScoringInput = {
  task: 'Read records', progress: [{ role: 'assistant', content: 'Need external records' }],
  allCapabilities: [
    { kind: 'tool', id: 'tool:read', name: 'read', description: 'Read records', parameters: {}, guidance: 'Use IDs' },
    { kind: 'tool', id: 'tool:search', name: 'search', description: 'Search records', parameters: {}, guidance: '' },
    { kind: 'tool', id: 'tool:write', name: 'write', description: 'Write records', parameters: {}, guidance: '' },
  ],
  activeSkills: [],
  enabled: ['tool:search'], candidates: ['tool:read', 'tool:write'],
};

function mockResponse(data: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}

test('Jev batches independent Noul questions, explicitly names tools, and preserves the full state', async t => {
  let received: { path?: string; authorization?: string; body: Record<string, unknown> } | undefined;
  const server = createServer(async (req, res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    received = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(buffers).toString()) };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'jev-test', answers: {
      capability_1: { type: 'noul', noul: 0.2 }, capability_0: { type: 'noul', noul: 0.8 },
    }, usage: { input_tokens: 50, output_tokens: 4 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const scorer = new JevScorer({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key' });
  const result = await scorer.score(input, new AbortController().signal);
  assert.deepEqual(result.scores, { 'tool:read': 0.8, 'tool:write': 0.2 });
  assert.deepEqual(result.usage, { input_tokens: 50, output_tokens: 4, total_tokens: 54 });
  assert.equal(received?.path, '/v1/systemone');
  assert.equal(received?.authorization, 'Bearer test-key');
  assert.equal(received?.body.model, 'jev-latest');
  assert.equal(received?.body.messages, undefined);
  assert.equal(received?.body.response_format, undefined);
  assert.deepEqual(received?.body.state, { task: input.task, progress: input.progress, all_capabilities: input.allCapabilities, enabled_capabilities: ['tool:search'], active_skills: [] });
  const questions = received?.body.questions as Record<string, { type: string; instructions: { capability_name: string } }>;
  assert.deepEqual(Object.keys(questions), ['capability_0', 'capability_1']);
  assert.equal(questions.capability_0?.type, 'noul');
  assert.equal(questions.capability_0?.instructions.capability_name, 'read');
  assert.equal(questions.capability_1?.instructions.capability_name, 'write');
});

test('incomplete, unknown, wrong-type and invalid-probability answers reject the entire batch', async () => {
  const bad = [
    { capability_0: { type: 'noul', noul: 0.9 } },
    { capability_0: { type: 'noul', noul: 0.9 }, wrong: { type: 'noul', noul: 0 } },
    { capability_0: { type: 'score', score: 1 }, capability_1: { type: 'noul', noul: 0 } },
    { capability_0: { type: 'noul', noul: '0.9' }, capability_1: { type: 'noul', noul: 0 } },
    { capability_0: { type: 'noul', noul: 1.1 }, capability_1: { type: 'noul', noul: 0 } },
  ];
  for (const answers of bad) {
    await assert.rejects(new JevScorer({ apiKey: 'test', fetch: mockResponse({ answers }) }).score(input, new AbortController().signal));
  }
  assert.throws(() => validateScores({ read: Infinity }, ['read']));
  assert.throws(() => validateScores({ read: NaN }, ['read']));
});

test('high confidence in a negative answer never substitutes for the Noul probability', async () => {
  const result = await new JevScorer({ apiKey: 'test', fetch: mockResponse({ answers: {
    capability_0: { type: 'noul', noul: 0.01, confidence: 0.99 }, capability_1: { type: 'noul', noul: 0 },
  } }) }).score(input, new AbortController().signal);
  assert.deepEqual(result.scores, { 'tool:read': 0.01, 'tool:write': 0 });
});

test('HTTP errors never expose the provider response body or API key', async () => {
  const scorer = new JevScorer({ apiKey: 'private-test-key', fetch: async () => new Response('private-test-key', { status: 401 }) });
  await assert.rejects(scorer.score(input, new AbortController().signal), { message: 'HTTP_401' });
});

test('Jev requires its own credentials and never falls back to the executor API key', () => {
  assert.throws(() => jevConfigFromEnv({ API_KEY: 'executor-only' }), /TYPESAFE_API_KEY/);
  assert.deepEqual(jevConfigFromEnv({ TYPESAFE_API_KEY: 'key' }), { apiKey: 'key', baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest' });
  assert.equal(jevConfigFromEnv({ TYPESAFE_API_KEY: 'key', JEV_MODEL: 'jev-pinned' }).model, 'jev-pinned');
});

test('no candidates skip the API; invalid candidates fail before sending a request', async () => {
  let calls = 0;
  const scorer = new JevScorer({ apiKey: 'test', fetch: async () => { calls++; throw new Error('must not call'); } });
  assert.deepEqual(await scorer.score({ ...input, candidates: [] }, new AbortController().signal), { scores: {} });
  await assert.rejects(scorer.score({ ...input, candidates: ['tool:read', 'tool:read'] }, new AbortController().signal));
  await assert.rejects(scorer.score({ ...input, candidates: ['unknown'] }, new AbortController().signal));
  await assert.rejects(scorer.score({ ...input, candidates: ['tool:search'] }, new AbortController().signal));
  assert.equal(calls, 0);
});

test('aborted requests do not call Jev and malformed HTTP payloads fail safely', async () => {
  let calls = 0;
  const scorer = new JevScorer({ apiKey: 'test', fetch: async () => { calls++; return new Response('not json'); } });
  await assert.rejects(scorer.score(input, AbortSignal.abort()));
  assert.equal(calls, 0);
  await assert.rejects(scorer.score(input, new AbortController().signal), { message: 'INVALID_RESPONSE_JSON' });
});

test('a same-named skill and tool receive distinct questions in the same request', async () => {
  let payload: { questions: Record<string, { instructions: { capability_kind: string } }> } | undefined;
  const scorer = new JevScorer({ apiKey: 'fixture', fetch: async (_url, request) => {
    payload = JSON.parse(String(request?.body));
    return new Response(JSON.stringify({ answers: {
      capability_0: { type: 'noul', noul: 0.1 }, capability_1: { type: 'noul', noul: 0.9 },
    } }));
  } });
  const result = await scorer.score({ ...input, enabled: [], candidates: ['tool:read', 'skill:read'], allCapabilities: [
    input.allCapabilities[0]!, { id: 'skill:read', kind: 'skill', name: 'read', description: 'Reading workflow', guidance: '' },
  ] }, new AbortController().signal);
  assert.equal(payload?.questions.capability_0?.instructions.capability_kind, 'tool');
  assert.equal(payload?.questions.capability_1?.instructions.capability_kind, 'skill');
  assert.deepEqual(result.scores, { 'tool:read': 0.1, 'skill:read': 0.9 });
});
