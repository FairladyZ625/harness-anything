// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext } from "node:test";
import { connect, type TLSSocket } from "node:tls";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { listenFleetTls, type FleetTlsCenter } from "../src/fleet/center.ts";
import { parseFleetFrame, serializeFleetFrame, type FleetFrameV1 } from "../src/fleet/contract.ts";
import {
  fleetHostWriterOptions,
  fleetLedgerRevision,
  fleetNodeOwners,
  waitForFleetPublication,
} from "./fleet-store.fixture.ts";
import { signInAt } from "./keycloak.fixtures.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
type FleetTestSubject = {
  nodeId: string;
  repoId: string;
  taskId: string;
  executionId: string;
  paths: readonly string[];
  viewId: string;
};

const replicaQuota = 64 * 1024 * 1024;

function reclaimer() {
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
  /** The runtime installations the center host discovers; an Agent installs only against an enabled instance. */
  centerRuntimes: readonly RuntimeInstallationWitness[] = [],
  mode: "local" | "remote-center" = "local",
) {
  // The product names a checkout by its resolved path; the fixture root is resolved once so every path derived
  // from it compares equal where the temporary directory is itself a symbolic link.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-fleet-one-"))),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user"),
    stateRoot = path.join(root, "state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt"),
    emptyPath = path.join(root, "empty-path"),
    owned = reclaimer();
  let ownerLookupDelayMs = 0,
    runtimeOutcomeFailures = 0,
    runtimeOutcomeFailureObserved: (() => void) | null = null,
    taskReleaseBarrier: { readonly started: () => void; readonly wait: Promise<void> } | null = null;
  const runtimeArchiveReceipts: Readonly<Record<string, unknown>>[] = [];
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  mkdirSync(emptyPath);
  initRepo(repo);
  writeFileSync(
    path.join(repo, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: fleet\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  git(repo, "add", "harness");
  git(repo, "commit", "-qm", "harness");
  registerDaemonRepo({ canonicalRoot: repo, repoId: "fleet-repo", mode, userRoot, createConvenienceLinks: false });
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
    host = await openDaemonHost({
      daemonId: "fleet-center",
      userRoot,
      ...(centerRuntimes.length ? { runtimeDiscover: () => [...centerRuntimes] } : {}),
    }),
    owners = await fleetNodeOwners({
      userRoot,
      owners: { "node-one": "person-owner", "node-two": "person-owner", "node-slow": "person-owner" },
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
  signInAt(userRoot, "person-owner");
  await host.attachmentsSettled();
  const subject: FleetTestSubject = {
      nodeId: "node-one",
      repoId: "fleet-repo",
      taskId: "task-fleet",
      executionId: "execution-fleet",
      paths,
      viewId: "node-one",
    },
    slowSubject: FleetTestSubject = {
      ...subject,
      nodeId: "node-slow",
      viewId: "node-slow",
    },
    auth = owners.auth(subject);
  const created = await host.run(subject.repoId, { kind: "task-create", taskId: subject.taskId, title: "Fleet" }, auth);
  assert.equal(created.outcome, "applied");
  await waitForFleetPublication(host, subject.repoId, created.opId, auth);
  await realizeTaskPlanFixture(
    repo,
    String((created as Record<string, unknown>).packagePath),
    (planPath) => host.run(subject.repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
    "Fleet",
  );
  const started = await host.run(
    subject.repoId,
    { kind: "task-start", taskId: subject.taskId, executionId: subject.executionId },
    auth,
  );
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  await waitForReceiptCommit(host, subject.repoId, started.opId, auth);
  return {
    root,
    repo,
    stateRoot,
    writerOptions: fleetHostWriterOptions(userRoot, ["fleet-repo"]),
    path: subject.paths[0]!,
    subject,
    slowSubject,
    auth,
    host,
    key,
    cert,
    certFile,
    emptyPath,
    track: owned.track,
    hold: owned.hold,
    owners,
    setOwner: (personId: string) => owners.reassign(subject.nodeId, personId),
    setOwnerLookupDelay: (value: number) => {
      ownerLookupDelayMs = value;
    },
    failNextRuntimeOutcome: () => {
      runtimeOutcomeFailures += 1;
      return new Promise<void>((resolve) => {
        runtimeOutcomeFailureObserved = resolve;
      });
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
    eventCount: () => fleetLedgerRevision(repo, "fleet-repo"),
    runtimeArchiveReceipts,
    center: (
      port?: number,
      loginAuthorityUrl = owners.url,
      verifyHuman?: Parameters<typeof listenFleetTls>[0]["verifyHuman"],
    ) =>
      owned.hold(
        listenFleetTls({
          host: {
            ...host,
            runtimeIngress: async (...args: Parameters<typeof host.runtimeIngress>) => {
              if (
                args[1].kind === "event" &&
                args[1].type === "runtime_session_outcome_observed" &&
                runtimeOutcomeFailures > 0
              ) {
                runtimeOutcomeFailures -= 1;
                runtimeOutcomeFailureObserved?.();
                runtimeOutcomeFailureObserved = null;
                throw Object.assign(new Error("injected center connection loss before runtime outcome"), {
                  code: "ECONNRESET",
                });
              }
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
          ...(port === undefined ? {} : { port }),
          ...fleetHostWriterOptions(userRoot, ["fleet-repo"]),
          key,
          cert,
          replicaDiskQuotaBytes: replicaQuota,
          ...(verifyHuman ? { verifyHuman } : {}),
          authenticate: (nodeId, credential) =>
            [subject.nodeId, slowSubject.nodeId].includes(nodeId) && credential === "machine-secret",
          loginAuthority: (nodeId) => ({
            url: loginAuthorityUrl,
            realm: "harness",
            clientId: `harness-node-${nodeId}`,
          }),
          nodeOwner: async (nodeId) => {
            if (ownerLookupDelayMs) await new Promise((resolve) => setTimeout(resolve, ownerLookupDelayMs));
            return owners.nodeOwner(nodeId);
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
  // Git ranks these four variables above every config file, so a caller's ambient identity would
  // override the one each fixture repository configures for itself; every fixture commit states
  // its author from the repository config, never from the environment the test host runs under.
  const env = { ...process.env };
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.GIT_COMMITTER_EMAIL;
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", env }).trim();
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
  return { request, raw, split, close: () => socket.destroy() };
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
export function runFaultChild(
  fixture: Awaited<ReturnType<typeof fleetFixture>>,
  config: Record<string, unknown>,
): Promise<{ code: number; output: string }> {
  const configFile = path.join(fixture.root, `fault-${Date.now()}-${Math.random()}.json`);
  writeFileSync(configFile, JSON.stringify(config));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dirname, "fixtures/fleet-edge-child.mjs"), configFile],
      { env: { ...process.env, PATH: fixture.emptyPath }, stdio: ["ignore", "pipe", "pipe"] },
    );
    fixture.track(() => child.kill("SIGKILL"));
    let output = "",
      errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      errors += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === null || ![0, 73, 74, 75].includes(code)) reject(new Error(`fault edge exited ${code}: ${errors}`));
      else resolve({ code, output });
    });
  });
}
