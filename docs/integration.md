# Plugin integration

The bundle targets DeepSeek Harness `0.1.7-alpha.1` and Cordis `4.0.3`. It adds the independent `just-enough-tools` preset and a plugin settings page. Other modes retain their own tools and configuration.

## Capability lifecycle

Tools and skills share one candidate pool and threshold. IDs are namespaced as `tool:<name>` and `skill:<name>`. The scorer receives the task, the completed round’s final Agent text (`agent_response`), candidate descriptions and already selected skill instructions; hidden model reasoning is excluded.

The first Agent response has no tools or skills. In every response, scoring requires `REQUEST_CAPABILITIES` or a supported spelling variant anywhere in the final reply. Matching ignores case, normalizes full-width characters and accepts spaces, underscores, hyphens or no separator, plus singular `CAPABILITY`. Bare markers, inline mentions, quotes and code blocks all match; requests accompanying tool calls are scored after that step, before the next model request.

Without the marker or a qualifying direct tool call, execution ends without scoring or continuation. A request admits only capabilities above the threshold and resumes the Agent; if none qualify, it must answer within current limits without repeating the same request.

Tool admission restores its executor, schema and scoped guidance. Skill admission loads its instructions through the dsh registry with provider and invocation-policy checks. Skills do not implicitly admit their required tools. Instructions retain user-role semantics and resource paths.

Each agent owns its enabled set. Skill discovery refreshes between steps; incomplete discovery retains known candidates. Enabled capabilities persist across turns and are restored on replay. New tasks can request additional capabilities through the same marker.

## Failure handling

Mixed batches load all selected skills before registration. Failed admission rolls back the batch; timeouts and cancellation prevent late results from becoming available. Scoring or registration failures stop execution with an explicit error. Existing execution guards remain active.

The plugin owns the managed agent's tool registrations and capability guidance. Do not add independent schemas or loader tools that bypass selection. Selection controls instruction injection and tool availability, not filesystem permissions.

## Configuration and observability

Configure the protocol, URL, model, credentials, threshold, step limit and timeout on the plugin page. Provider settings apply to the next score; routing-limit changes require a new conversation. See the [README](../README.md#providers-and-settings) for protocols and credential precedence.

Native System One and Vercel Evaluation return decision probabilities. Explicit OpenAI-compatible chat scoring returns validated model estimates. No protocol falls back automatically to another.

`just-enough-tools/decision` records scores, selected capabilities, usage and failures. Optional terminal diagnostics expose these results without task text, skill bodies or credentials.

## Independent tool calls and capability requests

The agent-scoped `llm/stream` interceptor handles that agent's loop requests. Native calls, complete DSML calls and `REQUEST_CAPABILITIES` can coexist. Calls to enabled tools execute normally; calls to hidden catalog tools validate and register the missing tools before entering the Harness loop. The request marker independently triggers Jev, even alongside tool calls. After the current calls finish, a live prompt assembly scores the remaining candidates once and exposes new admissions to the next model request. Preview assemblies do not score; completed step IDs prevent duplicate decisions. Requests on the last allowed step do not start scoring. No scorer probabilities are invented. Unknown names, invalid parameters and malformed DSML fail before admission; regular Harness approval and execution guards remain in force. A converted response preserves usage and excludes reasoning from parsing. Incomplete, failed or cancelled responses never admit tools.

`just-enough-tools/direct-call` records the source, added tools and enabled capability set for diagnostics and replay. Replay restores availability without re-executing calls. This path admits tools only; skills remain selected by Jev. Already enabled tools are never registered again.
