import readline from 'node:readline';
const label = process.argv[2] ?? 'fixture';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const result = (() => {
    switch (msg.method) {
      case 'initialize': return { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'fixture', version: '1' }, instructions: `Workspace ${label}: keep \${literal} literal.` };
      case 'ping': return {};
      case 'tools/list': return { tools: [{ name: 'identity', description: 'Returns workspace identity', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, { name: 'blocked', description: 'Filtered tool', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
      case 'tools/call': return { content: [{ type: 'text', text: JSON.stringify({ label, cwd: process.cwd(), marker: process.env.WORKSPACE_MARKER, method: msg.params.name }) }] };
      case 'resources/list': return { resources: [{ uri: 'fixture://identity', name: label }] };
      case 'resources/templates/list': return { resourceTemplates: [] };
      case 'resources/read': return { contents: [{ uri: msg.params.uri, text: label }] };
      default: return undefined;
    }
  })();
  if (result !== undefined) send({ id: msg.id, result });
  else send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
});
