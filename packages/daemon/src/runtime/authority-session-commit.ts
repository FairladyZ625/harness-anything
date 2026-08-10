import { execFileSync } from "node:child_process";

export function resolveAuthoritySessionCommit(
  authoredRoot: string,
  sessionId: string
): string {
  return execFileSync(
    "git",
    ["-C", authoredRoot, "rev-parse", "--verify", `refs/heads/sessions/${sessionId}^{commit}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 10_000, killSignal: "SIGKILL" }
  ).trim();
}
