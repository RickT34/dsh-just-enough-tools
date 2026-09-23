# Design

Tools and skills are peers in a shared capability catalog. Namespaced IDs prevent collisions, and a single threshold governs admission. Each agent maintains its own enabled set.

The Agent starts without tools or skills. The scorer evaluates its public answer or plan and admits capabilities as needed. A complete first-response answer can finish immediately when discovery is complete and all scores are strictly below the threshold.

Selected tools expose their schemas, executors and guidance. Selected skills contribute instructions, with their dependencies scored separately. Admission is atomic across a batch, and cancellation prevents late changes. Session events support inspection and replay.

System One and Vercel use native decision probabilities. OpenAI-compatible chat scoring is an explicit alternative using generated estimates. Invalid or incomplete scores never partially open a batch.

See the [README](README.md) for usage and [integration details](docs/integration.md) for lifecycle contracts.
