# AGENTS.md

## Project goal

Build a lightweight VS Code remote experience for Tensorlake sandboxes that does **not** install or run VS Code Server inside the sandbox.

Tensorlake free sandboxes may have only 1 GB RAM, so the remote architecture must keep the sandbox-side footprint minimal.

The primary implementation target is a **virtual workspace backed by Tensorlake APIs**, not a reimplementation of the full VS Code Remote Extension Host.

The first-class user experience must cover:

- Browse and edit files in a Tensorlake sandbox from VS Code Explorer/editor.
- Open an interactive terminal backed by Tensorlake PTY.
- Run commands/tasks through Tensorlake Processes where useful.
- Create/list/resume/suspend/delete sandboxes.
- Reconnect cleanly after a sandbox is resumed or temporarily unavailable.
- Avoid installing any persistent agent, daemon, `vscode-server`, `code-server`, or Remote-SSH server payload inside the sandbox.

## Non-goals

Do not attempt to make every VS Code extension think it is running inside a normal VS Code Remote Extension Host.

Extensions that require a true remote extension host, local Unix sockets inside the sandbox, or direct local-process access to the remote filesystem may not work. That limitation is acceptable for this design.

Do not use Remote-SSH as the primary connection path.

Do not copy the entire sandbox filesystem locally.

Do not add a long-running custom backend process in the sandbox unless Tensorlake's documented APIs are proven insufficient.

## Source of truth

Before implementing or changing Tensorlake behavior, verify it against current official Tensorlake documentation/OpenAPI.

Relevant Tensorlake documentation areas:

- Sandbox lifecycle
- Sandbox Files API
- Sandbox Processes API
- Sandbox PTY API / PTY WebSocket
- Authentication
- Sandbox status/state model
- OpenAPI schema

Do not guess endpoint shapes, websocket protocols, authentication headers, sandbox status values, response schemas, file metadata fields, or PTY message formats.

Wrap raw API details behind a client layer so endpoint changes do not leak through the VS Code integration.

---

# Architecture blueprint

## 1. Top-level design

The architecture is local-first:

```text
VS Code
  |
  |-- Remote Tensorlake extension
  |     |
  |     |-- Tensorlake API client
  |     |     |-- Lifecycle API
  |     |     |-- Files API
  |     |     |-- Processes API
  |     |     `-- PTY API / WebSocket
  |     |
  |     |-- Tensorlake FileSystemProvider
  |     |-- Tensorlake Pseudoterminal
  |     |-- Sandbox session manager
  |     `-- Commands / tree view
  |
  `-- virtual workspace URI
        tensorlake://<sandbox-id>/<absolute-path>
```

Nothing equivalent to VS Code Server should run in the Tensorlake sandbox.

All filesystem and terminal traffic should go directly from the local VS Code extension host to Tensorlake's documented APIs.

## 2. Proposed source layout

Keep the existing lifecycle code working, but gradually move responsibilities out of the current large `src/services/tensorlake.ts`.

Preferred structure:

```text
src/
  extension.ts

  models/
    types.ts
    tensorlake.ts

  providers/
    SandboxProvider.ts

  tensorlake/
    client.ts
    lifecycle.ts
    files.ts
    processes.ts
    pty.ts
    errors.ts

  remote/
    TensorlakeSessionManager.ts
    TensorlakeFileSystemProvider.ts
    TensorlakePseudoterminal.ts
    workspace.ts
    uri.ts
```

Responsibilities:

### `tensorlake/client.ts`

Owns shared HTTP/WebSocket concerns:

- Base URLs
- Authentication
- Request creation
- Response parsing
- Tensorlake error normalization
- Abort/cancellation plumbing

No VS Code UI should live here.

### `tensorlake/lifecycle.ts`

Owns:

- get sandbox
- list sandboxes
- create sandbox
- resume sandbox
- suspend sandbox
- delete sandbox
- wait until a sandbox reaches a usable state

### `tensorlake/files.ts`

Owns documented Tensorlake file operations only.

Expose a stable internal interface such as:

```ts
interface TensorlakeFiles {
  stat(path: string): Promise<RemoteFileStat>;
  readDirectory(path: string): Promise<RemoteDirEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array, options: WriteOptions): Promise<void>;
  createDirectory(path: string): Promise<void>;
  delete(path: string, options: DeleteOptions): Promise<void>;
  rename(oldPath: string, newPath: string, options: RenameOptions): Promise<void>;
}
```

The exact implementation must follow Tensorlake's current documented API. Do not invent an HTTP endpoint because this interface exists.

### `tensorlake/processes.ts`

Owns non-interactive command/process operations.

Use it for things such as:

- Resolving the sandbox's default working directory when required.
- One-shot commands.
- Future VS Code task execution support.
- Metadata fallbacks only when the Files API does not expose required information and the official Processes API provides a documented way to obtain it.

Do not use shell commands for normal file operations if Tensorlake has a native Files API for them.

### `tensorlake/pty.ts`

Owns PTY session creation and the documented WebSocket protocol.

It should expose a transport-neutral abstraction to the VS Code layer:

```ts
interface TensorlakePtySession {
  onData(listener: (data: string) => void): vscode.Disposable;
  onExit(listener: (code?: number) => void): vscode.Disposable;
  write(data: string): Promise<void> | void;
  resize(cols: number, rows: number): Promise<void> | void;
  close(): Promise<void>;
}
```

The VS Code layer must not know Tensorlake's raw WebSocket message format.

### `remote/TensorlakeSessionManager.ts`

Tracks active local connections by sandbox id.

Responsibilities:

- Ensure the API key exists.
- Fetch the current sandbox state.
- Resume a suspended sandbox when a user explicitly connects.
- Wait until the sandbox APIs are usable.
- Deduplicate concurrent connect/resume attempts.
- Hold lightweight per-sandbox state.
- Dispose PTYs and other live resources when appropriate.

It must not keep a permanent process alive in the sandbox.

### `remote/TensorlakeFileSystemProvider.ts`

Implements `vscode.FileSystemProvider`.

It translates VS Code filesystem operations into `tensorlake/files.ts`.

Required methods:

- `stat`
- `readDirectory`
- `readFile`
- `writeFile`
- `createDirectory`
- `delete`
- `rename`
- `watch`

Register with:

```ts
vscode.workspace.registerFileSystemProvider(
  "tensorlake",
  provider,
  {
    isCaseSensitive: true,
    isReadonly: false,
  },
);
```

Only change `isCaseSensitive` if Tensorlake documentation or sandbox behavior proves otherwise.

### `remote/TensorlakePseudoterminal.ts`

Implements `vscode.Pseudoterminal`.

Responsibilities:

- Create/connect a Tensorlake PTY session.
- Forward PTY output through `onDidWrite`.
- Forward keyboard input from `handleInput`.
- Forward terminal resize events.
- Close the remote PTY when the terminal is disposed.
- Ensure WebSocket resources are cleaned up exactly once.
- Surface connection errors to the user without crashing the extension host.

### `remote/uri.ts`

The canonical virtual filesystem URI format is:

```text
tensorlake://<sandbox-id>/<absolute-path>
```

Examples:

```text
tensorlake://sb_123/home/user/project
tensorlake://sb_123/etc/hosts
```

Rules:

- URI authority = Tensorlake sandbox id.
- URI path = absolute path inside that sandbox.
- Always normalize POSIX paths.
- Never use the local OS path separator for remote paths.
- Reject path traversal that escapes the intended normalized absolute path representation.
- Do not encode sandbox credentials in the URI.

### `remote/workspace.ts`

Owns opening/adding Tensorlake virtual workspace folders.

It should create a workspace URI from the sandbox id and resolved remote path, then use native VS Code workspace APIs.

No Remote-SSH command should be involved.

## 3. Connection flow

The intended connect path is:

```text
User clicks Connect
  |
  v
Validate Tensorlake API key
  |
  v
Fetch sandbox state
  |
  +-- suspended --> resume through lifecycle API
  |
  v
Wait for usable/running state
  |
  v
Resolve initial remote workspace path
  |
  v
Create tensorlake:// URI
  |
  v
Open/add virtual workspace folder
  |
  +--> Explorer/editor uses FileSystemProvider
  |
  `--> terminal command creates Tensorlake PTY on demand
```

The old path:

```text
Connect -> create SSH config -> Remote-SSH -> install vscode-server
```

is legacy behavior and should be removed once the API-backed remote path is complete.

## 4. Initial workspace path

Do not hard-code an assumed Tensorlake home directory unless current official documentation guarantees it.

Resolution order should be explicit:

1. Use a documented sandbox home/workdir field if Tensorlake exposes one.
2. Otherwise resolve it through a documented Processes API call.
3. If neither is available, use a documented stable default.
4. Only then fall back to `/`.

Persisting the last opened path per sandbox in VS Code local/global state is acceptable.

## 5. FileSystemProvider behavior

### `stat`

Map Tensorlake metadata to:

- `vscode.FileType.File`
- `vscode.FileType.Directory`
- symbolic-link type only if Tensorlake's API exposes enough information to support it correctly
- size
- ctime
- mtime

If required timestamps are not available from the Files API, verify a documented alternative before inventing values.

### `readDirectory`

Return immediate children only.

Do not recursively list a directory when VS Code asks for one level.

Sort order should normally be left to VS Code unless there is a strong UX reason otherwise.

### `readFile`

Use binary-safe transfer.

Never decode a remote file as UTF-8 inside the filesystem layer.

Return raw `Uint8Array`.

### `writeFile`

Respect VS Code's `create` and `overwrite` flags.

Do not silently overwrite a file when VS Code requested otherwise.

For larger files, use Tensorlake's documented upload mechanism rather than converting arbitrarily large content to JSON strings if the API provides a streaming/upload path.

### `createDirectory`

Match normal filesystem semantics as closely as Tensorlake permits.

Translate documented "already exists", "parent missing", and permission errors into appropriate `vscode.FileSystemError` values.

### `delete`

Respect recursive behavior.

Do not recursively delete unless VS Code explicitly requested it.

### `rename`

Respect overwrite behavior.

If Tensorlake has no native rename operation, only implement a copy/delete fallback after verifying that it is safe and preserves expected semantics. Do not casually implement rename by shell command.

### `watch`

Tensorlake may not provide native filesystem change events.

If there is no documented watch API:

- return a disposable watch registration
- emit local change events for operations performed through this extension
- do not aggressively poll the remote filesystem by default
- optionally add low-frequency polling later if it has clear value and bounded API cost

The initial implementation may therefore provide best-effort local coherence rather than real-time external-change detection.

### File change events

After successful extension-initiated mutations, fire appropriate `onDidChangeFile` events for:

- Created
- Changed
- Deleted

Include affected parent directories when needed so Explorer refreshes correctly.

## 6. Error mapping

Create one normalization layer for Tensorlake errors.

Map expected cases into VS Code filesystem errors where possible:

- missing path -> `FileNotFound`
- existing destination -> `FileExists`
- permission/auth failure -> `NoPermissions`
- invalid directory/file operation -> appropriate filesystem failure
- unavailable/suspended sandbox -> reconnect/resume path, not a misleading "file not found"

Do not expose API keys, bearer tokens, websocket credentials, or sensitive request headers in logs.

## 7. PTY / terminal design

A terminal is created locally using `vscode.window.createTerminal({ pty })`.

The `Pseudoterminal` implementation then connects to Tensorlake PTY.

Data flow:

```text
keyboard
  -> Pseudoterminal.handleInput
  -> Tensorlake PTY transport
  -> remote shell/process

remote PTY output
  -> Tensorlake PTY WebSocket
  -> Pseudoterminal.onDidWrite
  -> VS Code terminal
```

Resize flow:

```text
VS Code terminal dimensions
  -> setDimensions
  -> Tensorlake PTY resize operation
```

Lifecycle:

- Do not create a PTY merely because a sandbox workspace was opened.
- Create it only when the user opens a terminal.
- Close remote PTY/WebSocket when the terminal closes.
- Handle remote EOF/exit exactly once.
- Do not reconnect a dead shell invisibly if that would create a second process.
- If the transport disconnects unexpectedly, surface a clear terminal/session error and allow the user to reopen it.

Use the sandbox's resolved workspace path as the PTY working directory when the API supports it.

## 8. Processes API design

Processes API is separate from PTY.

Use PTY for interactive shells.

Use Processes for:

- one-shot commands
- future task execution
- non-interactive tooling
- lightweight discovery calls required by the integration

A future task provider can translate a VS Code task into a Tensorlake process and stream stdout/stderr locally.

Do not implement this before filesystem + PTY are stable unless required by another feature.

## 9. Ports, ingress, and optional local tunnels

For normal development web servers, **prefer Tensorlake's built-in networking/ingress URL** instead of creating a localhost tunnel.

Tensorlake documents networking for routing inbound internet traffic to sandbox applications separately from Local Tunnels. The extension should therefore treat the public/ingress URL as the primary port UX for HTTP/HTTPS services.

### Primary flow: Tensorlake public URL

When a user wants to expose a web app running on a sandbox port:

```text
sandbox process listening on :3000
        |
        v
Tensorlake networking / ingress
        |
        v
Tensorlake-provided public URL
        |
        v
Open in browser / copy URL
```

The extension should obtain the public endpoint from Tensorlake's documented sandbox/networking API. The current sandbox model already exposes ingress-related metadata; do not fabricate hostnames or reverse-proxy URLs locally.

Desired commands/actions:

```text
Tensorlake: Open Port
Tensorlake: Copy Public URL
Tensorlake: Open Public URL in Browser
```

The UI may present these under a sandbox-owned `Ports` or `Endpoints` section.

For a known remote port, show the Tensorlake-provided public URL directly. Do not create an unnecessary local listener just to open an HTTP service in the browser.

### Optional flow: local TCP tunnel

Use Tensorlake Local Tunnels only when a **local TCP endpoint is actually required**, for example:

- a database client expecting `localhost:<port>`
- VNC or another non-HTTP protocol
- Redis
- arbitrary TCP tools
- software that cannot consume Tensorlake's public URL

Flow:

```text
127.0.0.1:<local-port>
        |
        | Tensorlake Local Tunnel
        v
sandbox:<remote-port>
```

Tensorlake documents Local Tunnels as forwarding a local TCP port to a sandbox port over an authenticated WebSocket. Keep that implementation isolated behind a tunnel transport module.

Do not make local tunneling the default for web development.

### Proposed modules

Keep networking and local tunnels separate:

```text
src/
  tensorlake/
    networking.ts
    tunnels.ts       # only if local TCP tunnels are implemented

  remote/
    TensorlakeEndpoints.ts
    TensorlakePortForwarder.ts  # optional local-tunnel feature
```

`tensorlake/networking.ts` owns discovery/normalization of Tensorlake-provided ingress/public endpoints.

`TensorlakeEndpoints.ts` owns the VS Code-facing representation of sandbox ports/endpoints and actions such as Open in Browser and Copy URL.

`tensorlake/tunnels.ts` and `TensorlakePortForwarder.ts` are optional and only needed for localhost-style TCP forwarding.

### Do not conflate the transports

```text
Filesystem:
  Tensorlake Files API

Terminal:
  Tensorlake PTY WebSocket

Web service exposure:
  Tensorlake Networking / public ingress URL

Optional localhost TCP forwarding:
  Tensorlake Local Tunnel
```

Do not multiplex these through one custom WebSocket.

### Port/endpoints UX

Prefer an extension-owned `Ports` or `Endpoints` section unless a stable public VS Code API is verified to integrate third-party endpoints into the built-in Ports view.

Example:

```text
Tensorlake Sandboxes
  my-sandbox
    Ports / Endpoints
      3000  https://<tensorlake-provided-url>
      8080  https://<tensorlake-provided-url>
```

Useful actions:

- Open in Browser
- Copy Public URL
- Copy Port
- Refresh Endpoints
- Forward to Localhost (optional, only when the user explicitly wants a local TCP tunnel)

### Lifecycle behavior

When a sandbox is suspended or terminated, mark its endpoints unavailable rather than showing them as healthy.

After resume/reconnect, refresh endpoint metadata from Tensorlake.

Do not assume a previously returned public endpoint or local tunnel is still valid unless Tensorlake documentation guarantees that stability.

### Acceptance criteria

- a web server running in the sandbox can be opened using Tensorlake's own public URL without VS Code Server or Remote-SSH
- the URL is obtained from Tensorlake rather than constructed locally
- endpoint state refreshes after sandbox lifecycle changes
- local TCP tunneling is not required for normal HTTP/HTTPS development
- optional localhost forwarding can be added separately for non-HTTP/local-client use cases

## 9. Sandbox lifecycle behavior

### Connect to running sandbox

Do not restart it. Open the virtual workspace directly.

### Connect to suspended sandbox

Resume it through Tensorlake lifecycle API, wait until usable, then open the workspace.

### Busy/transitional sandbox

Show progress and wait only for documented transitional states.

Use a bounded timeout and cancellation where possible.

### Failed/terminated sandbox

Do not attempt filesystem/PTTY operations. Surface the actual state.

### Suspend

Before suspension:

- warn or block if active PTY sessions exist when suspension would destroy them
- dispose local transport state after the API operation succeeds

### Delete

Require explicit confirmation.

Dispose local sessions and remove stale cached state for that sandbox after successful deletion.

## 10. Session and concurrency rules

Multiple VS Code operations may hit the same sandbox simultaneously.

The session manager should deduplicate:

- resume requests
- readiness waits
- connection initialization

Avoid a situation where opening Explorer and Terminal simultaneously triggers multiple resumes.

Use one logical local session record per sandbox id, but allow multiple independent PTY sessions inside it.

Do not serialize unrelated file reads unnecessarily.

## 11. Authentication

Continue to support the configured Tensorlake API key.

Prefer VS Code `SecretStorage` for long-term credential storage if/when credentials are migrated out of plain settings.

Never put the API key in:

- workspace files
- URIs
- logs
- terminal environment unless Tensorlake explicitly requires that mechanism

Environment-variable support may remain for development/compatibility.

## 12. Logging

Keep one output channel, e.g. `Remote Tensorlake`.

Log high-value events:

- sandbox state transitions
- connect/resume attempts
- filesystem operation failures
- PTY open/close/failure
- API status/error summaries

Do not log file contents or credentials.

Avoid logging every successful small file read/write by default because editor activity can be noisy.

## 13. VS Code commands

Target command set:

```text
Tensorlake: Set API Key
Tensorlake: Create Sandbox
Tensorlake: Refresh Sandboxes
Tensorlake: Connect
Tensorlake: Connect in New Window
Tensorlake: Open Terminal
Tensorlake: Suspend Sandbox
Tensorlake: Resume Sandbox
Tensorlake: Delete Sandbox
```

"Connect" should mean opening the API-backed Tensorlake virtual workspace.

It should no longer mean "generate SSH config and invoke Remote-SSH".

Keep old command IDs temporarily only if needed for compatibility, then migrate them cleanly.

## 14. Tree view behavior

The sandbox tree remains the lifecycle/navigation surface.

For each sandbox:

- display name/id
- display status
- Connect action for usable/resumable states
- Suspend for running named sandboxes where Tensorlake permits it
- Resume for suspended sandboxes
- Delete/terminate action

Do not couple tree rendering to filesystem implementation details.

## 15. Legacy SSH removal plan

Do not delete working SSH code until the new API-backed path compiles and basic virtual workspace + PTY behavior exists.

Migration order:

1. Add Tensorlake API client modules.
2. Add URI helpers.
3. Add FileSystemProvider.
4. Add workspace open/connect flow.
5. Add Pseudoterminal/PTTY support.
6. Switch Connect commands to the virtual workspace path.
7. Validate normal editing and terminal behavior.
8. Remove Remote-SSH dependency and SSH config generation.
9. Remove stale README/package metadata related to SSH.
10. Package/test extension.

This ordering reduces breakage while another agent may be implementing adjacent pieces.

## 16. Expected limitations of the lightweight remote

This architecture provides remote **files + terminal + process access**.

It does not create a true remote VS Code extension host.

Therefore:

- Language servers started by normal local extensions may run locally and read files through the virtual filesystem if those extensions support virtual workspaces.
- Extensions that explicitly require a local filesystem path may not work with `tensorlake://` URIs.
- Extensions that expect binaries to execute "inside the remote VS Code host" will not automatically execute inside Tensorlake.
- Remote development features that are hard-coded to Microsoft's remote extension architecture may not behave identically.

Do not hide these limitations by silently reintroducing VS Code Server.

Later compatibility improvements should be targeted and lightweight.

## 17. Performance rules

Remember the reason for this architecture: Tensorlake may have only 1 GB RAM.

Sandbox-side memory usage from this extension should be approximately the cost of the user's shell/processes only.

Avoid:

- vscode-server
- code-server
- Node daemon installed only for this extension
- filesystem mirror services
- constant recursive polling
- unnecessary background PTYs

On the local side:

- cache metadata briefly when useful
- avoid duplicate API requests
- invalidate caches after mutations
- do not cache entire large files without need

## 18. Implementation phases

### Phase 1: client foundation

Deliver:

- lifecycle client separated from VS Code UI
- Files API wrapper
- normalized errors
- URI helpers

Acceptance:

- project compiles
- current sandbox lifecycle tree still works

### Phase 2: virtual filesystem

Deliver:

- registered `tensorlake` FileSystemProvider
- stat/list/read/write/create/delete/rename
- workspace open command

Acceptance:

- open a sandbox folder in Explorer
- open a text file
- edit/save it
- create/delete/rename files and directories

### Phase 3: terminal

Deliver:

- Tensorlake PTY transport wrapper
- `vscode.Pseudoterminal`
- resize/input/output/close handling
- Open Terminal command

Acceptance:

- interactive shell works
- resize works
- Ctrl+C/input works as documented by Tensorlake PTY
- closing terminal cleans up transport

### Phase 4: switch primary connect path

Deliver:

- Connect opens `tensorlake://` workspace
- suspended sandbox auto-resumes on explicit connect
- SSH/Remote-SSH no longer used for primary flow

Acceptance:

- normal connect does not install VS Code Server
- no Remote-SSH dependency required for normal operation

### Phase 5: cleanup

Deliver:

- remove obsolete SSH config code
- remove obsolete Remote-SSH recommendation/dependency
- update README
- package VSIX

Acceptance:

- TypeScript compile passes
- VSIX packages successfully
- no stale SSH code remains unless explicitly retained as an optional fallback

---

# Concurrent-agent rules

Another agent may be editing this repository at the same time.

Before every edit:

1. Run `git status` and inspect the current diff.
2. Re-read the target file immediately before changing it.
3. Treat unrecognized modifications as work owned by another agent.
4. Never overwrite, revert, reset, stash, or delete another agent's changes.

While editing:

- Prefer adding focused new modules over broad rewrites of shared files.
- Make the smallest integration change necessary in shared entrypoints.
- Avoid formatting unrelated code.
- Do not rename/move files unless required.
- Do not perform sweeping refactors while another agent is active.
- Keep commits narrowly scoped so changes can be reviewed or reverted independently.
- If another agent has already implemented part of this blueprint, adapt to that implementation rather than replacing it wholesale.

If a target file changed since it was last read, stop editing that file, inspect the new diff, and adapt the patch to the latest version.

# Validation

Use `rtk` by default for supported CLI operations.

For code changes, run the relevant checks before considering the work complete.

At minimum:

- TypeScript compile
- package/VSIX build when package metadata changes
- focused manual validation for virtual filesystem behavior when possible
- focused manual validation for PTY behavior when possible

Never report a check as passing unless it was actually executed.

# Review/fix workflow

The primary implementation may be produced by another agent. When reviewing its work:

- Check correctness against Tensorlake's official API.
- Look for unnecessary VS Code Server/Remote-SSH dependencies.
- Check lifecycle, reconnect, timeout, cancellation, and error paths.
- Check FileSystemProvider semantics, including stat/readDirectory/readFile/writeFile/createDirectory/delete/rename/watch behavior.
- Check binary file handling.
- Check VS Code FileSystemError mapping.
- Check PTY resize, input, close, exit, and disposal behavior.
- Check websocket/process cleanup.
- Check duplicate resume/connect races.
- Check that no credentials appear in logs or URIs.
- Check that virtual-workspace limitations are not misrepresented as full VS Code Remote compatibility.
- Prefer targeted fixes over redesigning working code.

# Git safety

Do not push, force-push, reset, rebase, or rewrite history unless explicitly requested.

Never discard local work that you did not create.