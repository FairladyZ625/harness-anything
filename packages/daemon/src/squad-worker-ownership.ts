import { normalizeRelativeDocumentPath } from "../../kernel/src/index.ts";
import { runProcessTextAsync } from "./process-port.ts";
import type { WorkerCheckout } from "./squad-worker-checkout.ts";

/** A trailing slash declares a directory; every other entry declares one file. */
export function parseWorkerOwnedPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error("ownedPaths must be an array of repository-relative files or directories ending in /.");
  return [
    ...new Set(
      value.map((entry: string) => {
        const directory = entry.endsWith("/"),
          source = directory ? entry.slice(0, -1) : entry,
          normalized = normalizeRelativeDocumentPath(source);
        if (source !== normalized || /[[\]{}]/u.test(source))
          throw new Error(`Ownership requires a canonical file or directory, not a glob: ${entry}`);
        return `${normalized}${directory ? "/" : ""}`;
      }),
    ),
  ];
}

function covers(declaration: string, file: string): boolean {
  const scope = declaration.toLocaleLowerCase("en-US"),
    candidate = file.toLocaleLowerCase("en-US");
  return scope.endsWith("/") ? candidate.startsWith(scope) : candidate === scope;
}

export function overlappingWorkerPaths(left: readonly string[], right: readonly string[]): string | null {
  for (const a of left)
    for (const b of right)
      if (
        covers(a, b) ||
        covers(b, a) ||
        a.toLocaleLowerCase("en-US").replace(/\/$/u, "") === b.toLocaleLowerCase("en-US").replace(/\/$/u, "")
      )
        return `${a} overlaps ${b}`;
  return null;
}

export type WorkerOwnershipCheck = {
  readonly baseSha: string;
  readonly deliveryBaseSha: string;
  readonly headSha: string;
  readonly changedPaths: readonly string[];
  readonly outsidePaths: readonly string[];
};

export async function checkWorkerOwnership(
  checkout: WorkerCheckout,
  ownedPaths: readonly string[],
): Promise<WorkerOwnershipCheck> {
  const headSha = (await runProcessTextAsync("git", ["rev-parse", "HEAD"], checkout.cwd)).trim(),
    remoteRefs = (
      await runProcessTextAsync(
        "git",
        ["for-each-ref", "--format=%(refname)", `--no-contains=${headSha}`, "refs/remotes"],
        checkout.cwd,
      )
    )
      .split("\n")
      .filter(Boolean),
    range = `${checkout.baseSha}..${headSha}`,
    allCommits = (await runProcessTextAsync("git", ["rev-list", "--reverse", "--topo-order", range], checkout.cwd))
      .split("\n")
      .filter(Boolean),
    workerCommits = (
      await runProcessTextAsync(
        "git",
        ["rev-list", "--reverse", "--topo-order", range, ...(remoteRefs.length ? ["--not", ...remoteRefs] : [])],
        checkout.cwd,
      )
    )
      .split("\n")
      .filter(Boolean),
    deliveryBaseSha = workerCommits.length
      ? (await runProcessTextAsync("git", ["rev-parse", `${workerCommits[0]}^`], checkout.cwd)).trim()
      : headSha,
    changed =
      workerCommits.length === allCommits.length
        ? await runProcessTextAsync(
            "git",
            ["diff", "--no-renames", "--name-only", "-z", checkout.baseSha, headSha, "--"],
            checkout.cwd,
          )
        : (
            await Promise.all(
              workerCommits.map(async (commit) => {
                const parents = (await runProcessTextAsync("git", ["show", "-s", "--format=%P", commit], checkout.cwd))
                  .trim()
                  .split(" ")
                  .filter(Boolean);
                return runProcessTextAsync(
                  "git",
                  [
                    "diff-tree",
                    "--root",
                    "--no-commit-id",
                    "--no-renames",
                    "--name-only",
                    "-z",
                    "-r",
                    ...(parents.length > 1 ? ["--cc"] : []),
                    commit,
                    "--",
                  ],
                  checkout.cwd,
                );
              }),
            )
          ).join(""),
    changedPaths = [...new Set(changed.split("\0").filter(Boolean))].sort();
  return {
    baseSha: checkout.baseSha,
    deliveryBaseSha,
    headSha,
    changedPaths,
    outsidePaths: changedPaths.filter((file) => !ownedPaths.some((scope) => covers(scope, file))),
  };
}
