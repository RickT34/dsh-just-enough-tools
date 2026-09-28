/** Match capability-request keywords anywhere in the final Agent text. */
export function requestsCapabilities(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '');
  return /request[\s_-]*capabilit(?:ies|y)/i.test(normalized);
}
