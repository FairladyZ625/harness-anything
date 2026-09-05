// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import type { DaemonHost } from "../../daemon/src/daemon-host.ts";
import { listenFleetTls } from "../../daemon/src/fleet/center.ts";
import { daemonStdioLogPath } from "../../daemon/src/lifecycle-log.ts";
import { openPersistentWriterEpoch } from "../../daemon/src/writer-epoch.ts";
import { localUserDaemonEndpoint } from "../src/daemon/client.ts";

const cli = path.resolve("packages/cli/src/index.ts");

test("local CLI seeds, follows, and reconciles the generation-1 SQLite shadow", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-cli-sqlite-reconcile-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "sqlite-cli-reconcile",
    keyFile = path.join(parent, "tls.key"),
    certFile = path.join(parent, "tls.crt");
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "SQLite Reconcile Test");
  git(root, "config", "user.email", "sqlite-reconcile@example.invalid");
  git(root, "commit", "--allow-empty", "-qm", "project root");
  try {
    const initialized = run(root, userRoot, [
      "init",
      "--repo-id",
      repoId,
      "--person-id",
      "person_zeyu",
      "--display-name",
      "Zeyu Li",
    ]);
    assert.equal(initialized.ok, true, JSON.stringify(initialized));
    assert.equal(run(root, userRoot, ["task", "create", "--title", "Before seed"]).outcome, "applied");

    const migrated = run(root, userRoot, ["migrate", "ledger", "--generation", "1"]);
    assert.equal(migrated.outcome, "applied", JSON.stringify(migrated));
    assert.equal(run(root, userRoot, ["task", "create", "--title", "After seed one"]).outcome, "applied");
    assert.equal(run(root, userRoot, ["task", "create", "--title", "After seed two"]).outcome, "applied");

    const authoredPath = "context/auto-settled.md",
      authoredBody = "# Auto settled\n\nThe daemon materializer authored this event.\n";
    mkdirSync(path.join(root, "harness", "context"), { recursive: true });
    writeFileSync(path.join(root, "harness", authoredPath), authoredBody);
    assert.equal(run(root, userRoot, ["task", "create", "--title", "Trigger authored settlement"]).outcome, "applied");
    await waitForDocEvent(root, repoId, authoredPath, daemonStdioLogPath(userRoot, "default"));

    const exact = report(run(root, userRoot, ["ledger", "reconcile", "--generation", "1"])),
      canonical = makeTaskEventReader({ repoId, rootDir: root }).read();
    assert.equal(exact.schema, "sqlite-ledger-reconciliation/v1");
    assert.equal(exact.matches, true, JSON.stringify(exact));
    assert.equal((exact.canonical as Record<string, unknown>).eventCount, canonical.events.length);
    assert.deepEqual(exact.revisionDifferences, []);
    assert.doesNotMatch(
      readFileSync(daemonStdioLogPath(userRoot, "default"), "utf8"),
      /writer epoch fence is unavailable/u,
    );
    context.diagnostic(JSON.stringify(exact));

    generateCertificate(keyFile, certFile);
    const writerEpochStateRoot = path.join(userRoot, "fleet"),
      transportStateRoot = path.join(parent, "fleet-transport"),
      observer = openPersistentWriterEpoch({ stateRoot: writerEpochStateRoot, holderId: "epoch-observer" }),
      localLease = observer.current(repoId);
    observer.close();
    assert.ok(localLease, "the local daemon must acquire a persistent repo writer epoch");
    const center = await listenFleetTls({
      host: centerHost(root, repoId),
      stateRoot: transportStateRoot,
      writerEpochStateRoot,
      key: readFileSync(keyFile),
      cert: readFileSync(certFile),
      writerId: "takeover-center",
      authenticate: () => false,
      resolveAssignment: () => null,
    });
    try {
      const centerObserver = openPersistentWriterEpoch({ stateRoot: writerEpochStateRoot, holderId: "observer" }),
        centerLease = centerObserver.current(repoId);
      centerObserver.close();
      assert.ok(centerLease);
      assert.ok(centerLease.epoch > localLease.epoch, JSON.stringify({ localLease, centerLease }));
      assert.equal(existsSync(path.join(transportStateRoot, "writer-epochs.json")), false);

      const canonicalBeforeStaleWrite = canonical.events.length,
        sqliteBeforeStaleWrite = sqliteEventCount(root),
        stale = invoke(root, userRoot, ["task", "create", "--title", "Rejected stale local write"]);
      assert.notEqual(stale.status, 0, `${stale.stderr}\n${JSON.stringify(stale.receipt)}`);
      assert.equal(stale.receipt.outcome, "op_rejected", JSON.stringify(stale.receipt));
      assert.equal(stale.receipt.code, "writer_epoch_stale", JSON.stringify(stale.receipt));
      assert.equal(makeTaskEventReader({ repoId, rootDir: root }).read().events.length, canonicalBeforeStaleWrite);
      assert.equal(sqliteEventCount(root), sqliteBeforeStaleWrite);
      context.diagnostic(
        JSON.stringify({
          localEpoch: localLease.epoch,
          centerEpoch: centerLease.epoch,
          staleWriteCode: stale.receipt.code,
          canonicalEventsAfterStaleWrite: canonicalBeforeStaleWrite,
          sqliteEventsAfterStaleWrite: sqliteBeforeStaleWrite,
        }),
      );
    } finally {
      await center.close();
    }

    const db = new DatabaseSync(path.join(root, ".harness/store/generations/1/ledger.sqlite"));
    try {
      db.prepare("UPDATE event SET event_json=event_json || ? WHERE revision=1").run(" ");
    } finally {
      db.close();
    }
    const divergent = report(run(root, userRoot, ["ledger", "reconcile", "--generation", "1"]));
    assert.equal(divergent.matches, false);
    assert.equal(divergent.firstDivergentRevision, 1);
    assert.deepEqual(
      (divergent.revisionDifferences as readonly Record<string, unknown>[]).map(({ revision, kind }) => ({
        revision,
        kind,
      })),
      [{ revision: 1, kind: "event_mismatch" }],
    );
    context.diagnostic(
      JSON.stringify({
        canonicalEvents: canonical.events.length,
        sqliteEvents: (exact.sqlite as Record<string, unknown>).eventCount,
        firstDivergentRevision: divergent.firstDivergentRevision,
      }),
    );
  } finally {
    stop(root, userRoot);
    rmSync(parent, { recursive: true, force: true });
  }
});

function report(receipt: Record<string, unknown>): Record<string, unknown> {
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  assert.equal(typeof receipt.evidence, "string");
  return JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
}

function run(root: string, userRoot: string, args: readonly string[]): Record<string, unknown> {
  const result = invoke(root, userRoot, args);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return result.receipt;
}

function invoke(
  root: string,
  userRoot: string,
  args: readonly string[],
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly receipt: Record<string, unknown>;
} {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env: environment(root, userRoot),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    receipt: result.stdout.trim() ? (JSON.parse(result.stdout) as Record<string, unknown>) : {},
  };
}

function sqliteEventCount(root: string): number {
  const db = new DatabaseSync(path.join(root, ".harness/store/generations/1/ledger.sqlite"), { readOnly: true });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS count FROM event").get()!.count);
  } finally {
    db.close();
  }
}

function centerHost(root: string, repoId: string): Parameters<typeof listenFleetTls>[0]["host"] {
  return {
    status: () => ({ repos: [{ repoId, rootDir: root, state: "attached" }] }) as ReturnType<DaemonHost["status"]>,
    settleMaterialization: async () => undefined,
    replica: () => {
      throw new Error("replica access is outside this takeover test");
    },
    run: async () => {
      throw new Error("remote writes are outside this takeover test");
    },
    read: async () => {
      throw new Error("remote reads are outside this takeover test");
    },
    runtimeIngress: async () => {
      throw new Error("runtime ingress is outside this takeover test");
    },
  } as Parameters<typeof listenFleetTls>[0]["host"];
}

function generateCertificate(keyFile: string, certFile: string): void {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
}

async function waitForDocEvent(root: string, repoId: string, target: string, daemonLog: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const event = makeTaskEventReader({ repoId, rootDir: root })
      .read()
      .events.find(
        (candidate) =>
          candidate.schema === "doc-event/v1" && candidate.payload.changes.some((change) => change.path === target),
      );
    if (event) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(
    `${target} did not produce an authored DocEvent\n${existsSync(daemonLog) ? readFileSync(daemonLog, "utf8") : "daemon log absent"}`,
  );
}

function stop(root: string, userRoot: string): void {
  spawnSync(process.execPath, [cli, "--root", root, "--json", "daemon", "stop"], {
    encoding: "utf8",
    env: environment(root, userRoot),
  });
}

function environment(root: string, userRoot: string): NodeJS.ProcessEnv {
  const { HARNESS_ACTOR: _actor, HARNESS_DAEMON_ENDPOINT: _endpoint, ...base } = process.env;
  return {
    ...base,
    HOME: path.join(root, ".home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_WAL_FLUSH_EVENTS: "1",
    HARNESS_WAL_FLUSH_MS: "250",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ENDPOINT:
      process.platform === "win32"
        ? localUserDaemonEndpoint(userRoot)
        : path.join("/tmp/harness-anything", path.basename(localUserDaemonEndpoint(userRoot))),
  };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
