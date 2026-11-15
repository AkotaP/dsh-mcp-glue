#!/usr/bin/env node
/**
 * dsh-mcp-glue 控制路由的零依赖 CLI。
 *
 * 依赖环境变量 DSH_WEB_URL、DSH_SESSION_ID（DSH 的工具 shell 已提供）。
 * token 通过 GET /workspace-mcp/handshake 在同源、本机回环条件下取得，只在内存中使用。
 *
 * 用法：
 *   node mcpctl.mjs status            工作区声明、连接状态、计数与最近一次声明变更时间
 *   node mcpctl.mjs list              声明文件、条目与当前字段值（含 version）
 *   node mcpctl.mjs probe <serverId>  单台真实握手测试，不注册工具、不动现有连接
 *   node mcpctl.mjs connect [serverId]    显式授权并连接（省略 serverId 为全部）
 *   node mcpctl.mjs disconnect [serverId] 手动断开（粘性，不删声明）
 *   node mcpctl.mjs follow            放弃手动选择，回到信任策略允许的集合
 *   node mcpctl.mjs config            读取插件当前生效配置
 *   node mcpctl.mjs write <preset> <name> '<json>'  新建条目（json 为字段对象）
 *   node mcpctl.mjs remove <serverId> 删除条目（自动从 list 取 version）
 *
 * 退出码：0 成功；1 请求失败；2 用法错误。
 */

const base = process.env.DSH_WEB_URL;
const sessionId = process.env.DSH_SESSION_ID;

if (!base) { console.error('缺少 DSH_WEB_URL'); process.exit(2); }
if (!sessionId) { console.error('缺少 DSH_SESSION_ID'); process.exit(2); }

const [, , command, ...rest] = process.argv;

async function token() {
  const response = await fetch(base + '/workspace-mcp/handshake', { headers: { Origin: base } });
  if (!response.ok) throw new Error('handshake ' + response.status + ': ' + (await response.text()).slice(0, 200));
  return (await response.json()).token;
}

async function call(path, body) {
  const headers = { Origin: base, 'x-workspace-mcp-token': await token() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + '/workspace-mcp/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 400) }; }
  if (!response.ok) {
    const code = parsed?.code ? ' [' + parsed.code + ']' : '';
    throw new Error(response.status + code + ': ' + (parsed?.error ?? text.slice(0, 200)));
  }
  return parsed;
}

function print(value) { console.log(JSON.stringify(value, null, 1)); }

/**
 * The view a person or an agent actually acts on: counts that separate a refused declaration from
 * a connection problem, per-row details for a hand edit, and the last time the set changed.
 */
function summarizeStatus(view) {
  return {
    workspace: view.workspace,
    trusted: view.trusted,
    trustMode: view.trustMode,
    selectionMode: view.selectionMode,
    loaded: view.loaded,
    selected: view.selected,
    counts: view.counts,
    lastDeclarationChangeAt: view.lastDeclarationChangeAt ?? null,
    servers: (view.servers ?? []).map(server => ({
      id: server.id,
      state: server.state,
      verified: server.verified,
      required: server.required,
      source: server.source,
      toolCount: (server.tools ?? []).length,
      error: server.error,
      ...(server.errorDetail === undefined ? {} : { errorDetail: server.errorDetail }),
      ...(server.warnings?.length ? { warnings: server.warnings.map(item => ({ code: item.code, detail: item.detail })) } : {}),
    })),
  };
}

const declarations = () => call('declaration', { sessionId, action: 'list' });

try {
  switch (command) {
    case 'status':
      print(summarizeStatus(await call('status?sessionId=' + encodeURIComponent(sessionId) + '&refresh=1')));
      break;
    case 'list': {
      const result = await declarations();
      print({
        writable: result.writable,
        reason: result.reason,
        targets: (result.targets ?? []).map(target => ({
          serverId: target.serverId,
          preset: target.preset,
          file: target.file,
          version: target.version,
          values: Object.fromEntries((target.fields ?? []).filter(field => field.value !== undefined).map(field => [field.name, field.value])),
        })),
      });
      break;
    }
    case 'probe':
      if (!rest[0]) { console.error('用法: probe <serverId>'); process.exit(2); }
      print(await call('probe', { sessionId, serverId: rest[0] }));
      break;
    case 'connect':
      print(summarizeStatus(await call('connect', { sessionId, ...(rest[0] ? { serverId: rest[0] } : {}) })));
      break;
    case 'disconnect':
      print(summarizeStatus(await call('disconnect', { sessionId, ...(rest[0] ? { serverId: rest[0] } : {}) })));
      break;
    case 'follow':
      print(summarizeStatus(await call('follow', { sessionId })));
      break;
    case 'config':
      print(await call('config'));
      break;
    case 'write': {
      const [preset, name, raw] = rest;
      if (!preset || !name || !raw) { console.error("用法: write <preset> <name> '{\"command\":\"node\",\"args\":[\"...\"]}'"); process.exit(2); }
      const values = JSON.parse(raw);
      print(await call('declaration', {
        sessionId, action: 'write', preset, name,
        fields: Object.entries(values).map(([field, value]) => ({ name: field, value })),
      }));
      break;
    }
    case 'remove': {
      if (!rest[0]) { console.error('用法: remove <serverId>'); process.exit(2); }
      const result = await declarations();
      const entry = (result.targets ?? []).find(target => target.serverId === rest[0]);
      if (!entry) { console.error('声明里没有 ' + rest[0]); process.exit(1); }
      print(await call('declaration', { sessionId, serverId: rest[0], action: 'remove', version: entry.version }));
      break;
    }
    case undefined:
    case '-h':
    case '--help':
      console.log('命令: status | list | probe <serverId> | connect [serverId] | disconnect [serverId] | follow | config | write <preset> <name> <json> | remove <serverId>');
      break;
    default:
      console.error('未知命令: ' + command);
      process.exit(2);
  }
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(1);
}
