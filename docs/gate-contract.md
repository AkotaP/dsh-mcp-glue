# DSH 工具调用闸门（tools/pre-execute）契约

> 读者对象：马上要照着这份文档实现「工具级闸门」的工程师。
> 目标形态：在**工具调用前**拦截本插件挂载的 MCP 工具；未授权工作区里的调用先问用户，用户可选「仅此次允许 / 允许并记住 / 拒绝」；已授权则直接放行。
>
> **被测版本**：DSH `0.2.0-rc.2`，安装路径 `D:\Soft\DSH\resources\app.asar`（asar 容器内的包路径前缀是
> `D:\Soft\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\<pkg>\`）。下文所有 `文件:行号` 都指该 asar 内的文件行号。
>
> **读取方式（已实测）**：本机 Electron 的 `fs` 已被 asar 补丁接管，Node 里可以直接
> `fs.readFileSync('D:\\Soft\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-tools\\lib\\index.js')`；
> 但 **PowerShell 的 `Get-ChildItem` 读不了 asar 内路径**，实测报 `Cannot find path 'D:\Soft\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai' because it does not exist`。想递归列目录也必须走 Node。
>
> **重要提示（仓库正在被并行修改）**：调研期间 `D:\Data\Project\dsh\dsh-mcp-glue\src\runtime.js` 的 mtime 从 `06:48:26Z` 变到 `06:48:51Z`，其中原有的 `approval.request(...)` 调用已被删除。本文引用仓库文件的行号都标了读取时刻，落地实现前请重新读一遍。DSH 安装包（asar）不在改动范围内。

---

## 0. 结论摘要

`tools/pre-execute` 是 DSH 里唯一「可以在调用前异步发问」的闸门：它是 **waterfall**（不是 emit），监听器签名 `(exec, next) => Promise<PreToolDecision>`，返回值是封闭四态 `{kind:'allow'|'deny'|'cancel'|'ask'}`；`next()` 委派给链上后续监听器（最终内置默认 `{kind:'allow'}`），不调用 `next()` 而直接返回决策 = 短路否决整条链。**返回 `undefined` 是 bug**：注册表会读 `gate.kind` 从而抛 TypeError，调用以错误结果失败（fail closed，但报错很难看）。返回 `{kind:'ask'}` 会走宿主批准通道 `ctx.approval.request({agent, toolName: exec.name, callId, reason, displayReason, signal})`，它**要求本回合处于打开状态**，会先写 `approval/asked`、再写 `approval/decided` 审计对；当会话批准政策是 `never` 时，`ApprovalService.decide()` 在**进入应答者瀑布之前**直接返回 `'rejected'`（不是 UI 超时、不是失败），于是这次调用以 `Error: the user rejected tool "<name>"` 失败——fail closed，且弹窗根本不会出现。宿主自带弹窗的按钮是**写死的两个**（Allow once / Reject，快捷键 Enter/Esc），请求体里也**没有**任何按钮/选项字段，插件无法给它加按钮或改文案；批准结果词汇表是封闭的 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，**没有「允许并记住」这一档，也没有任何 grant store**。所以「三选一 + 记住」这个 UX **不能**用宿主批准弹窗实现，正确做法是在 `tools/pre-execute` 里 await **`ctx.userQuestions.ask({questions, agent, signal})`**——它本身就是 waterfall + 客户端 `conversation.composer` 插槽渲染的自定义选项卡片，返回值就是用户点的那条 **option label 原文**，闸门拿到答案后再返回 `allow/deny`，同时把「记住」写进本插件自己的 `workspaceAllowances[].allowTools`。唯一的硬约束是：`ask()` 要求传入的 agent 必须是**当前的 live runtime root**，子 agent（Team 队友 / in-process 子代理）会被 `DELEGATED_CALLER` 拒绝，必须在闸门里 catch 并降级处理。

---

## 1. Q1 — tools/pre-execute 的确切签名

### 1.1 事件契约（权威声明）

`dsh-tool-cordis/lib/types/api-catalog.js`（DSH 自己生成的 API 目录，供 `cordis_inspect_query` 使用）：

- `4236-4241`：`'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>`
  - `4237` `mode: 'waterfall'`
  - `4240` 摘要原文：*"Allow, deny, cancel, or ask before dispatch. `next()` delegates to allow; `cancel` selects the canonical pre-dispatch cancellation result, and missing approval support turns `ask` into denial. Async gates must observe `exec.signal`; the registry rechecks cancellation after they settle but never abandons their promise. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls."*
  - `4241` 参数说明：`{ name: 'exec', description: 'the pending call (name, parsed arguments, caller agent).' }`

注册方式：`ctx.on('tools/pre-execute', listener, options?)`，`options` 为 `{ prepend?: boolean, global?: boolean }`（`cordis/src/events.ts:112-117` 的 `EventOptions`，注册入口 `events.ts:288`；布尔值等价于 `prepend`，见 `events.ts:289-291`）。返回 disposer，随 fiber 卸载自动解除（`events.ts:254-266 register()`）。

### 1.2 是 waterfall 还是 emit

**waterfall**。证据：事件目录的 `mode: 'waterfall'`（`api-catalog.js:4237`）与实现 `dsh-tools/lib/index.js:3225`：

    const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));

waterfall 语义（`cordis/src/events.ts:224-243`）原文：*"Compose listeners around the final `next` callback. The last dispatch argument is treated as the innermost `next`. Listeners run outermost-first; a listener that does not call `next()` vetoes the rest of the chain, including the built-in behavior."* 实现关键三行（`events.ts:234-242`）：`const next = () => { const cb = cbs.shift() ?? inner; return cb(...args) }`。**推论 1**：监听器顺序 = 注册顺序，`{prepend:true}` 插到最前；**推论 2**：`next()` 每次都会 `shift()` 掉一个后续监听器，**绝对不要调用两次 `next()`**（会跳过一层监听器）；**推论 3**：`next()` 的返回值就是下游决策，可以先 `await next()` 再决定是原样返回还是改写（这正是 `dsh-experimental-auto-review` 的写法）。

### 1.3 `exec` 有哪些字段

类型声明（`api-catalog.js`）：

- `7551-7552` `ToolExecutionInput`：`{ readonly callId: ToolCallId; readonly rootCallId?: ToolCallId; readonly name: string; readonly schema?: ToolSchema; readonly arguments: unknown; readonly agent?: Agent; readonly parent?: ToolExecutionToken; readonly signal: AbortSignal }`
- `7543-7544` `ToolExecution extends ToolExecutionInput`，新增 `readonly rootCallId: ToolCallId`、`readonly token: ToolExecutionToken`
- `token` 是 registry 铸造的关联令牌，`dsh-tools/lib/index.js:3613-3615` 显示它是 `Symbol("dsh.tool.execution")`
- `7531-7532` `ToolDefinition.execute(args, exec: ToolRunContext)`；实体上还带 `deferContext()` / `concludeTurn()`（`index.js:3152-3157`）——闸门用不到，但它们确实挂在对象上。

实现侧铸造点 `dsh-tools/lib/index.js:3131-3204 createExecution(exec)`，逐字段来源：

| 字段 | 来源 | 证据 |
|---|---|---|
| `name` | 调用方给的公共工具名 | `index.js:3136`, `3147` |
| `arguments` | `snapshotJsonValue(exec.arguments)` 后 `deepFreeze`（**深冻结、不可改写**） | `index.js:3163-3168` |
| `agent` | `exec.agent`；无 agent 时该字段**不存在**（不是 null） | `index.js:3137`, `3149` |
| `parent` | 仅 PTC `run_code` 内部子调用会带 | `index.js:3138`, `3150`；`dsh-tools/README.md:129` |
| `signal` | 调用方 signal；**只有 `tools/execute` 包装器可以替换**，registry 会在 body 前重新融合 | `index.js:3139`；`README.md:105` |
| `callId` / `rootCallId` / `token` | registry 铸造 | `index.js:3134-3135`, `3143-3145`, `3613-3615` |
| `schema` | 可选的 `exec.schema` | `index.js:3151` |

两条容易踩的：

1. `dsh-tools/README.md:230` 原文：*"**`tools/pre-execute` deliberately cannot rewrite `exec.arguments`** — logged and rendered args would desync from what ran"*。闸门只能读参数，不能改。
2. `createExecution` **不校验工具是否存在**：`const visible = this.get(name, agent); const collapsed = visible !== void 0 && ...`（`index.js:3140-3141`）。所以 native 模式下**未知工具名也会跑到 pre-execute**，`UNKNOWN_TOOL` 是之后在 `dispatchToolBody` 里 `if (!tool) throw new ToolNotFoundError(exec.name)`（`index.js:3307-3308`）才产生的。PTC 模式下「模型直接调非 `run_code` 的可见工具」会在 pre-execute **之前**就短路成 ToolNotFoundError（`index.js:3176-3187`）。

### 1.4 返回值有哪些合法取值

`PreToolDecision`（`api-catalog.js:5955-5956`，原文声明）：

    export type PreToolDecision = { kind: 'allow' }
      | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
      | { kind: 'cancel' }
      | { kind: 'ask'; reason?: string;
          displayReason?: { readonly en: string; readonly [locale: string]: string } }

`ToolErrorInfo`（`7539-7540`）：`{ name: string; code: string; reason?: string }`——`deny` 时可带一个**给用户看**的结构化信息，不会进模型内容（`README.md:123`、`index.js:3242`、`3252-3255`）。

注册表如何消费（`dsh-tools/lib/index.js:3223-3266 prepareExecution`）：

    const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));            // 3225
    const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : { decision: gate, approvalCancelled: false }; // 3226-3229
    const { decision } = askResolution;
    if (decision.kind === "cancel") return await next({ kind: "post-result", result: toolAbortedBeforeDispatchResult() });        // 3236-3240
    const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;                                   // 3241
    const denialInfo  = decision.kind === "deny" ? decision.info : void 0;                                                      // 3242
    if (denialReason !== void 0) return await next({ kind: "post-result", result: this.materializeFinalResult({
        content: [{ type: "text", text: `Error: ${denialReason}` }], isError: true,
        error: { message: denialReason, ...(denialInfo === void 0 ? {} : { info: denialInfo }) } }) });                          // 3243-3257

- `{kind:'allow'}`：放行（若 `deny`/`cancel` 都不成立）。
- `{kind:'deny', reason}`：调用不派发，模型看到的是 `Error: <reason>` 的 **isError 结果**（不会终止整个回合，`README.md:123`）。
- `{kind:'cancel'}`：走「派发前取消」的规范结果 `ABORTED_BEFORE_DISPATCH`。
- `{kind:'ask', reason?, displayReason?}`：见 Q2。
- `next()`：委派给后续监听器，最终落到内置 `{kind:'allow'}`（`index.js:3225` 的第五个参数）。
- **返回 `undefined`**：waterfall 原样把 `undefined` 返回给 `index.js:3226` 的 `gate.kind`，抛 `TypeError: Cannot read properties of undefined (reading 'kind')`，被 `3273` 的 catch 变成 `toolErrorResult`，调用以错误失败（fail closed，但语义错误、日志难看）。**这是最容易犯的错：任何分支都必须 `return next()` 或返回四态之一。**

---

## 2. Q2 — 返回 ask 之后走哪条批准通道

### 2.1 通道与 toolName

`dsh-tools/lib/index.js:3439-3491 serviceAsk(exec, ask)`：

    const approval = this.ctx.get("approval");                                                                            // 3440
    if (approval === void 0) return { decision: { kind: "deny", reason: ask.reason ?? `tool ${JSON.stringify(exec.name)} requires approval (not yet supported)` }, ... }; // 3441-3447
    if (exec.agent === void 0) return { decision: { kind: "deny", reason: `tool ${JSON.stringify(exec.name)} requires approval, but the call has no agent to route it through` }, ... }; // 3448-3454
    const outcome = await approval.request({
      agent: exec.agent, toolName: exec.name, callId: exec.callId,
      ...(ask.reason !== void 0 ? { reason: ask.reason } : {}),
      ...(ask.displayReason !== void 0 ? { displayReason: ask.displayReason } : {}),
      signal: exec.signal });                                                                                              // 3455-3462
    switch (outcome) {
      case "allowed-once": return { decision: { kind: "allow" }, approvalCancelled: false };                                 // 3464-3467
      case "rejected":     return { decision: { kind: "deny", reason: `the user rejected tool ${JSON.stringify(exec.name)}` }, ... };   // 3468-3474
      case "cancelled":    return { decision: { kind: "deny", reason: `approval for tool ${JSON.stringify(exec.name)} was cancelled` }, approvalCancelled: true }; // 3475-3481
      case "unavailable":  return { decision: { kind: "deny", reason: `tool ${JSON.stringify(exec.name)} requires approval, but no approval channel is available` }, ... }; // 3482-3488
    }

结论：

- **通道**：`ctx.approval`（`@deepseek-ai/dsh-user-approval` 的 `ApprovalService`），事件 `approval/request`（waterfall）。
- **呈现给用户的 toolName 就是 `exec.name` 原文**（`3457`），即 `mcp__<serverName>__<rawName>` 这个公共名，不再加工。客户端把它塞进文案：`dsh-client-ui-approval/lib/client.js:268` `escalation: "Tool {toolName} requests privileged execution"`（中文词典在同文件的 `255-262` 一带）。
- **批准结果如何回到本次调用**：`serviceAsk` 把 outcome 一对一映射成 `allow`/`deny`，回到 `prepareExecution` 的 `3241` 继续走 guard 与派发（`allowed-once` → `{kind:'allow'}` → `3241` 之后仍会再跑一次 `guardReason`）。
- **grant 只对这一条请求有效**：`ApprovalOutcome` 词汇表见 `api-catalog.js:4463` = `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`；`dsh-user-approval/README.md:155` 原文：*"**Only one-shot grants exist** — the outcome vocabulary has `allowed-once` but no `allow-always`, remembered rule, revocation, or grant store; session policy is only `ask` / `never`."*
- 请求体**不携带工具参数**：`README.md:156` *"The request carries no tool arguments — an answerer sees the tool name, reason, and optional call id"*；类型也印证：`api-catalog.js:4476 ApprovalRequestEvent` 只有 `{ agent, toolName, callId?, reason?, displayReason?, signal? }`。

### 2.2 审计与回合前提

`dsh-user-approval/lib/index.js`：

- `128-144 request(req)`：先 `if (!hasOpenTurn(session)) throw new Error("approval.request() outside an open turn: ...")`（`130`），再 `session.append("approval/asked", { id, toolName, ... })`（`132-137`），`await this.decide(...)`（`138`），最后 `session.append("approval/decided", { id, outcome })`（`139-142`）。
- `49-56 hasOpenTurn(session)`：从 `session.seq - 1` 往回扫，遇到 `turn/start` 为真、`turn/end` 为假。
- **对闸门的含义**：工具调用必然发生在回合内，所以 pre-execute 里 ask 一般满足前提；但若审计 append 抛错，`serviceAsk` 会抛异常，被 `prepareExecution` 的 `try/catch`（`index.js:3267-3272`）吞成 `toolErrorResult`——调用失败，不会崩进程。

### 2.3 approval 政策为 never 时会怎样（fail closed？）

**是，确定性地失败关闭，而且弹窗不会出现。** `dsh-user-approval/lib/index.js:172-189 decide(req, session)`：

    if (signal?.aborted) return "cancelled";                                    // 174
    if (this.effectivePolicy(session) === "never") return "rejected";          // 175
    ... this.ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, () => Promise.resolve("unavailable")) ...   // 176

源码注释（`dsh-user-approval/lib/types/index.js:173-177`）说得很直白：*"The 'never' policy is decided HERE, before any dispatch: a listener registered with `prepend: true` after this service mounts would sit ahead of any gate LISTENER, so a listener-shaped gate cannot keep the documented promise that 'never' rejects deterministically regardless of registration order — only the service's own request path can."*

配合 `serviceAsk` 的映射，`never` 下的最终结果是 `{kind:'deny', reason:'the user rejected tool "<name>"'}` → 模型看到 `Error: the user rejected tool "mcp__xxx__yyy"`。**这条 reason 会误导人**（像是用户点了拒绝，其实是政策拒绝）；本闸门若要更准确的文案，应在发起 ask 之前自行判断政策（见 Q6），直接返回带自定义 reason 的 `deny`。

政策取值只有 `ask` / `never`（`APPROVAL_POLICIES = ["ask","never"]`，`dsh-user-approval/lib/index.js:37`；`ApprovalPolicy` 类型 `api-catalog.js:4467`）。`README.md:36` 原文：*"`ask` (the default) delegates to the composed answerers; `never` rejects every request deterministically before interactive dispatch — the strict headless stance for CI and unattended runs."*

### 2.4 谁在应答（链路全景，便于排障）

1. 服务端只做策略与派发，自己**从不弹窗**（`dsh-user-approval/README.md:32`：*"the service itself never prompts a human"*）。
2. 应答者是 `approval/request` waterfall 的监听器；`dsh-user-approval/README.md:32`：*"Agent-scoped listeners receive only that agent's requests, and a deployment composes one terminal answerer — sibling listener order is not a policy-priority mechanism."*
3. Web GUI 这条链：Host 的 `@deepseek-ai/dsh-api-remotes` 把 `approval/request` 转发到浏览器（`dsh-api-remotes/lib/index.js:23` 在 `API_REMOTE_FORWARDED_EVENTS` 里），浏览器侧 `dsh-client-ui-approval/lib/client.js:355-357` 注册 `ctx.remote.$on("approval/request", ...)` → `answerApproval(...)`（`client.js:284-310`）→ 组件 `ApprovalPanel` 注册进 `conversation.composer` 插槽（`client.js:344-354`）。
4. ACP 通道另有一份：`dsh-acp/lib/index.js:1116-1139`，选项写死 `[{optionId:'allow-once', name:'Allow once', kind:'allow_once'}, {optionId:'reject-once', name:'Reject', kind:'reject_once'}]`。
5. 没有应答者时默认 `'unavailable'` → `deny`（fail closed）。

---

## 3. Q3 — 能否按 agent 限定 / 只拦自己挂载的工具

### 3.1 拿到「这次调用属于哪个 agent」

- `exec.agent`（`ToolExecutionInput.agent`，`api-catalog.js:7552`）就是 `Agent` 对象本体；**直接做引用相等比较**，不要比 id/名字。仓库既有写法：`if (exec.agent !== this.agent) return undefined;`（`src/runtime.js:192`，读取时刻 2026-10-15T06:48:51Z）。
- 无 agent 的调用（宿主/插件直接 `ctx.tools.execute()`）该字段缺失——闸门应直接 `return next()`。参考 `dsh-repeat-tool-reminder/README.md:85`：*"Calls without an agent are ignored. A direct `ctx.tools.execute()` caller has no model to remind and no live agent object to key on."*
- 每个 agent 的会话：`exec.agent.session`（`dsh-user-approval/lib/index.js:129`、`dsh-sandbox-policy/lib/index.js:127` 都是这么取的）。

### 3.2 作用域过滤：注册在谁身上，就只看谁的调用

`dsh-tools` 派发时用的接收者是 `scopeTarget(this, exec.agent)`（`index.js:3224`）；`dsh-scope/lib/index.js:327-338 scopeTarget` 造出的 carrier 过滤规则是：

    const tag = scopeOf(ctx);
    if (tag === void 0) return true;                 // 未打标签的监听器：全局可见（329-332）
    for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) if (cursor === tag) return true;  // 333

即：

- 插件根 ctx 上注册的监听器（无 scope 标签）→ **收到所有 agent 的调用**（含 agentless）；
- 通过 `agent.ctx` 注册 → **只收到那个 agent 的调用**（`dsh-scope/README.md:42`、`api-catalog.js:4240`）；
- `{ global: true }` 可以绕过过滤（`cordis/src/events.ts:112-117`、`173`），闸门一般不需要。

### 3.3 只拦自己挂载的那些工具

三个可叠加的判据（推荐 1+2）：

1. **名字前缀**：本插件挂载的 MCP 工具公共名恒为 `mcp__<serverName>__<rawName>`，见 `@deepseek-ai/dsh-mcp-client/lib/index.js:96-102 publicToolName`（*"the clean case is `mcp__<serverName>__<rawName>` verbatim"*）。超长或出现非法字符时会截断并追加 12 位哈希（`98-101`），但**前缀 `mcp__<serverName>__` 一定保留**（`serverName` 受 `SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/` 约束，`index.js:767`），所以 `exec.name.startsWith('mcp__' + serverName + '__')` 是可靠的。仓库里已有同样的前缀：`src/runtime.js:434` `const prefix = `mcp__${spec.config.serverName}__`;`，过滤用法在 `src/runtime.js:193-194`；本插件自己的 `src/normalize.js:161-162` 也是同一规则。
2. **注册作用域身份校验**（区分「我挂的」与「恰好同名前缀的全局工具」，仓库注释 `src/runtime.js:182-184` 明确了这个意图）：`owner.tools.get(exec.name, this.agent) === owner.tools.get(exec.name)` 表示该名字在 agent 自己的层里解析，即「是我 scoped 注册的」，而不是继承来的全局工具（`src/runtime.js:195`；`tools.get(name, scope)` 语义见 `api-catalog.js:3226-3229`，同层语义的权威描述在 `dsh-tools/lib/types/index.js:561-605 view()`）。
3. **agent 限定**：`exec.agent === this.agent`（`src/runtime.js:192`）。

**PTC 子调用别忘了**：`run_code` 程序里的 `tools.mcp__x__y(...)` 是真调用，`exec.parent !== void 0` 且 `exec.agent` 仍是发起 agent。`dsh-experimental-auto-review/lib/index.js:464` 的写法只排除外层传输工具：

    if (agent === void 0 || exec.parent === void 0 && exec.name === RUN_CODE_NAME) return next();

（`RUN_CODE_NAME = "run_code"`，`dsh-tools/lib/index.js:898`）——即「agentless 或（非子调用且名字是 run_code）」才跳过。本闸门要拦 MCP 工具，**不要**用 `exec.parent !== undefined` 一票跳过，否则 PTC 模式下半数调用漏网。

---

## 4. Q4 — 与既有 guard 的关系、顺序与优先级

### 4.1 guard 是什么

- 注册：`ctx.tools.guard(guard)`，签名 `guard(guard: ToolGuard): () => void`（`api-catalog.js:3220-3224`；实现 `dsh-tools/lib/index.js:2921-2926`）。
- 类型：`ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined`（`api-catalog.js:7576`）。**同步**、**只能拒绝**：返回字符串 = 拒绝理由；返回 `undefined` = 放行。
- 语义（`dsh-tools/README.md:85` 原文）：*"`ctx.tools.guard(guard)` registers a monotonic synchronous guard **after** the extensible `tools/pre-execute` waterfall: a returned reason denies the call, and **no later listener can turn that denial back into permission**."* —— guard 是「单调」的：不可被翻转成允许，但它自己也**不能发问**。
- 作用域：*"A plain-context guard applies globally; one registered through `agent.ctx` applies only to that agent."*（`index.js:2912-2915`；实现走 `this.layers.effect(this.ctx, ...)`，即按注册它的 ctx 决定层）。
- 求值顺序：全局层先，然后 agent scope 链由远及近（`index.js:2927-2936 guardReason`）。

### 4.2 同时注册 guard 和 pre-execute 的顺序与优先级

流水线顺序（`dsh-tools/README.md:105` 原文）：*"Every call runs a fixed pipeline: `tools/pre-execute` (extensible allow/deny/ask) → registered monotonic guards → `tools/execute` → `tools/post-execute` → `finalizeContent` → `tools/result`."*

代码层面的关键事实（`dsh-tools/lib/index.js:3225-3243`）：

- pre-execute 先跑（`3225`）；
- **只有 pre-execute 的结论是 `allow` 时才去问 guard**：`decision.kind === "allow" ? this.guardReason(exec) : decision.reason`（`3241`）；
- 因此 pre-execute 的 `deny`/`cancel` 会**直接压过** guard（guard 根本不被执行）；
- 反过来：`ask` 被用户批准（→ `allow`）之后，**guard 仍会再跑一次**，仍可拒绝——即**用户批准不能突破 guard**；
- 两者的拒绝都被物化成同一形状：`content: [{type:'text', text: 'Error: <reason>'}]`、`isError: true`（`3243-3257`）；guard 的典型 reason 是 `'Tool disabled by workspace MCP declaration'`（`src/runtime.js:196`）。

结论：**guard 继续当「同步 deny-only 的硬约束」用，pre-execute 当「需要问人的软闸门」用**，二者不冲突；但若要求「用户批准后一定能跑」，就不能让 guard 覆盖同一工具（否则批准后仍会被 guard 砍掉）。`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:10` 的选型建议原文：*"From weakest to strongest: `ctx.tools.restrict()` can only remove tools; `ctx.tools.guard()` can only deny; waterfall listeners can rewrite and depend on registration order; ..."*；同文件 `:17` 原文：*"A denial that must hold regardless of order is a `ctx.tools.guard()`; a guard is synchronous, so a decision that must await something, such as asking the user, returns `ask` from `tools/pre-execute`."*

---

## 5. Q5 — 性能与批准结果缓存

### 5.1 pre-execute 是不是每个工具调用都跑

是。`prepareExecution`（`dsh-tools/lib/index.js:3214-3225`）是每条执行记录的必经阶段，覆盖：

- native 模型直调、PTC 内层子调用（`exec.parent` 有值）、以及**不存在的工具名**（`createExecution` 3140-3141 不校验存在性，见 Q1.3）；
- **例外**（`index.js:3176-3187`）：PTC 模式下，模型**直接**调用非 `run_code` 的可见工具时 `collapsed` 为真，会在 pre-execute **之前**直接返回「只能从 run_code 内部调用」的 ToolNotFoundError。

开销：每条调用一次 waterfall 派发 + 一次 `hook.global || !filter || filter.call(...)` 过滤（`cordis/src/events.ts:165-174`）。只要监听器在「不是我的工具」时立刻 `return next()`，成本约为一次前缀比较 + 一次函数调用，可忽略。真正需要小心的是**监听器里 await 的东西**：`ask()` 会阻塞本回合直到用户作答或取消，这是设计意图，但不要在里面做文件 IO、网络请求或重活。

### 5.2 ask 的批准结果能缓存吗

**框架层没有任何缓存或记忆机制，必须插件自己记。** 依据：

- `dsh-user-approval/README.md:155`（已在 Q2.1 引用）：只有 `allowed-once`，没有 allow-always / 记忆规则 / 撤销 / grant store。
- 审批请求带不了参数（`README.md:156`），宿主每次 ask 都会**成对写日志** `approval/asked` + `approval/decided`（`dsh-user-approval/lib/index.js:132-142`），所以重复 ask 还会持续污染会话日志。
- 插件自记的定位：`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:7` 原文 *"The session log is the only source of truth. ... **Plugin memory is a derived cache.**"*；另一份先例把代价讲清楚了（`dsh-repeat-tool-reminder/README.md:87`）：*"**In-memory only.** A session resumed from persistence starts with a fresh chain — the guard is a heuristic nudge, not a logged invariant, so reminders after a resume are the accepted cost."*
- **推荐**：内存里按 `(agent, toolName)`（或 `agent.session.id` + toolName）记一个「本会话已放行」集合，命中就直接 `next()`；同时把「记住」的意图落到配置（`workspaceAllowances[].allowTools`）里，让它成为可恢复、可审计的事实。配置写入路径见 §9.4。

---

## 6. Q6 — 从插件侧判断当前策略（完全权限 / never）

三条可用通道，按可靠度排序。

### 6.1 sandbox 模式（公开契约，推荐）

`ctx.sandboxPolicy`（`@deepseek-ai/dsh-sandbox-policy`）：

- `api-catalog.js:1765-1791`：`defaultMode: SandboxMode`（`1770`）、`workspaceRoot: string`（`1775`）、`resolve(request?: SandboxPolicyRequest = {}): SandboxExecutionPolicy`（`1780`）、`overrideOf(session): SandboxMode | undefined`（`1786`）。
- `SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'`（`api-catalog.js:6211`）；`SandboxExecutionPolicy = { mode; workspaceRoot; sessionId? }`（`6207`）。
- 实现：`dsh-sandbox-policy/lib/index.js:141-148 resolve()`，优先级 `request.mode ?? overrideOf(session) ?? defaultMode`；`154-156 overrideOf` 读 `sessionProjections.stateOf(session,'sandboxMode')`。

用法：`ctx.sandboxPolicy.resolve({ session: exec.agent.session }).mode === 'danger-full-access'`。

### 6.2 批准政策（半公开，注意 fallback）

- 公开：`ctx.approval.overrideOf(session): ApprovalPolicy | undefined`（`api-catalog.js:337-341`）——**只读会话内覆盖，不含部署默认**（实现 `dsh-user-approval/lib/index.js:160-165`：从日志倒扫 `approval/policy`）。
- 只写 `overrideOf` 会漏掉「部署配置默认就是 never、会话没有覆盖事件」的情形。
- 补充手段（**运行时存在但未进 API 目录**，见 §11）：
  - `ctx.approval.effectivePolicy(session)`（`dsh-user-approval/lib/index.js:152-154`，`= overrideOf(session) ?? config.policy ?? 'ask'`）；官方先例 `dsh-experimental-auto-review` 没用它，而是用 `ctx.approval.overrideOf(agent.session) === "never"`（`lib/index.js:480`）判定「denial 是终局的」。
  - 服务实例上的 `config.policy`（类字段 `config;` + 构造赋值，`dsh-user-approval/lib/index.js:73-77`）。
- 建议写成防御式：

      const approval = ctx.get('approval');
      const policy = approval === undefined ? undefined
        : typeof approval.effectivePolicy === 'function' ? approval.effectivePolicy(session)
        : approval.overrideOf(session) ?? approval.config?.policy ?? 'ask';

### 6.3 权限预设（可选，语义上最贴合「完全权限」）

`ctx.permissionPresets`（`api-catalog.js:1502-1543`）：

- `current(session: Session): string`（`1519-1522`）——返回当前生效的预设名，未匹配任何预设时返回 `'custom'`；Auto 也会匹配 `never`。
- 出厂预设表（`dsh-permission-presets/README.md:47-50`）：`presets` 默认 `workspace-write`, `danger-full-access`；`README.md:34-45` 的配置示例正是本项目需求里的那一档：

      presets:
        workspace-write:    { sandbox: workspace-write,    approval: ask }
        danger-full-access: { sandbox: danger-full-access, approval: never }

  所以 `ctx.permissionPresets.current(session) === 'danger-full-access'` 在本机出厂配置下等价于「完全权限 + never」。**但预设名可被部署改写**，只适合当辅助判据（或用来做 UI 文案）。

### 6.4 本机现状（旁证）

当前 GUI 会话的运行时上下文明写 `Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.`（模板见 `dsh-sandbox-policy/lib/index.js:76`）与 `Approval prompts are disabled in this session: actions that require approval are rejected automatically ...`（模板 `dsh-user-approval/lib/index.js:39`），即本机就是 `danger-full-access` + `never`。桌面 profile 也确实把本插件作为 `workspace-mcp-glue` 行加载（`C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml`，`trustMode: ask`）。

---

<!--PART3-->