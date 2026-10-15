import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadWorkspace } from '../src/load.js';
import { harness, workspace, writeFixture } from './helpers.js';

test('loads workspace-local presets without merging global or parent configurations', async t => {
  const ctx = await harness(t), dir = await workspace(t);
  await writeFixture(dir, '.mcp.json', { mcpServers: { root: { command: 'root-program' } } });
  await writeFixture(dir, '.vscode/mcp.json', '// comment\n{"servers":{"vscode":{"command":"code-program"}}}');
  await writeFixture(dir, '.codex/config.toml', '[mcp_servers.codex]\ncommand="codex-program"\n');
  await writeFixture(dir, '.cursor/mcp.json', { mcpServers: { cursor: { command: 'cursor-program' } } });
  await writeFixture(dir, '.gemini/settings.json', { mcpServers: { gemini: { command: 'gemini-program' }, excluded: { command: 'no' } }, mcp: { excluded: ['excluded'] } });
  const result = await loadWorkspace(ctx.fs, dir);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.servers.map(s => s.spec.config.serverName), ['root', 'vscode', 'codex', 'cursor', 'gemini']);
  await fs.mkdir(path.join(dir, 'child'));
  assert.equal((await loadWorkspace(ctx.fs, path.join(dir, 'child'))).servers.length, 0);
  assert.equal((await loadWorkspace(ctx.fs, undefined)).servers.length, 0);
});

test('custom YAML preset, JSON pointer mapping and input substitution', async t => {
  const ctx = await harness(t), dir = await workspace(t);
  await writeFixture(dir, 'custom.yaml', 'integrations:\n  mcp:\n    service:\n      executable: node\n      arguments: ["${workspaceFolder}", "${input:key}"]\n');
  const result = await loadWorkspace(ctx.fs, dir, { enabledBuiltins: [], inputValues: { key: 'explicit-input' }, presets: [{ id: 'mine', files: ['custom.yaml'], format: 'yaml', serversPaths: ['/integrations/mcp'], fields: { command: 'executable', args: 'arguments' } }] });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.servers[0].spec.config.args, [dir, 'explicit-input']);
});

test('conflicts fail closed; explicit first/last wins; identical declarations deduplicate', async t => {
  const ctx = await harness(t), dir = await workspace(t);
  await writeFixture(dir, '.mcp.json', { mcpServers: { same: { command: 'first' } } });
  await writeFixture(dir, '.vscode/mcp.json', { servers: { same: { command: 'second' } } });
  const error = await loadWorkspace(ctx.fs, dir);
  assert.equal(error.servers.length, 0);
  assert.equal(error.diagnostics[0].code, 'DUPLICATE_SERVER');
  assert.equal((await loadWorkspace(ctx.fs, dir, { conflictPolicy: 'first-wins' })).servers[0].spec.config.command, 'first');
  assert.equal((await loadWorkspace(ctx.fs, dir, { conflictPolicy: 'last-wins' })).servers[0].spec.config.command, 'second');
  await writeFixture(dir, '.vscode/mcp.json', { servers: { same: { command: 'first' } } });
  assert.equal((await loadWorkspace(ctx.fs, dir)).diagnostics.length, 0);
});

test('envFile bounded to workspace, explicit env wins, missing inputs never execute commands', async t => {
  const ctx = await harness(t), dir = await workspace(t);
  await writeFixture(dir, '.env', 'VALUE=file\nSECRET="file-secret"\n');
  await writeFixture(dir, '.vscode/mcp.json', { servers: { ok: { command: 'node', envFile: '.env', env: { VALUE: 'explicit' } }, missing: { command: '${input:command}' } }, inputs: [{ id: 'command', type: 'command', command: 'malicious' }] });
  const result = await loadWorkspace(ctx.fs, dir);
  assert.deepEqual(result.servers[0].spec.config.env, { VALUE: 'explicit', SECRET: 'file-secret' });
  assert.equal(result.diagnostics[0].code, 'MISSING_INPUT_VALUE');
  await writeFixture(dir, '.vscode/mcp.json', { servers: { bad: { command: 'node', envFile: '../outside.env' } } });
  assert.equal((await loadWorkspace(ctx.fs, dir)).diagnostics[0].code, 'FILE_OUTSIDE_WORKSPACE');
});

test('invalid files/unsafe paths/limits give content-free diagnostics, and fingerprint detects edits', async t => {
  const ctx = await harness(t), dir = await workspace(t);
  await writeFixture(dir, '.mcp.json', '{"mcpServers":{"secret":"TOKEN-DO-NOT-LOG"');
  const broken = await loadWorkspace(ctx.fs, dir);
  assert.equal(broken.servers.length, 0);
  assert.ok(!JSON.stringify(broken.diagnostics).includes('TOKEN-DO-NOT-LOG'));
  await writeFixture(dir, '.mcp.json', { mcpServers: { a: { command: 'node' }, b: { command: 'node' } } });
  const small = await loadWorkspace(ctx.fs, dir, { maxServers: 1 });
  assert.equal(small.servers.length, 1);
  assert.equal(small.diagnostics[0].code, 'SERVER_LIMIT_EXCEEDED');
  assert.notEqual(small.fingerprint, broken.fingerprint);
  const unsafe = await loadWorkspace(ctx.fs, dir, { enabledBuiltins: [], presets: [{ id: 'outside', files: ['../outside.json'], serversPaths: ['mcpServers'] }] });
  assert.equal(unsafe.diagnostics[0].code, 'FILE_OUTSIDE_WORKSPACE');
  await writeFixture(dir, '.mcp.json', ' '.repeat(2048));
  assert.equal((await loadWorkspace(ctx.fs, dir, { maxFileBytes: 1024 })).servers.length, 0);
});

test('canonical junction/symlink escape is rejected before reading contents', async t => {
  const ctx = await harness(t), dir = await workspace(t), outside = await workspace(t);
  await writeFixture(outside, 'mcp.json', { servers: { escape: { command: 'x' } } });
  await fs.symlink(outside, path.join(dir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await loadWorkspace(ctx.fs, dir, { enabledBuiltins: [], presets: [{ id: 'escape', files: ['escape/mcp.json'], serversPaths: ['servers'] }] });
  assert.equal(result.servers.length, 0);
  assert.equal(result.diagnostics[0].code, 'FILE_OUTSIDE_WORKSPACE');
});
