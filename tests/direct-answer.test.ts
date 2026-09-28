import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidate, harness, ScriptedAdapter, textResponse, run, prompt } from './helpers.js';

for (const answer of [
  '2 + 2 = 4.',
  'No external capabilities needed.\n4.',
]) test('no valid intent skips scoring: ' + JSON.stringify(answer), async t => {
  let calls = 0;
  const adapter = new ScriptedAdapter([textResponse(answer)]);
  const h = await harness(adapter, { catalog: [candidate('read')], failOnRoutingError: true,
    discoverSkills: async () => ({ skills: [], complete: false }),
    scorer: { score: async () => { calls++; throw new Error('must not call'); } } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent, '2 + 2?');
  assert.deepEqual(h.errors, []);
  assert.equal(adapter.requests.length, 1);
  assert.equal(calls, 0);
  assert.deepEqual(h.ctx.tools.schemas(agent), []);
  assert.ok(!agent.session.snapshotEvents().some(e => e.type === 'just-enough-tools/decision'));
  assert.match(prompt(adapter.requests[0]!), /\[REQUEST_CAPABILITIES\]/);
});

for (const score of [0.1, 0.5, 0.9]) test('explicit request scores once then continues: ' + score, async t => {
  let calls = 0;
  const adapter = new ScriptedAdapter([
    textResponse('[REQUEST_CAPABILITIES]\nI need to read the file.'),
    textResponse('Final answer or limitation.'),
  ]);
  const h = await harness(adapter, { catalog: [candidate('read')], scorer: {
    score: async input => {
      calls++;
      assert.equal(input.agentResponse, '[REQUEST_CAPABILITIES]\nI need to read the file.');
      return { scores: { 'tool:read': score } };
    },
  } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(adapter.requests.length, 2);
  assert.equal(calls, 1);
  assert.equal(h.ctx.tools.schemas(agent).length, score > 0.5 ? 1 : 0);
  assert.match(prompt(adapter.requests[1]!), /\[REQUEST_CAPABILITIES\]/);
});

test('requested scoring failure stops execution', async t => {
  const adapter = new ScriptedAdapter([textResponse('[REQUEST_CAPABILITIES]\nRead file.')]);
  const h = await harness(adapter, { catalog: [candidate('read')], failOnRoutingError: true,
    scorer: { score: async () => { throw new Error('fixture failure'); } } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.equal(h.errors.length, 1);
  assert.equal(adapter.requests.length, 1);
});

test('a later user task can request capabilities after a direct answer', async t => {
  let calls = 0;
  const adapter = new ScriptedAdapter([textResponse('4.'), textResponse('I checked the task.\n**[request-capabilities]**: Need read for the new task'), textResponse('read is now available')]);
  const h = await harness(adapter, { catalog: [candidate('read')], scorer: {
    score: async () => { calls++; return { scores: { 'tool:read': 0.9 } }; },
  } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent, '2 + 2?'); await run(agent, 'Read file');
  assert.deepEqual(h.errors, []);
  assert.equal(calls, 1);
  assert.deepEqual(adapter.requests[2]?.tools?.map(tool => tool.name), ['read']);
});

test('repeated requests cannot exceed the step budget', async t => {
  let calls = 0;
  const request = textResponse('[REQUEST_CAPABILITIES]\nRead file.');
  const adapter = new ScriptedAdapter([request, request]);
  const h = await harness(adapter, { catalog: [candidate('read')], maxSteps: 2,
    scorer: { score: async () => { calls++; return { scores: { 'tool:read': 0 } }; } } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(adapter.requests.length, 2);
  assert.equal(calls, 1);
});

for (const reply of ['Please REQUEST_CAPABILITIES to read files.', '[REQUEST_CAPABILITIES]', '> request-capabilities', '```\nREQUEST CAPABILITIES\n```']) {
  test('keyword anywhere triggers one scoring call: ' + JSON.stringify(reply), async t => {
    let calls = 0;
    const adapter = new ScriptedAdapter([textResponse(reply), textResponse('Done.')]);
    const h = await harness(adapter, { catalog: [candidate('read')], scorer: {
      score: async () => { calls++; return { scores: { 'tool:read': 0.9 } }; },
    } });
    t.after(() => h.ctx.fiber.dispose());
    const agent = await h.create(); await run(agent);
    assert.deepEqual(h.errors, []);
    assert.equal(calls, 1);
    assert.equal(adapter.requests.length, 2);
    assert.deepEqual(adapter.requests[1]!.tools?.map(tool => tool.name), ['read']);
  });
}
