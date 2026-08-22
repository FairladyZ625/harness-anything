import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** Physical workspace text reads stay in the daemon adapter layer. */
export function readWorkspaceText(rootDir: string, requested: string, field: string): string {
  let root: string, candidate: string, bytes: Uint8Array;
  try { root = realpathSync(rootDir); candidate = realpathSync(path.resolve(root, requested)); bytes = readFileSync(candidate); }
  catch { throw portError(`${field} must be a readable UTF-8 file.`); }
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw portError(`${field} must stay inside the workspace.`);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw portError(`${field} must be a readable UTF-8 file.`); }
}

function portError(message: string): Error { const error = new Error(message) as Error & { readonly code: "invalid_command" }; Object.defineProperty(error, "code", { value: "invalid_command", enumerable: true }); return error; }
