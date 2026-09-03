// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetTlsCenter } from "../src/fleet/center.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

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

test("production Fleet TLS entry sustains 3/10/32 Git-less edge processes across eight repos without duplicate writes", async (t) => {
  const fixture = await scaleFixture();
  t.after(() => fixture.close());
  const center = await fixture.center();
  for (const count of [3, 10, 32]) {
    const clients = fixture.clients.splice(0, count),
      before = fixture.commitCounts(),
      children = await startChildrenAtWriteBarrier(fixture, center.port, clients),
      batch = fixture.beginBatch(clients.map((client) => client.assignment.repoId));
    for (const child of children) child.release();
    let results: ChildResult[];
    try {
      results = await Promise.all(children.map((child) => child.result));
    } finally {
      await batch.finish();
    }
    assert.equal(results.length, count);
    assert.equal(
      results.every((result) => result.ok && result.gitAbsent && result.replica.outcome === "applied"),
      true,
      JSON.stringify(results),
    );
    await Promise.all(
      results.map((result, index) =>
        waitForReceiptCommit(fixture.host, result.repoId, result.center.opId, clients[index]!.assignment),
      ),
    );
    const repoCuts = fixture
        .commitCounts()
        .map((row, index) => ({ repoId: row.repoId, commits: row.commits - before[index]!.commits })),
      materializedCommits = repoCuts.reduce((sum, row) => sum + row.commits, 0),
      touchedRepos = new Set(results.map((result) => result.repoId)).size,
      childWindows = results.map((result, index) => ({
        label: clients[index]!.label,
        repoId: result.repoId,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
      })),
      evidence = `Fleet coalescing evidence: ${JSON.stringify({ count, materializedCommits, touchedRepos, repoCuts, childWindows })}`;
    t.diagnostic(evidence);
    assert.equal(materializedCommits, touchedRepos, evidence);
    const intervalsOverlap = results.some((left, index) =>
      results
        .slice(index + 1)
        .some(
          (right) =>
            left.repoId !== right.repoId &&
            Math.max(left.startedAt, right.startedAt) < Math.min(left.endedAt, right.endedAt),
        ),
    );
    assert.equal(intervalsOverlap, true, "at least two repo transport/write windows must overlap");
    const readMs: number[] = [];
    for (const client of clients) {
      const started = performance.now(),
        shown = await fixture.host.run(
          client.assignment.repoId,
          { kind: "doc-show", path: client.path },
          { transportKind: "fleet-tls", assignmentBinding: client.assignment },
        );
      readMs.push(performance.now() - started);
      assert.equal(shown.evidence, client.body);
    }
    readMs.sort((a, b) => a - b);
    assert.ok(readMs[Math.ceil(readMs.length * 0.95) - 1]! < 2_000);
  }
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Fleet Test");
  git(rootDir, "config", "user.email", "fleet@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}
function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

function writePeopleFixture(rootDir: string): void {
  const ownerUid = process.getuid?.() ?? 0;
  writeFileSync(
    path.join(rootDir, "harness/people.yaml"),
    `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: "fleet-fixture", displayName: "Fleet Fixture", roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(ownerUid) }] }], roles: [{ roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] }] }, null, 2)}\n`,
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

type ScaleClient = { assignment: FleetAssignmentRecord; path: string; body: string; label: string };
type ChildResult = {
  ok: boolean;
  gitAbsent: boolean;
  repoId: string;
  startedAt: number;
  endedAt: number;
  center: { opId: string };
  replica: { outcome: string };
};
type ChildRun = { ready: Promise<void>; release: () => void; result: Promise<ChildResult> };
async function startChildrenAtWriteBarrier(
  fixture: Awaited<ReturnType<typeof scaleFixture>>,
  port: number,
  clients: readonly ScaleClient[],
): Promise<ChildRun[]> {
  const children: ChildRun[] = [];
  // Readiness is setup, not the scale assertion: serialize cold pulls so a loaded
  // runner cannot starve one wave. Every ready child remains alive, and all 32
  // write/replica windows are still released together below.
  for (const client of clients) {
    const child = runChild(fixture, port, client);
    children.push(child);
    await child.ready;
  }
  return children;
}
async function scaleFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-scale-")),
    userRoot = path.join(root, "user"),
    stateRoot = path.join(root, "state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt"),
    emptyPath = path.join(root, "empty-path"),
    owned = reclaimer();
  mkdirSync(emptyPath);
  const repos = Array.from({ length: 8 }, (_, index) => ({
    repoId: `fleet-r${index}`,
    rootDir: path.join(root, `repo-${index}`),
  }));
  for (const repo of repos) {
    mkdirSync(path.join(repo.rootDir, "harness"), { recursive: true });
    initRepo(repo.rootDir);
    writeFileSync(
      path.join(repo.rootDir, "harness/harness.yaml"),
      `schema: harness-anything/v1\nname: ${repo.repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
    );
    writePeopleFixture(repo.rootDir);
    git(repo.rootDir, "add", "harness");
    git(repo.rootDir, "commit", "-qm", "harness");
    registerDaemonRepo({ canonicalRoot: repo.rootDir, repoId: repo.repoId, userRoot, createConvenienceLinks: false });
  }
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
  const stores = new Map<string, Parameters<NonNullable<Parameters<typeof openRepoCell>[0]["onStoreOpened"]>>[0]>(),
    host = await openDaemonHost({
      daemonId: "fleet-scale",
      userRoot,
      openCell: (input) =>
        openRepoCell({
          ...input,
          onStoreOpened: (store) => stores.set(input.repoId, store),
        }),
    }),
    clients: ScaleClient[] = [],
    assignments = new Map<string, FleetAssignmentRecord>();
  await host.attachmentsSettled();
  const drafts = Array.from({ length: 45 }, (_, index) => {
      const repo = repos[index % repos.length]!,
        taskId = `task-f${index}`,
        assignment: FleetAssignmentRecord = {
          nodeId: `node-${index}`,
          assignmentId: `assignment-${index}`,
          repoId: repo.repoId,
          taskId,
          executionId: `execution-${index}`,
          paths: [`tasks/${taskId}-${taskId}/notes.md`],
          viewId: `view-${index}`,
          expiresAt: "2099-01-01T00:00:00.000Z",
          actor: { principal: { personId: "fleet-owner" }, executor: { kind: "agent", id: `edge-${index}` } },
        };
      return { index, repo, taskId, assignment };
    }),
    repoIds = repos.map((repo) => repo.repoId),
    creationBatch = beginStoreBatch(stores, repoIds);
  let created: Array<(typeof drafts)[number] & { packagePath: string }>;
  try {
    created = await Promise.all(
      drafts.map(async (draft) => {
        const auth = { transportKind: "fleet-tls" as const, assignmentBinding: draft.assignment },
          receipt = await host.run(
            draft.repo.repoId,
            { kind: "task-create", taskId: draft.taskId, title: draft.taskId },
            auth,
          );
        assert.equal(receipt.outcome, "applied");
        return { ...draft, packagePath: String((receipt as Record<string, unknown>).packagePath) };
      }),
    );
  } finally {
    await creationBatch.finish();
  }
  const preparationBatch = beginStoreBatch(stores, repoIds);
  let prepared: Array<{ assignment: FleetAssignmentRecord; opId: string; client: ScaleClient }>;
  try {
    prepared = await Promise.all(
      created.map(async ({ assignment, index, packagePath, repo, taskId }) => {
        await realizeTaskPlanFixture(
          repo.rootDir,
          packagePath,
          (planPath) => host.run(repo.repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
          taskId,
        );
        const auth = { transportKind: "fleet-tls" as const, assignmentBinding: assignment },
          started = await host.run(
            repo.repoId,
            { kind: "task-start", taskId, executionId: assignment.executionId },
            auth,
          );
        assert.equal(started.outcome, "applied", JSON.stringify(started));
        return {
          assignment,
          opId: started.opId,
          client: {
            assignment,
            path: assignment.paths[0]!,
            body: `# ${taskId}\n\nbody-${index}\n`,
            label: `client-${index}`,
          },
        };
      }),
    );
  } finally {
    await preparationBatch.finish();
  }
  for (const value of prepared) {
    assignments.set(value.assignment.assignmentId, value.assignment);
    clients.push(value.client);
  }
  await Promise.all(
    prepared.map((value) => waitForReceiptCommit(host, value.assignment.repoId, value.opId, value.assignment)),
  );
  const key = readFileSync(keyFile),
    cert = readFileSync(certFile);
  return {
    root,
    host,
    certFile,
    emptyPath,
    clients,
    track: owned.track,
    center: () =>
      owned.hold(
        listenFleetTls({
          host,
          stateRoot,
          key,
          cert,
          replicaDiskQuotaBytes: replicaQuota,
          authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
          resolveAssignment: (assignmentId) => assignments.get(assignmentId) ?? null,
        }),
      ),
    commitCounts: () =>
      repos.map((repo) => ({
        repoId: repo.repoId,
        commits: Number(git(repo.rootDir, "rev-list", "--count", "refs/ha/canonical")),
      })),
    beginBatch: (repoIds: readonly string[]) => {
      return beginStoreBatch(stores, repoIds);
    },
    close: async () => {
      await owned.reclaim();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function beginStoreBatch(
  stores: ReadonlyMap<string, Parameters<NonNullable<Parameters<typeof openRepoCell>[0]["onStoreOpened"]>>[0]>,
  repoIds: readonly string[],
) {
  const batches = [...new Set(repoIds)].map((repoId) => {
    const store = stores.get(repoId),
      batch = store?.beginBulkWrite?.();
    assert.ok(batch, `repo ${repoId} must expose deterministic WAL batching`);
    return batch;
  });
  return { finish: () => Promise.all(batches.map((batch) => batch.finish())) };
}
// Edge children report their result on stdout, so both runners settle on `close`, not `exit`:
// `exit` fires when the process ends and can precede the last stdout chunk, which under a
// 32-way fan-out leaves the parent parsing a truncated line.
function runChild(fixture: Awaited<ReturnType<typeof scaleFixture>>, port: number, client: ScaleClient): ChildRun {
  const directory = path.join(fixture.root, "children", client.label);
  mkdirSync(directory, { recursive: true });
  const bodyFile = path.join(directory, "body"),
    configFile = path.join(directory, "config.json");
  writeFileSync(bodyFile, client.body);
  writeFileSync(
    configFile,
    JSON.stringify({
      port,
      caFile: fixture.certFile,
      servername: "localhost",
      nodeId: client.assignment.nodeId,
      credential: `secret-${client.assignment.nodeId}`,
      assignmentId: client.assignment.assignmentId,
      repoId: client.assignment.repoId,
      viewRoot: path.join(directory, "view"),
      path: client.path,
      bodyFile,
      retry: true,
      // Keep the aggregate retry budget near four minutes while allowing one loaded-runner
      // transport turn the same 30-second window used by the other Fleet integration fixtures.
      timeoutMs: 30_000,
      maxAttempts: 8,
      label: client.label,
      writeBarrier: true,
    }),
  );
  let resolveReady!: () => void,
    rejectReady!: (error: unknown) => void,
    release = (): void => {};
  const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    }),
    result = new Promise<ChildResult>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(import.meta.dirname, "fixtures/fleet-edge-child.mjs"), configFile],
        { env: { ...process.env, PATH: fixture.emptyPath }, stdio: ["pipe", "pipe", "pipe"] },
      );
      fixture.track(() => child.kill("SIGKILL"));
      release = () => child.stdin.end("write\n");
      let buffered = "",
        resultLine = "",
        errors = "",
        readySeen = false;
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const frame = JSON.parse(line) as { event?: string };
          if (frame.event === "write-ready") {
            readySeen = true;
            resolveReady();
          } else resultLine = line;
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        errors += chunk;
      });
      child.on("error", (error) => {
        if (!readySeen) rejectReady(error);
        reject(error);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          const error = new Error(`edge ${client.label} exited ${code}: ${errors}`);
          if (!readySeen) rejectReady(error);
          reject(error);
        } else
          try {
            resolve(JSON.parse(resultLine || buffered.trim()));
          } catch (error) {
            reject(error);
          }
      });
    });
  return { ready, release: () => release(), result };
}

async function waitForReceiptCommit(
  host: Awaited<ReturnType<typeof openDaemonHost>>,
  repoId: string,
  opId: string,
  assignment: FleetAssignmentRecord,
): Promise<void> {
  const deadline = performance.now() + 15_000,
    binding = { transportKind: "fleet-tls" as const, assignmentBinding: assignment };
  do {
    const receipt = await host.run(repoId, { kind: "receipt-show", opId }, binding);
    if (typeof receipt.commitSha === "string") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (performance.now() < deadline);
  throw new Error(`Git materialization did not publish ${opId} within the bounded wait`);
}
