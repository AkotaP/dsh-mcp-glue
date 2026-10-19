# 管理界面

插件有两个界面座位：

1. **输入框工具行的 MCP 控件**（`conversation.input.left`）——当前会话工作区的连接状态与手动连接；
2. **插件详情页的预设管理**（`plugins.bundle.config`，按包名 `dsh-mcp-glue` keyed）——在「设置 → 插件 → dsh-mcp-glue」那一页直接维护声明预设。

两个座位都由客户端半以包名注册 `ctx.locale` 词典（`{ zh, en }` 两列、键集相同），注册项上带 `locale: NS`；`apply` 用 `ctx.effect` 注册词典、用 `locale.bind(NS)` 取得翻译函数，语言切换后已渲染的座位文案随之更新。拿不到 locale 服务时回落到中文列，离线渲染与测试因此保持中文。

## 一、MCP 控件（输入框工具行）

- 座位：`conversation.input.left`（list 槽，会话作用域），注册项 `id: workspace-mcp`、`order: 40`，紧邻 `+` 按钮与权限胶囊。
- 样式**全部自绘，但不加载任何 Harness 客户端包**：DSH 的插件写作约定明确禁止 `require('@deepseek-ai/dsh-client-ui-primitives')` 一类的导入——这类模块随时会变、纯 JS 插件没有类型检查，一次抛错就会让整个座位变空白（控制台只留 `slot entry crashed`）。因此 chip、状态点、面板与按钮都是本插件自己的 `.wmcp-*` 元素，**照抄宿主原语的几何与交互**（ghost 按钮的 `--dsw-radius-sm`/hover 底色、状态点的 6px 圆点、菜单材质的 `--dsw-menu-surface-fill` + `--dsw-menu-backdrop-filter`），共享面只有 `--dsw-alias-*` token：token 改名最多是外观退化，不会让渲染直接失败。
- 未展开时是一枚 chip：`● MCP 已连接数/声明数`（无声明时只显示 `MCP`）。**点的颜色跟随面板里的行，按严重级取最高**（`chipSummary`，[src/client.js](../src/client.js)）：
  1. 控制通道请求失败 → 红（此时一行数据都没有）；
  2. 否则面板里只要有**红**行（`failed` 启动失败 / `invalid` 声明非法）→ 红；
  3. 否则只要有**黄 / 琥珀色**行（`unauthorized` 没有任何一层授权它 / `unloaded` 未连接 / `reconnecting` 退避重连）→ 黄；
  4. 只有**所有行都是绿**（`connected`）→ 绿；
  5. 其余保持中性**灰**：没有声明、还没读到、或行处于中间态（如挂载瞬间的 `pending`）。
  红色表示"这一代有问题"，只有第 1 条是"控制通道本身不可达"。
- **读取方式：长轮询为主**。每个会话的管理视图有一个**修订号**（`WorkspaceMcpSession.statusVersion`），只有在声明代次、加载代次、手动选择、授权、`required` 失败、或某台的状态/工具数**真的变了**时才 +1（`publish()`，签名比较不碰文件系统）。页面把它带进 `GET /wait`：已经落后就立刻返回，否则宿主**把请求挂住**（最长 25 秒），所以空闲时零请求、有变化时延迟只有一个来回。拿到返回后页面立刻读一次 `/status` 取具体数据，再挂下一次；调用方断开（切会话、离开页面）会 abort 请求并立即释放挂起。
- **降级与兜底**：宿主尚未重启、还没有 `wait` 动作时（404），读取器自动降级为定时轮询，节奏仍由面板内容驱动——面板打开、工作区刚切换后的 30 秒内、或上一次读取发现任何一行变了（`statusSignature` 比较行的 id、状态、工具、错误与 reconnect 元数据，加 workspace/trust/monitoring）→ 1 秒，关闭且确实无变化 → 5 秒。轮询一律不带 `refresh=1`（重读声明只由"重新读取"按钮触发）。
- **失败与过渡态**：读取失败按 1s→2s→4s→8s→15s 退避重试，成功即回正常节奏，所以短暂的红灯最多存在一秒；会话刚建立、宿主还没注册该 agent 时 `/status` 返回 `SESSION_NOT_READY`，这是过渡态——chip 保持中性而不是闪红。
- 展开后是一个气泡面板：
  - 标题行：`工作区 MCP` + 当前工作区路径 + **＋新建 / 管理**，新建不再经过编辑列表或预设选择页；
  - 每台服务器一行：状态点、可点名称、状态标签、**工具（N）▾** 整块展开按钮、`连接`/`断开` 与 `⋯`（直达编辑、复制、删除）。工具按钮带边框，至少 32px 高；不再需要瞄准一个很小的箭头。逐台自动连接开关放在管理弹窗的「连接策略与权限」中；
  - 展开某一行会列出它**已经发现**的工具（`mcp__<server>__<tool>`，正是 `allowTools` 存的字符串），每个工具一个**免批准开关**（写 `workspaceAllowances[].allowTools`）；这个开关和工具调用闸门读的是同一份名单——关掉它，那个工具下次调用就会弹出一张三选一卡片；被**项目自己的** `includeTools`/`excludeTools` 禁掉的那些工具不显示开关，只标「项目已禁用」，因为那个禁制由 `tools.guard` 在闸门之后执行、本地面板无法覆盖；没挂载的服务器报告不了工具，所以展开时显示「连接后可管理工具」；
  - 底部的「恢复自动」按钮只在 `selectionMode === 'custom'`（用户手动挑过）时出现，点它丢弃手动选择、回到完全按策略判定；
  - **管理使用独立居中大弹窗**：通过 React portal 挂在 body，避免输入框容器裁切。桌面左右布局（服务器列表 / 表单），窄屏上下布局；进入表单不隐藏列表。新建、编辑、复制都在右侧完成。`command`/`cwd`/`url` 单行，`args` 每行一个参数，`env`/`headers` 默认键值行并遮掩值，可切换 JSON。关闭、切服务器和重新读取均保护未保存草稿；Escape、Tab 焦点约束、关闭后焦点恢复均由弹窗处理。保存钉住打开时的**版本令牌**，409 后保留草稿，不自动拿最新版本重试覆盖。
  - **连接方式选择器在前**：HTTP 只显示 `url` / `headers`；stdio 只显示 `command` / `args` / `env` / `cwd`。标准方言的连接方式可写入文件；Codex / Gemini 的选择器只筛选 UI，不提交额外字段。切换方式自动删除旧方式的字段，隐藏草稿不会参与校验；已有条目也可补填缺失的字段。清空已有值 = 提交 `null` = 从声明里**删掉对应键**。
  - **新建服务器**直接显示表单，「配置位置」是表单中的下拉框，切换位置保留已输入的字段；默认选择工作区上次使用的可写位置，其次项目配置。**复制到其它预设**同样直接预填表单，可勾「复制后删除原条目」。普通保存不新增授权，「保存并连接」明确请求当前会话连接。
  - **TOML 现有文件也可编辑**。表单常驻提示整个文件的注释与排版可能丢失，实际保存 / 删除 / 向现有文件追加 / 迁移删除源前还需明确确认；请求须携带严格布尔值 `allowLossy: true`，后端未收到则返回 `DECLARATION_CONFIRM_REQUIRED` 且不落盘。新建不存在的 TOML 文件无需重写确认。
  - 同名并存会被宿主以 `DECLARATION_CONFLICT` 拒绝（两个声明文件里同名会让加载器按冲突策略把它们都禁用）——它只能靠**改名**或**迁移**解决，所以覆盖确认框不会为它出现；`DECLARATION_EXISTS`（目标文件里已有同名）才是那个可以覆盖的拒绝。
  - 底部：`重新读取`、`恢复自动`（条件出现）、`连接全部`/`全部断开`、`关闭`。
- 状态读取以长轮询为主；降级时使用上述 1 秒 / 5 秒节奏。点击 `重新读取` 才重新解析声明文件；有未保存草稿时先确认。
- 每行的状态与颜色（`buildStatus`，[src/status.js](<../src/status.js>)）：`connected` 绿=已连接（显示工具数）；`unauthorized` 黄=有声明但未授权；`unloaded` 黄=该台被手动断开或尚未挂载；`pending` 灰=首次 / 手动连接中；`reconnecting` 琥珀色=退避等待或自动重连中；`failed` 红=连接失败或重试暂停（`error` 是有界错误码）；`invalid` 红=声明本身非法（诊断行，`连接` 按钮禁用）。详见[自动重连](<#auto-reconnect>)。
- `dsh.client.inject` 声明两个座位的主人（`@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-plugin-manager`）。它只排激活顺序，不作为渲染时序保证：座位是否就绪仍由 `ctx.slots.inject` 等待。

想换位置或顺序，改 `src/client.js` 里 `ctx.slots.inject('conversation.input.left', ...)` 的槽名与 `order` 即可（同级的可用座位还有 `conversation.input.right`、`conversation.input.activity`）。改完执行 `pnpm run build`。

## 二、预设管理（插件详情页）

座位 `plugins.bundle.config`，key = 包名 `dsh-mcp-glue`；宿主在渲染该 bundle 的详情页时按这个 key 派发，并以 `view: 'page'` 渲染（该座位只有 page 视图；本组件仍对 `view: 'summary'` 退化成一行摘要，且不读控制通道）。这一页是**插件自己的页面**，宿主不给 `form`，读写由插件自己负责——这正是它相比「在设置里另开一节」更贴近当前 DSH 的写法。

- **内置预设**：五行（`root`/`vscode`/`codex`/`cursor`/`gemini`）各一个勾选框，勾选即进入 `enabledBuiltins`，顺序即加载顺序；同时显示各自的文件位置、服务器表路径、格式与方言。
- **自定义预设**：卡片式编辑 `id`、`files`（每行一个）、`serversPaths`（每行一个，点路径或 `/JSON/Pointer`）、`format`、`dialect`、`interpolation`、`extends`、`fields`（规范字段名 → 声明字段路径的 JSON）。可增删。
- **保存**：先在前端做结构校验（id 非空且唯一、文件与服务器表路径非空、`fields` 是字符串到字符串的对象），再交给宿主用**与加载器同一个解析器**复验——所以永远写不进会让插件激活失败的配置。
- **只写可编辑字段**：`enabledBuiltins`、`presets`、`trustMode`、`trustedWorkspaces`、`conflictPolicy`。`inputValues`（含 `secret` 角色）与各种上限**不会**在浏览器与宿主之间往返，避免把密钥回写或泄漏到页面。
- 写入走 `settings.update(ns, patch, revision)`，带 revision CAS：并发修改会报 `SETTINGS_CONFLICT`，控制路由把它转成 HTTP 409，页面提示而不是覆盖别人的改动。
- **为什么这些字段必须是 `.volatile()`**：0.2.0-rc.2 的 `ctx.settings` 就是「Loader 条目的可编辑 Config」，而 `describe()` 只收录 `volatileForm(schema)` 非空的条目——没有 volatile 字段的条目会被整条丢掉，于是查不到描述符、`editable` 为 false、保存直接报「无法写入」。加 `.volatile()` 之后：`describe()` 以**行 id** 收录本条目；写入经 `configEditor.edit` 落进 profile patch（`cordis.patch.yml` 里那一行的 `config`），由 Loader 应用；Cordis 把 volatile 字段解析成**就地更新的引用**，所以保存生效**不需要重挂插件**（普通字段则要走常规 Loader 生命周期，因此上限、`webControl`、`enabled` 刻意保持非 volatile）。
- 引用由 `liveConfig()` 拆包：`apply` 拿到的 `enabledBuiltins`/`presets`/`trustMode`/`trustedWorkspaces`/`workspaceAllowances`/`conflictPolicy` 是引用对象而不是值，直接读会得到对象（`resolvePresets` 会因此报错）。入口把它投影成取值时才展开的视图，运行时的每次读取、状态接口与保存校验读到的都是当前值。
- 条目定位：插件用**包名**（Loader 行的模块名 `dsh-mcp-glue`）在自己的条目里查——不是 Cordis 的 `name` 导出（那是 `workspace-mcp-glue`）。自检脚本会校验这两处与 `package.json` 的 `name` 一致，防止漂移。
- **页面结构**：顶部是标题 + 一行元信息（`条目 <row id> · 保存后立即生效/需要重启`，不可写时显示原因）；下面三张卡片——**内置预设**（带 `已启用/总数` 计数与勾选高亮）、**自定义预设**（计数 + 卡片式编辑）、**信任**；底部一条操作栏，左边是保存状态、右边是 `重新读取` + `保存`。
- **信任区（同一页）**：`trustMode` 两个并排的选项卡片（`manual` / `all`，`all` 用红色边框和红字标出风险）+ 一个多行文本框维护 `trustedWorkspaces`（每行一个绝对路径，宿主按规范化身份精确匹配目录本身），标题旁显示已信任目录数。第三层 `workspaceAllowances`（按工作区的例外：只自动连接这些服务器 / 只免批准这些工具）**主要由 chip 面板里的开关写入**，这一页不提供手改 UI。两者都在可写白名单（`EDITABLE`）里且标了 `.volatile()`，所以**保存后立即生效、不需要重启**；写入走同一条 `POST /config`。对照：`maxServers` / `startupTimeoutMs` / `webControl` / `inputValues` 不是 volatile，改了要重启。
- **chip 面板的「始终信任此工作区」是一个开关（toggle）**，和上面那节做的是同一件事的快捷版：打开 = 把当前工作区加入 `trustedWorkspaces` 并立即连接；**关掉 = 从列表里移除并断开当前连接**（信任和连接一起走，不会留下"已取消信任但还在跑"的中间态）。它是一个真正的 `role="switch"` + `aria-checked` 控件（`TrustSwitch`），所以两个方向都能操作；`trustMode: all` 覆盖时它显示为禁用并提示去插件页改。它放在 chip 面板而不是插件页，是因为插件页是**全局页面、没有会话上下文**，拿不到「当前工作区」；开关状态读的是 profile 里的 `trustedWorkspaces`（面板打开时读一次），不是"当前是否受信任"。
- **为什么插件从不主动弹批准框**：早期版本会在首次模型请求的组装阶段走 DSH approval 请求批准。但 DSH 的批准政策为 `never`（danger-full-access 模式）时，它的语义是"需要批准的操作被**自动拒绝**"，那条路只会失败或打扰；而且批准只能按"会话 + 声明指纹"记在内存里，每个新会话都要重来。现在授权完全由界面上的一次点击产生（面板的 `连接`、每行的自动连接开关、底部的始终信任开关），加载路径上不再使用批准通道。

## 三、连接与授权的语义

一个服务器是否**自动加载**由三层策略决定（详见 README 的「信任与执行」）：`trustMode: all` → 所在目录在 `trustedWorkspaces` → 工作区的 `allowMcp` 里有它。**三层都不命中就保持未加载，插件不代用户询问**。

- `连接` = **显式用户同意**：把选择钉成手动模式（`selectionMode: 'custom'`）并立即加载这一台（或全部）。它不写配置，只影响当前会话。
- `断开` 是**粘性**的：即使声明文件之后变化，被用户关掉的服务器也不会自己回来。手动选择不持久化——重启或换会话后又回到策略判定。
- `恢复自动`（`POST /follow`）= 丢掉手动选择，回到完全按三层策略判定。
- `允许一个工具`（展开行里的工具开关）= 把 `mcp__<server>__<tool>` 写进 `allowTools`；它与连接无关，只影响工具调用是否需要放行。
- 一次「连接」在**下一条消息**生效：工具集在每次模型请求组装时确定，正在进行的回合不会中途换工具。
- 逐台切换、单台失败恢复与正常声明更新都按**每台服务器的 spec / 来源差异**协调：只卸载移除、改动或明确重试的失败服务器，保留未变化的健康同伴及其子 fiber，不再整组重启。

<a id="auto-reconnect"></a>

## 自动重连（Auto reconnect）

- **范围与授权**：只有本插件挂载、当前 `selected` 且策略仍 `autoAllowed` 的服务器可自动重试，还须通过原生版本与接口验证。`selectionMode: custom` 本身不禁用重连；手动选中的服务器只要策略仍允许就有资格。策略未允许的手动连接是 single-shot，失败后须用户再次连接。`断开 / 停止连接` 取消重试与进行中的初始化，粘性选择不会被后台任务或声明变化推翻；取消自动连接授权也会撤销重试资格。
- **兼容边界**：通过宿主 Cordis loader 获取同一原生模块实例，并通过该 loader 的元数据导入读取版本（可用时使用 `loader.internal.import` 的 JSON 属性）。只有恰为 `0.2.0-rc.2` 且接口形状匹配才启用监控；其他版本或元数据 / 接口不可验证均为 `monitoring: 'unsupported'`，宿主警告且面板明确提示「增强重连与断线监控不可用」。此时回退原生连接，不冒用已验证适配器或承诺增强重连。已验证模式关闭原生自身的 reconnect，由插件统一监督，避免两套重试叠加。
- **退避**：基准间隔为 **1、2、4、8、16、30、60 秒**，每次乘 **0.8～1** 的随机抖动；没有总尝试上限，后续始终用 60 秒档（实际 48～60 秒）。短暂接通不重置次数：连接至少稳定 **30 秒**后再次失败才从首档开始。模型请求不会跳过已有退避或重新启动失败记录；用户「立即重试」是显式单台重试入口，不重启健康同伴。首次启动与后台恢复共享每会话最多 6 个连接名额；后台初始化不占模型请求队列，可选 MCP 握手缓慢不会阻塞正常对话，等待名额的任务也可立即取消。
- **状态与操作**：`reconnecting` 为琥珀色，既包括等待重试也包括自动初始化中。行携带 `reconnect: { eligible, attempt, nextRetryAt, reason }`；有 `nextRetryAt` 时客户端每秒**本地**更新倒计时与次数，不为倒计时额外读状态或请求 MCP。`pending / reconnecting` 提供「停止连接」，`pending / reconnecting / failed` 提供「立即重试」（处理中或 `CLOSE_UNCONFIRMED` 时禁用）。失败行仍显示有界错误码，chip 仍按红 > 黄 > 中性 / 全绿取色。
- **required 故障**：已选 `required` 服务器启动失败或断线时，模型请求持续拒绝，直到它恢复；不会因重试请求而绕过退避，也不会卸载健康同伴。未授权且未选中的服务器不是 outage。非法 `required` 声明仍按原有 fail-closed 校验拒绝，不等同于单台运行时断线。
- **暂停与安全锁**：非法声明不进入重试；永久鉴权问题（如 401 / 403）与永久启动错误（如 `ENOENT / EACCES / EPERM`）暂停，修复后显式重试 / 安全协调。一般启动错误、网络故障、启动超时等瞬时错误仍自动退避。若无法确认旧进程 / transport 关闭，记为 `CLOSE_UNCONFIRMED`，当前会话对该服务器名停止一切重连，**手动连接也不能绕过**；必须换会话或实际重启宿主，不能仅点「立即重试」。
- **声明更新边界**：每次后台重试重读声明和授权；目标条目消失或发生变化时停止并报 `DECLARATION_CHANGED`，不在后台直接启动新声明。等下一次安全的模型组装 / 编辑协调，再按逐服务器差异应用，未变化的健康连接保留。
- **不做什么**：不自动重放失败的工具 / 资源请求、不发空闲 MCP 心跳、不替 UnityEditor 启动或打开服务器。断线由已验证原生生命周期信号或有类型的请求错误识别，普通工具业务错误、取消与单纯调用超时不当成断线。HTTP 会话 404 经有类型的调用错误识别为 `SESSION_EXPIRED` 后，退避建立新连接并重新 initialize；原调用仍失败，不重放。

## 数据通道

| 项 | 说明 |
|---|---|
| 路由 | 前缀 `/workspace-mcp`，由宿主半通过 `ctx.webServer.register` 注册 |
| 读状态 | `GET /workspace-mcp/status?sessionId=<id>&refresh=1` |
| 等变化（长轮询） | `GET /workspace-mcp/wait?sessionId=<id>&version=<n>`——**挂起**到该会话的管理视图越过 `version`，或 25 秒超时；返回 `{ version }`，调用方断开会立即释放 |
| 手动连接 | `POST /workspace-mcp/connect`，body `{ sessionId, serverId? }` |
| 手动断开 | `POST /workspace-mcp/disconnect`，body `{ sessionId, serverId? }` |
| 恢复自动 | `POST /workspace-mcp/follow`，body `{ sessionId }`——丢掉手动选择，回到按策略判定 |
| 读配置 | `GET /workspace-mcp/config` |
| 写配置 | `POST /workspace-mcp/config`，body `{ patch: { enabledBuiltins?, presets?, ... } }` |
| 取令牌 | `GET /workspace-mcp/handshake`（唯一不要求令牌的动作） |
| 认证 | 仅回环地址 + **每进程一个**令牌（请求头 `x-workspace-mcp-token`） |
| 令牌下发 | ① `webServer.tapIndex` 注入 index.html；② 页面自己 `handshake` 兜底 |
| 响应 | `application/json`、`cache-control: no-store`；请求体上限 4 KiB |
| 状态码 | 403 围栏拒绝；404 未知动作；405 方法不对；409 设置 revision 冲突；413 请求体过大；415 请求体不是 JSON；其余 400 |

错误信封：`{ error, code?, reason? }`，`code` 来自宿主（如 `SETTINGS_CONFLICT`、`SETTINGS_UNAVAILABLE`），`reason` 是「为什么这里不可写」的人类可读说明（仅在拿不到设置表单时出现）。

**令牌为什么要两路下发**：页面可能在插件激活**之前**就被渲染，那样 index.html 里没有内联令牌——实测就是这个状态（面板报 `stale workspace MCP token`）。所以客户端先读内联值，读不到就 `handshake` 取一次并记住；请求若被 403 拒绝，会丢弃缓存、重新握手并**重试一次**。令牌改为**每进程一个**后，插件热重载也不会再让已打开的页面失效。

**为什么握手是安全的**：握手只对回环 + 同源请求开放（校验 `Sec-Fetch-Site` / `Origin` 与 `Host` 一致），响应不带任何 CORS 头——别的网页读不到它，也就拿不到令牌、驱动不了"连接"这个会执行本地程序的动作；本机进程本来就能执行任意程序，这条通道没让它们多出任何权限。响应体里**只有**声明文件名、服务器名、传输方式、可执行程序名、子进程 cwd、远端 scheme+host、环境变量名与凭证引用名——**没有**参数值、URL 路径/查询串、环境变量值或 `${input:...}` 的展开值（预设里可能有 `${env:...}` 这类**引用名**，引用不等于值）。手动连接与配置写入都会写一条宿主警告日志，便于审计。

配置 `webControl: false` 可以完全不注册该路由与令牌注入（界面会停在无法读取状态）；此时插件依旧按信任/批准策略自动加载。

## 生效与调试

本轮已通过**197 项离线回归、后端自检与客户端构建**，尚未完成重启后运行中宿主、控制路由与 GUI 的部署验证。全量测试曾在系统临时目录遇到 Windows `ReplaceFileW / Win32 1175 / EIO`；将测试进程的 `TEMP / TMP` 指向工作区专用临时目录，并执行 `node --test --test-concurrency=1 test/*.test.js` 后 197/197 通过。未修改系统环境、声明编辑器或宿主文件系统实现，也未绕过版本守卫。下面是生效条件与调试方法，不代表本轮已完成现场验证。

- **客户端半**：`lib/client.js` 是仓库里的构建产物（`pnpm run build` 从 `src/client.js` 生成）。先构建，再确认当前宿主实际加载了更新的 bundle。自动热替换还依赖同一宿主 checkout 的 `pnpm run dev:web` 构建监听；没有核实监听运行时，不应承诺免刷新自动生效。
- **宿主半**：新增/修改 `src/*.js` 后，运行中的进程仍持有 activation 时 import 的模块。切插件条目只会重跑 `apply`，**不会重新 import 模块**；要让新的宿主代码生效需要重启 Harness（本机实测：`set_plugin` 反复启停后新路由仍未注册，符合该结论）。**例外是插件自己的设置**：volatile 字段由 Cordis 就地更新引用，保存后立刻生效，不需要重挂条目、也不需要重启。
- **服务获取必须走注入**：Cordis 的惰性 `ctx.get(name)` 只沿注入链查找，同级 row 提供的服务（`webServer`、`settings`）拿不到——实测插件里 `ctx.get('webServer')` 返回 `undefined`，界面就停在 `HTTP 404`。因此入口文件对所有可选服务都用 `ctx.inject([...], cb)`，并把 `loader`（本插件的原生桥接来源）也改成注入优先。判断链路是否在线：`GET /workspace-mcp/status?sessionId=x` 返回 403 说明路由已注册（缺令牌），404 说明路由未注册（或落在 SPA fallback 上）。

## 已知限制

- 面板只反映**当前会话工作区**的声明；切换会话后重新读取。
- 桌面 Electron 载体若以 `file://` 加载页面，同源相对路径语义由外壳的 fetch 桥决定；本机 web 载体（`http://127.0.0.1:<port>`）实测可用（同 profile 的 `dsh-chime` 也用同源路由）。
- 面板不显示 MCP 资源列表与服务器指令正文（那些属于会话上下文，不通过该通道下发）。
