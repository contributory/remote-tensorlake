import * as path from "path";
import * as vscode from "vscode";

export const TENSORLAKE_SCHEME = "tensorlake";
export const TENSORLAKE_HOME = "/home/tl-user";
export const DEFAULT_TENSORLAKE_WORKSPACE = `${TENSORLAKE_HOME}/workspace`;

export function tensorlakeUri(
  sandboxId: string,
  remotePath = DEFAULT_TENSORLAKE_WORKSPACE,
  sandboxName?: string | null,
): vscode.Uri {
  if (!sandboxId.trim()) {
    throw new Error("Tensorlake sandbox id is required.");
  }

  const normalized = path.posix.normalize(
    remotePath.startsWith("/") ? remotePath : `/${remotePath}`,
  );

  const authority = sandboxName?.trim() || sandboxId;
  const query = authority === sandboxId
    ? ""
    : new URLSearchParams({ sandboxId }).toString();

  return vscode.Uri.from({
    scheme: TENSORLAKE_SCHEME,
    authority,
    path: normalized === "." ? "/" : normalized,
    query,
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
  const query = new URLSearchParams(uri.query);
  const sandboxId = query.get("sandboxId")?.trim() || uri.authority;
  return {
    sandboxId,
    remotePath: remotePath.startsWith("/") ? remotePath : `/${remotePath}`,
  };
}
