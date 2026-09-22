/** Host settings for the independently selectable Just enough tools mode. */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type { Context, Volatile } from '@deepseek-ai/cordis';
import '@deepseek-ai/cordis-plugin-loader';
import z from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-settings';
import { JevScorer } from './scorer.js';

export const name = 'just-enough-tools-settings';
export const inject = ['agents'];

export interface Config {
  apiKey: Volatile<string | undefined>;
  baseUrl: Volatile<string>;
  model: Volatile<string>;
  threshold: Volatile<number>;
  maxSteps: Volatile<number>;
  scoreTimeoutMs: Volatile<number>;
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  baseUrl: z.string().default('https://api.typesafe.ai/v1').volatile(),
  model: z.string().default('jev-latest').volatile(),
  threshold: z.number().min(0).max(1).default(0.5).volatile(),
  maxSteps: z.number().min(2).step(1).default(12).volatile(),
  scoreTimeoutMs: z.number().min(1).max(2_147_483_647).step(1).default(60000).volatile(),
});

export interface ModeSettings {
  config: Config;
  has(agent: Agent): boolean;
  track(agent: Agent, stop: () => void): void;
  /** Resolve current settings for every call, so saved API changes take effect live. */
  scorer(): JevScorer;
}

declare module '@deepseek-ai/cordis' {
  interface Context { justEnoughToolsSettings: ModeSettings }
}

/** Expose settings without installing routing into any existing or ordinary-mode agent. */
export function apply(ctx: Context, config: Config): void {
  const active = new Map<Agent, () => void>();
  const detach = (agent: Agent) => { active.get(agent)?.(); active.delete(agent); };
  ctx.provide('justEnoughToolsSettings', {
    config,
    has: agent => active.has(agent),
    track: (agent, stop) => { active.set(agent, stop); },
    scorer() {
      const apiKey = config.apiKey.get() || process.env.TYPESAFE_API_KEY;
      if (!apiKey) throw new Error('Configure the Jev API key in Plugins > dsh-just-enough-tools before using Just enough tools mode.');
      return new JevScorer({ apiKey, baseUrl: config.baseUrl.get(), model: config.model.get(), timeoutMs: config.scoreTimeoutMs.get() });
    },
  } satisfies ModeSettings);
  ctx.on('agent-preset/selected', (sessionId, preset) => {
    const agent = ctx.agents.get(sessionId);
    if (agent && preset !== 'just-enough-tools') detach(agent);
  });
  ctx.on('agent/disposed', ({ agent }) => detach(agent));
  ctx.effect(() => () => { for (const stop of active.values()) stop(); active.clear(); });
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber));
  });
}

export { JevScorer, jevConfigFromEnv } from './scorer.js';
