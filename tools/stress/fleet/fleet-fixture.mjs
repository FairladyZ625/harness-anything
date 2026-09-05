import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { openDaemonHost } from "../../../packages/daemon/src/daemon-host.ts";
import { listenFleetTls } from "../../../packages/daemon/src/fleet/center.ts";
import { runFleetReplicaPullClient, runFleetScheduleCommandClient } from "../../../packages/daemon/src/fleet/edge.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "../../../packages/daemon/test/repo-settings.fixture.ts";

const quotaBytes = 64 * 1024 * 1024;

export async function openFleetCampaignFixture(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-stress-s4-fleet-")),
    userRoot = path.join(root, "center-user"),
    stateRoot = path.join(root, "fleet-state"),
    writerStateRoot = path.join(root, "writer-state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt"),
    repos = (options.repoNames ?? ["alpha", "beta"]).map((name) => ({
      repoId: `stress-${name}`,
      rootDir: path.join(root, `repo-${name}`),
    })),
    assignments = repos.flatMap((repo) =>
      Array.from({ length: 8 }, (_value, index) => ({
        nodeId: `edge-${index + 1}`,
        assignmentId: `${repo.repoId}-schedule-${index + 1}`,
        repoId: repo.repoId,
        viewId: `${repo.repoId}-view-${index + 1}`,
        scope: {
          kind: "schedule",
          scheduleId: "campaign",
          paths: ["agents", "schedules"],
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
        actor: {
          principal: { personId: `operator-${index + 1}` },
          executor: { kind: "agent", id: `edge-${index + 1}` },
        },
      })),
    ),
    byId = new Map(assignments.map((assignment) => [assignment.assignmentId, assignment]));
  let center = null,
    clock = options.now ?? "2026-09-06T00:00:00.000Z";
  const children = new Set();
  try {
    for (const repo of repos) {
      initHarnessRepo(repo.rootDir, repo.repoId);
      registerDaemonRepo({
        canonicalRoot: repo.rootDir,
        repoId: repo.repoId,
        mode: "remote-center",
        userRoot,
        createConvenienceLinks: false,
      });
    }
    makeCertificate(keyFile, certFile);
    const host = await openDaemonHost({ daemonId: "stress-s4-center", userRoot, now: () => clock });
    await host.attachmentsSettled();
    for (const repo of repos) {
      const assignment = assignments.find((candidate) => candidate.repoId === repo.repoId);
      const installed = await host.run(
        repo.repoId,
        {
          kind: "agent-install",
          declaration: {
            schema: "agent-declaration/v1",
            id: "campaign-agent",
            name: "Campaign Agent",
            instructions: "Exercise the fleet schedule claim.",
            runtime_type: "codex",
          },
        },
        assignmentAuth(assignment),
      );
      if (installed.outcome !== "applied") throw new Error(`agent install failed for ${repo.repoId}`);
    }
    const startCenter = async (writerId) => {
      if (center) throw new Error("fleet center must be closed before takeover");
      center = await listenFleetTls({
        host,
        stateRoot,
        writerEpochStateRoot: writerStateRoot,
        writerId,
        hostname: options.bind,
        port: options.port,
        key: readFileSync(keyFile),
        cert: readFileSync(certFile),
        replicaDiskQuotaBytes: quotaBytes,
        now: () => clock,
        authenticate: (nodeId, credential) => credential === `credential-${nodeId}`,
        resolveAssignment: (assignmentId) => byId.get(assignmentId) ?? null,
      });
      return center;
    };
    const closeCenter = async () => {
      const current = center;
      center = null;
      await current?.close();
    };
    const peer = (assignment, overrides = {}) => ({
      hostname: "127.0.0.1",
      port: center.port,
      ca: readFileSync(certFile),
      servername: "localhost",
      nodeId: assignment.nodeId,
      credential: `credential-${assignment.nodeId}`,
      assignmentId: assignment.assignmentId,
      ...overrides,
    });
    return {
      root,
      repos,
      assignments,
      host,
      certFile,
      quotaBytes,
      setClock: (value) => {
        clock = value;
      },
      startCenter,
      closeCenter,
      assignment: (repoId, index) =>
        assignments.find((candidate) => candidate.repoId === repoId && candidate.nodeId === `edge-${index + 1}`),
      schedule: (assignment, opId, action, overrides = {}) =>
        runFleetScheduleCommandClient({
          ...peer(assignment, overrides),
          repoId: assignment.repoId,
          scheduleId: assignment.scope.scheduleId,
          opId,
          action,
        }),
      pull: (assignment, viewRoot, overrides = {}) =>
        runFleetReplicaPullClient({
          ...peer(assignment, overrides),
          viewRoot,
          diskQuotaBytes: quotaBytes,
        }),
      raceClaims: (selected, action) => raceClaimChildren(root, certFile, center.port, selected, action, children),
      close: async () => {
        for (const child of children) child.kill("SIGKILL");
        children.clear();
        await closeCenter();
        await host.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const child of children) child.kill("SIGKILL");
    await center?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function raceClaimChildren(root, certFile, port, assignments, action, children) {
  const runs = assignments.map((assignment, index) => {
    const childRoot = path.join(root, "claim-children", assignment.assignmentId);
    mkdirSync(childRoot, { recursive: true });
    const configFile = path.join(childRoot, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        host: "127.0.0.1",
        port,
        caFile: certFile,
        servername: "localhost",
        nodeId: assignment.nodeId,
        credential: `credential-${assignment.nodeId}`,
        assignmentId: assignment.assignmentId,
        repoId: assignment.repoId,
        scheduleId: assignment.scope.scheduleId,
        opId: `claim-race-${index + 1}`,
        action,
      }),
    );
    return claimChild(configFile, children);
  });
  await Promise.all(runs.map((run) => run.ready));
  for (const run of runs) run.release();
  return Promise.all(runs.map((run) => run.result));
}

function claimChild(configFile, children) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "schedule-claim-child.mjs"), configFile], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let buffered = "",
    errors = "",
    resolveReady,
    rejectReady;
  const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    }),
    result = new Promise((resolve, reject) => {
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const frame = JSON.parse(line);
          if (frame.event === "ready") resolveReady();
          if (frame.event === "result") resolve(frame.result);
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        errors += chunk;
      });
      child.on("error", (error) => {
        rejectReady(error);
        reject(error);
      });
      child.on("close", (code) => {
        children.delete(child);
        if (code === 0) return;
        const error = new Error(`claim child exited ${code}: ${errors}`);
        rejectReady(error);
        reject(error);
      });
    });
  return { ready, release: () => child.stdin.end("claim\n"), result };
}

function initHarnessRepo(rootDir, name) {
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  git(rootDir, "init", "-q", "-b", "main");
  git(rootDir, "config", "user.name", "Fleet Stress");
  git(rootDir, "config", "user.email", "fleet-stress@example.invalid");
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    `schema: harness-anything/v1\nname: ${name}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  writePeople(rootDir);
  git(rootDir, "add", "harness");
  git(rootDir, "commit", "-qm", "harness");
  git(rootDir, "remote", "add", "origin", rootDir);
  git(rootDir, "fetch", "-q", "origin", "main");
}

function writePeople(rootDir) {
  const ownerUid = process.getuid?.() ?? 0;
  writeFileSync(
    path.join(rootDir, "harness/people.yaml"),
    `${JSON.stringify(
      {
        schema: "harness-people/v1",
        people: [
          {
            personId: "fleet-stress",
            displayName: "Fleet Stress",
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
        roles: [{ roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] }],
      },
      null,
      2,
    )}\n`,
  );
}

function makeCertificate(keyFile, certFile) {
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
}

function assignmentAuth(assignment) {
  return { transportKind: "fleet-tls", assignmentBinding: assignment };
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
