import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const execFileAsync = promisify(execFile);

test("daemon client mode preserves command receipt output shape against direct mode", () => {
  withTempRoot((rootDir) => {
    const direct = normalizeVolatileReceipt(runRawJson(rootDir, ["version"], { HARNESS_DAEMON_MODE: "direct" }));
    const daemon = normalizeVolatileReceipt(runRawJson(rootDir, ["version"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "250" }));

    assert.deepEqual(daemon, direct);
  });
});

test("daemon client auto-starts, durably writes, and exits after idle", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "250" });
    const created = runRawJson(rootDir, ["new-task", "--title", "Daemon Client Write"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "250" });

    assert.equal(created.ok, true);
    assert.equal(created.schema, "command-receipt/v2");
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/watermark.json")), true);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /write-watermark\/v1/u);

    sleep(700);
    const status = runDaemonCommand(rootDir, ["daemon", "status", "--json"]);
    assert.equal(status.started, false);
  });
});

test("daemon client applies command-level RBAC to inner CLI commands", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    writePeopleRoster(rootDir, {
      personId: "person_maint",
      displayName: "Maintainer User",
      email: "maintainer@example.test",
      role: "maintainer"
    });

    const read = runRawJson(rootDir, ["version"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "250" });
    assert.equal(read.ok, true);

    const write = runRawJson(rootDir, ["new-task", "--title", "Maintainer Daemon Write"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "250"
    });
    assert.equal(write.ok, true);

    const arbiter = runRawJsonMaybeFail(rootDir, ["decision", "accept", "dec_missing", "--judgment-only", "manual arbiter probe"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "250"
    });
    assert.notEqual(arbiter.status, 0);
    assert.equal(arbiter.receipt.ok, false);
    assert.deepEqual((arbiter.receipt.error as { code?: string }).code, "rbac_forbidden");
    assert.equal(((arbiter.receipt.details as Record<string, unknown>).actor as { personId?: string }).personId, "person_maint");
    assert.equal((arbiter.receipt.details as Record<string, unknown>).commandClass, "arbiter");
  });
});

test("daemon client writes git commits with the resolved actor author", () => {
  withTempRoot((rootDir) => {
    initGitRepo(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    writePeopleRoster(rootDir, {
      personId: "person_owner",
      displayName: "Owner User",
      email: "owner@example.test",
      role: "owner"
    });

    const receipt = runRawJson(rootDir, ["new-task", "--title", "Owner Author Attribution"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "250"
    });

    assert.equal(receipt.ok, true);
    assert.equal(((receipt.details as Record<string, unknown>).actor as { personId?: string }).personId, "person_owner");
    assert.equal(git(rootDir, "log", "-1", "--pretty=format:%an <%ae>"), "Owner User <owner@example.test>");
  });
});

test("concurrent daemon client startup converges on one lock owner and both clients continue", async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "1500" });

    const [left, right] = await Promise.all([
      runRawJsonAsync(rootDir, ["task", "list"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "1500" }),
      runRawJsonAsync(rootDir, ["task", "list"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "1500" })
    ]);

    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    const status = runDaemonCommand(rootDir, ["daemon", "status", "--json"]);
    assert.equal(status.started, true);
    assert.equal(typeof status.pid, "number");
  });
});

test("daemon start service status and stop expose productized status contract", () => {
  withTempRoot((rootDir) => {
    try {
      const start = runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"]);
      assert.equal(start.started, true);
      assert.equal(start.mode, "service");
      assert.equal(start.version, "0.0.0");
      assert.equal(typeof start.queueDepth, "number");

      const status = runDaemonCommand(rootDir, ["daemon", "status", "--json"]);
      assert.equal(status.started, true);
      assert.equal(status.reachable, true);
      assert.equal(typeof status.pid, "number");
      assert.equal(status.version, "0.0.0");
      assert.equal(status.protocolVersion, 1);
      assert.equal(typeof status.queueDepth, "number");
      assert.equal(isRecord(status.queue), true);
      assert.equal(isRecord(status.connections), true);
      assert.equal(Array.isArray(status.repos), true);
      assert.equal((status.repos as Array<{ repoId?: string; state?: string }>)[0]?.repoId, "canonical");
      assert.equal((status.repos as Array<{ repoId?: string; state?: string }>)[0]?.state, "attached");

      const stop = runDaemonCommand(rootDir, ["daemon", "stop", "--timeout-ms", "5000", "--json"]);
      assert.equal(stop.signaled, true);
      assert.equal(stop.drained, true);
      assert.equal(stop.stopped, true);
    } finally {
      try {
        runDaemonCommand(rootDir, ["daemon", "stop", "--timeout-ms", "1000", "--json"]);
      } catch {
        // best-effort cleanup for failed assertions
      }
    }
  });
});

test("daemon install-templates distributes three platform service templates", () => {
  withTempRoot((rootDir) => {
    const outDir = path.join(rootDir, "templates");
    const result = runDaemonCommand(rootDir, ["daemon", "install-templates", "--out", outDir, "--json"]);
    assert.equal(result.ok, true);
    assert.equal(existsSync(path.join(outDir, "harness-anything-daemon.service")), true);
    assert.equal(existsSync(path.join(outDir, "com.harness-anything.daemon.plist")), true);
    assert.equal(existsSync(path.join(outDir, "install-harness-anything-daemon.ps1")), true);
  });
});

test("daemon bootstrap-server is idempotent and installs roster hooks and read-only mirror", () => {
  withTempRoot((rootDir) => {
    const canonicalRoot = path.join(rootDir, "canonical");
    const mirrorRoot = path.join(rootDir, "readonly.git");
    const reportPath = path.join(rootDir, "bootstrap-report.json");
    const args = [
      "daemon",
      "bootstrap-server",
      "--canonical-root",
      canonicalRoot,
      "--ssh-host",
      "team-host",
      "--ssh-user",
      "alice",
      "--person-id",
      "person_alice",
      "--display-name",
      "Alice Admin",
      "--email",
      "alice@example.com",
      "--readonly-mirror",
      mirrorRoot,
      "--report",
      reportPath,
      "--skip-ssh-check",
      "--no-start",
      "--json"
    ];
    const first = runDaemonCommand(rootDir, args);
    const second = runDaemonCommand(rootDir, args);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(existsSync(path.join(canonicalRoot, "harness/people.yaml")), true);
    assert.match(readFileSync(path.join(canonicalRoot, "harness/people.yaml"), "utf8"), /person_alice/u);
    assert.equal(existsSync(path.join(canonicalRoot, ".git/hooks/pre-receive")), true);
    assert.equal(existsSync(path.join(mirrorRoot, "hooks/pre-receive")), true);
    assert.equal(existsSync(reportPath), true);

    const canonicalHook = spawnSync(path.join(canonicalRoot, ".git/hooks/pre-receive"), {
      cwd: canonicalRoot,
      encoding: "utf8"
    });
    assert.notEqual(canonicalHook.status, 0);
    assert.match(canonicalHook.stderr, /rejected this direct push/u);

    const mirrorHook = spawnSync(path.join(mirrorRoot, "hooks/pre-receive"), {
      cwd: mirrorRoot,
      encoding: "utf8"
    });
    assert.notEqual(mirrorHook.status, 0);
    assert.match(mirrorHook.stderr, /read-only mirror/u);
  });
});

test("daemon repo commands register list and unregister the user-level registry", () => {
  withTempRoot((rootDir) => {
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\n", "utf8");
    const userRoot = path.join(rootDir, "user-harness");

    const register = runDaemonCommand(rootDir, [
      "daemon",
      "repo",
      "register",
      "--repo-id",
      "canonical",
      "--display-name",
      "Canonical",
      "--user-root",
      userRoot,
      "--no-link",
      "--json"
    ]);
    assert.equal(register.ok, true);
    assert.equal((register.repo as { repoId?: string }).repoId, "canonical");
    assert.equal((register.repo as { state?: string }).state, "enabled");

    const list = runDaemonCommand(rootDir, ["daemon", "repo", "list", "--user-root", userRoot, "--json"]);
    assert.equal(list.ok, true);
    assert.equal(list.count, 1);
    assert.deepEqual((list.repos as Array<{ repoId: string; state: string }>).map((repo) => [repo.repoId, repo.state]), [["canonical", "enabled"]]);

    const unregister = runDaemonCommand(rootDir, ["daemon", "repo", "unregister", "--repo-id", "canonical", "--user-root", userRoot, "--no-link", "--json"]);
    assert.equal(unregister.ok, true);
    assert.equal((unregister.repo as { state?: string }).state, "disabled");
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-daemon-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

async function withTempRootAsync<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-daemon-"));
  try {
    return await fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runRawJson(rootDir: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

function runRawJsonMaybeFail(
  rootDir: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {}
): { readonly status: number | null; readonly receipt: Record<string, unknown> } {
  const result = spawnSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  assert.equal(result.stderr, "");
  return {
    status: result.status,
    receipt: JSON.parse(result.stdout) as Record<string, unknown>
  };
}

async function runRawJsonAsync(rootDir: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

function runDaemonCommand(rootDir: string, args: ReadonlyArray<string>): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, ...args], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_DAEMON_MODE: "direct" }
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

function normalizeVolatileReceipt(receipt: Record<string, unknown>): Record<string, unknown> {
  const meta = isRecord(receipt.meta) ? { ...receipt.meta } : undefined;
  if (meta) delete meta.generatedAt;
  return {
    ...receipt,
    ...(meta ? { meta } : {})
  };
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function initGitRepo(rootDir: string): void {
  execFileSync("git", ["-C", rootDir, "init", "-b", "master"], { stdio: "ignore" });
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Harness Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", rootDir, "config", "user.email", "harness@example.test"], { stdio: "ignore" });
}

function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function writePeopleRoster(rootDir: string, person: {
  readonly personId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: "owner" | "maintainer";
}): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  writeFileSync(path.join(harnessRoot, "people.yaml"), [
    "schema: harness-people/v1",
    "people:",
    `  - personId: ${person.personId}`,
    `    displayName: ${person.displayName}`,
    `    primaryEmail: ${person.email}`,
    `    roles: [${person.role}]`,
    "    credentials:",
    "      - kind: unix-uid",
    `        issuer: host:${hostname()}`,
    `        subject: ${process.getuid?.() ?? 0}`,
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    "  - roleId: maintainer",
    "    commandClasses: [repo-write, repo-read]",
    ""
  ].join("\n"), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
