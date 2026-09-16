// Shared helpers for S6 migration-source fixture generation.
// Freeze format per scenario directory:
//   events.jsonl           one JSON object per line: {revision, op_id, digest, occurred_at, recorded_at, event_json}
//                          event_json is the raw stored text (byte-exact for F tier).
//   command-outcomes.jsonl raw command_outcome rows.
//   objects/               content-addressed ledger objects referenced by the frozen events.
//   meta.json              {fixture, tier, shapes, source, repoId, revisionRange, notes}
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI = path.join(REPO_ROOT, "packages/cli/src/index.ts");
export const FIXTURE_OUT = path.join(REPO_ROOT, "packages/kernel/fixtures/migration-source");

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

export function runCli(fixture, args, environment, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "--root", fixture.root, "--json", ...args], {
      cwd: fixture.root,
      env: environment,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }));
    if (input !== undefined) child.stdin.end(input);
  });
}

export async function applied(fixture, args, environment) {
  const result = await runCli(fixture, args, environment);
  if (result.status !== 0)
    throw new Error(`ha ${args.join(" ")} exited ${result.status}: ${result.stderr}\n${result.stdout}`);
  const receipt = JSON.parse(result.stdout);
  if (receipt.outcome !== "applied") throw new Error(`ha ${args.join(" ")} not applied: ${result.stdout}`);
  return receipt;
}

export async function runAllowingRejection(fixture, args, environment) {
  const result = await runCli(fixture, args, environment);
  let receipt = null;
  try {
    receipt = JSON.parse(result.stdout);
  } catch {
    /* non-JSON output */
  }
  return { status: result.status, receipt, stdout: result.stdout, stderr: result.stderr };
}

export async function published(fixture, receipt, environment) {
  return applied(
    fixture,
    ["receipt", "show", String(receipt.opId), "--wait", "git_verified,worktree_visible", "--timeout-ms", "15000"],
    environment,
  );
}

export function actorEnvironment(fixture, actor) {
  const {
    HARNESS_ACTOR: _a,
    HARNESS_DAEMON_ENDPOINT: _e,
    HARNESS_DAEMON_REPO_ID: _r,
    HARNESS_DAEMON_ID: _d,
    HARNESS_DAEMON_USER_ROOT: _u,
    CLAUDE_CODE_SESSION_ID: _c,
    CODEX_THREAD_ID: _t,
    CODEX_SESSION_ID: _s,
    ...base
  } = process.env;
  return {
    ...base,
    HOME: path.join(fixture.parent, "home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HARNESS_DAEMON_USER_ROOT: fixture.userRoot,
    HARNESS_DAEMON_ID: fixture.daemonId,
    ...(actor ? { HARNESS_ACTOR: actor.startsWith("agent:") ? actor : `agent:${actor}` } : {}),
  };
}

export function fixtureRoot(prefix) {
  const parent = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    parent,
    root: path.join(parent, "repo"),
    userRoot: path.join(parent, "user"),
    daemonId: `s6-fixture-${process.pid}`,
    repoId: `s6-fixture-repo-${process.pid}`,
  };
}

export async function startDaemon(fixture, extraEnv = {}) {
  const env = { ...actorEnvironment(fixture, null), ...extraEnv };
  const started = await runCli(fixture, ["daemon", "start", "--service"], env);
  if (started.status !== 0 && !/daemon_starting/u.test(started.stdout)) {
    // status 0 can mean already running; otherwise wait for readiness below
    const probe = await runCli(fixture, ["daemon", "status"], env);
    if (probe.status !== 0)
      throw new Error(`daemon start failed: ${started.status} ${started.stdout} ${started.stderr}`);
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await runCli(fixture, ["daemon", "status"], env);
    if (status.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("daemon did not become ready");
}

export async function registerAndAttach(fixture, extraEnv = {}) {
  const env = { ...actorEnvironment(fixture, null), ...extraEnv };
  await applied(
    fixture,
    ["daemon", "repo", "register", "--repo-id", fixture.repoId, "--root", fixture.root, "--no-link"],
    env,
  );
  let last = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await runCli(fixture, ["daemon", "status"], env);
    last = status.stdout;
    try {
      const receipt = JSON.parse(status.stdout);
      const rows = Array.isArray(receipt.repos) ? receipt.repos : [];
      if (rows.some((repo) => repo.repoId === fixture.repoId && repo.state === "attached")) return;
    } catch {
      /* keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`repository did not attach: ${last}`);
}

export async function stopDaemon(fixture) {
  if (!existsSync(fixture.userRoot)) return;
  await runCli(fixture, ["daemon", "stop"], actorEnvironment(fixture, null));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await runCli(fixture, ["daemon", "status"], actorEnvironment(fixture, null));
    if (status.status !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function findLedgerDir(rootDir) {
  const generations = path.join(rootDir, ".harness", "store", "generations");
  const active = readdirSync(generations)
    .filter((name) => /^\d+$/u.test(name))
    .filter((name) => existsSync(path.join(generations, name, "ledger.sqlite.activation.json")))
    .map((name) => Number(name))
    .sort((a, b) => b - a);
  if (active.length === 0) throw new Error(`no activated generation under ${generations}`);
  return { generation: active[0], dir: path.join(generations, String(active[0])) };
}

function copyObjects(sourceObjectsDir, destinationDir) {
  if (!existsSync(sourceObjectsDir)) return 0;
  let count = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const relative = path.relative(sourceObjectsDir, full);
        const target = path.join(destinationDir, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(full, target);
        count += 1;
      }
    }
  };
  walk(sourceObjectsDir);
  return count;
}

// Freeze an entire ledger (all revisions, contiguous) into a fixture directory.
export function freezeLedger(rootDir, destination, meta) {
  const { generation, dir } = findLedgerDir(rootDir);
  mkdirSync(destination, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "ledger.sqlite"), { readOnly: true });
  try {
    const events = db
      .prepare("SELECT revision, op_id, digest, occurred_at, recorded_at, event_json FROM event ORDER BY revision")
      .all();
    const outcomes = db.prepare("SELECT * FROM command_outcome ORDER BY first_revision").all();
    writeFileSync(path.join(destination, "events.jsonl"), events.map((row) => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(
      path.join(destination, "command-outcomes.jsonl"),
      outcomes.map((row) => JSON.stringify(row)).join("\n") + (outcomes.length ? "\n" : ""),
    );
    const objectCount = copyObjects(path.join(dir, "objects"), path.join(destination, "objects"));
    const first = events[0]?.revision ?? null;
    const last = events[events.length - 1]?.revision ?? null;
    writeFileSync(
      path.join(destination, "meta.json"),
      JSON.stringify(
        {
          ...meta,
          generation,
          eventCount: events.length,
          outcomeCount: outcomes.length,
          objectCount,
          revisionRange: [first, last],
          contiguous: events.every((row, index) => row.revision === (first ?? 0) + index),
          frozenAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    return { generation, events, outcomes, objectCount };
  } finally {
    db.close();
  }
}

// Freeze a revision-selected subset of a canonical snapshot, preserving original revision
// numbers and digest column. event_json may be pre-transformed (de-identified); when it is,
// the row digest is recomputed and the original digest is kept as source_digest.
export function freezeRows(rows, destination, meta) {
  mkdirSync(destination, { recursive: true });
  writeFileSync(
    path.join(destination, "events.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
  );
  writeFileSync(
    path.join(destination, "meta.json"),
    JSON.stringify(
      {
        ...meta,
        eventCount: rows.length,
        revisionRange: rows.length
          ? [Math.min(...rows.map((r) => r.revision)), Math.max(...rows.map((r) => r.revision))]
          : null,
        revisions: rows.map((r) => r.revision),
        frozenAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
}

export function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function appendManifestEntry(entry) {
  const manifestPath = path.join(FIXTURE_OUT, "manifest.json");
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : { schema: "migration-source-fixtures/v1", fixtures: [] };
  manifest.fixtures = manifest.fixtures.filter((item) => item.id !== entry.id);
  manifest.fixtures.push(entry);
  manifest.fixtures.sort((a, b) => a.id.localeCompare(b.id));
  mkdirSync(FIXTURE_OUT, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

export function cleanFixtureDir(name) {
  const dir = path.join(FIXTURE_OUT, name);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}
