import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function initializeNestedHarnessRepo(rootDir: string, options: { readonly writeOuterGitignore?: boolean } = {}): void {
  if (options.writeOuterGitignore) {
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
  }

  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  if (existsSync(path.join(harnessRoot, ".git"))) return;

  execFileSync("git", ["-C", harnessRoot, "init", "-q"]);
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "harness@example.test"]);
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "Harness Test"]);
  writeFileSync(path.join(harnessRoot, ".gitignore"), "*.log\n", "utf8");
  execFileSync("git", ["-C", harnessRoot, "add", ".gitignore"]);
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "seed harness repo"]);
}
