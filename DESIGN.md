# Design

Tools and skills are peers in a shared capability catalog. Namespaced IDs prevent collisions, and a single threshold governs admission. Each agent maintains its own enabled set.

The Agent starts without tools or skills. A capability-request keyword anywhere in the final reply triggers scoring and continuation, regardless of brackets, Markdown formatting or accompanying description. Replies without this request finish immediately with no scorer call, including the first response. After a denied request, the Agent answers within current limits rather than repeating the same request; the step limit bounds continuations.

Selected tools expose their schemas, executors and guidance. Selected skills contribute instructions, with their dependencies scored separately. Admission is atomic across a batch, and cancellation prevents late changes. Session events support inspection and replay.

System One and Vercel use native decision probabilities. OpenAI-compatible chat scoring is an explicit alternative using generated estimates. Invalid or incomplete scores never partially open a batch.

See the [README](README.md) for usage and [integration details](docs/integration.md) for lifecycle contracts.

Scoring requests share one compact rule and task state. Candidate descriptions appear once per question; execution schemas and provider metadata are omitted. Enabled capabilities retain IDs and descriptions. Scoring runs only for explicit requests at a completed Agent round. `agent_response` is its final text string, excluding tool-call blocks, earlier messages, reasoning and tool results. Task text and active skill instructions remain separate inputs.
