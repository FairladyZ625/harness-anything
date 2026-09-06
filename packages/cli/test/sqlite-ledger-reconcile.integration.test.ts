// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { DaemonHost } from "../../daemon/src/daemon-host.ts";
import { listenFleetTls } from "../../daemon/src/fleet/center.ts";
import { daemonStdioLogPath } from "../../daemon/src/lifecycle-log.ts";
import { openPersistentWriterEpoch } from "../../daemon/src/writer-epoch.ts";
import { localUserDaemonEndpoint } from "../src/daemon/client.ts";

const cli = path.resolve("packages/cli/src/index.ts");

test("local CLI accepts and reconciles the canonical generation-1 SQLite ledger", async (context) => {
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
    assert.equal(run(root, userRoot, ["daemon", "start", "--service"]).ok, true);
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
    const databasePath = path.join(root, ".harness/store/generations/1/ledger.sqlite"),
      snapshotPath = path.join(root, ".harness/store/imports/generation-0.snapshot.json");
    assert.equal(existsSync(databasePath), true, "init must activate the canonical SQLite ledger directly");
    assert.equal(existsSync(snapshotPath), true, "init must bind SQLite to its immutable source snapshot");
    for (const title of ["Initial SQLite", "After acceptance one", "After acceptance two"])
      waitForAcceptedReceipt(root, userRoot, run(root, userRoot, ["task", "create", "--title", title]));

    const authoredPath = "context/explicitly-submitted.md",
      authoredBody = "# Explicitly submitted\n\nThe daemon accepts this document through doc submit.\n";
    mkdirSync(path.join(root, "harness", "context"), { recursive: true });
    writeFileSync(path.join(root, "harness", authoredPath), authoredBody);
    waitForAcceptedReceipt(root, userRoot, run(root, userRoot, ["doc", "sync", "--submit", "--path", authoredPath]));

    const source = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
        readonly schema: string;
        readonly sourceDigest: string;
        readonly eventBytes: readonly string[];
        readonly objects: readonly unknown[];
      },
      counts = sqliteCounts(root),
      authoredRoot = path.join(root, "harness"),
      manifest = JSON.parse(git(authoredRoot, "show", "HEAD:events/segments/manifest.json")) as {
        readonly schema: string;
        readonly generation: number;
        readonly cut: { readonly repoId: string; readonly revision: number; readonly headDigest: string };
      };
    assert.equal(source.schema, "immutable-legacy-generation-snapshot/v1");
    assert.deepEqual(source.eventBytes, []);
    assert.deepEqual(source.objects, []);
    assert.ok(counts.events > 0, "accepted commands must extend the immutable empty prefix");
    assert.ok(counts.objects > 0, "accepted document claims must have content-object closure");
    assert.equal(manifest.schema, "sqlite-ledger-segment-manifest/v1");
    assert.equal(manifest.generation, 1);
    assert.equal(manifest.cut.repoId, repoId);
    assert.equal(manifest.cut.revision, counts.events);
    assert.match(manifest.cut.headDigest, /^sha256:[0-9a-f]{64}$/u);
    const db = new DatabaseSync(databasePath),
      originalLastRevision = Number(
        db.prepare("SELECT last_revision FROM command_outcome ORDER BY rowid LIMIT 1").get()!.last_revision,
      );
    try {
      db.prepare(
        "UPDATE command_outcome SET last_revision=last_revision+1 WHERE rowid=(SELECT MIN(rowid) FROM command_outcome)",
      ).run();
    } finally {
      db.close();
    }
    try {
      const divergent = report(run(root, userRoot, ["ledger", "reconcile", "--generation", "1"]));
      assert.equal(divergent.matches, false);
      assert.deepEqual(
        {
          metadataMatches: divergent.metadataMatches,
          rowDigestMatches: divergent.rowDigestMatches,
          outcomeMatches: divergent.outcomeMatches,
          objectMatches: divergent.objectMatches,
          gitReadbackMatches: divergent.gitReadbackMatches,
        },
        {
          metadataMatches: true,
          rowDigestMatches: true,
          outcomeMatches: false,
          objectMatches: true,
          gitReadbackMatches: true,
        },
      );
      assert.deepEqual(divergent.differences, ["command outcomes differ from immutable source import outcomes"]);
      context.diagnostic(JSON.stringify({ sqliteEvents: counts.events, differences: divergent.differences }));
    } finally {
      const repair = new DatabaseSync(databasePath);
      try {
        repair
          .prepare("UPDATE command_outcome SET last_revision=? WHERE rowid=(SELECT MIN(rowid) FROM command_outcome)")
          .run(originalLastRevision);
      } finally {
        repair.close();
      }
    }
    stop(root, userRoot);
    assert.equal(run(root, userRoot, ["daemon", "start", "--service"]).ok, true);
    const exact = report(run(root, userRoot, ["ledger", "reconcile", "--generation", "1"]));
    assert.equal(exact.schema, "sqlite-ledger-reconciliation/v2");
    assert.equal(exact.matches, true, JSON.stringify(exact));
    assert.deepEqual(
      {
        metadataMatches: exact.metadataMatches,
        rowDigestMatches: exact.rowDigestMatches,
        outcomeMatches: exact.outcomeMatches,
        objectMatches: exact.objectMatches,
        gitReadbackMatches: exact.gitReadbackMatches,
      },
      {
        metadataMatches: true,
        rowDigestMatches: true,
        outcomeMatches: true,
        objectMatches: true,
        gitReadbackMatches: true,
      },
    );
    assert.equal(source.sourceDigest, exact.sourceDigest);
    assert.deepEqual(exact.expected, { events: 0, outcomes: 0, objects: counts.objects });
    assert.deepEqual(exact.actual, counts);
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

      const sqliteBeforeStaleWrite = sqliteCounts(root),
        gitBeforeStaleWrite = git(authoredRoot, "rev-parse", "HEAD"),
        stale = invoke(root, userRoot, ["task", "create", "--title", "Rejected stale local write"]);
      assert.notEqual(stale.status, 0, `${stale.stderr}\n${JSON.stringify(stale.receipt)}`);
      assert.equal(stale.receipt.outcome, "op_rejected", JSON.stringify(stale.receipt));
      assert.equal(stale.receipt.code, "writer_epoch_stale", JSON.stringify(stale.receipt));
      assert.deepEqual(sqliteCounts(root), sqliteBeforeStaleWrite);
      assert.equal(git(authoredRoot, "rev-parse", "HEAD"), gitBeforeStaleWrite);
      context.diagnostic(
        JSON.stringify({
          localEpoch: localLease.epoch,
          centerEpoch: centerLease.epoch,
          staleWriteCode: stale.receipt.code,
          sqliteAfterStaleWrite: sqliteBeforeStaleWrite,
        }),
      );
    } finally {
      await center.close();
    }
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

function sqliteCounts(root: string): { readonly events: number; readonly outcomes: number; readonly objects: number } {
  const db = new DatabaseSync(path.join(root, ".harness/store/generations/1/ledger.sqlite"), { readOnly: true });
  try {
    return {
      events: Number(db.prepare("SELECT COUNT(*) AS count FROM event").get()!.count),
      outcomes: Number(db.prepare("SELECT COUNT(*) AS count FROM command_outcome").get()!.count),
      objects: countFiles(path.join(root, ".harness/store/generations/1/objects/sha256")),
    };
  } finally {
    db.close();
  }
}

function countFiles(root: string): number {
  if (!existsSync(root)) return 0;
  return readdirSync(root, { withFileTypes: true }).reduce(
    (count, entry) => count + (entry.isDirectory() ? countFiles(path.join(root, entry.name)) : 1),
    0,
  );
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

function waitForAcceptedReceipt(
  root: string,
  userRoot: string,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  assert.equal(receipt.status, "accepted_durable", JSON.stringify(receipt));
  assert.equal((receipt.acceptance as { readonly storage?: unknown } | null)?.storage, "sqlite");
  assert.equal(typeof receipt.opId, "string");
  const settled = run(root, userRoot, [
    "receipt",
    "show",
    String(receipt.opId),
    "--wait",
    "accepted_durable,projection_visible,git_verified,worktree_visible",
    "--timeout-ms",
    "10000",
  ]);
  assert.equal(settled.status, "accepted_durable", JSON.stringify(settled));
  assert.deepEqual(settled.wait, { state: "satisfied", unsatisfied: [] });
  for (const facet of ["projection", "git", "worktree"])
    assert.equal((settled[facet] as { readonly state?: unknown }).state, "verified", JSON.stringify(settled));
  return settled;
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
