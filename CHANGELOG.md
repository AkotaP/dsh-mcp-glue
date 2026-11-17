# 变更记录

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
