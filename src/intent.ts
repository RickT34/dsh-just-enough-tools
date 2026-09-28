/** Recognize explicit capability requests despite common formatting variations. */
export function requestsCapabilities(text: string): boolean {
  const lines: string[] = [];
  let fence: { character: string; length: number } | undefined;
  const normalized = text.normalize('NFKC').replace(/[【〔]/g, '[').replace(/[】〕]/g, ']').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/<!--[^]*?(?:-->|$)/g, '');
  for (const raw of normalized.split(/\r?\n/)) {
    const line = raw.trim();
    const delimiter = /^(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (delimiter && delimiter[1]![0] === fence.character
        && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
      continue;
    }
    if (line.startsWith('>')) continue;
    if (delimiter) {
      fence = { character: delimiter[1]![0]!, length: delimiter[1]!.length };
      continue;
    }
    lines.push(line);
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
      .replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/^(?:\*\*|__|\x60)/, '');
    const match = /^(?:\[\s*request[\s_-]*capabilit(?:ies|y)\s*\]|request[\s_-]*capabilit(?:ies|y))(?=$|[\s:：*_`-])/i.exec(line);
    if (!match) continue;
    const rest = line.slice(match[0].length).replace(/^(?:\*\*|__|\x60)/, '').replace(/^\s*[:：-]?\s*/, '');
    // An empty marker is not a request; require visible capability needs.
    if (rest || lines.slice(i + 1).some(next => next.trim())) return true;
  }
  return false;
}
