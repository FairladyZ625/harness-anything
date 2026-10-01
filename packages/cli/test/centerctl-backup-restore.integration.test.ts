// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const centerctl = fileURLToPath(new URL("../../../tools/fleet-center/centerctl.sh", import.meta.url));
const repoId = "center-restore-probe";

type Side = { readonly root: string; readonly userRoot: string; readonly daemonId: string };

type RunResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

// The centerctl `ha` wrapper routes every command as `<cli> --json <command>` and pins the
// daemon user root, daemon id, and the Git identity the daemon's publication uses.
function sideEnvironment(side: Side | null): NodeJS.ProcessEnv {
  const {
    HARNESS_ACTOR: _actor,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repo,
    HARNESS_DAEMON_ID: _daemonId,
    HARNESS_DAEMON_USER_ROOT: _userRoot,
    CLAUDE_CODE_SESSION_ID: _claude,
    CODEX_THREAD_ID: _thread,
    CODEX_SESSION_ID: _session,
    ...base
  } = process.env;
  return {
    ...base,
    ...(side
      ? {
          HARNESS_DAEMON_USER_ROOT: side.userRoot,
          HARNESS_DAEMON_ID: side.daemonId,
          HOME: path.join(path.dirname(side.userRoot), "home"),
          GIT_CONFIG_GLOBAL: "/dev/null",
        }
      : {}),
    GIT_AUTHOR_NAME: "Center Restore Test",
    GIT_AUTHOR_EMAIL: "center-restore@example.test",
    GIT_COMMITTER_NAME: "Center Restore Test",
    GIT_COMMITTER_EMAIL: "center-restore@example.test",
    HARNESS_GIT_AUTHOR_NAME: "Center Restore Test",
    HARNESS_GIT_AUTHOR_EMAIL: "center-restore@example.test",
  };
}

function run(side: Side | null, args: readonly string[]): RunResult {
  const result = spawnSync(process.execPath, [cli, "--json", ...args], {
    cwd: side?.root ?? os.tmpdir(),
    encoding: "utf8",
    env: sideEnvironment(side),
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function receiptOf(side: Side | null, args: readonly string[]): Record<string, unknown> {
  const result = run(side, args);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function applied(side: Side | null, args: readonly string[]): Record<string, unknown> {
  const receipt = receiptOf(side, args);
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  return receipt;
}

// Polls the daemon's own registry state until the predicate holds; the deadline, not a fixed
// sleep, is the failure mode.
async function waitFor(description: string, probe: () => boolean, deadlineMs = 120_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function repoRow(statusReceipt: Record<string, unknown>): Record<string, unknown> | undefined {
  return (statusReceipt.repos as readonly Record<string, unknown>[] | undefined)?.find((row) => row.repoId === repoId);
}

function firstFileUnder(root: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile()) return candidate;
    const nested = firstFileUnder(candidate);
    if (nested) return nested;
  }
  return undefined;
}

test("center bootstrap chain: backup, offline restore, remote-center register, read", async (t) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "ha-center-restore-")),
    source: Side = {
      root: path.join(parent, "source"),
      userRoot: path.join(parent, "user-source"),
      daemonId: "center-restore-source",
    },
    center: Side = {
      root: path.join(parent, "center"),
      userRoot: path.join(parent, "user-center"),
      daemonId: "center-restore-center",
    },
    backupDir = path.join(parent, "backup");
  t.after(() => {
    run(source, ["daemon", "stop"]);
    run(center, ["daemon", "stop"]);
    rmSync(parent, { recursive: true, force: true });
  });
  mkdirSync(source.root, { recursive: true });

  // Seed the source exactly the way an operator's repository is born: `ha init` scaffolds the
  // authored ledger (including this host's local credential), then real writes flow through the
  // resident daemon.
  applied(source, [
    "--root",
    source.root,
    "init",
    "--repo-id",
    repoId,
    "--person-id",
    "center-restore-owner",
    "--display-name",
    "Center Restore Owner",
    "--name",
    "center-restore-source",
  ]);
  const taskId = "task-center-restore-probe";
  const created = applied(source, [
    "--root",
    source.root,
    "task",
    "create",
    "--id",
    taskId,
    "--title",
    "Center restore probe",
    "--preset",
    "docs-task",
    "--vertical",
    "software/coding",
    "--kind",
    "docs",
    "--admin",
  ]);
  applied(source, [
    "--root",
    source.root,
    "receipt",
    "show",
    String(created.opId),
    "--wait",
    "git_verified,worktree_visible",
    "--timeout-ms",
    "10000",
  ]);
  const packagePath = String(created.packagePath),
    planPath = path.join(source.root, "harness", packagePath, "task_plan.md");
  writeFileSync(planPath, "# Plan\n\nCenter restore probe plan body.\n");
  const published = applied(source, [
    "--root",
    source.root,
    "doc",
    "sync",
    "--submit",
    "--path",
    `${packagePath}/task_plan.md`,
  ]);
  applied(source, [
    "--root",
    source.root,
    "receipt",
    "show",
    String(published.opId),
    "--wait",
    "git_verified,worktree_visible",
    "--timeout-ms",
    "10000",
  ]);

  // The supported consistent entry: backup through the source daemon's writer queue, then an
  // offline restore into a destination that does not exist yet.
  const backup = receiptOf(source, ["--root", source.root, "backup", backupDir]);
  assert.equal(backup.schema, "ledger-backup-receipt/v1");
  assert.equal((backup.registration as Record<string, unknown>).repoId, repoId);
  const acceptedRevision = (backup.accepted as Record<string, unknown>).revision;
  assert.ok(typeof acceptedRevision === "number" && acceptedRevision > 0, JSON.stringify(backup));

  const restored = run(null, ["restore", backupDir, "--to", center.root]);
  assert.equal(restored.status, 0, `${restored.stderr}\n${restored.stdout}`);
  const restoreReceipt = JSON.parse(restored.stdout) as Record<string, unknown>;
  assert.equal(restoreReceipt.schema, "ledger-restore-receipt/v1");
  assert.equal(
    (restoreReceipt.accepted as Record<string, unknown>).revision,
    acceptedRevision,
    "restored cut must equal the backup cut",
  );
  assert.equal(
    readFileSync(planPath, "utf8"),
    readFileSync(path.join(center.root, "harness", packagePath, "task_plan.md"), "utf8"),
    "published document bytes must survive the restore",
  );

  // The restored SQLite ledger reads offline, before any center daemon exists, and its last
  // accepted revision is exactly the backup's cut.
  const tail = run(null, ["--root", center.root, "events", "tail", "--since", "0"]);
  assert.equal(tail.status, 0, `${tail.stderr}\n${tail.stdout}`);
  assert.match(tail.stdout, new RegExp(taskId));
  const revisions = (JSON.parse(tail.stdout) as { events: readonly { workspaceRevision: number }[] }).events.map(
    ({ workspaceRevision }) => workspaceRevision,
  );
  assert.equal(Math.max(...revisions), acceptedRevision, "the pristine restored ledger must end at the backup cut");

  // The centerctl sequence: start the center daemon, register the restored root as
  // remote-center, wait for attach, and prove the projection rebuild lands on the exact cut.
  receiptOf(center, ["daemon", "start", "--service"]);
  applied(center, [
    "daemon",
    "repo",
    "register",
    "--repo-id",
    repoId,
    "--root",
    center.root,
    "--mode",
    "remote-center",
  ]);
  await waitFor(`${repoId} attached in remote-center mode`, () => {
    const status = run(center, ["daemon", "status"]);
    if (status.status !== 0) return false;
    const row = repoRow(JSON.parse(status.stdout) as Record<string, unknown>);
    return row?.state === "attached" && row?.mode === "remote-center";
  });
  const rebuild = applied(center, ["--root", center.root, "daemon", "projection", "rebuild"]);
  const proof = rebuild.proof as Record<string, unknown>;
  assert.equal(proof.committedRevision, proof.appliedCut, JSON.stringify(rebuild));
  // The center daemon legitimately advances the restored cut with its own system events; the
  // rebuild must never fall behind the cut the backup carried in.
  assert.ok(Number(proof.committedRevision) >= acceptedRevision, JSON.stringify(rebuild));

  // Entities read back through the center daemon from the restored canonical ledger.
  const shown = receiptOf(center, ["--root", center.root, "task", "show", taskId]);
  const evidence = JSON.parse(String(shown.evidence)) as { task: { title: string } };
  assert.equal(evidence.task.title, "Center restore probe");
});

test("restore refuses an existing center root and a tampered backup", async (t) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "ha-center-restore-negative-")),
    source: Side = {
      root: path.join(parent, "source"),
      userRoot: path.join(parent, "user-source"),
      daemonId: "center-restore-negative",
    },
    backupDir = path.join(parent, "backup"),
    occupiedRoot = path.join(parent, "occupied"),
    tamperedDir = path.join(parent, "tampered"),
    freshRoot = path.join(parent, "fresh");
  t.after(() => {
    run(source, ["daemon", "stop"]);
    rmSync(parent, { recursive: true, force: true });
  });
  mkdirSync(source.root, { recursive: true });
  applied(source, [
    "--root",
    source.root,
    "init",
    "--repo-id",
    repoId,
    "--person-id",
    "center-restore-owner",
    "--display-name",
    "Center Restore Owner",
    "--name",
    "center-restore-negative",
  ]);
  receiptOf(source, ["--root", source.root, "backup", backupDir]);

  mkdirSync(occupiedRoot, { recursive: true });
  writeFileSync(path.join(occupiedRoot, "sentinel"), "existing data\n");
  const occupied = run(null, ["restore", backupDir, "--to", occupiedRoot]);
  assert.equal(occupied.status, 1);
  assert.match(String((JSON.parse(occupied.stdout) as { hint: string }).hint), /already exists/u);
  assert.equal(readFileSync(path.join(occupiedRoot, "sentinel"), "utf8"), "existing data\n");

  const flipped = flipOnePayloadByte(backupDir, tamperedDir);
  const tampered = run(null, ["restore", tamperedDir, "--to", freshRoot]);
  assert.equal(tampered.status, 1);
  assert.match(String((JSON.parse(tampered.stdout) as { hint: string }).hint), /differs/u);
  assert.ok(!existsSync(freshRoot), "a rejected restore must not leave a destination behind");
  assert.ok(flipped);
});

function flipOnePayloadByte(backupDir: string, tamperedDir: string): string {
  cpSync(backupDir, tamperedDir, { recursive: true, verbatimSymlinks: true });
  const victim = firstFileUnder(path.join(tamperedDir, "payload"));
  assert.ok(victim, "backup payload is empty");
  const body = readFileSync(victim);
  writeFileSync(victim, Buffer.from([body[0]! ^ 0xff, ...body.subarray(1)]));
  return victim;
}

test("centerctl.sh keeps the backup bootstrap contract", () => {
  const syntax = spawnSync("bash", ["-n", centerctl]);
  assert.equal(syntax.status, 0, syntax.stderr?.toString() ?? "bash -n failed");
  const script = readFileSync(centerctl, "utf8");
  assert.match(script, /HARNESS_CENTER_BACKUP_DIR/u, "the first up must take a backup directory");
  assert.doesNotMatch(
    script,
    /HARNESS_CENTER_LEDGER_URL|HARNESS_CENTER_LEDGER_BRANCH|HARNESS_CENTER_GIT_TOKEN_STDIN/u,
    "the Git-clone ledger bootstrap must stay deleted",
  );
  const usage = spawnSync("bash", [centerctl], { encoding: "utf8" });
  assert.equal(usage.status, 64);
  assert.match(usage.stderr, /usage: .*up\|status\|down/u);
});

test("offline restore and events tail route with a leading --json flag", () => {
  // centerctl invokes the CLI as `<cli> --json restore ...`; the offline parser must resolve
  // the subcommand by position, not by assuming argv[0].
  const missing = run(null, [
    "restore",
    path.join(os.tmpdir(), `ha-absent-backup-${process.pid}`),
    "--to",
    path.join(os.tmpdir(), `ha-absent-dest-${process.pid}`),
  ]);
  assert.equal(missing.status, 1);
  assert.match(String((JSON.parse(missing.stdout) as { hint: string }).hint), /manifest\.json/u);
});
