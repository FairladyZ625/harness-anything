// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWriteReceipt, sha256Bytes } from "../../kernel/src/index.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { listenFleetTls, type FleetAssignmentRecord } from "../src/fleet/center.ts";
import { FleetRemoteError, runFleetReplicaPullClient, runFleetWriteClient } from "../src/fleet/edge.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

test(
  "independent pull atomically switches a quota-bounded view and exact ACK derives durable replica receipts",
  { timeout: 30_000 },
  async () => {
    const fixture = await replicaFixture(),
      edgeRoot = path.join(fixture.root, "edge"),
      quota = 16 * 1024 * 1024;
    let center = await fixture.center(quota);
    try {
      const bootstrap = await runFleetReplicaPullClient({
        ...fixture.peer(center.port, fixture.assignment),
        viewRoot: edgeRoot,
        diskQuotaBytes: quota,
      });
      assert.equal(bootstrap.replica.outcome, "applied");
      const preRegistration = center.replicaReceipt(
        fixture.preRegistrationOpId,
        fixture.assignment.nodeId,
        fixture.assignment.viewId,
        fixture.assignment.repoId,
      );
      assert.equal(preRegistration.outcome, "op_rejected");
      assert.equal(preRegistration.code, "replica_not_registered_at_revision");
      const body = "# Replica R2\n",
        write = await runFleetWriteClient({
          ...fixture.peer(center.port, fixture.assignment),
          channel: "replica",
          changes: [{ path: fixture.documentPath, body }],
        });
      assert.equal(write.center.outcome, "applied");
      assert.equal("transferId" in write.center, false);
      const pending = center.replicaReceipt(
        write.center.opId,
        fixture.assignment.nodeId,
        fixture.assignment.viewId,
        fixture.assignment.repoId,
      );
      assert.equal(pending.outcome, "pending");
      assert.equal(pending.proof?.ackCut, undefined);
      assert.deepEqual(pending.visibility, {
        kind: "replica",
        viewId: fixture.assignment.viewId,
      });
      const pulled = await runFleetReplicaPullClient({
        ...fixture.peer(center.port, fixture.assignment),
        viewRoot: edgeRoot,
        diskQuotaBytes: quota,
      });
      assert.equal(pulled.replica.outcome, "applied");
      assert.equal(pulled.replica.ackCut, write.center.revision);
      const applied = center.replicaReceipt(
        write.center.opId,
        fixture.assignment.nodeId,
        fixture.assignment.viewId,
        fixture.assignment.repoId,
      );
      assert.equal(applied.outcome, "applied");
      assert.equal(applied.proof?.ackCut, write.center.revision);
      assert.doesNotThrow(() => createWriteReceipt(pending));
      assert.doesNotThrow(() => createWriteReceipt(applied));
      const viewPath = path.join(edgeRoot, "repos", fixture.assignment.repoId, "views", fixture.assignment.viewId),
        currentPath = path.join(viewPath, "current.json"),
        current = JSON.parse(readFileSync(currentPath, "utf8")) as Record<string, unknown>;
      assert.equal("transferId" in current, false);
      assert.equal(
        existsSync(
          path.join(
            edgeRoot,
            "repos",
            fixture.assignment.repoId,
            "cas",
            "sha256",
            sha256Bytes(Buffer.from(body)).slice(0, 2),
            sha256Bytes(Buffer.from(body)),
          ),
        ),
        true,
      );
      assert.deepEqual(readdirSync(path.join(viewPath, ".staging")), []);
      const bodyTwo = `${body}lost ack\n`,
        second = await runFleetWriteClient({
          ...fixture.peer(center.port, fixture.assignment),
          channel: "replica",
          changes: [
            {
              path: fixture.documentPath,
              body: bodyTwo,
              baseBlobSha256: sha256Bytes(Buffer.from(body)),
            },
          ],
        });
      await assert.rejects(
        runFleetReplicaPullClient({
          ...fixture.peer(center.port, fixture.assignment),
          viewRoot: edgeRoot,
          diskQuotaBytes: quota,
          beforeAck: () => {
            throw new Error("drop ACK response path");
          },
        }),
        /drop ACK/u,
      );
      assert.equal(
        center.replicaReceipt(
          second.center.opId,
          fixture.assignment.nodeId,
          fixture.assignment.viewId,
          fixture.assignment.repoId,
        ).outcome,
        "pending",
      );
      await center.close();
      center = await fixture.center(quota);
      assert.equal(
        center.status().replicas.some((row) => row.viewId === fixture.assignment.viewId),
        true,
      );
      assert.equal(
        center.replicaReceipt(
          second.center.opId,
          fixture.assignment.nodeId,
          fixture.assignment.viewId,
          fixture.assignment.repoId,
        ).outcome,
        "pending",
      );
      const replay = await runFleetReplicaPullClient({
        ...fixture.peer(center.port, fixture.assignment),
        viewRoot: edgeRoot,
        diskQuotaBytes: quota,
      });
      assert.equal(replay.replica.outcome, "applied");
      assert.equal(
        center.replicaReceipt(
          second.center.opId,
          fixture.assignment.nodeId,
          fixture.assignment.viewId,
          fixture.assignment.repoId,
        ).outcome,
        "applied",
      );
      const other = await runFleetReplicaPullClient({
        ...fixture.peer(center.port, fixture.otherAssignment),
        viewRoot: edgeRoot,
        diskQuotaBytes: quota,
      });
      assert.equal(other.replica.outcome, "applied");
      assert.equal(
        center.replicaReceipt(
          second.center.opId,
          fixture.otherAssignment.nodeId,
          fixture.otherAssignment.viewId,
          fixture.otherAssignment.repoId,
        ).outcome,
        "op_rejected",
      );
      const status = center.status().replicas.find((row) => row.viewId === fixture.assignment.viewId)!;
      assert.equal(status.lagRevisions, 0);
      assert.equal(status.lagMs, 0);
      assert.match(status.centerEventAt!, /^2026|^20/u);
      assert.match(status.ackCutEventAt!, /^2026|^20/u);
      assert.equal(status.sendWindowBytes, 256 * 1024);
      assert.equal(status.sendQuotaBytes, 512 * 1024);
      assert.ok(
        readdirSync(path.join(edgeRoot, "repos", fixture.assignment.repoId, "views", fixture.assignment.viewId, "cuts"))
          .length <= 2,
      );
      await center.close();
      center = await fixture.center(undefined);
      await assert.rejects(
        runFleetReplicaPullClient({
          ...fixture.peer(center.port, fixture.assignment),
          viewRoot: edgeRoot,
          diskQuotaBytes: quota,
        }),
        (error: unknown) => error instanceof FleetRemoteError && error.code === "replica_quota_required",
      );
    } finally {
      await center.close().catch(() => undefined);
      await fixture.close();
    }
  },
);

async function replicaFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-pull-")),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user"),
    stateRoot = path.join(root, "state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt");
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Replica Test");
  git(repo, "config", "user.email", "replica@example.invalid");
  writeFileSync(
    path.join(repo, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: replica-r2\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writePeopleFixture(repo);
  git(repo, "add", "harness");
  git(repo, "commit", "-qm", "base");
  registerDaemonRepo({
    canonicalRoot: repo,
    repoId: "replica-r2",
    userRoot,
    createConvenienceLinks: false,
  });
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
  const host = await openDaemonHost({ daemonId: "replica-r2", userRoot });
  await host.attachmentsSettled();
  const assignment: FleetAssignmentRecord = {
      nodeId: "node-one",
      assignmentId: "assignment-one",
      repoId: "replica-r2",
      taskId: "task-r2",
      executionId: "execution-r2",
      paths: ["tasks/task-r2-r2/notes.md"],
      viewId: "view-one",
      expiresAt: "2099-01-01T00:00:00.000Z",
      actor: {
        principal: { personId: "person-one" },
        executor: { kind: "agent", id: "edge-one" },
      },
    },
    otherAssignment: FleetAssignmentRecord = {
      ...assignment,
      assignmentId: "assignment-other",
      viewId: "view-other",
    },
    auth = {
      transportKind: "fleet-tls" as const,
      assignmentBinding: assignment,
    },
    created = await host.run(
      assignment.repoId,
      { kind: "task-create", taskId: assignment.taskId, title: "Replica R2" },
      auth,
    );
  assert.equal(created.outcome, "applied");
  await realizeTaskPlanFixture(
    repo,
    String((created as Record<string, unknown>).packagePath),
    (planPath) => host.run(assignment.repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
    "Replica R2",
  );
  const started = await host.run(
    assignment.repoId,
    { kind: "task-start", taskId: assignment.taskId, executionId: assignment.executionId },
    auth,
  );
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  const key = readFileSync(keyFile),
    cert = readFileSync(certFile),
    assignments = new Map([
      [assignment.assignmentId, assignment],
      [otherAssignment.assignmentId, otherAssignment],
    ]);
  return {
    root,
    stateRoot,
    assignment,
    otherAssignment,
    documentPath: assignment.paths[0]!,
    preRegistrationOpId: created.opId,
    peer: (port: number, a: FleetAssignmentRecord) => ({
      port,
      ca: cert,
      nodeId: a.nodeId,
      credential: "machine-secret",
      assignmentId: a.assignmentId,
    }),
    center: (replicaDiskQuotaBytes: number | undefined) =>
      listenFleetTls({
        host,
        stateRoot,
        key,
        cert,
        replicaDiskQuotaBytes,
        authenticate: (nodeId, credential) => nodeId === assignment.nodeId && credential === "machine-secret",
        resolveAssignment: (assignmentId) => assignments.get(assignmentId) ?? null,
      }),
    close: async () => {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writePeopleFixture(rootDir: string): void {
  const ownerUid = process.getuid?.() ?? 0;
  writeFileSync(
    path.join(rootDir, "harness/people.yaml"),
    `${JSON.stringify(
      {
        schema: "harness-people/v1",
        people: [
          {
            personId: "replica-fixture",
            displayName: "Replica Fixture",
            roles: ["owner"],
            credentials: [
              {
                kind: "unix-socket-owner-boundary",
                issuer: `host:${hostname()}`,
                subject: String(ownerUid),
              },
            ],
          },
        ],
        roles: [
          { roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function localAuthFixture() {
  return {
    transportKind: "unix-socket" as const,
    unixSocketOwnerBoundary: {
      ownerUid: process.getuid?.() ?? 0,
      source: "unix-socket-filesystem-owner-boundary" as const,
    },
  };
}
function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  }).trim();
}
