import * as path from "path";
import * as vscode from "vscode";

export const TENSORLAKE_SCHEME = "tensorlake";
export const DEFAULT_TENSORLAKE_WORKSPACE = "/home/tl-user/workspace";

export function tensorlakeUri(
  sandboxId: string,
  remotePath = DEFAULT_TENSORLAKE_WORKSPACE,
): vscode.Uri {
  if (!sandboxId.trim()) {
    throw new Error("Tensorlake sandbox id is required.");
  }

  const normalized = path.posix.normalize(
    remotePath.startsWith("/") ? remotePath : `/${remotePath}`,
  );

  return vscode.Uri.from({
    scheme: TENSORLAKE_SCHEME,
    authority: sandboxId,
    path: normalized === "." ? "/" : normalized,
  });
}

export function parseTensorlakeUri(uri: vscode.Uri): {
  sandboxId: string;
  remotePath: string;
} {
  if (uri.scheme !== TENSORLAKE_SCHEME || !uri.authority) {
    throw vscode.FileSystemError.Unavailable("Invalid Tensorlake URI.");
  }

  const remotePath = path.posix.normalize(uri.path || "/");
  return {
    sandboxId: uri.authority,
    remotePath: remotePath.startsWith("/") ? remotePath : `/${remotePath}`,
  };
}
