import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { workspacePathResolutionRule } from "@harness-anything/preset/internal/preset-command-contract";

/** Physical workspace text reads stay in the daemon adapter layer. */
export function readWorkspaceText(rootDir: string, requested: string, field: string): string {
  let root = rootDir,
    requestedPath: string,
    candidate: string,
    bytes: Uint8Array;
  try {
    root = realpathSync(rootDir);
    requestedPath = path.resolve(root, requested);
    requestedPath = path.join(realpathSync(path.dirname(requestedPath)), path.basename(requestedPath));
    if (requestedPath !== root && !requestedPath.startsWith(`${root}${path.sep}`)) throw boundaryError(field, root);
    candidate = realpathSync(requestedPath);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw boundaryError(field, root);
    bytes = readFileSync(candidate);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (isBoundaryError(error)) throw error;
    throw portError(
      `${field} must name a readable UTF-8 file inside workspace root ${root}; ${workspacePathResolutionRule}.`,
    );
  }
}

function boundaryError(field: string, workspaceRoot: string): Error {
  return portError(`${field} is outside the workspace boundary.`, { field, workspaceRoot });
}

function isBoundaryError(error: unknown): error is Error & { readonly field: string; readonly workspaceRoot: string } {
  return !!error && typeof error === "object" && "field" in error && "workspaceRoot" in error;
}

function portError(message: string, boundary?: { readonly field: string; readonly workspaceRoot: string }): Error {
  const error = new Error(message) as Error & {
    readonly code: "invalid_command";
    readonly field?: string;
    readonly workspaceRoot?: string;
  };
  Object.defineProperty(error, "code", { value: "invalid_command", enumerable: true });
  if (boundary) Object.assign(error, boundary);
  return error;
}
