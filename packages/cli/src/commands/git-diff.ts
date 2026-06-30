import { collectGitDiffEvidence } from "../../../adapters/local/src/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import type { CliResult } from "../cli/types.ts";

export function runGitDiffEvidence(rootDir: string, baseRef?: string): CliResult {
  const report = collectGitDiffEvidence({ rootDir, baseRef });
  return {
    ok: report.ok,
    command: "git-diff",
    report,
    error: report.ok ? undefined : cliError(CliErrorCode.GitDiffUnavailable, report.error ?? "Git diff evidence is unavailable for this repository.")
  };
}
