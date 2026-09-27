# Remote Tensorlake

Remote Tensorlake manages **Tensorlake** sandboxed environments and helps you connect to them over SSH from VS Code.

The extension provides a **Sandboxes** view in the Activity Bar (like Remote Extended) that lists your Tensorlake sandboxes. Connecting to a sandbox **starts/resumes it, writes the matching `~/.ssh/*.conf` file if needed, and opens Remote-SSH** — no manual "get SSH info" step required.

## Requirements

- VS Code 1.80.0 or later
- Remote - SSH extension
- Node.js 18 or later for development
- API keys for the providers you use (see Configuration)

## Installation

### Run from source

```bash
npm install
npm run compile
```

Open the project in VS Code and press `F5` to launch an Extension Development Host.

### Package a VSIX

```bash
npm install -g @vscode/vsce
vsce package
```

Install the generated VSIX from the Extensions view.

## Usage

Open the **Remote Tensorlake** view in the Activity Bar. The tree shows your Tensorlake sandboxes:

- **Tensorlake Sandboxes** — supports create, suspend/resume for named sandboxes, terminate, and Remote-SSH connect. Before connecting, the extension discovers local SSH keys from `~/.ssh` and `ssh-agent`, registers any missing public keys with Tensorlake, and writes the SSH config.

Each item has a context menu to **Connect in Current Window** or **Connect in New Window**. Next to the connect buttons, each sandbox shows a lifecycle toggle:

- **Tensorlake**: **Suspend** for named running sandboxes, **Resume** when suspended.

The view title bar has a shortcut for:

- Refresh

All commands are also available from the Command Palette.

## SSH configuration

The extension manages its own SSH config file under `~/.ssh` and only writes it when needed:

- **Tensorlake** (`~/.ssh/tensorlake.conf`) — uses the sandbox-specific hostname returned by Tensorlake and the same default identity path as the Tensorlake CLI: `~/.ssh/id_ed25519_tensorlake`. Remote Tensorlake only writes the SSH config; it does not create or register SSH keys.

The config is (re)written automatically as part of **Connect in Current Window**, **Connect in New Window**, **Resume** and **Start** actions — whenever a check shows the stored config is outdated. The standalone "Get SSH Info" / "Save SSH Config" commands were removed.

The extension writes its own `.conf` file and prints the `Include` line to the output channel; make sure that line is present in `~/.ssh/config`.

## Configuration

Open Settings and search for `Remote Tensorlake`.

```json
{
  "remoteTensorlake.tensorlakeApiKey": ""
}
```

- `remoteTensorlake.tensorlakeApiKey`: Your Tensorlake project API key for sandbox lifecycle operations. You can also set it with the **Tensorlake: Set API Key** command or `TENSORLAKE_API_KEY`.

## Troubleshooting

- Check the Remote Tensorlake output channel for operation details and errors.
- Verify the generated configuration file is included by `~/.ssh/config` (the extension writes its own `.conf` file and prints the `Include` line to the output channel).
- Confirm the required API key is available.

## License

GPL-3.0-only