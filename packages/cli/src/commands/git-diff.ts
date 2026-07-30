import { collectGitDiffEvidence } from "@harness-anything/adapter-local";
import { demotedGateWarning } from "../cli/demoted-gate-warning.ts";
import type { CliResult } from "../cli/types.ts";

export function runGitDiffEvidence(rootDir: string, baseRef?: string): CliResult {
  const report = collectGitDiffEvidence({ rootDir, baseRef });
  return {
    ok: true,
    command: "git-diff",
    report,
    warnings: report.ok ? undefined : [demotedGateWarning(
      "git_diff_unavailable",
      report.error ?? "Git diff evidence is unavailable for this repository."
    )]
  };
}
