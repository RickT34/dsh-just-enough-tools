# Validation

Validated against DeepSeek Harness `0.1.7-alpha.1` / Cordis `4.0.3`.

- 43 automated tests pass with real Harness components and local HTTP fixtures. The mode tests verify that only Just enough tools agents start without capabilities, the configured Jev endpoint drives registration, ordinary agents remain usable without a Jev key, and blank conversations can switch into and out of the mode.
- Skill tests cover same-name tool/skill separation, one shared threshold, skill-only admission, user-role instruction injection, mixed-batch rollback, cancellation/timeout, replay, dynamic discovery, invocation policy, and filesystem resource hints.
- Host and browser TypeScript checks pass. The browser bundle uses dsh's module-loader contract and the host React runtime.
- Before the package rename, installed v0.4.0 with the real `dsh plugin --profile web add` command in an isolated profile and verified successful Web startup with the skill filesystem provider in the composed preset. Mode selection and settings interactions below were checked in the actual Web interface on v0.3.0; v0.4.0 changes the threshold label to include skills.
- Before the package rename, verified API key, API URL, model and threshold edits through the plugin settings page. Saving, refreshing, retaining the key during unrelated edits and resetting the saved key were checked. The page displays only the saved-key state and does not fill the key back into the input.
- UI testing used a dummy key in a temporary profile. No paid model requests were made. A live Jev service request remains unverified because no real TypeSafe key was available.

Run `npm test`, `npm run typecheck`, and `npm run build` without API keys.

After renaming the package to `dsh-just-enough-tools`, all 43 tests, host/browser type checks and the package build pass. Package contents were scanned for the retired name; actual Web installation under the new package identity has not been repeated. Existing installations need a fresh plugin configuration and conversation under the new identity.
