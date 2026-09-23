/** Compact routing diagnostics: never include task text, prompts, keys or provider bodies. */
import type { Decision } from './index.js';

export function decisionSummary(decision: Decision): string {
  const outcome = decision.status !== 'ok' ? decision.status
    : decision.candidates.length === 0 ? 'no-candidates'
    : decision.added.length === 0 ? 'none-above-threshold' : 'capabilities-added';
  return JSON.stringify({
    outcome, afterStepSeq: decision.afterStepSeq, threshold: decision.threshold,
    durationMs: decision.durationMs, catalogComplete: decision.catalogComplete,
    errorCode: decision.errorCode,
    scores: decision.candidates.map(id => ({ id, score: decision.scores[id] ?? null,
      result: decision.added.includes(id) ? 'opened'
        : decision.status !== 'ok' ? 'failed'
        : 'below-or-equal-threshold' })),
    added: decision.added, enabled: decision.enabled, model: decision.model, usage: decision.usage,
  });
}

export function routingErrorHint(code?: string): string {
  if (code?.includes('CHAT')) return 'The chat scorer must generate complete JSON scores. Encoder-only Laya GGUF in LM Studio cannot do this; use a generative model or serve Laya with its decision head through System One.';
  if (code === 'HTTP_401' || code === 'HTTP_403') return 'Check the selected provider and its API key.';
  if (code === 'HTTP_404') return 'Check the API protocol, base URL and model ID. Vercel defaults: /v4/ai and typesafe-ai/jev.';
  if (code === 'HTTP_429') return 'Provider rate or quota limit reached; check provider usage and retry later.';
  if (code === 'ROUTING_TIMEOUT') return 'The routing operation timed out; check connectivity or increase the timeout.';
  if (code === 'NETWORK_ERROR') return 'Cannot reach the provider; check network access and the API URL.';
  if (code === 'REGISTRATION_FAILED') return 'Capability loading or registration failed; no capabilities from this batch were opened.';
  return 'Check the provider protocol, model and endpoint; the response must contain one valid probability per candidate.';
}

/** Cordis logger exporters may be absent in Web mode. Use the launcher's stderr. */
export function writeRoutingDiagnostic(line: string): void {
  process.stderr.write(`${line.replace(/[\r\n]/g, ' ')}\n`);
}
