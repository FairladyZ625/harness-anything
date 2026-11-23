import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CanonicalContentBlob } from "@harness-anything/kernel";
import { createHostScratchDirectory } from "./host-environment-io.ts";
import { runProcessExitAsync } from "./process-port.ts";

export interface PreparedHandoffBundle {
  readonly wipCommitSha: string;
  readonly bundleBlob?: CanonicalContentBlob;
  readonly bundleSha256?: `sha256:${string}`;
  readonly bundleSize?: number;
}

/**
 * Prepare a content-addressed git bundle for a task worktree (or an explicit bundle file) so
 * WIP commits are persisted through the canonical content-object store & 7545 replication stream
 * instead of staying trapped on a shutting-down node's disk.
 */
export async function prepareHandoffBundle(input: {
  readonly rootDir: string;
  readonly targetId: string;
  readonly explicitCommitSha?: string;
  readonly explicitBundlePath?: string;
}): Promise<PreparedHandoffBundle> {
  if (input.explicitBundlePath) {
    const bytes = readFileSync(input.explicitBundlePath);
    const hex = createHash("sha256").update(bytes).digest("hex");
    const commitSha = input.explicitCommitSha ?? hex.slice(0, 40);
    return {
      wipCommitSha: commitSha,
      bundleBlob: { sha256: hex, size: bytes.byteLength, mediaType: "application/x-git-bundle", body: bytes },
      bundleSha256: `sha256:${hex}`,
      bundleSize: bytes.byteLength,
    };
  }
  const worktreeDir = path.join(input.rootDir, ".worktrees", input.targetId);
  const gitDir = existsSync(worktreeDir) ? worktreeDir : input.rootDir;
  let commitSha = input.explicitCommitSha;
  if (!commitSha && existsSync(path.join(gitDir, ".git"))) {
    const rev = await runProcessExitAsync("git", ["rev-parse", "HEAD"], gitDir, undefined, undefined, undefined, {
      timeoutMs: 5_000,
    });
    if (rev.exitCode === 0 && /^[0-9a-f]{7,64}$/u.test(rev.stdout.trim())) commitSha = rev.stdout.trim();
  }
  if (!commitSha) commitSha = "0000000000000000000000000000000000000000";

  if (!existsSync(path.join(gitDir, ".git"))) return { wipCommitSha: commitSha };

  const scratch = createHostScratchDirectory("peerHandoffBundle");
  const bundleFile = path.join(scratch.directory, `${input.targetId}.bundle`);
  try {
    const created = await runProcessExitAsync(
      "git",
      ["bundle", "create", bundleFile, "HEAD"],
      gitDir,
      undefined,
      undefined,
      undefined,
      { timeoutMs: 15_000 },
    );
    if (created.exitCode !== 0 || !existsSync(bundleFile)) return { wipCommitSha: commitSha };
    const bytes = readFileSync(bundleFile);
    const hex = createHash("sha256").update(bytes).digest("hex");
    return {
      wipCommitSha: commitSha,
      bundleBlob: { sha256: hex, size: bytes.byteLength, mediaType: "application/x-git-bundle", body: bytes },
      bundleSha256: `sha256:${hex}`,
      bundleSize: bytes.byteLength,
    };
  } finally {
    scratch.close();
  }
}

export interface MaterializedHandoffBundle {
  readonly materialized: boolean;
  readonly gitDir: string;
  readonly commitSha: string;
}

/** Materialize a content-addressed git bundle blob into the receiver's local worktree/repo. */
export async function materializeHandoffBundle(input: {
  readonly rootDir: string;
  readonly targetId: string;
  readonly bundleBytes: Uint8Array;
  readonly wipCommitSha: string;
}): Promise<MaterializedHandoffBundle> {
  const worktreeDir = path.join(input.rootDir, ".worktrees", input.targetId);
  const gitDir = existsSync(worktreeDir) ? worktreeDir : input.rootDir;
  if (!existsSync(path.join(gitDir, ".git"))) {
    return { materialized: false, gitDir, commitSha: input.wipCommitSha };
  }
  const scratch = createHostScratchDirectory("peerHandoffBundle");
  const bundleFile = path.join(scratch.directory, `${input.targetId}.bundle`);
  try {
    writeFileSync(bundleFile, input.bundleBytes);
    const unbundled = await runProcessExitAsync(
      "git",
      ["bundle", "unbundle", bundleFile],
      gitDir,
      undefined,
      undefined,
      undefined,
      { timeoutMs: 15_000 },
    );
    return { materialized: unbundled.exitCode === 0, gitDir, commitSha: input.wipCommitSha };
  } finally {
    scratch.close();
  }
}
