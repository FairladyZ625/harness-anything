import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CanonicalContentBlob } from "@harness-anything/kernel";
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

  const tempDir = path.join(os.tmpdir(), `ha-peer-bundle-${randomBytes(8).toString("hex")}`);
  const bundleFile = path.join(tempDir, `${input.targetId}.bundle`);
  mkdirSync(tempDir, { recursive: true });
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
    rmSync(tempDir, { recursive: true, force: true });
  }
}
