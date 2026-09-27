import * as vscode from "vscode";
import type { SandboxProviderId } from "../models/types";
import {
  hasTensorlakeApiKey,
  listTensorlakeSandboxes,
  type TensorlakeSandbox,
} from "../services/tensorlake";

export type SandboxTreeItem = vscode.TreeItem;

class SandboxSectionItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly provider: SandboxProviderId,
    collapsibleState: vscode.TreeItemCollapsibleState,
    icon: string,
  ) {
    super(label, collapsibleState);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = `${provider}Section`;
  }
}

/** A non-interactive / action leaf shown inside a provider section. */
class ActionItem extends vscode.TreeItem {
  constructor(label: string, commandId: string | undefined, icon: string, args?: unknown[]) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    if (commandId) {
      this.command = { command: commandId, title: label, arguments: args };
    }
  }
}

export class TensorlakeSandboxItem extends vscode.TreeItem {
  constructor(public readonly sandbox: TensorlakeSandbox) {
    super(
      sandbox.name ?? sandbox.sandbox_id,
      vscode.TreeItemCollapsibleState.None,
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

/**
 * Tree data provider for the "Sandboxes" view. The root shows one collapsible
 * section per provider; each section lazily lists the user's sandboxes from
 * the corresponding service.
 */
export class SandboxProvider implements vscode.TreeDataProvider<SandboxTreeItem> {
  private readonly _onDidChangeTreeData: vscode.EventEmitter<SandboxTreeItem | undefined | null | void> =
    new vscode.EventEmitter<SandboxTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<SandboxTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SandboxTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SandboxTreeItem): Promise<SandboxTreeItem[]> {
    if (!element) {
      return [
        new SandboxSectionItem(
          "Tensorlake Sandboxes",
          "tensorlake",
          vscode.TreeItemCollapsibleState.Expanded,
          "cloud",
        ),
      ];
    }

    if (element instanceof SandboxSectionItem) {
      switch (element.provider) {
        case "tensorlake":
          return this.getTensorlakeChildren();
      }
    }

    return [];
  }

  private async getTensorlakeChildren(): Promise<SandboxTreeItem[]> {
    const items: SandboxTreeItem[] = [];
    if (!hasTensorlakeApiKey()) {
      items.push(
        new ActionItem(
          "Set Tensorlake API key...",
          "remote-tensorlake.tensorlakeSetApiKey",
          "key",
        ),
      );
      return items;
    }
    const sandboxes = await listTensorlakeSandboxes(this.outputChannel);
    if (sandboxes.length === 0) {
      items.push(
        new ActionItem("No Tensorlake sandboxes found", undefined, "info"),
      );
    } else {
      items.push(...sandboxes.map((s) => new TensorlakeSandboxItem(s)));
    }
    return items;
  }
}