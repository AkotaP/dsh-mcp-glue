/*
 * Client half: a compact MCP control in the composer tool row.
 *
 * This file is the module body of the browser bundle. tools/build-client.mjs wraps it in
 * `window.__ModuleLoader__.load({ id, factory })`, so it may use the CJS `require`
 * (platform seeds only), `module`, and `exports` that the wrapper provides. It uses
 * plain React.createElement deliberately: no build toolchain and nothing to transpile.
 *
 * Host communication is one same-origin HTTP route registered by the host half. The
 * per-process token is injected into index.html by the host and is unreadable
 * cross-origin, so another page cannot drive this control.
 */
const React = require('react');
const { createPortal } = require('react-dom');

/**
 * Copy for every user-visible string in this half, plus the Host locale binding that replaces it:
 * `ctx.locale.register` publishes both columns under NS and `bind(NS)` returns the framework
 * translate function (which also fills `{name}` placeholders). Without the locale service — an
 * older composition, or a direct render in the offline tests — the zh column answers instead.
 */
const NS = 'dsh-mcp-glue';
/** key: [zh, en]; both columns fill the same `{name}` placeholders. */
const DICT = {
  "action.back": ["返回", "Back"],
  "action.backToList": ["返回列表", "Back to the list"],
  "action.cancel": ["取消", "Cancel"],
  "action.cancelEdit": ["取消编辑", "Cancel editing"],
  "action.close": ["关闭", "Close"],
  "action.closeManager": ["关闭 MCP 管理", "Close MCP management"],
  "action.collapse": ["收起", "Collapse"],
  "action.confirmRemove": ["确认删除", "Confirm deletion"],
  "action.confirmRewrite": ["确认重写并继续", "Confirm and continue"],
  "action.connect": ["连接", "Connect"],
  "action.connectAll": ["连接全部", "Connect all"],
  "action.copy": ["复制", "Copy"],
  "action.copying": ["复制中…", "Copying…"],
  "action.create": ["创建", "Create"],
  "action.creating": ["创建中…", "Creating…"],
  "action.delete": ["删除", "Delete"],
  "action.discard": ["放弃修改", "Discard changes"],
  "action.disconnect": ["断开", "Disconnect"],
  "action.disconnectAll": ["全部断开", "Disconnect all"],
  "action.editConfig": ["编辑配置", "Edit configuration"],
  "action.expand": ["展开", "Expand"],
  "action.follow": ["恢复自动", "Follow policy"],
  "action.manage": ["管理", "Manage"],
  "action.new": ["＋ 新建", "＋ New"],
  "action.newServer": ["＋ 新建服务器", "＋ New server"],
  "action.overwrite": ["覆盖写入", "Overwrite"],
  "action.reload": ["重新读取", "Reload"],
  "action.removing": ["删除中…", "Deleting…"],
  "action.save": ["保存", "Save"],
  "action.saveAndConnect": ["保存并连接", "Save and connect"],
  "action.saveAndConnectHint": ["保存后立即连接；stdio 会启动本地程序", "Connect right after saving; stdio starts a local program"],
  "action.saving": ["保存中…", "Saving…"],
  "action.working": ["处理中…", "Working…"],
  "action.writing": ["写入中…", "Writing…"],
  "chip.none": ["工作区 MCP：无声明", "Workspace MCP: no declarations"],
  "chip.summary": ["工作区 MCP：{connected}/{total} 已连接", "Workspace MCP: {connected}/{total} connected"],
  "common.builtin": ["内置", "Built-in"],
  "common.custom": ["自定义", "Custom"],
  "common.declarationFile": ["声明文件", "declaration file"],
  "common.dotSeparator": [" · ", " · "],
  "common.field": ["字段", "field"],
  "common.itemsCount": ["{count} 条", "{count} entries"],
  "common.listSeparator": ["、", ", "],
  "common.notWritable": ["不可写", "Not writable"],
  "common.presetsCount": ["{count} 个", "{count}"],
  "common.readOnly": ["只读", "Read-only"],
  "common.thisServer": ["该服务器", "this server"],
  "common.workspaceMcp": ["工作区 MCP", "Workspace MCP"],
  "confirm.actionTitle": ["确认操作", "Confirm the action"],
  "confirm.discardBody": ["当前草稿尚未保存。继续将丢弃这些修改。", "The current draft is not saved. Continuing discards these changes."],
  "confirm.discardTitle": ["放弃未保存的修改？", "Discard the unsaved changes?"],
  "confirm.overwriteBody": ["覆盖会替换 {server} 的全部声明字段，请确认。", "Overwriting replaces every declaration field of {server}; please confirm."],
  "confirm.removeBody": ["将从 {file} 删除 {server}，无法撤销。", "Deletes {server} from {file}; it cannot be undone."],
  "confirm.removeTitle": ["确认删除服务器？", "Delete the server?"],
  "confirm.tomlTitle": ["确认重写 TOML 文件", "Confirm rewriting the TOML file"],
  "error.checkStartup": ["请检查启动命令或服务地址", "Check the startup command or the service address"],
  "error.settingsUnavailable": ["settings 服务不可用", "the settings service is unavailable"],
  "field.addEnv": ["＋ 添加环境变量", "＋ Add environment variable"],
  "field.addHeader": ["＋ 添加请求头", "＋ Add header"],
  "field.args": ["参数（每行一个）", "Arguments (one per line)"],
  "field.command": ["启动命令", "Command"],
  "field.cwd": ["工作目录", "Working directory"],
  "field.env": ["环境变量", "Environment"],
  "field.error.duplicateKey": ["键名重复：{key}", "Duplicate key: {key}"],
  "field.error.keyRequired": ["请填写每一行的键名，或删除该行", "Fill in every row's key, or delete the row"],
  "field.error.mustBeString": ["{name} 的值必须是字符串{extra}", "{name} must be a string{extra}"],
  "field.error.notJson": ["{name} 不是合法 JSON", "{name} is not valid JSON"],
  "field.error.notObject": ["{name} 需要是 JSON 对象", "{name} must be a JSON object"],
  "field.error.orFiniteNumber": ["或有限数字", " or a finite number"],
  "field.headers": ["HTTP 请求头", "HTTP headers"],
  "field.help.command": ["只填程序名或可执行文件路径，例如 npx、node；参数在下方逐行填写。", "Enter the program name or an executable path, such as npx or node; arguments go below, one per line."],
  "field.help.jsonMode": ["高级 JSON 模式，修改后会校验结构。", "Advanced JSON mode; the structure is validated on change."],
  "field.help.list": ["每行一条，空行忽略；提交时是一组字符串。", "One per line, blank lines ignored; submitted as a list of strings."],
  "field.help.mapStrings": ["JSON 对象，键和值都是字符串，例如 {\"KEY\":\"value\"}。", "JSON object whose keys and values are strings, for example {\"KEY\":\"value\"}."],
  "field.help.mapValues": ["JSON 对象，值可以是字符串或数字，例如 {\"API_KEY\":\"value\"}。", "JSON object whose values may be strings or numbers, for example {\"API_KEY\":\"value\"}."],
  "field.help.textMode": ["逐行填写键和值，无需编写 JSON。", "Fill keys and values row by row; no JSON needed."],
  "field.help.transport": ["声明文件里的 transport / type；留空时由宿主按 url / command 推断，宿主不认识的值会被整体回滚。", "The transport/type field in the declaration file; when empty the host infers it from url/command, and a value the host does not know rolls the whole change back."],
  "field.help.transportSwitch": ["切换连接方式后只显示相关字段；保存时清理旧方式的字段。", "Switching the transport shows only the relevant fields; saving removes the previous transport's fields."],
  "field.help.transportUi": ["仅用于筛选表单；文件中的连接方式由命令或地址推断。", "Only filters this form; the transport in the file is inferred from the command or the address."],
  "field.hideValues": ["隐藏值", "Hide values"],
  "field.kind.list": ["字符串数组", "String array"],
  "field.kind.map": ["键值对象", "Key/value object"],
  "field.labelWithKind": ["{field} · {kind}", "{field} · {kind}"],
  "field.mode.json": ["JSON 模式", "JSON mode"],
  "field.mode.text": ["键值模式", "Key/value mode"],
  "field.placeholder.command": ["例如 npx 或可执行文件路径", "e.g. npx or an executable path"],
  "field.placeholder.cwd": ["留空使用当前工作区", "Leave empty to use the current workspace"],
  "field.placeholder.env": ["例如 API_KEY", "e.g. API_KEY"],
  "field.placeholder.header": ["例如 Authorization", "e.g. Authorization"],
  "field.row.keyAria": ["{field} 第 {row} 行键名", "{field} row {row} key"],
  "field.row.removeAria": ["删除 {field} 第 {row} 行", "Delete {field} row {row}"],
  "field.row.value": ["值", "value"],
  "field.row.valueAria": ["{field} 第 {row} 行值", "{field} row {row} value"],
  "field.showValues": ["显示值", "Show values"],
  "field.transport": ["调用方式", "Transport"],
  "field.transportHttp": ["远程服务 · HTTP", "Remote service · HTTP"],
  "field.transportLabel": ["连接方式", "Transport"],
  "field.transportStdio": ["本地程序 · stdio", "Local program · stdio"],
  "field.transportUnset": ["不指定：由宿主按 url / command 推断", "Unset: the host infers it from url/command"],
  "field.transportUnsetShort": ["不指定", "Unset"],
  "field.url": ["服务器 URL", "Server URL"],
  "handshake.failed": ["控制通道握手失败（HTTP {status}）", "Control channel handshake failed (HTTP {status})"],
  "handshake.invalid": ["控制通道握手响应无效", "Control channel handshake returned an invalid response"],
  "manager.autoConnectHint": ["这里管理以后是否自动连接，以及工具调用是否需要批准；与当前连接状态分开。", "This section manages future auto-connecting and whether tool calls need approval; it is separate from the current connection state."],
  "manager.autoConnectTools": ["自动连接与工具权限", "Auto-connect and tool permissions"],
  "manager.builtinSuffix": [" · 内置预设", " · built-in preset"],
  "manager.choosePresetCopy": ["选目标预设：这条声明的字段会预填到它的声明文件里，格式不同时由宿主转换。", "Choose a target preset: this declaration's fields prefill its declaration file, and the host converts them when the formats differ."],
  "manager.choosePresetNew": ["选目标预设：新条目会写进它的声明文件；文件还不存在时由宿主新建整个文件。", "Choose a target preset: the new entry is written into its declaration file, and the host creates the whole file when it does not exist yet."],
  "manager.configLocation": ["配置位置", "Configuration location"],
  "manager.copyHint": ["把这条声明的字段预填到另一个可写预设里，格式不同时由宿主转换", "Prefill this declaration's fields into another writable preset; the host converts them when the formats differ"],
  "manager.copyToOther": ["复制到其他位置", "Copy elsewhere"],
  "manager.copyToPreset": ["复制到其它预设", "Copy to another preset"],
  "manager.createHint": ["在某个可写的预设里新建一条服务器声明；目标文件不存在时由宿主新建整个文件", "Create a server declaration in a writable preset; when the target file does not exist the host creates the whole file"],
  "manager.declarationOf": ["声明 {server}", "Declaration {server}"],
  "manager.editConfigOf": ["编辑配置 {server}", "Edit configuration for {server}"],
  "manager.editTitle": ["编辑 MCP 声明", "Edit MCP declarations"],
  "manager.fieldCount": ["{count} 字段", "{count} fields"],
  "manager.formatSuffix": [" · {format}", " · {format}"],
  "manager.nameHint": ["写进声明文件的名字；目标文件里已经有同名条目时由宿主拒绝。", "The name written into the declaration file; the host rejects it when the target file already has an entry with that name."],
  "manager.nameLabel": ["条目名 · 服务器名", "Entry name · server name"],
  "manager.namePlaceholder": ["例如 demo", "e.g. demo"],
  "manager.newServer": ["新建服务器", "New server"],
  "manager.newTomlWarning": ["新建 TOML 文件；以后编辑此文件会重写整个文件，可能丢失注释和排版。", "A new TOML file; editing it later rewrites the whole file and may lose comments and formatting."],
  "manager.noChanges": ["没有改动，只提交改过的字段", "Nothing changed; only edited fields are submitted"],
  "manager.noEditableDeclarations": ["没有可以原地编辑的声明条目。", "No declaration entry can be edited in place."],
  "manager.noEditableFields": ["这个条目没有任何已经存在的可编辑字段。", "This entry has no existing editable fields."],
  "manager.noFileSelected": ["未选择配置文件", "no configuration file selected"],
  "manager.notEditable": ["这个条目不能原地编辑", "This entry cannot be edited in place"],
  "manager.noWritablePreset": ["当前配置里没有可以写入的预设。", "The current configuration has no preset that can be written."],
  "manager.overwriteTitle": ["覆盖声明 {name}", "Overwrite {name}"],
  "manager.overwriteWarning": ["{where} 里已经有一条叫 {name} 的声明；覆盖会把它现有的字段换成这次提交的字段。", "{where} already has a declaration named {name}; overwriting replaces its current fields with the submitted ones."],
  "manager.policyAndPermissions": ["连接策略与权限", "Connection policy and permissions"],
  "manager.prefillNote": ["字段预填自 {server} 的当前值；改动以这里填的为准。", "Fields prefilled from the current values of {server}; what is entered here wins."],
  "manager.presetLocked": ["这个预设现在不能写入", "This preset cannot be written right now"],
  "manager.presetOption": ["{label} · {where}{reason}", "{label} · {where}{reason}"],
  "manager.presetReasonParen": ["（{reason}）", " ({reason})"],
  "manager.projectConfig": ["项目配置（推荐）", "Project configuration (recommended)"],
  "manager.readingConfig": ["正在读取配置…", "Reading configuration…"],
  "manager.readingDeclarations": ["正在读取可编辑的声明…", "Reading editable declarations…"],
  "manager.readOnlyReason": ["只读：{reason}", "Read-only: {reason}"],
  "manager.removeConfirm": ["这会从 {file} 里删掉这一条服务器声明，无法撤销。", "This deletes the server declaration from {file}; it cannot be undone."],
  "manager.removeOf": ["删除声明 {server}", "Delete the declaration {server}"],
  "manager.removeShort": ["删除 {server}", "Delete {server}"],
  "manager.removeSourceAfterCopy": ["复制后删除原条目", "Delete the original entry after copying"],
  "manager.sameFile": ["源和目标是同一个文件", "Source and target are the same file"],
  "manager.selectHint": ["选择左侧服务器进行编辑，或直接新建。", "Select a server on the left to edit it, or create one."],
  "manager.serverManagerTitle": ["MCP 服务器管理", "MCP server management"],
  "manager.serversAndPolicy": ["服务器与连接策略", "Servers and connection policy"],
  "manager.targetExists": ["目标条目已存在", "The target entry already exists"],
  "manager.targetLine": ["目标：{target}{format}{builtin}", "Target: {target}{format}{builtin}"],
  "manager.targetPreset": ["目标预设：{preset}", "Target preset: {preset}"],
  "manager.thisDeclaration": ["这条声明", "this declaration"],
  "manager.trustAllWarning": ["信任所有项目——任何仓库的声明都可能启动本地程序", "Trust every project — any repository's declaration may start a local program"],
  "manager.trustSummary": ["受信任的工作区自动加载；其余工作区里的声明不会被加载，也不会弹窗询问，只能逐项放行", "Trusted workspaces load automatically; declarations elsewhere are never loaded and never prompt — they can only be approved one by one"],
  "manager.willSubmit": ["将提交 {count} 个字段", "Will submit {count} fields"],
  "manager.willWrite": ["将写入：{file}", "Will write: {file}"],
  "manager.writeInto": ["写入 {target}", "Write into {target}"],
  "panel.andRemovedSource": ["，并删掉了原条目", ", and the original entry was removed"],
  "panel.cannotWrite": ["当前会话不能写工作区文件：{reason}", "This session cannot write workspace files: {reason}"],
  "panel.connectHint": ["连接后从下一条消息开始可用", "Available from the next message once connected"],
  "panel.copied": ["已复制 {server} 到 {file}{suffix}", "Copied {server} to {file}{suffix}"],
  "panel.created": ["已在 {file} 新建 {server}", "Created {server} in {file}"],
  "panel.editHint": ["直接改这 {count} 条声明里已经存在的字段（command/args/env/cwd/url/headers），或删掉一条", "Edit fields that already exist in these {count} declarations (command/args/env/cwd/url/headers), or delete one"],
  "panel.empty": ["这个工作区没有项目级 MCP 声明。", "This workspace has no project-level MCP declarations."],
  "panel.emptyHint": ["这个项目还没有声明条目；在这里新建一台服务器（command/args/env/cwd/url/headers），写进 {count} 个可写预设之一", "This project has no declarations yet; create a server here (command/args/env/cwd/url/headers) and write it into one of the {count} writable presets"],
  "panel.followHint": ["丢掉手动挑选，改回完全按策略判定（trustMode / trustedWorkspaces / allowMcp）", "Drop the manual picks and follow the policy again (trustMode / trustedWorkspaces / allowMcp)"],
  "panel.managerTitle": ["工作区 MCP 管理", "Workspace MCP management"],
  "panel.missingSaved": ["找不到刚保存的服务器，请重新读取", "Could not find the server that was just saved; read the declarations again"],
  "panel.newServerHint": ["直接新建 MCP 服务器", "Create an MCP server straight away"],
  "panel.reading": ["正在读取声明…", "Reading declarations…"],
  "panel.readOnlySession": ["当前会话只读", "This session is read-only"],
  "panel.removed": ["已从 {file} 删除 {server}", "Removed {server} from {file}"],
  "panel.sandboxReadOnly": ["沙箱只读", "the sandbox is read-only"],
  "panel.savedAndRequested": ["配置已保存并已请求连接，从下一条消息开始可用。", "Configuration saved and a connection requested; it becomes available from the next message."],
  "panel.savedConnectFailed": ["配置已保存，但连接失败：{reason}", "Configuration saved, but connecting failed: {reason}"],
  "panel.savedFields": ["已保存 {server} 的 {count} 个字段", "Saved {count} fields for {server}"],
  "row.autoConnectAria": ["自动连接 {id}", "Auto-connect {id}"],
  "row.autoConnectOff": ["取消自动连接 {id}：从 allowMcp 移除并断开", "Stop auto-connecting {id}: remove it from allowMcp and disconnect"],
  "row.autoConnectOn": ["加入 allowMcp：这个工作区的 {id} 不再需要逐项放行", "Join allowMcp: {id} no longer needs per-server approval in this workspace"],
  "row.editAria": ["编辑 {id}", "Edit {id}"],
  "row.manageAria": ["管理 {id}", "Manage {id}"],
  "row.manageHint": ["编辑、复制或删除此服务器", "Edit, copy or delete this server"],
  "row.projectDisabled": ["项目已禁用", "Disabled by the project"],
  "row.projectDisabledHint": ["项目声明里的 includeTools/excludeTools 禁用了它，本地开关无法覆盖", "The project declaration's includeTools/excludeTools disables it; the local switch cannot override that"],
  "row.settingsLocked": ["设置不可写，无法改这个工作区的自动连接", "Settings are not writable, so this workspace's auto-connect cannot change"],
  "row.toolsAfterConnect": ["连接后可管理工具", "Connect to manage its tools"],
  "row.toolsCollapse": ["收起工具列表", "Collapse the tool list"],
  "row.toolsCount": ["工具（{count}）", "Tools ({count})"],
  "row.toolsExpand": ["查看工具列表与调用权限", "Show the tool list and call permissions"],
  "row.toolsToggleAria": ["{action} {id} 的工具列表", "{action} the tool list of {id}"],
  "row.trustedNote": ["已信任此工作区，声明会直接自动加载；取消信任后才需要逐项放行", "This workspace is trusted, so its declarations load automatically; per-server approval is only needed after trust is removed"],
  "row.unconvertible": ["声明无法转换，先修文件", "The declaration cannot be converted; fix the file first"],
  "settings.addPreset": ["添加预设", "Add preset"],
  "settings.appliesLive": ["保存后立即生效，不需要重启", "applies immediately after saving; no restart needed"],
  "settings.appliesRestart": ["保存后需要重启", "needs a restart after saving"],
  "settings.builtinHint": ["勾选即启用，加载顺序就是这里的顺序；取消勾选后该文件不再被读取。", "Ticking a preset enables it, and the load order is the order shown here; unticking it means that file is no longer read."],
  "settings.builtinPresets": ["内置预设", "Built-in presets"],
  "settings.cardsHint": ["上面两张卡片决定「读什么」——哪些声明文件、用什么格式解析、服务器表在哪；下面那张决定「能不能跑」——哪些工作区里的声明可以自动启动本地程序。", "The first two cards decide what is read: which declaration files, in which format, and where the servers table lives. The third decides what may run: which workspaces' declarations may start local programs automatically."],
  "settings.customHint": ["追加在内置预设之后；用相同的 id 可以覆盖内置预设。", "Appended after the built-in presets; the same id overrides a built-in preset."],
  "settings.customPresets": ["自定义预设", "Custom presets"],
  "settings.dialect": ["方言", "Dialect"],
  "settings.dialectSuffix": [" · {dialect}", " · {dialect}"],
  "settings.dirty": ["改动需要保存才生效", "Changes take effect after saving"],
  "settings.entryLine": ["条目 {id} · {timing}", "Entry {id} · {timing}"],
  "settings.error.duplicatePresetId": ["预设 id 重复：{id}", "Duplicate preset id: {id}"],
  "settings.error.presetFieldsJson": ["预设 {id} 的字段映射不是合法 JSON", "The field mapping of preset {id} is not valid JSON"],
  "settings.error.presetFieldsObject": ["预设 {id} 的字段映射必须是对象", "The field mapping of preset {id} must be an object"],
  "settings.error.presetFieldsStrings": ["预设 {id} 的字段映射值必须是字符串", "The field mapping values of preset {id} must be strings"],
  "settings.error.presetFileRequired": ["预设 {id} 至少需要一个文件位置", "Preset {id} needs at least one file location"],
  "settings.error.presetIdRequired": ["每个预设都需要一个 id", "Every preset needs an id"],
  "settings.error.presetServersRequired": ["预设 {id} 至少需要一个服务器表路径", "Preset {id} needs at least one servers path"],
  "settings.extends": ["继承（可选）", "Extends (optional)"],
  "settings.extendsPlaceholder": ["内置或前一个预设 id", "a built-in or earlier preset id"],
  "settings.fieldsLabel": ["字段映射 JSON（可用键：{keys}）", "Field mapping JSON (keys: {keys})"],
  "settings.filesLabel": ["文件位置（每行一个，相对会话工作区）", "File locations (one per line, relative to the session workspace)"],
  "settings.format": ["格式", "Format"],
  "settings.heading": ["项目级 MCP 声明", "Project-level MCP declarations"],
  "settings.interpolation": ["变量插值", "Interpolation"],
  "settings.noCustomPresets": ["还没有自定义预设。", "No custom presets yet."],
  "settings.notWritable": ["当前不可写", "Not writable right now"],
  "settings.notWritableReason": ["当前不可写 — {reason}", "Not writable right now — {reason}"],
  "settings.presetIdPlaceholder": ["预设 id（例如 team-tools）", "preset id (e.g. team-tools)"],
  "settings.presetMeta": ["{paths} · {format}{dialect}", "{paths} · {format}{dialect}"],
  "settings.savedSummary": ["已保存（{presets} 个自定义预设，{builtins} 个内置预设，信任 {trustMode}·{workspaces} 个目录）", "Saved ({presets} custom presets, {builtins} built-in presets, trust {trustMode}·{workspaces} directories)"],
  "settings.serversPathsLabel": ["服务器表路径（每行一个；点路径或 /JSON/Pointer；空行代表根对象）", "Servers paths (one per line; dot paths or /JSON/Pointer; an empty line means the root object)"],
  "settings.subtitle": ["维护项目级 MCP 声明预设：勾选要读取的内置声明文件，或添加读取任意路径与字段名的自定义预设。", "Maintain the project-level MCP declaration presets: tick the built-in declaration files to read, or add custom presets that read any path and field name."],
  "settings.title": ["MCP 声明预设", "MCP declaration presets"],
  "settings.trust": ["信任", "Trust"],
  "settings.trustedWorkspacesLabel": ["受信任的工作区（每行一个绝对路径；精确匹配该目录本身，不含子目录）", "Trusted workspaces (one absolute path per line; matches that directory itself, not its subdirectories)"],
  "settings.trustHint": ["受信任的工作区在会话创建时直接加载声明；其余工作区里的声明不会被加载，也不会弹窗询问——要放行就在对话里的 MCP 面板逐台打开「自动连接」，或者把它的目录加进下面的列表。两者都可热改：保存后立即生效，不需要重启。", "Trusted workspaces load their declarations as soon as the session is created; declarations in other workspaces are never loaded and never prompt — to allow one, turn on auto-connect per server in the conversation's MCP panel, or add its directory to the list below. Both are hot-editable: they apply immediately after saving, with no restart."],
  "state.connected": ["已连接", "Connected"],
  "state.failed": ["连接失败", "Connection failed"],
  "state.invalid": ["声明有问题", "Declaration problem"],
  "state.pending": ["连接中", "Connecting"],
  "state.unauthorized": ["未授权", "Unauthorized"],
  "state.unloaded": ["未加载", "Not loaded"],
  "toml.lossyWarning": ["修改 TOML 会重写整个文件，整个文件的注释和排版可能丢失；其他配置值会保留。", "Editing TOML rewrites the whole file; comments and formatting may be lost, other configuration values are kept."],
  "tool.exemptAria": ["免批准工具 {tool}", "Approve {tool} without asking"],
  "tool.exemptOff": ["取消免批准 {tool}：从 allowTools 移除，调用时重新询问", "Revoke the exemption for {tool}: remove it from allowTools so calls ask again"],
  "tool.exemptOn": ["免批准 {tool}：写进 allowTools，调用不再逐次询问", "Exempt {tool}: write it into allowTools so calls stop asking"],
  "trust.allBadge": ["信任所有项目（设置）", "Trusts every project (setting)"],
  "trust.allLocked": ["trustMode: all 已经信任所有项目；去插件页的「信任」区改这个设置", "trustMode: all already trusts every project; change it in the plugin page's Trust section"],
  "trust.alwaysThisWorkspace": ["始终信任此工作区", "Always trust this workspace"],
  "trust.disable": ["取消信任：不再自动加载这个工作区，并断开当前连接", "Stop trusting: no longer auto-load this workspace and drop the current connection"],
  "trust.enable": ["始终信任此工作区：加入 trustedWorkspaces 并立即连接，以后不再询问", "Always trust this workspace: join trustedWorkspaces, connect immediately and stop asking"],
  "write.error.commandRequired": ["stdio 需要填写命令", "stdio needs a command"],
  "write.error.commandRequiredStdio": ["stdio 需要填写启动命令", "stdio needs a startup command"],
  "write.error.empty": ["至少要填一个字段", "Fill in at least one field"],
  "write.error.nameRequired": ["条目名不能为空", "The entry name cannot be empty"],
  "write.error.urlRequired": ["HTTP 需要填写 URL", "HTTP needs a URL"],
};
const dictOf = column => Object.fromEntries(Object.entries(DICT).map(([key, pair]) => [key, pair[column]]));
let bound;
const t = (key, params) => {
  if (bound !== undefined) return bound(key, params);
  const pair = DICT[key];
  const template = pair === undefined ? key : pair[0];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
};
const TOKEN_GLOBAL = '__WORKSPACE_MCP_TOKEN__';
const ENDPOINT = '/workspace-mcp';
/** The Host holds this one request open until the management view moves. */
const WAIT_PATH = '/wait';
/** Cadence while the panel is open, a workspace is settling, or the rows are moving. */
const FAST_MS = 1000;
/** Settled closed-chip cadence. `/status` reuses the cached plan, so this stays cheap. */
const IDLE_MS = 5000;
/** How long a workspace keeps the fast cadence after the chip attaches or the session changes. */
const WARM_MS = 30000;
/**
 * The dot is a projection of the panel, so it follows every row change instead of waiting out
 * a period: an open panel, a freshly attached or switched workspace, and any read that found
 * the rows moving all run fast. Only a settled, closed chip slows down — and even then it stays
 * sensitive rather than going quiet for fifteen seconds.
 */
const pollInterval = (open, warm, changing) => (open || warm || changing ? FAST_MS : IDLE_MS);

/** One tool as the status row reports it: the public model-facing name, stored verbatim. */
const toolNameOf = tool => (typeof tool === 'string' ? tool : tool?.name ?? '');
/** The public tool names one row published; a server that is not mounted reports none. */
const toolNames = row => (row?.tools ?? []).map(toolNameOf).filter(name => name.length > 0);

/**
 * Cheap identity of one status view: any row's state, the tools it published, or the workspace
 * and trust flag moving makes the next read count as "the panel changed".
 */
const statusSignature = status => (status === undefined ? '' : [
  status.workspace ?? '',
  status.trusted === true ? 'trusted' : 'untrusted',
  // The panel unfolds a row's tool list now, so its contents are part of the view as well.
  ...(status.servers ?? []).map(row => `${row.id}:${row.state}:${toolNames(row).join(',')}`),
].join('|'));

/** A read that failed (or a session not created yet) retries fast first, then doubles. */
const RETRY_MS = 1000;
const RETRY_MAX_MS = 15000;
/** 0 means "healthy"; anything else is the previous backoff step. */
const retryBackoff = previous => (previous === 0 ? RETRY_MS : Math.min(previous * 2, RETRY_MAX_MS));

// This bundle loads no Harness Client package: `dsh.client.inject` only orders activation,
// those modules change without notice, and one throwing import blanks the whole slot entry
// (`slot entry crashed`). The controls below copy the host's own geometry — ghost chip,
// menu surface, state dot — under our own class names, so the shared surface is the
// `--dsw-alias-*` tokens alone.

const CSS = `
.wmcp-wrap{position:relative;display:inline-flex;align-items:center}
/* Action buttons are the host's compact ghost button. The chip instead mirrors the seat it
   sits beside — the composer's own permission trigger — whose stylesheet reads: secondary
   label colour, 13px/500, height 28px, padding 0 4px 0 8px, a focus ring rather than an
   outline, and the dimmed label when disabled. Keeping them equal is what makes the two
   controls look like one row. */
.wmcp-act{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.wmcp-chip{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;height:28px;padding:0 4px 0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer}
.wmcp-chip:hover:not(:disabled),.wmcp-act:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wmcp-chip:active:not(:disabled),.wmcp-act:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.wmcp-act:disabled{cursor:not-allowed;opacity:.4}
.wmcp-chip:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.wmcp-act:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0}
.wmcp-chip:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.wmcp-act[data-variant=primary]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.wmcp-act[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.wmcp-count{font-variant-numeric:tabular-nums}
/* The host's menu material: its fill plus backdrop filter, over the page. */
.wmcp-panel{position:fixed;z-index:60;width:360px;max-width:calc(100vw - 24px);max-height:min(60vh,420px);overflow:auto;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.wmcp-head{display:flex;align-items:baseline;gap:6px;margin:0 0 8px}
.wmcp-head strong{font-size:13px;font-weight:600;flex:none}
.wmcp-path{color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.wmcp-note{color:var(--dsw-alias-label-tertiary);margin:0 0 8px;word-break:break-word}
.wmcp-note[data-kind=error]{color:var(--dsw-alias-state-error-primary)}
/* One declared server is one item: its row, plus the tool list it can unfold below. */
.wmcp-item{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l2)}
.wmcp-item:first-of-type{border-top:0}
.wmcp-row{display:flex;align-items:center;gap:8px;padding:6px 2px}
.wmcp-more{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;height:22px;padding:0 5px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:10px;line-height:14px;cursor:pointer}
.wmcp-more:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wmcp-more[aria-expanded=true]{color:var(--dsw-alias-label-primary)}
.wmcp-more:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0}
.wmcp-more:disabled{cursor:not-allowed;opacity:.4}
.wmcp-tools{display:flex;flex-direction:column;gap:2px;padding:0 2px 8px 20px}
.wmcp-tool{display:flex;align-items:center;gap:8px;min-width:0}
.wmcp-tool-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}
.wmcp-tools-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:0}
.wmcp-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wmcp-tag{color:var(--dsw-alias-label-tertiary);font-size:11px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:0 4px;flex:none}
.wmcp-foot{display:flex;align-items:center;gap:6px;margin-top:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px}
/* Trust switch: a track plus a knob, driven by aria-checked so it stays a real switch. */
.wmcp-trust{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}
.wmcp-switch{display:inline-flex;align-items:center;gap:8px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.wmcp-switch:disabled{opacity:.5;cursor:not-allowed}
/* Off state: an l3-filled well with an l2 inset edge, and a primary-coloured knob. A track
   painted with the panel fill is invisible, and a foreground-coloured knob on it reads as the
   page background instead of as something to drag. */
.wmcp-switch-track{position:relative;width:28px;height:16px;flex:none;border-radius:999px;background:var(--dsw-alias-border-l3);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2);transition:background .15s ease}
.wmcp-switch-track::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform .15s ease}
.wmcp-switch[aria-checked=true] .wmcp-switch-track{background:var(--dsw-alias-state-business-primary);box-shadow:none}
.wmcp-switch[aria-checked=true] .wmcp-switch-track::after{transform:translateX(12px)}
.wmcp-switch:focus-visible .wmcp-switch-track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
/* A tool the project itself forbids: reported, not switchable. */
.wmcp-tool.is-forbidden .wmcp-tool-name{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}
.wmcp-tool-declared{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none}
@media (prefers-reduced-motion:reduce){.wmcp-switch-track,.wmcp-switch-track::after{transition:none}}
.wmcp-spacer{flex:1}
/* State dot: a 10px layout slot painting one 6px currentColor core, as the host does. */
.wmcp-dot{position:relative;display:inline-block;width:10px;height:10px;flex:none;color:var(--dsw-alias-state-idle-primary)}
.wmcp-dot::after{content:'';position:absolute;inset:20%;border-radius:50%;background:currentColor}
.wmcp-dot[data-state=connected]{color:var(--dsw-alias-state-success-primary)}
.wmcp-dot[data-state=unauthorized],.wmcp-dot[data-state=unloaded]{color:var(--dsw-alias-state-warn-primary)}
.wmcp-dot[data-state=failed],.wmcp-dot[data-state=invalid]{color:var(--dsw-alias-state-error-primary)}
.wmcp-dot[data-state=pending]{color:var(--dsw-alias-label-tertiary)}
/* Preset + trust page on the plugin detail page: one header, three cards, one footer. */
.wmpm{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.wmpm h4{font-size:13px;font-weight:600;margin:0}
.wmpm-head{display:flex;flex-direction:column;gap:4px}
.wmpm-title{font-size:14px;font-weight:600;margin:0}
.wmpm-intro{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0}
.wmpm-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0;word-break:break-all}
/* One card per concern, so "what gets read" and "what may run" never blur together. */
.wmpm-section{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.wmpm-section-head{display:flex;align-items:center;gap:8px}
.wmpm-count{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:0 5px}
.wmpm-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}
.wmpm-builtins{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px}
.wmpm-builtin{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;cursor:pointer}
.wmpm-builtin:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wmpm-builtin.is-on{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-2)}
.wmpm-builtin input{margin:2px 0 0;accent-color:var(--dsw-alias-state-business-primary);flex:none}
.wmpm-builtin-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.wmpm-builtin-id{font-weight:500}
.wmpm-card{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.wmpm-card-head{display:flex;align-items:center;gap:8px}
.wmpm-card-head input{flex:1;min-width:0}
.wmpm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
.wmpm-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.wmpm-field>span{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.wmpm input[type=text],.wmpm select,.wmpm textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:4px 8px}
.wmpm textarea{min-height:54px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;line-height:17px}
.wmpm input[type=text]:focus-visible,.wmpm select:focus-visible,.wmpm textarea:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:0}
.wmpm-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
/* Two side-by-side trust choices; the "trust everything" one is drawn as the risky one. */
.wmpm-choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px}
.wmpm-choice{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer}
.wmpm-choice:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wmpm-choice.is-on{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-2)}
.wmpm-choice.is-danger{border-color:var(--dsw-alias-state-error-primary)}
.wmpm-choice input{margin:2px 0 0;accent-color:var(--dsw-alias-state-business-primary);flex:none}
.wmpm-choice-body{display:flex;flex-direction:column;gap:2px;min-width:0}
.wmpm-choice-id{font-weight:500}
.wmpm-choice-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.wmpm-choice.is-danger .wmpm-choice-note{color:var(--dsw-alias-state-error-primary)}
.wmpm-spacer{flex:1}
.wmpm-foot{display:flex;align-items:center;gap:6px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}
.wmpm-status{color:var(--dsw-alias-label-tertiary);font-size:12px}
.wmpm-status[data-kind=error]{color:var(--dsw-alias-state-error-primary)}
.wmpm-status[data-kind=ok]{color:var(--dsw-alias-state-success-primary)}
.wmpm-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
.wmpm-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
/* The declaration editor: a sibling surface that REPLACES the panel, the way the host's own
   pickers replace the control that opened them. Keeping it inside the panel was wrong twice:
   a backdrop-filtered box nested in another loses its blur, so the menu material degraded to a
   translucent slab, and the two surfaces also overlapped. Same recipe as the panel, one level
   up, so the material composites over the page exactly as the panel does. */
.wmcp-overlay{position:fixed;z-index:61;width:360px;max-width:calc(100vw - 24px);max-height:min(60vh,420px);overflow:auto;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;text-align:left}
.wmcp-scrim{display:flex;flex-direction:column;gap:8px}
.wmcp-dialog{display:flex;flex-direction:column;gap:8px}
.wmcp-dialog-head{display:flex;align-items:baseline;gap:6px}
.wmcp-dialog-head strong{font-size:13px;font-weight:600;flex:none}
.wmcp-dialog-note{margin:0;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.wmcp-dialog-note[data-kind=error]{color:var(--dsw-alias-state-error-primary)}
.wmcp-dialog-note[data-kind=ok]{color:var(--dsw-alias-state-success-primary)}
.wmcp-entries{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.wmcp-entry{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.wmcp-entry:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wmcp-entry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0}
.wmcp-entry:disabled{cursor:not-allowed;opacity:.55}
/* A preset that cannot be written still has to say why, so its row carries a second line. */
.wmcp-preset{flex-direction:column;align-items:stretch;gap:2px}
.wmcp-preset-line{display:flex;align-items:center;gap:8px;min-width:0}
.wmcp-preset-reason{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;word-break:break-word}
.wmcp-entry-tag{flex:none}
.wmcp-entry-id{flex:none;font-weight:500}
.wmcp-entry-where{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}
/* One field per row: the label says which kind it is, the hint says how the draft is typed. */
.wmcp-field-row{display:flex;flex-direction:column;gap:4px;min-width:0}
.wmcp-field-row>span{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.wmcp-dialog input[type=text],.wmcp-dialog textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:4px 8px}
.wmcp-dialog textarea{min-height:56px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;line-height:17px}
.wmcp-dialog input[type=text]:focus-visible,.wmcp-dialog textarea:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:0}
.wmcp-dialog input:disabled,.wmcp-dialog textarea:disabled{opacity:.6;cursor:not-allowed}
/* The choice control (transport): a segmented picker drawn here, not borrowed from the host,
   because its options and their order belong to the Host and its value is a plain string. */
.wmcp-choice{display:flex;flex-wrap:wrap;gap:4px}
.wmcp-choice-option{box-sizing:border-box;flex:none;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;cursor:pointer}
.wmcp-choice-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wmcp-choice-option[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.wmcp-choice-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0}
.wmcp-choice-option:disabled{opacity:.6;cursor:not-allowed}
.wmcp-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.wmcp-dialog-foot{display:flex;align-items:center;gap:6px;margin-top:2px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px}
/* The copy action sits under the fields rather than in the foot: the foot already carries
   save and delete, and a copy is a second decision, not a second submit. */
.wmcp-actions{display:flex;align-items:center;gap:6px;margin-top:2px}
.wmcp-check{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}
.wmcp-check input{margin:0;accent-color:var(--dsw-alias-state-business-primary);flex:none}
.wmcp-check:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
/* Connection popover stays compact; configuration lives in a body-level, roomy modal. */
.wmcp-head-actions{display:flex;align-items:center;gap:4px;margin-left:auto;flex:none}
.wmcp-panel{width:420px;box-sizing:border-box;max-height:min(70vh,540px)}
.wmcp-tools-trigger{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;flex:none}
.wmcp-tools-trigger:hover,.wmcp-tools-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wmcp-tools-trigger:focus-visible,.wmcp-name-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.wmcp-tools-trigger:disabled{opacity:.5;cursor:not-allowed}
.wmcp-tools-arrow{display:inline-flex;align-items:center;justify-content:center;width:12px;font-size:10px;line-height:1}
.wmcp-name-button{border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:0;cursor:pointer}
.wmcp-name-button:hover{text-decoration:underline}
.wmcp-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:rgba(0,0,0,.38);color:var(--dsw-alias-label-primary)}
.wmcp-backdrop .wmcp-overlay{position:relative;inset:auto;z-index:auto;box-sizing:border-box;width:1000px;max-width:100%;height:min(760px,calc(100dvh - 48px));max-height:calc(100dvh - 48px);padding:0;overflow:hidden;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));backdrop-filter:none;box-shadow:0 20px 70px rgba(0,0,0,.25)}
.wmcp-manager{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;line-height:20px}
.wmcp-manager-head{display:flex;align-items:center;gap:12px;flex:none;padding:16px 20px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.wmcp-manager-title{margin:0;font-size:16px;font-weight:600}
.wmcp-manager-subtitle{color:var(--dsw-alias-label-tertiary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:380px}
.wmcp-manager-layout{display:flex;flex:1;min-height:0;overflow:hidden}
.wmcp-manager-sidebar{box-sizing:border-box;width:230px;flex:none;display:flex;flex-direction:column;gap:10px;padding:14px 10px;border-right:1px solid var(--dsw-alias-border-l2);overflow:auto;background:var(--dsw-alias-bg-layer-2)}
.wmcp-manager-sidebar .wmcp-entry{flex-direction:column;align-items:stretch;gap:3px;padding:10px}
.wmcp-manager-sidebar .wmcp-entry[aria-current=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-3)}
.wmcp-manager-content{flex:1;min-width:0;overflow:auto;overscroll-behavior:contain;padding:20px 24px}
.wmcp-manager-content>.wmcp-dialog{min-height:100%;gap:16px}
.wmcp-manager-content .wmcp-dialog-head strong{font-size:15px}
.wmcp-manager-content .wmcp-dialog-foot{position:sticky;bottom:-20px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));padding:14px 0;margin-top:auto;flex-wrap:wrap;z-index:2}
.wmcp-manager-content .wmcp-field-row{gap:6px}
.wmcp-manager-content input[type=text],.wmcp-manager-content input[type=password],.wmcp-manager-content select,.wmcp-manager-content textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:7px 10px}
.wmcp-manager-content input:focus-visible,.wmcp-manager-content select:focus-visible,.wmcp-manager-content textarea:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:0}
.wmcp-manager-content textarea{min-height:96px;line-height:20px}
.wmcp-manager-content .wmcp-choice-option{height:34px;padding:0 14px;font-size:13px}
.wmcp-manager-content .wmcp-act{height:32px;font-size:13px}
.wmcp-location{display:flex;flex-direction:column;gap:5px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
.wmcp-location-path{font-family:ui-monospace,Consolas,monospace;overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary);font-size:12px}
.wmcp-warning{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:8px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:19px}
.wmcp-map{display:flex;flex-direction:column;gap:8px}
.wmcp-map-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.wmcp-map-row{display:grid;grid-template-columns:minmax(90px,1fr) minmax(110px,1.5fr) auto;gap:6px;align-items:start}
.wmcp-map-actions{display:flex;align-items:center;gap:2px}
.wmcp-map .wmcp-act{padding:0 6px;font-size:12px}
.wmcp-manager-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:0}
.wmcp-manager-policy{display:flex;flex-direction:column;gap:16px}
.wmcp-manager-policy .wmcp-row{flex-wrap:wrap}
.wmcp-manager-policy h4{margin:0;font-size:14px}
.wmcp-manager-alert{display:flex;flex-direction:column;gap:16px;max-width:620px;margin:30px auto}
.wmcp-manager-alert h3{font-size:17px;margin:0}
.wmcp-manager-empty{padding:36px 10px;text-align:center;color:var(--dsw-alias-label-tertiary)}
@media(max-width:680px){.wmcp-backdrop{padding:8px}.wmcp-backdrop .wmcp-overlay{height:calc(100dvh - 16px);max-height:calc(100dvh - 16px)}.wmcp-manager-head{padding:12px}.wmcp-manager-layout{flex-direction:column}.wmcp-manager-sidebar{width:auto;max-height:150px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}.wmcp-manager-sidebar .wmcp-entries{display:flex;gap:6px;overflow:auto;flex:none}.wmcp-manager-sidebar .wmcp-entry{width:150px;height:100%}.wmcp-manager-content{padding:16px}.wmcp-manager-subtitle{display:none}.wmcp-map-row{grid-template-columns:minmax(70px,1fr) minmax(90px,1.3fr) auto}}
`;

function ensureStyle() {
  if (typeof document === 'undefined') return;
  const id = 'dsh-mcp-glue/panel.css';
  let tag = document.querySelector(`style[data-plugin-css="${id}"]`);
  if (tag === null) {
    tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-mcp-glue';
    tag.dataset.pluginCss = id;
    document.head.appendChild(tag);
  }
  tag.textContent = CSS;
}
// Inject at module scope: the module system claims styles that exist when the factory
// materializes and removes them on HMR invalidation. A style created later would leak.
ensureStyle();

/**
 * Control token: the page shell injects it, but a page served before this plugin
 * activated has no inline token, so fall back to a same-origin handshake and remember
 * the answer. `request` clears the cache and retries once when the Host rotated it.
 */
let cachedToken;
let handshakePreferred = false;
async function controlToken() {
  const injected = typeof window === 'undefined' ? undefined : window[TOKEN_GLOBAL];
  if (!handshakePreferred && typeof injected === 'string' && injected.length > 0) return injected;
  if (cachedToken !== undefined) return cachedToken;
  const response = await fetch(`${ENDPOINT}/handshake`, { method: 'GET', cache: 'no-store' });
  if (!response.ok) throw new Error(t('handshake.failed', { status: response.status }));
  const payload = await response.json();
  if (typeof payload?.token !== 'string' || payload.token.length === 0) throw new Error(t('handshake.invalid'));
  cachedToken = payload.token;
  return cachedToken;
}
async function request(path, body, signal) {
  const send = async () => {
    let token;
    try { token = await controlToken(); } catch (reason) { throw reason; }
    const response = await fetch(`${ENDPOINT}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'x-workspace-mcp-token': token }) },
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload;
    try { payload = text.length === 0 ? {} : JSON.parse(text); } catch { throw new Error(`HTTP ${response.status}`); }
    return { response, payload };
  };
  let { response, payload } = await send();
  if (response.status === 403) {
    // The Host rejected our token: take the authoritative one once and retry.
    cachedToken = undefined; handshakePreferred = true;
    ({ response, payload } = await send());
  }
  if (!response.ok) {
    const failure = new Error(payload.error ?? `HTTP ${response.status}`);
    if (typeof payload?.code === 'string') failure.code = payload.code;
    failure.status = response.status;
    throw failure;
  }
  return payload;
}

const STATE_LABEL = {
  connected: t('state.connected'),
  failed: t('state.failed'),
  invalid: t('state.invalid'),
  unauthorized: t('state.unauthorized'),
  unloaded: t('state.unloaded'),
  pending: t('state.pending'),
};

/** One state dot; the CSS paints the host's four state colours from `data-state`. */
function dotElement(state, key) {
  return React.createElement('span', { key, className: 'wmcp-dot', 'data-state': state, 'aria-hidden': true });
}

/** Panel row states that force the chip red: a broken declaration or a failed start. */
const CHIP_ERROR_STATES = new Set(['failed', 'invalid']);
/** Panel row states that force the chip amber: declared, but not connected. */
const CHIP_WARN_STATES = new Set(['unauthorized', 'unloaded']);

/**
 * Chip text, dot state and accessible name for one host status payload.
 *
 * The dot mirrors the panel's rows with severity precedence: any red row makes the chip
 * red, otherwise any amber row makes it amber, and a row that is neither (a pending one,
 * say) keeps the chip neutral. Only an all-green panel turns it green. A workspace with
 * no declaration stays neutral rather than warning, and an unreachable control channel is
 * red on its own: that is the one case where there are no rows to read at all.
 */
function chipSummary(status, error) {
  const rows = status?.servers ?? [];
  const connected = status?.counts?.connected ?? 0;
  const total = status?.counts?.declarations ?? 0;
  const state = error !== undefined ? 'failed'
    : status === undefined ? 'idle'
      : rows.length === 0 ? 'idle'
        : rows.some(row => CHIP_ERROR_STATES.has(row.state)) ? 'failed'
          : rows.some(row => CHIP_WARN_STATES.has(row.state)) ? 'unauthorized'
            : rows.every(row => row.state === 'connected') ? 'connected'
              : 'idle';
  return {
    state,
    label: total === 0 ? 'MCP' : `MCP ${connected}/${total}`,
    aria: total === 0 ? t('chip.none') : t('chip.summary', { connected: connected, total: total }),
  };
}
/** Manual selection is per generation: report whether anything is selected at all. */
function allSelected(status) {
  return status?.loaded === true || (status?.counts?.selected ?? 0) > 0;
}

/** Add or drop one name, keeping the order of everything else. */
const toggleName = (list, name) => (list.includes(name) ? list.filter(item => item !== name) : [...list, name]);
/** One workspace's allowance row; a workspace without a row is the empty allowance. */
const allowanceOf = (allowances, workspace) => {
  const found = (allowances ?? []).find(item => item?.workspace === workspace);
  return {
    workspace: typeof workspace === 'string' && workspace.length > 0 ? workspace : null,
    allowMcp: [...(found?.allowMcp ?? [])],
    allowTools: [...(found?.allowTools ?? [])],
  };
};
/**
 * Replace one workspace's allowance row and keep every other row exactly as it was: the Host
 * replaces the whole array, so a write must never drop an entry it did not touch. A row that
 * would hold nothing is dropped rather than stored, so flipping the last switch off leaves no
 * residue behind.
 */
const withAllowance = (allowances, next) => {
  const list = (allowances ?? []).map(item => ({
    workspace: item?.workspace,
    allowMcp: [...(item?.allowMcp ?? [])],
    allowTools: [...(item?.allowTools ?? [])],
  }));
  const empty = next.allowMcp.length === 0 && next.allowTools.length === 0;
  const at = list.findIndex(item => item.workspace === next.workspace);
  if (at === -1) return empty ? list : [...list, next];
  if (empty) return list.filter((_item, index) => index !== at);
  return list.map((item, index) => (index === at ? next : item));
};
/** The allowance list after one server is allowed to auto-connect, or no longer is. */
const withAllowedServer = (allowances, workspace, serverId) => {
  const current = allowanceOf(allowances, workspace);
  return withAllowance(allowances, { ...current, allowMcp: toggleName(current.allowMcp, serverId) });
};
/**
 * The allowance list after one tool is exempted from approval, or no longer is.
 *
 * The name is the public model-facing one (mcp__server__tool) exactly as the status row
 * reported it: the loader matches that string, so nothing here trims or rebuilds it.
 */
const withAllowedTool = (allowances, workspace, tool) => {
  const current = allowanceOf(allowances, workspace);
  return withAllowance(allowances, { ...current, allowTools: toggleName(current.allowTools, tool) });
};
/** The current session's allowance: what the switches read, normalized for a missing view. */
const sessionAllowance = status => {
  const view = status?.allowance;
  return {
    workspace: typeof view?.workspace === 'string' && view.workspace.length > 0 ? view.workspace : null,
    allowMcp: [...(view?.allowMcp ?? [])],
    allowTools: [...(view?.allowTools ?? [])],
  };
};
/** The profile's trust mode in this page's vocabulary: anything that is not "all" is manual. */
const trustModeOf = value => (value === 'all' ? 'all' : 'manual');

function Chip(props) {
  const sessionId = props.sessionId;
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState(undefined);
  const [error, setError] = React.useState(undefined);
  const [busy, setBusy] = React.useState(undefined);
  const [rect, setRect] = React.useState(undefined);
  const [warm, setWarm] = React.useState(true);
  const [trusting, setTrusting] = React.useState(false);
  /**
   * The profile fields this panel reads: the trust decision, the workspace allowance list a
   * switch writes back, and whether the entry accepts writes at all.
   */
  const [profile, setProfile] = React.useState(undefined);
  /** The declaration targets this session may rewrite in place, read when the panel opens. */
  const [declaration, setDeclaration] = React.useState(undefined);
  /** The last declaration success or failure, shown in the editor; never the chip's own dot. */
  const [declarationStatus, setDeclarationStatus] = React.useState(undefined);
  const [declarationBusy, setDeclarationBusy] = React.useState(false);
  /** Independent manager intent: direct create, inspect, copy or remove. Not a popup sub-page. */
  const [editing, setEditing] = React.useState(undefined);
  /** Server rows whose tool list is unfolded right now, keyed by server id. */
  const [expanded, setExpanded] = React.useState({});
  const anchor = React.useRef(null);
  /** The panel element, so a pointer outside both it and the chip can dismiss it. */
  const panel = React.useRef(null);
  const alive = React.useRef(true);
  /** Signature of the last read, and whether it differed: the chip follows row changes. */
  const signature = React.useRef('');
  const changing = React.useRef(false);
  /** Management-view revision the Host already answered, and whether it offers a long poll. */
  const version = React.useRef(0);
  const longPoll = React.useRef(true);

  /** Read one session status; resolves with what the cadence should do next. */
  const load = React.useCallback(async refresh => {
    if (sessionId === undefined) return 'ok';
    try {
      const next = await request(`/status?sessionId=${encodeURIComponent(sessionId)}${refresh ? '&refresh=1' : ''}`);
      // Any row that moved since the last read keeps the fast cadence, so a generation that is
      // still coming up is followed row by row instead of sampled once per period.
      const nextSignature = statusSignature(next);
      changing.current = nextSignature !== signature.current;
      signature.current = nextSignature;
      if (alive.current) { setStatus(next); setError(undefined); }
      return 'ok';
    } catch (reason) {
      // A session the Host has not created yet is a transition, not a broken channel: the
      // dot must stay neutral and retry soon instead of flashing red at every new session.
      const pending = reason?.code === 'SESSION_NOT_READY';
      if (alive.current) setError(pending ? undefined : reason instanceof Error ? reason.message : String(reason));
      return pending ? 'pending' : 'failed';
    }
  }, [sessionId]);

  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // A new attach or a session switch is when the generation is still settling: keep the
  // fast cadence for a while, then fall back to the idle one.
  React.useEffect(() => {
    setWarm(true);
    const timer = setTimeout(() => setWarm(false), WARM_MS);
    return () => { clearTimeout(timer); };
  }, [load]);

  // One self-scheduling reader serves the attach, an opened panel and the idle cadence: it
  // never asks for a re-read of the declarations (`refresh=1`), and a read that failed — or
  // a session still coming up — retries on a short backoff instead of waiting out a whole
  // period, so a transient red dot clears within a second.
  // One reader serves the attach, an opened panel and the idle cadence. It prefers the Host's
  // long poll: the request is held until the management view moves, so an idle page costs no
  // requests at all and a change reaches the dot within one round trip. A Host without that
  // action downgrades the reader to the timed cadence for the rest of the page life.
  React.useEffect(() => {
    let stopped = false;
    let timer;
    let controller;
    let backoff = 0;
    const sleep = ms => new Promise(resolve => { timer = setTimeout(resolve, ms); });
    const hold = async () => {
      controller = new AbortController();
      const view = await request(`/wait?sessionId=${encodeURIComponent(sessionId)}&version=${version.current}`, undefined, controller.signal);
      if (typeof view?.version === 'number') version.current = view.version;
    };
    const tick = async () => {
      const outcome = await load(false);
      if (stopped) return;
      backoff = outcome === 'ok' ? 0 : retryBackoff(backoff);
      if (backoff === 0 && longPoll.current) {
        try {
          await hold();
          if (!stopped) void tick();
          return;
        } catch (reason) {
          if (stopped) return;
          // An older Host has no wait action: fall back to the timed cadence for good.
          if (reason?.status === 404) longPoll.current = false;
          else backoff = retryBackoff(backoff);
        }
      }
      await sleep(backoff === 0 ? pollInterval(open, warm, changing.current) : backoff);
      if (!stopped) void tick();
    };
    version.current = 0;
    void tick();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, [open, warm, load]);

  React.useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const node = anchor.current;
      if (node === null) return;
      const box = node.getBoundingClientRect();
      setRect({ left: Math.max(12, Math.min(box.left, window.innerWidth - 432)), bottom: window.innerHeight - box.top + 8 });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    // Escape unwinds one layer at a time: the declaration overlay first, then the panel.
    const onKey = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    // The host's own composer popups dismiss on a pointer down anywhere else, so this one does
    // too; the chip itself is excluded because that click already toggles it shut, and the
    // overlay because its own scrim decides whether that pointer closes it.
    const onPointerDown = event => {
      if (panel.current?.contains(event.target) === true) return;
      if (anchor.current?.contains(event.target) === true) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const act = async (name, serverId) => {
    setBusy(`${name}:${serverId ?? ''}`);
    try {
      const next = await request(`/${name}`, serverId === undefined ? { sessionId } : { sessionId, serverId });
      if (alive.current) { setStatus(next); setError(undefined); }
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  /** Keep exactly the profile fields this panel reads; every read and every write lands here. */
  const adoptProfile = payload => setProfile({
    mode: trustModeOf(payload?.config?.trustMode),
    workspaces: payload?.config?.trustedWorkspaces ?? [],
    allowances: payload?.config?.workspaceAllowances ?? [],
    editable: payload?.editable !== false,
  });

  /**
   * Read the profile: the trust switch reflects `trustedWorkspaces`, not the workspace's
   * effective trust, because that is the thing a user can turn back off, and the allowance
   * switches read the same profile.
   */
  const loadProfile = React.useCallback(async () => {
    try {
      const payload = await request('/config');
      if (alive.current) adoptProfile(payload);
    } catch {
      if (alive.current) setProfile(undefined); // no editable settings: hide the switch
    }
  }, []);

  /**
   * Flip this workspace's trust. Leaving it trusted also clears the connection: the two go
   * together, so a switch turned off cannot leave the declarations running as a side effect.
   */
  const toggleTrust = async () => {
    const workspace = status?.workspace;
    const current = profile?.workspaces;
    if (typeof workspace !== 'string' || workspace.length === 0 || current === undefined) return;
    const trusted = current.includes(workspace);
    const next = trusted ? current.filter(item => item !== workspace) : withWorkspace(current, workspace);
    setTrusting(true);
    try {
      const saved = await request('/config', { patch: { trustedWorkspaces: next } });
      // The answer to a write is the new read, so the switches show what the profile now holds.
      if (alive.current) { adoptProfile(saved); setError(undefined); }
      await act(trusted ? 'disconnect' : 'connect');
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
      void loadProfile(); // a rejected write leaves the profile as it was
    } finally {
      if (alive.current) setTrusting(false);
    }
  };

  /**
   * Write one workspace's allowance back whole.
   *
   * The Host replaces `workspaceAllowances` rather than merging it, so this reads the profile
   * first: a write built from an older copy would silently drop an entry that another tab, or
   * the settings page, added since. The answer to the write is the new read, so it is adopted
   * here and the panel never has to guess what was stored.
   */
  const saveAllowance = async (workspace, next) => {
    const latest = await request('/config');
    const allowances = latest?.config?.workspaceAllowances ?? [];
    const saved = await request('/config', { patch: { workspaceAllowances: next(allowances) } });
    if (alive.current) adoptProfile(saved);
    return saved;
  };

  /**
   * The workspace this session's allowance is written to: the spelling the profile already uses
   * when it has a row for this directory, else the session's own workspace.
   */
  const allowanceKey = () => {
    const view = sessionAllowance(status);
    if (view.workspace !== null) return view.workspace;
    return typeof status?.workspace === 'string' && status.workspace.length > 0 ? status.workspace : null;
  };

  /**
   * Flip one server's automatic connection.
   *
   * Granting it also mounts the server now, and revoking it also drops the connection: the
   * switch is the whole decision, so turning it back off must not leave the declaration running
   * as a side effect of the earlier grant.
   */
  const toggleAllowMcp = async serverId => {
    const workspace = allowanceKey();
    if (workspace === null) return;
    const allowed = sessionAllowance(status).allowMcp.includes(serverId);
    setBusy(`allowMcp:${serverId}`);
    try {
      await saveAllowance(workspace, allowances => withAllowedServer(allowances, workspace, serverId));
      if (alive.current) setError(undefined);
      await act(allowed ? 'disconnect' : 'connect', serverId);
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
      void loadProfile();
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  /**
   * Flip one tool's approval exemption. The name written is the public tool name exactly as the
   * status row reports it; the loader matches that string, so it is never rewritten here.
   */
  const toggleAllowTool = async tool => {
    const workspace = allowanceKey();
    if (workspace === null) return;
    setBusy(`allowTool:${tool}`);
    try {
      await saveAllowance(workspace, allowances => withAllowedTool(allowances, workspace, tool));
      if (alive.current) setError(undefined);
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
      void loadProfile();
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  /**
   * Read the declaration targets: which declared servers this session may rewrite in place,
   * and which fields each one already has. Read when the panel opens and after every write; a
   * session whose sandbox cannot write reports writable:false, which the overlay shows.
   */
  const loadDeclaration = React.useCallback(async () => {
    if (sessionId === undefined) return;
    try {
      const payload = await readDeclaration(request, sessionId);
      if (alive.current) { setDeclaration(payload); setDeclarationStatus(undefined); }
    } catch (reason) {
      // A Host without this action, or a read that failed, hides the entry point: the panel
      // stays useful, and reopening it (or the reload action) retries the read.
      if (alive.current) {
        setDeclaration(undefined);
        setDeclarationStatus({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) });
      }
    }
  }, [sessionId]);

  React.useEffect(() => {
    if (!open && editing === undefined) return undefined;
    void loadDeclaration();
    return undefined;
  }, [open, editing, loadDeclaration]);

  /**
   * Write the changed fields of one declaration entry, then re-read both the targets and the
   * status: the panel has to show the new declaration instead of waiting out a poll. Returns
   * whether the write landed, so the overlay can go back to the list only when it did.
   */
  const connectSaved = async spec => {
    try {
      const current = await request(`/status?sessionId=${encodeURIComponent(sessionId)}`);
      const serverId = spec.serverId ?? (current.servers ?? []).find(row => row.source?.server === spec.name && row.source?.preset === spec.preset)?.id;
      if (serverId === undefined) throw new Error(t('panel.missingSaved'));
      const next = await request('/connect', { sessionId, serverId });
      if (alive.current) {
        setStatus(next);
        const row = next.servers?.find(item => item.id === serverId);
        setDeclarationStatus(row?.state === 'failed'
          ? { kind: 'error', text: t('panel.savedConnectFailed', { reason: row.error ?? t('error.checkStartup') }) }
          : { kind: 'ok', text: t('panel.savedAndRequested') });
      }
    } catch (error) {
      if (alive.current) setDeclarationStatus({ kind: 'error', text: t('panel.savedConnectFailed', { reason: error.message }) });
    }
  };
  const saveDeclarationTarget = async (serverId, changes, options = {}) => {
    setDeclarationBusy(true);
    try {
      await saveDeclaration(request, sessionId, serverId, changes, options.version ?? versionOfTarget(declaration, serverId), options);
      await loadDeclaration();
      if (alive.current) setDeclarationStatus({ kind: 'ok', text: t('panel.savedFields', { server: serverId, count: changes.length }) });
      await load(false);
      if (options.connect === true) await connectSaved({ serverId });
      return true;
    } catch (reason) {
      // A file that moved under the editor is the one failure this panel can answer itself:
      // re-read the targets first, then report, so the next attempt is built on what is there.
      if (reason?.code === 'DECLARATION_STALE') await loadDeclaration();
      if (alive.current) setDeclarationStatus({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) });
      return reason?.code === 'DECLARATION_CONFIRM_REQUIRED' ? 'confirm' : false;
    } finally {
      if (alive.current) setDeclarationBusy(false);
    }
  };

  /** Remove one server from the declaration file it came from, then re-read both views. */
  const removeDeclarationTarget = async (serverId, options = {}) => {
    const file = (declaration?.targets ?? []).find(target => target.serverId === serverId)?.file;
    setDeclarationBusy(true);
    try {
      await removeDeclaration(request, sessionId, serverId, options.version ?? versionOfTarget(declaration, serverId), options);
      await loadDeclaration();
      if (alive.current) setDeclarationStatus({ kind: 'ok', text: t('panel.removed', { file: file ?? t('common.declarationFile'), server: serverId }) });
      await load(false);
      return true;
    } catch (reason) {
      if (reason?.code === 'DECLARATION_STALE') await loadDeclaration();
      if (alive.current) setDeclarationStatus({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) });
      return reason?.code === 'DECLARATION_CONFIRM_REQUIRED' ? 'confirm' : false;
    } finally {
      if (alive.current) setDeclarationBusy(false);
    }
  };

  /**
   * Write one new entry into a target preset, or copy an existing entry there, then re-read both
   * the targets and the status: the list and the chooser show what the files now hold, and the
   * chip follows a declaration that started loading.
   *
   * Returns whether the write landed, and calls the one refusal apart: a name the target file
   * already holds is a question the overlay asks, not an error to report and forget.
   */
  const writeDeclarationEntry = async spec => {
    setDeclarationBusy(true);
    try {
      const result = await writeDeclaration(request, sessionId, spec);
      await loadDeclaration();
      const file = result?.file ?? spec.preset;
      if (alive.current) {
        setDeclarationStatus({ kind: 'ok', text: spec.fromServerId === undefined
          ? t('panel.created', { file: file, server: spec.name })
          : t('panel.copied', { server: spec.fromServerId, file: file, suffix: result?.removedSource === true ? t('panel.andRemovedSource') : '' }) });
      }
      await load(false);
      if (spec.connect === true) await connectSaved(spec);
      return 'ok';
    } catch (reason) {
      // The file moved under the form: re-read the targets before the next attempt, then report.
      if (reason?.code === 'DECLARATION_STALE') await loadDeclaration();
      if (alive.current) setDeclarationStatus({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) });
      return reason?.code === 'DECLARATION_EXISTS' ? 'exists'
        : reason?.code === 'DECLARATION_CONFIRM_REQUIRED' ? 'confirm' : 'failed';
    } finally {
      if (alive.current) setDeclarationBusy(false);
    }
  };

  // The switches show what the profile says, so the panel reads it when it opens.
  React.useEffect(() => {
    if (!open && editing === undefined) return undefined;
    void loadProfile();
    return undefined;
  }, [open, editing, loadProfile]);

  const openManagement = initial => {
    setDeclarationStatus(undefined); setEditing(initial); setOpen(false);
  };
  const rows = status?.servers ?? [];
  const summary = chipSummary(status, error);
  const anySelected = allSelected(status);
  /** The allowance the switches read; the write path re-reads the profile before it changes it. */
  const allowance = sessionAllowance(status);
  /** Whether the entry accepts writes at all — a profile that could not be read hides the switches. */
  const writable = profile !== undefined && profile.editable !== false;
  /** A trusted workspace loads every declaration, so one server's grant could not change anything. */
  const trusted = status?.trusted === true || profile?.mode === 'all';

  const chip = React.createElement('button', {
    ref: anchor,
    type: 'button',
    className: 'wmcp-chip',
    'data-open': open,
    'aria-expanded': open,
    'aria-label': summary.aria,
    title: error ?? (status?.workspace ?? t('common.workspaceMcp')),
    disabled: editing !== undefined,
    onClick: () => setOpen(current => !current),
  }, [
    dotElement(summary.state, 'dot'),
    React.createElement('span', { key: 'label', className: 'wmcp-count' }, summary.label),
  ]);

  if (!open && editing === undefined) return React.createElement('span', { className: 'wmcp-wrap' }, chip);

  const body = [];
  if (error !== undefined) body.push(React.createElement('p', { key: 'error', className: 'wmcp-note', 'data-kind': 'error' }, error));
  if (status === undefined) body.push(React.createElement('p', { key: 'loading', className: 'wmcp-note' }, t('panel.reading')));
  else if (rows.length === 0) body.push(React.createElement('p', { key: 'empty', className: 'wmcp-note' }, t('panel.empty')));
  else body.push(...rows.map(row => React.createElement(ServerRow, {
    key: row.id,
    row,
    allowance,
    expanded: expanded[row.id] === true,
    busy,
    trusted,
    writable,
    onToggleAllow: serverId => { void toggleAllowMcp(serverId); },
    onToggleTool: tool => { void toggleAllowTool(tool); },
    onToggleExpand: serverId => setExpanded(current => ({ ...current, [serverId]: current[serverId] !== true })),
    onAct: action => { void act(action, row.id); },
    showPolicy: false,
    onEdit: declaration?.targets?.some(target => target.serverId === row.id) ? serverId => openManagement({ mode: 'manage', serverId }) : undefined,
  })));

  const footer = React.createElement(PanelFooter, {
    key: 'foot',
    status,
    busy,
    anySelected,
    rowCount: rows.length,
    // The entry point into the declaration editor only exists once there is something to edit;
    // The reload action retries the read, so a failed one is recoverable without reopening the panel.
    declarationCount: (declaration?.targets ?? []).length,
    // A project with no declaration yet still needs the editor: that is where a new server is
    // created, so a writable preset alone is enough to keep the entry point.
    presetCount: editablePresets(declaration).length,
    // New and management are direct header actions, not buried in the footer.
    onRefresh: () => { void load(true); void loadDeclaration(); },
    onFollow: () => { void act('follow'); },
    onToggleAll: () => { void act(anySelected ? 'disconnect' : 'connect'); },
    onClose: () => setOpen(false),
  });

  /** The trust switch: on means this directory sits in `trustedWorkspaces`. */
  const allTrusted = profile?.mode === 'all';
  const workspaceTrusted = profile !== undefined
    && typeof status?.workspace === 'string'
    && profile.workspaces.includes(status.workspace);
  const trustRow = React.createElement(TrustSwitch, {
    key: 'trust',
    checked: workspaceTrusted,
    disabled: profile === undefined || allTrusted || trusting || busy !== undefined,
    label: allTrusted ? t('trust.allBadge') : t('trust.alwaysThisWorkspace'),
    hint: allTrusted
      ? t('trust.allLocked')
      : workspaceTrusted
        ? t('trust.disable')
        : t('trust.enable'),
    onToggle: () => { void toggleTrust(); },
  });

  const editor = editing === undefined ? null : React.createElement(DeclarationManager, {
    key: `manager:${sessionId}`, payload: declaration, initial: editing, workspace: status?.workspace,
    busy: declarationBusy, status: declarationStatus, returnFocus: anchor,
    onClose: () => setEditing(undefined), onReload: () => { void loadDeclaration(); void load(true); },
    onSave: saveDeclarationTarget, onRemove: removeDeclarationTarget, onWrite: writeDeclarationEntry,
    policy: React.createElement(React.Fragment, null, [trustRow, ...rows.map(row => React.createElement(ServerRow, {
      key: row.id, row, allowance, expanded: expanded[row.id] === true, busy, trusted, writable,
      onToggleAllow: serverId => { void toggleAllowMcp(serverId); }, onToggleTool: tool => { void toggleAllowTool(tool); },
      onToggleExpand: serverId => setExpanded(current => ({ ...current, [serverId]: current[serverId] !== true })),
      onAct: action => { void act(action, row.id); },
    }))]),
  });

  const panelSurface = React.createElement('div', {
    key: 'panel',
    ref: panel,
    className: 'wmcp-panel',
    role: 'dialog',
    'aria-label': t('panel.managerTitle'),
    style: rect === undefined ? { left: 12, bottom: 64 } : { left: rect.left, bottom: rect.bottom },
  }, [
    React.createElement('div', { key: 'head', className: 'wmcp-head' }, [
      React.createElement('strong', { key: 'title' }, t('common.workspaceMcp')),
      React.createElement('span', { key: 'path', className: 'wmcp-path', title: status?.workspace ?? '' }, status?.workspace ?? ''),
      React.createElement('div', { key: 'actions', className: 'wmcp-head-actions' }, [
        actionButton({ key: 'new', disabled: !canCreateEntry(declaration) || busy !== undefined,
          title: declaration?.writable === false ? declaration.reason ?? t('panel.readOnlySession') : t('panel.newServerHint'),
          onClick: () => openManagement({ mode: 'create' }) }, t('action.new')),
        actionButton({ key: 'manage', disabled: busy !== undefined, onClick: () => openManagement({ mode: 'manage' }) }, t('action.manage')),
      ]),
    ]),
    ...body,
    trustRow,
    footer,
  ]);

  // Exactly one surface is ever on screen: the editor replaces the panel rather than covering it,
  // the way the host's own pickers replace the control that opened them.
  return React.createElement('span', { className: 'wmcp-wrap' }, [
    chip,
    editing !== undefined ? editor : open ? panelSurface : null,
  ]);
}

/**
 * The panel footer: re-read the declarations, drop a manual selection, connect or drop every
 * server, close.
 *
 * The "follow policy" action only exists while the selection is pinned by hand (`selectionMode: custom`, which
 * connect and disconnect both pin): that is the one state it can leave, and a workspace that
 * already follows the policy has nothing to restore.
 */
function PanelFooter(props) {
  const { status, busy, anySelected, rowCount, declarationCount = 0, presetCount = 0, onRefresh, onFollow, onToggleAll, onEditDeclaration, onClose } = props;
  const children = [
    actionButton({ key: 'refresh', disabled: busy !== undefined, onClick: onRefresh }, t('action.reload')),
  ];
  // No editable entry and nowhere to write one means no entry point: a panel with nothing to
  // rewrite keeps the button out of the way rather than opening an overlay that can only
  // apologize. A project with no declaration at all still gets in, because that is exactly where
  // a new server is created.
  if (declarationCount > 0 && typeof onEditDeclaration === 'function') {
    children.push(actionButton({
      key: 'edit',
      disabled: busy !== undefined,
      title: t('panel.editHint', { count: declarationCount }),
      onClick: onEditDeclaration,
    }, t('action.editConfig')));
  } else if (presetCount > 0 && typeof onEditDeclaration === 'function') {
    children.push(actionButton({
      key: 'edit',
      disabled: busy !== undefined,
      title: t('panel.emptyHint', { count: presetCount }),
      onClick: onEditDeclaration,
    }, t('action.editConfig')));
  }
  children.push(React.createElement('span', { key: 'spacer', className: 'wmcp-spacer' }));
  if (status?.selectionMode === 'custom') {
    children.push(actionButton({
      key: 'follow',
      disabled: busy !== undefined,
      title: t('panel.followHint'),
      onClick: onFollow,
    }, t('action.follow')));
  }
  children.push(actionButton({
    key: 'all',
    disabled: busy !== undefined || rowCount === 0,
    title: t('panel.connectHint'),
    onClick: onToggleAll,
  }, anySelected ? t('action.disconnectAll') : t('action.connectAll')));
  children.push(actionButton({ key: 'close', onClick: onClose }, t('action.close')));
  return React.createElement('div', { key: 'foot', className: 'wmcp-foot' }, children);
}

/**
 * One switch control: a real `role="switch"` with `aria-checked`, so both directions are the
 * same gesture and assistive tech announces the state rather than a pressed button. The track
 * is drawn by our own CSS; `ariaLabel` names a switch that carries no visible text.
 */
function Switch({ checked, disabled, label, ariaLabel, hint, onToggle, className = 'wmcp-switch' }) {
  return React.createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    ...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }),
    disabled,
    className,
    title: hint,
    onClick: onToggle,
  }, [
    React.createElement('span', { key: 'track', className: 'wmcp-switch-track', 'aria-hidden': true }),
    label === undefined ? null : React.createElement('span', { key: 'label', className: 'wmcp-switch-label' }, label),
  ]);
}

/**
 * The panel's workspace-trust switch: on means this directory sits in `trustedWorkspaces`.
 */
function TrustSwitch({ checked, disabled, label, hint, onToggle }) {
  return React.createElement('div', { className: 'wmcp-trust' }, [
    React.createElement(Switch, { key: 'switch', checked, disabled, label, hint, onToggle }),
  ]);
}

/**
 * One declared server: its state, its automatic-connection switch, the manual connect action,
 * and the tool list it published once it mounted.
 *
 * The tool list holds the Host's public names (mcp__server__tool), the exact strings
 * `allowTools` stores, so nothing here rewrites one. A server that is not mounted reports no
 * tools at all, so an empty list is the hint to connect first rather than an empty box.
 */
function ServerRow(props) {
  const { row, allowance, expanded, busy, trusted, writable, onToggleAllow, onToggleTool, onToggleExpand, onAct, onEdit, showPolicy = true } = props;
  const tools = toolNames(row);
  const allowed = (allowance?.allowMcp ?? []).includes(row.id);
  const connected = row.state === 'connected';
  const rowChildren = [
    dotElement(row.state, 'dot'),
    React.createElement(onEdit === undefined ? 'span' : 'button', {
      key: 'name',
      className: onEdit === undefined ? 'wmcp-name' : 'wmcp-name wmcp-name-button',
      ...(onEdit === undefined ? {} : { type: 'button', onClick: () => onEdit(row.id), 'aria-label': t('row.editAria', { id: row.id }) }),
      title: `${row.source?.preset ?? ''} ${row.source?.file ?? ''}${row.error === undefined ? '' : ` — ${row.error}`}`,
    }, row.id),
    connected ? null : React.createElement('span', { key: 'tag', className: 'wmcp-tag' }, STATE_LABEL[row.state] ?? row.state),
    showPolicy ? React.createElement(Switch, {
      key: 'allow',
      checked: allowed,
      disabled: busy !== undefined || trusted || !writable,
      ariaLabel: t('row.autoConnectAria', { id: row.id }),
      hint: trusted
        ? t('row.trustedNote')
        : !writable
          ? t('row.settingsLocked')
          : allowed
            ? t('row.autoConnectOff', { id: row.id })
            : t('row.autoConnectOn', { id: row.id }),
      onToggle: () => onToggleAllow(row.id),
    }) : null,
    React.createElement('button', {
      key: 'more',
      type: 'button',
      className: 'wmcp-tools-trigger',
      'aria-expanded': expanded,
      'aria-label': t('row.toolsToggleAria', { action: expanded ? t('action.collapse') : t('action.expand'), id: row.id }),
      title: expanded ? t('row.toolsCollapse') : t('row.toolsExpand'),
      onClick: () => onToggleExpand(row.id),
    }, [
      React.createElement('span', { key: 'label' }, t('row.toolsCount', { count: tools.length })),
      React.createElement('span', { key: 'arrow', className: 'wmcp-tools-arrow', 'aria-hidden': true }, expanded ? '▴' : '▾'),
    ]),
    actionButton({
      key: 'act',
      disabled: busy !== undefined || row.state === 'invalid',
      title: row.state === 'invalid' ? t('row.unconvertible') : undefined,
      onClick: () => onAct(connected ? 'disconnect' : 'connect'),
    }, busy !== undefined ? '…' : connected ? t('action.disconnect') : t('action.connect')),
    onEdit === undefined ? null : actionButton({
      key: 'edit', 'aria-label': t('row.manageAria', { id: row.id }), title: t('row.manageHint'),
      disabled: busy !== undefined, onClick: () => onEdit(row.id),
    }, '⋯'),
  ];
  const children = [React.createElement('div', { key: 'row', className: 'wmcp-row' }, rowChildren)];
  if (expanded) {
    children.push(React.createElement('div', { key: 'tools', className: 'wmcp-tools' },
      tools.length === 0
        ? [React.createElement('p', { key: 'hint', className: 'wmcp-tools-hint' }, t('row.toolsAfterConnect'))]
        : tools.map(tool => {
          // The project's own include/exclude list wins over anything the user allows here: a
          // guard denies those calls after this gate, so the row reports the prohibition instead
          // of offering a switch that could never take effect.
          const forbidden = (row.disabledTools ?? []).includes(tool);
          return React.createElement('div', { key: tool, className: forbidden ? 'wmcp-tool is-forbidden' : 'wmcp-tool' }, [
            React.createElement('span', { key: 'name', className: 'wmcp-tool-name', title: tool }, tool),
            forbidden
              ? React.createElement('span', { key: 'declared', className: 'wmcp-tool-declared', title: t('row.projectDisabledHint') }, t('row.projectDisabled'))
              : React.createElement(Switch, {
                key: 'switch',
                checked: (allowance?.allowTools ?? []).includes(tool),
                disabled: busy !== undefined || !writable,
                ariaLabel: t('tool.exemptAria', { tool: tool }),
                hint: (allowance?.allowTools ?? []).includes(tool)
                  ? t('tool.exemptOff', { tool: tool })
                  : t('tool.exemptOn', { tool: tool }),
                onToggle: () => onToggleTool(tool),
              }),
          ]);
        })));
  }
  return React.createElement('div', { className: 'wmcp-item' }, children);
}

/** The host's compact ghost button; `variant: 'primary'` is its filled action. */
function actionButton({ key, variant = 'ghost', ...props }, children) {
  return React.createElement('button', {
    ...props,
    key,
    type: 'button',
    'data-variant': variant,
    className: 'wmcp-act',
  }, children);
}

/* ── Declaration editor: rewrite the known fields of one declared server ─────── */

/** The one route that lists, saves and removes declaration entries. */
const DECLARATION_PATH = '/declaration';
const TOML_WARNING = t('toml.lossyWarning');
/** A field's draft shape comes from the Host's kind, never from its name. */
const fieldKind = field => (field?.kind === 'choice' ? 'choice'
  : field?.kind === 'list' ? 'list' : field?.kind === 'map' ? 'map' : 'text');
/**
 * What each kind is, and how its draft is typed on — the draft is not the stored value.
 *
 * Only the kinds whose editing is not self-evident get a caption and a hint. A plain text field
 * needs neither: its name is the label and the box is the control.
 */
const KIND_LABEL = { list: t('field.kind.list'), map: t('field.kind.map'), choice: t('field.transport') };
const KIND_HINT = {
  list: t('field.help.list'),
  map: t('field.help.mapStrings'),
  // The Host owns this vocabulary: the transport says what the loader will connect with, and a
  // value outside it does not degrade — the loader rejects the whole entry.
  choice: t('field.help.transport'),
};

/** One field as the text the user edits: verbatim text, one list item per line, JSON map. */
function draftOfField(field) {
  const kind = fieldKind(field);
  if (kind === 'list') return (Array.isArray(field?.value) ? field.value : []).map(item => String(item)).join('\n');
  if (kind === 'map') return field?.value === undefined ? '' : JSON.stringify(field.value, null, 2);
  return field?.value === undefined || field?.value === null ? '' : String(field.value);
}

/**
 * The segments of one choice field: the Host's options, the current value when the Host did not
 * list it (an older declaration can spell a transport the loader no longer offers, and showing it
 * verbatim is the only honest rendering), and an explicit blank where the field may be left alone.
 */
function choiceOptions(field, current, blank) {
  const options = (field?.options ?? []).filter(option => typeof option === 'string' && option.length > 0);
  if (typeof current === 'string' && current.length > 0 && !options.includes(current)) options.unshift(current);
  return blank === true ? ['', ...options] : options;
}

/** Every draft a target opens with, keyed by the field name the Host reported. */
const draftsOfTarget = target => Object.fromEntries((target?.fields ?? []).map(field => [field.name, draftOfField(field)]));

/**
 * One draft as the JSON value the Host stores for that kind. A map that is not an object of
 * strings is a user error, not a silent rewrite: the save is blocked until it is fixed.
 */
function valueOfDraft(field, draft) {
  const kind = fieldKind(field);
  if (kind === 'list') return linesOf(String(draft ?? ''));
  if (kind !== 'map') return String(draft ?? '');
  const text = String(draft ?? '').trim();
  let value;
  try { value = JSON.parse(text.length === 0 ? '{}' : text); }
  catch { throw new Error(t('field.error.notJson', { name: field?.name ?? t('common.field') })); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('field.error.notObject', { name: field?.name ?? t('common.field') }));
  for (const item of Object.values(value)) {
    if (typeof item !== 'string' && !(field?.name === 'env' && typeof item === 'number' && Number.isFinite(item))) {
      throw new Error(t('field.error.mustBeString', { name: field?.name ?? t('common.field'), extra: field?.name === 'env' ? t('field.error.orFiniteNumber') : '' }));
    }
  }
  return value;
}

/** A UI-only picker is also available for dialects that infer transport from command / URL. */
const UI_TRANSPORT = { name: '$transport', kind: 'choice', options: ['stdio', 'http'] };
const connectionTransport = drafts => {
  const explicit = drafts?.$transport || drafts?.transport;
  if (explicit) return explicit === 'streamable-http' ? 'http' : explicit;
  return hasText(drafts?.command) ? 'stdio' : hasText(drafts?.url) ? 'http' : 'stdio';
};
const inactiveField = (name, transport) => transport === 'http'
  ? ['command', 'args', 'env', 'cwd'].includes(name)
  : transport === 'stdio' ? ['url', 'headers'].includes(name) : false;
const visibleFields = (fields, drafts) => {
  const picker = fields.find(field => field.name === 'transport') ?? UI_TRANSPORT;
  return [picker, ...fields.filter(field => field !== picker && !inactiveField(field.name, connectionTransport(drafts)))];
};
const pickerDraft = (field, drafts) => field.name === '$transport' ? connectionTransport(drafts) : drafts?.[field.name] ?? '';

/** Whether a value the declaration already holds is something "clear" can erase. */
const hasStoredValue = value => (typeof value === 'string' ? value.length > 0
  : Array.isArray(value) ? value.length > 0
    : value !== null && typeof value === 'object' ? Object.keys(value).length > 0 : false);

/**
 * Only the fields the user changed, in the order the Host listed them, each already in the
 * JSON shape its kind requires. A field the Host did not report cannot be submitted at all:
 * the route rejects an unknown name, so it never reaches the wire from here.
 *
 * Emptying a box that held something is a change of its own: `null` deletes the key. That is the
 * only way to stop naming a `url` when an entry turns local — writing an empty string there would
 * leave a declaration the loader rejects, and the write would be rolled back whole.
 */
function changesOfTarget(target, drafts) {
  const changes = [];
  const transport = connectionTransport(drafts);
  const switched = transport !== connectionTransport(draftsOfTarget(target));
  for (const field of target?.fields ?? []) {
    if (inactiveField(field.name, transport)) {
      if (switched && field.value !== undefined) changes.push({ name: field.name, value: null });
      continue;
    }
    const draft = drafts?.[field.name];
    if (typeof draft !== 'string' || draft === draftOfField(field)) continue;
    if (draft.trim().length === 0 && (hasStoredValue(field?.value) || field.value !== undefined)) {
      changes.push({ name: field.name, value: null });
      continue;
    }
    const value = valueOfDraft(field, draft);
    if (JSON.stringify(value) === JSON.stringify(field?.value)) continue;
    changes.push({ name: field.name, value });
  }
  return changes;
}

/** `list`: the servers this session may rewrite in place, with the fields each one already has. */
const readDeclaration = (send, sessionId) => send(DECLARATION_PATH, { sessionId, action: 'list' });
/**
 * `save`: the changed fields of one entry, already in their stored JSON shape.
 *
 * `version` is the token the listing was read with. Sending it back turns "the file moved while I
 * was typing" into a conflict the Host reports, instead of a field quietly overwritten.
 */
const saveDeclaration = (send, sessionId, serverId, changes, version, options = {}) => send(DECLARATION_PATH, {
  sessionId, action: 'save', serverId, changes, ...(version === undefined ? {} : { version }),
  ...(options.allowLossy === true ? { allowLossy: true } : {}),
});
/** `remove`: drop this server from the declaration file it came from. */
const removeDeclaration = (send, sessionId, serverId, version, options = {}) => send(DECLARATION_PATH, {
  sessionId, action: 'remove', serverId, ...(version === undefined ? {} : { version }),
  ...(options.allowLossy === true ? { allowLossy: true } : {}),
});
/** The version token of one listed target, when the Host offered one. */
const versionOfTarget = (declaration, serverId) => (declaration?.targets ?? []).find(target => target.serverId === serverId)?.version;
/**
 * The canonical fields a write may carry, each with the draft shape its kind is edited as.
 *
 * This is the fallback, not the order: a Host that reports `presets[].fields` decides both the
 * names and their order (`url` first, `transport` second, and nothing a dialect cannot write).
 * An older Host that reports no fields still opens a usable form instead of an empty one.
 */
const WRITE_FIELDS = [
  { name: 'command', kind: 'text' },
  { name: 'args', kind: 'list' },
  { name: 'env', kind: 'map' },
  { name: 'cwd', kind: 'text' },
  { name: 'url', kind: 'text' },
  { name: 'headers', kind: 'map' },
];
/**
 * The fields one form offers, in the order the Host reported them, never re-sorted here.
 *
 * `url` leads because for a remote entry it is the whole declaration, and `transport` follows so the
 * "how do we connect" answer sits right under the address it belongs to. A dialect that cannot
 * write a field — Codex' TOML has no transport key, Gemini infers it from the address — does not
 * list it at all, so the form simply does not offer what the file has nowhere to put.
 */
const presetFields = preset => {
  const fields = (preset?.fields ?? []).filter(field => typeof field?.name === 'string' && field.name.length > 0);
  return fields.length === 0 ? WRITE_FIELDS : fields;
};
/**
 * `write`: one new entry in a target preset, optionally carrying the fields of an existing entry.
 *
 * Every optional key is either on the wire with the meaning the user chose, or absent: a
 * `removeSource: false` or `overwrite: false` would be a different request than saying nothing at
 * all, and the defaults belong to the Host.
 */
const writeDeclaration = (send, sessionId, spec) => send(DECLARATION_PATH, {
  sessionId,
  action: 'write',
  preset: spec.preset,
  name: spec.name,
  fields: spec.fields ?? [],
  ...(spec.fromServerId === undefined ? {} : { fromServerId: spec.fromServerId }),
  ...(spec.removeSource === true ? { removeSource: true } : {}),
  ...(spec.overwrite === true ? { overwrite: true } : {}),
  ...(spec.allowLossy === true ? { allowLossy: true } : {}),
});
/** One preset's files as the chooser spells them. */
const presetWhere = preset => (preset?.files ?? [])
  .filter(file => typeof file === 'string' && file.length > 0).join(t('common.listSeparator'));
/** The presets this session may write into: the Host decides, this only reads the flag. */
const editablePresets = payload => (payload?.presets ?? []).filter(preset => preset?.editable !== false);
/** The presets an existing entry can be copied into: another one, never the file it is already in. */
const copyPresets = (payload, source) => editablePresets(payload).filter(preset => preset?.id !== source?.preset);
/**
 * The chooser's rows: every preset, so a refused one can state its reason, minus the entry's own
 * preset when copying. A preset the Host marked uneditable is never filtered out — hiding it
 * would leave the user wondering why the file they want is not on the list.
 */
const presetsFor = (payload, mode, source) => (payload?.presets ?? [])
  .filter(preset => mode !== 'copy' || preset?.id !== source?.preset);
/** Whether the list offers a new entry at all: the session may write, and some preset accepts it. */
const canCreateEntry = payload => payload?.writable !== false && editablePresets(payload).length > 0;
/** Whether one entry can be copied elsewhere: the same rule, plus another preset to land in. */
const canCopyEntry = (payload, target) => payload?.writable !== false && copyPresets(payload, target).length > 0;
/** A blank write form: every field this preset takes, nothing filled in. */
const emptyWriteDrafts = (fields) => Object.fromEntries((fields ?? WRITE_FIELDS).map(field => [field.name, '']));
/** The write form prefilled from one existing entry; a field it does not carry opens blank. */
const writeDraftsFrom = (source, fields) => Object.fromEntries((fields ?? WRITE_FIELDS).map(field => {
  const found = (source?.fields ?? []).find(item => item.name === field.name);
  return [field.name, found === undefined ? '' : draftOfField(found)];
}));
/**
 * The fields one write carries: the ones the user filled in, in the Host's own order.
 *
 * An empty draft is a field the user did not set, so it is left out instead of sent as an empty
 * value. The exception is the box the user emptied after it opened with something: that is
 * `{ value: null }`, the key is deleted. Dropping it instead is what breaks a conversion — a copy
 * would keep the source entry's `url` beside its `stdio` command, and the Host would find the
 * rewritten declaration unloadable and roll the whole write back. A draft that cannot be parsed
 * throws, and the form blocks the submit rather than writing something unintended.
 */
function writeFieldsOf(drafts, fields, baseline) {
  const out = [];
  for (const spec of fields ?? WRITE_FIELDS) {
    if (inactiveField(spec.name, connectionTransport(drafts))) {
      if (hasText(baseline?.[spec.name])) out.push({ name: spec.name, value: null });
      continue;
    }
    const draft = drafts?.[spec.name];
    if (typeof draft !== 'string') continue;
    if (draft.trim().length === 0) {
      if (hasText(baseline?.[spec.name])) out.push({ name: spec.name, value: null });
      continue;
    }
    out.push({ name: spec.name, value: valueOfDraft(spec, draft) });
  }
  return out;
}
/** Why the form cannot be submitted yet: the Host needs a name, and an entry needs a field. */
const writeBlocked = (name, fields, transport) => {
  if (String(name ?? '').trim().length === 0) return t('write.error.nameRequired');
  if ((fields ?? []).length === 0) return t('write.error.empty');
  const values = Object.fromEntries(fields.map(field => [field.name, field.value]));
  const mode = transport ?? connectionTransport(values);
  if (mode === 'stdio' && !hasText(values.command)) return t('write.error.commandRequired');
  if (mode === 'http' && !hasText(values.url)) return t('write.error.urlRequired');
  return undefined;
};
/** Whether a draft a form opened with carried anything: what one emptied box has to delete. */
const hasText = draft => typeof draft === 'string' && draft.trim().length > 0;
/** The field specs one open write form offers: the list it opened with, else the preset's own. */
const formFieldsOf = form => form?.fields ?? presetFields(form?.preset);
/**
 * The drafts one open write form opened with, which a cleared box is measured against.
 *
 * The overlay records this when the form opens; deriving it covers a form built by hand (a test,
 * or an older caller), where the only thing that could have had a value is the source entry.
 */
const formBaselineOf = (form, fields) => form?.baseline
  ?? (form?.source === undefined ? emptyWriteDrafts(fields) : writeDraftsFrom(form.source, fields));
/**
 * The write one filled-in form asks for: the chosen preset and name, the fields the user left
 * filled in, and only the optional keys this form actually chose. `action` and `sessionId` are
 * added by `writeDeclaration`, so this is the whole of what the form contributes.
 */
const writeSpecOf = (form, overwrite) => {
  const fields = formFieldsOf(form);
  return {
    preset: form.preset.id,
    name: form.name.trim(),
    fields: writeFieldsOf(form.drafts, fields, formBaselineOf(form, fields)),
    ...(form.source === undefined ? {} : { fromServerId: form.source.serverId }),
    ...(form.removeSource === true ? { removeSource: true } : {}),
    ...(overwrite === true ? { overwrite: true } : {}),
  };
};
/** A pointer on the scrim itself — never on the dialog — dismisses the overlay. */
const scrimDismiss = onClose => event => { if (event.target === event.currentTarget) onClose(); };

/** The one dialog container every view of the overlay shares. */
const dialogSurface = (label, children, role = 'dialog') => React.createElement('div', {
  className: 'wmcp-dialog',
  role,
  ...(role === 'region' ? {} : { 'aria-modal': true }),
  'aria-label': label,
}, children);

/** A server id and where it was declared, as every view of the overlay spells it. */
const whereOf = target => [target?.preset, target?.file]
  .filter(part => typeof part === 'string' && part.length > 0).join(t('common.dotSeparator'));

/**
 * One field of a form: its label, the control its kind is edited with, and the hint that says how.
 *
 * Both forms render the same control for the same kind, so a value typed on one path means the same
 * thing on the other. `allowBlank` is the one thing they disagree on: a brand-new entry may leave
 * its transport unset and let the Host infer it from url / command.
 */
const mapStateOf = (field, draft) => {
  try {
    const value = valueOfDraft(field, draft);
    return { mode: 'rows', rows: Object.entries(value).map(([key, value]) => ({ key, value })), lastDraft: draft, dirty: false };
  } catch { return { mode: 'json', rows: [], lastDraft: draft, dirty: false }; }
};
/** Validate before Object.fromEntries: duplicate keys must not silently overwrite credentials. */
const draftOfMapRows = rows => {
  const used = new Set();
  const entries = [];
  for (const row of rows) {
    if (row.key.length === 0 && row.value === '') continue;
    if (row.key.trim().length === 0) throw new Error(t('field.error.keyRequired'));
    if (used.has(row.key)) throw new Error(t('field.error.duplicateKey', { key: row.key }));
    used.add(row.key); entries.push([row.key, row.value]);
  }
  return entries.length === 0 ? '' : JSON.stringify(Object.fromEntries(entries), null, 2);
};

function MapField({ field, draft = '', disabled, onChange, mapState, onMapState }) {
  const [local, setLocal] = React.useState(() => mapStateOf(field, draft));
  const [revealed, setRevealed] = React.useState(false);
  const state = mapState ?? local;
  const adopt = next => { setLocal(next); onMapState?.(field.name, next); };
  React.useEffect(() => {
    if (state.lastDraft !== draft) adopt(mapStateOf(field, draft));
  }, [draft]);
  const updateRows = rows => {
    let text;
    try { text = draftOfMapRows(rows); }
    catch (error) { adopt({ ...state, rows, dirty: true, problem: error.message }); return; }
    adopt({ ...state, rows, lastDraft: text, dirty: true, problem: undefined });
    onChange(field.name, text);
  };
  const rowsMode = state.mode === 'rows';
  const children = [React.createElement('div', { key: 'bar', className: 'wmcp-map-bar' }, [
    React.createElement('span', { key: 'hint', className: 'wmcp-hint' }, rowsMode ? t('field.help.textMode') : t('field.help.jsonMode')),
    React.createElement('span', { key: 'space', className: 'wmcp-spacer' }),
    actionButton({ key: 'mode', disabled, onClick: () => {
      if (rowsMode) {
        if (state.problem !== undefined) return;
        adopt({ ...state, mode: 'json' });
      } else {
        try { const value = valueOfDraft(field, draft); adopt({ ...state, mode: 'rows', rows: Object.entries(value).map(([key, value]) => ({ key, value })), problem: undefined }); }
        catch (error) { adopt({ ...state, problem: error.message }); }
      }
    } }, rowsMode ? t('field.mode.json') : t('field.mode.text')),
    rowsMode ? actionButton({ key: 'reveal', disabled, 'aria-pressed': revealed, onClick: () => setRevealed(value => !value) }, revealed ? t('field.hideValues') : t('field.showValues')) : null,
  ])];
  if (rowsMode) {
    children.push(...state.rows.map((row, index) => React.createElement('div', { key: index, className: 'wmcp-map-row' }, [
      React.createElement('input', { key: 'key', type: 'text', value: row.key, disabled, spellCheck: false, autoComplete: 'off',
        placeholder: field.name === 'headers' ? t('field.placeholder.header') : t('field.placeholder.env'), 'aria-label': t('field.row.keyAria', { field: field.name, row: index + 1 }),
        onChange: event => updateRows(state.rows.map((item, at) => at === index ? { ...item, key: event.target.value } : item)) }),
      React.createElement('input', { key: 'value', type: revealed ? 'text' : 'password', value: String(row.value), disabled, spellCheck: false, autoComplete: 'off',
        placeholder: t('field.row.value'), 'aria-label': t('field.row.valueAria', { field: field.name, row: index + 1 }),
        onChange: event => updateRows(state.rows.map((item, at) => at === index ? { ...item, value: event.target.value } : item)) }),
      actionButton({ key: 'remove', disabled, 'aria-label': t('field.row.removeAria', { field: field.name, row: index + 1 }), onClick: () => updateRows(state.rows.filter((_item, at) => at !== index)) }, t('action.delete')),
    ])));
    children.push(actionButton({ key: 'add', disabled, onClick: () => updateRows([...state.rows, { key: '', value: '' }]) }, field.name === 'headers' ? t('field.addHeader') : t('field.addEnv')));
  } else children.push(React.createElement('textarea', { key: 'json', value: draft, disabled, spellCheck: false, 'aria-label': `${field.name} JSON`,
    onChange: event => { adopt({ ...state, lastDraft: event.target.value, dirty: true, problem: undefined }); onChange(field.name, event.target.value); } }));
  let displayedProblem = state.problem;
  if (!rowsMode) {
    try { valueOfDraft(field, draft); } catch (error) { displayedProblem = error.message; }
  }
  if (displayedProblem !== undefined) children.push(React.createElement('p', { key: 'problem', className: 'wmcp-manager-error', role: 'alert' }, displayedProblem));
  return React.createElement('div', { className: 'wmcp-map' }, children);
}

function fieldRow({ field, draft, disabled, allowBlank, onChange, mapState, onMapState, friendly = false }) {
  const kind = fieldKind(field);
  const labels = { transport: t('field.transportLabel'), $transport: t('field.transportLabel'), command: t('field.command'), args: t('field.args'), env: t('field.env'), cwd: t('field.cwd'), url: t('field.url'), headers: t('field.headers') };
  const caption = friendly ? labels[field.name] ?? field.name
    : field.name === '$transport' ? t('field.transportLabel') : kind === 'text' ? field.name : t('field.labelWithKind', { field: field.name, kind: KIND_LABEL[kind] });
  const hint = field.name === '$transport' ? t('field.help.transportUi')
    : field.name === 'transport' ? t('field.help.transportSwitch')
      : field.name === 'command' ? t('field.help.command')
        : field.name === 'env' ? t('field.help.mapValues') : KIND_HINT[kind];
  return React.createElement(friendly ? 'div' : 'label', { key: field.name, className: 'wmcp-field-row', ...(friendly ? { role: 'group', 'aria-label': caption } : {}) }, [
    React.createElement('span', { key: 'name' }, caption),
    kind === 'map' && friendly
      ? React.createElement(MapField, { key: 'value', field, draft, disabled, onChange, mapState, onMapState })
      : fieldControl({ field, draft, disabled, allowBlank, onChange, friendly }),
    ...(hint === undefined || (friendly && kind === 'map') ? [] : [React.createElement('span', { key: 'hint', className: 'wmcp-hint' }, hint)]),
  ]);
}

/**
 * The control one field is edited with, from its kind alone.
 *
 * A choice is drawn here rather than borrowed from the host: its options and their order are the
 * Host's, its value is a plain string, and an option the Host did not list is still offered as
 * itself — the current spelling of an older declaration must stay selectable, or merely opening
 * the entry would move it.
 */
function fieldControl({ field, draft, disabled, allowBlank, onChange, friendly = false }) {
  const kind = fieldKind(field);
  const value = typeof draft === 'string' ? draft : '';
  if (kind === 'choice') {
    return React.createElement('div', {
      key: 'value',
      className: 'wmcp-choice',
      role: 'group',
      'aria-label': field.name,
    }, choiceOptions(field, value, allowBlank === true).map(option => React.createElement('button', {
      key: option.length === 0 ? 'unset' : option,
      type: 'button',
      className: 'wmcp-choice-option',
      'data-value': option,
      'aria-pressed': value === option,
      disabled: disabled === true,
      title: option.length === 0 ? t('field.transportUnset') : option,
      onClick: () => onChange(field.name, option),
    }, option.length === 0 ? t('field.transportUnsetShort') : friendly ? ({ stdio: t('field.transportStdio'), http: t('field.transportHttp') }[option] ?? option) : option)));
  }
  return kind === 'text'
    ? React.createElement('input', {
      key: 'value',
      type: 'text',
      value,
      disabled: disabled === true,
      spellCheck: false,
      'aria-label': field.name,
      placeholder: { command: t('field.placeholder.command'), url: 'https://example.com/mcp', cwd: t('field.placeholder.cwd') }[field.name],
      onChange: event => onChange(field.name, event.target.value),
    })
    : React.createElement('textarea', {
      key: 'value',
      value,
      disabled: disabled === true,
      spellCheck: false,
      'aria-label': field.name,
      placeholder: field.name === 'args' ? '-y\n@your-org/mcp-server' : undefined,
      onChange: event => onChange(field.name, event.target.value),
    });
}

/**
 * The overlay's first view: every declaration entry this session may rewrite. An entry that
 * cannot be rewritten in place is listed with its reason instead of hidden — the user should
 * learn which file is read-only, not wonder where it went.
 */
function DeclarationListView(props) {
  const { payload, status, busy, canCreate, onOpen, onNew, onReload, onClose } = props;
  const targets = payload?.targets ?? [];
  const children = [
    React.createElement('div', { key: 'head', className: 'wmcp-dialog-head' }, [
      React.createElement('strong', { key: 'title' }, t('action.editConfig')),
      React.createElement('span', { key: 'spacer', className: 'wmcp-spacer' }),
      React.createElement('span', { key: 'count', className: 'wmcp-tag' }, t('common.itemsCount', { count: targets.length })),
    ]),
  ];
  if (status !== undefined) children.push(React.createElement('p', { key: 'status', className: 'wmcp-dialog-note', 'data-kind': status.kind }, status.text));
  // A read-only session cannot write any of this, so the whole overlay says so up front.
  if (payload?.writable === false) children.push(React.createElement('p', { key: 'session', className: 'wmcp-dialog-note' },
    t('panel.cannotWrite', { reason: payload.reason ?? t('panel.sandboxReadOnly') })));
  if (payload === undefined) children.push(React.createElement('p', { key: 'loading', className: 'wmcp-dialog-note' }, t('manager.readingDeclarations')));
  else if (targets.length === 0) children.push(React.createElement('p', { key: 'empty', className: 'wmcp-dialog-note' }, t('manager.noEditableDeclarations')));
  else children.push(React.createElement('ul', { key: 'list', className: 'wmcp-entries' }, targets.map(target => React.createElement('li', { key: target.serverId },
    React.createElement('button', {
      type: 'button',
      className: 'wmcp-entry',
      title: `${target.serverId} — ${whereOf(target)}`,
      onClick: () => onOpen(target),
    }, [
      React.createElement('span', { key: 'id', className: 'wmcp-entry-id' }, target.serverId),
      React.createElement('span', { key: 'where', className: 'wmcp-entry-where' }, whereOf(target)),
      target.editable === false
        ? React.createElement('span', { key: 'tag', className: 'wmcp-tag', title: target.reason ?? '' }, t('common.readOnly'))
        : React.createElement('span', { key: 'tag', className: 'wmcp-tag' }, t('manager.fieldCount', { count: (target.fields ?? []).length })),
    ])))));
  const foot = [];
  // A new entry needs a preset that accepts writes: without one the button would only be able to
  // apologize, so it stays away until the config says where a new server could land.
  if (canCreate === true && typeof onNew === 'function') {
    foot.push(actionButton({
      key: 'new',
      disabled: busy === true,
      title: t('manager.createHint'),
      onClick: onNew,
    }, t('manager.newServer')));
  }
  foot.push(React.createElement('span', { key: 'spacer', className: 'wmcp-spacer' }));
  foot.push(actionButton({ key: 'reload', disabled: busy === true, onClick: onReload }, t('action.reload')));
  foot.push(actionButton({ key: 'close', onClick: onClose }, t('action.close')));
  children.push(React.createElement('div', { key: 'foot', className: 'wmcp-dialog-foot' }, foot));
  return dialogSurface(t('manager.editTitle'), children);
}

/**
 * One entry's known fields, as the drafts the user edits.
 *
 * The draft is not the stored value: a list is one item per line and a map is JSON, so the hint
 * under each field spells the format out. A read-only entry — an unsupported format, or a
 * session whose sandbox cannot write — offers neither save nor delete and states why.
 */
function DeclarationEditorView(props) {
  const { target, drafts, editable, reason, busy, status, problem, changeCount, copyable, onChange, onBack, onCopy, onDelete, onSave } = props;
  const fields = visibleFields(target?.fields ?? [], drafts);
  const children = [
    React.createElement('div', { key: 'head', className: 'wmcp-dialog-head' }, [
      React.createElement('strong', { key: 'title' }, t('manager.declarationOf', { server: target.serverId })),
      React.createElement('span', { key: 'spacer', className: 'wmcp-spacer' }),
      React.createElement('span', { key: 'where', className: 'wmcp-entry-where', title: target.file ?? '' }, whereOf(target)),
    ]),
  ];
  if (!editable) children.push(React.createElement('p', { key: 'readonly', className: 'wmcp-dialog-note' },
    t('manager.readOnlyReason', { reason: reason ?? t('manager.notEditable') })));
  if (fields.length === 0) children.push(React.createElement('p', { key: 'nofields', className: 'wmcp-dialog-note' },
    t('manager.noEditableFields')));
  for (const field of fields) {
    children.push(fieldRow({
      field,
      draft: pickerDraft(field, drafts),
      disabled: !editable || busy === true,
      // An entry that already exists keeps a transport: unsetting it would delete the key from a
      // declaration that still has to load, and "no transport" is not a state its file can hold.
      allowBlank: false,
      onChange,
      friendly: props.embedded === true,
      mapState: props.maps?.[field.name], onMapState: props.onMapState,
    }));
  }
  // Copying out is not rewriting in place: the entry being read may be read-only, and the write
  // lands in another preset, so only the session's own writability has to hold here.
  if (copyable === true && typeof onCopy === 'function') {
    children.push(React.createElement('div', { key: 'copy', className: 'wmcp-actions' }, [
      actionButton({
        key: 'copy',
        disabled: busy === true,
        title: t('manager.copyHint'),
        onClick: onCopy,
      }, props.embedded ? t('manager.copyToOther') : t('manager.copyToPreset')),
    ]));
  }
  if (problem !== undefined) children.push(React.createElement('p', { key: 'problem', className: 'wmcp-dialog-note', 'data-kind': 'error' }, problem));
  if (status !== undefined) children.push(React.createElement('p', { key: 'status', className: 'wmcp-dialog-note', 'data-kind': status.kind }, status.text));
  if (target.lossy === true || target.format === 'toml') children.push(React.createElement('p', { key: 'toml', className: 'wmcp-warning' }, TOML_WARNING));
  const foot = [actionButton({ key: 'back', disabled: busy === true, onClick: onBack }, props.embedded ? t('action.cancelEdit') : t('action.backToList'))];
  foot.push(React.createElement('span', { key: 'spacer', className: 'wmcp-spacer' }));
  if (editable) {
    foot.push(React.createElement('span', { key: 'hint', className: 'wmcp-hint' },
      changeCount === 0 ? t('manager.noChanges') : t('manager.willSubmit', { count: changeCount })));
    foot.push(actionButton({
      key: 'del',
      disabled: busy === true,
      style: { color: 'var(--dsw-alias-state-error-primary)' },
      onClick: onDelete,
    }, t('action.delete')));
    if (props.onSaveConnect !== undefined) foot.push(actionButton({
      key: 'save-connect', disabled: busy === true || problem !== undefined || changeCount === 0,
      title: t('action.saveAndConnectHint'), onClick: props.onSaveConnect,
    }, t('action.saveAndConnect')));
    foot.push(actionButton({
      key: 'save',
      variant: 'primary',
      disabled: busy === true || problem !== undefined || changeCount === 0,
      onClick: onSave,
    }, busy === true ? t('action.saving') : t('action.save')));
  }
  children.push(React.createElement('div', { key: 'foot', className: 'wmcp-dialog-foot' }, foot));
  return dialogSurface(t('manager.editConfigOf', { server: target.serverId }), children, props.embedded ? 'region' : 'dialog');
}

/**
 * The second ask before a delete, in the same surface: never a host dialog, and never a delete
 * that a stray click can complete.
 */
function DeclarationConfirmView(props) {
  const { target, busy, onCancel, onConfirm } = props;
  return dialogSurface(t('manager.removeOf', { server: target.serverId }), [
    React.createElement('strong', { key: 'title' }, t('manager.removeShort', { server: target.serverId })),
    React.createElement('p', { key: 'note', className: 'wmcp-dialog-note' },
      t('manager.removeConfirm', { file: target.file ?? t('common.declarationFile') })),
    React.createElement('p', { key: 'where', className: 'wmcp-hint' }, whereOf(target)),
    React.createElement('div', { key: 'foot', className: 'wmcp-dialog-foot' }, [
      actionButton({ key: 'cancel', disabled: busy === true, onClick: onCancel }, t('action.cancel')),
      React.createElement('span', { key: 'spacer', className: 'wmcp-spacer' }),
      actionButton({ key: 'confirm', variant: 'primary', disabled: busy === true, onClick: onConfirm },
        busy === true ? t('action.removing') : t('action.confirmRemove')),
    ]),
  ], 'alertdialog');
}

/**
 * The target-preset chooser: the one step between "new server" (or "copy to another preset") and the form.
 *
 * Every preset is listed, the refused ones included: a file that cannot be written from here says
 * why instead of vanishing from the list, and a refused row is never clickable.
 */
function PresetPickView(props) {
  const { mode, presets, busy, status, onPick, onBack } = props;
  const copy = mode === 'copy';
  const list = presets ?? [];
  const title = copy ? t('manager.copyToPreset') : t('manager.newServer');
  const children = [
    React.createElement('div', { key: 'head', className: 'wmcp-dialog-head' }, [
      React.createElement('strong', { key: 'title' }, title),
      React.createElement('span', { key: 'spacer', className: 'wmcp-spacer' }),
      React.createElement('span', { key: 'count', className: 'wmcp-tag' }, t('common.presetsCount', { count: list.length })),
    ]),
    React.createElement('p', { key: 'note', className: 'wmcp-dialog-note' },
      copy
        ? t('manager.choosePresetCopy')
        : t('manager.choosePresetNew')),
  ];
  if (status !== undefined) children.push(React.createElement('p', { key: 'status', className: 'wmcp-dialog-note', 'data-kind': status.kind }, status.text));
  if (list.length === 0) children.push(React.createElement('p', { key: 'empty', className: 'wmcp-dialog-note' }, t('manager.noWritablePreset')));
  else children.push(React.createElement('ul', { key: 'list', className: 'wmcp-entries' }, list.map((preset, index) => {
    // The Host owns this decision: a preset it marked uneditable is shown with its reason, never
    // re-tested here — a TOML file may be writable exactly while it does not exist yet.
    const writable = preset?.editable !== false;
    return React.createElement('li', { key: preset?.id ?? index },
      React.createElement('button', {
        type: 'button',
        className: 'wmcp-entry wmcp-preset',
        disabled: !writable || busy === true,
        title: writable ? t('manager.writeInto', { target: presetWhere(preset) }) : (preset?.reason ?? t('manager.presetLocked')),
        onClick: () => onPick(preset),
      }, [
        React.createElement('span', { key: 'line', className: 'wmcp-preset-line' }, [
          React.createElement('span', { key: 'id', className: 'wmcp-entry-id' }, preset?.id ?? ''),
          React.createElement('span', { key: 'where', className: 'wmcp-entry-where' }, presetWhere(preset)),
          React.createElement('span', { key: 'tag', className: 'wmcp-tag wmcp-entry-tag' },
            writable ? (preset?.builtin === true ? t('common.builtin') : t('common.custom')) : t('common.notWritable')),
        ]),
        writable ? null : React.createElement('span', { key: 'reason', className: 'wmcp-preset-reason' },
          preset?.reason ?? t('manager.presetLocked')),
      ]));
  })));
  children.push(React.createElement('div', { key: 'foot', className: 'wmcp-dialog-foot' }, [
    actionButton({ key: 'back', disabled: busy === true, onClick: onBack }, t('action.back')),
  ]));
  return dialogSurface(title, children);
}

/**
 * The write form: one new server entry, or an existing one copied into another preset.
 *
 * The mode changes the header, whether the fields open prefilled and whether the
 * "delete the original entry after copying" box is offered; the fields are the ones the chosen preset reports, in its own
 * order and kinds, in the same draft shapes the editor uses — so a value means the same thing on
 * both paths, and a dialect that has nowhere to put a field is never asked for one.
 */
const presetLabel = preset => ({ root: t('manager.projectConfig'), vscode: 'VS Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini' }[preset?.id] ?? preset?.id ?? t('manager.configLocation'));
function ConfigLocation({ preset, presets, disabled, onChange }) {
  return React.createElement('div', { className: 'wmcp-location' }, [
    React.createElement('label', { key: 'label', className: 'wmcp-field-row' }, [
      React.createElement('span', { key: 'title' }, t('manager.configLocation')),
      React.createElement('select', { key: 'select', 'aria-label': t('manager.configLocation'), value: preset?.id ?? '', disabled,
        onChange: event => onChange((presets ?? []).find(item => item.id === event.target.value)) },
      (presets ?? []).map(item => React.createElement('option', { key: item.id, value: item.id, disabled: item.editable === false },
        t('manager.presetOption', { label: presetLabel(item), where: presetWhere(item), reason: item.editable === false ? t('manager.presetReasonParen', { reason: item.reason ?? t('common.notWritable') }) : '' })))),
    ]),
    React.createElement('span', { key: 'path', className: 'wmcp-location-path' }, t('manager.willWrite', { file: preset?.files?.[0] ?? t('manager.noFileSelected') })),
    preset?.lossy === true || preset?.format === 'toml'
      ? React.createElement('p', { key: 'warning', className: 'wmcp-warning' }, preset?.exists === false ? t('manager.newTomlWarning') : TOML_WARNING)
      : null,
  ]);
}

function DeclarationWriteView(props) {
  const { mode, preset, source, name, drafts, removeSource, busy, status, problem, blocked,
    onName, onChange, onToggleRemove, onSubmit, onBack } = props;
  const copy = mode === 'copy';
  // The specs travel with the open form, so the view and the request it submits read one list.
  const specs = props.fields ?? presetFields(preset);
  const title = copy ? (props.embedded ? t('manager.copyToOther') : t('manager.copyToPreset')) : t('manager.newServer');
  const children = [
    React.createElement('div', { key: 'head', className: 'wmcp-dialog-head' }, [
      React.createElement('strong', { key: 'title' }, title),
      React.createElement('span', { key: 'spacer', className: 'wmcp-spacer' }),
      React.createElement('span', { key: 'target', className: 'wmcp-tag' }, preset?.id ?? ''),
    ]),
    React.createElement('p', { key: 'where', className: 'wmcp-dialog-note' },
      t('manager.targetLine', { target: presetWhere(preset), format: preset?.format === undefined ? '' : t('manager.formatSuffix', { format: preset.format }), builtin: preset?.builtin === true ? t('manager.builtinSuffix') : '' })),
  ];
  if (copy) children.push(React.createElement('p', { key: 'source', className: 'wmcp-hint' },
    t('manager.prefillNote', { server: source?.serverId ?? t('manager.thisDeclaration') })));
  children.push(React.createElement('label', { key: 'name', className: 'wmcp-field-row' }, [
    React.createElement('span', { key: 'label' }, t('manager.nameLabel')),
    React.createElement('input', {
      key: 'input',
      type: 'text',
      value: name ?? '',
      spellCheck: false,
      placeholder: t('manager.namePlaceholder'),
      'data-manager-autofocus': props.embedded === true ? true : undefined,
      disabled: busy === true,
      onChange: event => onName(event.target.value),
    }),
    React.createElement('span', { key: 'hint', className: 'wmcp-hint' },
      t('manager.nameHint')),
  ]));
  // The field list is the Host's: which names this preset can write, in which order. Nothing is
  // re-sorted here — url leads because for a remote entry it is the whole declaration, and a
  // dialect that cannot spell a transport simply does not list one.
  for (const spec of visibleFields(specs, drafts)) {
    children.push(fieldRow({
      field: spec,
      draft: pickerDraft(spec, drafts),
      disabled: busy === true,
      // A fresh entry may leave the transport out entirely: the Host infers it from url / command,
      // and that stays valid whichever way the rest of the entry is filled in.
      allowBlank: props.embedded !== true,
      onChange,
      friendly: props.embedded === true,
      mapState: props.maps?.[spec.name], onMapState: props.onMapState,
    }));
  }
  if (props.presets !== undefined) children.push(React.createElement(ConfigLocation, {
    key: 'location', preset, presets: props.presets, disabled: busy === true, onChange: props.onPreset,
  }));
  if (copy) children.push(React.createElement('label', { key: 'remove', className: 'wmcp-check' }, [
    React.createElement('input', {
      key: 'box',
      type: 'checkbox',
      checked: removeSource === true,
      disabled: busy === true,
      onChange: () => onToggleRemove(removeSource !== true),
    }),
    React.createElement('span', { key: 'text' }, t('manager.removeSourceAfterCopy')),
  ]));
  if (problem !== undefined) children.push(React.createElement('p', { key: 'problem', className: 'wmcp-dialog-note', 'data-kind': 'error' }, problem));
  if (status !== undefined) children.push(React.createElement('p', { key: 'status', className: 'wmcp-dialog-note', 'data-kind': status.kind }, status.text));
  const foot = [actionButton({ key: 'back', disabled: busy === true, onClick: onBack }, props.embedded ? t('action.cancel') : t('action.back'))];
  foot.push(React.createElement('span', { key: 'spacer', className: 'wmcp-spacer' }));
  if (blocked !== undefined) foot.push(React.createElement('span', { key: 'blocked', className: 'wmcp-hint' }, blocked));
  if (props.onSubmitConnect !== undefined) foot.push(actionButton({
    key: 'connect', disabled: busy === true || problem !== undefined || blocked !== undefined,
    title: t('action.saveAndConnectHint'), onClick: props.onSubmitConnect,
  }, t('action.saveAndConnect')));
  foot.push(actionButton({
    key: 'submit',
    variant: 'primary',
    disabled: busy === true || problem !== undefined || blocked !== undefined,
    onClick: onSubmit,
  }, busy === true ? (copy ? t('action.copying') : t('action.creating')) : (copy ? t('action.copy') : t('action.create'))));
  children.push(React.createElement('div', { key: 'foot', className: 'wmcp-dialog-foot' }, foot));
  return dialogSurface(`${title}${name === undefined || name.length === 0 ? '' : ` ${name}`}`, children, props.embedded ? 'region' : 'dialog');
}

/**
 * The second ask after DECLARATION_EXISTS: whether to replace the entry that already has this
 * name is the one write the form cannot answer by itself, so it is asked in the same surface.
 */
function DeclarationOverwriteView(props) {
  const { preset, name, busy, onCancel, onConfirm } = props;
  return dialogSurface(t('manager.overwriteTitle', { name: name }), [
    React.createElement('strong', { key: 'title' }, t('manager.targetExists')),
    React.createElement('p', { key: 'note', className: 'wmcp-dialog-note' },
      t('manager.overwriteWarning', { where: presetWhere(preset), name: name })),
    React.createElement('p', { key: 'where', className: 'wmcp-hint' }, t('manager.targetPreset', { preset: preset?.id ?? '' })),
    React.createElement('div', { key: 'foot', className: 'wmcp-dialog-foot' }, [
      actionButton({ key: 'cancel', disabled: busy === true, onClick: onCancel }, t('action.cancel')),
      React.createElement('span', { key: 'spacer', className: 'wmcp-spacer' }),
      actionButton({ key: 'confirm', variant: 'primary', disabled: busy === true, onClick: onConfirm },
        busy === true ? t('action.writing') : t('action.overwrite')),
    ]),
  ], 'alertdialog');
}

/**
 * The declaration overlay: the entry list, one entry's fields, the delete confirmation, the
 * target-preset chooser and the write form (a new entry, or an existing one copied elsewhere).
 *
 * The overlay owns only the view state; the panel owns the reads and writes, so one write can
 * refresh the targets, the presets and the status in one place. Escape is handled by the panel,
 * which unwinds this layer before its own, and the scrim dismisses on a click outside the card.
 *
 * One layer, never a nested one: the chooser and the form replace the view they were opened from,
 * exactly as the list and the entry already do, so no backdrop-filtered box ever nests.
 */
const preferredPreset = (payload, workspace, source) => {
  const options = source === undefined ? editablePresets(payload) : copyPresets(payload, source)
    .filter(item => item.files?.[0] !== source.file);
  let remembered;
  try { remembered = localStorage.getItem(`dsh-mcp-glue:preset:${workspace ?? ''}`); } catch { /* optional storage */ }
  return options.find(item => item.id === remembered) ?? options.find(item => item.id === 'root') ?? options[0];
};
const rememberPreset = (workspace, id) => {
  try { localStorage.setItem(`dsh-mcp-glue:preset:${workspace ?? ''}`, id); } catch { /* optional storage */ }
};
const makeWriteForm = (preset, source) => {
  if (preset === undefined) return undefined;
  const fields = presetFields(preset);
  const baseline = source === undefined ? emptyWriteDrafts(fields) : writeDraftsFrom(source, fields);
  const transport = source === undefined ? 'stdio' : connectionTransport(draftsOfTarget(source));
  const drafts = { ...baseline, [fields.some(field => field.name === 'transport') ? 'transport' : '$transport']: transport };
  return { mode: source === undefined ? 'create' : 'copy', preset, source, fields, baseline,
    name: source === undefined ? '' : `${source.serverId}-copy`, drafts, initialDrafts: drafts, removeSource: false };
};
const formDirty = form => form !== undefined && (hasText(form.name) || form.removeSource === true
  || JSON.stringify(form.drafts) !== JSON.stringify(form.initialDrafts));
const lossyTarget = target => target?.lossy === true || target?.format === 'toml';
const writeLossyFiles = form => [...new Set([
  ...(lossyTarget(form?.preset) && form.preset.exists !== false ? form.preset.files?.slice(0, 1) ?? [] : []),
  ...(form?.removeSource === true && lossyTarget(form.source) ? [form.source.file] : []),
])];
const activeMapProblem = (fields, drafts, maps) => visibleFields(fields, drafts)
  .map(field => maps?.[field.name]?.problem).find(problem => problem !== undefined);
const requiredConnectionProblem = (fields, drafts) => {
  const mode = connectionTransport(drafts);
  const name = mode === 'http' ? 'url' : 'command';
  if (fields.some(field => field.name === name) && !hasText(drafts?.[name])) {
    return mode === 'http' ? t('write.error.urlRequired') : t('write.error.commandRequiredStdio');
  }
  return undefined;
};
const initialManagerState = (payload, initial, workspace) => {
  const target = (payload?.targets ?? []).find(item => item.serverId === initial?.serverId)
    ?? (initial?.mode === 'create' ? undefined : payload?.targets?.[0]);
  return { target, drafts: draftsOfTarget(target), form: initial?.mode === 'create'
    ? makeWriteForm(preferredPreset(payload, workspace)) : undefined, tab: 'servers', maps: {} };
};

function ManagerConfirmation({ confirmation, busy, onCancel, onConfirm }) {
  const text = {
    discard: [t('confirm.discardTitle'), t('confirm.discardBody'), t('action.discard')],
    toml: [t('confirm.tomlTitle'), TOML_WARNING, t('action.confirmRewrite')],
    delete: [t('confirm.removeTitle'), t('confirm.removeBody', { file: confirmation.file ?? t('common.declarationFile'), server: confirmation.name ?? t('common.thisServer') }), t('action.confirmRemove')],
    overwrite: [t('manager.targetExists'), t('confirm.overwriteBody', { server: confirmation.name ?? t('common.thisServer') }), t('action.overwrite')],
  }[confirmation.kind];
  return React.createElement('section', { className: 'wmcp-manager-alert', 'aria-label': text[0] }, [
    React.createElement('h3', { key: 'title', tabIndex: -1, 'data-manager-autofocus': true }, text[0]),
    React.createElement('p', { key: 'text', className: 'wmcp-dialog-note' }, text[1]),
    confirmation.kind !== 'toml' && confirmation.lossy ? React.createElement('p', { key: 'toml', className: 'wmcp-warning' }, TOML_WARNING) : null,
    ...(confirmation.files ?? []).map(file => React.createElement('p', { key: file, className: 'wmcp-location-path' }, file)),
    React.createElement('div', { key: 'actions', className: 'wmcp-dialog-foot' }, [
      actionButton({ key: 'cancel', disabled: busy, onClick: onCancel }, t('action.cancel')),
      React.createElement('span', { key: 'spacer', className: 'wmcp-spacer' }),
      actionButton({ key: 'confirm', variant: 'primary', disabled: busy, onClick: onConfirm }, busy ? t('action.working') : text[2]),
    ]),
  ]);
}

/** One body-level modal, a persistent server sidebar, and forms without a preset-chooser step. */
function DeclarationManager(props) {
  const { payload, busy, status, initial, workspace, onClose, onReload, onSave, onRemove, onWrite, policy, returnFocus } = props;
  const [view, setView] = React.useState(() => initialManagerState(payload, initial, workspace));
  const [confirmation, setConfirmation] = React.useState(undefined);
  const [submitting, setSubmitting] = React.useState(false);
  const ready = React.useRef(payload !== undefined);
  const root = React.useRef(null);
  const live = React.useRef({});
  const locked = busy === true || submitting;
  const { target, drafts, form, maps } = view;
  let changes = [];
  let problem;
  try { if (target !== undefined && form === undefined) changes = changesOfTarget(target, drafts); }
  catch (error) { problem = error.message; }
  const dirty = form !== undefined ? formDirty(form) || Object.values(maps).some(map => map.problem !== undefined)
    : changes.length > 0 || problem !== undefined || Object.values(maps).some(map => map.problem !== undefined);
  const navigate = action => {
    if (locked) return;
    if (dirty) setConfirmation({ kind: 'discard', run: action });
    else action();
  };
  const select = item => setView({ tab: 'servers', target: item, drafts: draftsOfTarget(item), form: undefined, maps: {} });
  const create = source => {
    const preset = preferredPreset(payload, workspace, source);
    if (preset === undefined) return;
    setView({ tab: 'servers', target, drafts, maps: {}, form: makeWriteForm(preset, source) });
  };
  const finish = () => setView({ tab: 'servers', target: undefined, drafts: {}, form: undefined, maps: {} });
  live.current = { close: () => navigate(onClose), locked, dirty, cancel: () => setConfirmation(undefined), confirmation };

  React.useEffect(() => {
    if (!ready.current && payload !== undefined) {
      ready.current = true; setView(initialManagerState(payload, initial, workspace));
    } else if (form === undefined && !dirty && payload !== undefined) {
      const next = payload.targets?.find(item => item.serverId === target?.serverId) ?? payload.targets?.[0];
      if (next?.version !== target?.version || next?.serverId !== target?.serverId) select(next);
    }
  }, [payload, dirty]);

  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focus = () => (root.current?.querySelector('[data-manager-autofocus]') ?? root.current)?.focus();
    focus();
    const keys = event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (live.current.locked) return;
        if (live.current.confirmation !== undefined) live.current.cancel(); else live.current.close();
      }
      if (event.key !== 'Tab') return;
      const nodes = [...(root.current?.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? [])]
        .filter(node => node.getClientRects().length > 0);
      const first = nodes[0], last = nodes.at(-1);
      if (first === undefined) { event.preventDefault(); root.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const focusInside = event => { if (root.current !== null && !root.current.contains(event.target)) focus(); };
    const unload = event => { if (live.current.dirty) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('keydown', keys, true);
    document.addEventListener('focusin', focusInside);
    window.addEventListener('beforeunload', unload);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', keys, true); document.removeEventListener('focusin', focusInside);
      window.removeEventListener('beforeunload', unload);
      const destination = returnFocus?.current ?? previous;
      if (destination?.isConnected) destination.focus();
    };
  }, []);
  React.useEffect(() => {
    if (confirmation !== undefined) root.current?.querySelector('[data-manager-autofocus]')?.focus();
  }, [confirmation]);

  const runSave = async (connect, allowLossy = false) => {
    if (target === undefined || locked || problem !== undefined || changes.length === 0) return;
    setConfirmation(undefined); setSubmitting(true);
    try {
      const result = await onSave(target.serverId, changes, { version: target.version, allowLossy, connect });
      if (result === 'confirm') setConfirmation({ kind: 'toml', files: [target.file], run: () => runSave(connect, true) });
      else if (result === true) finish();
    } finally { setSubmitting(false); }
  };
  const requestSave = connect => {
    if (lossyTarget(target)) setConfirmation({ kind: 'toml', files: [target.file], run: () => runSave(connect, true) });
    else void runSave(connect);
  };
  const runWrite = async (connect, overwrite = false, allowLossy = false) => {
    if (form === undefined || locked) return;
    let spec;
    try { spec = writeSpecOf(form, overwrite); } catch { return; }
    if (writeBlocked(spec.name, spec.fields, connectionTransport(form.drafts)) !== undefined) return;
    setConfirmation(undefined); setSubmitting(true);
    try {
      const result = await onWrite({ ...spec, connect, ...(allowLossy ? { allowLossy: true } : {}) });
      if (result === 'ok') { rememberPreset(workspace, form.preset.id); finish(); }
      else if (result === 'exists') setConfirmation({ kind: 'overwrite', name: spec.name, files: [presetWhere(form.preset)],
        lossy: writeLossyFiles(form).length > 0, run: () => runWrite(connect, true, allowLossy || writeLossyFiles(form).length > 0) });
      else if (result === 'confirm') setConfirmation({ kind: 'toml', files: writeLossyFiles(form).length > 0 ? writeLossyFiles(form) : [presetWhere(form.preset)],
        run: () => runWrite(connect, overwrite, true) });
    } finally { setSubmitting(false); }
  };
  const requestWrite = connect => {
    const files = writeLossyFiles(form);
    if (files.length > 0) setConfirmation({ kind: 'toml', files, run: () => runWrite(connect, false, true) });
    else void runWrite(connect);
  };
  const requestDelete = () => setConfirmation({ kind: 'delete', name: target.serverId, file: target.file,
    lossy: lossyTarget(target), run: async () => {
      setConfirmation(undefined); setSubmitting(true);
      try {
        const result = await onRemove(target.serverId, { version: target.version, allowLossy: lossyTarget(target) });
        if (result === true) finish();
        else if (result === 'confirm') setConfirmation({ kind: 'toml', files: [target.file], run: async () => {
          setConfirmation(undefined); setSubmitting(true);
          try { if (await onRemove(target.serverId, { version: target.version, allowLossy: true }) === true) finish(); }
          finally { setSubmitting(false); }
        } });
      } finally { setSubmitting(false); }
    } });
  const mapChange = (name, map) => setView(current => ({ ...current, maps: { ...current.maps, [name]: map } }));
  let content;
  if (confirmation !== undefined) content = React.createElement(ManagerConfirmation, { confirmation, busy: locked,
    onCancel: () => setConfirmation(undefined), onConfirm: () => {
      if (locked) return;
      const run = confirmation.run; setConfirmation(undefined); void run();
    } });
  else if (view.tab === 'policy') content = React.createElement('section', { className: 'wmcp-manager-policy' }, [
    React.createElement('h4', { key: 'title' }, t('manager.autoConnectTools')),
    React.createElement('p', { key: 'note', className: 'wmcp-dialog-note' }, t('manager.autoConnectHint')),
    policy,
  ]);
  else if (form !== undefined) {
    let fields = [];
    let writeProblem;
    try { fields = writeFieldsOf(form.drafts, form.fields, form.baseline); } catch (error) { writeProblem = error.message; }
    writeProblem ??= activeMapProblem(form.fields, form.drafts, maps);
    content = React.createElement(DeclarationWriteView, { key: `write:${form.mode}:${form.source?.serverId ?? ''}`, ...form,
      embedded: true, maps, onMapState: mapChange, busy: locked, status,
      problem: writeProblem, blocked: writeProblem === undefined ? writeBlocked(form.name, fields, connectionTransport(form.drafts)) : undefined,
      presets: presetsFor(payload, form.mode, form.source).map(item => item.files?.[0] === form.source?.file
        ? { ...item, editable: false, reason: t('manager.sameFile') } : item),
      onPreset: preset => {
        if (preset === undefined || preset.editable === false) return;
        const next = makeWriteForm(preset, form.source);
        const mode = connectionTransport(form.drafts);
        setView(current => ({ ...current, form: { ...form, preset, fields: next.fields, baseline: next.baseline,
          drafts: { ...form.drafts, transport: next.fields.some(field => field.name === 'transport') ? mode : undefined,
            $transport: next.fields.some(field => field.name === 'transport') ? undefined : mode } } }));
      },
      onName: name => setView(current => ({ ...current, form: { ...current.form, name } })),
      onChange: (name, value) => setView(current => ({ ...current, form: { ...current.form, drafts: { ...current.form.drafts, [name]: value } } })),
      onToggleRemove: value => setView(current => ({ ...current, form: { ...current.form, removeSource: value === true } })),
      onSubmit: () => requestWrite(false), onSubmitConnect: () => requestWrite(true), onBack: () => navigate(finish),
    });
  } else if (target !== undefined) {
    problem ??= activeMapProblem(target.fields ?? [], drafts, maps);
    problem ??= requiredConnectionProblem(target.fields ?? [], drafts);
    content = React.createElement(DeclarationEditorView, { key: `edit:${target.serverId}`, target, drafts, maps, onMapState: mapChange,
      embedded: true, busy: locked, status, problem, changeCount: changes.length,
      editable: payload?.writable !== false && target.editable !== false,
      reason: payload?.writable === false ? payload.reason : target.reason,
      copyable: canCopyEntry(payload, target),
      onChange: (name, value) => setView(current => ({ ...current, drafts: { ...current.drafts, [name]: value } })),
      onBack: () => navigate(finish), onCopy: () => navigate(() => create(target)), onDelete: requestDelete,
      onSave: () => requestSave(false), onSaveConnect: () => requestSave(true),
    });
  } else content = React.createElement('div', { className: 'wmcp-manager-empty' }, [
    React.createElement('p', { key: 'empty' }, payload === undefined ? t('manager.readingConfig') : t('manager.selectHint')),
    status === undefined ? null : React.createElement('p', { key: 'status', 'data-kind': status.kind, className: 'wmcp-dialog-note' }, status.text),
    canCreateEntry(payload) ? actionButton({ key: 'new', variant: 'primary', onClick: () => create() }, t('action.newServer')) : null,
    payload?.writable === false ? React.createElement('p', { key: 'readonly' }, t('panel.cannotWrite', { reason: payload.reason ?? t('panel.sandboxReadOnly') })) : null,
  ]);

  const modal = React.createElement('div', { className: 'wmcp-backdrop', onPointerDown: scrimDismiss(() => live.current.close()) },
    React.createElement('div', { className: 'wmcp-overlay', ref: root, role: confirmation === undefined ? 'dialog' : 'alertdialog', 'aria-modal': true,
      'aria-label': confirmation === undefined ? t('manager.serverManagerTitle') : t('confirm.actionTitle'), tabIndex: -1 },
    React.createElement('div', { className: 'wmcp-manager' }, [
      React.createElement('header', { key: 'head', className: 'wmcp-manager-head' }, [
        React.createElement('h2', { key: 'title', className: 'wmcp-manager-title' }, t('manager.serverManagerTitle')),
        React.createElement('span', { key: 'workspace', className: 'wmcp-manager-subtitle', title: workspace ?? '' }, workspace ?? ''),
        React.createElement('span', { key: 'spacer', className: 'wmcp-spacer' }),
        actionButton({ key: 'reload', disabled: locked || confirmation !== undefined, onClick: () => navigate(() => { finish(); onReload(); }) }, t('action.reload')),
        actionButton({ key: 'close', disabled: locked, 'aria-label': t('action.closeManager'), onClick: () => navigate(onClose) }, t('action.close')),
      ]),
      React.createElement('div', { key: 'layout', className: 'wmcp-manager-layout' }, [
        React.createElement('nav', { key: 'sidebar', className: 'wmcp-manager-sidebar', 'aria-label': t('manager.serversAndPolicy') }, [
          actionButton({ key: 'create', variant: 'primary', disabled: locked || confirmation !== undefined || !canCreateEntry(payload), onClick: () => navigate(() => create()) }, t('action.newServer')),
          React.createElement('ul', { key: 'servers', className: 'wmcp-entries' }, (payload?.targets ?? []).map(item => React.createElement('li', { key: item.serverId },
            React.createElement('button', { type: 'button', className: 'wmcp-entry', 'aria-current': form === undefined && view.tab === 'servers' && target?.serverId === item.serverId,
              disabled: locked || confirmation !== undefined, onClick: () => navigate(() => select(item)) }, [
              React.createElement('span', { key: 'name', className: 'wmcp-entry-id' }, item.serverId),
              React.createElement('span', { key: 'file', className: 'wmcp-entry-where', title: item.file }, item.file),
              item.editable === false ? React.createElement('span', { key: 'readonly', className: 'wmcp-tag' }, t('common.readOnly')) : null,
            ])))),
          policy === undefined ? null : actionButton({ key: 'policy', disabled: locked || confirmation !== undefined, onClick: () => navigate(() => setView({ tab: 'policy', drafts: {}, maps: {} })) }, t('manager.policyAndPermissions')),
        ]),
        React.createElement('main', { key: 'content', className: 'wmcp-manager-content' }, content),
      ]),
    ])));
  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}

const DeclarationOverlay = DeclarationManager;

/* ── Preset manager: rendered on this plugin's page in Settings → Plugins ────────── */

const FORMATS = ['json', 'jsonc', 'toml', 'yaml'];
const DIALECTS = ['standard', 'codex', 'gemini'];
const INTERPOLATIONS = ['standard', 'shell', 'none'];
const FIELDS = ['transport', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'enabled', 'disabled',
  'envFile', 'envVars', 'envHeaders', 'bearerTokenEnv', 'timeoutMs', 'timeoutSeconds'];

const linesOf = text => text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
/** Trust mode choices, with the risk spelled out on the one that stops asking. */
const TRUST_MODES = [
  { id: 'manual', label: 'manual', note: t('manager.trustSummary') },
  { id: 'all', label: 'all', note: t('manager.trustAllWarning') },
];

/**
 * Trusted-workspace draft lines → the absolute-path list the Host stores.
 *
 * The Host matches a workspace by its canonical identity, so this only has to drop blank
 * lines, trim the rest and keep the list unique; a differently spelled duplicate of the same
 * directory is harmless (it simply matches the same identity twice).
 */
const workspacesOf = text => [...new Set(text.split('\n').map(line => line.trim()).filter(line => line.length > 0))];
/** Append one workspace unless it is already trusted verbatim. */
const withWorkspace = (list, workspace) => (list.includes(workspace) ? list : [...list, workspace]);
/** The complete editable patch this page submits: the presets plus the trust decision. */
const configPatch = ({ drafts, enabled, trustMode, workspaces }) => ({
  enabledBuiltins: enabled,
  presets: draftToPresets(drafts),
  // The Host validates the mode against its own enum, so a legacy spelling never reaches it.
  trustMode: trustModeOf(trustMode),
  trustedWorkspaces: workspacesOf(workspaces),
});
const emptyPreset = () => ({ id: '', files: '', serversPaths: '', format: 'jsonc', dialect: 'standard', interpolation: 'standard', extends: '', fields: '{}' });
const toDraft = preset => ({
  id: preset.id ?? '',
  extends: preset.extends ?? '',
  files: (preset.files ?? []).join('\n'),
  serversPaths: (preset.serversPaths ?? []).join('\n'),
  format: preset.format ?? 'jsonc',
  dialect: preset.dialect ?? 'standard',
  interpolation: preset.interpolation ?? 'standard',
  fields: JSON.stringify(preset.fields ?? {}, null, 2),
});
/** Preset drafts → the config payload the host validates with the same resolver. */
function draftToPresets(drafts) {
  const seen = new Set();
  return drafts.map(draft => {
    const id = draft.id.trim();
    if (id.length === 0) throw new Error(t('settings.error.presetIdRequired'));
    if (seen.has(id)) throw new Error(t('settings.error.duplicatePresetId', { id: id }));
    seen.add(id);
    const files = linesOf(draft.files);
    if (files.length === 0) throw new Error(t('settings.error.presetFileRequired', { id: id }));
    const serversPaths = linesOf(draft.serversPaths);
    if (serversPaths.length === 0) throw new Error(t('settings.error.presetServersRequired', { id: id }));
    let fields;
    try { fields = JSON.parse(draft.fields.length === 0 ? '{}' : draft.fields); }
    catch { throw new Error(t('settings.error.presetFieldsJson', { id: id })); }
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new Error(t('settings.error.presetFieldsObject', { id: id }));
    for (const value of Object.values(fields)) {
      if (typeof value !== 'string') throw new Error(t('settings.error.presetFieldsStrings', { id: id }));
    }
    return {
      id,
      files,
      serversPaths,
      format: draft.format,
      dialect: draft.dialect,
      interpolation: draft.interpolation,
      ...(draft.extends.trim().length === 0 ? {} : { extends: draft.extends.trim() }),
      ...(Object.keys(fields).length === 0 ? {} : { fields }),
    };
  });
}

/**
 * The Plugins page renders this entry as the body of the bundle's page
 * (`plugins.bundle.config` is page-only today; a `summary` view still degrades to a
 * one-liner instead of fetching).
 */
function PresetManager(props) {
  const summary = props?.view === 'summary';
  const [state, setState] = React.useState(undefined);
  const [drafts, setDrafts] = React.useState([]);
  const [enabled, setEnabled] = React.useState([]);
  const [trustMode, setTrustMode] = React.useState('manual');
  const [workspaces, setWorkspaces] = React.useState('');
  const [status, setStatus] = React.useState(undefined);
  const [busy, setBusy] = React.useState(false);
  const alive = React.useRef(true);

  const adopt = payload => {
    setState(payload);
    setDrafts((payload.config.presets ?? []).map(toDraft));
    setEnabled(payload.config.enabledBuiltins ?? []);
    setTrustMode(trustModeOf(payload.config.trustMode));
    setWorkspaces((payload.config.trustedWorkspaces ?? []).join('\n'));
    setStatus(undefined);
  };
  const load = React.useCallback(async () => {
    try {
      const payload = await request('/config');
      if (alive.current) adopt(payload);
    } catch (reason) {
      if (alive.current) setStatus({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) });
    }
  }, []);
  React.useEffect(() => {
    alive.current = true;
    if (!summary) void load();
    return () => { alive.current = false; };
  }, [load, summary]);

  const save = async () => {
    setBusy(true);
    try {
      const patch = configPatch({ drafts, enabled, trustMode, workspaces });
      const payload = await request('/config', { patch });
      if (alive.current) { adopt(payload); setStatus({ kind: 'ok', text: t('settings.savedSummary', { presets: patch.presets.length, builtins: enabled.length, trustMode: trustMode, workspaces: patch.trustedWorkspaces.length }) }); }
    } catch (reason) {
      if (alive.current) setStatus({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const patchDraft = (index, patch) => setDrafts(current => current.map((draft, at) => (at === index ? { ...draft, ...patch } : draft)));
  const removeDraft = index => setDrafts(current => current.filter((_draft, at) => at !== index));
  const toggleBuiltin = id => setEnabled(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);

  if (summary) {
    return React.createElement('p', { key: 'summary', className: 'wmpm-intro' },
      t('settings.subtitle'));
  }

  if (state === undefined) {
    return React.createElement('div', { className: 'wmpm' }, [
      React.createElement('h4', { key: 'title' }, t('settings.title')),
      React.createElement('p', { key: 'note', className: 'wmpm-intro' }, t('manager.readingConfig')),
      status === undefined ? null : React.createElement('p', { key: 'status', className: 'wmpm-status', 'data-kind': status.kind }, status.text),
    ]);
  }

  return React.createElement('div', { className: 'wmpm' }, [
    React.createElement('header', { key: 'head', className: 'wmpm-head' }, [
      React.createElement('h4', { key: 'title', className: 'wmpm-title' }, t('settings.heading')),
      React.createElement('p', { key: 'intro', className: 'wmpm-intro' },
        t('settings.cardsHint')),
      React.createElement('p', { key: 'meta', className: 'wmpm-meta' },
        state.editable
          ? t('settings.entryLine', { id: state.entryId, timing: state.applies === 'live' ? t('settings.appliesLive') : t('settings.appliesRestart') })
          : t('settings.notWritableReason', { reason: state.reason ?? t('error.settingsUnavailable') })),
    ]),
    React.createElement('section', { key: 'builtins', className: 'wmpm-section' }, [
      React.createElement('div', { key: 'h', className: 'wmpm-section-head' }, [
        React.createElement('h4', null, t('settings.builtinPresets')),
        React.createElement('span', { key: 'n', className: 'wmpm-count' }, `${enabled.length}/${state.builtins.length}`),
      ]),
      React.createElement('p', { key: 'hint', className: 'wmpm-hint' }, t('settings.builtinHint')),
      React.createElement('div', { key: 'list', className: 'wmpm-builtins' },
        state.builtins.map(preset => React.createElement('label', {
          key: preset.id,
          className: enabled.includes(preset.id) ? 'wmpm-builtin is-on' : 'wmpm-builtin',
        }, [
          React.createElement('input', {
            key: 'box',
            type: 'checkbox',
            checked: enabled.includes(preset.id),
            onChange: () => toggleBuiltin(preset.id),
          }),
          React.createElement('span', { key: 'body', className: 'wmpm-builtin-body' }, [
            React.createElement('span', { key: 'id', className: 'wmpm-builtin-id' }, preset.id),
            React.createElement('span', { key: 'files', className: 'wmpm-meta' }, preset.files.join(t('common.listSeparator'))),
            React.createElement('span', { key: 'table', className: 'wmpm-meta' }, t('settings.presetMeta', { paths: preset.serversPaths.join(' / '), format: preset.format, dialect: preset.dialect === 'standard' ? '' : t('settings.dialectSuffix', { dialect: preset.dialect }) })),
          ]),
        ]))),
    ]),
    React.createElement('section', { key: 'custom', className: 'wmpm-section' }, [
      React.createElement('div', { key: 'h', className: 'wmpm-section-head' }, [
        React.createElement('h4', null, t('settings.customPresets')),
        React.createElement('span', { key: 'n', className: 'wmpm-count' }, drafts.length),
      ]),
      React.createElement('p', { key: 'hint', className: 'wmpm-hint' }, t('settings.customHint')),
      drafts.length === 0
        ? React.createElement('p', { key: 'empty', className: 'wmpm-empty' }, t('settings.noCustomPresets'))
        : drafts.map((draft, index) => React.createElement('div', { key: `draft-${index}`, className: 'wmpm-card' }, [
          React.createElement('div', { key: 'head', className: 'wmpm-card-head' }, [
            React.createElement('input', {
              key: 'id',
              type: 'text',
              value: draft.id,
              placeholder: t('settings.presetIdPlaceholder'),
              onChange: event => patchDraft(index, { id: event.target.value }),
            }),
            actionButton({
              key: 'del',
              style: { color: 'var(--dsw-alias-state-error-primary)' },
              onClick: () => removeDraft(index),
            }, t('action.delete')),
          ]),
          React.createElement('div', { key: 'grid', className: 'wmpm-grid' }, [
            React.createElement('label', { key: 'format', className: 'wmpm-field' }, [
              React.createElement('span', null, t('settings.format')),
              React.createElement('select', { value: draft.format, onChange: event => patchDraft(index, { format: event.target.value }) },
                FORMATS.map(value => React.createElement('option', { key: value, value }, value))),
            ]),
            React.createElement('label', { key: 'dialect', className: 'wmpm-field' }, [
              React.createElement('span', null, t('settings.dialect')),
              React.createElement('select', { value: draft.dialect, onChange: event => patchDraft(index, { dialect: event.target.value }) },
                DIALECTS.map(value => React.createElement('option', { key: value, value }, value))),
            ]),
            React.createElement('label', { key: 'interpolation', className: 'wmpm-field' }, [
              React.createElement('span', null, t('settings.interpolation')),
              React.createElement('select', { value: draft.interpolation, onChange: event => patchDraft(index, { interpolation: event.target.value }) },
                INTERPOLATIONS.map(value => React.createElement('option', { key: value, value }, value))),
            ]),
            React.createElement('label', { key: 'extends', className: 'wmpm-field' }, [
              React.createElement('span', null, t('settings.extends')),
              React.createElement('input', { type: 'text', value: draft.extends, placeholder: t('settings.extendsPlaceholder'), onChange: event => patchDraft(index, { extends: event.target.value }) }),
            ]),
          ]),
          React.createElement('label', { key: 'files', className: 'wmpm-field' }, [
            React.createElement('span', null, t('settings.filesLabel')),
            React.createElement('textarea', { value: draft.files, placeholder: '.team/mcp.yaml', onChange: event => patchDraft(index, { files: event.target.value }) }),
          ]),
          React.createElement('label', { key: 'paths', className: 'wmpm-field' }, [
            React.createElement('span', null, t('settings.serversPathsLabel')),
            React.createElement('textarea', { value: draft.serversPaths, placeholder: 'mcpServers', onChange: event => patchDraft(index, { serversPaths: event.target.value }) }),
          ]),
          React.createElement('label', { key: 'fields', className: 'wmpm-field' }, [
            React.createElement('span', null, t('settings.fieldsLabel', { keys: FIELDS.join(t('common.listSeparator')) })),
            React.createElement('textarea', { value: draft.fields, spellCheck: false, onChange: event => patchDraft(index, { fields: event.target.value }) }),
          ]),
        ])),
      React.createElement('div', { key: 'add', className: 'wmpm-actions' }, [
        actionButton({
          key: 'add',
          onClick: () => setDrafts(current => [...current, emptyPreset()]),
        }, t('settings.addPreset')),
      ]),
    ]),
    React.createElement('section', { key: 'trust', className: 'wmpm-section' }, [
      React.createElement('div', { key: 'h', className: 'wmpm-section-head' }, [
        React.createElement('h4', null, t('settings.trust')),
        React.createElement('span', { key: 'n', className: 'wmpm-count' }, workspacesOf(workspaces).length),
      ]),
      React.createElement('p', { key: 'hint', className: 'wmpm-hint' },
        t('settings.trustHint')),
      React.createElement('div', { key: 'modes', className: 'wmpm-choices' },
        TRUST_MODES.map(mode => React.createElement('label', {
          key: mode.id,
          className: `wmpm-choice${trustMode === mode.id ? ' is-on' : ''}${mode.id === 'all' ? ' is-danger' : ''}`,
        }, [
          React.createElement('input', {
            key: 'box',
            type: 'radio',
            name: 'workspace-mcp-trust-mode',
            checked: trustMode === mode.id,
            onChange: () => setTrustMode(mode.id),
          }),
          React.createElement('span', { key: 'body', className: 'wmpm-choice-body' }, [
            React.createElement('span', { key: 'id', className: 'wmpm-choice-id' }, mode.label),
            React.createElement('span', { key: 'note', className: 'wmpm-choice-note' }, mode.note),
          ]),
        ]))),
      React.createElement('label', { key: 'list', className: 'wmpm-field' }, [
        React.createElement('span', null, t('settings.trustedWorkspacesLabel')),
        React.createElement('textarea', {
          value: workspaces,
          placeholder: 'D:\\work\\team-a',
          onChange: event => setWorkspaces(event.target.value),
        }),
      ]),
    ]),
    React.createElement('footer', { key: 'foot', className: 'wmpm-foot' }, [
      React.createElement('span', { key: 'status', className: 'wmpm-status', 'data-kind': status?.kind },
        status?.text ?? (state.editable ? t('settings.dirty') : t('settings.notWritable'))),
      React.createElement('span', { key: 'spacer', className: 'wmpm-spacer' }),
      actionButton({ key: 'reload', disabled: busy, onClick: () => { void load(); } }, t('action.reload')),
      actionButton({ key: 'save', variant: 'primary', disabled: busy || !state.editable, onClick: () => { void save(); } }, busy ? t('action.saving') : t('action.save')),
    ]),
  ]);
}

const inject = ['slots', 'locale'];

// A workspace switch must not reuse another session's drafts, pending reads or manager state.
function SessionChip(props) { return React.createElement(Chip, { ...props, key: props.sessionId }); }

function apply(ctx) {
  // Dictionaries are registered as owned effects, so unloading this half removes them again;
  // `bind` hands back one stable translate function per namespace.
  const locale = ctx.locale;
  if (locale !== undefined && locale !== null) {
    if (typeof locale.register === 'function') ctx.effect(() => locale.register(NS, { zh: dictOf(0), en: dictOf(1) }), NS + ': dictionaries');
    if (typeof locale.bind === 'function') ctx.effect(() => { bound = locale.bind(NS); return () => { bound = undefined; }; }, NS + ': translate');
  }
  // The descriptor's `inject` is evaluated with the render owner's session id, which is
  // the only place a seat component can learn which session it is rendering for.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'workspace-mcp',
    order: 40,
    label: () => 'MCP',
    locale: NS,
    inject: sessionId => ({ sessionId }),
  }, SessionChip));
  // Rendered on this bundle's page in Settings → Plugins, keyed by package name.
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: 'dsh-mcp-glue',
    locale: NS,
  }, PresetManager));
}

module.exports = {
  apply,
  inject,
  __internals: {
    t, DICT, NS, dictOf,
    Chip, PresetManager, ServerRow, PanelFooter, Switch, TrustSwitch, CSS, STATE_LABEL,
    chipSummary, allSelected, sessionAllowance, allowanceOf, withAllowance, withAllowedServer, withAllowedTool,
    toggleName, toolNames, trustModeOf, draftToPresets, toDraft, request, controlToken, pollInterval,
    statusSignature, retryBackoff, workspacesOf, withWorkspace, configPatch, TRUST_MODES,
    FAST_MS, IDLE_MS, WARM_MS, RETRY_MS, RETRY_MAX_MS, WAIT_PATH,
    DeclarationOverlay, DeclarationManager, ManagerConfirmation, DeclarationListView, DeclarationEditorView, DeclarationConfirmView,
    MapField, mapStateOf, draftOfMapRows, activeMapProblem, ConfigLocation,
    preferredPreset, makeWriteForm, formDirty, writeLossyFiles, initialManagerState, TOML_WARNING,
    DECLARATION_PATH, KIND_LABEL, KIND_HINT, fieldKind, fieldRow, fieldControl, choiceOptions,
    draftOfField, draftsOfTarget, valueOfDraft, changesOfTarget, hasStoredValue, hasText,
    readDeclaration, saveDeclaration, removeDeclaration, scrimDismiss, whereOf,
    PresetPickView, DeclarationWriteView, DeclarationOverwriteView, writeDeclaration, WRITE_FIELDS,
    presetFields, writeFieldsOf, writeDraftsFrom, emptyWriteDrafts, writeBlocked,
    formFieldsOf, formBaselineOf, editablePresets, copyPresets,
    connectionTransport, inactiveField, visibleFields,
    presetsFor, canCreateEntry, canCopyEntry, presetWhere, writeSpecOf,
  },
};
