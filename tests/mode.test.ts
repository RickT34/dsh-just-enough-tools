import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import Skills from '@deepseek-ai/dsh-skill';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import { SessionId } from '@deepseek-ai/dsh-session';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import * as Settings from '../src/plugin.js';
import { harness, ScriptedAdapter, textResponse, callResponse, run, prompt } from './helpers.js';

const tools = new URL('./fixtures/preset-tools.mjs', import.meta.url).href;
const routing = new URL('../src/session.ts', import.meta.url).href;

test('only Just enough tools mode starts empty and routes through the configured Jev endpoint', async t => {
  let scoringCalls = 0;
  let authorization: string | undefined;
  const server = createServer(async (req, res) => {
    authorization = req.headers.authorization;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    scoringCalls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({answers:Object.fromEntries(Object.keys(body.questions).map(id=>[id,{type:'noul',noul:0.9}]))}));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const address=server.address(); assert.ok(address && typeof address==='object');
  const adapter = new ScriptedAdapter([textResponse('ordinary answer'),textResponse('plan'),callResponse('read'),textResponse('done')]);
  const h = await harness(adapter);
  t.after(()=>h.ctx.fiber.dispose());
  await h.ctx.plugin(Loader);
  await h.ctx.plugin(Skills);
  await h.ctx.plugin(AgentPresets,{default:'standard'});
  await h.ctx.plugin(Settings,{apiKey:'mode-test-key',baseUrl:`http://127.0.0.1:${address.port}/v1`});
  await h.ctx.agentPresets.register({id:'standard',plugins:[{name:tools}]});
  await h.ctx.agentPresets.register({id:'just-enough-tools',name:'Just enough tools',plugins:[{name:tools},{name:routing}]});
  const create = async (id:string,preset:string) => (await h.ctx.agents.create({
    sessionId:SessionId(id),agentOptions:{provider:'test',model:'test'},
    setup: async ctx => {await h.ctx.agentPresets.mount(ctx,preset);},
  })).agent;
  const normal=await create('ordinary','standard');
  assert.deepEqual(h.ctx.tools.schemas(normal).map(t=>t.name),['read']);
  await run(normal);
  assert.equal(scoringCalls,0);
  const routed=await create('routed','just-enough-tools');
  assert.deepEqual(h.ctx.tools.schemas(routed),[]);
  assert.deepEqual(h.ctx.tools.schemas(normal).map(t=>t.name),['read']);
  await run(routed);
  assert.deepEqual(h.errors,[]);
  assert.equal(scoringCalls,1);
  assert.equal(authorization,'Bearer mode-test-key');
  assert.deepEqual(adapter.requests.map(r=>r.tools?.map(t=>t.name)??[]),[['read'],[],['read'],['read']]);
  assert.doesNotMatch(prompt(adapter.requests[1]!), /Use read to inspect/);
  assert.match(prompt(adapter.requests[2]!), /Use read to inspect/);
});

test('installing the mode settings without a key leaves ordinary mode usable', async t => {
  const h=await harness(new ScriptedAdapter([textResponse('ordinary answer')]));
  t.after(()=>h.ctx.fiber.dispose());
  await h.ctx.plugin(Settings,{});
  const agent=await h.create();
  await run(agent);
  assert.deepEqual(h.errors,[]);
  assert.equal(h.ctx.justEnoughToolsSettings.config.apiKey.get(),undefined);
});

test('switching a blank conversation into and out of Just enough tools restores ordinary tools', async t => {
  const adapter=new ScriptedAdapter([textResponse('ordinary answer')]);
  const h=await harness(adapter);
  t.after(()=>h.ctx.fiber.dispose());
  await h.ctx.plugin(Loader);
  await h.ctx.plugin(Skills);
  await h.ctx.plugin(AgentPresets,{default:'standard'});
  await h.ctx.plugin(Settings,{apiKey:'fixture'});
  await h.ctx.agentPresets.register({id:'standard',plugins:[{name:tools}]});
  await h.ctx.agentPresets.register({id:'just-enough-tools',plugins:[{name:tools},{name:routing}]});
  const {agent}=await h.ctx.agents.create({sessionId:SessionId('switching'),agentOptions:{provider:'test',model:'test'},
    setup:async ctx=>{await h.ctx.agentPresets.mount(ctx,'standard');}});
  await h.ctx.agentPresets.select(agent,'just-enough-tools');
  const routed=await agent.ctx.systemPrompt.assemble(assembleContextFor(agent));
  assert.deepEqual(routed.tools,[]);
  await h.ctx.agentPresets.select(agent,'standard');
  const ordinary=await agent.ctx.systemPrompt.assemble(assembleContextFor(agent));
  assert.deepEqual(ordinary.tools.map(t=>t.name),['read']);
  assert.ok(!ordinary.sections.some(s=>s.name==='just-enough-tools:phase'));
  await run(agent);
  assert.deepEqual(h.errors,[]);
  assert.equal(adapter.requests.length,1);
});

test('Just enough tools mode scores registry skills alongside tools without exposing the native skill loader', async t => {
  const seen: Array<{ questions: Record<string, { instructions: { capability_kind: string } }>; state: { all_capabilities: Array<{ id: string }>; active_skills: Array<{ instructions: string }> } }> = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); seen.push(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, {
      type: 'noul', noul: (question as { instructions: { capability_kind: string } }).instructions.capability_kind === 'skill' ? 0.9 : 0,
    }])) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const adapter = new ScriptedAdapter([textResponse('plan'), textResponse('followed the workflow')]);
  const h = await harness(adapter); t.after(() => h.ctx.fiber.dispose());
  await h.ctx.plugin(Loader); await h.ctx.plugin(Skills);
  await h.ctx.plugin(AgentPresets, { default: 'standard' });
  await h.ctx.plugin(Settings, { apiKey: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1` });
  h.ctx.skills.register({ name: 'read', description: 'A reading workflow', content: 'REGISTERED_SKILL_BODY', source: 'runtime' });
  h.ctx.skills.register({ name: 'manual-only', description: 'Only for explicit human use', content: 'FORBIDDEN_BODY', source: 'runtime',
    invocation: { modelInvocable: false, userInvocable: true } });
  h.ctx.tools.register({ name: 'skill', description: 'Ungated loader must remain hidden', parameters: { type: 'object', properties: {} },
    execute: async () => 'FORBIDDEN_LOADER', output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] } });
  await h.ctx.agentPresets.register({ id: 'just-enough-tools', plugins: [{ name: tools }, { name: routing }] });
  const { agent } = await h.ctx.agents.create({ sessionId: SessionId('registry-skills'), agentOptions: { provider: 'test', model: 'test' },
    setup: async ctx => { await h.ctx.agentPresets.mount(ctx, 'just-enough-tools'); } });
  await run(agent);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(seen[0]!.state.all_capabilities.map(c => c.id), ['tool:read', 'skill:read']);
  assert.ok(!JSON.stringify(seen[0]).includes('REGISTERED_SKILL_BODY'));
  assert.match(seen[1]!.state.active_skills[0]!.instructions, /REGISTERED_SKILL_BODY/);
  assert.deepEqual(adapter.requests.map(r => r.tools ?? []), [[], []]);
  const visible = adapter.requests[1]!.messages.flatMap(m => m.content).filter(b => b.type === 'text').map(b => b.text).join('\n');
  assert.match(visible, /REGISTERED_SKILL_BODY/);
  assert.doesNotMatch(visible, /FORBIDDEN_BODY|FORBIDDEN_LOADER/);
  assert.equal((await h.ctx.skills.get('read'))?.content, 'REGISTERED_SKILL_BODY');
});
