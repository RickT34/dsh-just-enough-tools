# Plugin integration

Just enough tools targets DeepSeek Harness `0.1.7-alpha.1` with Cordis `4.0.3`. Install the bundle into the Web profile with `dsh plugin --profile web add`, then open Plugins → dsh-just-enough-tools to configure Jev. The bundle adds an independent `just-enough-tools` preset and settings page without changing other modes.

## Unified capabilities

Tools and skills share one threshold and one scoring request. IDs use `tool:<name>` and `skill:<name>`, while native tool names remain unchanged on execution. Jev receives the complete capability summaries, current public progress, and the instructions of already admitted skills. A skill can be selected on its own or in the same batch as tools.

The preset includes native file, search and platform-appropriate terminal tools, plus the dsh filesystem skill provider. Skills are resolved through `ctx.skills` for the agent's scope and workspace. Project `.dsh/skills` and `.agents/skills`, configured custom roots, and dsh/user agent skill directories follow dsh's normal priority rules. Only `modelInvocable` skills enter autonomous selection; user-only or disabled skills are not silently enabled.

Discovery exposes summaries to Jev, not every skill body. Selected bodies are loaded through the registry, rechecking provider ownership and invocation policy. `renderSkillContent` preserves relative-resource hints. Bodies enter ordinary user-role instruction context, not the system prompt, and are reinjected only if absent or different in retained history. Literal template braces are preserved.

Just enough tools does not mount the generic `skill` loader or publish the full native skill catalog. Native catalog/invocation messages cannot bypass the selection step. Existing file and terminal permissions still apply: capability selection controls skill instruction injection, not arbitrary filesystem reads by an already enabled tool.

## Admission and failure handling

The first Agent step has no tools or skills. A planning continuation starts selection. Tools above the threshold receive their original executor, output renderer and scoped guidance; skills above it receive their full instructions. Tools required by a skill still need their own score above the threshold.

All skill loads in a mixed batch finish before any registration is committed. Load, registration or prompt failures leave the earlier set unchanged. Cancellation and deadlines prevent late admissions. Discovery failures/incomplete snapshots retain last-known candidates and are marked with `catalogComplete: false` in subsequent decisions.

After the Agent reads a newly admitted skill, a further decision may expose dependencies not apparent from the summary. If no new capability is admitted, the final answer closes normally; step limits bound continuations. No full-catalog fallback is applied on scorer failure.

Do not independently register agent-local tools, extra schemas or unconditional capability guidance in a managed agent. PTC's permanent `run_code` transport is outside this mode's initially-empty-set contract. Existing execution guards and tool-level checks remain in force.

## Session lifecycle

Only agents bound to Just enough tools are routed. Blank conversations can switch into or out of the mode before their first turn; switching out unwinds its local registrations. Ordinary modes and the shared skill registry are unchanged.

Enabled capabilities persist across user turns. Selected skill content is retained for the session; new/changed unselected metadata is rediscovered between steps. Replay restores tool registrations and loads selected skills from the current providers; unavailable skills fail restoration rather than being silently skipped. Older tool-only decision records remain readable.

`just-enough-tools/decision` v2 records namespaced candidate, added and enabled IDs, their kinds, scores, usage and failures. Skill bodies have `just-enough-tools-skill` message sources. Hidden model reasoning is not sent to Jev.

## Configuration

Use the plugin page for the provider protocol, API key, base URL, model, shared tool/skill threshold, step limit and operation timeout. The timeout bounds each discovery, scoring or skill-load operation. Configuration is persisted by dsh; secret fields are redacted from settings reads. An empty saved key falls back to `JEV_API_KEY`, then `AI_GATEWAY_API_KEY` for Vercel or `TYPESAFE_API_KEY` for System One. Blank URL/model values use protocol defaults. Both protocols support compatible custom base URLs or full endpoints. The Vercel adapter uses the AI SDK v4 evaluation wire format (`boolean` / `probability`); System One uses `noul` / `noul`. An explicitly selected OpenAI-compatible protocol sends Chat Completions requests and strictly validates generated JSON scores; it is never an automatic fallback. Local servers may omit authentication.

API key, URL and model changes apply to the next scoring call. Start a new conversation for new routing limits. The default base URL is `https://api.typesafe.ai/v1`, and the model is `jev-latest`. There is no LLM scoring fallback.

Gateway protocol reference: [official evaluation adapter](https://github.com/vercel/ai/blob/main/packages/gateway/src/gateway-evaluation-model.ts).

API reference: [TypeSafe System One](https://docs.typesafe.ai/api), [Noul](https://docs.typesafe.ai/primitives/noul).

The mode enables terminal diagnostics by default (`debug` setting, live). Scoring and registration failures persist a decision then raise a redacted actionable error to the agent UI; a successful all-low-score decision continues normally. Diagnostic data never enters the model prompt.
