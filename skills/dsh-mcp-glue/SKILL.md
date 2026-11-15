---
name: dsh-mcp-glue
description: 管理与排查 dsh-mcp-glue 插件加载的工作区级 MCP 声明（`.mcp.json`、`.vscode/mcp.json`、`.codex/config.toml` 等预设文件）：增删服务器、查看加载与连接状态、单台真实握手测试、处理 Windows 与文件沙箱下的 stdio 启动失败。适用于给当前工作区加入或移除 MCP server、配置写好但工具没出现、或需要判断声明是否被信任与自动连接时。
whenToUse: 需要为会话工作区添加或删除 MCP server、查询 MCP 声明与连接状态、或排查 MCP 工具未出现／连接失败时。
---

# dsh-mcp-glue（0.4.0 实测）

基线：DSH 0.2.2-rc.3 + Desktop profile，插件 dsh-mcp-glue 0.4.0，Windows。以下结论均为现场实测；版本变化后重新核对。

## 1. 定位与前提

- Loader 行 id 为 `workspace-mcp-glue`，npm 包名 `dsh-mcp-glue`；只读**当前会话工作区**的声明文件，不向父目录搜索。
- 插件配置位于 profile 的 `cordis.patch.yml`：

```yaml
- id: workspace-mcp-glue
  name: dsh-mcp-glue
  config:
    trustMode: manual
    enabledBuiltins: [root, vscode]
    trustedWorkspaces: []
```

- 工具 shell 已提供 `DSH_SESSION_ID`、`DSH_WEB_URL`、`DSH_HOME`、`DSH_PROFILE`、`DSH_PROFILE_DIR`；控制路由需要前两个。
- 人工入口：输入框工具行左侧的 MCP 控件（连接／断开／重新读取／测试连接／编辑声明）。
- **本文件的交付方式**：插件激活时通过 `ctx.skills.register()` 把它注册为 `source: bundled` 的技能，无需复制到 skill 目录。同一层内的优先级为 project-* > runtime > user-*：项目 skill 目录里的同名技能优先，用户目录（`$DSH_HOME/skills/dsh-mcp-glue`）的同名副本不生效。需要修改文档时应改插件包内的 `skills/dsh-mcp-glue/SKILL.md`。

## 2. 预设与声明文件

| 预设 | 工作区相对位置 | 服务器表 | 格式 |
|---|---|---|---|
| `root` | `.mcp.json` | `mcpServers` 或 `servers`（不能同时存在） | JSONC |
| `vscode` | `.vscode/mcp.json` | `servers` | JSONC |
| `codex` | `.codex/config.toml` | `mcp_servers` | TOML |
| `cursor` | `.cursor/mcp.json` | `mcpServers` | JSONC |
| `gemini` | `.gemini/settings.json` | `mcpServers` | JSONC |

条目字段（标准方言）：`type`／`command`／`args`／`env`／`cwd`／`url`／`headers`／`enabled`／`disabled`／`timeout`，另支持 `envFile`、`includeTools`／`excludeTools`、`required`。字符串支持 `${env:VAR}`、`${workspaceFolder}`、`${input:id}`；插值在加载期展开，缺值即加载失败。

约束：服务器名 `[A-Za-z0-9_-]{1,32}`；每工作区最多 32 台；单文件 1MB；启动超时默认 15s；不同文件同名由 `conflictPolicy` 处理（默认 `error`，冲突双方都不加载）。

## 3. 添加服务器（手工编辑为主）

1. 读取现有声明文件；不存在时按预设新建。
2. 在服务器表中添加一条，保留 JSONC 注释与已有条目。
3. 保存后生效。插件发现声明变化后在下一次模型工具组装时重读并（在允许自动连接时）连接，无需重启，也无需操作面板。

最小 stdio 条目（跨平台，Windows 见 §7）：

```json
{
  "mcpServers": {
    "<server>": {
      "command": "node",
      "args": ["<绝对或相对工作区的 JS 入口>", "--flag"]
    }
  }
}
```

手工编辑更稳妥：天然保留注释与排版，且文件工具的「按原文匹配」写作本身防并发覆盖。面板的声明编辑器（0.4.0 起可用）额外提供字段级校验、版本冲突检测和失败回滚，适合不熟悉格式的场景。

## 4. 删除服务器

- 删除服务器表中对应的键；下一次组装后连接关闭、工具消失。
- `disconnect` 只断开连接且**粘性**（声明变化也不会自动恢复），不删声明；`follow` 撤销手动选择，回到信任策略允许的集合。
- 删除后需确认声明文件仍是合法 JSONC。删掉一台后 `status.counts.invalid` 应回到 0。

## 5. 控制路由（可脚本化，替代面板操作）

前缀 `/workspace-mcp`，仅本机回环且同源；先通过 `GET /handshake` 获取 token（`Origin` 头需为 `DSH_WEB_URL`），其余请求携带 `x-workspace-mcp-token`。

| 方法与路径 | 请求体 | 用途 |
|---|---|---|
| `GET status?sessionId=<id>&refresh=1` | — | 工作区、信任、选中集合、每台的 state／verified／tools／warnings、counts |
| `POST declaration` `{action:"list"}` | `sessionId` | 声明文件、条目字段值与 `version` |
| `POST probe` | `sessionId`,`serverId` | 单台真实握手与工具列表，不注册工具、不影响现有连接 |
| `POST connect` | `sessionId`[,`serverId`] | 显式授权并连接（省略为全部） |
| `POST disconnect` | `sessionId`[,`serverId`] | 手动断开（粘性） |
| `POST follow` | `sessionId` | 回到策略允许的集合 |
| `GET/POST config` | 读取／`{patch}` | 插件生效配置 |
| `POST declaration` `{action:"write"}` | `sessionId`,`preset`,`name`,`fields:[{name,value}]` | 新建条目 |
| `POST declaration` `{action:"save"}` | `sessionId`,`serverId`,`changes`,`version` | 改字段（保留注释） |
| `POST declaration` `{action:"remove"}` | `sessionId`,`serverId`,`version` | 删除条目 |

随本 skill 提供零依赖 CLI（`scripts/mcpctl.mjs`，读 `DSH_WEB_URL` 与 `DSH_SESSION_ID`）：`node <skill 目录>/scripts/mcpctl.mjs status`，另有 `list`／`probe <serverId>`／`connect [serverId]`／`disconnect [serverId]`／`follow`／`config`／`write <preset> <name> <json>`／`remove <serverId>`。安装后的 skill 目录通常为 `$DSH_HOME/skills/dsh-mcp-glue`。

**写入与沙箱**：声明写入走会话自己的沙箱策略。

- `workspace-write` 及以上：可写工作区内的声明文件。
- `read-only`：`writable: false`，写入返回 403 `DECLARATION_READ_ONLY`。
- 若在 `workspace-write` 会话里仍收到 `FS_SANDBOX_DENIED ... file access denied under workspace-write mode`，这属于 0.3.3 及更早版本的缺陷（写入没有携带会话策略，落到部署级根目录），升级插件可解决；改用更宽权限不能解决该问题。

token 是进程级凭据：只在本机回环使用，不落盘、不回显到项目文件或日志。

## 6. 信任与批准（未连接与反复批准的主要来源）

- 自动连接条件：`trustMode: all`，或工作区在 `trustedWorkspaces`，或 `workspaceAllowances[].allowMcp` 含该服务器名。
- 工具调用免批准条件：同上，或 `workspaceAllowances[].allowTools` 含 `mcp__<server>__<tool>`。
- 二者只写在 profile patch，**不写进项目文件**——仓库不能自我授权。
- 未受信任时：新声明不自动连接（面板「连接」或 `connect` 等于显式授权）；每次工具调用都要批准，用户可当场选择「总是允许」，结果写入 patch。
- **未授权时只能由用户授权**：`state: unauthorized` 表示声明有效，但 `trustMode`／`trustedWorkspaces`／`allowMcp` 都没有授权它加载。沙箱提权（`danger-full-access`）不会让它加载：提权只影响文件与进程，不改变信任判定；它唯一的作用是在服务器已经加载之后，使本插件的工具闸门不再询问。授权入口共三个，均需用户操作：

  > 该 MCP 服务器已在声明中，但当前工作区未被信任，因此没有加载。授权入口：MCP 面板的「连接」（仅本会话）、行内的「加入 allowMcp」（持久生效）、「始终信任此工作区」（整个目录）。该步骤只能由用户完成。

## 7. Windows

- 裸 `npx`／`npm` 无法直接 spawn：Node 对 `.cmd` 返回 `EINVAL`。可用写法如下：
  1. `command: node` + 包内 JS 入口的绝对路径（首选，稳定、不经过 shell）；
  2. `command: cmd`、`args: ["/d", "/s", "/c", "npx", "-y", "<package>"]`；
  3. 全局安装后指向 `<全局 npm 目录>/node_modules/<package>/out/.../bin/<cli>.js`。
- 插件 0.4.0 起会在 `status` 的该行给出 `WINDOWS_SHIM_COMMAND` 警告（含 `detail`），不影响加载。`windowsShim` 设为 `rewrite` 时在内存中改写成 `cmd /d /s /c`（声明文件不变），副作用是声明与实际执行的命令不一致。
- 全局 npm 目录在工作区外，写入需要一次性更宽权限（`danger-full-access` 批准）；`workspace-write` 下安装会 `EPERM`。
- **区分两种 `npx`**。在会话里用 bash 工具跑 `npx`（临时试包、安装）时，npm 缓存默认写在工作区外，沙箱会 `EPERM`——此时可设置 `npm_config_cache=<工作区>/.tmp/npm-cache`，或改用工作区内／全局安装后以 `node` 入口启动。
  声明里的 `command: "npx"` **不受这条影响**：MCP 的 stdio 子进程由 MCP SDK 直接 spawn，不经过 DSH 的 shell／文件沙箱，缓存写用户目录是正常的；Windows 上会先遇到上一条所述的 `EINVAL`，不会进入缓存阶段。

## 8. 诊断

`status` 与 `list` 的诊断带 `detail`：解析错误给出行列，字段错误给出字段名、键名或变量名。`detail` 指明具体位置，可避免逐个试错。

排障顺序：先看该行的 `state`，再看 `error`／`errorDetail`，最后看 `warnings`。`state` 决定问题在「加载前」还是「加载后」，两者对应的处理方式不同。

| 现象 | 原因 | 处理 |
|---|---|---|
| 工具始终不出现 | 声明未加载：预设未在 `enabledBuiltins`、文件名或服务器表路径不符、`mcpServers` 与 `servers` 同时存在、同名冲突 | 由 `list` 检查 `targets` 是否包含该条目，以及 `status.counts.declarations` 是否为 0 |
| `INVALID_DECLARATION` + 行列 | JSONC/TOML/YAML 语法或重复键 | 按 `detail` 给出的行列修改 |
| `MISSING_ENVIRONMENT_VARIABLE` | `${env:VAR}` 在加载期无值 | `detail` 点名变量；需补齐环境变量或改用固定值 |
| `state: failed` | 启动失败：命令不存在、参数错、`EINVAL`、`EPERM` | 检查 `probe` 的 `stage`／`message`；Windows shim 见 §7 |
| 启动失败 `spawn EINVAL` | Windows 直接 spawn `.cmd` | 改用 `node` 入口或 `cmd /d /s /c` |
| 启动失败 `EPERM` | 沙箱阻止子进程写工作区外路径（缓存、profile 目录） | 改到工作区内路径，或申请更宽权限 |
| 连接正常，但每次调用都要批准 | 工作区未受信任且 `allowTools` 未含该工具 | 调用时由用户选择「总是允许」，或写入 `workspaceAllowances` |
| `state: unauthorized` | 声明有效，但 `trustMode`／`trustedWorkspaces`／`allowMcp` 都没有授权它加载 | **交由用户授权**：面板「连接」（仅本会话）／行内「加入 allowMcp」（持久）／「始终信任此工作区」（整目录）。沙箱提权不改变信任判定，不能替代授权 |
| 新声明没自动连接 | `trustMode: manual` 且工作区未受信任 | 同前；`connect` 等价于面板「连接」 |
| 工具调用返回 `WORKSPACE_MCP_DENIED` | 用户在授权卡片里选择拒绝，或闸门等待超时 | 重新发起调用，由用户选择「仅此次允许」或「总是允许」（后者写入 `allowTools`） |
| 工具调用返回 `WORKSPACE_MCP_UNREACHABLE` | 可达性探测判定该服务器当前不可达，正在自动重连 | 待重连完成后重试；修改沙箱模式不能改善该状态 |
| 手动断开后再没恢复 | 断开是粘性的 | 执行 `connect` 或 `follow` |
| 改了声明仍跑旧命令 | 新声明在下一次工具组装才生效 | 下一轮生效；`status.lastDeclarationChangeAt` 变化即已重读 |
| 日志出现 `DECLARATION_CHANGED` | 后台重连发现声明变化而主动停止 | 属正常现象；下一次组装会应用新声明 |
| 文件类工具只能访问临时目录 | 客户端未协商 MCP roots | 服务器需加 `--allow-unrestricted-paths` 之类开关 |

## 9. 验证闭环

1. 修改声明 → 由 `mcpctl list` 确认条目与字段已落盘；
2. 由 `mcpctl status` 检查 `counts.invalid`／`counts.warnings` 与每行 `error`／`errorDetail`／`warnings`；
3. 由 `mcpctl probe <serverId>` 执行一次真实握手（`ok: true` 且 `toolNames` 非空）；
4. 由 `mcpctl status` 确认 `state: connected`、`verified: true`、`problems: 0`；
5. 新工具在**下一轮**对话进入模型工具表，名称形如 `mcp__<server>__<tool>`。
