import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface DocSyncAppliedLedgerLayout {
  readonly authoredRoot: string;
  readonly watermarkPath: string;
}

export function resolveDocSyncAppliedLedgerSha(
  layout: DocSyncAppliedLedgerLayout,
  intentId: string,
  hasAppliedChanges: boolean
): string {
  if (!hasAppliedChanges) return gitText(layout.authoredRoot, ["rev-parse", "HEAD"]) ?? "no-git-head";
  const parsed = JSON.parse(readFileSync(layout.watermarkPath, "utf8")) as {
    readonly schema?: unknown;
    readonly lastCommittedOpIds?: unknown;
    readonly lastCommitSha?: unknown;
  };
  if (parsed.schema !== "write-watermark/v1"
    || !Array.isArray(parsed.lastCommittedOpIds)
    || !parsed.lastCommittedOpIds.includes(intentId)
    || typeof parsed.lastCommitSha !== "string"
    || !/^[0-9a-f]{40}$/u.test(parsed.lastCommitSha)) {
    throw new Error(`Doc sync commit watermark does not prove publication for ${intentId}.`);
  }
  const resolved = gitText(layout.authoredRoot, ["rev-parse", "--verify", `${parsed.lastCommitSha}^{commit}`]);
  if (resolved !== parsed.lastCommitSha) {
    throw new Error(`Doc sync commit watermark is not visible in the authored repository for ${intentId}.`);
  }
  return parsed.lastCommitSha;
}

export function gitText(cwd: string, args: ReadonlyArray<string>): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trimEnd();
  } catch {
    return null;
  }
}
