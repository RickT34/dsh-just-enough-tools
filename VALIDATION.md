# Validation

Validated against DeepSeek Harness `0.1.7-alpha.1` / Cordis `4.0.3`.

- 58 automated tests pass with real Harness components and local HTTP fixtures. The mode tests verify that only Just enough tools agents start without capabilities, the configured Jev endpoint drives registration, ordinary agents remain usable without a Jev key, and blank conversations can switch into and out of the mode.
- Skill tests cover same-name tool/skill separation, one shared threshold, skill-only admission, user-role instruction injection, mixed-batch rollback, cancellation/timeout, replay, dynamic discovery, invocation policy, and filesystem resource hints.
- Host and browser TypeScript checks pass. The browser bundle uses dsh's module-loader contract and the host React runtime.
- Before the package rename, installed v0.4.0 with the real `dsh plugin --profile web add` command in an isolated profile and verified successful Web startup with the skill filesystem provider in the composed preset. Mode selection and settings interactions below were checked in the actual Web interface on v0.3.0; v0.4.0 changes the threshold label to include skills.
- Before the package rename, verified API key, API URL, model and threshold edits through the plugin settings page. Saving, refreshing, retaining the key during unrelated edits and resetting the saved key were checked. The page displays only the saved-key state and does not fill the key back into the input.
- UI testing used a dummy key in a temporary profile. No paid model requests were made. A live Jev service request remains unverified because no real TypeSafe key was available.

Run `npm test`, `npm run typecheck`, and `npm run build` without API keys.

After renaming the package to `dsh-just-enough-tools`, all 43 tests, host/browser type checks and the package build pass. Package contents were scanned for the retired name; actual Web installation under the new package identity has not been repeated. Existing installations need a fresh plugin configuration and conversation under the new identity.

Version 0.4.1 adds provider protocol configuration. Tests cover the Vercel evaluation request/response contract, gateway headers, custom endpoints/model IDs, invalid probabilities, provider-specific credential fallbacks, and routing through both protocols using real Harness components with local HTTP fixtures. Host/browser type checks and the package build pass. The new provider selector has not been browser-tested; live authenticated Vercel evaluation remains unverified. No paid API requests were made.

Startup report follow-up: the failing CLI was 0.1.5-rc.2 and did not ship `@deepseek-ai/dsh-agent-preset`. A fresh isolated Web profile installed the v0.4.1 tarball and started successfully with dsh 0.1.7-alpha.1 on Node 26.4.0. The only activation warning was HMR file watching (`EMFILE`); no plugin/preset loading error occurred. The temporary server was stopped. Installation and startup instructions now pin the required CLI version.

Version 0.4.2 gates static native `tool:<name>` guidance by candidate admission, fixing the first-step error caused by the shipped bash guidance. Regression coverage checks actual agent requests before/after admission, never-selected guidance, unchanged outer-scope prompts, and rejection of unknown guidance. Both provider mode tests now use static inherited guidance.

Version 0.4.3 adds terminal routing diagnostics and stops the dsh mode on scoring/registration errors after persisting the decision. Tests distinguish low scores from provider failure, expose safe error codes, preserve rollback, and verify exact per-candidate scores and threshold outcomes. Live Vercel scoring and the browser diagnostics toggle remain unverified; no paid calls were made.

Version 0.5.0 adds explicit OpenAI-compatible chat scoring, including unauthenticated local servers, required model IDs, strict complete-score validation, usage normalization, and real Harness routing via local HTTP fixtures. A live request to LM Studio with weidows/laya-multilingual failed with a logits-computation error, consistent with the model card identifying an encoder-only GGUF and a separate decision head. This does not establish working native Laya inference or scoring quality. No other local model was loaded for testing.
