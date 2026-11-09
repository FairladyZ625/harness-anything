import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { workspacePathResolutionRule } from "@harness-anything/preset/internal/preset-command-contract";

/**
 * The filesystem adapter behind AuthoredDocument reads of uncommitted package bytes. Canonical
 * bytes are read from `TaskProjection.readDocument`; this port is only for worktree candidates that
 * have not been accepted into that projection yet. All daemon package-byte reads use this adapter.
 */
export function readAuthoredDocumentBytes(authoredRoot: string, logicalPath: string): Uint8Array {
  try {
    const root = realpathSync(authoredRoot);
    const requested = path.resolve(root, logicalPath),
      parent = realpathSync(path.dirname(requested)),
      candidate = path.join(parent, path.basename(requested));
    if (
      (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) ||
      (realpathSync(candidate) !== root && !realpathSync(candidate).startsWith(`${root}${path.sep}`))
    )
      throw new Error("authored document path is outside the task package root");
    return readFileSync(candidate);
  } catch (error) {
    const failure = new Error(
      `authored document path must name a readable file inside its authored root; ${workspacePathResolutionRule}.`,
      { cause: error },
    ) as Error & { readonly code: "invalid_command" };
    Object.defineProperty(failure, "code", { value: "invalid_command", enumerable: true });
    throw failure;
  }
}
