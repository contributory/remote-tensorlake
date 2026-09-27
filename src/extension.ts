import * as vscode from "vscode";
import {
  connectTensorlakeSandbox,
  listTensorlakeSandboxes,
  setTensorlakeApiKey,
  createTensorlakeSandbox,
  suspendTensorlakeSandbox,
  resumeTensorlakeSandbox,
  deleteTensorlakeSandbox,
} from "./services/tensorlake";
import {
  SandboxProvider,
  TensorlakeSandboxItem,
  SandboxTreeItem,
} from "./providers/SandboxProvider";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Remote Tensorlake");
  outputChannel.appendLine("Remote Tensorlake is now active!");

  // Initialize Tree View
  const provider = new SandboxProvider(context, outputChannel);
  const treeView = vscode.window.createTreeView(
    "remote-tensorlake-sandboxes-sidebar",
    {
      treeDataProvider: provider,
    },
  );
  outputChannel.appendLine("View registered: remote-tensorlake-sandboxes-sidebar");

  // Tensorlake service
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-tensorlake.tensorlakeSetApiKey",
      () => setTensorlakeApiKey(),
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
        await suspendTensorlakeSandbox(item.sandbox.sandbox_id, outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.tensorlakeResumeSandbox",
      async (item: TensorlakeSandboxItem) => {
        if (!(item instanceof TensorlakeSandboxItem)) {
          return;
        }
        await resumeTensorlakeSandbox(item.sandbox.sandbox_id, outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.tensorlakeDeleteSandbox",
      async (item: TensorlakeSandboxItem) => {
        if (!(item instanceof TensorlakeSandboxItem)) {
          return;
        }
        await deleteTensorlakeSandbox(item.sandbox.sandbox_id, outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.tensorlakeListSandboxes",
      async () => {
        const sandboxes = await listTensorlakeSandboxes(outputChannel);
        if (sandboxes.length === 0) {
          vscode.window.showInformationMessage("No Tensorlake sandboxes found.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          sandboxes.map((sandbox) => ({
            label: sandbox.name ?? sandbox.sandbox_id,
            description: sandbox.status,
            detail: sandbox.name ? sandbox.sandbox_id : undefined,
            sandbox,
          })),
          {
            placeHolder: "Select a Tensorlake sandbox to connect to",
            matchOnDescription: true,
          },
        );
        if (!pick) {
          return;
        }
        const hostAlias = await connectTensorlakeSandbox(
          pick.sandbox,
          outputChannel,
        );
        if (hostAlias) {
          openRemoteWindow(hostAlias, false, outputChannel);
        }
      },
    ),
  );

  // Refresh
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-tensorlake.refreshSandboxes",
      () => provider.refresh(),
    ),
  );

  // Connect actions (invoked from tree item context menus)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-tensorlake.connectInCurrentWindow",
      (item: SandboxTreeItem) => connectToSandbox(item, false),
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.connectInNewWindow",
      (item: SandboxTreeItem) => connectToSandbox(item, true),
    ),
  );

  async function connectToSandbox(
    item: SandboxTreeItem | undefined,
    newWindow: boolean,
  ): Promise<void> {
    if (!item) {
      return;
    }

    let hostAlias: string | undefined;
    if (item instanceof TensorlakeSandboxItem) {
      hostAlias = await connectTensorlakeSandbox(item.sandbox, outputChannel);
    }

    if (hostAlias) {
      openRemoteWindow(hostAlias, newWindow, outputChannel);
    }
  }

  context.subscriptions.push(outputChannel, treeView);
}

function openRemoteWindow(
  hostAlias: string,
  newWindow: boolean,
  outputChannel: vscode.OutputChannel,
): void {
  const commandId = newWindow
    ? "opensshremotes.openEmptyWindow"
    : "opensshremotes.openEmptyWindowInCurrentWindow";
  vscode.commands.executeCommand(commandId, { host: hostAlias }).then(
    () => {
      outputChannel.appendLine(
        `[Remote-SSH] Opened ${hostAlias} in ${newWindow ? "new" : "current"} window.`,
      );
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[Remote-SSH] Failed to open ${hostAlias}: ${message}`);
      vscode.window.showErrorMessage(
        `Could not open ${hostAlias} via Remote-SSH. Please connect manually.`,
      );
    },
  );
}

export function deactivate(): void {
  // nothing to clean up
}