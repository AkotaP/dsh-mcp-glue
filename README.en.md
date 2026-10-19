# dsh-mcp-glue

[中文](README.md) | English

Loads project-level MCP declarations for **DeepSeek Harness 0.2.0-rc.2**. A session reads only its own workspace's configuration and connects servers inside its own Agent scope. The plugin never writes to the global DSH profile and never modifies the declaration files it reads.

## Built-in presets

| ID | Workspace-relative path | Servers table | Format |
|---|---|---|---|
| `root` | `.mcp.json` | `mcpServers` or `servers`, not both | JSONC |
| `vscode` | `.vscode/mcp.json` | `servers` | JSONC |
| `codex` | `.codex/config.toml` | `mcp_servers` | TOML |
| `cursor` | `.cursor/mcp.json` | `mcpServers` | JSONC |
| `gemini` | `.gemini/settings.json` | `mcpServers` | JSONC |

The newer VS Code portable configuration is loaded through the `root` preset as well. Presets are Host configuration data only: they run no project script and no transform function.

## Management UI

Two seats:

- **The MCP control at the left of the composer tool row**: shows the **current session workspace's** declarations and connection state (`● MCP connected/declared`). Expanding it connects or disconnects one server at a time, reloads declarations, or connects and disconnects all. A manual connect is an explicit grant for that session and that declaration fingerprint; a disconnect is sticky and survives declaration changes.
- **Preset management on the plugin page** (Settings → Plugins → dsh-mcp-glue): tick built-in presets and add or remove custom ones (file locations, formats, servers-table paths, dialects, interpolation, field mappings). Both halves validate with the same resolver, write only the editable fields, and use revision CAS (a conflict returns 409). The page is the **plugin's own page** (`plugins.bundle.config`, keyed by package name), not a separate settings section.

The client half registers its copy as `ctx.locale` dictionaries under the package name, so the panel and the plugin page follow the GUI language (Chinese or English). Without the locale service the zh column is used.

The contract, security boundaries and activation rules are in the [management UI document](<docs/management-ui.md>). The client half is the repository's build artifact `lib/client.js` (generated from `src/client.js` by `pnpm run build`); it must be built or the Host reports a missing bundle and refuses to activate. Run `pnpm run build` after changing the client source. Whether the running Host picks up the new bundle automatically depends on its development watcher, so an open page alone proves nothing. **Host**-half changes require a DSH restart, because the process keeps the module it imported at activation time.

## Auto reconnect

- Supervision covers **only this plugin's mounts** that remain selected (`selected`) and policy-allowed (`autoAllowed`), with the native bridge verified as exactly **`0.2.0-rc.2`**. A manual (`custom`) selection still qualifies when policy permits; a manually connected, policy-unallowed server gets a single attempt. Disconnect / Stop connecting remains sticky.
- Transient startup and connection failures retry at **1, 2, 4, 8, 16, 30, 60 seconds × 0.8–1 random jitter**, then keep retrying indefinitely in the 60-second tier. Backoff resets only after **30 seconds** of stable connection. Model requests do not bypass it; recovery, toggling one server and normal declaration updates preserve unchanged healthy peers.
- An outage of a selected `required` server rejects model requests until recovery without tearing down healthy peers. Background retries that detect a changed target declaration stop with `DECLARATION_CHANGED` until the next safe model-assembly / editor reconcile applies it.
- The panel shows amber `reconnecting`, a local countdown and attempt count, plus **Stop connecting / Retry now**. Invalid declarations, authentication failures and permanent spawn errors pause retries. Unconfirmed old-process shutdown (`CLOSE_UNCONFIRMED`) blocks even manual retries until a new session or Host restart. An unverified native version/interface explicitly reports unsupported monitoring and falls back to native connections without enhanced reconnect.
- **Drop detection**: connected HTTP servers are probed read-only (`HEAD`, 1.5 s timeout, no credentials; any HTTP response counts as alive). The first failure withdraws the green dot and shows "Unverified", re-checked after 1.2 s; only two consecutive failures hand the server to the reconnect supervisor, while any real successful call renews the confirmation. Cadence follows activity: 10 s while MCP work happens, 30 s after two minutes, and it stops after five idle minutes. Opening the panel and calling a tool whose confirmation is older than 5 s probe immediately; an unreachable endpoint then fails that call with a clear reason instead of waiting out the tool timeout, and the call is never replayed. `stdio` relies on the child-exit event and is not probed.
- Failed tools are never replayed; there is no UnityEditor server-startup automation. A typed call error identifying an HTTP session 404 schedules fresh initialization under backoff, without replaying that call.

See the [management UI reconnect contract](<docs/management-ui.md#auto-reconnect>) for details. Verification so far covers backend checks and the client build only, **not live deployment verification**. Host source changes require an actual Harness restart, not toggling the plugin row or assuming HMR.

## Install

Any one of three paths. All of them place the package in the profile's `node_modules`, after which `dsh.bundle.patch` inserts the `workspace-mcp-glue` row; confirm that `dsh-mcp-glue` is enabled on the plugin page.

- **From a Git repository (the usual published path)**: install it from the Plugins page, or let the CLI do it:
  ```powershell
  pnpm dsh plugin --profile <profile> add 'github:<owner>/dsh-mcp-glue'
  # pin a commit: 'github:<owner>/dsh-mcp-glue#<sha>'
  ```
  This path needs no build step: `lib/client.js` is committed, and `prepack` runs only for local packaging (DSH executes `pnpm add <spec>`, which does not run the pack lifecycle). The repository has no install-time script, so no dependency build script ever waits for approval.
- **Link install (recommended while iterating)**: link the profile to this directory without repacking each time. Rebuild client source changes and confirm the Host loads the new bundle; Host source changes require an actual Harness restart (reloading the plugin row does not re-import modules).
  ```powershell
  # run in the profile directory; the spec points at this project
  pnpm add link:<absolute path to this project>
  ```
- **tgz install**: run `pnpm pack` and install the generated tgz from the Plugins page (`prepack` rebuilds `lib/client.js` first).

Runtime code deliberately imports **no** `@deepseek-ai/dsh-*` module: scope identity lives in module-private symbols, and a second copy of those modules turns scoped registrations into global ones. The native MCP bridge is obtained from the Host Cordis loader, which loads the instance the runtime itself uses (see the [investigation notes](<docs/loading-model.md#6-模块实例身份第三方插件的关键约束>)).

`peerDependencies` declares only `@deepseek-ai/dsh: >=0.2.0-rc.2`, marked optional: DSH uses it for version compatibility at install and startup (it recognizes only the `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` prefixes) and refuses or warns when it is not satisfied. Marking it optional keeps pnpm from installing it and keeps it out of runtime imports. `engines.dsh` is documentation only and is not read at runtime.

Development and packaging (use Node 22.16+ for `node`/`pnpm`):

```powershell
pnpm install --ignore-scripts
pnpm run build      # builds the client half, lib/client.js (missing it means activation fails)
pnpm test
pnpm run check
pnpm pack
```

When installing through the CLI, check `dsh plugin --help` for the current version's arguments first. Do not import a project's MCP list into a profile directly.

Six hot-editable fields (`enabledBuiltins`, `presets`, `trustMode`, `trustedWorkspaces`, `workspaceAllowances`, `conflictPolicy`) are declared `.volatile()` in Config: `ctx.settings` treats only Loader rows with volatile fields as configurable (`describe()` drops the rest), and a write lands in the profile patch through `configEditor`, where the Loader applies it in place — **effective immediately after saving, with no restart**. Limits, secrets (`inputValues`, the `secret` role) and `webControl` are deliberately **not** hot-editable and never travel between the browser and the Host.

The same values can be written directly into the profile patch, overriding the row produced by the install (this bypasses the settings form but writes the same file and the same `config`):

```yaml
- id: workspace-mcp-glue
  config:
    enabledBuiltins: [root, vscode, codex, cursor, gemini]
    trustMode: manual          # manual | all (all trusts every repository — use with care)
    trustedWorkspaces:         # declarations in this directory load automatically; exact directory match
      - 'D:\Data\Project\trusted-project'
    workspaceAllowances:       # trust only these entries from this directory
      - workspace: 'D:\Data\Project\other-repo'
        allowMcp: [team-tools]
        allowTools: ['mcp__team-tools__identity']
    conflictPolicy: error
    webControl: true           # registers the management UI's same-origin control route; false leaves the UI unable to read state
```

### Trust and execution

Whether a declared server **auto-connects** is decided by three layers, strongest first; any hit loads it:

1. **`trustMode: all`** — trust everything: any repository's declarations may start local programs (a high-risk opt-in; do not use it on untrusted repositories).
2. **`trustedWorkspaces`** — every declaration in that **directory** may load automatically. The directory is matched **exactly** by normalized identity; subdirectories are not included.
3. **`workspaceAllowances[].allowMcp`** — only the listed servers in this workspace may load automatically.

When no layer matches, the server **stays unloaded** and the plugin **never opens an approval prompt by itself** (this differs from earlier versions). To start it, use the row's Connect action in the panel, or the "always trust this workspace" switch at the bottom of the panel. Authorization always comes from a user action in the UI; the plugin never asks on the user's behalf.

- The panel's connect/disconnect is **session-scoped**: it pins the choice to manual mode (`selectionMode: custom`), so later declaration changes cannot add back what was switched off. "Follow policy" returns to the layered decision.
- Disconnect is **sticky**: a restart or a new session returns to the policy decision (manual choices are not persisted).
- A project's own `includeTools`/`excludeTools` (Codex `enabled_tools`/`disabled_tools`, Gemini) are the **project's** tool filters and are unrelated to trust: a tool the project excludes is never available.
- **DSH native MCP stdio is started by the SDK and is not subject to the DSH file tools' execution sandbox.** Allowing a directory to auto-load means allowing the declarations inside it to start arbitrary programs, and approving one server does not exempt its tools from DSH's own tool-call policy.

### Tool-call gate

**Allowing a server to start** and **allowing one of its tools to be called** are separate decisions. When a tool comes from a workspace where the server is allowed but the tool is not in `allowTools`, the plugin asks the user first in the `tools/pre-execute` gate, with three answers:

| Answer | Effect |
|---|---|
| **Allow once** | Lets this call through; the next call asks again |
| **Always allow this tool** | Writes `mcp__<server>__<tool>` into that workspace's `allowTools`, so it stops asking (the panel's per-tool switches read and write the same list) |
| **Deny** | The call returns an error result; the model sees the reason and the turn continues |

- The question goes through `ctx.userQuestions` and renders as a card with options in the conversation. It is **not** a DSH approval dialog: only this path can offer three answers instead of allow-once/reject.
- **No question is asked** when `trustMode: all` applies, the workspace is in `trustedWorkspaces`, the tool is in `allowTools`, the deployment or the current session already runs `danger-full-access` (a global answer), the composition provides no question service, or the call comes from a delegated child agent (DSH does not let a child agent open a human interaction). The last two cases pass through directly so a tool call can never hang.
- A cancelled or timed-out question is treated as **deny** (fail closed), with the reason in the error.
- The gate **only covers servers this plugin mounts**: global MCP and servers mounted by other plugins are untouched.
- The DSH-side event contract, the `exec` fields, the four decision states, the relation to `tools.guard`, and how to determine full access correctly are in the [gate contract](<docs/gate-contract.md>).
- **A project's own tool filters win over every switch here**: `includeTools`/`excludeTools` (Codex `enabled_tools`/`disabled_tools`, Gemini) are enforced by `tools.guard` **after** this gate, and a guard can only deny. So a tool the project disables is **neither asked about nor re-enabled by the panel**: the gate skips it and the guard rejects it with an exact reason, while the panel marks the row "disabled by project" and offers no switch — no switch that could never take effect.
- No other client's auto-trust, OAuth or global user settings are read; a project cannot declare itself trusted.
- Declaration fields that affect authentication or isolation (OAuth, dynamic headers helpers, remote stdio, per-server sandbox, and so on) cause the server to be **skipped**, never silently downgraded. Native startup errors are logged as sanitized summaries; expanded secrets never reach the plugin log.

### Editing configuration (writing declaration files)

The MCP panel's title bar offers **+ New / Manage**; a server name and its `⋯` menu open the editor directly. Creation and editing happen in a dedicated large dialog that keeps the server list visible. The configuration location is chosen in the form, preferring this workspace's last writable location and then the project configuration. The panel keeps the "always trust this workspace" shortcut; per-server auto-connect and permission policy live in the management dialog.

- **Fields follow the transport**: the picker comes first. HTTP shows only `url` / `headers`; stdio shows only `command` / `args` / `env` / `cwd`. Commands, URLs and working directories are single-line; arguments are one per line; environment variables and headers are entered as key/value rows with values masked by default and an advanced JSON mode. Existing entries can gain fields they did not have before; duplicate or missing keys block submission.
- **Transport and file fields are separate**: root / vscode / cursor write `type` (`stdio` / `http`). Gemini and Codex also offer a transport picker, but it only filters the form and never writes a `type` that does not exist; the file's transport is inferred from the command or the address. Custom field mappings take part in that inference too.
- **`sse` is not offered**: the loader rejects a whole server with `UNSUPPORTED_SSE`, so the plugin refuses the value before writing instead of writing and rolling back.
- **Custom preset rules**: the deciding property is the preset's `dialect` — unset means `standard`, so a transport picker appears; which key is written is decided by `fields.transport` (unset means `type`). If a format has no notion of transport, map `fields: { transport: '' }` to the empty string so no unreadable `type` is written.
- **Switching the transport cleans up automatically**: saving deletes the previous transport's fields, including the old URL/headers or command/args/env/cwd; drafts survive a switch back, and hidden fields never take part in parsing or submission. Clearing an existing value in the form submits `null`, which deletes the key.
- **Surgical edits only**: exactly one path in the original document changes, and comments, key order, other servers and unrecognized keys are preserved byte for byte — JSONC through `jsonc-parser`'s `modify`, YAML through the Document API.
- **TOML can be edited, appended to, deleted from and migrated**: the existing `@iarna/toml` dependency rewrites the whole file, so **comments and layout may be lost** while other values survive. The form warns about this, and saving, deleting or migrating asks for a separate confirmation; the backend also requires a strict `allowLossy: true` and writes nothing without it. Creating a TOML file that does not exist yet needs no such confirmation, and the version guard and rollback still apply.
- **Drafts and version guard**: closing, switching servers or reloading asks before discarding an unsaved draft, and a failure never clears the form. Editing pins the version token read when the form opened; if the file changed elsewhere the write returns 409, and even an automatic list reload cannot silently replace someone else's content. Only after confirming the discard does a reload adopt the newest file.
- **Saving and connecting are separate**: an ordinary save grants no new connection; "Save and connect" explicitly asks the current session to connect, and stdio may start a local program. The workspace trust and auto-connect policy still apply.
- **Validate after writing, roll back on failure**: the file is re-read through the same loader path immediately; if the new content does not parse, the entry disappeared, or loading fails, the original bytes the Host returned are restored exactly and the reason is reported.
- **Writes stay inside the workspace**: the target path must lie within the current workspace.
- **Read-only sessions cannot write**: when the sandbox is `read-only`, the editor is read-only in the session and explains why; `workspace-write` and above may save.
- **These files are shared**: `.mcp.json` is also read by VS Code and Cursor, and `.codex/config.toml` belongs to Codex. Which file and which key changed is written to the Host log.
- **New servers**: a server can be created from nothing, creating the file if needed (TOML included).
- **Copy / migrate to another preset**: the connection fields are read as canonical fields and written for the target preset; a `transport` the target dialect cannot express is not written. Advanced fields that are not yet convertible (tool filters, credential forwarding, timeouts) make the copy fail rather than silently lose meaning; the same physical file may not be copied onto itself through a preset alias. A failed migration rolls the source and the target back under the version guard.
- **Same names must migrate, not coexist**: the same server name in two declaration files is a conflict in DSH, and the loader disables **both** according to `conflictPolicy`. A same-name copy that keeps the original is rejected; rename it or tick "delete the original after copying". Migration deletes the source and then validates, leaving no conflicting state in between, and rolls the whole operation back if the source cannot be deleted.
- Unrecognized fields are still untouched: an edit changes only those six fields, a deletion only that one entry.

## Session isolation and updates

- The only workspace root is `agent.session.header.cwd`; the Host's current directory is ignored, no parent directory is searched for a project root, and global user MCP configuration is not read.
- The same server name may appear in workspaces A and B; their processes, tools, resources and instructions stay isolated. Different sessions in the same workspace connect separately and share no mutable process.
- Pre-existing global MCP stays visible to sessions; a project tool with the same name shadows the global tool by DSH's scoped rules. The plugin never removes global MCP.
- Declarations are re-read while every model request is assembled: additions, edits and deletions take effect on the **next model request**, never in the middle of a running tool call.
- Normal updates re-apply policy (directory trust / allow list) and diff each server's spec/source: only removed, changed or deselected entries are unmounted; new/changed entries load independently, preserving unchanged healthy connections and child fibers.
- A session that is already running loads safely on the next request after the plugin is installed or hot-reloaded. Unloading the plugin or releasing the Agent closes its connections and removes its scoped tools, resources and instructions.
- Syntax errors and unsupported servers are recorded as bounded diagnostics and skipped without affecting other valid servers; deleting a declaration does not leave the old server behind. A Codex server with `required: true` that is **invalid, fails to start or disconnects at runtime** rejects model requests instead of silently downgrading. Eligible supervised retries recover runtime failures without model requests bypassing backoff or tearing down healthy peers. An unauthorized, unselected server is different: it is simply not loaded, not an error, and the plugin never interrupts a session over a user's silence.
- Loading happens during `system-prompt/assemble`, so added or removed servers take effect in the **current** request rather than the next turn.
- Tool allow/deny lists are enforced by a guard this plugin registers before the call: only tools registered in that project's scope are restricted, and global MCP with the same name prefix is unaffected. A blocked tool may still appear in the schema list, but direct and PTC calls are both rejected.

## Custom presets

The full example is in [custom presets](<examples/custom-presets.patch.yml>). Any workspace-relative file location, parse format, servers-table path and field mapping can be defined, and built-in presets can be extended or overridden:

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

      # override a built-in preset by id, without touching the plugin source
      - id: cursor
        enabled: false
```

That team's declaration may look like this:

```yaml
integrations:
  mcp:
    local:
      executable: node
      arguments: ['${workspaceFolder}/tools/server.js']
      environment:
        API_TOKEN: '${env:MY_TOKEN}'
```

`serversPaths` and `fields` accept dot paths or RFC 6901 JSON Pointers; the empty string means the object root. A servers table must be a name-to-object mapping; arrays, globs and arbitrary JS/eval are not supported. File paths and `envFile` must resolve inside the workspace after normalization, and directory junctions or symlink escapes are rejected.

Mappable fields: `transport`, `command`, `args`, `env`, `cwd`, `url`, `headers`, `enabled`, `disabled`, `envFile`, `envVars`, `envHeaders`, `bearerTokenEnv`, `timeoutMs`, `timeoutSeconds`.

Formats: `json`, `jsonc`, `toml`, `yaml`. Dialects: `standard`, `codex`, `gemini`. `extends` may inherit a built-in or an earlier custom preset; custom presets are appended in definition order, and the built-in order is decided by `enabledBuiltins`.

### Variables and credentials

- `standard` supports `${VAR}`, `${VAR:-default}`, `${env:VAR}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`, `${pathSeparator}`, `${/}`, `${configDir}` and `${input:id}`.
- `shell` (the Gemini default) adds `$VAR` and `%VAR%`; `none` (the Codex default) keeps literal strings.
- `${input:id}` reads only the Host plugin configuration `inputValues`, whose values are marked `secret` in the settings schema; VS Code's `inputs.command` is never executed.
- A missing variable or input value **rejects that server**, so empty credentials or leftover placeholders can never be used. This is this plugin's conservative policy and does not claim to reproduce every client's interpolation-failure behavior.
- `envFile` is a UTF-8 dotenv file inside the workspace, parsed literally; an explicit `env` overrides its values. It does not become an interpolation source for other fields.
- Codex `env_vars` forwards the named host variables, `env_http_headers` reads the variable named by each header, and `bearer_token_env_var` reads a token and adds `Bearer`. Remote sources are not supported.
- Interpolation happens once; `$`/`${...}` inside a secret is never expanded recursively. The plugin's own diagnostics record only preset names, file names, server names and error codes; native bridge startup errors are reduced to summaries without a body, so secrets never reach the log through a spawn error.
- A relative `command` resolves against the declared `cwd` (the workspace when unset), matching clients that resolve in the child process's working directory. A NUL character in `args`/`cwd` is rejected.

### Conflicts and limits

- The default `conflictPolicy: error` disables same-name servers whose configurations differ between sources; identical declarations are deduplicated. `first-wins`/`last-wins` replace a whole entry and never mix credentials.
- The plugin supports DSH native **stdio / Streamable HTTP**; `type: http` maps to Streamable HTTP. When no type is given it is inferred from command/url, which is loader-compatible behavior rather than Claude's strict validation.
- Gemini `httpUrl` is HTTP while `url` is the old SSE, and the two are never confused.
- SSE, WebSocket, OAuth, dynamic headers helpers, remote stdio and per-server sandbox policies are not supported yet; declarations using them for security or authentication are skipped rather than silently downgraded.
- Codex `enabled_tools`/`disabled_tools` and Gemini `includeTools`/`excludeTools` are enforced as **call restrictions** (exclusions win). A blocked tool may still appear in the schema list, but direct and PTC calls are rejected by the guard. Gemini `trust` never auto-approves tools.
- Deleting an inherited variable with a null value in VS Code `env` is not supported, and non-string/non-number environment values are rejected. No other client's per-tool approval or output-truncation policy is imported.
- Non-native safe server names are normalized deterministically with a hash suffix; a name containing `__` or ending in `_` is hashed too, so native unescaped separators cannot overlap tool identities or filter prefixes.
- Defaults: 1 MiB per file, 32 server entries checked, 15 seconds per startup. Codex `startup_timeout_sec` overrides a single server's startup timeout. **Several servers start concurrently** (up to 6 at a time, `MOUNT_CONCURRENCY`), so a generation takes as long as its slowest server rather than the sum: on this machine one stdio server takes about 470 ms, five in sequence would take 2.4 s, while reading and parsing all declaration files takes about 3 ms.
- **Local Host filesystems only.** Native MCP stdio has no SSH subprocess seam, so remote filesystems are rejected and no remote declaration can be started on the Host by mistake.

## Investigation and verification

[The DSH loading-chain investigation](<docs/loading-model.md>) records the native loading path, the extension points and why project configuration cannot live in the global Loader. [The management UI document](<docs/management-ui.md>) records the control contract, the control route and the token boundary. [The test suite](<test/runtime.test.js>) uses the real Cordis/DSH MCP bridge and a local JSON-RPC fixture to cover concurrent workspace isolation, updates, resources and instructions, the first request and unmounting. [The HTTP tests](<test/http.test.js>) drive token injection → status → manual connect over a real `dsh-host-webserver`.

External format references:

- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [VS Code configuration fields](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)
- [Cursor MCP](https://cursor.com/docs/mcp)
- [Gemini MCP](https://geminicli.com/docs/tools/mcp-server/)

This package is a **declaration-format compatible loader**, not a complete runtime or authentication implementation of those clients.
