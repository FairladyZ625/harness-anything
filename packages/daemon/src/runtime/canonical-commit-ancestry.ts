import { execFileSync } from "node:child_process";

export function canonicalCommitContaining(
  authoredRoot: string,
  acceptedCommitSha: string
): string | undefined {
  try {
    const head = execFileSync(
      "git",
      ["-C", authoredRoot, "rev-parse", "--verify", "HEAD^{commit}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    ).trim();
    execFileSync(
      "git",
      ["-C", authoredRoot, "merge-base", "--is-ancestor", acceptedCommitSha, head],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
    );
    return head;
  } catch {
    return undefined;
  }
}
