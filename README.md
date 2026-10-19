# dsh-mcp-glue

[English](README.en.md) | 中文

为 **DeepSeek Harness 0.2.0-rc.2** 加载项目级 MCP 声明。一个工作区的会话只读取自己的配置，并在各自 Agent 作用域内连接服务器；不会把配置写入 DSH 全局 profile，也不会修改原声明文件。

## 内置预设

| ID | 工作区相对位置 | 服务器表 | 格式 |
|---|---|---|---|
| `root` | `.mcp.json` | `mcpServers` 或 `servers`，不能同时存在 | JSONC |
| `vscode` | `.vscode/mcp.json` | `servers` | JSONC |
| `codex` | `.codex/config.toml` | `mcp_servers` | TOML |
| `cursor` | `.cursor/mcp.json` | `mcpServers` | JSONC |
| `gemini` | `.gemini/settings.json` | `mcpServers` | JSONC |

新的 VS Code portable 配置也通过 `root` 预设加载。预设只是 Host 配置中的数据，不执行项目脚本或转换函数。

## 管理界面

两个界面：

- **输入框工具行左侧的 MCP 控件**：显示**当前会话工作区**的声明与连接状态（`● MCP 已连接/声明`），点开可逐台 `连接`/`断开`、`重新读取` 声明、`连接全部`/`全部断开`。手动连接等于对该会话 + 该声明指纹的显式授权；`断开` 是粘性的，声明变化后也不会自动重连。
- **插件详情页的预设管理**（设置 → 插件 → dsh-mcp-glue）：勾选内置预设、增删自定义预设（文件位置、格式、服务器表路径、方言、插值、字段映射）。保存时前后端都用同一个解析器校验，只写可编辑字段，带 revision CAS（冲突回 409）。这一页是**插件自己的页面**（`plugins.bundle.config`，按包名 keyed），不是另开的设置节。

两个座位的文案都以包名为命名空间注册进 `ctx.locale` 的中英词典，随 GUI 语言切换；没有 locale 服务时使用中文列。

详细契约、安全边界与生效方式见 [管理界面文档](<docs/management-ui.md>)。客户端半是仓库里的构建产物 `lib/client.js`，由 `src/client.js` 经 `pnpm run build` 生成；缺这个文件时宿主会报缺 bundle 并拒绝激活，所以改完客户端源码必须先构建。是否自动热替换取决于宿主的开发构建监听是否运行，页面打开不能说明新 bundle 已生效。**宿主**半改完要重启 Harness 才会重新 import 模块。

## 自动重连（Auto reconnect）

- 仅监督**本插件挂载**、当前仍被选中（`selected`）、且策略仍允许自动连接（`autoAllowed`）的服务器；还必须验证原生桥接恰为 **`0.2.0-rc.2`**。手动选择（`custom`）不妨碍符合策略的服务器重连；未被策略允许的手动连接只有单次尝试。手动断开 / 停止连接保持粘性。
- 瞬时启动或断线故障按 **1、2、4、8、16、30、60 秒 × 0.8～1 随机抖动**重试，之后无限按 60 秒档重试；连接持续稳定 **30 秒**后才重置退避。模型请求不会绕过等待；一台恢复、切换或正常声明更新不会重启未变化的健康同伴。
- 已选 `required` 服务器不可用期间拒绝模型请求，恢复后放行，但保留健康同伴。后台重试发现目标声明变化时以 `DECLARATION_CHANGED` 停止，等待下一次安全的模型组装 / 编辑协调应用新声明。
- 面板用琥珀色 `reconnecting`、本地倒计时和尝试次数显示退避，提供「停止连接 / 立即重试」。非法声明、鉴权错误或永久性启动错误暂停；无法确认旧进程已关闭（`CLOSE_UNCONFIRMED`）时，连手动重试也禁止，须换会话或重启宿主。原生版本 / 接口无法验证时明确显示监控不支持，回退原生连接而不启用增强重连。
- **断线感知**：对已连接的 HTTP 服务器做只读可达性探测（`HEAD`，1.5 秒超时，不带凭据，任何 HTTP 响应都算存活）。第一次失败立即撤下绿点、显示「待确认」，1.2 秒后复核；连续两次失败才交给重连监督器，而任何真实调用成功都会刷新确认。节奏随活跃度：有 MCP 活动时 10 秒，2 分钟后 30 秒，5 分钟无活动即停。面板打开时与工具调用前（距上次确认超过 5 秒）会即时探测，不可达时该次调用立刻得到明确原因，而不是干等工具超时；原调用不会重放。`stdio` 依赖子进程退出事件，不做探测。
- 不重放失败工具、不替 UnityEditor 启动服务器。HTTP 会话 404 经有类型的调用错误识别后，按退避重新初始化会话，而不重放该调用。

更多边界见[管理界面的自动重连说明](<docs/management-ui.md#auto-reconnect>)。本轮验证仅覆盖后端检查与客户端构建，**尚未完成运行中宿主的部署验证**；宿主源码改动必须实际重启 Harness，不能靠切换插件条目或假定 HMR 生效。

## 安装

三种方式，任选其一。三条路都只把包装进 profile 的 `node_modules`，随后由 `dsh.bundle.patch` 插入 `workspace-mcp-glue` 条目，在插件页确认 `dsh-mcp-glue` 已启用即可。

- **从 Git 仓库安装（发布后的常规方式）**：在侧边栏「插件」页发起安装并填仓库地址，或让 CLI 代劳：
  ```powershell
  pnpm dsh plugin --profile <profile> add 'github:<owner>/dsh-mcp-glue'
  # 建议锁到具体 commit：'github:<owner>/dsh-mcp-glue#<sha>'
  ```
  这条路径**不需要任何构建步骤**：`lib/client.js` 已随仓库提交，`prepack` 只在本地打包时跑（DSH 侧执行的是 `pnpm add <spec>`，不跑 pack 生命周期）。仓库里也没有 install 期脚本，因此不会出现「有待批准的依赖构建脚本」。
- **link 安装（推荐用于持续迭代）**：让 profile 直接链接本工程目录，不必每次重新打包；客户端源码改后先构建并确认宿主加载新 bundle，宿主源码改后必须实际重启 Harness（仅重载插件条目不会重新 import）。
  ```powershell
  # 在 profile 目录执行；spec 用 link: 指向本工程
  pnpm add link:<本工程绝对路径>
  ```
- **tgz 安装**：`pnpm pack` 后在插件界面安装生成的 tgz（`prepack` 会先重建 `lib/client.js`）。

本包的**运行时代码刻意不 import** 任何 `@deepseek-ai/dsh-*` 模块：作用域身份来自模块私有 Symbol，第二份模块拷贝会让 scoped 注册退化成全局注册。原生 MCP 桥接通过宿主 Cordis loader 按运行时自己的实例加载（详见[调查笔记](<docs/loading-model.md#6-模块实例身份第三方插件的关键约束>)）。

`peerDependencies` 只声明 `@deepseek-ai/dsh: >=0.2.0-rc.2` 并标为 `optional`。DSH 用它做安装与启动时的版本兼容判定（只认 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 前缀），不满足就拒绝安装或告警；标 optional 后 pnpm 不会自动安装它，它也不代表运行时 import。`engines.dsh` 只是文档，运行时不读。

开发/打包（`node`/`pnpm` 应为 Node 22.16+）：

```powershell
pnpm install --ignore-scripts
pnpm run build      # 生成客户端半 lib/client.js（缺失会导致激活失败）
pnpm test
pnpm run check
pnpm pack
```

若通过 CLI 安装，先用 `dsh plugin --help` 核对当前版本的命令参数；不要直接把项目里的 MCP 列表导入 profile。

六个可热改字段（`enabledBuiltins`、`presets`、`trustMode`、`trustedWorkspaces`、`workspaceAllowances`、`conflictPolicy`）在 Config 里声明为 `.volatile()`：DSH 的 `ctx.settings` 只把「有 volatile 字段」的 Loader 条目视为可配置（`describe()` 直接丢掉其余条目），写入经 `configEditor` 落进 profile patch 并由 Loader 就地应用，**保存后立即生效、不需要重启**。上限、密钥（`inputValues`，secret 角色）与 `webControl` 刻意**不**可热改，也不在浏览器与宿主之间往返。

同样的值也可以直接写在自己的 profile patch 里，覆盖安装产生的条目（这样改不会经过设置表单，但两者是同一份文件与同一条 `config`）：

```yaml
- id: workspace-mcp-glue
  config:
    enabledBuiltins: [root, vscode, codex, cursor, gemini]
    trustMode: manual          # manual | all（all 等于信任一切仓库，谨慎）
    trustedWorkspaces:         # 这个目录里的声明全部允许自动加载；精确匹配目录本身
      - 'D:\Data\Project\trusted-project'
    workspaceAllowances:       # 只信这个目录里的这几样
      - workspace: 'D:\Data\Project\other-repo'
        allowMcp: [team-tools]
        allowTools: ['mcp__team-tools__identity']
    conflictPolicy: error
    webControl: true           # 注册管理界面的同源控制路由；false 则界面只读不到状态
```

### 信任与执行

一个声明的服务器是否**自动连接**，按三层判定，从强到弱，任一层命中就加载：

1. **`trustMode: all`** —— 信任一切：任何仓库的声明都会启动本地程序（高风险 opt-in，别对不可信仓库用）。
2. **`trustedWorkspaces`** —— 这个**目录**里的声明全部允许自动加载。目录按规范化身份**精确匹配**，不包含其子目录。
3. **`workspaceAllowances[].allowMcp`** —— 这个工作区里**只**允许列出的那几个服务器自动加载。

三层都不命中时：**保持未加载**，插件**不会主动弹批准框**（这点与早期版本不同）。要让它跑起来，点面板里那一行的「连接」，或者打开面板底部的「始终信任此工作区」开关——授权只能由用户在界面上做出，插件不代用户询问。

- 面板的「连接 / 断开」是**会话级**的：它把选择钉成手动模式（`selectionMode: custom`），之后声明再变也不会把用户关掉的服务器加回来；点「恢复自动」才回到按策略判定。
- 「断开」是**粘性**的，重启或换会话后又回到策略判定（手动选择不持久化）。
- 项目里的 `includeTools`/`excludeTools`（Codex `enabled_tools`/`disabled_tools`、Gemini）是**项目自己**的工具过滤，与信任无关：被项目排除的工具永远不可用。
- **DSH 原生 MCP stdio 由 SDK 直接启动，不受 DSH 文件工具的执行沙箱限制。**允许一个目录自动加载，等于允许其中的声明启动任意程序；授权一个服务器也不等于给它的工具免除 DSH 自己的工具调用策略。

### 工具调用闸门

**允许一个服务器启动**和**允许它的某个工具被调用**是两件事。当一个工具来自「服务器已被允许、但这个工具不在 `allowTools` 里」的工作区时，插件在 `tools/pre-execute` 闸门里**先问用户**，给三个答案：

| 答案 | 效果 |
|---|---|
| **仅此次允许** | 放行这一次；下次调用仍会询问 |
| **总是允许这个工具** | 把 `mcp__<server>__<tool>` 写进该工作区的 `allowTools`，以后不再询问（面板里的工具开关读写的就是同一份名单） |
| **拒绝** | 本次调用返回一条错误结果，模型看得到原因，回合继续 |

- 问题走「上下文问答」（`ctx.userQuestions`），在对话里显示成一张带选项的卡片，**不是** DSH 的批准弹窗：只有这条路能给出三个选项，而不是「允许一次 / 拒绝」两个。
- **以下情况不会问**：`trustMode: all`、工作区在 `trustedWorkspaces` 里、工具在 `allowTools` 里、部署或当前会话本身是 `danger-full-access`（用户已全局表态过）、这个 composition 没装问答服务，或调用来自被委派的子 Agent（DSH 不允许子 Agent 打开人类交互）。最后两种都直接放行，绝不把工具调用挂死。
- 用户取消、超时或回答失败时按**拒绝**处理（fail closed），错误里带上原因。
- 闸门**只拦本插件挂载的服务器**：全局 MCP 和其他插件挂的 MCP 一律不碰。
- DSH 侧的事件契约、`exec` 字段、决策四态、与 `tools.guard` 的关系，以及判断完全权限的正确姿势，见[闸门契约](<docs/gate-contract.md>)。
- **项目自己的工具过滤优先于这里的任何开关**：`includeTools` / `excludeTools`（Codex `enabled_tools` / `disabled_tools`、Gemini）由 `tools.guard` 在本闸门**之后**执行，而 guard 只能拒绝、没有任何东西能把它翻回允许。所以一个被项目禁用的工具**既不会被询问、也不会被面板放行**：闸门直接跳过它，交给 guard 用准确的理由拒绝；面板把那一行标成「项目已禁用」并且不给开关——避免出现永远不生效的开关。
- 不读取其他客户端的自动信任、OAuth、用户全局设置；项目不能声明自己受信任。
- 项目内容里影响鉴权/隔离的字段（OAuth、动态 headers helper、remote stdio、服务器级 sandbox 等）会导致该服务器被跳过而不是静默降级；原生启动错误只记录脱敏摘要，不把展开后的密钥写进插件日志。

### 编辑配置（写声明文件）

MCP 小面板标题栏提供 **＋新建 / 管理**；服务器名称与 `⋯` 可直达编辑。新建和编辑在独立大弹窗完成，左侧服务器列表始终保留；配置位置直接在表单里选择，默认优先本工作区上次使用的可写位置，其次项目配置。小面板保留「始终信任此工作区」快捷开关，逐台自动连接与权限策略放在管理弹窗。

- **字段按连接方式显示**：选择器在前。HTTP 只显示 `url` / `headers`；stdio 只显示 `command` / `args` / `env` / `cwd`。命令、URL、工作目录用单行；参数用多行（每行一个参数）；环境变量与请求头默认逐行填写键和值，值默认遮掩，可切换高级 JSON 模式。已有条目也能补填原先不存在的字段；重复键或漏填键会阻止提交。
- **连接方式与文件字段分开**：root / vscode / cursor 用 `type`（`stdio` / `http`）。Gemini、Codex 也提供连接方式选择器，但仅用于筛选表单，不会写入不存在的 `type`；文件按命令或地址推断连接方式。自定义字段映射同样参与推断。
- **`sse` 不提供**：加载器会以 `UNSUPPORTED_SSE` 直接拒绝整台服务器，所以插件在写入前就拦下这种值，而不是写进去再回滚。
- **自定义预设怎么算**：判断依据是预设的 `dialect`——**不写就是 `standard`，于是有**调用方式；写到哪个键由 `fields.transport` 决定（不写就是 `type`）。如果某个格式没有「调用方式」这个概念，把 `fields: { transport: '' }` 映射成空串即表示不支持，否则我们会往文件里写一个没人读的 `type`。
- **切换连接方式自动清理**：保存时删除旧方式的字段，包括旧的 URL / 请求头或命令 / 参数 / 环境变量 / 工作目录；切回去之前草稿仍保留，隐藏字段不会参与解析或提交。表单里清空已有值 = 提交 `null` = 删掉对应键。
- **只做定点手术**：改的是原始文档里的那一个路径，注释、键顺序、其它服务器、以及我们不认识的键**原样保留**——JSONC 走 `jsonc-parser` 的 `modify`，YAML 走 Document API。
- **TOML 可以编辑、追加、删除和迁移**：现有依赖 `@iarna/toml` 会重写整个文件，**整个文件的注释和排版可能丢失**，其他配置值保留。表单会提示，保存 / 删除 / 迁移前还要单独确认；后端也要求严格的 `allowLossy: true`，不确认就不落盘。新建尚不存在的 TOML 文件无需这次确认，版本守卫和失败回滚仍然有效。
- **草稿与版本守卫**：关闭、切服务器或重新读取前，未保存的草稿需确认才能丢弃；失败不清空表单。编辑会钉住打开时的版本令牌，文件被外部修改时返回 409，即使列表自动重读也不会悄悄换用新版本覆盖别人的内容。点击重新读取并确认丢弃后，才采用最新文件。
- **保存与连接分开**：普通保存不会新增连接授权；「保存并连接」才明确请求当前会话连接，stdio 可能启动本地程序。原有的工作区信任 / 自动连接策略仍会生效。
- **写后校验、失败回滚**：写完立刻用加载器的同一条路径重读一遍；新内容解析不了、条目消失了、或者加载报错，就用宿主交回的原文**逐字节还原**，再把失败原因报给用户。
- **只写工作区内**：目标路径必须落在当前工作区里。
- **只读会话不给写**：沙箱是 `read-only` 时会话里入口只读并说明原因；`workspace-write` 及以上才允许保存。
- **这些文件是共享的**：`.mcp.json` 同时被 VS Code / Cursor 读，`.codex/config.toml` 是 Codex 的。「改了哪个文件、哪个键」都会记进宿主日志。
- **新建服务器**：可以凭空建一台，文件不存在就一并创建（此时连 TOML 都行）。
- **复制 / 迁移到另一个预设**：把基础连接字段读成规范字段、再按目标预设写出；目标方言不支持的 `transport` 不会写入。含工具过滤、凭证转发或超时等尚未支持转换的高级字段时拒绝复制，防止静默丢失语义；同一物理文件不允许通过预设别名复制到自身。迁移失败时对源和目标均做版本守卫回滚。
- **同名只能「迁移」，不能「并存」**：DSH 里同一个服务器名出现在两个声明文件里就是冲突，加载器会按 `conflictPolicy` 把它们**都禁用**。所以「保留原条目的同名复制」会被直接拒绝——要么改个名字，要么勾上「复制后删除原条目」把它挪过去。迁移时**先删源、再校验**，中间不会留下冲突状态；删源失败则整个操作回滚。
- 仍然不动我们不认识的字段：编辑只碰那六个字段，删除只碰那一个条目。

## 会话隔离与更新

- 以 `agent.session.header.cwd` 为唯一工作区根；不使用 DSH Host 的当前目录，不向父目录寻找项目根，不读取用户全局 MCP 配置。
- 同一个服务器名可以分别出现在工作区 A/B，它们的进程、工具、资源、指令彼此隔离；同一工作区的不同会话也各自连接，不共享可变进程。
- 原有全局 MCP 仍对会话可见；同名的项目工具按 DSH scoped-shadow 规则覆盖对应的全局工具。插件不删除全局 MCP。
- 每次模型请求组装时重新读取声明；新增、修改、删除在**下一次模型请求**生效，不在运行中的工具调用中途切换。
- 正常更新重新按策略（目录信任 / 白名单）判定，并逐服务器比较 spec / 来源：只卸载删除、改动或取消选择的条目，新增 / 改动的条目独立加载；未变化的健康连接与子 fiber 保留。
- 已运行的会话在安装/热加载插件后于下次请求安全加载。插件卸载或 Agent 释放会关闭其连接、删除 scoped 工具、资源和指令。
- 语法错误/不支持的服务器会记录有界诊断并跳过，不影响其他有效服务器；删掉声明后不会保留旧服务器。Codex `required: true` 的服务器**声明本身非法、启动失败或运行中断线**会拒绝模型请求而不是静默降级；运行时故障由符合资格的监督重试恢复，模型请求不绕过退避，健康同伴保留。至于「没被授权且未选中」——那只是没加载，不是错误：插件不会为一个用户的沉默而打断会话。
- 加载发生在 `system-prompt/assemble` 的组装阶段，因此新增/删除的服务器能在**当前**这次请求就生效，而不是等到下一轮。
- 工具白名单/黑名单由本插件注册的 guard 在调用前判定：只有该项目作用域注册的工具会被限制，全局 MCP 即使名称前缀相同也不受影响；被禁工具仍可能出现在 schema 列表中，但直接调用与 PTC 调用都会被拒绝。

## 自定义预设

完整例子见 [自定义预设示例](<examples/custom-presets.patch.yml>)。可以定义任意工作区相对文件位置、解析格式、服务器表路径、字段映射，也可以继承或覆盖内置预设：

```yaml
- id: workspace-mcp-glue
  config:
    presets:
      - id: team-tools
        files: ['.team/mcp.yaml']
        format: yaml
        serversPaths: ['/integrations/mcp']
        fields:
          command: executable
          args: arguments
          env: environment
          transport: connection.type
          url: connection.url
          headers: connection.headers

      - id: extra-vscode
        extends: vscode
        files: ['.tools/mcp.json']

      # 同 ID 覆盖内置预设，不修改插件源码
      - id: cursor
        enabled: false
```

该团队声明可写成：

```yaml
integrations:
  mcp:
    local:
      executable: node
      arguments: ['${workspaceFolder}/tools/server.js']
      environment:
        API_TOKEN: '${env:MY_TOKEN}'
```

`serversPaths` / `fields` 接受点路径或 RFC6901 JSON Pointer；空字符串代表对象根。服务器表必须是「名字 → 对象」的映射，不支持数组、glob、任意 JS/eval。文件和 `envFile` 经规范化后必须位于工作区内，拒绝目录联接/符号链接逃逸。

可映射字段：`transport`, `command`, `args`, `env`, `cwd`, `url`, `headers`, `enabled`, `disabled`, `envFile`, `envVars`, `envHeaders`, `bearerTokenEnv`, `timeoutMs`, `timeoutSeconds`。

格式：`json`, `jsonc`, `toml`, `yaml`。方言：`standard`, `codex`, `gemini`。`extends` 可以继承内置或前面定义的自定义预设；自定义预设按定义顺序追加，内置预设顺序由 `enabledBuiltins` 决定。

### 变量与凭证

- `standard` 支持 `${VAR}`, `${VAR:-default}`, `${env:VAR}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`, `${pathSeparator}`, `${/}`, `${configDir}`, `${input:id}`。
- `shell`（Gemini 默认）另支持 `$VAR` 与 `%VAR%`；`none`（Codex 默认）保留字面字符串。
- `${input:id}` 只读取 Host 插件配置 `inputValues`，值在设置 schema 中标记为 secret；不会运行 VS Code 的 `inputs.command`。
- 缺失变量/输入值**拒绝该服务器**，避免空凭证或残留占位符。这是本插件的保守策略，不承诺完全复现各客户端的插值失败行为。
- `envFile` 是工作区内 UTF-8 dotenv 文件，按字面值解析；显式 `env` 覆盖其值。它不会自动成为其他字段插值的环境来源。
- Codex `env_vars` 转发指定的宿主变量，`env_http_headers` 读取 header 对应的变量值，`bearer_token_env_var` 读取 token 并添加 `Bearer`。不支持 remote 来源。
- 插值只进行一次；secret 中的 `$`/`${...}` 不会递归解释。插件自身诊断只记录预设名、文件名、服务器名与错误码；原生桥接的启动错误被降级为不含正文的摘要，避免密钥经 spawn 错误进入日志。
- 相对 `command` 按**声明中的 `cwd`**（未声明时是工作区）解析，与各客户端在子进程 cwd 下解析的语义一致；`args`/`cwd` 中出现 NUL 字符会被拒绝。

### 冲突与限制

- 默认 `conflictPolicy: error` 禁用不同来源中存在不同配置的同名服务器；完全相同的声明去重。可显式选择 `first-wins`/`last-wins`，整条替换、不混合凭证。
- 本插件支持 DSH 原生 **stdio / Streamable HTTP**；`type: http` 映射到 Streamable HTTP。未指定 type 时根据 command/url 推断，是兼容加载器策略而非 Claude 的严格校验行为。
- Gemini `httpUrl` 是 HTTP，`url` 是旧 SSE，**不会误当 HTTP**。
- SSE、WebSocket、OAuth、动态 headers helper、remote stdio、显式服务器 sandbox 策略暂不支持；带这些影响安全/鉴权的声明会跳过，而不是静默降级。
- 支持 Codex `enabled_tools`/`disabled_tools` 与 Gemini `includeTools`/`excludeTools` 的**调用限制**（排除优先）；被禁工具可能仍在 schema 列表中，但直接调用/PTC 调用均会被 guard 阻止。Gemini `trust` 不会自动批准工具。
- 不支持 VS Code `env` 中 null 删除继承变量；非字符串/数字环境值拒绝。不会导入其他客户端的单工具批准/输出截断策略。
- 非原生安全服务器名会确定性规范化并附 hash；包含 `__` 或以 `_` 结尾的名字也会 hash，避免原生未转义分隔符造成工具身份/过滤前缀重叠。
- 默认每文件 1 MiB、检查 32 个服务器条目、每台启动 15 秒。Codex `startup_timeout_sec` 可覆盖单台启动超时。**多台服务器并发启动**（最多 6 台同时进行，`MOUNT_CONCURRENCY`）：一代的总耗时取决于最慢的那台，而不是各台之和——本机实测一台 stdio 服务器约 470 ms，串行 5 台要 2.4 s，而读取并解析全部声明文件只要约 3 ms。
- **仅支持本地 Host 文件系统**。原生 MCP stdio 没有 SSH subprocess seam，远程文件系统被拒绝，避免在 Host 上误启动远端声明。

## 调查与验证

[DSH 加载链路调查](<docs/loading-model.md>) 记录原生加载方式、扩展点及为什么不能把项目配置放进全局 Loader；[管理界面文档](<docs/management-ui.md>) 记录控件契约、控制路由与令牌边界。[测试目录](<test/runtime.test.js>) 使用真实 Cordis/DSH MCP 桥接与本地 JSON-RPC fixture，覆盖工作区并发隔离、更新、资源/指令、首次请求与卸载；[HTTP 测试](<test/http.test.js>) 用真实 `dsh-host-webserver` 跑通令牌注入 → 状态 → 手动连接的完整链路。

外部格式依据：
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [VS Code 配置字段](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)
- [Cursor MCP](https://cursor.com/docs/mcp)
- [Gemini MCP](https://geminicli.com/docs/tools/mcp-server/)

本包是**声明格式兼容加载器**，不是这些客户端的完整运行时或鉴权实现。
