import path from "node:path";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { cellCodedError } from "./repo-cell-errors.ts";
import { runProcessExitAsync, runProcessTextAsync } from "./process-port.ts";

/** Admission shared by submission and publication: deleting an old leak is allowed, publishing one is not. */
export async function assertNoIgnoredLedgerDelivery(
  rootDir: string,
  baseRef: string,
  commitSha: string,
): Promise<void> {
  const layout = resolveHarnessLayout(rootDir),
    roots = [layout.authoredRoot, layout.localRoot].map((root) =>
      path.relative(rootDir, root).split(path.sep).join("/"),
    ),
    // Inspect the whole delivery history: removing a forced file at the tip still publishes its bytes.
    records = (
      await runProcessTextAsync(
        "git",
        [
          "log",
          "--format=",
          "--raw",
          "-z",
          "--no-renames",
          "--diff-merges=first-parent",
          "--diff-filter=ACMRT",
          `${baseRef}..${commitSha}`,
          "--",
          ...roots.map((root) => `:(literal)${root}`),
        ],
        rootDir,
      )
    ).split("\0"),
    paths = [...new Set(records.filter((_, index) => index % 2 === 1))];
  if (!paths.length) return;
  const result = await runProcessExitAsync(
    "git",
    ["check-ignore", "--no-index", "--stdin", "-z"],
    rootDir,
    undefined,
    `${paths.join("\0")}\0`,
  );
  // Exit 1 is Git's ordinary no-match verdict; other exits remain Git failures.
  if (result.exitCode !== 0 && result.exitCode !== 1)
    throw Object.assign(new Error(result.stderr.trim()), { code: result.exitCode });
  const ignored = result.stdout.split("\0").filter(Boolean);
  if (ignored.length)
    throw Object.assign(
      cellCodedError(
        "ignored_ledger_delivery",
        `Delivery history contains ignored ledger paths: ${ignored.join(", ")}. ` +
          "Keep task documents in the ledger; task submit accepts them. Remove these paths from the delivery commits before retrying; do not force-add ignored ledger files.",
      ),
      {
        nextAction:
          "Remove ignored ledger paths from the delivery commits, keeping their files in the task ledger; then retry the same task submit or task push command.",
      },
    );
}
