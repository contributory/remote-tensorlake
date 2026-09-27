# Remote Tensorlake

Remote Tensorlake is a lightweight VS Code remote workspace extension for
[Tensorlake](https://tensorlake.ai) sandboxes.

It is designed for small sandboxes where running the full VS Code Server is too
expensive. The extension stays in the local VS Code extension host and talks to
Tensorlake's sandbox APIs directly.

## How it works

Normal remote access does **not** install or run `vscode-server`,
`code-server`, or a custom daemon in the sandbox.

- Explorer/editor access uses the Tensorlake Files API through a
  `tensorlake://<sandbox-id>/...` virtual filesystem.
- Integrated terminals use Tensorlake PTY sessions over WebSocket.
- Lightweight helper commands use the Tensorlake Processes API.
- Sandbox create/list/resume/suspend/delete uses the Tensorlake management API.
- Web development ports use Tensorlake's public ingress URLs.

The only sandbox-side memory consumed by the remote experience is the user's
own shell/processes plus Tensorlake's existing sandbox services.

## Requirements

- VS Code 1.80.0 or later
- A Tensorlake project API key
- Node.js 18 or later for development

The Microsoft Remote - SSH extension is **not required** for the lightweight
remote path.

## Development

```bash
npm install
npm run compile
```

Open the project in VS Code and press `F5` to launch an Extension Development
Host.

To package a VSIX:

```bash
npx vsce package
```

## Usage

Open **Remote Tensorlake** in the Activity Bar.

The sandbox tree supports:

- Create sandbox
- Connect in the current window
- Connect in a new window
- Open a Tensorlake PTY terminal
- Suspend/resume named sandboxes
- Terminate a sandbox
- Expose a public port through Tensorlake ingress
- Refresh sandbox state

### Connect

**Connect** starts or resumes the selected sandbox and opens `/home/tl-user`
directly as a `tensorlake://` virtual workspace through VS Code's `vscode.openFolder` API.

- **Tensorlake: Open Folder...** can switch to another sandbox directory through
  the Tensorlake Files API.
- **Clone Git Repository...** is available when `git` exists in the sandbox.
  The clone runs inside Tensorlake and the cloned directory is opened afterward.
- **Open Extensions** opens the normal VS Code Extensions view.

Opening a selected directory produces a URI such as:

```text
tensorlake://<sandbox-name>/.tensorlake/<sandbox-id>/home/tl-user/workspace
```

Files are read and written as raw bytes through the Tensorlake sandbox proxy.
Directory creation and rename operations use lightweight Tensorlake process
calls where the Files API does not expose equivalent operations.

### Terminal

**Tensorlake: Open Terminal** creates a PTY session through Tensorlake's PTY API
and connects it to a VS Code `Pseudoterminal`. Tensorlake connection workspaces
set this profile as the workspace default, so **New Terminal** opens the remote
PTY instead of a local shell. Folder context menus also provide **Open in
Tensorlake Terminal** and start the shell in the selected remote directory.

Terminal input, output, resize events, Ctrl+C, and process exit all travel over
the Tensorlake PTY WebSocket protocol. No VS Code Server is installed.

### Public ports

**Tensorlake: Expose Public Port** adds a port to the sandbox's
`exposed_ports` and enables unauthenticated ingress for the sandbox.

Tensorlake routes user services with URLs of the form:

```text
https://<port>-<sandbox-id-or-name>.sandbox.tensorlake.ai
```

The extension offers **Open in Browser** and **Copy URL** after exposure.

> **Security:** Tensorlake's `allow_unauthenticated_access` setting applies at
> the sandbox level. If a sandbox already has authenticated exposed ports, the
> extension warns before switching ingress to public access.

Local TCP tunneling is intentionally not required for normal web development.
It can be added separately for non-HTTP software that specifically requires a
localhost TCP endpoint.

## Configuration

Open Settings and search for `Remote Tensorlake`.

```json
{
  "remoteTensorlake.tensorlakeApiKey": ""
}
```

The API key can also be supplied through `TENSORLAKE_API_KEY`.

## Virtual workspace limitations

This extension provides remote files, terminal access, process execution, and
sandbox lifecycle management without a remote VS Code Extension Host.

As a result, extensions that support VS Code virtual workspaces can work with
`tensorlake://` files, but extensions that require a real local filesystem
path or expect their own extension host/binaries to run inside the remote
machine may not work.

The extension does not silently fall back to installing VS Code Server to work
around those incompatibilities.

## Troubleshooting

- Check the **Remote Tensorlake** output channel for connection/API errors.
- Confirm the Tensorlake API key belongs to the project containing the sandbox.
- If a named sandbox is suspended, reconnecting will resume it.
- If a terminal closes unexpectedly, open a new Tensorlake terminal.
- File watching is currently best-effort for changes made through this
  extension; external filesystem changes are discovered when VS Code refreshes
  the relevant directory.

## License

GPL-3.0-only
