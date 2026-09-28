# Plugin integration

The bundle targets DeepSeek Harness `0.1.7-alpha.1` and Cordis `4.0.3`. It adds the independent `just-enough-tools` preset and a plugin settings page. Other modes retain their own tools and configuration.

## Capability lifecycle

Tools and skills share one candidate pool and threshold. IDs are namespaced as `tool:<name>` and `skill:<name>`. The scorer receives the task, the completed round’s final Agent text (`agent_response`), candidate descriptions and already selected skill instructions; hidden model reasoning is excluded.

The first Agent response has no tools or skills. In every round, scoring requires `REQUEST_CAPABILITIES` or a supported spelling variant anywhere in the final reply. Matching ignores case, normalizes full-width characters and accepts spaces, underscores, hyphens or no separator, plus singular `CAPABILITY`. Bare markers, inline mentions, quotes and code blocks all match; replies containing tool calls still wait until the round ends.

Without the marker, execution ends without scoring or continuation. A request admits only capabilities above the threshold and resumes the Agent; if none qualify, it must answer within current limits without repeating the same request.

Tool admission restores its executor, schema and scoped guidance. Skill admission loads its instructions through the dsh registry with provider and invocation-policy checks. Skills do not implicitly admit their required tools. Instructions retain user-role semantics and resource paths.

Each agent owns its enabled set. Skill discovery refreshes between steps; incomplete discovery retains known candidates. Enabled capabilities persist across turns and are restored on replay. New tasks can request additional capabilities through the same marker.

## Failure handling

Mixed batches load all selected skills before registration. Failed admission rolls back the batch; timeouts and cancellation prevent late results from becoming available. Scoring or registration failures stop execution with an explicit error. Existing execution guards remain active.

The plugin owns the managed agent's tool registrations and capability guidance. Do not add independent schemas or loader tools that bypass selection. Selection controls instruction injection and tool availability, not filesystem permissions.

## Configuration and observability

Configure the protocol, URL, model, credentials, threshold, step limit and timeout on the plugin page. Provider settings apply to the next score; routing-limit changes require a new conversation. See the [README](../README.md#providers-and-settings) for protocols and credential precedence.

Native System One and Vercel Evaluation return decision probabilities. Explicit OpenAI-compatible chat scoring returns validated model estimates. No protocol falls back automatically to another.

`just-enough-tools/decision` records scores, selected capabilities, usage and failures. Optional terminal diagnostics expose these results without task text, skill bodies or credentials.
