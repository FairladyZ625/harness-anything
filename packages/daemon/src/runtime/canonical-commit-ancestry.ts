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
    execFileSync(
      "git",
      ["-C", authoredRoot, "merge-base", "--is-ancestor", acceptedCommitSha, head],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, timeout: 10_000, killSignal: "SIGKILL" }
    );
    return head;
  } catch {
    return undefined;
  }
}
