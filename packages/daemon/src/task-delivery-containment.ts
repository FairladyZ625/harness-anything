import { localGitObjectRefStore } from "@harness-anything/storage";
import { runProcessText } from "./process-port.ts";

export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type DeliveryContainment = "contained" | "missing" | "unavailable";

/** Prove that the frozen patch, replayed in Git's object database, produces the annotated head tree. */
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
  try {
    const replayedTree = runProcessText(
        "git",
        ["merge-tree", "--write-tree", "--merge-base", frozenBase, rebasedBase, frozenCommit],
        rootDir,
      ).trim(),
      headTree = runProcessText("git", ["rev-parse", `${rebasedHead}^{tree}`], rootDir).trim();
    return replayedTree === headTree;
  } catch {
    return false;
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
