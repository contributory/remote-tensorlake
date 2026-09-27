import * as vscode from "vscode";
import {
  listTensorlakeSandboxes,
  setTensorlakeApiKey,
  createTensorlakeSandbox,
  suspendTensorlakeSandbox,
  resumeTensorlakeSandbox,
  deleteTensorlakeSandbox,
  type TensorlakeSandbox,
} from "./services/tensorlake";
import {
  SandboxProvider,
  TensorlakeSandboxItem,
  SandboxTreeItem,
} from "./providers/SandboxProvider";
import { TensorlakeFileSystemProvider } from "./remote/TensorlakeFileSystemProvider";
import { TensorlakeSessionManager } from "./remote/TensorlakeSessionManager";
import { openTensorlakeWorkspace } from "./remote/workspace";
import {
  openTensorlakeTerminal,
  TensorlakePseudoterminal,
} from "./remote/TensorlakePseudoterminal";
import { DEFAULT_TENSORLAKE_WORKSPACE } from "./remote/uri";
import {
  exposeTensorlakePort,
  publicTensorlakePortUrl,
} from "./tensorlake/lifecycle";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Remote Tensorlake");
  outputChannel.appendLine("Remote Tensorlake is now active!");
  const sessionManager = new TensorlakeSessionManager(outputChannel);
  const fileSystemProvider = new TensorlakeFileSystemProvider(
    (sandboxId) => sessionManager.ensureRunning(sandboxId),
  );
  const fileSystemRegistration = vscode.workspace.registerFileSystemProvider(
    "tensorlake",
    fileSystemProvider,
    {
      isCaseSensitive: true,
      isReadonly: false,
    },
  );

  const terminalProfileRegistration =
    vscode.window.registerTerminalProfileProvider(
      "remote-tensorlake.terminal",
      {
        provideTerminalProfile: async () => {
          try {
            const remoteFolders = (vscode.workspace.workspaceFolders ?? []).filter(
              (folder) => folder.uri.scheme === "tensorlake",
            );

            let sandboxId: string;
            let workingDir: string;
            let label: string;

            if (remoteFolders.length === 1) {
              const folder = remoteFolders[0];
              sandboxId = folder.uri.authority;
              workingDir = folder.uri.path || DEFAULT_TENSORLAKE_WORKSPACE;
              label = folder.name;
            } else if (remoteFolders.length > 1) {
              const selected = await vscode.window.showQuickPick(
                remoteFolders.map((folder) => ({
                  label: folder.name,
                  description: folder.uri.authority,
                  folder,
                })),
                { placeHolder: "Select a Tensorlake workspace for the terminal" },
              );
              if (!selected) {
                return undefined;
              }
              sandboxId = selected.folder.uri.authority;
              workingDir =
                selected.folder.uri.path || DEFAULT_TENSORLAKE_WORKSPACE;
              label = selected.folder.name;
            } else {
              const sandbox = await pickTensorlakeSandbox(outputChannel);
              if (!sandbox) {
                return undefined;
              }
              sandboxId = sandbox.sandbox_id;
              workingDir = DEFAULT_TENSORLAKE_WORKSPACE;
              label = sandbox.name ?? sandbox.sandbox_id;
            }

            await sessionManager.ensureRunning(sandboxId, true);
            return new vscode.TerminalProfile({
              name: `Tensorlake: ${label}`,
              pty: new TensorlakePseudoterminal(sandboxId, workingDir),
              iconPath: new vscode.ThemeIcon("cloud"),
              isTransient: true,
            });
          } catch (error) {
            showConnectionError(error, outputChannel);
            return undefined;
          }
        },
      },
    );

  const provider = new SandboxProvider(context, outputChannel);
  const treeView = vscode.window.createTreeView(
    "remote-tensorlake-sandboxes-sidebar",
    {
      treeDataProvider: provider,
    },
  );
  outputChannel.appendLine("View registered: remote-tensorlake-sandboxes-sidebar");

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-tensorlake.tensorlakeSetApiKey",
      async () => {
        await setTensorlakeApiKey();
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.tensorlakeCreateSandbox",
      async () => {
        await createTensorlakeSandbox(outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.tensorlakeSuspendSandbox",
      async (item: TensorlakeSandboxItem) => {
        if (!(item instanceof TensorlakeSandboxItem)) {
          return;
        }
        const suspended = await suspendTensorlakeSandbox(
          item.sandbox.sandbox_id,
          outputChannel,
        );
        if (suspended) {
          sessionManager.markSuspended(item.sandbox.sandbox_id);
        }
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.tensorlakeResumeSandbox",
      async (item: TensorlakeSandboxItem) => {
        if (!(item instanceof TensorlakeSandboxItem)) {
          return;
        }
        const resumed = await resumeTensorlakeSandbox(
          item.sandbox.sandbox_id,
          outputChannel,
        );
        if (resumed) {
          sessionManager.markAvailable(item.sandbox.sandbox_id);
        }
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.tensorlakeDeleteSandbox",
      async (item: TensorlakeSandboxItem) => {
        if (!(item instanceof TensorlakeSandboxItem)) {
          return;
        }
        const deleted = await deleteTensorlakeSandbox(
          item.sandbox.sandbox_id,
          outputChannel,
        );
        if (deleted) {
          sessionManager.remove(item.sandbox.sandbox_id);
        }
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.tensorlakeListSandboxes",
      async () => {
        const sandbox = await pickTensorlakeSandbox(outputChannel);
        if (sandbox) {
          await connectSandbox(sandbox, false);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-tensorlake.refreshSandboxes",
      () => provider.refresh(),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-tensorlake.connectInCurrentWindow",
      (item: SandboxTreeItem | undefined) => connectTreeItem(item, false),
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.connectInNewWindow",
      (item: SandboxTreeItem | undefined) => connectTreeItem(item, true),
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.openTerminal",
      async (item: SandboxTreeItem | undefined) => {
        const sandbox =
          item instanceof TensorlakeSandboxItem
            ? item.sandbox
            : await pickTensorlakeSandbox(outputChannel);
        if (!sandbox) {
          return;
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Connecting to Tensorlake sandbox ${sandbox.name ?? sandbox.sandbox_id}...`,
              cancellable: false,
            },
            () => sessionManager.ensureRunning(sandbox.sandbox_id, true),
          );
          openTensorlakeTerminal(sandbox.sandbox_id);
        } catch (error) {
          showConnectionError(error, outputChannel);
        }
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.exposePublicPort",
      async (item: SandboxTreeItem | undefined) => {
        const sandbox =
          item instanceof TensorlakeSandboxItem
            ? item.sandbox
            : await pickTensorlakeSandbox(outputChannel);
        if (!sandbox) {
          return;
        }

        const portInput = await vscode.window.showInputBox({
          prompt: "Port to expose publicly through Tensorlake ingress",
          placeHolder: "3000",
          ignoreFocusOut: true,
          validateInput: (value) => {
            const port = Number(value);
            return Number.isInteger(port) && port >= 1 && port <= 65535
              ? null
              : "Enter a port between 1 and 65535";
          },
        });
        if (portInput === undefined) {
          return;
        }
        const port = Number(portInput);

        try {
          const current = await sessionManager.ensureRunning(
            sandbox.sandbox_id,
            true,
          );
          const existingPorts = current.exposed_ports ?? [];
          if (
            !current.allow_unauthenticated_access &&
            existingPorts.length > 0
          ) {
            const confirmed = await vscode.window.showWarningMessage(
              `Making this port public also makes the sandbox's existing exposed ports unauthenticated: ${existingPorts.join(", ")}.`,
              { modal: true },
              "Expose Publicly",
            );
            if (confirmed !== "Expose Publicly") {
              return;
            }
          }

          const updated = await exposeTensorlakePort(
            sandbox.sandbox_id,
            port,
          );
          sessionManager.invalidate(sandbox.sandbox_id);
          const publicUrl = publicTensorlakePortUrl(updated, port);
          const action = await vscode.window.showInformationMessage(
            `Tensorlake port ${port} is public at ${publicUrl}`,
            "Open in Browser",
            "Copy URL",
          );
          if (action === "Open in Browser") {
            await vscode.env.openExternal(vscode.Uri.parse(publicUrl));
          } else if (action === "Copy URL") {
            await vscode.env.clipboard.writeText(publicUrl);
          }
          provider.refresh();
        } catch (error) {
          showConnectionError(error, outputChannel);
        }
      },
    ),
  );

  async function connectTreeItem(
    item: SandboxTreeItem | undefined,
    newWindow: boolean,
  ): Promise<void> {
    const sandbox =
      item instanceof TensorlakeSandboxItem
        ? item.sandbox
        : await pickTensorlakeSandbox(outputChannel);
    if (!sandbox) {
      return;
    }
    await connectSandbox(sandbox, newWindow);
  }

  async function connectSandbox(
    sandbox: TensorlakeSandbox,
    newWindow: boolean,
  ): Promise<void> {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Opening Tensorlake sandbox ${sandbox.name ?? sandbox.sandbox_id}...`,
          cancellable: false,
        },
        async () => {
          await sessionManager.ensureRunning(sandbox.sandbox_id, true);
          await openTensorlakeWorkspace(sandbox.sandbox_id, newWindow);
        },
      );
    } catch (error) {
      showConnectionError(error, outputChannel);
    }
  }

  context.subscriptions.push(
    fileSystemRegistration,
    terminalProfileRegistration,
    fileSystemProvider,
    sessionManager,
    outputChannel,
    treeView,
  );
}

async function pickTensorlakeSandbox(
  outputChannel: vscode.OutputChannel,
): Promise<TensorlakeSandbox | undefined> {
  const sandboxes = await listTensorlakeSandboxes(outputChannel);
  if (sandboxes.length === 0) {
    vscode.window.showInformationMessage("No Tensorlake sandboxes found.");
    return undefined;
  }

  const pick = await vscode.window.showQuickPick(
    sandboxes.map((sandbox) => ({
      label: sandbox.name ?? sandbox.sandbox_id,
      description: sandbox.status,
      detail: sandbox.name ? sandbox.sandbox_id : undefined,
      sandbox,
    })),
    {
      placeHolder: "Select a Tensorlake sandbox",
      matchOnDescription: true,
    },
  );
  return pick?.sandbox;
}

function showConnectionError(
  error: unknown,
  outputChannel: vscode.OutputChannel,
): void {
  const message = error instanceof Error ? error.message : String(error);
  outputChannel.appendLine(`[Tensorlake] Remote connection error: ${message}`);
  vscode.window.showErrorMessage(`Tensorlake connection error: ${message}`);
}

export function deactivate(): void {
  // Resources are disposed through context.subscriptions.
}