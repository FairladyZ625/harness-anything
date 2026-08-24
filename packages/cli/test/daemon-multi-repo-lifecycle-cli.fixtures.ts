import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, hostname, loadavg, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestLocalDaemonJsonRpc } from "../../daemon/src/client/local-json-rpc-client.ts";
import {
  canonicalRoot,
  workspaceId,
} from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../../daemon/src/repo-cell.ts";
import { readDaemonPid } from "../../daemon/src/runtime.ts";
import { makeTaskEventStore } from "../../kernel/src/index.ts";

export const cli = path.resolve("packages/cli/src/index.ts");
export const builtCli = path.resolve("packages/cli/dist/cli/src/index.js");

export function setup(): {
  root: string;
  userRoot: string;
  alpha: string;
  beta: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "ha-w3-"));
  const alpha = path.join(root, "alpha"),
    beta = path.join(root, "beta"),
    userRoot = path.join(root, "user");
  for (const repo of [alpha, beta]) initialize(repo);
  return { root, userRoot, alpha, beta };
}
export function setupEmpty(): { root: string; userRoot: string; repo: string } {
  const root = mkdtempSync(path.join(tmpdir(), "ha-w3-init-"));
  const repo = path.join(root, "repo"),
    userRoot = path.join(root, "user");
  mkdirSync(repo);
  return { root, userRoot, repo };
}
export function makeCanary(
  root: string,
  script = 'const { title } = JSON.parse(process.env.HA_PRESET_INPUT); console.log(JSON.stringify({ schema: "preset-script-result/v1", produces: [{ capabilityId: "policy:task-create/v1", payload: { taskId: "task-canary", title } }] }));\n',
  produces: readonly Record<string, string>[] = [
    { id: "policy:task-create/v1", kind: "command", version: "1" },
  ],
): string {
  const source = path.join(root, "user-canary");
  mkdirSync(path.join(source, "scripts"), { recursive: true });
  writeFileSync(
    path.join(source, "PRESET.md"),
    "---\nschema: preset-document/v1\ndescription: Daemon canary\nwhenToUse: Verify the typed process route.\n---\n# Canary\n",
  );
  writeFileSync(
    path.join(source, "preset.json"),
    JSON.stringify({
      schema: "preset-manifest/v3",
      id: "user-canary",
      title: "User Canary",
      vertical: "software/coding",
      version: "3.0.0",
      kind: "process-action",
      outputShape: "repository-diff",
      kernelVersionRange: { min: "1.0.0" },
      capabilityImports: [],
      entrypoints: {
        create: {
          type: "script",
          intent: "Create one task",
          inputs: [{ name: "title", type: "string", required: true }],
          requires: [],
          produces,
          sideEffects: [],
          command: "scripts/create.mjs",
        },
      },
      profiles: [
        {
          id: "baseline",
          title: "Baseline",
          completionGates: [],
          templateSelections: [],
        },
      ],
      defaultProfile: "baseline",
    }),
  );
  writeFileSync(path.join(source, "scripts/create.mjs"), script);
  return source;
}
export async function waitForRun(
  root: string,
  userRoot: string,
  runId: string,
  phase: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await requestLocalDaemonJsonRpc(
      root,
      "repo.preset.run.status",
      { repo: { repoId: "alpha" }, payload: { runId } },
      1_000,
      { userRoot },
    );
    if (status.phase === phase) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} did not reach ${phase}`);
}
export function initialize(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "layout:\n  authoredRoot: harness\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`,
    "utf8",
  );
  git(root, "init", "--quiet");
  git(root, "add", "harness/harness.yaml", "harness/people.yaml");
  git(root, "commit", "--quiet", "-m", "fixture");
}
export function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)]!;
}

export function register(
  root: string,
  userRoot: string,
  repoId: string,
  entry = cli,
): void {
  assert.equal(
    run(
      root,
      userRoot,
      [
        "daemon",
        "repo",
        "register",
        "--repo-id",
        repoId,
        "--root",
        root,
        "--no-link",
      ],
      entry,
    ).ok,
    true,
  );
}
export function run(
  root: string,
  userRoot: string,
  args: readonly string[],
  entry = cli,
): Record<string, unknown> {
  const result = runMaybe(root, userRoot, args, entry);
  assert.equal(
    result.status,
    0,
    `${result.stderr}\n${JSON.stringify(result.receipt)}`,
  );
  return result.receipt;
}
export function runMaybe(
  root: string,
  userRoot: string,
  args: readonly string[],
  entry = cli,
): { status: number | null; receipt: Record<string, unknown>; stderr: string } {
  const { HARNESS_ACTOR: _actor, ...baseEnv } = process.env;
  const result = spawnSync(
    process.execPath,
    [entry, "--root", root, "--json", ...args],
    {
      encoding: "utf8",
      env: {
        ...baseEnv,
        HOME: path.join(root, ".home"),
        GIT_CONFIG_GLOBAL: "/dev/null",
        HARNESS_DAEMON_USER_ROOT: userRoot,
      },
    },
  );
  return {
    status: result.status,
    receipt: JSON.parse(result.stdout) as Record<string, unknown>,
    stderr: result.stderr,
  };
}
export function runNoop(
  root: string,
  userRoot: string,
  entry: string,
): { status: number | null } {
  const { HARNESS_ACTOR: _actor, ...baseEnv } = process.env;
  const result = spawnSync(
    process.execPath,
    [entry, "--root", root, "--help"],
    {
      stdio: "ignore",
      env: {
        ...baseEnv,
        HOME: path.join(root, ".home"),
        GIT_CONFIG_GLOBAL: "/dev/null",
        HARNESS_DAEMON_USER_ROOT: userRoot,
      },
    },
  );
  return { status: result.status };
}
export function stop(root: string, userRoot: string, entry = cli): void {
  spawnSync(
    process.execPath,
    [entry, "--root", root, "--json", "daemon", "stop"],
    {
      encoding: "utf8",
      env: { ...process.env, HARNESS_DAEMON_USER_ROOT: userRoot },
    },
  );
}
// The ledger repository is created by `ha init`, which supplies the commit
// identity per command instead of configuring it in the repository. Fixture
// commits must carry their own identity: an ambient global identity exists on
// developer machines and not on CI runners.
export function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "W3 Test",
      GIT_AUTHOR_EMAIL: "w3@example.test",
      GIT_COMMITTER_NAME: "W3 Test",
      GIT_COMMITTER_EMAIL: "w3@example.test",
    },
  }).trim();
}
