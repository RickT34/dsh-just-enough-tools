import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidate, harness, ScriptedAdapter, textResponse, run } from './helpers.js';

for (const [name, first, score, expected] of [
  ['complete direct answer with low scores', '无需外部能力。\n\n2 + 2 = 4。', 0.1, 1],
  ['score at threshold remains conservative', '无需外部能力。\n\n答案。', 0.5, 2],
  ['needed tool overrides direct declaration', '无需外部能力。\n\n答案。', 0.9, 2],
  ['plan alone still needs a final answer', '先考虑这个问题。', 0.1, 2],
  ['declaration without answer is incomplete', '无需外部能力。', 0.1, 2],
] as const) test(name, async t => {
  let calls = 0;
  const adapter = new ScriptedAdapter([textResponse(first), textResponse('final')]);
  const h = await harness(adapter, { catalog: [candidate('read')], scorer: {
    score: async () => { calls++; return { scores: { 'tool:read': score } }; },
  } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(adapter.requests.length, expected);
  assert.equal(calls, 1);
  assert.equal(agent.session.snapshotEvents().some(e => e.type === 'just-enough-tools/direct-answer'), expected === 1);
  assert.equal(h.ctx.tools.schemas(agent).length, score > 0.5 ? 1 : 0);
});

test('failed scoring does not accept a direct answer as verified', async t => {
  const adapter = new ScriptedAdapter([textResponse('无需外部能力。\n\n4。')]);
  const h = await harness(adapter, { catalog: [candidate('read')], failOnRoutingError: true,
    scorer: { score: async () => { throw new Error('fixture failure'); } } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.equal(h.errors.length, 1);
  assert.ok(!agent.session.snapshotEvents().some(e => e.type === 'just-enough-tools/direct-answer'));
});

test('incomplete discovery cannot approve a direct answer', async t => {
  const adapter = new ScriptedAdapter([textResponse('无需外部能力。\n\n4。'), textResponse('final')]);
  const h = await harness(adapter, { catalog: [candidate('read')], discoverSkills: async () => ({ skills: [], complete: false }),
    scorer: { score: async () => ({ scores: { 'tool:read': 0.1 } }) } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(adapter.requests.length, 2);
});

test('a later user task is scored again after a direct answer', async t => {
  let calls = 0;
  const adapter = new ScriptedAdapter([textResponse('无需外部能力。\n\n4。'), textResponse('read is now available')]);
  const h = await harness(adapter, { catalog: [candidate('read')], scorer: {
    score: async input => { calls++; return { scores: { 'tool:read': input.task.includes('Read file') ? 0.9 : 0.1 } }; },
  } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent, '2 + 2?'); await run(agent, 'Read file');
  assert.deepEqual(h.errors, []);
  assert.equal(calls, 2);
  assert.deepEqual(adapter.requests[1]?.tools?.map(tool => tool.name), ['read']);
});
