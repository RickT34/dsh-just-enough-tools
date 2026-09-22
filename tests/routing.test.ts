import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import type { ScoringInput, ScoringResult } from '../src/scorer.js';
import { JevScorer } from '../src/scorer.js';
import { candidate, harness, run, ScriptedAdapter, textResponse, callResponse, prompt } from './helpers.js';

test('real agent loop starts empty, appends tools and guidance, and scores only remaining candidates', async t => {
  const inputs: ScoringInput[] = [];
  const executed: string[] = [];
  const adapter = new ScriptedAdapter([
    textResponse('First I need lookup; its result may require decode.'),
    callResponse('lookup'), callResponse('decode'), textResponse('Completed'),
  ]);
  const h = await harness(adapter, {
    catalog: [candidate('lookup', async () => { executed.push('lookup'); return 'Now decode'; }),
      candidate('decode', async () => { executed.push('decode'); return '42'; }), candidate('unused')],
    threshold: 0.5,
    scorer: { score: async (input): Promise<ScoringResult> => {
      inputs.push(input);
      return { scores: inputs.length === 1 ? { 'tool:lookup': 0.9, 'tool:decode': 0.5, 'tool:unused': 0 }
        : inputs.length === 2 ? { 'tool:decode': 0.8, 'tool:unused': 0.1 } : { 'tool:unused': 0.1 } };
    } },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  await run(agent);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(adapter.requests.map(r => r.tools?.map(t => t.name) ?? []), [[], ['lookup'], ['decode', 'lookup'], ['decode', 'lookup']]);
  assert.doesNotMatch(prompt(adapter.requests[0]!), /GUIDANCE_/);
  assert.match(prompt(adapter.requests[1]!), /GUIDANCE_lookup/);
  assert.doesNotMatch(prompt(adapter.requests[1]!), /GUIDANCE_decode/);
  assert.match(prompt(adapter.requests[2]!), /GUIDANCE_decode/);
  assert.deepEqual(executed, ['lookup', 'decode']);
  assert.deepEqual(inputs.map(i => i.candidates), [['tool:lookup', 'tool:decode', 'tool:unused'], ['tool:decode', 'tool:unused'], ['tool:unused']]);
  assert.equal(inputs[0]!.task, 'Complete the original task');
  assert.equal(inputs[1]!.allCapabilities.length, 3);
  assert.match(JSON.stringify(inputs[1]!.progress), /Now decode/);
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'just-enough-tools/continued').length, 1);
});

test('an unregistered tool cannot execute even if the model guesses its name', async t => {
  let called = false;
  const adapter = new ScriptedAdapter([textResponse('plan'), callResponse('hidden'), textResponse('done')]);
  const h = await harness(adapter, {
    catalog: [candidate('hidden', async () => { called = true; return 'bad'; })],
    scorer: { score: async () => ({ scores: { 'tool:hidden': 0 } }) },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(called, false);
  const result = agent.session.snapshotEvents().find(e => e.type === 'tool/result');
  assert.equal(result?.type === 'tool/result' && result.data.message.isError, true);
  assert.equal(h.ctx.tools.get('hidden', agent), undefined);
});

test('invalid scores leave the entire batch closed and allow a final answer', async t => {
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('answer')]);
  const h = await harness(adapter, {
    catalog: [candidate('a'), candidate('b')],
    scorer: { score: async () => ({ scores: { 'tool:a': 0.9 } }) },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(adapter.requests.length, 2);
  assert.deepEqual(h.ctx.tools.schemas(agent), []);
  const decision = agent.session.snapshotEvents().find(e => e.type === 'just-enough-tools/decision');
  assert.equal(decision?.type === 'just-enough-tools/decision' && decision.data.status, 'score-error');
});

test('a failed registration rolls back earlier tools and prompt sections in the same batch', async t => {
  const broken = candidate('b');
  broken.create = () => { throw new Error('registration failed'); };
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('answer')]);
  const h = await harness(adapter, {
    catalog: [candidate('a'), broken], scorer: { score: async () => ({ scores: { 'tool:a': 1, 'tool:b': 1 } }) },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  await run(agent);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.ctx.tools.schemas(agent), []);
  assert.doesNotMatch(prompt(adapter.requests[1]!), /GUIDANCE_/);
  const decision = agent.session.snapshotEvents().find(e => e.type === 'just-enough-tools/decision');
  assert.equal(decision?.type === 'just-enough-tools/decision' && decision.data.status, 'registration-error');
});

test('tool registration and execution are isolated between real agents', async t => {
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('answer')]);
  const h = await harness(adapter, { catalog: [candidate('a')], scorer: { score: async () => ({ scores: { 'tool:a': 1 } }) } });
  t.after(() => h.ctx.fiber.dispose());
  const a = await h.create('a');
  const b = await h.create('b');
  await run(a);
  assert.deepEqual(h.errors, []);
  assert.ok(h.ctx.tools.get('a', a));
  assert.equal(h.ctx.tools.get('a', b), undefined);
  assert.equal(h.ctx.tools.get('a'), undefined);
  const denied = await h.ctx.tools.execute({ agent: b, name: 'a', arguments: {}, callId: ToolCallId('deny'), signal: new AbortController().signal });
  assert.equal(denied.isError, true);
});

test('preview assemblies do not rescore completed state or disclose more tools', async t => {
  let calls = 0;
  const h = await harness(new ScriptedAdapter([textResponse('plan'), textResponse('answer')]), {
    catalog: [candidate('a')], scorer: { score: async () => { calls++; return { scores: { 'tool:a': 0 } }; } },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  await run(agent);
  await agent.ctx.systemPrompt.assemble(assembleContextFor(agent));
  await agent.ctx.systemPrompt.assemble(assembleContextFor(agent));
  assert.equal(calls, 1);
  assert.deepEqual(h.errors, []);
});

test('scoring timeout cannot later register tools', async t => {
  let release!: (value: { scores: Record<string, number> }) => void;
  const h = await harness(new ScriptedAdapter([textResponse('plan'), textResponse('answer')]), {
    catalog: [candidate('a')], scoreTimeoutMs: 10,
    scorer: { score: () => new Promise(resolve => { release = resolve; }) },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  await run(agent);
  release({ scores: { 'tool:a': 1 } });
  await Promise.resolve();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.ctx.tools.schemas(agent), []);
});

test('cancellation during scoring stops the turn and never admits late scores', async t => {
  const entered = Promise.withResolvers<void>();
  const late = Promise.withResolvers<ScoringResult>();
  const adapter = new ScriptedAdapter([textResponse('plan')]);
  const h = await harness(adapter, {
    catalog: [candidate('a')], scorer: { score: () => { entered.resolve(); return late.promise; } },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }));
  await entered.promise;
  agent.cancel({ kind: 'user' });
  await agent.whenIdle();
  late.resolve({ scores: { 'tool:a': 1 } });
  await Promise.resolve();
  assert.deepEqual(h.ctx.tools.schemas(agent), []);
  assert.equal(adapter.requests.length, 1);
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'just-enough-tools/decision').length, 0);
});

test('the per-turn step limit bounds both executor and scorer requests', async t => {
  let scoringCalls = 0;
  const adapter = new ScriptedAdapter([textResponse('plan'), callResponse('a'), textResponse('must not run')]);
  const h = await harness(adapter, {
    catalog: [candidate('a'), candidate('b')], maxSteps: 2,
    scorer: { score: async () => { scoringCalls++; return { scores: { 'tool:a': 1, 'tool:b': 0 } }; } },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(adapter.requests.length, 2);
  assert.equal(scoringCalls, 1);
  const end = agent.session.snapshotEvents().findLast(e => e.type === 'turn/end');
  assert.equal(end?.type === 'turn/end' && end.data.reason.kind, 'blocked');
});

test('replayed session decisions restore local tools before a resumed agent is used', async t => {
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('answer')]);
  const h = await harness(adapter, { catalog: [candidate('a')], scorer: { score: async () => ({ scores: { 'tool:a': 1 } }) } });
  t.after(() => h.ctx.fiber.dispose());
  const original = await h.create('original');
  await run(original);
  const { agent: restored, dispose } = await h.ctx.agents.create({
    sessionId: SessionId('restored'), seed: original.session.snapshotEvents(),
    agentOptions: { provider: 'test', model: 'test' },
  });
  assert.ok(h.ctx.tools.get('a', restored));
  const assembly = await restored.ctx.systemPrompt.assemble(assembleContextFor(restored));
  assert.deepEqual(assembly.tools.map(t => t.name), ['a']);
  assert.ok(assembly.sections.some(s => s.text === 'GUIDANCE_a'));
  await dispose();
  assert.ok(h.ctx.tools.get('a', original), 'disposing the restored agent must not affect the original');
});

test('global execution guards still apply after a tool is dynamically registered', async t => {
  let executed = false;
  const h = await harness(new ScriptedAdapter([textResponse('plan'), callResponse('a'), textResponse('denied')]), {
    catalog: [candidate('a', async () => { executed = true; return 'bad'; })],
    scorer: { score: async () => ({ scores: { 'tool:a': 1 } }) },
  });
  t.after(() => h.ctx.fiber.dispose());
  h.ctx.tools.guard(() => 'Existing policy denies this operation.');
  const agent = await h.create();
  await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(executed, false);
  assert.ok(h.ctx.tools.get('a', agent));
  const result = agent.session.snapshotEvents().find(e => e.type === 'tool/result');
  assert.equal(result?.type === 'tool/result' && result.data.message.isError, true);
});

test('later scoring failures preserve tools already admitted in an earlier step', async t => {
  let count = 0;
  const adapter = new ScriptedAdapter([textResponse('plan'), callResponse('a'), textResponse('answer')]);
  const h = await harness(adapter, {
    catalog: [candidate('a'), candidate('b')],
    scorer: { score: async () => {
      if (++count > 1) throw new Error('simulated backend failure');
      return { scores: { 'tool:a': 1, 'tool:b': 0 } };
    } },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  await run(agent);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(adapter.requests.map(r => r.tools?.map(t => t.name) ?? []), [[], ['a'], ['a']]);
  assert.match(prompt(adapter.requests[2]!), /GUIDANCE_a/);
  assert.doesNotMatch(prompt(adapter.requests[2]!), /GUIDANCE_b/);
});

test('no remaining candidates means no extra scoring while normal tool execution continues', async t => {
  let calls = 0;
  const adapter = new ScriptedAdapter([textResponse('plan'), callResponse('a'), textResponse('answer')]);
  const h = await harness(adapter, {
    catalog: [candidate('a')], scorer: { score: async () => { calls++; return { scores: { 'tool:a': 1 } }; } },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(calls, 1);
  assert.equal(adapter.requests.length, 3);
});

test('complete prompt overrides are rejected before leaking a model request', async t => {
  const adapter = new ScriptedAdapter([textResponse('must not run')]);
  const h = await harness(adapter, { catalog: [], scorer: { score: async () => ({ scores: {} }) } });
  t.after(() => h.ctx.fiber.dispose());
  h.ctx.systemPrompt.section({ name: 'complete', order: 0, text: 'hidden full-tool prompt', complete: true });
  const agent = await h.create();
  await run(agent);
  assert.equal(adapter.requests.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(String(h.errors[0]), /complete prompts/);
});

test('unmanaged schema providers cannot expose extra tools to the first request', async t => {
  const adapter = new ScriptedAdapter([textResponse('must not run')]);
  const h = await harness(adapter, { catalog: [], scorer: { score: async () => ({ scores: {} }) } });
  t.after(() => h.ctx.fiber.dispose());
  h.ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'extra', description: 'bad', parameters: {} }] }));
  const agent = await h.create();
  await run(agent);
  assert.equal(adapter.requests.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(String(h.errors[0]), /schema provider/);
});

test('a new user turn reaches the scorer before its first model request', async t => {
  const inputs: ScoringInput[] = [];
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('A completed'), callResponse('b'), textResponse('B completed')]);
  const h = await harness(adapter, {
    catalog: [candidate('a'), candidate('b')],
    scorer: { score: async (input): Promise<ScoringResult> => {
      inputs.push(input);
      return { scores: inputs.length === 1 ? { 'tool:a': 1, 'tool:b': 0 } : { 'tool:b': 1 } };
    } },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  await run(agent, 'First do A');
  await run(agent, 'Now do B');
  assert.deepEqual(h.errors, []);
  assert.equal(inputs[1]!.task, 'First do A\nNow do B');
  assert.match(JSON.stringify(inputs[1]!.progress), /Now do B/);
  assert.deepEqual(adapter.requests[2]!.tools?.map(t => t.name), ['a', 'b']);
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'just-enough-tools/continued').length, 1);
});

test('Jev probabilities drive registration through the real Harness loop', async t => {
  const questionTools: string[][] = [];
  const scorer = new JevScorer({ apiKey: 'local-fixture', fetch: async (_url, request) => {
    const body = JSON.parse(String(request?.body));
    const questions = Object.entries(body.questions) as Array<[string, { instructions: { capability_name: string } }]>;
    questionTools.push(questions.map(([, q]) => q.instructions.capability_name));
    return new Response(JSON.stringify({ answers: Object.fromEntries(questions.map(([id, question]) => [id, {
      type: 'noul', noul: question.instructions.capability_name === 'read' ? 0.9 : 0.1,
    }])) }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const adapter = new ScriptedAdapter([textResponse('Need archive access'), callResponse('read'), textResponse('Done')]);
  const h = await harness(adapter, { catalog: [candidate('read'), candidate('write')], scorer });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  await run(agent);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(adapter.requests.map(r => r.tools?.map(tool => tool.name) ?? []), [[], ['read'], ['read']]);
  assert.deepEqual(questionTools, [['read', 'write'], ['write']]);
  assert.ok(agent.session.snapshotEvents().some(e => e.type === 'tool/result' && !e.data.message.isError));
});

test('legacy tool-only decisions restore into the namespaced capability model', async t => {
  const h = await harness(new ScriptedAdapter([textResponse('plan'), textResponse('answer')]), {
    catalog: [candidate('read')], scorer: { score: async () => ({ scores: { 'tool:read': 1 } }) },
  });
  t.after(() => h.ctx.fiber.dispose());
  const original = await h.create('original-legacy'); await run(original);
  const seed = original.session.snapshotEvents().map(event => {
    if (event.type !== 'just-enough-tools/decision') return event;
    const { version: _version, capabilities: _capabilities, ...data } = event.data;
    return { ...event, data: { ...data, candidates: ['read'], enabled: ['read'], added: ['read'], scores: { read: 1 } } };
  });
  const { agent } = await h.ctx.agents.create({ sessionId: SessionId('legacy'), seed, agentOptions: { provider: 'test', model: 'test' } });
  assert.ok(h.ctx.tools.get('read', agent));
});
