import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { delay, runDaemonCommand } from "./daemon-cli.ts";

export function readCliPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(path.resolve("packages/cli/package.json"), "utf8")) as { readonly version?: unknown };
  assert.equal(typeof pkg.version, "string");
  return pkg.version;
}

export function normalizeVolatileReceipt(receipt: Record<string, unknown>): Record<string, unknown> {
  const meta = isRecord(receipt.meta) ? { ...receipt.meta } : undefined;
  if (meta) delete meta.generatedAt;
  return {
    ...receipt,
    ...(meta ? { meta } : {})
  };
}

export async function waitForCondition(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (check()) return;
    await delay(100);
  }
  assert.equal(check(), true);
}

export function daemonStatusRepoIds(rootDir: string, userRoot: string, repoId: string): ReadonlyArray<string> {
  return daemonStatusRepos(rootDir, userRoot, repoId).map((repo) => repo.repoId);
}

export function daemonStatusRepos(rootDir: string, userRoot: string, repoId: string): ReadonlyArray<{ readonly repoId: string; readonly state?: string }> {
  const status = runDaemonCommand(rootDir, ["--repo", repoId, "daemon", "status", "--user-root", userRoot, "--json"], {
    HARNESS_DAEMON_USER_ROOT: userRoot
  });
  return Array.isArray(status.repos) ? status.repos as Array<{ repoId: string; state?: string }> : [];
}

export function initGitRepo(rootDir: string): void {
  const env = hermeticGitEnv(rootDir);
  execFileSync("git", ["-C", rootDir, "init", "-b", "master"], { stdio: "ignore", env });
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Harness Test"], { stdio: "ignore", env });
  execFileSync("git", ["-C", rootDir, "config", "user.email", "harness@example.test"], { stdio: "ignore", env });
}

export function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: hermeticGitEnv(rootDir)
  }).trim();
}

export function hermeticGitEnv(rootDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: path.join(rootDir, ".home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    // The fixture carries its own identity. Blanking the config files is not enough:
    // macOS Git synthesizes a `user@host` author when none is configured, so these
    // commits pass on a developer machine and fail on CI with "Author identity unknown".
    GIT_AUTHOR_NAME: "Harness Test",
    GIT_AUTHOR_EMAIL: "harness@example.test",
    GIT_COMMITTER_NAME: "Harness Test",
    GIT_COMMITTER_EMAIL: "harness@example.test"
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function receiptPath(receipt: Record<string, unknown>, role: string): string {
  const paths = receipt.paths;
  assert.equal(Array.isArray(paths), true);
  const value = (paths as ReadonlyArray<{ readonly role?: unknown; readonly path?: unknown }>)
    .find((entry) => entry.role === role)?.path;
  assert.equal(typeof value, "string");
  return value as string;
}
