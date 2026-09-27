import * as vscode from "vscode";
import { createTensorlakeDirectory } from "../tensorlake/processes";
import {
  DEFAULT_TENSORLAKE_WORKSPACE,
  tensorlakeUri,
} from "./uri";

export async function openTensorlakeWorkspace(
  sandboxId: string,
  newWindow: boolean,
  remotePath = DEFAULT_TENSORLAKE_WORKSPACE,
): Promise<void> {
  // Tensorlake documents /home/tl-user/workspace as the writable,
  // snapshot-persisted development directory. Ensure it exists.
  if (remotePath === DEFAULT_TENSORLAKE_WORKSPACE) {
    await createTensorlakeDirectory(sandboxId, remotePath);
  }

  await vscode.commands.executeCommand(
    "vscode.openFolder",
    tensorlakeUri(sandboxId, remotePath),
    { forceNewWindow: newWindow },
  );
}
