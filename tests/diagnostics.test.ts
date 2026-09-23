import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionSummary, routingErrorHint } from '../src/diagnostics.js';
import { ScorerError } from '../src/scorer.js';
import { candidate, harness, ScriptedAdapter, textResponse, run } from './helpers.js';
import type { Decision } from '../src/index.js';

const decision: Decision = {
  afterStepSeq: 5, threshold: 0.5, durationMs: 10, catalogComplete: true, status: 'ok',
  candidates: ['tool:read', 'skill:debug', 'tool:write'], enabled: ['tool:read'], added: ['tool:read'],
  scores: { 'tool:read': 0.9, 'skill:debug': 0.5, 'tool:write': 0.1 },
};
test('diagnostics show exact scores, strict threshold decisions and enabled capabilities', () => {
  const view = JSON.parse(decisionSummary(decision));
  assert.equal(view.outcome, 'capabilities-added');
  assert.deepEqual(view.scores, [
    { id: 'tool:read', score: 0.9, result: 'opened' },
    { id: 'skill:debug', score: 0.5, result: 'below-or-equal-threshold' },
    { id: 'tool:write', score: 0.1, result: 'below-or-equal-threshold' },
  ]);
  assert.deepEqual(view.enabled, ['tool:read']);
  assert.equal(JSON.parse(decisionSummary({ ...decision, added: [] })).outcome, 'none-above-threshold');
  assert.equal(JSON.parse(decisionSummary({ ...decision, status: 'score-error', scores: {}, errorCode: 'HTTP_401' })).scores[0].score, null);
  assert.match(routingErrorHint('HTTP_401'), /API key/);
});
test('mode failure stops after planning, persists the error and never exposes provider body text', async t => {
  const adapter = new ScriptedAdapter([textResponse('plan')]);
  const h = await harness(adapter, { catalog: [candidate('read')], failOnRoutingError: true,
    scorer: { score: async () => { throw new ScorerError('HTTP_401'); } } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  await run(agent);
  assert.equal(adapter.requests.length, 1);
  assert.equal(h.errors.length, 1);
  assert.match(String(h.errors[0]), /HTTP_401/);
  const event = agent.session.snapshotEvents().find(e => e.type === 'just-enough-tools/decision');
  assert.equal(event?.type === 'just-enough-tools/decision' && event.data.errorCode, 'HTTP_401');
  assert.deepEqual(h.ctx.tools.schemas(agent), []);
});
test('low scores are a successful decision and do not stop the agent', async t => {
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('answer')]);
  const h = await harness(adapter, { catalog: [candidate('read')], failOnRoutingError: true,
    scorer: { score: async () => ({ scores: { 'tool:read': 0.1 } }) } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(adapter.requests.length, 2);
});
test('registration failure is visible and keeps the batch closed', async t => {
  const tool = candidate('read'); tool.create = () => { throw new Error('secret provider response'); };
  const adapter = new ScriptedAdapter([textResponse('plan')]);
  const h = await harness(adapter, { catalog: [tool], failOnRoutingError: true,
    scorer: { score: async () => ({ scores: { 'tool:read': 0.9 } }) } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.match(String(h.errors[0]), /REGISTRATION_FAILED/);
  assert.doesNotMatch(String(h.errors[0]), /secret provider response/);
  assert.deepEqual(h.ctx.tools.schemas(agent), []);
});

// Test the actual process output with no Cordis logging exporter installed.
// A logger spy would miss the Web-mode bug this guards against.
test('routing scores reach stderr without a host logger exporter', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const script = `
    import { harness, candidate, ScriptedAdapter, textResponse, run } from './tests/helpers.ts';
    const h = await harness(new ScriptedAdapter([textResponse('plan'),textResponse('answer')]), {
      catalog: [candidate('read')], debug: () => true,
      scorer: {score: async () => ({scores: {'tool:read': 0.75}})},
    });
    const agent = await h.create(); await run(agent);
    await h.ctx.fiber.dispose();
  `;
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), timeout: 10000,
  });
  assert.match(result.stderr, /\[Just enough tools\].*scoring/);
  assert.match(result.stderr, /"id":"tool:read","score":0.75,"result":"opened"/);
  assert.match(result.stderr, /"enabled":\["tool:read"\]/);
  assert.equal(result.stdout, '');
});

test('disabled diagnostics do not print successful routing decisions', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const script = `
    import { harness, candidate, ScriptedAdapter, textResponse, run } from './tests/helpers.ts';
    const h = await harness(new ScriptedAdapter([textResponse('plan'),textResponse('answer')]), {
      catalog: [candidate('read')], debug: () => false,
      scorer: {score: async () => ({scores: {'tool:read': 0.75}})},
    });
    const agent = await h.create(); await run(agent);
    await h.ctx.fiber.dispose();
  `;
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), timeout: 10000,
  });
  assert.doesNotMatch(result.stderr, /\[Just enough tools\]/);
});
