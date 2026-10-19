/**
 * Plugin entry: workspace-scoped MCP loading plus the management-UI control route.
 *
 * Host code is reloaded by dsh-hmr on file change; the client half is a built bundle
 * under lib/ served by the shell module loader.
 *
 * Every optional service is acquired through `ctx.inject([...])`, never through a bare
 * `ctx.get`: a Cordis fiber only sees services it declares, so a lazy lookup from a
 * plugin fiber silently returns undefined for a sibling plugin's service.
 */
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { BUILTIN_PRESETS, resolvePresets } from './presets.js';
import { installWorkspaceLoader } from './runtime.js';
import { createControl } from './control.js';
import { createConfigControl, liveConfig } from './config.js';
import { installWebControl } from './web.js';

export const name = 'workspace-mcp-glue';
/** The npm package name: the Loader row specifier, the client bundle id, and the client seat key. */
export const packageName = 'dsh-mcp-glue';
export const inject = ['agents', 'tools', 'fs', 'systemPrompt'];
const choice = values => z.union(values.map(v => z.const(v)));
const Preset = z.object({
  id: z.string().required().description('预设唯一 ID；使用内置 ID 可覆盖该预设'),
  extends: z.string().description('继承内置或前面声明的自定义预设 ID'),
  enabled: z.boolean().description('设为 false 禁用这个预设'),
  files: z.array(String).description('相对会话工作区的文件位置；不向父目录搜索'),
  format: choice(['json', 'jsonc', 'toml', 'yaml']).description('声明文件解析格式'),
  serversPaths: z.array(String).description('服务器表路径；点路径或 JSON Pointer；空字符串代表文件根'),
  dialect: choice(['standard', 'codex', 'gemini']).description('协议字段的语义方言'),
  interpolation: choice(['standard', 'shell', 'none']).description('变量插值：standard 支持 ${env:VAR} 等；shell 另支持 $VAR/%VAR%'),
  fields: z.dict(String).description('规范字段名 → 声明中的字段路径；例如 command: executable'),
});
/**
 * The five fields the management UI edits are declared `.volatile()`: DSH derives an
 * entry's editable settings form from its Config schema, and `volatileForm()` drops an
 * entry whose form would be empty. A volatile field also arrives in `apply` as a live
 * reference rather than a plain value, which is what `liveConfig` unwraps. See
 * src/config.js for the matching field list and the write path.
 */
/**
 * One workspace's exceptions beneath the directory-level trust list.
 *
 * `trustedWorkspaces` means "everything in this directory is trusted"; this is the finer
 * layer for "in this directory I trust only these". It lives in the user's profile patch,
 * never in the project: a repository must not be able to authorize itself.
 */
const WorkspaceAllowance = z.object({
  workspace: z.string().required().description('绝对路径；按规范化身份精确匹配该目录本身，不含子目录'),
  allowMcp: z.array(String).default([]).description('这个工作区里自动连接的服务器名（serverName）'),
  allowTools: z.array(String).default([]).description('这个工作区里免批准的工具，写 public 名（mcp__server__tool）'),
});
export const Config = z.object({
  enabled: z.boolean().default(true).description('按会话工作区加载项目 MCP'),
  enabledBuiltins: z.array(String).default(BUILTIN_PRESETS.map(p => p.id)).description('启用的内置预设及其加载顺序：root/vscode/codex/cursor/gemini').volatile(),
  presets: z.array(Preset).default([]).description('自定义预设；内置 ID 可被同名定义覆盖').volatile(),
  conflictPolicy: choice(['error', 'first-wins', 'last-wins']).default('error').description('不同文件的同名服务器冲突；error 禁用冲突服务器').volatile(),
  // `ask` is the value earlier versions wrote. Tightening this enum once took the whole plugin
  // down for a profile that still said it — and the symptom was an unrelated-looking 404, since
  // the Loader drops a row whose config fails to resolve. It is accepted and read as `manual`.
  trustMode: choice(['manual', 'all', 'ask']).default('manual').description('manual：只加载被信任目录或被逐项许可的服务器，从不主动询问；all：信任所有项目，存在执行仓库代码风险').volatile(),
  trustedWorkspaces: z.array(String).default([]).description('受信任的绝对工作区目录：其中一切都允许自动加载；只匹配该目录本身，不含子目录').volatile(),
  workspaceAllowances: z.array(WorkspaceAllowance).default([]).description('按工作区的例外：这个目录里只自动连接这些服务器 / 只免批准这些工具').volatile(),
  inputValues: z.dict(z.string().role('secret')).default({}).description('VS Code ${input:id} 等变量的显式值；不会执行项目 inputs.command'),
  maxFileBytes: z.number().step(1).min(1024).max(16777216).default(1048576).description('每个声明文件或 envFile 的字节上限'),
  maxServers: z.number().step(1).min(1).max(128).default(32).description('每个工作区最多检查的服务器条目数'),
  startupTimeoutMs: z.number().step(1).min(100).max(300000).default(15000).description('每台服务器启动超时；Codex startup_timeout_sec 优先'),
  webControl: z.boolean().default(true).description('注册管理 UI 的同源控制路由；关闭后界面仍显示状态但无法手动连接'),
});
export async function apply(ctx, config) {
  // Volatile fields arrive as live references; every read below goes through the
  // unwrapped view so a saved setting applies without a remount.
  const live = liveConfig(config);
  resolvePresets(live); // Fail malformed Host presets before attaching any Agent.
  if (live.trustedWorkspaces.some(root => !path.isAbsolute(root))) throw new Error('trustedWorkspaces must contain absolute Host paths');
  if ((live.workspaceAllowances ?? []).some(entry => !path.isAbsolute(entry.workspace))) throw new Error('workspaceAllowances must name absolute Host paths');
  // Optional services for consumers that cannot see them through the Agent's context. The
  // loader asks for nothing else: it never requests approval on a project's behalf, because
  // a workspace declaration is only loaded when the user already allowed it.
  const optional = { fs: undefined, sandboxPolicy: undefined };
  for (const name of ['fs', 'sandboxPolicy']) {
    ctx.inject([name], inner => {
      optional[name] = inner[name];
      return () => { optional[name] = undefined; };
    });
  }
  const services = { settings: undefined, loader: undefined };
  ctx.inject(['loader'], inner => {
    services.loader = inner.loader;
    return () => { services.loader = undefined; };
  });
  ctx.inject(['settings'], inner => {
    services.settings = inner.settings;
    return () => { services.settings = undefined; };
  });
  const loader = await installWorkspaceLoader(ctx, live, {
    optionalServices: optional,
    resolveLoader: () => services.loader ?? ctx.get('loader'),
  });
  if (!loader) return;
  if (live.webControl === false) {
    ctx.logger.warn('workspace-mcp: webControl is disabled; the management UI cannot read or change state');
    return;
  }
  const control = createControl(ctx, loader.stateFor);
  // Configuration editing reads and writes this plugin's own profile entry.
  const configControl = createConfigControl({
    settings: () => services.settings,
    loader: () => services.loader,
    packageNames: [packageName, name],
    fallback: () => live,
    onChange: () => loader.policyChanged(),
  });
  // ── Tool gate ────────────────────────────────────────────────────────────────────
  // Loading a server and calling one of its tools are separate decisions. A tool from a
  // workspace that authorized the server but not that tool asks the user first — through
  // `ctx.userQuestions`, not through DSH approval, because only this way can the answer offer
  // "always allow" as well as "once" and "no". `tools/pre-execute` is an async waterfall, which
  // is what lets the gate wait for that answer before deciding.
  const questions = { service: undefined };
  ctx.inject(['userQuestions'], inner => {
    questions.service = inner.userQuestions;
    return () => { questions.service = undefined; };
  });
  const policy = { service: undefined };
  ctx.inject(['sandboxPolicy'], inner => {
    policy.service = inner.sandboxPolicy;
    return () => { policy.service = undefined; };
  });
  /**
   * A deployment — or this particular session — that already runs unconfined has answered this
   * question globally. `resolve({ session })` is what lets a session-level override count, not
   * just the deployment default.
   */
  const unconfined = exec => {
    try { return policy.service?.resolve?.({ session: exec?.agent?.session })?.mode === 'danger-full-access'; }
    catch { return false; }
  };
  const ONCE = '仅此次允许';
  const ALWAYS = '总是允许这个工具';
  const NEVER = '拒绝';
  ctx.on('tools/pre-execute', async (exec, next) => {
    const state = exec?.agent === undefined ? undefined : loader.stateFor(exec.agent);
    if (state === undefined || typeof exec.name !== 'string' || !exec.name.startsWith('mcp__')) return next();
    // Leave every global or sibling-plugin MCP alone: only this session's own mounts are ours.
    const owned = [...state.mountedServers()].find(server => exec.name.startsWith(`mcp__${server}__`));
    if (owned === undefined) return next();
    // During recovery an inherited global definition may become visible beneath
    // the removed scoped registration. A textual namespace alone does not own it.
    if (ctx.tools.get(exec.name, exec.agent) === ctx.tools.get(exec.name)) return next();
    // A stale confirmation costs a bounded probe here; letting the call proceed would cost
    // the whole tool timeout. Never replay the call afterwards.
    const verdict = await state.verifyBeforeCall(owned, exec.signal);
    if (verdict !== undefined && verdict.reachable === false) {
      return {
        kind: 'deny',
        reason: `工作区 MCP「${owned}」当前不可达（${verdict.code}），正在自动重连，请稍后重试`,
        info: { name: exec.name, code: 'WORKSPACE_MCP_UNREACHABLE', reason: `可达性探测失败：${verdict.code}` },
      };
    }
    if (state.canInvokeWithoutApproval(exec.name) || unconfined(exec)) return next();
    // The project can forbid its own tools, and that prohibition is enforced by a guard after
    // this gate — a guard can only deny, so the question would have no honest answer. Skip it
    // and let the guard refuse the call with its own reason.
    if (state.declaredUnavailable(exec.name) !== undefined) return next();
    if (questions.service === undefined) return next(); // No answerer composed: never wedge a tool call.
    let answer;
    try {
      answer = await questions.service.ask({
        agent: exec.agent,
        signal: exec.signal,
        questions: [{
          id: 'workspace-mcp-tool',
          header: '工作区 MCP 工具',
          question: `允许调用 ${exec.name} 吗？`,
          detail: `这个工具来自 ${state.workspacePath ?? '当前工作区'}：该工作区没有被信任，这个工具也不在它的 allowTools 里。`,
          options: [
            { label: ONCE, description: '只放行这一次，下次调用仍会询问' },
            { label: ALWAYS, description: '写进这个工作区的 allowTools，以后不再询问' },
            { label: NEVER, description: '这次调用返回错误' },
          ],
        }],
      });
    } catch (error) {
      const code = error?.code;
      // A delegated child agent cannot open a human interaction at all (`assertLiveRoot` rejects
      // it), and an unanswerable gate must not forbid the call either: the server itself was
      // already authorized. Everything else — the user dismissing the card, a timeout, no
      // answerer at all — fails closed with the reason spelled out.
      if (code === 'DELEGATED_CALLER' || code === 'CALLER_NOT_LIVE') return next();
      return { kind: 'deny', reason: `工作区 MCP 工具授权未完成（${code ?? 'ASK_FAILED'}）` };
    }
    const item = answer?.answers?.[0];
    const chosen = item?.custom ?? item?.selected?.[0];
    if (chosen === ALWAYS) {
      const workspace = state.workspacePath;
      if (workspace !== undefined) {
        try {
          await configControl.updateAllowance(workspace, entry => ({
            ...entry,
            allowTools: [...new Set([...entry.allowTools, exec.name])],
          }));
        } catch (error) {
          ctx.logger.warn(`workspace-mcp: could not record allowTools for ${exec.name}: ${error?.message ?? error}`);
        }
      }
      return next();
    }
    if (chosen === NEVER) {
      return {
        kind: 'deny',
        reason: `用户拒绝了这个工作区 MCP 工具调用：${exec.name}`,
        info: { name: exec.name, code: 'WORKSPACE_MCP_DENIED', reason: '用户在工具授权卡片里选择了拒绝' },
      };
    }
    return next(); // Once: this call only; the next one asks again.
  });
  // `webServer` is optional: the inject callback runs only while it exists, and its
  // returned disposer removes the token tap and the route with the same lifetime.
  ctx.inject(['webServer'], inner => installWebControl(inner, { ...control, ...configControl }));
}
