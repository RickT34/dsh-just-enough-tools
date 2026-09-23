/** Progressive admission of tools and skills into one isolated agent. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { PromptAssembly, AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { jevConfigFromEnv, JevScorer, ScorerError, validateScores } from './scorer.js';
import type { CapabilitySummary, Scorer, ScoringResult } from './scorer.js';
export * from './scorer.js';
import { decisionSummary, routingErrorHint, writeRoutingDiagnostic } from './diagnostics.js';

export const name = 'just-enough-tools';
export const inject = ['agents', 'tools', 'systemPrompt'];

interface CandidateBase { name: string; description: string; guidance: string }
export interface ToolCandidate extends CandidateBase {
  kind: 'tool';
  parameters: unknown;
  /** Synchronous factory; it must not register side effects itself. */
  create(agent: Agent): ToolDefinition;
}
export interface SkillCandidate extends CandidateBase {
  kind: 'skill';
  provider?: string;
  /** Load full instructions only after admission. No registration side effects. */
  load(signal: AbortSignal): Promise<string>;
}
export type CapabilityCandidate = ToolCandidate | SkillCandidate;
export interface SkillCatalogSnapshot { skills: SkillCandidate[]; complete: boolean }
export interface Config {
  catalog: readonly CapabilityCandidate[];
  /** Scope-aware metadata discovery; incomplete observations retain last-known candidates. */
  discoverSkills?: (signal: AbortSignal) => Promise<SkillCatalogSnapshot>;
  scorer?: Scorer;
  inheritedGuidance?: boolean;
  /** Read on each decision, so the plugin settings toggle applies immediately. */
  debug?: () => boolean;
  failOnRoutingError?: boolean;
  threshold?: number;
  maxSteps?: number;
  /** Bounds each discovery, scoring or instruction-loading operation. */
  scoreTimeoutMs?: number;
}
export interface Decision {
  /** Absent in legacy tool-only logs, whose IDs were bare tool names. */
  version?: 2;
  afterStepSeq: number;
  threshold: number;
  candidates: string[];
  enabled: string[];
  added: string[];
  scores: Record<string, number>;
  capabilities?: Array<{ id: string; kind: 'tool' | 'skill'; name: string }>;
  catalogComplete?: boolean;
  status: 'ok' | 'score-error' | 'registration-error';
  durationMs: number;
  errorCode?: string;
  model?: string;
  usage?: Record<string, number>;
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'just-enough-tools/decision': Decision;
    'just-enough-tools/continued': { version: 1 };
    'just-enough-tools/direct-answer': { version: 1; afterStepSeq: number };
  }
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'just-enough-tools': { kind: 'just-enough-tools' };
    'just-enough-tools-skill': { kind: 'just-enough-tools-skill'; id: string; name: string; form: 'instructions' };
  }
}

const REASSEMBLED = Symbol('just-enough-tools-reassembled');
const PLAN_SECTION = 'just-enough-tools:phase';
const installed = new WeakSet<Agent>();
const INITIAL_PROMPT = 'Analyze the user task independently. Give a brief plan and identify any external operations or specialized workflows needed, without guessing specific tool or skill names. If you can answer completely without external tools or skills, provide the complete final answer now, preceded by the standalone first line "No external capabilities needed." Otherwise, provide only your plan and capability needs in this step; execution will follow. Answer in the language appropriate to the user request.';
export function capabilityId(candidate: Pick<CapabilityCandidate, 'kind' | 'name'>): string {
  return `${candidate.kind}:${candidate.name}`;
}
function summary(candidate: CapabilityCandidate): CapabilitySummary {
  return { id: capabilityId(candidate), kind: candidate.kind, name: candidate.name,
    description: candidate.description, guidance: candidate.guidance,
    ...(candidate.kind === 'tool' ? { parameters: candidate.parameters } : candidate.provider ? { provider: candidate.provider } : {}),
  };
}
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  const control = new AbortController();
  const combined = AbortSignal.any([signal, control.signal]);
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort?.(combined.reason);
  combined.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => control.abort(new ScorerError('ROUTING_TIMEOUT')), ms);
  try { combined.throwIfAborted(); return await Promise.race([work(combined), aborted]); }
  finally { clearTimeout(timer); combined.removeEventListener('abort', abort); }
}

/** Install one agent's router. Disposal unwinds its registrations and restrictions. */
export function installJustEnoughTools(agent: Agent, config: Config): () => void {
  if (installed.has(agent)) throw new Error('Just enough tools is already installed on this agent.');
  const threshold = config.threshold ?? 0.5;
  const maxSteps = config.maxSteps ?? 12;
  const timeoutMs = config.scoreTimeoutMs ?? 60_000;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('threshold must be in [0, 1].');
  if (!Number.isInteger(maxSteps) || maxSteps < 2) throw new Error('maxSteps must be an integer >= 2.');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('scoreTimeoutMs must be a positive timer-safe integer.');
  const catalog = new Map<string, CapabilityCandidate>();
  const addCandidate = (candidate: CapabilityCandidate) => {
    if (!['tool', 'skill'].includes(candidate.kind) || !candidate.name
      || (candidate.kind === 'tool' && ['run_code', 'skill'].includes(candidate.name))) {
      throw new Error('Invalid capability kind/name or reserved loader/transport tool.');
    }
    catalog.set(capabilityId(candidate), candidate);
  };
  for (const candidate of config.catalog) {
    if (catalog.has(capabilityId(candidate))) throw new Error('Candidate IDs must be unique.');
    addCandidate(candidate);
  }
  const scorer = config.scorer ?? new JevScorer(jevConfigFromEnv());
  const ctx = agent.ctx;
  const disposers: Array<() => void> = [];
  const registrations: Array<() => void> = [];
  const enabled = new Set<string>();
  const activeSkills = new Map<string, string>();
  const discovered = new Set<string>();
  const claimedMessages = new Map<string, UserMessage>();
  const lifetime = new AbortController();
  let lastScoredTurn = -1;
  let lastScored = -1, skillRevision = 0, lastScoredSkillRevision = 0;
  let continued = false, disposed = false, changing = false, catalogComplete = true;
  let scoring: Promise<void> | undefined;
  let preparation: Promise<boolean> | undefined;
  let pendingRestore: string[] = [];

  const steps = () => agent.session.snapshotEvents().filter(event => event.type === 'step/end');
  const toolNames = () => [...enabled].filter(id => catalog.get(id)?.kind === 'tool').map(id => catalog.get(id)!.name);
  const remaining = () => [...catalog.keys()].filter(id => !enabled.has(id));
  const assertRegistry = () => {
    const names = toolNames();
    const actual = ctx.tools.schemas(agent).map(tool => tool.name);
    if (actual.length !== names.length || actual.some(n => !names.includes(n))) {
      throw new Error('Just enough tools requires native mode and exclusive ownership of agent-local tool registrations.');
    }
  };
  const checkAssembly = (assembly: PromptAssembly) => {
    assertRegistry();
    // Some native tools (notably bash) register static guidance even while
    // their schemas are restricted. Gate these sections with their candidate.
    // Return a new assembly so other agents retain their inherited guidance.
    if (config.inheritedGuidance) {
      assembly = { ...assembly, sections: assembly.sections.filter(section =>
        !(section.name.startsWith('tool:') && catalog.get(section.name)?.kind === 'tool'
          && !enabled.has(section.name))) };
    }
    const names = toolNames();
    if (assembly.tools.length !== names.length || assembly.tools.some(t => !names.includes(t.name))) {
      throw new Error('A schema provider changed the Just enough tools tool set.');
    }
    const sections = new Set(assembly.sections.map(s => s.name));
    if (!sections.has(PLAN_SECTION) || [...enabled].some(id => !sections.has(`just-enough-tools:${id}`))) {
      throw new Error('Just enough tools sections were overridden; complete prompts are not supported.');
    }
    if (assembly.sections.some(s => s.text && /^(tool:|tools:|mcp:|skill:|skills:)/.test(s.name)
      && !(config.inheritedGuidance && s.name.startsWith('tool:') && enabled.has(s.name)))) {
      throw new Error('Remove independently registered capability guidance; supply it through Just enough tools.');
    }
    return assembly;
  };
  const commit = (added: string[], loaded: Map<string, string>) => {
    const batch: Array<() => void> = [];
    changing = true;
    try {
      for (const id of added) {
        const candidate = catalog.get(id);
        if (!candidate) throw new Error('Capability is no longer available.');
        let text = candidate.guidance;
        if (candidate.kind === 'tool') {
          const definition = candidate.create(agent);
          if (definition.name !== candidate.name || definition.description !== candidate.description
            || JSON.stringify(definition.parameters) !== JSON.stringify(candidate.parameters)) {
            throw new Error('Registered tool must match its scored catalog schema.');
          }
          batch.push(ctx.tools.register(definition));
        } else {
          const instructions = loaded.get(id);
          if (typeof instructions !== 'string') throw new Error('Skill loader must return instructions.');
          // Full skill bodies retain the native user-role instruction semantics.
          // This empty marker only participates in atomic availability checks.
          text = '';
        }
        batch.push(ctx.systemPrompt.section({ name: `just-enough-tools:${id}`, order: candidate.kind === 'skill' ? 6000 : 1000,
          text, interpolate: false }));
      }
      for (const id of added) {
        enabled.add(id);
        if (loaded.has(id)) { activeSkills.set(id, loaded.get(id)!); skillRevision++; }
      }
      registrations.push(...batch);
    } catch (error) { batch.reverse().forEach(dispose => dispose()); throw error; }
    finally { changing = false; }
  };
  const admit = async (added: string[], signal: AbortSignal) => {
    const selected = added.map(id => ({ id, candidate: catalog.get(id) }));
    if (selected.some(({ candidate }) => !candidate)) throw new Error('Capability is unavailable.');
    const loaded = await bounded(async loadSignal => new Map(await Promise.all(selected.flatMap(({ id, candidate }) =>
      candidate?.kind === 'skill' ? [candidate.load(loadSignal).then(text => [id, text] as [string, string])] : []))), signal, timeoutMs);
    signal.throwIfAborted();
    commit(added, loaded);
  };
  const refresh = async (signal: AbortSignal) => {
    if (config.discoverSkills) {
      try {
        const snapshot = await bounded(config.discoverSkills, signal, timeoutMs);
        signal.throwIfAborted();
        if (snapshot.skills.some(skill => skill.kind !== 'skill' || typeof skill.name !== 'string' || !skill.name || typeof skill.load !== 'function')) {
          throw new Error('Invalid discovered skill.');
        }
        const incoming = new Set(snapshot.skills.map(capabilityId));
        if (incoming.size !== snapshot.skills.length) throw new Error('Duplicate discovered skill IDs.');
        if (snapshot.complete) {
          for (const id of discovered) if (!incoming.has(id) && !enabled.has(id)) catalog.delete(id);
        }
        for (const skill of snapshot.skills) {
          if (skill.kind !== 'skill') throw new Error('Discovery returned a non-skill.');
          if (!enabled.has(capabilityId(skill))) addCandidate(skill);
          discovered.add(capabilityId(skill));
        }
        catalogComplete = snapshot.complete;
      } catch {
        signal.throwIfAborted(); catalogComplete = false;
        writeRoutingDiagnostic(`[Just enough tools] session=${agent.session.id} SKILL_DISCOVERY_FAILED: keeping last-known candidates.`);
      }
    }
    if (pendingRestore.length) {
      if (pendingRestore.some(id => !catalog.has(id))) throw new Error('Resumed session references unavailable skills.');
      await admit(pendingRestore, signal);
      pendingRestore = [];
      lastScoredSkillRevision = skillRevision;
      return true;
    }
    return false;
  };
  const prepare = (signal: AbortSignal) => preparation ??= refresh(signal).finally(() => { preparation = undefined; });
  const scoreStep = async (afterStepSeq: number, signal: AbortSignal) => {
    lastScoredTurn = agent.session.snapshotEvents().findLast(e => e.type === 'turn/start')?.seq ?? -1;
    const candidates = remaining();
    if (!candidates.length) {
      lastScored = afterStepSeq; lastScoredSkillRevision = skillRevision;
      if (config.debug?.()) writeRoutingDiagnostic(`[Just enough tools] session=${agent.session.id} no remaining candidates; enabled=${JSON.stringify([...enabled])}; catalogComplete=${catalogComplete}`);
      return;
    }
    const started = Date.now();
    if (config.debug?.()) writeRoutingDiagnostic(`[Just enough tools] session=${agent.session.id} scoring ${JSON.stringify(candidates)}; threshold=${threshold}; catalogComplete=${catalogComplete}`);
    let result: ScoringResult, status: Decision['status'] = 'ok', errorCode: string | undefined;
    let added: string[] = [];
    try {
      const history = agent.session.deriveMessages();
      const committedIds = new Set(history.map(m => m.id));
      const pending = [...claimedMessages.values()].filter(m => !committedIds.has(m.id));
      const progress = [...history, ...pending].filter(m => m.role !== 'system' && m.role !== 'developer' && m.source.kind !== 'just-enough-tools-skill')
        .map(m => ({ role: m.role, content: m.content.filter(b => b.type !== 'reasoning') }));
      const priorTasks = agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'user')
        .flatMap(e => e.type === 'user/message' ? [e.data] : []);
      const task = [...priorTasks, ...pending.filter(m => m.source.kind === 'user')]
        .map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).join('\n');
      lastScoredSkillRevision = skillRevision;
      result = await bounded(callSignal => scorer.score({ task, progress, candidates, enabled: [...enabled],
        allCapabilities: [...catalog.values()].map(summary),
        activeSkills: [...activeSkills].map(([id, instructions]) => ({ id, name: catalog.get(id)!.name, instructions })),
      }, callSignal), signal, timeoutMs);
      signal.throwIfAborted();
      result.scores = validateScores(result.scores, candidates);
    } catch (error) {
      signal.throwIfAborted(); status = 'score-error'; result = { scores: {} };
      errorCode = error instanceof ScorerError ? error.code : 'SCORER_FAILED';
    }
    if (status === 'ok') {
      added = candidates.filter(id => result.scores[id]! > threshold);
      try { await admit(added, signal); }
      catch (error) { signal.throwIfAborted(); status = 'registration-error';
        errorCode = error instanceof ScorerError ? error.code : 'REGISTRATION_FAILED'; added = []; }
    }
    lastScored = afterStepSeq;
    const decision: Decision = {
      version: 2, afterStepSeq, threshold, candidates, enabled: [...enabled], added,
      capabilities: [...catalog.values()].map(c => ({ id: capabilityId(c), kind: c.kind, name: c.name })),
      catalogComplete, scores: result.scores, status, durationMs: Date.now() - started,
      ...(errorCode ? { errorCode } : {}), ...(result.model ? { model: result.model } : {}), ...(result.usage ? { usage: result.usage } : {}),
    };
    agent.session.append('just-enough-tools/decision', decision);
    if (config.debug?.() || status !== 'ok') {
      const line = `[Just enough tools] session=${agent.session.id} ${decisionSummary(decision)}`;
      writeRoutingDiagnostic(line);
    }
    if (status !== 'ok' && config.failOnRoutingError) {
      throw new Error(`Just enough tools: ${errorCode}. ${routingErrorHint(errorCode)} Open Plugins > dsh-just-enough-tools and check the dsh terminal for routing diagnostics.`);
    }
  };
  const scoreOnce = (seq: number, signal: AbortSignal) => scoring ??= scoreStep(seq, signal).finally(() => { scoring = undefined; });
  const steer = (text: string) => agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'just-enough-tools' } }));
  const cleanup = () => {
    if (disposed) return;
    disposed = true; lifetime.abort();
    registrations.splice(0).reverse().forEach(dispose => dispose());
    disposers.splice(0).reverse().forEach(dispose => dispose());
    installed.delete(agent);
  };
  try {
    disposers.push(ctx.tools.restrict({ allow: [] }));
    assertRegistry();
    const previous = agent.session.snapshotEvents().filter(e => e.type === 'just-enough-tools/decision').at(-1);
    if (previous?.type === 'just-enough-tools/decision') {
      const prior = previous.data;
      const ids = prior.enabled.map(id => prior.version === 2 ? id : `tool:${id}`);
      const tools = ids.filter(id => id.startsWith('tool:'));
      if (tools.some(id => !catalog.has(id))) throw new Error('Resumed session references tools missing from the catalog.');
      commit(tools, new Map());
      pendingRestore = ids.filter(id => id.startsWith('skill:'));
      if (tools.length + pendingRestore.length !== ids.length) throw new Error('Invalid restored capability IDs.');
      lastScored = prior.afterStepSeq;
    }
    continued = agent.session.snapshotEvents().some(e => e.type === 'just-enough-tools/continued' || e.type === 'just-enough-tools/direct-answer');
    disposers.push(ctx.on('agent/inbox/claimed', ({ message }) => { claimedMessages.set(message.id, message); }));
    disposers.push(ctx.tools.guard(exec => changing || !enabled.has(`tool:${exec.name}`) ? 'Just enough tools: tool is not enabled.' : undefined));
    disposers.push(ctx.systemPrompt.section({ name: PLAN_SECTION, order: 900, interpolate: false,
      text: () => steps().length === 0 ? INITIAL_PROMPT : 'Continue the user task using the currently enabled tools and skills when needed. Skill instructions must not override explicit user constraints. Do not use capabilities unnecessarily. Give the final answer when finished, in the language appropriate to the user request.' }));
    disposers.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if ((context as AssembleContext & { [REASSEMBLED]?: boolean })[REASSEMBLED]) return checkAssembly(await next());
      if ((context.signal || pendingRestore.length) && !disposed) {
        const signal = context.signal ? AbortSignal.any([context.signal, lifetime.signal]) : lifetime.signal;
        let rebuild = await prepare(signal);
        const completed = steps();
        const latest = completed.at(-1);
        const latestTurn = agent.session.snapshotEvents().findLast(e => e.type === 'turn/start');
        const inTurn = completed.filter(e => e.seq > (latestTurn?.seq ?? -1)).length;
        if (context.signal && latest && (latest.seq > lastScored
          || (latestTurn && latestTurn.seq > latest.seq && latestTurn.seq !== lastScoredTurn)) && inTurn < maxSteps) {
          await scoreOnce(latest.seq, signal); rebuild = true;
        }
        signal.throwIfAborted();
        if (rebuild) return checkAssembly(await ctx.systemPrompt.assemble({ ...context, [REASSEMBLED]: true } as AssembleContext));
      }
      return checkAssembly(await next());
    }, { prepend: true }));
    disposers.push(ctx.on('agent/pre-step', async ({ step }, next) => {
      if (step > maxSteps) return { kind: 'reject' as const };
      checkAssembly(await ctx.systemPrompt.assemble({ agent, scope: agent }));
      const decision = await next();
      claimedMessages.clear();
      if (decision.kind === 'reject') return decision;
      // Native full-catalog/slash injections must not bypass capability selection.
      const visible = new Map<string, string>();
      for (const message of agent.session.deriveMessages()) {
        if (message.source.kind === 'just-enough-tools-skill') {
          visible.set(message.source.id, message.content.filter(b => b.type === 'text').map(b => b.text).join('\n'));
        }
      }
      const instructions = [...activeSkills].filter(([id, body]) => visible.get(id) !== body).map(([id, body]) =>
        createUserMessage({ content: [{ type: 'text', text: body }],
          source: { kind: 'just-enough-tools-skill', id, name: catalog.get(id)!.name, form: 'instructions' } }));
      return { ...decision, messages: [
        ...decision.messages.filter(m => !['skill-catalog', 'skill-invocation', 'just-enough-tools-skill'].includes(m.source.kind)),
        ...instructions,
      ] };
    }, { prepend: true }));
    disposers.push(ctx.on('agent/turn-stopping', async ({ signal, turn }) => {
      signal = AbortSignal.any([signal, lifetime.signal]); signal.throwIfAborted();
      if (!continued && steps().length === 1) {
        const latest = steps()[0]!;
        const reply = agent.session.deriveMessages().findLast(message => message.role === 'assistant');
        const text = reply?.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() ?? '';
        const direct = /^No external capabilities needed\.[\r\n]+\s*\S/.test(text)
          && !reply?.content.some(block => block.type === 'tool-call');
        if (direct) {
          await prepare(signal);
          if (latest.seq > lastScored) await scoreOnce(latest.seq, signal);
          signal.throwIfAborted();
          const event = agent.session.snapshotEvents().findLast(e => e.type === 'just-enough-tools/decision');
          const belowThreshold = remaining().length === 0 && enabled.size === 0
            || (event?.type === 'just-enough-tools/decision' && event.data.afterStepSeq === latest.seq
              && event.data.status === 'ok' && event.data.candidates.every(id => event.data.scores[id]! < threshold));
          if (catalogComplete && enabled.size === 0 && belowThreshold) {
            continued = true;
            agent.session.append('just-enough-tools/direct-answer', { version: 1, afterStepSeq: latest.seq });
            if (config.debug?.()) writeRoutingDiagnostic(`[Just enough tools] session=${agent.session.id} direct-answer accepted; skipped second model call.`);
            return;
          }
        }
        continued = true;
        steer('Continue the original task according to your plan. Use the tools and skills enabled for this step when needed; otherwise answer directly.');
        agent.session.append('just-enough-tools/continued', { version: 1 });
      } else if (skillRevision > lastScoredSkillRevision && steps().filter(s => s.data.turn === turn).length < maxSteps) {
        // A newly read skill may reveal dependencies that its summary did not mention.
        await prepare(signal);
        const latest = steps().at(-1);
        const before = enabled.size;
        if (latest) await scoreOnce(latest.seq, signal);
        if (enabled.size > before) steer('Additional capabilities have been enabled based on skill instructions and current progress. Continue the original task.');
      }
    }));
    ctx.effect(() => cleanup); installed.add(agent); return cleanup;
  } catch (error) { cleanup(); throw error; }
}

/** Internal Cordis composition used by behavior tests and agent-scoped integrations. */
export function apply(ctx: Context, config: Config): void {
  const active = new Map<Agent, () => void>();
  ctx.on('agent/created', ({ agent }) => { active.set(agent, installJustEnoughTools(agent, config)); return undefined; });
  ctx.on('agent/disposed', ({ agent }) => { active.get(agent)?.(); active.delete(agent); });
  ctx.effect(() => () => { for (const dispose of active.values()) dispose(); active.clear(); });
}
