# 变更记录

## 0.5.0：改用 `ctx.mcpClientHost`、浏览器授权、按需工具加载

这一版不再自建连接层：挂载、探测、授权与断线状态全部交给原生桥接 `@deepseek-ai/dsh-mcp-client` 的 `ctx.mcpClientHost`（DSH 0.2.3 起提供，`engines.dsh: >=0.2.3-alpha.2`）。

- **连接层换成 `ctx.mcpClientHost`**：每会话在其作用域边界下创建一个 `isolate` 过服务名的宿主实例，用 `validate()` 解析声明、`mount()` 挂载、`onChange` 订阅 `McpConnectionStatus`、`dispose()` 取回 `closeConfirmed` / `cleanupError`。删除了自建的 `createNativeAdapter`、按版本号与导出名的能力探测、读取 `connectionStatusOf`、日志文本匹配，以及整套自管重试定时器（`retry.js` 只剩并发名额限制）。挂载配置传 `failOnStartupError: false`，`waiting-authorization` 才不会被启动错误掩盖。
- **断线与重试归桥接**：面板状态直接映射原生状态机（`connecting` / `connected` / `reconnecting` / `failed(gave-up|reconnect-disabled|unclosed-generation)` / `waiting-authorization` / `waiting-credentials` / `closed`），重连次数、退避与尝试预算都由桥接决定。插件只保留两件自己的事：权限被撤销时结束实例，以及**只读可达性探测**——连续两次不可达时替换连接代（dispose + 重新 mount），因为桥接无法报告一个不回应任何请求的端点。
- **MCP OAuth 与凭据自动刷新**：声明可用 `oauth`（`true` 或 `{ clientId, scope, credentialKey, requestTimeoutMs, authorizationTimeoutMs }`），凭据存进宿主凭据服务并自动刷新。被动连接不打开浏览器：行显示「需要授权」与 `missing` / `expired` / `binding` / `rejected` / `scope` 原因，「授权」走 DSH 授权流程并给出授权页链接，「取消授权」撤回进行中的尝试。新增控制路由 `POST /workspace-mcp/authorize` 与 `/cancelAuthorize`。`oauth` 与 `Authorization` 头互斥、stdio 不能声明，分别以 `CONFLICTING_AUTH_HEADERS` / `INVALID_OAUTH` 拒绝。
- **按需工具加载（默认开）**：`toolLoading: 'on-demand'` 让桥接把工具列进系统提示词目录、只注册一个 `mcp__<server>__load_tools`，多服务器场景不再全量占用上下文；`catalogDescriptionMaxLength`（默认 160）限制目录简介长度。单条声明可覆盖这两个值，声明字段不是任何方言的标准字段，只影响本插件。面板按需行显示「N 个工具（按需）」。
- **按 0.2.3 契约修正的适配点**：工具准入改为 `ctx.tools.resolve()`（`step.js`）；`engines.dsh` 提到 `0.2.3-alpha.2` 并去掉 `@deepseek-ai/dsh` peer（否则会把整个元包拉进开发依赖）；devDependencies 升到 `0.2.3-alpha.2`（cordis `4.2.0-alpha.1`），测试夹具改为 `fakeHost` + 真实 `executeToolBatch` 管线。
- **修复 `includeTools` 把按需加载器一起禁掉**：项目写了 `includeTools` 时，过滤名单里没有桥接自己注册的 `mcp__<server>__load_tools`，guard 会把它当作被禁用工具拒绝，于是该服务器的任何工具都无法加载（默认 `on-demand` 下必现）。加载器是这套过滤的传输手段而不是被过滤的工具：`tools.guard` 与闸门的 `declaredUnavailable()` 都按名单跳过它，`status` 也不再把它列进 `disabledTools`；被 `excludeTools` 排除的工具仍出现在目录里、可以加载，但调用时照旧由 guard 拒绝。回归：`test/gate.test.js`、`test/status.test.js`。
- **明确的限制**：HTTP 服务端重启后旧会话失效、端点仍然可达时，transport 不会报关闭，本插件也不按错误文本猜断线——该行保持已连接，失败一次不重放，需「断开 → 连接」或改声明来重新 initialize。
- **随包 skill 同步 0.5.0 行为**：`skills/dsh-mcp-glue/SKILL.md` 补上按需加载的加载／生命周期／全量开关、授权行与授权页取法，以及 `INVALID_CONFIG`、`MISSING_CREDENTIALS`、`NATIVE_UNAVAILABLE` 三类新增失败和「已连接但工具不在工具表里」的处置；验证闭环改为先 `load_tools` 再调用，声明字段表补上三个插件自有字段。

## 0.4.2：适配 DSH 0.2.3-alpha.2

- **探测改走 `ctx.mcpClientHost`**：0.2.3 起 `@deepseek-ai/dsh-mcp-client` 的根入口不再导出模块级 `probeServer`，探测只能经管理方创建的主机调用。现在优先复用组合里已有的 `mcpClientHost`，没有就为本会话在插件上下文中创建一个；旧桥（0.2.0–0.2.2）的 `probeServer` 保留为兜底，不会因为升级宿主而丢掉「测试连接」。
- **控制路由声明匿名准入**：0.2.3 起 `webServer.register` 的命名路由默认 `auth: 'required'`，没有 Cookie 的本机进程调用会被 503/401 挡住，`skills/dsh-mcp-glue/scripts/mcpctl.mjs` 的 status/list/probe/connect 全部失效。该 handler 自带 loopback、同源与每进程 token 三层校验，显式声明 `auth: 'anonymous'` 不降低安全性。

## 0.4.1：会话失效识别补全

- **HTTP 400 也算会话失效**：原先只有 `404` 会被判成 `SESSION_EXPIRED`。服务端用 `400` 回 `-32600 Session not found` 时分类落空（返回 `undefined`），插件不发射失败事件——面板继续显示已连接，也不会自动重连。现在 `400` 必须由响应体明确提到会话失效才判，普通请求错误（如 `Invalid params`）不会触发重连。
- **JSON-RPC 协议错误不再被跳过**：服务端以 `200 + error` 回复时，SDK 抛的是没有 SDK 品牌的数字码 `ProtocolError`，原来的 `isSdkError` 检查会直接略过。现在 `-32600` 且消息指明会话失效时同样判为 `SESSION_EXPIRED`。
- 会话失效仍只触发一次重连：本次失败照原样返回给模型，不重放可能已产生副作用的工具调用。

## 0.4.0：写入跟随会话沙箱、诊断带位置、Windows shim 提示

- **修复 `workspace-write` 下写入必失败**：声明写操作没有把会话的沙箱策略交给文件系统，后端回退到部署级工作区根，于是工作区内的 `.mcp.json` 也被判为越界（`FS_SANDBOX_DENIED`）。现在每次写都携带该会话解析出的策略；`read-only` 仍然只读并返回 `DECLARATION_READ_ONLY`。
- **诊断带位置与字段**：JSONC/TOML/YAML 语法错误报告行列，字段错误点名具体字段、键或环境变量（例如「变量 TOKEN 没有值」），不再只给一个错误码。
- **`status` 更可判读**：每行新增 `errorDetail` 与 `warnings`；计数拆出 `counts.invalid` 与 `counts.warnings`，并新增 `lastDeclarationChangeAt`，手改之后能直接确认改动是否被接受。
- **Windows shim 提示**：`command` 为 `.cmd`/`.bat` 或 `npx`/`npm`/`pnpm`/`yarn` 时给出 `WINDOWS_SHIM_COMMAND` 警告（不阻塞加载）；`windowsShim` 设为 `rewrite` 时在内存中改写成 `cmd /d /s /c`，声明文件不变。
- **随包 skill 自动注册**：`skills/dsh-mcp-glue/` 提供排障说明与零依赖 CLI（`mcpctl.mjs`），插件激活时通过 `ctx.skills.register()` 注册为 `source: bundled`，无需复制到 skill 目录。

## 0.3.3：面板细节修正

- 面板打开时不再先出现在兜底位置再瞬移：改为在绘制前用 `useLayoutEffect` 测量 MCP 按钮，测量完成前保持隐藏。
- 行始终是一行：重连倒计时并入状态标签（`重连中 · 12s`，等宽数字），尝试次数与传输错误码放进该标签 tooltip；「重试」回到行内，主操作简写为「停止／重试」（完整文案保留在 `title` 与 `aria-label`）。纯网络错误码不再单独占行，只有可操作的失败原因才占一行。
- 修复面板横向溢出：`overflow-x` 隐藏、行允许收缩，行内不再出现横向滚动条，右侧按钮不会被挤出面板。
- 移除行内多余的 `⋯`：点击服务器名称本来就是编辑入口，重复的入口只会占宽度并触发上面的溢出。

## 0.3.2：DSH 0.2.2-rc.2 兼容、原生连接状态与「测试连接」

- 接入 `dsh-mcp-client` 0.2.2+ 的 `connectionStatusOf(fiber)`：断线、重连、失败原因与清理结果直接读原生状态机；**订阅成功后不再解析生命周期日志**（单一事实来源，措辞漂移不会叠出重复事件），只有无此接口的旧版本才用日志文本兜底，无法适配时回退原生行为。
- 关闭确认改读状态单元的 `closure()`：`closeConfirmed: false` 或 `cleanupError` 一律标记 `CLOSE_UNCONFIRMED`。0.2.2 移除了原先匹配的两句关闭日志（改说 `cleanup incomplete`），旧逻辑在 rc.2 上无法再拦截重叠进程。
- 面板每行新增「测试连接」：调用原生 `probeServer()` 完成一次真实 MCP 握手与工具列表（stdio 与 HTTP 均可），不注册工具、不占用服务器名、不影响现有连接，返回服务器身份、工具数与耗时；成功即刷该行的 MCP 级确认，失败只撤绿、不拆连接。
- 修复面板定位：弹层 portal 到 `document.body`，不再被输入框工具行的 transform/contain 影响，位置始终跟随 MCP 按钮。
- 0.3.1 的组装适配（0.2.2 在提示词组装前固定本步可执行工具，`system-prompt/assemble` 不含 `tools`）保持不变。
