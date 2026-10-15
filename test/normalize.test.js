import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BUILTIN_PRESETS, resolvePresets, select } from '../src/presets.js';
import { interpolate, normalizeServer, normalizeServerName, publicToolName } from '../src/normalize.js';
import { parseDeclaration } from '../src/load.js';
const context = { cwd: path.resolve('work-A'), configDir: path.resolve('work-A/.vscode'), env: { TOKEN: 'secret', VALUE: 'hello', LITERAL: '$VALUE-${VALUE}' }, inputs: { key: 'input-secret' } };
const preset = id => BUILTIN_PRESETS.find(p => p.id === id);

test('all builtins and data-only custom mapping/overrides', () => {
  assert.equal(resolvePresets().length, 5);
  const entries = resolvePresets({ enabledBuiltins: ['vscode'], presets: [{ id: 'custom', extends: 'vscode', files: ['config.yaml'], format: 'yaml', serversPaths: ['/custom/map'], fields: { command: 'program' } }] });
  assert.equal(entries[1].fields.command, 'program');
  assert.equal(entries[1].format, 'yaml');
  assert.deepEqual(resolvePresets({ presets: [{ id: 'vscode', enabled: false }] }).map(p => p.id), ['root', 'codex', 'cursor', 'gemini']);
  assert.throws(() => resolvePresets({ presets: [{ id: 'bad', files: ['foo'], serversPaths: ['mcp'], fields: { execute: 'code' } }] }));
  assert.throws(() => resolvePresets({ enabledBuiltins: ['unknown'] }));
  assert.equal(select({ 'a.b': { 'a/b': 1 } }, '/a.b/a~1b'), 1);
  assert.equal(select({}, 'toString'), undefined);
});

test('supported JSON/JSONC/TOML/YAML and rejection of duplicate/malformed keys', () => {
  assert.deepEqual(parseDeclaration('// hi\n{"servers": {},}', 'jsonc'), { servers: {} });
  assert.throws(() => parseDeclaration('{"x":1,"x":2}', 'jsonc'));
  assert.throws(() => parseDeclaration('//hi\n{}', 'json'));
  assert.throws(() => parseDeclaration('{ broken SECRET-TEXT', 'jsonc'), err => !err.message.includes('SECRET-TEXT'));
  assert.equal(parseDeclaration('[mcp_servers.a]\ncommand="x"', 'toml').mcp_servers.a.command, 'x');
  assert.equal(parseDeclaration('mcpServers:\n  a:\n    command: x', 'yaml').mcpServers.a.command, 'x');
  assert.throws(() => parseDeclaration('a: 1\na: 2', 'yaml'));
});

test('single-pass interpolation, explicit inputs, defaults and missing-variable rejection', () => {
  assert.equal(interpolate('${env:TOKEN}-${VALUE}-${MISSING:-fallback}-${input:key}', context), 'secret-hello-fallback-input-secret');
  assert.equal(interpolate('${LITERAL}', context), '$VALUE-${VALUE}');
  assert.equal(interpolate('$VALUE/%VALUE%', context, 'shell'), 'hello/hello');
  assert.equal(interpolate('${env:TOKEN}', context, 'none'), '${env:TOKEN}');
  assert.throws(() => interpolate('${MISSING}', context));
  assert.throws(() => interpolate('${input:missing}', context));
  assert.throws(() => interpolate('${command:malicious}', context));
});

test('stdio workspace cwd, relative executable, env/args and timeout mapping', () => {
  const result = normalizeServer('same', { command: './serve.exe', args: ['${workspaceFolder}', '${VALUE}'], env: { TOKEN: '${env:TOKEN}', COUNT: 2 }, cwd: 'sub' }, preset('vscode'), context);
  assert.equal(result.config.cwd, path.join(context.cwd, 'sub'));
  assert.equal(result.config.command, path.join(context.cwd, 'sub', 'serve.exe'));
  assert.deepEqual(result.config.env, { TOKEN: 'secret', COUNT: '2' });
  assert.equal(normalizeServer('off', { command: 'x', enabled: false }, preset('codex'), context), undefined);
  assert.throws(() => normalizeServer('bad', { command: 'x', args: 'not-array' }, preset('root'), context));
  assert.throws(() => normalizeServer('bad', { command: 'x', env: { A: null } }, preset('vscode'), context));
});

test('Codex env forwarding and HTTP credential references use actual environment values', () => {
  const stdio = normalizeServer('same', { command: 'x', env_vars: ['TOKEN'], env: { LITERAL: '${TOKEN}' }, tool_timeout_sec: 5, startup_timeout_sec: 2, enabled_tools: ['identity'], disabled_tools: ['blocked'] }, preset('codex'), context);
  assert.equal(stdio.config.env.TOKEN, 'secret');
  assert.equal(stdio.config.env.LITERAL, '${TOKEN}');
  assert.equal(stdio.config.toolCallTimeoutMs, 5000);
  assert.equal(stdio.startupTimeoutMs, 2000);
  const http = normalizeServer('web', { url: 'https://example.test/mcp', http_headers: { Accept: 'application/json' }, env_http_headers: { 'X-Token': 'TOKEN' }, bearer_token_env_var: 'TOKEN' }, preset('codex'), context);
  assert.equal(http.config.headers['X-Token'], 'secret');
  assert.equal(http.config.headers.Authorization, 'Bearer secret');
  assert.throws(() => normalizeServer('bad', { command: 'x', env_vars: [{ name: 'TOKEN', source: 'remote' }] }, preset('codex'), context));
});

test('Gemini URL semantics, security and authentication do not silently degrade', () => {
  assert.throws(() => normalizeServer('legacy', { url: 'https://example.test/sse' }, preset('gemini'), context), /UNSUPPORTED_SSE/);
  assert.equal(normalizeServer('http', { httpUrl: 'https://example.test/mcp' }, preset('gemini'), context).config.transport, 'streamable-http');
  for (const raw of [{ command: 'x', sandboxEnabled: true }, { command: 'x', oauth: {} }, { url: 'https://example.test', headersHelper: 'danger' }, { type: 'ws', url: 'wss://example.test' }]) assert.throws(() => normalizeServer('bad', raw, preset('root'), context));
  assert.throws(() => normalizeServer('bad', { type: 'http', url: 'file:///secret' }, preset('root'), context));
  assert.throws(() => normalizeServer('bad', { type: 'http', url: 'https://example.test', headers: { X: 'x\nsecret' } }, preset('root'), context));
});

test('server namespaces and native public tool names stay stable and collision resistant', () => {
  const names = ['normal', 'bad.name', 'bad/name', '名字', 'a'.repeat(100)].map(normalizeServerName);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^[A-Za-z0-9_-]{1,32}$/);
  assert.equal(publicToolName('normal', 'identity'), 'mcp__normal__identity');
  assert.equal(publicToolName('a'.repeat(32), 'b'.repeat(100)).length, 64);
  assert.notEqual(publicToolName('normal', 'a.b'), publicToolName('normal', 'a/b'));
});
