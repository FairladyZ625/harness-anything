// W3-C class-A/class-B dual sync state machines: every test drives the real
// product entry points (runFleetEdgeTask / runFleetEdgeDocSync /
// runFleetEdgeConflictExit) against a live fleet TLS center, mirroring the
// lease-broker and transport integration fixtures. P0 semantics under test:
// non-holder task-doc pushes are rejected; a base conflict voids the whole
// transition; CENTER_REJECTED never silently overwrites; conflict staging
// lands base/local/center with three explicit exits; pull-blocked is reported
// on the dual axis instead of masquerading as synced.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fleetNodeOwners } from "./fleet-store.fixture.ts";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { runFleetEdgeTask } from "../src/fleet-edge-task.ts";
import { runFleetEdgeConflictExit, runFleetEdgeDocSync } from "../src/fleet-edge-doc-sync.ts";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { listenFleetTls, type FleetTlsCenter } from "../src/fleet/center.ts";
import { runFleetWriteClient } from "../src/fleet/edge.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";

// Idle WAL→Git materialization defaults to one hour (owner ruling 2026-08-31). These suites
// wait for materialized commits, so pin the test-local idle timer to a fast interval.
process.env.HARNESS_WAL_FLUSH_MS = "250";

// "The ledger must not move" is a statement about the merged WAL+Git event stream, not about
// Git commit counts: a background idle flush may materialize earlier events between two
// measurements without any new append. Read the flush-timing-invariant revision instead.
export function ledgerRevision(fixture: Fixture): number {
  return makeTaskEventReader({ repoId: "dual-repo", rootDir: path.join(fixture.root, "repo") }).read().revision;
}

const replicaQuota = 64 * 1024 * 1024,
  nodes = ["node-one", "node-two"] as const;
type NodeId = (typeof nodes)[number];
export async function dualSyncFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-dual-")),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user"),
    stateRoot = path.join(root, "state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt");
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  const git = (...args: readonly string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Dual Sync Test");
  git("config", "user.email", "dual@example.invalid");
  git("commit", "--allow-empty", "-qm", "base");
  writeFileSync(
    path.join(repo, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: dual\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  const ownerUid = process.getuid?.() ?? 0;
  git("add", "harness");
  git("commit", "-qm", "harness");
  registerDaemonRepo({ canonicalRoot: repo, repoId: "dual-repo", userRoot, createConvenienceLinks: false });
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
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const key = readFileSync(keyFile),
    cert = readFileSync(certFile),
    host = await openDaemonHost({ daemonId: "dual-center", userRoot }),
    owners = await fleetNodeOwners({
      userRoot,
      owners: Object.fromEntries(nodes.map((nodeId) => [nodeId, `person-${nodeId}`])),
      repoIds: ["dual-repo"],
      localPersonId: "person-fixture",
    });
  await host.attachmentsSettled();
  // Match daemon-fleet-center-start: local and edge ingress share the host lease.
  const writerEpochStateRoot = path.join(userRoot, "fleet"),
    writerAuthority = openPersistentWriterEpoch({ stateRoot: writerEpochStateRoot });
  const hostLease = writerAuthority.current("dual-repo");
  writerAuthority.close();
  assert.ok(hostLease);
  const center: FleetTlsCenter = await listenFleetTls({
    host,
    stateRoot,
    writerEpochStateRoot,
    writerEpochLease: (repoId) => {
      assert.equal(repoId, hostLease.repoId);
      return hostLease;
    },
    key,
    cert,
    replicaDiskQuotaBytes: replicaQuota,
    authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
    nodeOwner: owners.nodeOwner,
  });
  const edgeRoot = (nodeId: NodeId): string => path.join(root, `${nodeId}-edge`),
    workspace = (nodeId: NodeId): string => path.join(root, `${nodeId}-workspace`);
  for (const nodeId of nodes) mkdirSync(workspace(nodeId), { recursive: true });
  const channel = (nodeId: NodeId) => ({
    host: "127.0.0.1",
    port: center.port,
    caPath: certFile,
    servername: "localhost",
    nodeId,
    credential: `secret-${nodeId}`,
    principalId: owners.nodeOwner(nodeId),
    repoId: "dual-repo",
    viewRoot: edgeRoot(nodeId),
    quotaBytes: replicaQuota,
    workspaceRoot: workspace(nodeId),
  });
  const edgeTask = (nodeId: NodeId, action: Record<string, unknown>): Promise<Record<string, unknown>> =>
    runFleetEdgeTask({ payload: { ...channel(nodeId), action: action as never } });
  const edgeDocSync = (
    nodeId: NodeId,
    options: { readonly dryRun?: boolean; readonly paths?: readonly string[] } = {},
  ): Promise<Record<string, unknown>> => runFleetEdgeDocSync({ payload: { ...channel(nodeId), ...options } as never });
  const conflictExit = (
    nodeId: NodeId,
    action: "resolve" | "discard-local" | "overwrite-center",
    conflictId: string,
  ): Promise<Record<string, unknown>> =>
    runFleetEdgeConflictExit({ payload: { ...channel(nodeId), action, conflictId } as never });
  const rawWrite = (
    nodeId: NodeId,
    changes: readonly { readonly path: string; readonly body: string; readonly baseBlobSha256?: string | null }[],
    executionId: string | null = null,
  ) =>
    runFleetWriteClient({
      hostname: "127.0.0.1",
      port: center.port,
      ca: cert,
      servername: "localhost",
      nodeId,
      credential: `secret-${nodeId}`,
      repoId: "dual-repo",
      timeoutMs: 30_000,
      channel: "collaborator",
      executionId,
      changes,
    });
  const view = (nodeId: NodeId) => locateFleetMirrorView(edgeRoot(nodeId), "dual-repo");
  const worktree = (nodeId: NodeId, logical: string): string =>
    path.join(workspace(nodeId), "harness", ...logical.split("/"));
  const writeWorktree = (nodeId: NodeId, logical: string, body: string): void => {
    const target = worktree(nodeId, logical);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  const conflictsRoot = (nodeId: NodeId): string => path.join(workspace(nodeId), ".harness", "conflicts");
  const localAuth = {
    transportKind: "unix-socket" as const,
    unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" as const },
  };
  const centerRun = (action: Record<string, unknown>): Promise<Record<string, unknown>> =>
    host.run("dual-repo", action as never, localAuth) as Promise<Record<string, unknown>>;
  const waitPublished = async (opId: string): Promise<void> => {
    const deadline = performance.now() + 15_000;
    for (;;) {
      const shown = await centerRun({ kind: "receipt-show", opId });
      if (typeof shown.commitSha === "string") return;
      if (performance.now() >= deadline) throw new Error(`Git materialization did not publish ${opId}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const createTask = async (
    nodeId: NodeId,
    taskId: string,
    title: string,
    presetId?: string,
  ): Promise<{ readonly taskId: string; readonly packagePath: string }> => {
    const receipt = await edgeTask(nodeId, {
      kind: "task-create",
      taskId,
      title,
      ...(presetId ? { presetId } : {}),
    });
    assert.equal(receipt.ok, true, `task create failed: ${JSON.stringify(receipt).slice(0, 400)}`);
    const publication = await host.run(
      "dual-repo",
      {
        kind: "receipt-show",
        opId: String(receipt.opId),
        waitFor: ["git_verified", "worktree_visible"],
        timeoutMs: 5000,
      },
      localAuth,
    );
    assert.equal(publication.wait?.state, "satisfied", JSON.stringify(publication));
    const packagePath = String(receipt.packagePath),
      planPath = `${packagePath}/task_plan.md`;
    writeFileSync(path.join(repo, "harness", planPath), realizedTaskPlan(title));
    const submitted = await host.run("dual-repo", { kind: "doc-submit", paths: [planPath] }, localAuth);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitPublished(String(submitted.opId));
    for (const target of nodes) {
      const synced = await edgeDocSync(target);
      assert.equal(synced.ok, true, JSON.stringify(synced).slice(0, 500));
    }
    return { taskId: String(receipt.taskId), packagePath };
  };
  return {
    root,
    repo,
    host,
    center,
    channel,
    edgeTask,
    edgeDocSync,
    conflictExit,
    rawWrite,
    view,
    worktree,
    writeWorktree,
    conflictsRoot,
    createTask,
    centerRun,
    waitPublished,
    git,
    owners,
    close: async () => {
      await center.close();
      await host.close();
      await owners.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof dualSyncFixture>>;
