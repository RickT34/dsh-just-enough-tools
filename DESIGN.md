# Design

Just enough tools treats tools and skills as peers in one capability catalog. IDs are namespaced (`tool:name`, `skill:name`) so equal names do not collide. Jev scores every remaining candidate independently with the same necessity criterion (System One Noul or Vercel boolean probability) and threshold.

The Agent's first step sees neither tool schemas nor skill instructions. An admitted tool is registered with its schema and guidance. An admitted skill is loaded and delivered as user-role instruction context, preserving dsh resource-base hints and literal content. Neither kind automatically admits the other. Newly revealed skill instructions can inform the next selection of dependencies.

Each agent owns a monotonic enabled set. Metadata discovery refreshes skills between model steps; incomplete observations retain last-known candidates. Admission stages all skill loads before registering anything, rolls back mixed batches on failure, and discards late/cancelled results. Existing execution guards remain in force.

Decision events record capability IDs and kinds. Replay migrates legacy tool-only IDs and restores selected skills before continuing. Full native skill catalogs and native invocation injections are suppressed in Just enough tools mode; skill selection is not a filesystem sandbox.

See [the README](README.md) for the flow and [integration details](docs/integration.md) for lifecycle requirements. Jev handles selection; dsh provides the acting model and tool runtime.
