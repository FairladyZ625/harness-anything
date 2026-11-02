import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { localGitObjectRefStore, localGitText } from "@harness-anything/storage";
import { runProcessText } from "./process-port.ts";

export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type DeliveryContainment = "contained" | "missing" | "unavailable";

/** Prove that the frozen patch, replayed onto the rebased base, produces the annotated head tree. */
export function rebaseEquivalentDelivery(
  rootDir: string,
  frozenBase: string,
  frozenCommit: string,
  rebasedBase: string,
  rebasedHead: string,
): boolean {
  if (
    !/^[0-9a-f]{40}$/u.test(frozenBase) ||
    !/^[0-9a-f]{40}$/u.test(frozenCommit) ||
    !/^[0-9a-f]{40}$/u.test(rebasedBase) ||
    !/^[0-9a-f]{40}$/u.test(rebasedHead) ||
    !localGitObjectRefStore.hasCommit(rootDir, frozenBase) ||
    !localGitObjectRefStore.hasCommit(rootDir, frozenCommit) ||
    !localGitObjectRefStore.hasCommit(rootDir, rebasedBase) ||
    !localGitObjectRefStore.hasCommit(rootDir, rebasedHead) ||
    !localGitObjectRefStore.isAncestor(rootDir, rebasedBase, rebasedHead)
  )
    return false;
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "ha-rebase-equivalence-")),
    patchPath = path.join(temporaryRoot, "frozen.patch"),
    indexPath = path.join(temporaryRoot, "index");
  try {
    const patch = runProcessText(
      "git",
      ["diff", "--no-ext-diff", "--no-renames", "--binary", frozenBase, frozenCommit, "--"],
      rootDir,
    );
    if (!patch) return false;
    writeFileSync(patchPath, patch);
    // The index is disposable, but GIT_INDEX_FILE is process-scoped. These synchronous calls
    // run without an event-loop yield, so no other operation can observe the temporary index.
    const previousIndex = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = indexPath;
    let replayedTree: string;
    try {
      localGitText(rootDir, "read-tree", rebasedBase);
      localGitText(rootDir, "apply", "--cached", "--3way", patchPath);
      replayedTree = localGitText(rootDir, "write-tree").trim();
    } finally {
      if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previousIndex;
    }
    const headTree = runProcessText("git", ["rev-parse", `${rebasedHead}^{tree}`], rootDir).trim();
    return replayedTree === headTree;
  } catch {
    return false;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/** Prove the submitted diff is present in the annotated commit without requiring shared ancestry. */
export function deliveryContainment(
  rootDir: string,
  baseline: string | null,
  deliveryCommit: string,
  mergeCommit: string,
): DeliveryContainment {
  if (localGitObjectRefStore.isAncestor(rootDir, deliveryCommit, mergeCommit)) return "contained";
  // The canonical empty tree is a valid `git diff` endpoint, but it is a tree object rather than
  // a commit, so `hasCommit` must not reject the baseline frozen for an unborn repository.
  if (baseline === null || (baseline !== EMPTY_TREE_SHA && !localGitObjectRefStore.hasCommit(rootDir, baseline)))
    return "unavailable";

  const changedPaths = runProcessText(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", baseline, deliveryCommit, "--"],
    rootDir,
  )
    .split("\0")
    .filter((target) => target.length > 0);
  // A pathless commit proves no delivered content; only the exact commit ancestry proves this cut.
  if (changedPaths.length === 0) return "missing";
  return localGitObjectRefStore.pathsMatch(rootDir, deliveryCommit, mergeCommit, changedPaths)
    ? "contained"
    : "missing";
}
