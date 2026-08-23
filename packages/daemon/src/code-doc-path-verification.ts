import path from "node:path";
import { resolveLedgerGitLayout } from "../../kernel/src/index.ts";
import { makeGitReadinessSource } from "./process-port.ts";

type GitSource = ReturnType<typeof makeGitReadinessSource>;

export type CodeDocCommitPathVerification =
  | {
      readonly ok: true;
      readonly commitSha: string;
      readonly paths: readonly string[];
      readonly repositoryRoot: string;
    }
  | {
      readonly ok: false;
      readonly code: "commit_not_found" | "paths_not_found";
      readonly commitSha: string;
      readonly missingPaths: readonly string[];
    };

/** Resolve one immutable commit/path cut in either legitimate Git root of the workspace. */
export function verifyCodeDocCommitPaths(
  input: { readonly rootDir: string; readonly commitSha: string; readonly paths: readonly string[] },
  source: GitSource = makeGitReadinessSource(),
): CodeDocCommitPathVerification {
  const roots = [
    ...new Set([path.resolve(input.rootDir), path.resolve(resolveLedgerGitLayout(input.rootDir).rootDir)]),
  ];
  const owners = roots.filter(
    (root) => source.run(root, ["cat-file", "-e", `${input.commitSha}^{commit}`]).ok,
  );
  if (!owners.length)
    return {
      ok: false,
      code: "commit_not_found",
      commitSha: input.commitSha,
      missingPaths: [...input.paths],
    };
  const missingByOwner = owners.map((root) => ({
    root,
    missing: input.paths.filter(
      (candidate) => !source.run(root, ["cat-file", "-e", `${input.commitSha}:${candidate}`]).ok,
    ),
  }));
  const verified = missingByOwner.find(({ missing }) => missing.length === 0);
  if (verified)
    return {
      ok: true,
      commitSha: input.commitSha,
      paths: [...input.paths],
      repositoryRoot: verified.root,
    };
  const missingEverywhere = input.paths.filter((candidate) =>
    missingByOwner.every(({ missing }) => missing.includes(candidate)),
  );
  return {
    ok: false,
    code: "paths_not_found",
    commitSha: input.commitSha,
    missingPaths: missingEverywhere.length ? missingEverywhere : [...input.paths],
  };
}
