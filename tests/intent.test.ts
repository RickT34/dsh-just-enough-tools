import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestsCapabilities } from '../src/intent.js';

test('recognizes explicit requests with common model formatting variations', () => {
  const requests = [
    '[REQUEST_CAPABILITIES]\nRead the file.',
    'I have a plan.\n\n[request_capabilities]: Read the file.',
    '**[REQUEST_CAPABILITIES]**\nRead the file.',
    '`[REQUEST_CAPABILITIES]`: Read the file.',
    '### [REQUEST-CAPABILITIES]\nRead the file.',
    '- [REQUEST CAPABILITIES] Read the file.',
    '1. [REQUEST_CAPABILITY]: Read the file.',
    '【REQUEST_CAPABILITIES】\nRead the file.',
    '［ＲＥＱＵＥＳＴ＿ＣＡＰＡＢＩＬＩＴＩＥＳ］：读取文件。',
    'REQUEST_CAPABILITIES: Read the file.',
    '  [REQUEST_CAPABILITIES]\r\nRead the file.',
    '[REQUEST_\u200bCAPABILITIES]\nRead the file.',
    '```text\nExample only\n```\n[REQUEST_CAPABILITIES]\nRead the file.',
  ];
  for (const text of requests) assert.equal(requestsCapabilities(text), true, text);
});

test('does not route ordinary prose, quoted examples, empty or unrelated markers', () => {
  const answers = [
    '4.', 'I may need a tool.', 'The marker is [REQUEST_CAPABILITIES].',
    '[REQUEST_CAPABILITIES]', '[REQUEST_CAPABILITIES]\n  ',
    '[REQUEST_CAPABILITIES_EXTRA]\nRead the file.',
    '> [REQUEST_CAPABILITIES]\n> Read the file.',
    '```text\n[REQUEST_CAPABILITIES]\nRead the file.\n```',
    '~~~~\n[REQUEST_CAPABILITIES]\nRead the file.\n~~~\nStill quoted.',
    '<!-- [REQUEST_CAPABILITIES]\nRead the file. -->',
    '```\n[REQUEST_CAPABILITIES]\nRead the file.',
  ];
  for (const text of answers) assert.equal(requestsCapabilities(text), false, text);
});
