import { Context } from '@deepseek-ai/cordis';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadWorkspace } from '../src/load.js';
import { createDeclarationEditor } from '../src/edit.js';

const ctx = new Context();
await ctx.plugin(LocalFileSystem, { cwd: process.cwd() });
const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'probe-')));
await fs.writeFile(path.join(dir, '.mcp.json'), '{ "mcpServers": { "demo": { "command": "node" } } }');
await fs.mkdir(path.join(dir, '.gemini'), { recursive: true });
await fs.writeFile(path.join(dir, '.gemini', 'settings.json'), '{ "mcpServers": {} }');
const plan = await loadWorkspace(ctx.fs, dir, {});
console.log('sources:', JSON.stringify(plan.servers.map(s => s.source)));
const editor = createDeclarationEditor({ fs: ctx.fs, config: {} });
try {
  const r = await editor.write(plan, { preset: 'gemini', name: 'demo', fromServerId: 'demo' }, new AbortController().signal);
  console.log('WRITE OK', JSON.stringify(r));
} catch (error) {
  console.log('WRITE FAIL', error.code, error.message);
}
console.log('gemini file now:', JSON.stringify(await fs.readFile(path.join(dir, '.gemini', 'settings.json'), 'utf8')));
const after = await loadWorkspace(ctx.fs, dir, {});
console.log('after sources:', JSON.stringify(after.servers.map(s => s.source)));
await fs.rm(dir, { recursive: true, force: true });
