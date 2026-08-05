import { execFileSync } from "node:child_process";

export function publicationGitExitCode(rootDir: string, ...args: ReadonlyArray<string>): number {
  try {
    execFileSync("git", ["-C", rootDir, ...args], {
      stdio: "ignore",
      windowsHide: true
    });
    return 0;
  } catch (error) {
    return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : 1;
  }
}
