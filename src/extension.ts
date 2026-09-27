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
  TensorlakeRecentFolderItem,
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
import { DEFAULT_TENSORLAKE_WORKSPACE, TENSORLAKE_HOME, parseTensorlakeUri } from "./remote/uri";
import { TensorlakeConnectionStore } from "./remote/connection";
import { TensorlakePortsProvider, type TensorlakePortItem } from "./remote/TensorlakePortsProvider";
import { pickTensorlakeFolder } from "./remote/folderPicker";
import {
  cloneTensorlakeGitRepository,
  tensorlakeHasGit,
} from "./remote/git";
import { createTensorlakeDirectory } from "./tensorlake/processes";
import {
  exposeTensorlakePort,
  publicTensorlakePortUrl,
  removeTensorlakePort,
} from "./tensorlake/lifecycle";

interface SandboxTarget {
  sandboxId: string;
  label: string;
  workingDir: string;
}

interface PendingLocalTensorlakeConnect {
  sandboxId: string;
  sandboxName?: string | null;
  remotePath: string;
  createdAt: number;
}

const PENDING_LOCAL_CONNECT_KEY = "tensorlake.pendingLocalConnect";
const PENDING_LOCAL_CONNECT_MAX_AGE_MS = 30_000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("Remote Tensorlake", { log: true });
  outputChannel.info("Extension activated");
  outputChannel.info(`Workspace folders: ${(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()).join(", ") || "none"}`);

  const sessionManager = new TensorlakeSessionManager(outputChannel);
  const connectionStore = new TensorlakeConnectionStore();
  const portsProvider = new TensorlakePortsProvider(connectionStore, outputChannel);
  const fileSystemProvider = new TensorlakeFileSystemProvider(
    (sandboxId) => sessionManager.ensureRunning(sandboxId),
    outputChannel,
  );
  const fileSystemRegistration = vscode.workspace.registerFileSystemProvider(
    "tensorlake",
    fileSystemProvider,
    {
      isCaseSensitive: true,
      isReadonly: false,
    },
  );

  const refreshConnectionContext = async (): Promise<void> => {
    const connected = connectionStore.resolveCurrent();
    await vscode.commands.executeCommand(
      "setContext",
      "remoteTensorlake.connected",
      Boolean(connected),
    );

    if (connected) {
      outputChannel.info(
        `Connected workspace detected: name=${connected.name} sandbox=${connected.sandboxId} path=${connected.remotePath}`,
      );
      await ensureTensorlakeTerminalDefault();
    } else {
      outputChannel.info("No Tensorlake workspace detected");
    }
  };

  const ensureTensorlakeTerminalDefault = async (): Promise<void> => {
    const folder = (vscode.workspace.workspaceFolders ?? []).find(
      (candidate) => candidate.uri.scheme === "tensorlake",
    );
    if (!folder) {
      return;
    }

    // VS Code resolves the default terminal profile at workspace scope when
    // the New Terminal command / + button is used. A WorkspaceFolder-scoped
    // value on a virtual filesystem is not consulted by that resolver.
    const config = vscode.workspace.getConfiguration("terminal.integrated");
    const platform =
      process.platform === "win32"
        ? "windows"
        : process.platform === "darwin"
          ? "osx"
          : "linux";
    const key = `defaultProfile.${platform}`;
    const inspected = config.inspect<string>(key);
    outputChannel.info(
      `Terminal default check: key=${key} workspaceValue=${String(inspected?.workspaceValue)} resolved=${String(config.get<string>(key))}`,
    );
    if (inspected?.workspaceValue !== "Tensorlake") {
      outputChannel.info(`Setting ${key}=Tensorlake at workspace scope`);
      await config.update(
        key,
        "Tensorlake",
        vscode.ConfigurationTarget.Workspace,
      );
    }

    const resolved = vscode.workspace
      .getConfiguration("terminal.integrated")
      .get<string>(key);
    outputChannel.info(`Terminal default resolved to ${String(resolved)}`);
    if (resolved !== "Tensorlake") {
      throw new Error(
        `VS Code did not accept Tensorlake as the workspace default terminal profile (${key}).`,
      );
    }
  };

  await refreshConnectionContext();

  const terminalProfileRegistration =
    vscode.window.registerTerminalProfileProvider(
      "remote-tensorlake.terminal",
      {
        provideTerminalProfile: async () => {
          outputChannel.info("Terminal profile requested by VS Code");
          try {
            const remoteFolders = (vscode.workspace.workspaceFolders ?? []).filter(
              (folder) => folder.uri.scheme === "tensorlake",
            );

            let sandboxId: string;
            let workingDir: string;
            let label: string;

            if (remoteFolders.length === 1) {
              const folder = remoteFolders[0];
              const parsed = parseTensorlakeUri(folder.uri);
              sandboxId = parsed.sandboxId;
              workingDir = parsed.remotePath;
              label = folder.uri.authority || folder.name;
            } else if (remoteFolders.length > 1) {
              const selected = await vscode.window.showQuickPick(
                remoteFolders.map((folder) => ({
                  label: folder.name,
                  description: parseTensorlakeUri(folder.uri).sandboxId,
                  folder,
                })),
                { placeHolder: "Select a Tensorlake workspace for the terminal" },
              );
              if (!selected) {
                return undefined;
              }
              const parsed = parseTensorlakeUri(selected.folder.uri);
              sandboxId = parsed.sandboxId;
              workingDir = parsed.remotePath;
              label = selected.folder.uri.authority || selected.folder.name;
            } else {
              const connected = connectionStore.resolveCurrent();
              if (connected) {
                sandboxId = connected.sandboxId;
                workingDir = connected.remotePath;
                label = connected.name;
              } else {
                const sandbox = await pickTensorlakeSandbox(outputChannel);
                if (!sandbox) {
                  return undefined;
                }
                sandboxId = sandbox.sandbox_id;
                workingDir = DEFAULT_TENSORLAKE_WORKSPACE;
                label = sandbox.name ?? sandbox.sandbox_id;
              }
            }

            outputChannel.info(
              `Resolving Tensorlake terminal: sandbox=${sandboxId} label=${label} cwd=${workingDir}`,
            );
            await sessionManager.ensureRunning(sandboxId, true);
            outputChannel.info(`Tensorlake terminal profile ready: sandbox=${sandboxId} cwd=${workingDir}`);
            return new vscode.TerminalProfile({
              name: `Tensorlake: ${label}`,
              pty: new TensorlakePseudoterminal(
                sandboxId,
                workingDir,
                outputChannel,
              ),
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
  const portsView = vscode.window.createTreeView(
    "remote-tensorlake-ports",
    {
      treeDataProvider: portsProvider,
    },
  );

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
          portsProvider.refresh();
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
          portsProvider.refresh();
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
          await provider.clearRecentFolders(item.sandbox.sandbox_id);
          portsProvider.refresh();
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
    vscode.commands.registerCommand(
      "remote-tensorlake.refreshSandboxes",
      () => provider.refresh(),
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.showLogs",
      () => outputChannel.show(false),
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.refreshPorts",
      () => portsProvider.refresh(),
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.openPort",
      async (item: TensorlakePortItem | undefined) => {
        if (!item?.url) {
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(item.url));
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.copyPortUrl",
      async (item: TensorlakePortItem | undefined) => {
        if (!item?.url) {
          return;
        }
        await vscode.env.clipboard.writeText(item.url);
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.removePort",
      async (item: TensorlakePortItem | undefined) => {
        if (!item) {
          return;
        }
        const connected = connectionStore.resolveCurrent();
        if (!connected) {
          return;
        }

        try {
          outputChannel.info(
            `Remove port requested: sandbox=${connected.sandboxId} port=${item.port}`,
          );
          await removeTensorlakePort(connected.sandboxId, item.port);
          sessionManager.invalidate(connected.sandboxId);
          outputChannel.info(
            `Port removed: sandbox=${connected.sandboxId} port=${item.port}`,
          );
          portsProvider.refresh();
        } catch (error) {
          showConnectionError(error, outputChannel);
        }
      },
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
      "remote-tensorlake.connectRecentFolderInCurrentWindow",
      (item: TensorlakeRecentFolderItem | undefined) =>
        connectRecentFolder(item, false),
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.connectRecentFolderInNewWindow",
      (item: TensorlakeRecentFolderItem | undefined) =>
        connectRecentFolder(item, true),
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.removeRecentFolder",
      async (item: TensorlakeRecentFolderItem | undefined) => {
        if (!(item instanceof TensorlakeRecentFolderItem)) {
          return;
        }
        await provider.removeRecentFolder(item);
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.openConnectedFolder",
      async () => {
        const connected = connectionStore.resolveCurrent();
        if (!connected) {
          vscode.window.showErrorMessage(
            "Connect to a Tensorlake sandbox before opening a remote folder.",
          );
          return;
        }

        try {
          await sessionManager.ensureRunning(connected.sandboxId, true);
          const remotePath = await pickTensorlakeFolder(connected.sandboxId);
          if (!remotePath) {
            return;
          }
          await provider.rememberRecentFolder(
            connected.sandboxId,
            connected.name,
            remotePath,
          );
          await openTensorlakeWorkspace(
            connected.sandboxId,
            false,
            remotePath,
            connected.name,
          );
        } catch (error) {
          showConnectionError(error, outputChannel);
        }
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.cloneGitRepository",
      async () => {
        const connected = connectionStore.resolveCurrent();
        if (!connected) {
          vscode.window.showErrorMessage(
            "Connect to a Tensorlake sandbox before cloning a repository.",
          );
          return;
        }

        try {
          await sessionManager.ensureRunning(connected.sandboxId, true);
          const hasGit = await tensorlakeHasGit(connected.sandboxId);
          await vscode.commands.executeCommand(
            "setContext",
            "remoteTensorlake.gitAvailable",
            hasGit,
          );
          if (!hasGit) {
            vscode.window.showErrorMessage(
              "Git is not installed in this Tensorlake sandbox.",
            );
            return;
          }

          const repositoryUrl = await vscode.window.showInputBox({
            title: "Clone Git Repository",
            prompt: "GitHub repository URL",
            placeHolder: "https://github.com/owner/repository.git",
            ignoreFocusOut: true,
            validateInput: (value) => {
              const trimmed = value.trim();
              if (!trimmed) {
                return "Enter a repository URL.";
              }
              if (trimmed.startsWith("-")) {
                return "Repository URL cannot start with '-'.";
              }
              return null;
            },
          });
          if (!repositoryUrl) {
            return;
          }

          await createTensorlakeDirectory(
            connected.sandboxId,
            DEFAULT_TENSORLAKE_WORKSPACE,
          );
          const parentPath = await pickTensorlakeFolder(connected.sandboxId);
          if (!parentPath) {
            return;
          }

          const clonedPath = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Cloning repository in Tensorlake...",
              cancellable: false,
            },
            () =>
              cloneTensorlakeGitRepository(
                connected.sandboxId,
                repositoryUrl.trim(),
                parentPath,
              ),
          );

          await provider.rememberRecentFolder(
            connected.sandboxId,
            connected.name,
            clonedPath,
          );
          await openTensorlakeWorkspace(
            connected.sandboxId,
            false,
            clonedPath,
            connected.name,
          );
        } catch (error) {
          showConnectionError(error, outputChannel);
        }
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.openTerminalAtPath",
      async (resource: vscode.Uri | undefined) => {
        if (!resource || resource.scheme !== "tensorlake") {
          return;
        }

        try {
          const parsed = parseTensorlakeUri(resource);
          await sessionManager.ensureRunning(parsed.sandboxId, true);
          outputChannel.info(
            `Opening Tensorlake terminal from Explorer: sandbox=${parsed.sandboxId} cwd=${parsed.remotePath}`,
          );
          openTensorlakeTerminal(
            parsed.sandboxId,
            parsed.remotePath,
            outputChannel,
          );
        } catch (error) {
          showConnectionError(error, outputChannel);
        }
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.openTerminal",
      async (item: SandboxTreeItem | undefined) => {
        const target = await resolveSandboxTarget(
          item,
          connectionStore,
          outputChannel,
        );
        if (!target) {
          return;
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Connecting to Tensorlake sandbox ${target.label}...`,
              cancellable: false,
            },
            () => sessionManager.ensureRunning(target.sandboxId, true),
          );
          outputChannel.info(
            `Opening Tensorlake terminal: sandbox=${target.sandboxId} cwd=${target.workingDir}`,
          );
          openTensorlakeTerminal(
            target.sandboxId,
            target.workingDir,
            outputChannel,
          );
        } catch (error) {
          showConnectionError(error, outputChannel);
        }
      },
    ),
    vscode.commands.registerCommand(
      "remote-tensorlake.exposePublicPort",
      async (item: SandboxTreeItem | undefined) => {
        const target = await resolveSandboxTarget(
          item,
          connectionStore,
          outputChannel,
        );
        if (!target) {
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
        outputChannel.info(
          `Expose port requested: sandbox=${target.sandboxId} port=${port}`,
        );

        try {
          const current = await sessionManager.ensureRunning(
            target.sandboxId,
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
            target.sandboxId,
            port,
          );
          sessionManager.invalidate(target.sandboxId);
          const publicUrl = publicTensorlakePortUrl(updated, port);
          outputChannel.info(
            `Port exposed: sandbox=${target.sandboxId} port=${port} url=${publicUrl}`,
          );
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
          portsProvider.refresh();
        } catch (error) {
          showConnectionError(error, outputChannel);
        }
      },
    ),
  );

  async function openTensorlakeTarget(
    sandboxId: string,
    sandboxName: string | null | undefined,
    remotePath: string,
    newWindow: boolean,
  ): Promise<void> {
    if (newWindow && vscode.env.remoteName) {
      const pending: PendingLocalTensorlakeConnect = {
        sandboxId,
        sandboxName,
        remotePath,
        createdAt: Date.now(),
      };

      outputChannel.info(
        "Connect in New Window requested from remote host " +
          vscode.env.remoteName +
          "; opening a local VS Code window first.",
      );
      await context.globalState.update(PENDING_LOCAL_CONNECT_KEY, pending);

      try {
        await vscode.commands.executeCommand("workbench.action.newWindow");
      } catch (error) {
        await context.globalState.update(PENDING_LOCAL_CONNECT_KEY, undefined);
        throw error;
      }
      return;
    }

    await openTensorlakeWorkspace(
      sandboxId,
      newWindow,
      remotePath,
      sandboxName,
    );
  }

  async function connectRecentFolder(
    item: TensorlakeRecentFolderItem | undefined,
    newWindow: boolean,
  ): Promise<void> {
    if (!(item instanceof TensorlakeRecentFolderItem)) {
      return;
    }
    const recent = item.recent;
    try {
      outputChannel.info(
        "Recent folder connect requested: sandbox=" + recent.sandboxId +
          " path=" + recent.remotePath + " newWindow=" + newWindow,
      );
      await sessionManager.ensureRunning(recent.sandboxId, true);
      await provider.rememberRecentFolder(
        recent.sandboxId,
        recent.sandboxName,
        recent.remotePath,
      );
      await openTensorlakeTarget(
        recent.sandboxId,
        recent.sandboxName,
        recent.remotePath,
        newWindow,
      );
    } catch (error) {
      showConnectionError(error, outputChannel);
    }
  }

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
      outputChannel.info(
        `Connect requested: sandbox=${sandbox.sandbox_id} name=${sandbox.name ?? ""} newWindow=${newWindow}`,
      );
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Connecting to Tensorlake sandbox ${sandbox.name ?? sandbox.sandbox_id}...`,
          cancellable: false,
        },
        async () => {
          await sessionManager.ensureRunning(sandbox.sandbox_id, true);
          outputChannel.info(
            `Opening Tensorlake virtual workspace: sandbox=${sandbox.sandbox_id} name=${sandbox.name ?? ""} path=${TENSORLAKE_HOME}`,
          );
          await openTensorlakeTarget(
            sandbox.sandbox_id,
            sandbox.name,
            TENSORLAKE_HOME,
            newWindow,
          );
        },
      );
    } catch (error) {
      showConnectionError(error, outputChannel);
    }
  }

  if (!vscode.env.remoteName) {
    const pending = context.globalState.get<PendingLocalTensorlakeConnect>(
      PENDING_LOCAL_CONNECT_KEY,
    );
    if (pending) {
      const age = Date.now() - pending.createdAt;
      await context.globalState.update(PENDING_LOCAL_CONNECT_KEY, undefined);

      if (
        age >= 0 &&
        age <= PENDING_LOCAL_CONNECT_MAX_AGE_MS &&
        pending.sandboxId &&
        pending.remotePath
      ) {
        outputChannel.info(
          "Consuming pending local Tensorlake connect: sandbox=" +
            pending.sandboxId +
            " path=" +
            pending.remotePath,
        );
        try {
          await sessionManager.ensureRunning(pending.sandboxId, true);
          await openTensorlakeWorkspace(
            pending.sandboxId,
            false,
            pending.remotePath,
            pending.sandboxName,
          );
        } catch (error) {
          showConnectionError(error, outputChannel);
        }
      } else {
        outputChannel.warn(
          "Discarded stale pending local Tensorlake connect: ageMs=" + age,
        );
      }
    }
  }

  context.subscriptions.push(
    fileSystemRegistration,
    terminalProfileRegistration,
    fileSystemProvider,
    sessionManager,
    provider,
    portsProvider,
    portsView,
    outputChannel,
    treeView,
  );
}

async function resolveSandboxTarget(
  item: SandboxTreeItem | undefined,
  connectionStore: TensorlakeConnectionStore,
  outputChannel: vscode.OutputChannel,
): Promise<SandboxTarget | undefined> {
  if (item instanceof TensorlakeSandboxItem) {
    return {
      sandboxId: item.sandbox.sandbox_id,
      label: item.sandbox.name ?? item.sandbox.sandbox_id,
      workingDir: TENSORLAKE_HOME,
    };
  }

  const connected = connectionStore.resolveCurrent();
  if (connected) {
    return {
      sandboxId: connected.sandboxId,
      label: connected.name,
      workingDir: connected.remotePath,
    };
  }

  const sandbox = await pickTensorlakeSandbox(outputChannel);
  if (!sandbox) {
    return undefined;
  }
  return {
    sandboxId: sandbox.sandbox_id,
    label: sandbox.name ?? sandbox.sandbox_id,
    workingDir: TENSORLAKE_HOME,
  };
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
  if ("error" in outputChannel && typeof outputChannel.error === "function") {
    (outputChannel as vscode.LogOutputChannel).error(message);
  } else {
    outputChannel.appendLine(`[Tensorlake] ${message}`);
  }
  vscode.window.showErrorMessage(`Tensorlake connection error: ${message}`);
}

export function deactivate(): void {
  // Resources are disposed through context.subscriptions.
}