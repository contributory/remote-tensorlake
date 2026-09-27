import * as path from "node:path";
import * as vscode from "vscode";
import {
  hasTensorlakeApiKey,
  listTensorlakeSandboxes,
  type TensorlakeSandbox,
} from "../services/tensorlake";

export type SandboxTreeItem = vscode.TreeItem;

const RECENT_FOLDERS_KEY = "tensorlake.recentFolders";
const MAX_RECENT_FOLDERS_PER_SANDBOX = 12;

export interface TensorlakeRecentFolder {
  sandboxId: string;
  sandboxName?: string | null;
  remotePath: string;
  lastUsedAt: number;
}

class ActionItem extends vscode.TreeItem {
  constructor(
    label: string,
    commandId: string | undefined,
    icon: string,
    args?: unknown[],
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    if (commandId) {
      this.command = { command: commandId, title: label, arguments: args };
    }
  }
}

export class TensorlakeSandboxItem extends vscode.TreeItem {
  constructor(
    public readonly sandbox: TensorlakeSandbox,
    hasRecentFolders: boolean,
  ) {
    super(
      sandbox.name ?? sandbox.sandbox_id,
      hasRecentFolders
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    const status = sandbox.status.toLowerCase();
    this.description = sandbox.name
      ? `${sandbox.status} · ${sandbox.sandbox_id}`
      : sandbox.status;
    this.iconPath = new vscode.ThemeIcon(
      status === "running" ? "vm-running" : "vm-outline",
    );

    if (status === "running") {
      this.contextValue = sandbox.name
        ? "tensorlakeSandboxRunning"
        : "tensorlakeSandboxRunningEphemeral";
    } else if (status === "suspended") {
      this.contextValue = "tensorlakeSandboxSuspended";
    } else {
      this.contextValue = "tensorlakeSandboxBusy";
    }

    this.tooltip = sandbox.name
      ? `Tensorlake sandbox: ${sandbox.name} (${sandbox.sandbox_id})`
      : `Tensorlake sandbox: ${sandbox.sandbox_id}`;
  }
}

export class TensorlakeRecentFolderItem extends vscode.TreeItem {
  constructor(public readonly recent: TensorlakeRecentFolder) {
    const normalized = path.posix.normalize(recent.remotePath);
    const label =
      normalized === "/"
        ? "/"
        : path.posix.basename(normalized) || normalized;

    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = normalized;
    this.iconPath = new vscode.ThemeIcon("folder");
    this.contextValue = "tensorlakeRecentFolder";
    this.tooltip = new vscode.MarkdownString(
      [
        `**${recent.sandboxName ?? recent.sandboxId}**`,
        "",
        `\`${normalized}\``,
      ].join("\n"),
    );
  }
}

export class SandboxProvider
  implements vscode.TreeDataProvider<SandboxTreeItem>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    SandboxTreeItem | undefined | null | void
  >();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  refresh(item?: SandboxTreeItem): void {
    this.changeEmitter.fire(item);
  }

  getTreeItem(element: SandboxTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SandboxTreeItem): Promise<SandboxTreeItem[]> {
    if (element instanceof TensorlakeSandboxItem) {
      return this.getRecentFolders(element.sandbox.sandbox_id).map(
        (recent) => new TensorlakeRecentFolderItem(recent),
      );
    }

    if (element) {
      return [];
    }

    if (!hasTensorlakeApiKey()) {
      return [
        new ActionItem(
          "Set Tensorlake API key...",
          "remote-tensorlake.tensorlakeSetApiKey",
          "key",
        ),
      ];
    }

    const sandboxes = await listTensorlakeSandboxes(this.outputChannel);
    if (sandboxes.length === 0) {
      return [
        new ActionItem("No Tensorlake sandboxes found", undefined, "info"),
      ];
    }

    return sandboxes.map(
      (sandbox) =>
        new TensorlakeSandboxItem(
          sandbox,
          this.getRecentFolders(sandbox.sandbox_id).length > 0,
        ),
    );
  }

  async rememberRecentFolder(
    sandboxId: string,
    sandboxName: string | null | undefined,
    remotePath: string,
  ): Promise<void> {
    const normalized = path.posix.normalize(
      remotePath.startsWith("/") ? remotePath : `/${remotePath}`,
    );
    const all = this.readAllRecentFolders().filter(
      (item) =>
        !(
          item.sandboxId === sandboxId &&
          path.posix.normalize(item.remotePath) === normalized
        ),
    );

    all.unshift({
      sandboxId,
      sandboxName,
      remotePath: normalized,
      lastUsedAt: Date.now(),
    });

    const kept: TensorlakeRecentFolder[] = [];
    const counts = new Map<string, number>();
    for (const item of all) {
      const count = counts.get(item.sandboxId) ?? 0;
      if (count >= MAX_RECENT_FOLDERS_PER_SANDBOX) {
        continue;
      }
      counts.set(item.sandboxId, count + 1);
      kept.push(item);
    }

    await this.context.globalState.update(RECENT_FOLDERS_KEY, kept);
    this.outputChannel.appendLine(
      `[Tensorlake] Recent folder saved: sandbox=${sandboxId} path=${normalized}`,
    );
    this.refresh();
  }

  async removeRecentFolder(item: TensorlakeRecentFolderItem): Promise<void> {
    const recent = item.recent;
    const normalized = path.posix.normalize(recent.remotePath);
    const next = this.readAllRecentFolders().filter(
      (entry) =>
        !(
          entry.sandboxId === recent.sandboxId &&
          path.posix.normalize(entry.remotePath) === normalized
        ),
    );
    await this.context.globalState.update(RECENT_FOLDERS_KEY, next);
    this.outputChannel.appendLine(
      `[Tensorlake] Recent folder removed: sandbox=${recent.sandboxId} path=${normalized}`,
    );
    this.refresh();
  }

  async clearRecentFolders(sandboxId: string): Promise<void> {
    const next = this.readAllRecentFolders().filter(
      (item) => item.sandboxId !== sandboxId,
    );
    await this.context.globalState.update(RECENT_FOLDERS_KEY, next);
    this.refresh();
  }

  private getRecentFolders(sandboxId: string): TensorlakeRecentFolder[] {
    return this.readAllRecentFolders()
      .filter((item) => item.sandboxId === sandboxId)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  private readAllRecentFolders(): TensorlakeRecentFolder[] {
    const stored = this.context.globalState.get<unknown>(RECENT_FOLDERS_KEY);
    if (!Array.isArray(stored)) {
      return [];
    }

    return stored.filter(
      (item): item is TensorlakeRecentFolder =>
        Boolean(
          item &&
            typeof item === "object" &&
            typeof (item as TensorlakeRecentFolder).sandboxId === "string" &&
            typeof (item as TensorlakeRecentFolder).remotePath === "string" &&
            typeof (item as TensorlakeRecentFolder).lastUsedAt === "number",
        ),
    );
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
