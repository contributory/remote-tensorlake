import * as path from "path";
import * as vscode from "vscode";

export const TENSORLAKE_SCHEME = "tensorlake";
export const TENSORLAKE_HOME = "/home/tl-user";
export const DEFAULT_TENSORLAKE_WORKSPACE = `${TENSORLAKE_HOME}/workspace`;

const TENSORLAKE_URI_NAMESPACE = "/.tensorlake";

function normalizeRemotePath(remotePath: string): string {
  const normalized = path.posix.normalize(
    remotePath.startsWith("/") ? remotePath : `/${remotePath}`,
  );
  return normalized === "." ? "/" : normalized;
}

function uriPathForSandbox(sandboxId: string, remotePath: string): string {
  const normalized = normalizeRemotePath(remotePath);
  const encodedSandboxId = encodeURIComponent(sandboxId);
  return `${TENSORLAKE_URI_NAMESPACE}/${encodedSandboxId}${
    normalized === "/" ? "/" : normalized
  }`;
}

export function tensorlakeUri(
  sandboxId: string,
  remotePath = DEFAULT_TENSORLAKE_WORKSPACE,
  sandboxName?: string | null,
): vscode.Uri {
  const normalizedSandboxId = sandboxId.trim();
  if (!normalizedSandboxId) {
    throw new Error("Tensorlake sandbox id is required.");
  }

  return vscode.Uri.from({
    scheme: TENSORLAKE_SCHEME,
    authority: sandboxName?.trim() || normalizedSandboxId,
    path: uriPathForSandbox(normalizedSandboxId, remotePath),
  });
}

export function parseTensorlakeUri(uri: vscode.Uri): {
  sandboxId: string;
  remotePath: string;
} {
  if (uri.scheme !== TENSORLAKE_SCHEME || !uri.authority) {
    throw vscode.FileSystemError.Unavailable("Invalid Tensorlake URI.");
  }

  // Backward compatibility for workspaces opened by <= 0.0.15.
  const legacyQuery = new URLSearchParams(uri.query);
  const legacySandboxId = legacyQuery.get("sandboxId")?.trim();
  if (legacySandboxId) {
    return {
      sandboxId: legacySandboxId,
      remotePath: normalizeRemotePath(uri.path || "/"),
    };
  }

  const prefix = `${TENSORLAKE_URI_NAMESPACE}/`;
  if (uri.path.startsWith(prefix)) {
    const remainder = uri.path.slice(prefix.length);
    const separator = remainder.indexOf("/");
    if (separator <= 0) {
      throw vscode.FileSystemError.Unavailable("Invalid Tensorlake URI.");
    }

    const encodedSandboxId = remainder.slice(0, separator);
    let sandboxId: string;
    try {
      sandboxId = decodeURIComponent(encodedSandboxId).trim();
    } catch {
      throw vscode.FileSystemError.Unavailable("Invalid Tensorlake sandbox id.");
    }
    if (!sandboxId) {
      throw vscode.FileSystemError.Unavailable("Invalid Tensorlake sandbox id.");
    }

    const remotePath = remainder.slice(separator) || "/";
    return {
      sandboxId,
      remotePath: normalizeRemotePath(remotePath),
    };
  }

  // Legacy unnamed-sandbox URIs used the sandbox id directly as authority.
  return {
    sandboxId: uri.authority,
    remotePath: normalizeRemotePath(uri.path || "/"),
  };
}
