export const inject = ['tools', 'systemPrompt'];
export function apply(ctx) {
  ctx.tools.register({
    name: 'read', description: 'Read a test record.', parameters: { type: 'object', properties: {} },
    execute: async () => 'fixture record',
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  });
  ctx.systemPrompt.section({name:'tool:read',order:1100,text:({scope})=>ctx.tools.get('read',scope) ? 'Use read to inspect a record.' : ''});
}
