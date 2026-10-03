import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { connect, type TLSSocket } from "node:tls";
import {
  fleetHostWriterOptions,
  fleetLedgerRevision,
  fleetNodeOwners,
  waitForFleetPublication,
} from "./fleet-store.fixture.ts";
import { AccessAdminService } from "../src/access-admin-service.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetTlsCenter } from "../src/fleet/center.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { parseFleetFrame, serializeFleetFrame, type FleetFrameV1 } from "../src/fleet/contract.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

export const replicaQuota = 64 * 1024 * 1024;
// A `node --test` timeout suspends the test body at its current await and never resumes it, so `try…finally`
// teardown does not run on the timeout path. Every fixture therefore owns its OS resources and every test hands
// `fixture.close` to `t.after`, which node:test does run after a timeout. Sockets and edge children are dropped
// before the centers so `server.close()` is never left waiting on a peer that outlived the test.
export function reclaimer() {
  const closers: Array<() => void> = [],
    centers: FleetTlsCenter[] = [];
  return {
    track: (close: () => void) => {
      closers.push(close);
    },
    hold: async (opening: Promise<FleetTlsCenter>) => {
      const center = await opening;
      centers.push(center);
      return center;
    },
    reclaim: async () => {
      for (const close of closers.splice(0)) close();
      for (const center of centers.splice(0)) await center.close();
    },
  };
}
export async function fleetFixture(
  t: TestContext,
  paths: readonly string[] = ["tasks/task-fleet-fleet/notes.md"],
  closeoutProfile: "standard" | "strict" = "standard",
) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-one-")),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user"),
    stateRoot = path.join(root, "state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt"),
    emptyPath = path.join(root, "empty-path"),
    owned = reclaimer();
  let expiresAt = "2099-01-01T00:00:00.000Z",
    assignmentDelayMs = 0,
    authenticateBarrier: { readonly started: () => void; readonly wait: Promise<boolean> } | null = null;
  let taskReleaseBarrier: { readonly started: () => void; readonly wait: Promise<void> } | null = null;
  const runtimeArchiveReceipts: Readonly<Record<string, unknown>>[] = [];
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  mkdirSync(emptyPath);
  initRepo(repo);
  writeFileSync(
    path.join(repo, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: fleet\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n" +
      `settings:\n  closeout:\n    profile: ${closeoutProfile}\n`,
  );
  writePeopleFixture(repo);
  git(repo, "add", "harness");
  git(repo, "commit", "-qm", "harness");
  registerDaemonRepo({ canonicalRoot: repo, repoId: "fleet-repo", userRoot, createConvenienceLinks: false });
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
    host = await openDaemonHost({ daemonId: "fleet-center", userRoot }),
    owners = await fleetNodeOwners({
      userRoot,
      owners: { "node-one": "person-owner", "node-two": "person-owner" },
      repoIds: ["fleet-repo"],
    });
  t.after(async () => {
    try {
      await owned.reclaim();
    } finally {
      try {
        await host.close();
      } finally {
        await owners.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  await host.attachmentsSettled();
  const assignment: FleetAssignmentRecord = {
      nodeId: "node-one",
      assignmentId: "assignment-one",
      repoId: "fleet-repo",
      taskId: "task-fleet",
      executionId: "execution-fleet",
      paths,
      viewId: "node-one_task-fleet",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    // The healthy second node: unregistering node-one must leave its sessions untouched.
    peerAssignment: FleetAssignmentRecord = {
      ...assignment,
      nodeId: "node-two",
      assignmentId: "assignment-two",
      viewId: "node-two_task-fleet",
    },
    slowAssignment: FleetAssignmentRecord = {
      ...assignment,
      assignmentId: "assignment-slow",
      viewId: "node-one_task-fleet-slow",
    },
    machines = new Set([assignment.nodeId, peerAssignment.nodeId]),
    auth = owners.auth(assignment);
  const created = await host.run(
    assignment.repoId,
    { kind: "task-create", taskId: assignment.taskId, title: "Fleet" },
    auth,
  );
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFleetPublication(host, assignment.repoId, created.opId, auth);
  await realizeTaskPlanFixture(
    repo,
    String((created as Record<string, unknown>).packagePath),
    (planPath) => host.run(assignment.repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
    "Fleet",
  );
  const started = await host.run(
    assignment.repoId,
    { kind: "task-start", taskId: assignment.taskId, executionId: assignment.executionId },
    auth,
  );
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  await waitForReceiptCommit(host, assignment.repoId, started.opId, auth);
  return {
    root,
    repo,
    packagePath: String((created as Record<string, unknown>).packagePath),
    stateRoot,
    writerOptions: fleetHostWriterOptions(userRoot, ["fleet-repo"]),
    path: assignment.paths[0]!,
    assignment,
    peerAssignment,
    slowAssignment,
    auth,
    host,
    key,
    cert,
    certFile,
    emptyPath,
    track: owned.track,
    hold: owned.hold,
    userRoot,
    owners,
    setExpiry: (value: string) => {
      expiresAt = value;
    },
    setAssignmentDelay: (value: number) => {
      assignmentDelayMs = value;
    },
    blockTaskRelease: () => {
      let started!: () => void, release!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
          started = resolve;
        }),
        wait = new Promise<void>((resolve) => {
          release = resolve;
        });
      taskReleaseBarrier = { started, wait };
      return { started: startedPromise, release };
    },
    /** The administrator composition root for node removal, wired to one center the way the daemon host is. */
    admin: (center: FleetTlsCenter) =>
      new AccessAdminService(new OidcSessionService(userRoot), userRoot, {
        onNodeRemoved: (nodeId) => center.disconnectNode(nodeId),
      }),
    /** Parks the next hello inside `authenticate` until released, for handshake-race cases. */
    holdAuthenticate: () => {
      let started!: () => void, release!: (verdict: boolean) => void;
      const startedPromise = new Promise<void>((resolve) => {
          started = resolve;
        }),
        wait = new Promise<boolean>((resolve) => {
          release = resolve;
        }),
        barrier = {
          started,
          wait,
        };
      authenticateBarrier = barrier;
      return {
        started: startedPromise,
        release: (verdict: boolean) => {
          if (authenticateBarrier === barrier) authenticateBarrier = null;
          release(verdict);
        },
      };
    },
    eventCount: () => fleetLedgerRevision(repo, "fleet-repo"),
    runtimeArchiveReceipts,
    center: (diskQuotaBytes = replicaQuota, staleReplica = false) =>
      owned.hold(
        listenFleetTls({
          host: {
            ...host,
            replica: (repoId: string) => {
              const replica = host.replica(repoId);
              return staleReplica
                ? {
                    ...replica,
                    waitForCut: async (revision: number) => {
                      const cut = await replica.waitForCut(revision);
                      return { ...cut, headDigest: `sha256:${"f".repeat(64)}` };
                    },
                  }
                : replica;
            },
            runtimeIngress: async (...args: Parameters<typeof host.runtimeIngress>) => {
              const receipt = await host.runtimeIngress(...args);
              if (args[1].kind === "archive") runtimeArchiveReceipts.push(receipt);
              return receipt;
            },
            run: async (...args: Parameters<typeof host.run>) => {
              const barrier = taskReleaseBarrier;
              if (args[1].kind === "task-release" && barrier) {
                barrier.started();
                await barrier.wait;
                if (taskReleaseBarrier === barrier) taskReleaseBarrier = null;
              }
              return host.run(...args);
            },
          },
          stateRoot,
          ...fleetHostWriterOptions(userRoot, ["fleet-repo"]),
          key,
          cert,
          replicaDiskQuotaBytes: diskQuotaBytes,
          authenticate: async (nodeId, credential) => {
            const barrier = authenticateBarrier;
            if (barrier) {
              barrier.started();
              return barrier.wait;
            }
            return machines.has(nodeId) && credential === "machine-secret";
          },
          nodeOwner: owners.nodeOwner,
          resolveAssignment: async (assignmentId) => {
            if (assignmentDelayMs) await new Promise((resolve) => setTimeout(resolve, assignmentDelayMs));
            return assignmentId === assignment.assignmentId
              ? { ...assignment, expiresAt }
              : assignmentId === slowAssignment.assignmentId
                ? { ...slowAssignment, expiresAt }
                : assignmentId === peerAssignment.assignmentId
                  ? { ...peerAssignment, expiresAt }
                  : null;
          },
        }),
      ),
    close: async () => {
      await owned.reclaim();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Fleet Test");
  git(rootDir, "config", "user.email", "fleet@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}
export function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
export function writePeopleFixture(rootDir: string): void {
  const ownerUid = process.getuid?.() ?? 0;
  writeFileSync(
    path.join(rootDir, "harness/people.yaml"),
    `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: "fleet-fixture", displayName: "Fleet Fixture", roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(ownerUid) }] }], roles: [{ roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] }] }, null, 2)}\n`,
  );
}
export function localAuthFixture() {
  return {
    transportKind: "unix-socket" as const,
    unixSocketOwnerBoundary: {
      ownerUid: process.getuid?.() ?? 0,
      source: "unix-socket-filesystem-owner-boundary" as const,
    },
  };
}
export async function rawPeer(
  track: (close: () => void) => void,
  port: number,
  ca: Buffer,
  nodeId: string,
  credential: string,
) {
  const socket = await new Promise<TLSSocket>((resolve, reject) => {
      const candidate = connect({ host: "127.0.0.1", port, ca, servername: "localhost" }, () => resolve(candidate));
      candidate.once("error", reject);
    }),
    frames: FleetFrameV1[] = [],
    waiters: Array<(frame: FleetFrameV1) => void> = [];
  track(() => socket.destroy());
  // A center that cuts this session destroys the socket; observing that as an error here would
  // fail the test run, while the close event below is the signal cut cases assert on.
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const frame = parseFleetFrame(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    }
  });
  const next = () =>
      frames.length ? Promise.resolve(frames.shift()!) : new Promise<FleetFrameV1>((resolve) => waiters.push(resolve)),
    request = async (frame: FleetFrameV1) => {
      socket.write(serializeFleetFrame(frame));
      return next();
    },
    raw = async (frame: unknown) => {
      socket.write(`${JSON.stringify(frame)}\n`);
      return next();
    },
    split = async (frame: FleetFrameV1, marker: string) => {
      splitWrite(socket, frame, marker);
      return next();
    };
  const hello = await request({
    schema: "fleet.session.hello/v1",
    messageId: "hello",
    protocolVersion: { major: 1, minor: 0 },
    nodeId,
    credential,
  });
  if (hello.schema === "fleet.error/v1") throw new Error(hello.code);
  return { request, raw, split, receive: next, closed, close: () => socket.destroy() };
}
export function splitWrite(socket: TLSSocket, frame: FleetFrameV1, marker: string): void {
  const bytes = Buffer.from(serializeFleetFrame(frame)),
    markerOffset = bytes.indexOf(Buffer.from(marker));
  if (markerOffset < 0) throw new Error("split marker missing");
  socket.setNoDelay(true);
  socket.write(bytes.subarray(0, markerOffset + 1));
  setTimeout(() => socket.write(bytes.subarray(markerOffset + 1)), 100);
}
export async function waitForReceiptCommit(
  host: Awaited<ReturnType<typeof openDaemonHost>>,
  repoId: string,
  opId: string,
  binding: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2],
): Promise<void> {
  const deadline = performance.now() + 15_000;
  do {
    const receipt = await host.run(repoId, { kind: "receipt-show", opId }, binding);
    if (typeof receipt.commitSha === "string") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (performance.now() < deadline);
  throw new Error(`Git materialization did not publish ${opId} within the bounded wait`);
}
