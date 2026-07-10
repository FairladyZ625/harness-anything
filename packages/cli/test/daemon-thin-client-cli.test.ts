import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import net from "node:net";
import { hostname } from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonRpcLineClient } from "../../daemon/src/index.ts";
import {
  defaultDaemonUserRoot,
  delay,
  runDaemonCommand,
  runRawJson,
  runRawJsonAsync,
  runRawJsonMaybeFail,
  sleep,
  stopDaemonQuietly,
  withTempRoot,
  withTempRootAsync
} from "./helpers/daemon-cli.ts";

const expectedCliVersion = readCliPackageVersion();
const cliEntry = path.resolve("packages/cli/src/index.ts");

test("daemon connect relays opaque bytes without creating repository runtime state", { skip: process.platform === "win32" }, async () => {
  await withTempRootAsync(async (rootDir) => {
    const endpoint = path.join(rootDir, "relay.sock");
    const server = net.createServer((socket) => socket.pipe(socket));
    await listen(server, endpoint);
    try {
      const result = await runDaemonCliProcess(rootDir, ["daemon", "connect", "--stdio", "--socket", endpoint], "opaque request\nsecond frame\n");
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "opaque request\nsecond frame\n");
      assert.equal(existsSync(path.join(rootDir, "harness")), false);
    } finally {
      await closeServer(server);
    }
  });
});

test("daemon connect reaches the already-running daemon instance", async () => {
  await withTempRootAsync(async (rootDir) => {
    const startStatus = runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"]);
    const child = spawnDaemonCli(rootDir, ["daemon", "connect", "--stdio"]);
    const client = new JsonRpcLineClient(child.stdout, child.stdin, child);
    const hello = await client.request("protocol.hello", { protocolVersion: 1 });
    const status = await client.request("repo.daemon.status", { repo: { repoId: "canonical" } });
    client.close();

    assert.equal(hello.ok, true);
    const details = status.details as Record<string, unknown>;
    const data = details.data as Record<string, unknown>;
    assert.equal(data.daemonId, startStatus.daemonId);
    assert.equal(data.started, true);
  });
});

test("daemon connect fails closed with startup instructions when no persistent daemon exists", async () => {
  await withTempRootAsync(async (rootDir) => {
    const endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\ha-connect-missing-${process.pid}-${Date.now()}`
      : path.join(rootDir, "missing.sock");
    const result = await runDaemonCliProcess(rootDir, ["daemon", "connect", "--stdio", "--socket", endpoint]);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /No persistent daemon is listening/iu);
    assert.match(result.stderr, /ha daemon start --service/iu);
    assert.equal(existsSync(path.join(rootDir, "harness")), false);
  });
});

test("daemon serve --stdio is rejected before runtime attachment", async () => {
  await withTempRootAsync(async (rootDir) => {
    const result = await runDaemonCliProcess(rootDir, ["daemon", "serve", "--stdio"]);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /daemon connect --stdio/iu);
    assert.equal(existsSync(path.join(rootDir, "harness")), false);
  });
});

test("daemon client mode preserves command receipt output shape against direct mode", () => {
  withTempRoot((rootDir) => {
    const direct = normalizeVolatileReceipt(runRawJson(rootDir, ["version"], { HARNESS_DAEMON_MODE: "direct" }));
    const daemon = normalizeVolatileReceipt(runRawJson(rootDir, ["version"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "250" }));

    assert.deepEqual(daemon, direct);
  });
});

test("daemon client auto-starts, durably writes, and exits after idle", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    writePeopleRoster(rootDir, {
      personId: "person_auto",
      displayName: "Auto User",
      email: "auto@example.test",
      role: "owner"
    });
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
    assert.equal(git(path.join(rootDir, "harness"), "log", "-1", "--pretty=format:%an <%ae>"), "Owner User <owner@example.test>");
  });
});

test("concurrent daemon client startup converges on one lock owner and both clients continue", async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });

    const [left, right] = await Promise.all([
      runRawJsonAsync(rootDir, ["task", "list"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "10000" }),
      runRawJsonAsync(rootDir, ["task", "list"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "10000" })
    ]);

    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    const status = runDaemonCommand(rootDir, ["daemon", "status", "--json"]);
    assert.equal(status.started, true);
    assert.equal(typeof status.pid, "number");
  });
});

test("concurrent daemon client writes serialize into linear git history", async () => {
  await withTempRootAsync(async (rootDir) => {
    initGitRepo(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    writePeopleRoster(rootDir, {
      personId: "person_concurrent",
      displayName: "Concurrent User",
      email: "concurrent@example.test",
      role: "owner"
    });
    const harnessRoot = path.join(rootDir, "harness");
    const beforeHead = git(harnessRoot, "rev-parse", "HEAD");

    const [left, right] = await Promise.all([
      runRawJsonAsync(rootDir, ["new-task", "--title", "Concurrent Daemon Write Left"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "1500" }),
      runRawJsonAsync(rootDir, ["new-task", "--title", "Concurrent Daemon Write Right"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "1500" })
    ]);

    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    const leftPackagePath = receiptPath(left, "package");
    const rightPackagePath = receiptPath(right, "package");
    const taskIndexPaths = [leftPackagePath, rightPackagePath].map((packagePath) => {
      const taskPath = path.relative(harnessRoot, path.resolve(rootDir, packagePath)).split(path.sep).join("/");
      return `${taskPath}/INDEX.md`;
    });
    assert.equal(new Set(taskIndexPaths).size, 2);
    for (const taskIndexPath of taskIndexPaths) {
      assert.doesNotThrow(() => git(harnessRoot, "cat-file", "-e", `HEAD:${taskIndexPath}`));
      assert.equal(Number(git(harnessRoot, "rev-list", "--count", `${beforeHead}..HEAD`, "--", taskIndexPath)), 1);
    }
    const parentCounts = git(harnessRoot, "log", "--format=%P", `${beforeHead}..HEAD`)
      .split(/\r?\n/u)
      .map((line) => line.trim().length === 0 ? 0 : line.trim().split(/\s+/u).length);
    assert.equal(parentCounts.every((count) => count <= 1), true);
    assert.equal(git(harnessRoot, "status", "--short"), "");
  });
});

test("daemon start service status and stop expose productized status contract", () => {
  withTempRoot((rootDir) => {
    try {
      const start = runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"]);
      assert.equal(start.started, true);
      assert.equal(start.mode, "service");
      assert.equal(start.version, expectedCliVersion);
      assert.equal(typeof start.queueDepth, "number");

      const status = runDaemonCommand(rootDir, ["daemon", "status", "--json"]);
      assert.equal(status.started, true);
      assert.equal(status.reachable, true);
      assert.equal(typeof status.pid, "number");
      assert.equal(status.version, expectedCliVersion);
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
    assert.equal(first.registry && typeof first.registry === "object" && (first.registry as { repoId?: string }).repoId, "canonical");
    assert.equal(existsSync(path.join(defaultDaemonUserRoot(rootDir), "registry.json")), true);

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

test("daemon client auto-registers initialized single repo on first local command", () => {
  withTempRoot((rootDir) => {
    const userRoot = path.join(rootDir, "user-daemon");
    try {
      runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: userRoot });

      const listed = runRawJson(rootDir, ["task", "list"], {
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_IDLE_MS: "60000"
      });

      assert.equal(listed.ok, true);
      const registry = JSON.parse(readFileSync(path.join(userRoot, "registry.json"), "utf8")) as { repos: Array<{ repoId: string; canonicalRoot: string; state: string }> };
      assert.deepEqual(registry.repos.map((repo) => [repo.repoId, repo.canonicalRoot, repo.state]), [["canonical", realpathSync.native(rootDir), "enabled"]]);

      const status = runDaemonCommand(rootDir, ["daemon", "status", "--user-root", userRoot, "--json"], { HARNESS_DAEMON_USER_ROOT: userRoot });
      assert.equal(status.started, true);
      assert.equal(status.repoId, "canonical");
      assert.equal(status.rootDir, realpathSync.native(rootDir));
    } finally {
      stopDaemonQuietly(rootDir, userRoot);
    }
  });
});

test("daemon client resolves an existing single-repo registry without requiring repo input", () => {
  withTempRoot((rootDir) => {
    const userRoot = path.join(rootDir, "user-daemon");
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: userRoot });
    writePeopleRoster(rootDir, {
      personId: "person_registered",
      displayName: "Registered User",
      email: "registered@example.test",
      role: "owner"
    });
    const registered = runDaemonCommand(rootDir, ["daemon", "repo", "register", "--repo-id", "canonical", "--user-root", userRoot, "--no-link", "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    assert.equal(registered.ok, true);

    const created = runRawJson(rootDir, ["new-task", "--title", "Registered Single Repo"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_DAEMON_IDLE_MS: "250"
    });

    assert.equal(created.ok, true);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks")), true);
  });
});

test("daemon client fails unregistered cwd in multi-repo registry with register hint", () => {
  withTempRoot((workspaceRoot) => {
    const userRoot = path.join(workspaceRoot, "user-daemon");
    const alphaRoot = path.join(workspaceRoot, "alpha");
    const betaRoot = path.join(workspaceRoot, "beta");
    const outsiderRoot = path.join(workspaceRoot, "outsider");
    for (const rootDir of [alphaRoot, betaRoot, outsiderRoot]) {
      mkdirSync(rootDir, { recursive: true });
      runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: userRoot });
    }
    runDaemonCommand(alphaRoot, ["daemon", "repo", "register", "--repo-id", "alpha", "--root", alphaRoot, "--user-root", userRoot, "--no-link", "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    runDaemonCommand(betaRoot, ["daemon", "repo", "register", "--repo-id", "beta", "--root", betaRoot, "--user-root", userRoot, "--no-link", "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });

    const failed = runRawJsonMaybeFail(outsiderRoot, ["task", "list"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });

    assert.notEqual(failed.status, 0);
    assert.equal(failed.receipt.ok, false);
    assert.match(((failed.receipt.error as Record<string, unknown>).hint as string), /ha daemon repo register --repo-id <id> --root/u);
  });
});

test("daemon client --repo override targets a registered repo from a different cwd", () => {
  withTempRoot((workspaceRoot) => {
    const userRoot = path.join(workspaceRoot, "user-daemon");
    const alphaRoot = path.join(workspaceRoot, "alpha");
    const betaRoot = path.join(workspaceRoot, "beta");
    try {
      for (const rootDir of [alphaRoot, betaRoot]) {
        mkdirSync(rootDir, { recursive: true });
        runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: userRoot });
      }
      runDaemonCommand(alphaRoot, ["daemon", "repo", "register", "--repo-id", "alpha", "--root", alphaRoot, "--user-root", userRoot, "--no-link", "--json"], {
        HARNESS_DAEMON_USER_ROOT: userRoot
      });
      runDaemonCommand(betaRoot, ["daemon", "repo", "register", "--repo-id", "beta", "--root", betaRoot, "--user-root", userRoot, "--no-link", "--json"], {
        HARNESS_DAEMON_USER_ROOT: userRoot
      });

      const listed = runRawJson(betaRoot, ["--repo", "alpha", "task", "list"], {
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_IDLE_MS: "60000"
      });
      assert.equal(listed.ok, true);

      const status = runDaemonCommand(betaRoot, ["--repo", "alpha", "daemon", "status", "--user-root", userRoot, "--json"], {
        HARNESS_DAEMON_USER_ROOT: userRoot
      });
      assert.equal(status.repoId, "alpha");
      assert.equal(status.rootDir, realpathSync.native(alphaRoot));
      assert.deepEqual((status.repos as Array<{ repoId: string }>).map((repo) => repo.repoId), ["alpha", "beta"]);
    } finally {
      stopDaemonQuietly(betaRoot, userRoot);
    }
  });
});

test("daemon service reconciles registry register and unregister changes", async () => {
  await withTempRootAsync(async (workspaceRoot) => {
    const userRoot = path.join(workspaceRoot, "user-daemon");
    const alphaRoot = path.join(workspaceRoot, "alpha");
    const betaRoot = path.join(workspaceRoot, "beta");
    for (const rootDir of [alphaRoot, betaRoot]) {
      mkdirSync(rootDir, { recursive: true });
      runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: userRoot });
    }
    runDaemonCommand(alphaRoot, ["daemon", "repo", "register", "--repo-id", "alpha", "--root", alphaRoot, "--user-root", userRoot, "--no-link", "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });

    const listed = runRawJson(alphaRoot, ["task", "list"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_DAEMON_IDLE_MS: "15000"
    });
    assert.equal(listed.ok, true);
    assert.deepEqual(daemonStatusRepoIds(alphaRoot, userRoot, "alpha"), ["alpha"]);

    runDaemonCommand(betaRoot, ["daemon", "repo", "register", "--repo-id", "beta", "--root", betaRoot, "--user-root", userRoot, "--no-link", "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    await waitForCondition(() => daemonStatusRepoIds(alphaRoot, userRoot, "alpha").includes("beta"));

    runDaemonCommand(betaRoot, ["daemon", "repo", "unregister", "--repo-id", "beta", "--user-root", userRoot, "--no-link", "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    await waitForCondition(() => daemonStatusRepos(alphaRoot, userRoot, "alpha").find((repo) => repo.repoId === "beta")?.state === "detached");
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

function readCliPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(path.resolve("packages/cli/package.json"), "utf8")) as { readonly version?: unknown };
  assert.equal(typeof pkg.version, "string");
  return pkg.version;
}

function normalizeVolatileReceipt(receipt: Record<string, unknown>): Record<string, unknown> {
  const meta = isRecord(receipt.meta) ? { ...receipt.meta } : undefined;
  if (meta) delete meta.generatedAt;
  return {
    ...receipt,
    ...(meta ? { meta } : {})
  };
}

async function waitForCondition(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (check()) return;
    await delay(100);
  }
  assert.equal(check(), true);
}

function daemonStatusRepoIds(rootDir: string, userRoot: string, repoId: string): ReadonlyArray<string> {
  return daemonStatusRepos(rootDir, userRoot, repoId).map((repo) => repo.repoId);
}

function daemonStatusRepos(rootDir: string, userRoot: string, repoId: string): ReadonlyArray<{ readonly repoId: string; readonly state?: string }> {
  const status = runDaemonCommand(rootDir, ["--repo", repoId, "daemon", "status", "--user-root", userRoot, "--json"], {
    HARNESS_DAEMON_USER_ROOT: userRoot
  });
  return Array.isArray(status.repos) ? status.repos as Array<{ repoId: string; state?: string }> : [];
}

function initGitRepo(rootDir: string): void {
  const env = hermeticGitEnv(rootDir);
  execFileSync("git", ["-C", rootDir, "init", "-b", "master"], { stdio: "ignore", env });
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Harness Test"], { stdio: "ignore", env });
  execFileSync("git", ["-C", rootDir, "config", "user.email", "harness@example.test"], { stdio: "ignore", env });
}

function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: hermeticGitEnv(rootDir)
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
    "      - kind: unix-socket-owner-boundary",
    `        issuer: host:${hostname()}`,
    `        subject: ${process.getuid?.() ?? 0}`,
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    "  - roleId: maintainer",
    "    commandClasses: [repo-write, repo-read]",
    ""
  ].join("\n"), "utf8");
  commitPeopleRoster(harnessRoot);
}

function commitPeopleRoster(harnessRoot: string): void {
  if (!existsSync(path.join(harnessRoot, ".git"))) return;
  execFileSync("git", ["-C", harnessRoot, "add", "--", "people.yaml"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "chore: configure daemon people roster"], {
    stdio: "ignore",
    env: gitAuthorEnv(harnessRoot)
  });
}

function gitAuthorEnv(rootDir: string): NodeJS.ProcessEnv {
  const name = process.env.HARNESS_GIT_AUTHOR_NAME ?? "Harness Test";
  const email = process.env.HARNESS_GIT_AUTHOR_EMAIL ?? "harness@example.test";
  return {
    ...hermeticGitEnv(rootDir),
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? name,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? email
  };
}

function hermeticGitEnv(rootDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: path.join(rootDir, ".home"),
    GIT_CONFIG_GLOBAL: "/dev/null"
  };
}

function spawnDaemonCli(rootDir: string, args: ReadonlyArray<string>) {
  return spawn(process.execPath, [cliEntry, "--root", rootDir, ...args], {
    env: {
      ...process.env,
      HOME: path.join(rootDir, ".home"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DAEMON_USER_ROOT: defaultDaemonUserRoot(rootDir)
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function runDaemonCliProcess(
  rootDir: string,
  args: ReadonlyArray<string>,
  stdin = ""
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnDaemonCli(rootDir, args);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function listen(server: net.Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function receiptPath(receipt: Record<string, unknown>, role: string): string {
  const paths = receipt.paths;
  assert.equal(Array.isArray(paths), true);
  const value = (paths as ReadonlyArray<{ readonly role?: unknown; readonly path?: unknown }>)
    .find((entry) => entry.role === role)?.path;
  assert.equal(typeof value, "string");
  return value as string;
}
