import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import { parseDsml, recoverDirectCalls } from '../src/direct-calls.js';
import { candidate, harness, run, ScriptedAdapter, textResponse, callResponse, prompt } from './helpers.js';

const dsml = (name: string, params = '') => `<｜DSML｜function_calls>\n<｜DSML｜invoke name="${name}">\n${params}\n</｜DSML｜invoke>\n</｜DSML｜function_calls>`;

for (const format of ['dsml', 'native'] as const) test(`${format} call with no tools opens and executes directly without Jev`, async t => {
  let executions = 0, scores = 0;
  const adapter = new ScriptedAdapter([
    format === 'dsml' ? textResponse('Reading now.\n' + dsml('read')) : callResponse('read'),
    textResponse('Read complete.'),
  ]);
  const h = await harness(adapter, { catalog: [candidate('read', async () => { executions++; return 'FILE_CONTENT'; }), candidate('unused')],
    scorer: { score: async () => { scores++; throw new Error('Jev must not run'); } } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(executions, 1);
  assert.equal(scores, 0);
  assert.equal(adapter.requests.length, 2);
  assert.deepEqual(adapter.requests[0]!.tools ?? [], []);
  assert.deepEqual(adapter.requests[1]!.tools?.map(tool => tool.name), ['read']);
  assert.match(prompt(adapter.requests[1]!), /GUIDANCE_read/);
  assert.doesNotMatch(prompt(adapter.requests[1]!), /GUIDANCE_unused/);
  assert.ok(adapter.requests[1]!.messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('FILE_CONTENT')));
  const events = agent.session.snapshotEvents();
  assert.equal(events.filter(e => e.type === 'tool/call').length, 1);
  assert.equal(events.filter(e => e.type === 'tool/result').length, 1);
  assert.ok(events.some(e => e.type === 'just-enough-tools/direct-call' && e.data.source === format));
  const { agent: restored } = await h.ctx.agents.create({ sessionId: SessionId('restored'), seed: events,
    agentOptions: { provider: 'test', model: 'test' } });
  assert.ok(h.ctx.tools.get('read', restored));
  assert.equal(executions, 1, 'replay must not rerun calls');
});

test('DSML parameters preserve raw strings and JSON values', () => {
  const parsed = parseDsml(dsml('read', [
    '<｜DSML｜parameter name="path" string="true">全角Ａ &amp; <test>\nfile</｜DSML｜parameter>',
    '<｜DSML｜parameter name="limit" string="false">3</｜DSML｜parameter>',
    '<｜DSML｜parameter name="options" string="false">{"include": [true, null]}</｜DSML｜parameter>',
  ].join('\n')))!;
  const call = parsed.find(block => block.type === 'tool-call');
  assert.ok(call?.type === 'tool-call');
  assert.deepEqual(JSON.parse(call.arguments), { path: '全角Ａ &amp; <test>\nfile', limit: 3, options: { include: [true, null] } });
});

for (const kind of ['unknown', 'bad-args', 'malformed'] as const) test(`${kind} DSML cannot register or execute`, async t => {
  let executions = 0;
  const text = kind === 'unknown' ? dsml('invented') : kind === 'bad-args'
    ? dsml('read', '<｜DSML｜parameter name="unexpected" string="false">1</｜DSML｜parameter>')
    : dsml('read').replace('</｜DSML｜invoke>', '');
  const adapter = new ScriptedAdapter([textResponse(text)]);
  const h = await harness(adapter, { catalog: [candidate('read', async () => { executions++; return ''; })],
    scorer: { score: async () => { throw new Error('must not score'); } } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.equal(h.errors.length, 1);
  assert.equal(executions, 0);
  assert.deepEqual(h.ctx.tools.schemas(agent), []);
});

test('direct calls still pass through Harness approval policy and execution guards', async t => {
  let executed = false, checked = false;
  const adapter = new ScriptedAdapter([textResponse(dsml('read')), textResponse('Access denied.')]);
  const h = await harness(adapter, { catalog: [candidate('read', async () => { executed = true; return ''; })],
    scorer: { score: async () => { throw new Error('must not score'); } } });
  h.ctx.on('tools/pre-execute', async () => { checked = true; return { kind: 'deny', reason: 'approval required' }; });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(checked, true);
  assert.equal(executed, false);
  assert.ok(agent.session.snapshotEvents().some(e => e.type === 'tool/result' && e.data.message.isError));
});

test('DSML opens a hidden tool even when the request already exposes another tool', async t => {
  let scores = 0, hiddenCalls = 0;
  const adapter = new ScriptedAdapter([textResponse('[REQUEST_CAPABILITIES] read'), textResponse(dsml('hidden')), textResponse('Done')]);
  const h = await harness(adapter, { catalog: [candidate('read'), candidate('hidden', async () => { hiddenCalls++; return ''; })],
    scorer: { score: async () => { scores++; return { scores: { 'tool:read': 1, 'tool:hidden': 0 } }; } } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(scores, 1);
  assert.equal(hiddenCalls, 1);
  assert.deepEqual(h.ctx.tools.schemas(agent).map(tool => tool.name).sort(), ['hidden', 'read']);
});

test('quoted DSML examples are not executed', () => {
  assert.equal(parseDsml('```xml\n' + dsml('read') + '\n```'), undefined);
  assert.equal(parseDsml(dsml('read').split('\n').map(line => '> ' + line).join('\n')), undefined);
});

test('truncated and cancelled streams never admit calls', async () => {
  let admissions = 0;
  const controller = new AbortController();
  async function* truncated(): AsyncIterable<StreamChunk> {
    yield* textResponse(dsml('read')).filter(chunk => chunk.type !== 'finish');
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  }
  for await (const _chunk of recoverDirectCalls(truncated(), () => { admissions++; }, controller.signal)) { /* consume */ }
  assert.equal(admissions, 0);
  async function* cancelled() {
    yield* textResponse(dsml('read'));
    controller.abort();
  }
  await assert.rejects(async () => {
    for await (const _chunk of recoverDirectCalls(cancelled(), () => { admissions++; }, controller.signal)) { /* consume */ }
  });
  assert.equal(admissions, 0);
});

test('all tools in a DSML batch open before normal execution and receive original arguments', async t => {
  const seen: unknown[] = [];
  const read = candidate('read');
  const parameters = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };
  read.parameters = parameters;
  read.create = () => ({ name: 'read', description: read.description, parameters,
    execute: async args => { seen.push(args); return 'ok'; },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'ok' }] } });
  const batch = dsml('read', '<｜DSML｜parameter name="path" string="true">config.json</｜DSML｜parameter>')
    .replace('</｜DSML｜function_calls>', '<｜DSML｜invoke name="second">\n</｜DSML｜invoke>\n</｜DSML｜function_calls>');
  const adapter = new ScriptedAdapter([textResponse(batch), textResponse('Done')]);
  const h = await harness(adapter, { catalog: [read, candidate('second', async () => { seen.push('second'); return 'ok'; })],
    scorer: { score: async () => { throw new Error('must not score'); } } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); const other = await h.create('other'); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(seen, [{ path: 'config.json' }, 'second']);
  assert.deepEqual(h.ctx.tools.schemas(agent).map(tool => tool.name), ['read', 'second']);
  assert.deepEqual(h.ctx.tools.schemas(other), []);
  assert.ok(!other.session.snapshotEvents().some(e => e.type === 'just-enough-tools/direct-call'));
});

test('a bad later invocation prevents partial admission or execution of a batch', async t => {
  let executed = false;
  const batch = dsml('read').replace('</｜DSML｜function_calls>', '<｜DSML｜invoke name="invented">\n</｜DSML｜invoke>\n</｜DSML｜function_calls>');
  const h = await harness(new ScriptedAdapter([textResponse(batch)]), {
    catalog: [candidate('read', async () => { executed = true; return ''; })],
    scorer: { score: async () => { throw new Error('must not score'); } },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.equal(h.errors.length, 1);
  assert.equal(executed, false);
  assert.deepEqual(h.ctx.tools.schemas(agent), []);
});

test('inline-code DSML is an example, and raw parameter values are never normalized', () => {
  assert.equal(parseDsml('Example: `' + dsml('read').replaceAll('\n', '') + '`'), undefined);
  const raw = 'Literal <｜DSML｜invoke name="x"> and 全角Ａ';
  const call = parseDsml(dsml('read', `<｜DSML｜parameter name="text" string="true">${raw}</｜DSML｜parameter>`))?.find(b => b.type === 'tool-call');
  assert.ok(call?.type === 'tool-call');
  assert.equal(JSON.parse(call.arguments).text, raw);
});

for (const format of ['native', 'dsml'] as const) test(`${format} calls and capability requests independently handle all three actions`, async t => {
  let scores = 0;
  const executed: string[] = [], registered: string[] = [];
  const tools = ['read', 'edit', 'search'].map(name => {
    const tool = candidate(name, async () => { executed.push(name); return 'PRIVATE_RESULT'; });
    const create = tool.create;
    tool.create = agent => { registered.push(name); return create(agent); };
    return tool;
  });
  const request = 'REQUEST_CAPABILITIES\nI also need search and a review workflow.';
  const mixed = format === 'dsml'
    ? textResponse(request + '\n' + dsml('read').replace('</｜DSML｜function_calls>', '<｜DSML｜invoke name="edit"></｜DSML｜invoke></｜DSML｜function_calls>'))
    : [...textResponse(request).filter(c => c.type !== 'finish'),
      ...callResponse('read', 'read-2').filter(c => c.type !== 'finish').map(c => 'index' in c ? { ...c, index: c.index + 1 } : c),
      ...callResponse('edit', 'edit-1').map(c => 'index' in c ? { ...c, index: c.index + 2 } : c)];
  const adapter = new ScriptedAdapter([
    format === 'dsml' ? textResponse(dsml('read')) : callResponse('read', 'read-1'),
    mixed,
    textResponse('Done.'),
  ]);
  const h = await harness(adapter, { catalog: [...tools, {
    kind: 'skill', name: 'review', description: 'Review workflow', guidance: '', load: async () => 'REVIEW_INSTRUCTIONS',
  }], scorer: { score: async input => {
    scores++;
    assert.deepEqual(executed, ['read', 'read', 'edit']);
    assert.deepEqual(input.candidates, ['tool:search', 'skill:review']);
    assert.deepEqual(input.enabled, ['tool:read', 'tool:edit']);
    assert.equal(input.agentResponse.trim(), request);
    return { scores: { 'tool:search': 1, 'skill:review': 1 } };
  } } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(scores, 1);
  assert.deepEqual(executed, ['read', 'read', 'edit']);
  assert.deepEqual(registered, ['read', 'edit', 'search']);
  assert.equal(adapter.requests.length, 3);
  assert.deepEqual(adapter.requests[2]!.tools?.map(tool => tool.name).sort(), ['edit', 'read', 'search']);
  assert.ok(adapter.requests[2]!.messages.some(message => JSON.stringify(message.content).includes('REVIEW_INSTRUCTIONS')));
  const admissions = agent.session.snapshotEvents().filter(e => e.type === 'just-enough-tools/direct-call');
  assert.deepEqual(admissions.map(e => e.data.added), [['tool:read'], ['tool:edit']]);
});

test('a capability request on the last tool step does not exceed the scoring budget', async t => {
  let scores = 0, executions = 0;
  const adapter = new ScriptedAdapter([
    textResponse(dsml('read')),
    textResponse('REQUEST_CAPABILITIES\nNeed search.\n' + dsml('read')),
  ]);
  const h = await harness(adapter, { maxSteps: 2, catalog: [candidate('read', async () => { executions++; return 'ok'; }), candidate('search')],
    scorer: { score: async () => { scores++; return { scores: { 'tool:search': 1 } }; } } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(executions, 2);
  assert.equal(scores, 0);
  assert.equal(adapter.requests.length, 2);
});
