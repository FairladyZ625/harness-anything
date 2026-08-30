// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetTlsCenter } from "../src/fleet/center.ts";
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

test(
  "production Fleet TLS entry sustains 3/10/32 Git-less edge processes across eight repos without duplicate writes",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await scaleFixture();
    t.after(() => fixture.close());
    const center = await fixture.center();
    for (const count of [3, 10, 32]) {
      const clients = fixture.clients.splice(0, count),
        before = fixture.commitCounts(),
        results = await Promise.all(
          clients.map((client, index) => runChild(fixture, center.port, client, Math.floor(index / 8) * 120)),
        );
      assert.equal(results.length, count);
      assert.equal(
        results.every((result) => result.ok && result.gitAbsent && result.replica.outcome === "applied"),
        true,
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
      assert.equal(materializedCommits >= touchedRepos, true, evidence);
      assert.equal(materializedCommits <= count, true, evidence);
      if (count > touchedRepos)
        assert.equal(
          materializedCommits < count,
          true,
          `${count} writes must coalesce into fewer Git cuts; ${evidence}`,
        );
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
  },
);

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
  const host = await openDaemonHost({ daemonId: "fleet-scale", userRoot }),
    clients: ScaleClient[] = [],
    assignments = new Map<string, FleetAssignmentRecord>();
  await host.attachmentsSettled();
  const setupCuts = new Map<string, { readonly opId: string; readonly assignment: FleetAssignmentRecord }>();
  for (let index = 0; index < 45; index += 1) {
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
      },
      auth = { transportKind: "fleet-tls" as const, assignmentBinding: assignment };
    assignments.set(assignment.assignmentId, assignment);
    const created = await host.run(repo.repoId, { kind: "task-create", taskId, title: taskId }, auth);
    assert.equal(created.outcome, "applied");
    await realizeTaskPlanFixture(
      repo.rootDir,
      String((created as Record<string, unknown>).packagePath),
      (planPath) => host.run(repo.repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
      taskId,
    );
    const started = await host.run(
      repo.repoId,
      { kind: "task-start", taskId, executionId: assignment.executionId },
      auth,
    );
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    setupCuts.set(repo.repoId, { opId: started.opId, assignment });
    clients.push({
      assignment,
      path: assignment.paths[0]!,
      body: `# ${taskId}\n\nbody-${index}\n`,
      label: `client-${index}`,
    });
  }
  await Promise.all(
    [...setupCuts].map(([repoId, value]) => waitForReceiptCommit(host, repoId, value.opId, value.assignment)),
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
    close: async () => {
      await owned.reclaim();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
// Edge children report their result on stdout, so both runners settle on `close`, not `exit`:
// `exit` fires when the process ends and can precede the last stdout chunk, which under a
// 32-way fan-out leaves the parent parsing a truncated line.
function runChild(
  fixture: Awaited<ReturnType<typeof scaleFixture>>,
  port: number,
  client: ScaleClient,
  startDelayMs: number,
): Promise<{
  ok: boolean;
  gitAbsent: boolean;
  repoId: string;
  startedAt: number;
  endedAt: number;
  center: { opId: string };
  replica: { outcome: string };
}> {
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
      label: client.label,
      startDelayMs,
    }),
  );
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
      if (code !== 0) reject(new Error(`edge ${client.label} exited ${code}: ${errors}`));
      else
        try {
          resolve(JSON.parse(output.trim()));
        } catch (error) {
          reject(error);
        }
    });
  });
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
