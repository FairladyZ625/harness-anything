import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function runGit(rootDir, args) {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function writeRepoFile(rootDir, filePath, body) {
  const absolutePath = path.join(rootDir, filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, body);
}

export function makeRepo(files) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "rebuild-gate-test-"));
  runGit(rootDir, ["init", "--quiet"]);
  runGit(rootDir, ["config", "user.name", "Gate Test"]);
  runGit(rootDir, ["config", "user.email", "gate-test@example.invalid"]);
  for (const [filePath, body] of Object.entries(files)) writeRepoFile(rootDir, filePath, body);
  runGit(rootDir, ["add", "."]);
  runGit(rootDir, ["commit", "--quiet", "-m", "fixture base"]);
  return { rootDir, base: runGit(rootDir, ["rev-parse", "HEAD"]) };
}

export function commitAll(rootDir, message = "fixture head") {
  runGit(rootDir, ["add", "."]);
  runGit(rootDir, ["commit", "--quiet", "-m", message]);
  return runGit(rootDir, ["rev-parse", "HEAD"]);
}
