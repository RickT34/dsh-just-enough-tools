import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { JevScorer, validateScores, jevConfigFromEnv } from '../src/scorer.js';
import type { ScoringInput } from '../src/scorer.js';

const input: ScoringInput = {
  task: 'Read records', agentResponse: 'Need external records',
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

test('Jev batches independent Noul questions, identifies candidates and sends compact shared context', async t => {
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
  const state = received?.body.state as any;
  assert.equal(state.task, input.task);
  assert.deepEqual(state.agent_response, input.agentResponse);
  assert.deepEqual(state.enabled, [{ id: 'tool:search', description: 'Search records' }]);
  assert.equal(state.all_capabilities, undefined);
  assert.equal(state.active_skills, undefined);
  const questions = received?.body.questions as Record<string, { type: string; instructions: { id: string } }>;
  assert.deepEqual(Object.keys(questions), ['capability_0', 'capability_1']);
  assert.equal(questions.capability_0?.type, 'noul');
  assert.equal(questions.capability_0?.instructions.id, 'tool:read');
  assert.equal(questions.capability_1?.instructions.id, 'tool:write');
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
  let payload: { questions: Record<string, { instructions: { id: string } }> } | undefined;
  const scorer = new JevScorer({ apiKey: 'fixture', fetch: async (_url, request) => {
    payload = JSON.parse(String(request?.body));
    return new Response(JSON.stringify({ answers: {
      capability_0: { type: 'noul', noul: 0.1 }, capability_1: { type: 'noul', noul: 0.9 },
    } }));
  } });
  const result = await scorer.score({ ...input, enabled: [], candidates: ['tool:read', 'skill:read'], allCapabilities: [
    input.allCapabilities[0]!, { id: 'skill:read', kind: 'skill', name: 'read', description: 'Reading workflow', guidance: '' },
  ] }, new AbortController().signal);
  assert.equal(payload?.questions.capability_0?.instructions.id, 'tool:read');
  assert.equal(payload?.questions.capability_1?.instructions.id, 'skill:read');
  assert.deepEqual(result.scores, { 'tool:read': 0.1, 'skill:read': 0.9 });
});

test('Vercel evaluation uses boolean probabilities, gateway headers and normalized usage', async () => {
  let endpoint = '';
  let headers = new Headers();
  let body: any;
  const scorer = new JevScorer({ protocol: 'vercel', apiKey: 'gateway-fixture', fetch: async (url, init) => {
    endpoint = String(url); headers = new Headers(init?.headers); body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ answers: {
      capability_0: { type: 'boolean', probability: 0.8 },
      capability_1: { type: 'boolean', probability: 0.01, confidence: 0.99 },
    }, usage: { inputTokens: 100, outputTokens: 0 } }));
  } });
  const result = await scorer.score(input, new AbortController().signal);
  assert.equal(endpoint, 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
  assert.equal(headers.get('authorization'), 'Bearer gateway-fixture');
  assert.equal(headers.get('ai-model-id'), 'typesafe-ai/jev');
  assert.equal(headers.get('ai-evaluation-model-specification-version'), '4');
  assert.equal(headers.get('ai-gateway-protocol-version'), '0.0.1');
  assert.equal(body.model, undefined);
  assert.equal(body.questions.capability_0.type, 'boolean');
  assert.equal(body.questions.capability_0.instructions.id, 'tool:read');
  assert.equal(body.state.all_capabilities, undefined);
  assert.equal(body.questions.capability_0.instructions.description, 'Read records');
  assert.deepEqual(result.scores, { 'tool:read': 0.8, 'tool:write': 0.01 });
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 0, total_tokens: 100 });
});

test('custom providers preserve base paths, full endpoints, credentials and model IDs', async () => {
  for (const protocol of ['vercel', 'systemone'] as const) {
    const suffix = protocol === 'vercel' ? 'evaluation-model' : 'systemone';
    for (const baseUrl of ['https://example.test/custom/', `https://example.test/custom/${suffix}`]) {
      const scorer = new JevScorer({ protocol, baseUrl, apiKey: 'custom-key', model: 'custom-jev', fetch: async (url, init) => {
        assert.equal(String(url), `https://example.test/custom/${suffix}`);
        const body = JSON.parse(String(init?.body));
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('authorization'), 'Bearer custom-key');
        assert.equal(protocol === 'vercel' ? headers.get('ai-model-id') : body.model, 'custom-jev');
        return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id,
          protocol === 'vercel' ? { type: 'boolean', probability: 0.7 } : { type: 'noul', noul: 0.7 },
        ])) }));
      } });
      assert.deepEqual((await scorer.score(input, new AbortController().signal)).scores, { 'tool:read': 0.7, 'tool:write': 0.7 });
    }
  }
});

test('gateway rejects missing, malformed and out-of-range boolean probabilities', async () => {
  for (const answer of [{ type: 'boolean' }, { type: 'boolean', probability: '0.9' },
    { type: 'boolean', probability: -1 }, { type: 'boolean', probability: 1.1 }, { type: 'noul', noul: 0.9 }]) {
    await assert.rejects(new JevScorer({ protocol: 'vercel', apiKey: 'fixture', fetch: mockResponse({ answers: {
      capability_0: answer, capability_1: { type: 'boolean', probability: 0.2 },
    } }) }).score(input, new AbortController().signal));
  }
});

test('provider environment configuration never borrows credentials from another provider', () => {
  assert.deepEqual(jevConfigFromEnv({ JEV_PROTOCOL: 'vercel', AI_GATEWAY_API_KEY: 'gateway' }), {
    protocol: 'vercel', apiKey: 'gateway', baseUrl: 'https://ai-gateway.vercel.sh/v4/ai', model: 'typesafe-ai/jev',
  });
  assert.throws(() => jevConfigFromEnv({ JEV_PROTOCOL: 'vercel', TYPESAFE_API_KEY: 'wrong-provider' }));
  assert.throws(() => jevConfigFromEnv({ AI_GATEWAY_API_KEY: 'wrong-provider' }));
  assert.throws(() => jevConfigFromEnv({ JEV_PROTOCOL: 'unknown', JEV_API_KEY: 'fixture' }));
  assert.equal(jevConfigFromEnv({ JEV_PROTOCOL: 'vercel', JEV_API_KEY: 'custom', AI_GATEWAY_API_KEY: 'gateway',
    JEV_BASE_URL: 'https://example.test/custom', JEV_MODEL: 'custom-jev' }).apiKey, 'custom');
});

test('OpenAI-compatible chat scoring supports unauthenticated local servers and exact candidate IDs', async () => {
  let request: { url: string; headers: Headers; body: any } | undefined;
  const result = await new JevScorer({ protocol: 'openai', model: 'local-chat', fetch: async (url, init) => {
    request = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ scores: {
      'tool:read': 0.9, 'tool:write': 0.1,
    } }) } }], usage: { prompt_tokens: 200, completion_tokens: 20 } }));
  } }).score(input, new AbortController().signal);
  assert.equal(request?.url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(request?.headers.has('authorization'), false);
  assert.equal(request?.body.model, 'local-chat');
  assert.equal(request?.body.stream, false);
  assert.deepEqual(JSON.parse(request?.body.messages[1].content).candidates.map((c: { id: string }) => c.id), input.candidates);
  assert.deepEqual(result.scores, { 'tool:read': 0.9, 'tool:write': 0.1 });
  assert.deepEqual(result.usage, { input_tokens: 200, output_tokens: 20, total_tokens: 220 });
});

test('chat scoring rejects truncation, missing scores, invented IDs and malformed JSON', async () => {
  for (const [finish, content] of [
    ['length', '{"scores":{"tool:read":0.9,"tool:write":0.1}}'],
    ['stop', '{"scores":{"tool:read":0.9}}'],
    ['stop', '{"scores":{"tool:read":0.9,"tool:write":0.1,"invented":1}}'],
    ['stop', '{"scores":{"tool:read":"0.9","tool:write":0.1}}'],
    ['stop', '```json\n{"scores":{}}\n```'],
  ]) {
    await assert.rejects(new JevScorer({ protocol: 'openai', model: 'local', fetch: mockResponse({
      choices: [{ finish_reason: finish, message: { content } }],
    }) }).score(input, new AbortController().signal));
  }
  await assert.rejects(new JevScorer({ protocol: 'openai', model: 'encoder',
    fetch: mockResponse({ error: 'logits unavailable' }),
  }).score(input, new AbortController().signal), { message: 'INVALID_CHAT_RESPONSE' });
});

test('chat protocol requires an explicit model and does not borrow the Vercel key', () => {
  assert.throws(() => new JevScorer({ protocol: 'openai' }), /model ID/);
  const config = jevConfigFromEnv({ JEV_PROTOCOL: 'openai', JEV_MODEL: 'local', AI_GATEWAY_API_KEY: 'not-for-local' });
  assert.equal(config.apiKey, undefined);
  assert.equal(config.protocol, 'openai');
  assert.equal(jevConfigFromEnv({ JEV_PROTOCOL: 'openai', OPENAI_API_KEY: 'chat-key' }).apiKey, 'chat-key');
});

test('compact payload removes duplicate task and schemas and retains only the latest Agent reply and skill dependencies', async () => {
  let payload: any;
  const scorer = new JevScorer({ apiKey: 'fixture', fetch: async (_url, request) => {
    payload = JSON.parse(String(request?.body));
    return new Response(JSON.stringify({ answers: {
      capability_0: { type: 'noul', noul: 0.8 }, capability_1: { type: 'noul', noul: 0.1 },
    } }));
  } });
  await scorer.score({ ...input, agentResponse: 'Need to inspect records.',
    activeSkills: [{ id: 'skill:debug', name: 'debug', instructions: 'Run verification after editing.' }],
    allCapabilities: input.allCapabilities.map(c => ({ ...c, parameters: { secretSchemaMarker: 'x'.repeat(10000) } })),
  }, new AbortController().signal);
  assert.deepEqual(payload.state.agent_response, 'Need to inspect records.');
  assert.deepEqual(payload.state.active_skills, [{ id: 'skill:debug', instructions: 'Run verification after editing.' }]);
  const encoded = JSON.stringify(payload);
  assert.equal(encoded.split('Read records').length - 1, 2); // task plus the candidate's distinct description
  assert.doesNotMatch(encoded, /secretSchemaMarker|all_capabilities|capability_kind|capability_name/);
  assert.ok(encoded.length < 1800, `Unexpected request growth: ${encoded.length} characters`);
});

test('all scoring protocols send only the latest public Agent reply from a long trajectory', async () => {
  const latest = 'Latest final answer';
  for (const protocol of ['systemone', 'vercel', 'openai'] as const) {
    let state: any;
    const scorer = new JevScorer({ protocol, apiKey: 'fixture', model: 'test', fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      state = protocol === 'openai' ? JSON.parse(body.messages[1].content).state : body.state;
      return new Response(JSON.stringify(protocol === 'openai'
        ? { choices: [{ finish_reason: 'stop', message: { content: '{"scores":{"tool:read":0.9,"tool:write":0.1}}' } }] }
        : { answers: Object.fromEntries([0.9, 0.1].map((score, i) => [`capability_${i}`, protocol === 'vercel'
          ? { type: 'boolean', probability: score } : { type: 'noul', noul: score }])) }));
    } });
    await scorer.score({ ...input, agentResponse: latest }, new AbortController().signal);
    assert.deepEqual(state.agent_response, latest);
    assert.doesNotMatch(JSON.stringify(state), /OLD_HISTORY|HIDDEN|TOOL_RESULT|USER_MESSAGE/);
  }
});
