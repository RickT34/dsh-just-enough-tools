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
