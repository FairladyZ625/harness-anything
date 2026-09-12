// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { connect, type TLSSocket } from "node:tls";
import { sha256Bytes } from "../../kernel/src/index.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetTlsCenter } from "../src/fleet/center.ts";
import {
  currentFleetProtocolVersion,
  parseFleetFrame,
  serializeFleetFrame,
  type FleetFrameV1,
} from "../src/fleet/contract.ts";
import { fleetHostWriterOptions } from "./fleet-store.fixture.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";

const replicaQuota = 64 * 1024 * 1024;

// Repo admission is dynamic host lifecycle state: the registry replaces a
// repo's row when it transitions warming→attached or detaches, and upload
// staging resolves the repo root per frame. These tests restates the row the
// same way the registry does and require every staging frame to consult the
// live host status instead of a row cached when the listener started.
test("upload staging follows a repo that attaches after the listener started", { timeout: 30_000 }, async (t) => {
  const fixture = await admissionFixture(t, "warming");
  const rejected = await uploadBegin(fixture, 1);
  assert.equal(rejected.schema, "fleet.error/v1");
  if (rejected.schema === "fleet.error/v1") assert.equal(rejected.code, "repo_unavailable");
  fixture.setRepoState(null);
  const admitted = await uploadBegin(fixture, 2);
  assert.equal(admitted.schema, "fleet.upload.ready/v1");
  if (admitted.schema === "fleet.upload.ready/v1") assert.equal(admitted.status, "receiving");
});

test("upload staging is refused once an attached repo detaches", { timeout: 30_000 }, async (t) => {
  const fixture = await admissionFixture(t, null);
  const admitted = await uploadBegin(fixture, 1);
  assert.equal(admitted.schema, "fleet.upload.ready/v1");
  fixture.setRepoState("unavailable");
  const rejected = await uploadBegin(fixture, 2);
  assert.equal(rejected.schema, "fleet.error/v1");
  if (rejected.schema === "fleet.error/v1") assert.equal(rejected.code, "repo_unavailable");
});

// `initialState` overrides the repo row the listener observes from its first
// status read; `setRepoState` restates the row afterward, mirroring how the
// host registry swaps entries on warming→attached and on detach.
async function admissionFixture(t: TestContext, initialState: "warming" | "unavailable" | null) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-admission-")),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user"),
    stateRoot = path.join(root, "state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt");
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  const git = (...args: readonly string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Admission Test");
  git("config", "user.email", "admission@example.invalid");
  git("commit", "--allow-empty", "-qm", "base");
  writeFileSync(
    path.join(repo, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: admission\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(repo, "harness/people.yaml"),
    `${JSON.stringify(
      {
        schema: "harness-people/v1",
        people: [
          {
            personId: "admission-owner",
            displayName: "Admission Owner",
            roles: ["owner"],
            credentials: [
              {
                kind: "unix-socket-owner-boundary",
                issuer: `host:${hostname()}`,
                subject: String(process.getuid?.() ?? 0),
              },
            ],
          },
        ],
        roles: [{ roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] }],
      },
      null,
      2,
    )}\n`,
  );
  git("add", "harness");
  git("commit", "-qm", "harness");
  registerDaemonRepo({ canonicalRoot: repo, repoId: "admission-repo", userRoot, createConvenienceLinks: false });
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
    opened = await openDaemonHost({ daemonId: "fleet-admission", userRoot });
  let repoState = initialState;
  const host = {
    ...opened,
    status: () => {
      const live = opened.status();
      return repoState === null ? live : { ...live, repos: live.repos.map((row) => ({ ...row, state: repoState })) };
    },
  };
  t.after(async () => {
    try {
      await opened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await opened.attachmentsSettled();
  const assignment: FleetAssignmentRecord = {
    nodeId: "node-one",
    assignmentId: "assignment-one",
    repoId: "admission-repo",
    taskId: "task-admission",
    executionId: "execution-admission",
    paths: ["tasks/task-admission-admission/notes.md"],
    viewId: "node-one-view",
    expiresAt: "2099-01-01T00:00:00.000Z",
    actor: { principal: { personId: "admission-owner" }, executor: { kind: "agent", id: "fleet-edge" } },
  };
  const centers: FleetTlsCenter[] = [];
  t.after(async () => {
    for (const center of centers.splice(0)) await center.close();
  });
  const center = await listenFleetTls({
    host,
    stateRoot,
    ...fleetHostWriterOptions(userRoot, ["admission-repo"]),
    key,
    cert,
    replicaDiskQuotaBytes: replicaQuota,
    authenticate: (nodeId, credential) => nodeId === "node-one" && credential === "machine-secret",
    resolveAssignment: (assignmentId) => (assignmentId === assignment.assignmentId ? assignment : null),
  });
  centers.push(center);
  return {
    center,
    cert,
    assignment,
    setRepoState: (state: "warming" | "unavailable" | null) => {
      repoState = state;
    },
  };
}

type AdmissionFixture = Awaited<ReturnType<typeof admissionFixture>>;

// One hello + one upload.begin over a fresh TLS connection; the probe number
// varies the content identity so every call stages a distinct upload.
async function uploadBegin(fixture: AdmissionFixture, probe: number): Promise<FleetFrameV1> {
  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const candidate = connect(
      { host: "127.0.0.1", port: fixture.center.port, ca: fixture.cert, servername: "localhost" },
      () => resolve(candidate),
    );
    candidate.once("error", reject);
  });
  let buffer = "";
  const replies: FleetFrameV1[] = [],
    waiters: Array<(frame: FleetFrameV1) => void> = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const frame = parseFleetFrame(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else replies.push(frame);
    }
  });
  try {
    const request = async (frame: FleetFrameV1): Promise<FleetFrameV1> => {
      socket.write(serializeFleetFrame(frame));
      return replies.length ? replies.shift()! : new Promise((resolve) => waiters.push(resolve));
    };
    const hello = await request({
      schema: "fleet.session.hello/v1",
      messageId: `admission-hello-${probe}`,
      protocolVersion: currentFleetProtocolVersion,
      nodeId: fixture.assignment.nodeId,
      credential: "machine-secret",
    });
    if (hello.schema === "fleet.error/v1") return hello;
    const body = Buffer.from(`admission-probe-${probe}`);
    return await request({
      schema: "fleet.upload.begin/v1",
      messageId: `admission-begin-${probe}`,
      assignmentId: fixture.assignment.assignmentId,
      content: { sha256: sha256Bytes(body), size: body.byteLength, mediaType: "text/plain; charset=utf-8" },
    });
  } finally {
    socket.destroy();
  }
}
