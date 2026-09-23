# Validation

Run the checks without API credentials:

```sh
npm test
npm run typecheck
npm run build
```

Tests cover capability selection, provider response parsing, direct-answer completion, scoped guidance, skill discovery, session replay, rollback, cancellation and diagnostic output.

Automated checks validate plugin behavior; they do not establish provider availability, answer accuracy or cost savings for a particular workload.
