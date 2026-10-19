# DSH 的 MCP 加载方式与插件扩展点

本页记录实现前对本机 **DeepSeek Harness 0.2.0-rc.2** 的调查结论（安装位置 `D:\Soft\DSH\resources\app.asar`，运行入口 `resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`）。结论都来自对归档内 `dsh/node_modules/@deepseek-ai/*` 的只读阅读：asar 是"16 字节头部（含 JSON 索引）+ 文件数据"的简单容器，需要复核时直接按该格式解包即可。

> **0.2.1-rc.2 复核**：本机随后升级到 DSH `0.2.1-rc.2`（`@deepseek-ai/dsh-mcp-client` 同为 `0.2.1-rc.2`）。对归档内该模块的只读比对确认：本插件依赖的三条生命周期日志措辞、`Config.reconnect` 字段、导出集合（`Config / apply / createMcpToolDefinition / inject / name`）全部未变，因此适配层沿用同一实现，版本准入改为“已验证版本 + 能力兜底”。离线测试套件的 `devDependencies` 仍固定在 `0.2.0-rc.2`。

## 1. 原生加载链路

| 环节 | 事实 |
|---|---|
| Profile 装配 | `cordis.yml` 风格的 profile patch 由 `@deepseek-ai/dsh-app-boot` 解析，bundle 通过 `package.json` 的 `dsh.bundle.patch` 提供补丁层 |
| MCP 插件 | `@deepseek-ai/dsh-mcp-client`：**一个插件实例 = 一台服务器**；`inject: ['tools']` |
| 配置字段 | `serverName`、`transport: stdio \| streamable-http`、`command/args/env/cwd` 或 `url/headers`、`toolCallTimeoutMs`、`failOnStartupError`、`reconnect.*` |
| 工具命名 | 公开名是 `(serverName, rawName)` 的纯函数：`mcp__<server>__<tool>`，超长/非法字符时追加 12 位 SHA-256 并截断到 64；`tools/call` 始终发送原始名 |
| 资源 | `@deepseek-ai/dsh-mcp-resources` 提供 `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`；每台服务器调用 `ctx.mcpResources.register(name, provider)` |
| 服务器指令 | `ctx.systemPrompt.section({ name: 'mcp:<server>', order: MCP_SERVERS, interpolate: false, text: () => connection.instructions() })` |
| 作用域 | 上述三个注册都走 `dsh-scope` 的分层注册表：`scopeOf(ctx)` 决定注册所属的 scope，而工具/提示词/资源读取按 scope 链合并 |
| 启动语义 | 服务器不可达时 harness 照常启动、只记录错误；`failOnStartupError: true` 才拒绝插件激活 |

## 2. 会话作用域

- `@deepseek-ai/dsh-agent-loop` 为每个会话执行 `this.scope = createScope(loopCtx, this)`，`this` 就是 Agent 对象本身，所以 **scope key = agent**。
- `assembleContextFor(agent, signal)` 返回 `{ agent, scope: agent, signal }`，即提示词组装与工具快照都用同一个 Agent 作为查看 scope。
- `@deepseek-ai/dsh-scope` 的 `ScopedLayers` 规则：全局层 + 按 scope 链（最近者胜）的覆盖层；`createScope(ctx, key)` 会「继承铸造方的依赖 API」，同时把 `key` 作为注册与事件路由的标识。
- `@deepseek-ai/dsh-tools` 的 `register/get/schemas/restrict/guard` 都接受 `scope`，scoped 注册覆盖同名全局注册。
- **结论**：只要以 Agent 作为 scope key 注册 MCP 插件实例，它的工具、资源、指令就只对该会话可见；同一 `serverName` 在不同会话中互不冲突（原生 `activeServerNames` 也按 scope key 隔离）。

## 3. 时机（关键坑）

`agent-loop` 的顺序是：

1. `preStep()`：`this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))` —— 工具快照与提示词在这里冻结；
2. 之后才 dispatch `agent/pre-step` waterfall；
3. `step()` 用上一步的 `assembly.tools` 构造请求。

因此**在 `agent/pre-step` 里加载的服务器赶不上当前这次请求**（要到下一轮）。`system-prompt/assemble` 的 waterfall 是在基础快照构建之后运行的，所以本插件在那里加载，并在检测到「加载状态有变化」时用 `refreshBaseDelta` 只把变化的 sections/contexts/tools/variables 覆盖进当前 assembly。

插件不递归调用 `assemble()`（那会让排在它之前的中间件重复执行、产生重复 section 甚至触发原生 invariant 拒绝），而是用 `ctx.extend({ waterfall })` 读一次基础快照做差量。

## 4. 为什么不能把项目声明放进全局 profile

- Loader 条目在进程启动时就确定，`serverName` 在**加载作用域内唯一**，且 stdio `cwd` 是启动期固定值 —— 无法按会话工作区变化。
- 全局条目对**所有**会话可见，正是需要避免的串扰。
- 因此正确做法是：插件只读取「当前会话工作区」的文件，运行期在 Agent scope 内实例化原生 `dsh-mcp-client`。不修改、不导入、不覆盖用户原有 MCP 条目。

## 5. 安全边界

- 原生 stdio 由 MCP SDK 直接 `spawn`，**不经过 DSH 的 pwsh/bash 沙箱**；因此项目声明等同「以当前用户身份执行程序」的权限，必须显式授权。本插件默认 `trustMode: ask`，且只接受 `allowed-once`。
- 批准需要在 turn 内（`approval.request` 要求审计对可提交）；`agent/created` 阶段只读取与诊断，不询问。
- 原生 `scrubbedParentEnv()` 会剔除名称匹配 `KEY|PASSWORD|SECRET|TOKEN` 的变量与全部 `DSH_*`，再合并声明里的 `env`。
- 插件对项目内容只做**声明式转换**：不加载项目 JS、不执行 `inputs.command`、不跟随目录联接逃逸工作区、拒绝重复 JSON 键、对超限文件/条目给出内容无关诊断。

## 6. 模块实例身份（第三方插件的关键约束）

`@deepseek-ai/dsh-scope` 把作用域标签、父子关系、事件路由键都存在**模块私有**的 `Symbol("dsh.scope")` 和 `WeakMap` 里：

- 运行时（app.asar 内 `dsh/node_modules`）与 profile 的 `node_modules` 是两份物理拷贝；
- 如果第三方插件从自己的 `node_modules` 里 `import '@deepseek-ai/dsh-scope'` 并调用 `createScope`，它写入的标签用**自己那份**的 Symbol；而 `ctx.tools` / `ctx.systemPrompt` / `ctx.mcpResources` 注册表来自运行时那份，读的是**另一个** Symbol；
- 结果：注册被当成全局注册（跨会话泄漏），`scopeTarget` 事件过滤也随之失效。

同理，`@deepseek-ai/dsh-mcp-client` 内部也用 `scopeOf(ctx)`，所以**不能用第二份拷贝**去挂载服务器。

本插件的对策：

1. **不使用 `createScope`**。作用域标签会沿 context 原型链继承，因此在 `agent.ctx` 下创建一个普通子纤维即可：注册既归属该 Agent 的 scope，又能随子纤维单独卸载。
2. **通过宿主 loader 取得原生桥接**：`ctx.get('loader').import('@deepseek-ai/dsh-mcp-client')`。Node 以解析后的 URL 缓存 ES 模块，而 loader 加载 profile 行用的就是这条路径，因此拿到的是**同一个实例**。
3. 因此插件不声明任何 `@deepseek-ai/dsh-*` 运行时依赖（`schemastery` 只用于 Config schema，是纯数据结构，无跨模块身份要求）。

第三方插件的先例也印证这一点：profile 里已安装的 `dsh-skill-mcp-panel` 等只从自己的 `node_modules` 引入 `dsh-subprocess`、`schemastery`、`yaml` 这类无身份耦合的包。

## 7. 未支持的原因

| 项 | 原因 |
|---|---|
| SSE / WebSocket | 原生桥接只实现 stdio 与 Streamable HTTP |
| OAuth / 动态 headers helper | 原生插件没有对应配置面，静默降级会改变鉴权语义 |
| Gemini `url` | 在 Gemini 方言中语义是旧 SSE，误当 HTTP 会改变连接目标 |
| `sandboxEnabled` / 服务器级 sandbox | 原生桥接不支持；假装支持会让用户以为已有隔离 |
| VS Code `${input:...}` 交互取值 | 需要 UI 输入与秘密存储，本插件改为读取 Host 配置里的显式值，未提供则拒绝该服务器 |
