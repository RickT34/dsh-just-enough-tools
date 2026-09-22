/** Skill discovery for Just enough tools's unified capability catalog; no model-facing loader. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { isModelInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill';
import type { SkillCandidate, SkillCatalogSnapshot } from './index.js';

/** Discover metadata only. The full body is read only when its candidate is admitted. */
export async function discoverSkills(ctx: Context, agent: Agent, signal: AbortSignal): Promise<SkillCatalogSnapshot> {
  const lookup = { cwd: agent.session.header.cwd, scope: agent, signal };
  const snapshot = await ctx.skills.snapshot(lookup);
  const skills: SkillCandidate[] = snapshot.skills.filter(isModelInvocable).map(summary => ({
    kind: 'skill', name: summary.name, description: summary.description,
    guidance: summary.whenToUse ?? '', provider: summary.provider,
    async load(loadSignal) {
      const skill = await ctx.skills.get(summary.name, { ...lookup, signal: loadSignal });
      if (!skill || !isModelInvocable(skill) || skill.provider !== summary.provider) {
        throw new Error('Selected skill is no longer available for model invocation.');
      }
      return renderSkillContent(skill);
    },
  }));
  return { skills, complete: snapshot.complete };
}
