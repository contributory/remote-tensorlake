import * as vscode from "vscode";
import type { TensorlakeSandbox } from "../services/tensorlake";

const CONNECTIONS_KEY = "remoteTensorlake.connectionWorkspaces";

export interface ConnectedTensorlakeSession {
  sandboxId: string;
  name?: string | null;
  gitAvailable?: boolean;
}

type ConnectionMap = Record<string, ConnectedTensorlakeSession>;

export class TensorlakeConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCurrent(): ConnectedTensorlakeSession | undefined {
    const remoteFolders = (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) => folder.uri.scheme === "tensorlake",
    );
    if (remoteFolders.length > 0) {
      const folder = remoteFolders[0];
      return {
        sandboxId: folder.uri.authority,
        name: folder.name,
      };
    }

    const workspaceFile = vscode.workspace.workspaceFile;
    if (!workspaceFile) {
      return undefined;
    }

    return this.connections()[workspaceFile.toString()];
  }

  isEmptyConnectionWorkspace(): boolean {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (!workspaceFile) {
      return false;
    }
    const hasRemoteFolder = (vscode.workspace.workspaceFolders ?? []).some(
      (folder) => folder.uri.scheme === "tensorlake",
    );
    return !hasRemoteFolder && Boolean(this.connections()[workspaceFile.toString()]);
  }

  async openEmptyConnection(
    sandbox: TensorlakeSandbox,
    newWindow: boolean,
    gitAvailable: boolean,
  ): Promise<void> {
    const directory = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      "connections",
    );
    await vscode.workspace.fs.createDirectory(directory);

    const safeId = sandbox.sandbox_id.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileName = `${safeId}-${Date.now()}.code-workspace`;
    const workspaceFile = vscode.Uri.joinPath(directory, fileName);
    const workspaceContents = JSON.stringify(
      {
        folders: [],
        settings: {},
      },
      null,
      2,
    );
    await vscode.workspace.fs.writeFile(
      workspaceFile,
      Buffer.from(workspaceContents, "utf8"),
    );

    const connections = this.connections();
    connections[workspaceFile.toString()] = {
      sandboxId: sandbox.sandbox_id,
      name: sandbox.name,
      gitAvailable,
    };
    await this.context.globalState.update(CONNECTIONS_KEY, connections);

    await vscode.commands.executeCommand(
      "vscode.openFolder",
      workspaceFile,
      { forceNewWindow: newWindow },
    );
  }

  private connections(): ConnectionMap {
    return {
      ...(this.context.globalState.get<ConnectionMap>(CONNECTIONS_KEY) ?? {}),
    };
  }
}
