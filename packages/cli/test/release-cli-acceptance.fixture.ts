// harness-test-tier: integration
import assert from "node:assert/strict";

import { execFileSync, spawnSync } from "node:child_process";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

import { hostname, tmpdir } from "node:os";

import path from "node:path";

import { makeTaskEventReader, sha256Bytes } from "../../kernel/src/index.ts";

import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";

import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";

const cli = path.resolve("packages/cli/src/index.ts"),
  daemonId = "release-acc-e2e";

/**
 * Release CLI black-box acceptance: every write goes through the real thin CLI against an isolated
 * daemon, with distinct authenticated principals (owner person, agent:release-worker executor,
 * agent:release-reviewer reviewer). Ledger reads only assert what the CLI already accepted.
 */

function initialize(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n");
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`,
  );
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Release Acceptance");
  git(root, "config", "user.email", "release-acceptance@example.test");
  git(root, "add", "harness/harness.yaml", "harness/people.yaml");
  git(root, "commit", "--quiet", "-m", "release acceptance fixture");
}

function git(root: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function gitBytes(root: string, ref: string): Buffer {
  return execFileSync("git", ["-C", root, "cat-file", "-p", ref], { maxBuffer: 64 * 1024 * 1024 });
}

function gitHasPath(root: string, ref: string): boolean {
  return spawnSync("git", ["-C", root, "cat-file", "-e", ref]).status === 0;
}

function environment(root: string, userRoot: string, actor?: string): NodeJS.ProcessEnv {
  const {
    HARNESS_ACTOR: _actor,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repo,
    ...base
  } = process.env;
  return {
    ...base,
    HOME: path.join(root, ".home"),
    TMPDIR: "/tmp",
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: daemonId,
    ...(actor ? { HARNESS_ACTOR: actor } : {}),
  };
}

function startDaemon(root: string, userRoot: string): void {
  const started = runMaybe(root, userRoot, ["daemon", "start", "--service"]);
  if (started.status === 0) return;
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(started.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(started.stderr || started.stdout);
  }
  if (receipt.code !== "daemon_starting") throw new Error(started.stderr || started.stdout);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    if (runMaybe(root, userRoot, ["daemon", "status"]).status === 0) return;
  }
  throw new Error(String(receipt.nextAction));
}

function run(root: string, userRoot: string, args: readonly string[], actor?: string): Record<string, unknown> {
  const result = runMaybe(root, userRoot, args, actor);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function runMaybe(
  root: string,
  userRoot: string,
  args: readonly string[],
  actor?: string,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env: environment(root, userRoot, actor),
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/**
 * Offline storage commands (backup/restore/events) parse the leading token positionally, so they run
 * with the repository as cwd instead of a --root flag.
 */
function runOffline(root: string, userRoot: string, args: readonly string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: root,
    env: environment(root, userRoot),
  });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function settle(root: string, userRoot: string, opId: string, actor?: string): Record<string, unknown> {
  return run(
    root,
    userRoot,
    ["receipt", "show", opId, "--wait", "git_verified,worktree_visible", "--timeout-ms", "20000"],
    actor,
  );
}

function writeCloseout(root: string, packagePath: string, summary: string, risk = "None for the fixture."): void {
  writeFileSync(
    path.join(root, "harness", packagePath, "closeout.md"),
    `# Closeout\n\n## Summary\n\n${summary}\n\n## Verification\n\nVerified through the real CLI.\n\n` +
      `## Residual Risk\n\n${risk}\n\n## Same Mechanism Elsewhere\n\nNot applicable to the release acceptance fixture.\n`,
  );
}

function docStatusRows(receipt: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> {
  const evidence = String(receipt.evidence ?? "");
  assert.ok(evidence.startsWith("doc-scan:"), `doc status must report its scan, saw ${evidence.slice(0, 120)}`);
  const scan = JSON.parse(evidence.slice("doc-scan:".length)) as {
    rows: ReadonlyArray<Record<string, unknown>>;
  };
  return scan.rows;
}

export {
  assert,
  execFileSync,
  spawnSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  hostname,
  tmpdir,
  path,
  makeTaskEventReader,
  sha256Bytes,
  seedSettingsEvent,
  realizedPlan,
  cli,
  daemonId,
  initialize,
  git,
  gitBytes,
  gitHasPath,
  environment,
  startDaemon,
  run,
  runMaybe,
  runOffline,
  settle,
  writeCloseout,
  docStatusRows,
};
