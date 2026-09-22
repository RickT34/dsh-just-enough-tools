import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as JustEnoughTools from '../src/index.js';
import type { Agent } from '@deepseek-ai/dsh-agent';

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

export function callResponse(name: string, id = name): StreamChunk[] {
  const callId = ToolCallId(id);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

export class ScriptedAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  constructor(private script: StreamChunk[][]) { super(); }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const chunks = this.script.shift();
    if (!chunks) throw new Error('Script exhausted');
    yield* chunks;
  }
}

export function candidate(name: string, execute = async () => `${name} result`): JustEnoughTools.ToolCandidate {
  const parameters = { type: 'object', properties: {}, additionalProperties: false };
  return {
    kind: 'tool', name, description: `${name} description`, parameters, guidance: `GUIDANCE_${name}`,
    create: () => ({
      name, description: `${name} description`, parameters, execute,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    }),
  };
}

export async function harness(adapter: LlmAdapter, config?: JustEnoughTools.Config) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  if (config) await ctx.plugin(JustEnoughTools, config);
  ctx.llm.registerAdapter(['test'], adapter);
  const errors: unknown[] = [];
  ctx.on('agent/error', ({ error }) => { errors.push(error); });
  const create = (id = 'test') => ctx.agentLoop.create(SessionId(id), { provider: 'test', model: 'test' });
  return { ctx, errors, create };
}

export async function run(agent: Agent, task = 'Complete the original task') {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }));
  await agent.whenIdle();
}

export function prompt(request: GenerateOptions) {
  return request.messages.filter(m => m.role === 'system').flatMap(m => m.content)
    .filter(b => b.type === 'text').map(b => b.text).join('\n');
}
