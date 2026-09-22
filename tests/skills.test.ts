import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Skills from '@deepseek-ai/dsh-skill';
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { discoverSkills } from '../src/skills.js';
import type { SkillCandidate } from '../src/index.js';
import type { ScoringInput, ScoringResult } from '../src/scorer.js';
import { candidate, harness, run, ScriptedAdapter, textResponse, callResponse } from './helpers.js';

function skill(name: string, body = `Instructions for ${name}`, load = async () => body): SkillCandidate {
  return { kind: 'skill', name, description: `Workflow for ${name}`, guidance: 'Use when relevant.', load };
}
function text(request: GenerateOptions): string {
  return request.messages.flatMap(m => m.content).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

test('same-named tools and skills are independently scored and a skill at the threshold stays hidden', async t => {
  const inputs: ScoringInput[] = [];
  let loaded = 0;
  const adapter = new ScriptedAdapter([textResponse('plan'), callResponse('read'), textResponse('done')]);
  const h = await harness(adapter, {
    catalog: [candidate('read'), skill('read', '', async () => { loaded++; return 'SKILL_BODY {{literal}}'; })],
    scorer: { score: async (input): Promise<ScoringResult> => {
      inputs.push(input);
      return { scores: inputs.length === 1 ? { 'tool:read': 0.9, 'skill:read': 0.5 } : { 'skill:read': 0.9 } };
    } },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  assert.equal(loaded, 0);
  await run(agent);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(inputs.map(i => i.candidates), [['tool:read', 'skill:read'], ['skill:read']]);
  assert.deepEqual(inputs[0]!.allCapabilities.map(c => c.kind), ['tool', 'skill']);
  assert.ok(!JSON.stringify(inputs[0]).includes('SKILL_BODY'));
  assert.doesNotMatch(text(adapter.requests[0]!), /SKILL_BODY/);
  assert.doesNotMatch(text(adapter.requests[1]!), /SKILL_BODY/);
  assert.match(text(adapter.requests[2]!), /SKILL_BODY \{\{literal\}\}/);
  assert.equal(loaded, 1);
  const injection = adapter.requests[2]!.messages.find(m => 'source' in m && m.source?.kind === 'just-enough-tools-skill');
  assert.equal(injection?.role, 'user', 'skills must not become higher-priority system instructions');
  assert.deepEqual(adapter.requests.map(r => r.tools?.map(t => t.name) ?? []), [[], ['read'], ['read']]);
});

test('a skill can be admitted without enabling any tool or generic skill loader', async t => {
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('rewritten')]);
  const h = await harness(adapter, { catalog: [skill('writing')], scorer: { score: async () => ({ scores: { 'skill:writing': 1 } }) } });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  await run(agent);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(adapter.requests.map(r => r.tools ?? []), [[], []]);
  assert.match(text(adapter.requests[1]!), /Instructions for writing/);
  assert.equal(h.ctx.tools.get('skill', agent), undefined);
});

test('skill load failure prevents the entire mixed batch from registering', async t => {
  let created = 0;
  const tool = candidate('read');
  const create = tool.create;
  tool.create = agent => { created++; return create(agent); };
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('fallback')]);
  const h = await harness(adapter, {
    catalog: [tool, skill('workflow', '', async () => { throw new Error('unavailable'); })],
    scorer: { score: async () => ({ scores: { 'tool:read': 1, 'skill:workflow': 1 } }) },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(created, 0);
  assert.deepEqual(h.ctx.tools.schemas(agent), []);
  const decision = agent.session.snapshotEvents().find(e => e.type === 'just-enough-tools/decision');
  assert.equal(decision?.type === 'just-enough-tools/decision' && decision.data.status, 'registration-error');
});

test('registration failure after a skill loads does not leak its instructions', async t => {
  const bad = candidate('bad'); bad.create = () => { throw new Error('broken registration'); };
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('fallback')]);
  const h = await harness(adapter, {
    catalog: [skill('workflow', 'MUST_NOT_LEAK'), candidate('read'), bad],
    scorer: { score: async () => ({ scores: { 'skill:workflow': 1, 'tool:read': 1, 'tool:bad': 1 } }) },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.ctx.tools.schemas(agent), []);
  assert.doesNotMatch(text(adapter.requests[1]!), /MUST_NOT_LEAK/);
});

test('a timed-out skill load cannot inject late instructions', async t => {
  const late = Promise.withResolvers<string>();
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('fallback')]);
  const h = await harness(adapter, {
    catalog: [skill('slow', '', () => late.promise)], scoreTimeoutMs: 10,
    scorer: { score: async () => ({ scores: { 'skill:slow': 1 } }) },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  late.resolve('LATE_BODY'); await Promise.resolve();
  assert.deepEqual(h.errors, []);
  assert.doesNotMatch(text(adapter.requests[1]!), /LATE_BODY/);
  assert.equal(agent.session.deriveMessages().filter(m => m.source.kind === 'just-enough-tools-skill').length, 0);
});

test('skill state survives session replay without duplicating already-present instructions', async t => {
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('first answer'), textResponse('next answer')]);
  const h = await harness(adapter, {
    catalog: [skill('writing')], scorer: { score: async () => ({ scores: { 'skill:writing': 1 } }) },
  });
  t.after(() => h.ctx.fiber.dispose());
  const first = await h.create('first'); await run(first);
  const { agent: restored } = await h.ctx.agents.create({ sessionId: SessionId('restored-skill'),
    seed: JSON.parse(JSON.stringify(first.session.snapshotEvents())), agentOptions: { provider: 'test', model: 'test' } });
  await run(restored, 'Continue');
  assert.deepEqual(h.errors, []);
  assert.match(text(adapter.requests[2]!), /Instructions for writing/);
  assert.equal(restored.session.deriveMessages().filter(m => m.source.kind === 'just-enough-tools-skill').length, 1);
});

test('newly discovered skills join the next decision without reopening existing tools', async t => {
  let published = false;
  const inputs: ScoringInput[] = [];
  const adapter = new ScriptedAdapter([textResponse('plan'), callResponse('read'), textResponse('done')]);
  const h = await harness(adapter, {
    catalog: [candidate('read', async () => { published = true; return 'New workflow available'; })],
    discoverSkills: async () => ({ skills: published ? [skill('late', 'LATE_WORKFLOW')] : [], complete: true }),
    scorer: { score: async (input): Promise<ScoringResult> => {
      inputs.push(input);
      return { scores: inputs.length === 1 ? { 'tool:read': 1 } : { 'skill:late': 1 } };
    } },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(inputs.map(i => i.candidates), [['tool:read'], ['skill:late']]);
  assert.match(text(adapter.requests[2]!), /LATE_WORKFLOW/);
});

test('instructions revealed by a skill can trigger a later independent tool admission', async t => {
  const inputs: ScoringInput[] = [];
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('The workflow requires record access.'), callResponse('read'), textResponse('done')]);
  const h = await harness(adapter, {
    catalog: [candidate('read'), skill('workflow', 'Read a record to complete this workflow.')],
    scorer: { score: async (input): Promise<ScoringResult> => {
      inputs.push(input);
      return { scores: inputs.length === 1 ? { 'tool:read': 0, 'skill:workflow': 1 } : { 'tool:read': 1 } };
    } },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.equal(inputs[0]!.activeSkills.length, 0);
  assert.match(inputs[1]!.activeSkills[0]!.instructions, /Read a record/);
  assert.deepEqual(adapter.requests.map(r => r.tools?.map(t => t.name) ?? []), [[], [], ['read'], ['read']]);
});

test('native skill injections cannot bypass first-round selection', async t => {
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('answer')]);
  const h = await harness(adapter, { catalog: [], scorer: { score: async () => ({ scores: {} }) } });
  t.after(() => h.ctx.fiber.dispose());
  h.ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    return { ...decision, messages: [...decision.messages, createUserMessage({
      source: { kind: 'skill-invocation', name: 'hidden', form: 'instructions' },
      content: [{ type: 'text', text: 'UNSELECTED_NATIVE_SKILL' }],
    })] };
  });
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.ok(adapter.requests.every(r => !text(r).includes('UNSELECTED_NATIVE_SKILL')));
});

test('filesystem discovery respects invocation policy and retains resource paths on load', async t => {
  const root = mkdtempSync(join(tmpdir(), 'just-enough-tools-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'workflow'));
  writeFileSync(join(root, 'workflow', 'SKILL.md'), '---\nname: workflow\ndescription: Review local files\nwhenToUse: Before editing\n---\nBODY_MARKER {{literal}}\nRead references/checklist.md.\n');
  mkdirSync(join(root, 'manual-only'));
  writeFileSync(join(root, 'manual-only', 'SKILL.md'), '---\nname: manual-only\ndescription: Manual instructions\ndisable-model-invocation: true\n---\nHIDDEN_BODY\n');
  const h = await harness(new ScriptedAdapter([]));
  t.after(() => h.ctx.fiber.dispose());
  await h.ctx.plugin(Skills);
  await h.ctx.plugin(SkillFilesystem, { includeDefaultRoots: false, customSkillDirs: [root], watch: false });
  const agent = await h.create();
  const result = await discoverSkills(h.ctx, agent, new AbortController().signal);
  assert.equal(result.complete, true);
  assert.deepEqual(result.skills.map(s => s.name), ['workflow']);
  assert.equal(result.skills[0]!.guidance, 'Before editing');
  assert.ok(!JSON.stringify(result.skills).includes('BODY_MARKER'));
  const body = await result.skills[0]!.load(new AbortController().signal);
  assert.match(body, /BODY_MARKER \{\{literal\}\}/);
  assert.ok(body.includes(join(root, 'workflow')));
});

test('an incomplete discovery retains the last-known skill instead of dropping it', async t => {
  let discovery = 0;
  const inputs: ScoringInput[] = [];
  const adapter = new ScriptedAdapter([textResponse('plan'), callResponse('read'), textResponse('done')]);
  const h = await harness(adapter, {
    catalog: [candidate('read')],
    discoverSkills: async () => ++discovery === 1 ? { skills: [skill('workflow')], complete: true } : { skills: [], complete: false },
    scorer: { score: async (input): Promise<ScoringResult> => {
      inputs.push(input);
      return { scores: inputs.length === 1 ? { 'tool:read': 1, 'skill:workflow': 0 } : { 'skill:workflow': 1 } };
    } },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create(); await run(agent);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(inputs[1]!.candidates, ['skill:workflow']);
  assert.match(text(adapter.requests[2]!), /Instructions for workflow/);
  const decision = agent.session.snapshotEvents().find(e => e.type === 'just-enough-tools/decision');
  assert.equal(decision?.type === 'just-enough-tools/decision' && decision.data.catalogComplete, false);
});

test('skills opened in one agent do not appear in another agent', async t => {
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('first answer')]);
  const h = await harness(adapter, { catalog: [skill('workflow')], scorer: { score: async () => ({ scores: { 'skill:workflow': 1 } }) } });
  t.after(() => h.ctx.fiber.dispose());
  const first = await h.create('first-skill');
  const second = await h.create('second-skill');
  await run(first);
  assert.deepEqual(h.errors, []);
  assert.ok(first.session.deriveMessages().some(m => m.source.kind === 'just-enough-tools-skill'));
  assert.ok(!second.session.deriveMessages().some(m => m.source.kind === 'just-enough-tools-skill'));
  const assembly = await second.ctx.systemPrompt.assemble({ agent: second, scope: second });
  assert.ok(!assembly.sections.some(s => s.name === 'just-enough-tools:skill:workflow'));
});

test('cancelling during skill loading leaves no instruction or tool admission', async t => {
  const entered = Promise.withResolvers<void>();
  const late = Promise.withResolvers<string>();
  const adapter = new ScriptedAdapter([textResponse('plan')]);
  const h = await harness(adapter, {
    catalog: [candidate('read'), skill('slow', '', () => { entered.resolve(); return late.promise; })],
    scorer: { score: async () => ({ scores: { 'tool:read': 1, 'skill:slow': 1 } }) },
  });
  t.after(() => h.ctx.fiber.dispose());
  const agent = await h.create();
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }));
  await entered.promise; agent.cancel({ kind: 'user' }); await agent.whenIdle();
  late.resolve('LATE_INSTRUCTIONS'); await Promise.resolve();
  assert.deepEqual(h.ctx.tools.schemas(agent), []);
  assert.equal(adapter.requests.length, 1);
  assert.equal(agent.session.deriveMessages().filter(m => m.source.kind === 'just-enough-tools-skill').length, 0);
});
