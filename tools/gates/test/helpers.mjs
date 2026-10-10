import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";

// Repos made by this helper are throwaway fixtures; the module-level after hook removes them
// once the file's tests finish (it runs after a timeout too, where try/finally inside a test would not).
const fixtureRoots = [];
// Registered at module load, before any test body runs: a hook registered inside a test body
// would attach to that one test instead of the file's whole run.
after(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function trackFixtureRoot(rootDir) {
  fixtureRoots.push(rootDir);
}

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
  trackFixtureRoot(rootDir);
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

export function captureGate(run) {
  const stdout = [],
    stderr = [],
    originalLog = console.log,
    originalError = console.error;
  console.log = (...args) => stdout.push(args.join(" "));
  console.error = (...args) => stderr.push(args.join(" "));
  try {
    return { code: run(), stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}
