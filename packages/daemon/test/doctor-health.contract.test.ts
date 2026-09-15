// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDaemonRegistry } from "../../kernel/src/index.ts";
import { doctorHealth } from "../src/repo-cell-doctor.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { removeTemporaryDirectory } from "../../../tools/temporary-directory-cleanup.mjs";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "codex" } },
  binding = withRoleBinding({ actor, source: "local" as const }, "repo-write");

function initRepo(rootDir: string): void {
  const git = (...args: readonly string[]) =>
    execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet");
  git("config", "user.name", "Doctor Health Test");
  git("config", "user.email", "doctor@example.invalid");
  git("config", "gc.auto", "0");
  writeFileSync(path.join(rootDir, "README.md"), "# Fixture\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "fixture base");
}

test("doctor health reports the six checks and degrades to indeterminate without origin/main", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doctor-health-")),
    repoId = workspaceId("doctor-health");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "doctor-health" });
    const receipt = (await cell.run({ kind: "doctor-health" }, binding)) as Record<string, unknown>;
    assert.equal(receipt.schema, "doctor-health/v1", JSON.stringify(receipt));
    const checks = receipt.checks as readonly { id: string; status: string; count: number }[];
    assert.deepEqual(
      checks.map((check) => check.id),
      ["stale-delivered", "executor-undeclared", "orphan-lease", "wip-pressure", "doc-debt", "build-drift"],
    );
    const byId = new Map(checks.map((check) => [check.id, check]));
    // A fixture repository has no origin remote: freshness and the daemon-side build verdict
    // cannot be judged, so both checks report indeterminate rather than guessing.
    assert.equal(byId.get("stale-delivered")?.status, "indeterminate");
    assert.equal(byId.get("build-drift")?.status, "indeterminate");
    for (const id of ["executor-undeclared", "orphan-lease", "wip-pressure"])
      assert.equal(byId.get(id)?.status, "ok", id);
    assert.ok(["ok", "warn"].includes(String(byId.get("doc-debt")?.status)));
    for (const check of checks) assert.ok(["ok", "warn", "fail", "indeterminate"].includes(check.status), check.id);
  } finally {
    await cell?.close();
    await removeTemporaryDirectory(rootDir);
  }
});

test("doctor host composes loaded/disk identities and remote edge never reports local data as center health", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-doctor-host-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    runtimeFile = path.join(parent, "dist/daemon/src/runtime.js"),
    marker = path.join(parent, "dist/build-id.txt"),
    edge = path.join(parent, "edge");
  rosterRepo(rootDir, "doctor-host");
  mkdirSync(path.dirname(runtimeFile), { recursive: true });
  writeFileSync(runtimeFile, "fixture");
  writeFileSync(marker, "build-a\n");
  mkdirSync(path.join(edge, "harness"), { recursive: true });
  writeFileSync(
    path.join(edge, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  registerBootstrappedDaemonRepo({
    canonicalRoot: rootDir,
    repoId: "doctor-host",
    userRoot,
    createConvenienceLinks: false,
  });
  // An edge registration comes from fleet onboarding; it has no ledger Git checkout.
  const registry = readDaemonRegistry({ userRoot });
  writeFileSync(
    path.join(userRoot, "registry.json"),
    JSON.stringify({
      schema: "harness-daemon-registry/v2",
      connections: registry.connections,
      repos: [
        ...registry.repos,
        { ...registry.repos[0], repoId: "doctor-edge", canonicalRoot: edge, mode: "remote-edge" },
      ],
    }),
  );
  const host = await openDaemonHost({ daemonId: "doctor-host", userRoot, runtimeFile });
  await host.attachmentsSettled();
  try {
    for (const [disk, expected] of [
      ["build-a", "ok"],
      ["build-b", "warn"],
      ["", "indeterminate"],
    ]) {
      writeFileSync(marker, disk!);
      const receipt = (await host.run("doctor-host", { kind: "doctor-health" }, auth)) as Record<string, unknown>;
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const checks = receipt.checks as { id: string; status: string }[];
      assert.equal(checks.length, 6);
      assert.deepEqual(JSON.parse(String(receipt.evidence)).checks, checks);
      assert.equal(checks.find((check) => check.id === "build-drift")?.status, expected);
    }
    const receipt = (await host.run("doctor-edge", { kind: "doctor-health" }, auth)) as Record<string, unknown>;
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal((receipt.checks as { status: string }[]).length, 6);
    assert.ok((receipt.checks as { status: string }[]).every((check) => check.status === "indeterminate"));
    assert.match(JSON.stringify(receipt.scope), /center-local.*unavailable.*remote-edge/u);
  } finally {
    await host.close();
    await removeTemporaryDirectory(parent);
  }
});

test("doctor reads beyond 500 tasks and deduplicates ancestry against the captured tip", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doctor-cut-")),
    bin = path.join(rootDir, "bin"),
    logPath = path.join(rootDir, "git-calls.jsonl"),
    originalPath = process.env.PATH,
    realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  initRepo(rootDir);
  const git = (...args: string[]) => execFileSync(realGit, ["-C", rootDir, ...args], { encoding: "utf8" }).trim(),
    tip = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "test: later delivery");
  const delivery = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", tip);
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "git"),
    `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const {appendFileSync} = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
const result = spawnSync(${JSON.stringify(realGit)}, args, {encoding:'utf8'});
if (args.join(' ') === 'rev-parse origin/main') spawnSync(${JSON.stringify(realGit)}, ['update-ref','refs/remotes/origin/main',${JSON.stringify(delivery)}]);
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  const rows = Array.from({ length: 501 }, (_, i) => ({
    taskId: `task_${i}`,
    snapshot: {
      task: {
        iteration: 1,
        title: `Task ${i}`,
        status: "in_review",
        currentNode: "review",
        packageDisposition: "active",
      },
      lease: null,
      executions: [
        {
          schema: "execution/v1",
          executionId: `exe_${i}`,
          iteration: 1,
          state: "submitted",
          actor: i === 500 ? { ...actor, executor: null } : actor,
          submission: { commitSha: delivery },
        },
      ],
    },
  }));
  const cell = {
    rootDir,
    mode: "local",
    input: { repoId: "doctor-cut" },
    now: () => "2026-09-15T00:00:00.000Z",
    projection: {
      list: (query: { status: string; limit?: number }) => ({
        rows: query.status === "in_review" ? rows.slice(0, query.limit) : [],
      }),
      readTaskChildCounts: () => ({}),
      currentLease: (taskId: string) =>
        taskId === "task_500"
          ? { phase: "orphaned", executionId: "exe_500", expiresAt: "2026-09-14T00:00:00.000Z" }
          : null,
      readCut: () => ({ sourceRevision: 1 }),
    },
    operationId: () => "doctor-read",
    readResult: () => ({ outcome: "applied" }),
  };
  try {
    const receipt = (await doctorHealth(cell as never, { kind: "doctor-health" }, binding)) as Record<string, unknown>,
      checks = receipt.checks as { id: string; status: string; count: number; summary: string }[],
      byId = new Map(checks.map((check) => [check.id, check]));
    assert.equal(byId.get("executor-undeclared")?.count, 1);
    assert.equal(byId.get("executor-undeclared")?.status, "fail");
    assert.equal(byId.get("orphan-lease")?.count, 1);
    assert.equal(byId.get("stale-delivered")?.count, 501);
    assert.match(byId.get("stale-delivered")!.summary, /not yet merged/u);
    const calls = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
      ancestry = calls.filter((args) => args[0] === "merge-base");
    assert.deepEqual(ancestry, [["merge-base", "--is-ancestor", delivery, tip]]);
    assert.equal(calls.filter((args) => args[0] === "cat-file").length, 1);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await removeTemporaryDirectory(rootDir);
  }
});
