# Contributing to Just enough tools

Contributions to tool and skill selection, provider support, documentation and examples are welcome.

Use Node.js 22.19+, install with `npm ci`, then run:

```sh
npm test
npm run typecheck
npm run build
```

Routing code lives in `src/`; the settings page lives in `client/`. Keep model-facing prompts in English and synchronize the English and Chinese READMEs.

Add focused behavior tests for changes to selection, response parsing or lifecycle handling. Preserve agent isolation, atomic admission, cancellation and existing execution guards.

Issues should include the expected behavior, package and Harness versions, and a minimal reproduction. Do not include API keys, `.env` files or private task content.

Contributions use the [MIT license](LICENSE). English and Chinese issues and pull requests are welcome.
