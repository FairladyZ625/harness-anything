import { execFileSync } from "node:child_process";

export function canonicalCommitContaining(
  authoredRoot: string,
  acceptedCommitSha: string
): string | undefined {
  try {
    const head = execFileSync(
      "git",
      ["-C", authoredRoot, "rev-parse", "--verify", "HEAD^{commit}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 10_000, killSignal: "SIGKILL" }
    ).trim();
    const firstParentHistory = gitLines(authoredRoot, "rev-list", "--first-parent", head);
    const ancestryPath = new Set([
      acceptedCommitSha,
      ...gitLines(authoredRoot, "rev-list", "--ancestry-path", `${acceptedCommitSha}..${head}`)
    ]);
    return [...firstParentHistory].reverse().find((commitSha) => ancestryPath.has(commitSha));
  } catch {
    return undefined;
  }
}

function gitLines(authoredRoot: string, ...args: ReadonlyArray<string>): ReadonlyArray<string> {
  return execFileSync(
    "git",
    ["-C", authoredRoot, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 10_000,
      killSignal: "SIGKILL"
    }
  ).trim().split("\n").filter(Boolean);
}
