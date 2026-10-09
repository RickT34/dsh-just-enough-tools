/** Recover DeepSeek DSML as native calls before the Harness execution loop. */
import { randomUUID } from 'node:crypto';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, StreamChunk, ToolCallBlock } from '@deepseek-ai/dsh-llm';

function quoted(text: string, offset: number): boolean {
  let fence: string | undefined;
  const lines = text.slice(0, offset).split('\n');
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    }
  }
  const prefix = lines.at(-1) ?? '';
  let inline: string | undefined;
  for (const match of prefix.matchAll(/(?<!\\)(`+)/g)) {
    if (!inline) inline = match[1];
    else if (match[1] === inline) inline = undefined;
  }
  return !!fence || !!inline || /^\s*>/.test(prefix);
}

/** DSML string parameters are raw text, not XML-escaped or JSON-quoted. */
export function parseDsml(text: string): ContentBlock[] | undefined {
  const opening = [...text.matchAll(/<[｜|]DSML[｜|]function_calls>/g)].find(match => !quoted(text, match.index!));
  if (!opening) return undefined;
  const start = opening.index!;
  const contentStart = start + opening[0].length;
  const closing = /<\/[｜|]DSML[｜|]function_calls>/.exec(text.slice(contentStart));
  if (!closing) throw new Error('Just enough tools: incomplete DSML tool call.');
  const end = contentStart + closing.index;
  const tail = text.slice(end + closing[0].length);
  if (/<[｜|]DSML[｜|]function_calls>/.test(tail)) throw new Error('Just enough tools: multiple DSML call envelopes.');
  let body = text.slice(contentStart, end).trim();
  const calls: ToolCallBlock[] = [];
  while (body) {
    const invocation = /^<[｜|]DSML[｜|]invoke\s+name="([^"<>]+)">([\s\S]*?)<\/[｜|]DSML[｜|]invoke>/.exec(body);
    if (!invocation) throw new Error('Just enough tools: malformed DSML invocation.');
    let parameters = invocation[2]!.trim();
    const args: Record<string, unknown> = Object.create(null);
    while (parameters) {
      const parameter = /^<[｜|]DSML[｜|]parameter\s+name="([^"<>]+)"\s+string="(true|false)">([\s\S]*?)<\/[｜|]DSML[｜|]parameter>/.exec(parameters);
      if (!parameter || Object.hasOwn(args, parameter[1]!)) throw new Error('Just enough tools: malformed or duplicate DSML parameter.');
      try { args[parameter[1]!] = parameter[2] === 'true' ? parameter[3]! : JSON.parse(parameter[3]!); }
      catch { throw new Error('Just enough tools: invalid JSON in DSML parameter.'); }
      parameters = parameters.slice(parameter[0].length).trim();
    }
    calls.push({ type: 'tool-call', id: ToolCallId(`jet-${randomUUID()}`), name: invocation[1]!, arguments: JSON.stringify(args) });
    body = body.slice(invocation[0].length).trim();
  }
  if (!calls.length) throw new Error('Just enough tools: empty DSML call envelope.');
  return [
    ...(text.slice(0, start).trim() ? [{ type: 'text' as const, text: text.slice(0, start) }] : []),
    ...calls,
    ...(tail.trim() ? [{ type: 'text' as const, text: tail }] : []),
  ];
}

/** Wait for a successful complete response before opening or executing any tool. */
export async function* recoverDirectCalls(
  stream: AsyncIterable<StreamChunk>,
  admit: (calls: ToolCallBlock[], source: 'native' | 'dsml') => void,
  signal: AbortSignal,
): AsyncIterable<StreamChunk> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) { signal.throwIfAborted(); chunks.push(chunk); }
  signal.throwIfAborted();
  const finish = chunks.at(-1);
  if (finish?.type !== 'finish' || !['stop', 'tool-calls'].includes(finish.reason.kind)) {
    yield* chunks; return;
  }
  const blocks = chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : []);
  const native = blocks.filter((block): block is ToolCallBlock => block.type === 'tool-call');
  if (native.length) {
    admit(native, 'native');
    yield* chunks; return;
  }
  const parsed = parseDsml(blocks.filter(block => block.type === 'text').map(block => block.text).join('\n'));
  if (!parsed) { yield* chunks; return; }
  admit(parsed.filter((block): block is ToolCallBlock => block.type === 'tool-call'), 'dsml');
  // Keep reasoning separate; converted blocks invalidate provider replay metadata.
  const converted = [...blocks.filter(block => block.type !== 'text'), ...parsed];
  for (const [index, block] of converted.entries()) {
    yield { type: 'block-start', index, blockType: block.type };
    if (block.type === 'text') yield { type: 'text-delta', index, text: block.text };
    else if (block.type === 'reasoning') yield { type: 'reasoning-delta', index, text: block.text };
    else if (block.type === 'tool-call') yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
    yield { type: 'block-end', index, block };
  }
  for (const chunk of chunks) if (chunk.type === 'usage') yield chunk;
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
