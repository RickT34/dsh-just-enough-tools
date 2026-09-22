# Contributing to Just enough tools

Help make selective tool exposure useful in real agents. Good first contributions include tool and skill integrations, clearer examples, and focused tests for lifecycle or routing behavior.

## Develop

Use Node.js 22.19 or newer, then run `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`. The Web bundle registers an independent preset and a configuration card. Routing internals live in `src/`, and the settings page lives in `client/`. Client code builds as a dsh module-loader closure and shares the host React runtime.

The test suite uses local HTTP responses and real Harness components; no API key is required. Jev is the only bundled scoring backend. The acting model is provided by dsh.

Keep changes focused. Add a behavior test when changing capability exposure, cancellation, registration, skill loading, or response parsing. A scorer response must never partially admit a mixed batch of tools and skills. Preserve agent isolation and existing execution guards.

## Suggest an improvement

Share the use case, expected behavior, and a small reproducible example. Useful directions include reusable tools and skills, clearer configuration, threshold policies, and scoring only when a new capability may be needed.

## Report an issue

Describe the expected and observed behavior, Node/Harness versions, and the smallest reproducible example. A redacted `just-enough-tools/decision` event is useful. Never include API keys, `.env`, or private task content.

Contributions are accepted under the [MIT license](LICENSE). Chinese issues and pull requests are welcome — 中文问题、测试报告和改进建议同样欢迎。
