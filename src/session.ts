/** Agent-preset child: routes only agents bound to the Just enough tools preset. */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import { installJustEnoughTools } from './index.js';
import type { ToolCandidate } from './index.js';
import type {} from './plugin.js';
import { discoverSkills } from './skills.js';

export const name = 'just-enough-tools-session';
export const inject = ['tools', 'skills', 'systemPrompt', 'justEnoughToolsSettings'];

/** Capture this preset's inherited tools, then let Just enough tools own the agent-local set. */
export function apply(ctx: Context): void {
  const attach = (agent: Agent) => {
    const settings = ctx.justEnoughToolsSettings;
    if (settings.has(agent)) return false;
    const catalog: ToolCandidate[] = ctx.tools.schemas(agent).filter(schema => schema.name !== 'skill').map(schema => {
      const definition = ctx.tools.get(schema.name, agent);
      if (!definition) throw new Error('Just enough tools candidate vanished before agent initialization.');
      return { ...schema, kind: 'tool', guidance: '', create: () => definition };
    });
    const stop = installJustEnoughTools(agent, {
      catalog,
      discoverSkills: signal => discoverSkills(ctx, agent, signal),
      scorer: { score: (input, signal) => settings.scorer().score(input, signal) },
      threshold: settings.config.threshold.get(),
      maxSteps: settings.config.maxSteps.get(),
      scoreTimeoutMs: settings.config.scoreTimeoutMs.get(),
      inheritedGuidance: true,
      debug: () => settings.config.debug.get(),
      failOnRoutingError: true,
    });
    settings.track(agent, stop);
    return true;
  };
  ctx.on('agent/created', ({ agent }) => { attach(agent); return undefined; });
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (!context.agent) return next();
    if (context.signal) ctx.justEnoughToolsSettings.scorer();
    // Blank conversations can change preset without creating a new Agent.
    if (attach(context.agent)) return ctx.systemPrompt.assemble(context);
    return next();
  }, { prepend: true });
}
