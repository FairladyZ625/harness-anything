import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext } from "node:test";
import {
  fleetHostWriterOptions,
  fleetLedgerRevision,
  fleetNodeOwners,
  waitForFleetPublication,
} from "./fleet-store.fixture.ts";
import { openDaemonHost, type DaemonHost } from "../src/daemon-host.ts";
import { listenFleetTls, type FleetTlsCenter } from "../src/fleet/center.ts";
import { runFleetTaskCommandClient } from "../src/fleet/edge.ts";
import { randomUUID } from "node:crypto";
import {
  registerBootstrappedDaemonRepo as registerDaemonRepo,
  registerSettledBootstrappedDaemonRepo,
} from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const replicaQuota = 64 * 1024 * 1024;

// Same fixture discipline as fleet-transport.integration: every OS resource is
// owned by the fixture and reclaimed through t.after, because a `node --test`
// timeout suspends the body and never runs try/finally teardown.
export async function fleetNodeClaimFixture(
  t: TestContext,
  wrapRun?: (run: DaemonHost["run"]) => DaemonHost["run"],
  verifyHuman?: Parameters<typeof listenFleetTls>[0]["verifyHuman"],
  now?: () => string,
  loginAuthority?: Parameters<typeof listenFleetTls>[0]["loginAuthority"],
  seedCenterSettings = false,
  runtimeOptions: Pick<Parameters<typeof openDaemonHost>[0], "runtimeDiscover" | "runtimeLaunch"> = {},
  seedRepository?: (rootDir: string) => Promise<void>,
) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-lease-")),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user"),
    stateRoot = path.join(root, "state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt");
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  const git = (...args: readonly string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Lease Test");
  git("config", "user.email", "lease@example.invalid");
  git("commit", "--allow-empty", "-qm", "base");
  writeFileSync(
    path.join(repo, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: lease\nsettings: {}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  git("add", "harness");
  git("commit", "-qm", "harness");
  const registration = { canonicalRoot: repo, repoId: "lease-repo", userRoot, createConvenienceLinks: false } as const;
  if (seedCenterSettings) await registerSettledBootstrappedDaemonRepo(registration);
  else registerDaemonRepo(registration);
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
  await seedRepository?.(repo);
  const key = readFileSync(keyFile),
    cert = readFileSync(certFile);
  const owners = await fleetNodeOwners({
    userRoot,
    owners: { "node-one": "person-one", "node-two": "person-one", "center-node": "person-center" },
    repoIds: ["lease-repo"],
    localPersonId: "lease-owner",
  });
  const hosts: DaemonHost[] = [],
    centers: FleetTlsCenter[] = [];
  const openCenter = async (host: DaemonHost, port?: number): Promise<FleetTlsCenter> => {
    const center = await listenFleetTls({
      host,
      stateRoot,
      ...fleetHostWriterOptions(userRoot, ["lease-repo"]),
      key,
      cert,
      ...(port === undefined ? {} : { port }),
      replicaDiskQuotaBytes: replicaQuota,
      authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
      nodeOwner: owners.nodeOwner,
      nodeSubject: owners.nodeSubject,
      ...(verifyHuman ? { verifyHuman } : {}),
      ...(loginAuthority ? { loginAuthority } : {}),
    });
    centers.push(center);
    return center;
  };
  const openHost = async (): Promise<DaemonHost> => {
    const host = await openDaemonHost({
      ...runtimeOptions,
      daemonId: "lease-center",
      userRoot,
      ...(now ? { now } : {}),
    });
    const wrapped = wrapRun ? { ...host, run: wrapRun(host.run) } : host;
    hosts.push(wrapped);
    await host.attachmentsSettled();
    return wrapped;
  };
  const closeHost = async (host: DaemonHost): Promise<void> => {
    const at = hosts.indexOf(host);
    if (at >= 0) hosts.splice(at, 1);
    await host.close();
  };
  const closeFixtures = async () => {
    const centerResults = await Promise.allSettled(centers.splice(0).map((target) => target.close())),
      hostResults = await Promise.allSettled(hosts.splice(0).map((target) => target.close())),
      results = [...centerResults, ...hostResults];
    await owners.close();
    rmSync(root, { recursive: true, force: true });
    const unexpected = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(({ reason }) => reason)
      .filter((reason) => !isExpectedStaleWriterClose(reason));
    if (unexpected.length > 0) throw new AggregateError(unexpected, "fleet lease fixture cleanup failed");
  };
  t.after(closeFixtures);
  const host = await openHost(),
    center = await openCenter(host);
  const command = async (
    nodeId: string,
    action: Record<string, unknown>,
    waitMs = 5_000,
    taskId: string | null = typeof action.taskId === "string" ? action.taskId : null,
    accessToken?: string,
  ) => {
    const result = await runFleetTaskCommandClient({
      port: center.port,
      ca: cert,
      servername: "localhost",
      nodeId,
      credential: `secret-${nodeId}`,
      opId: randomUUID(),
      repoId: "lease-repo",
      taskId,
      action: action as never,
      waitMs,
      ...(accessToken ? { accessToken } : {}),
    });
    if (action.kind === "task-create" && result.outcome === "applied") {
      await waitForFleetPublication(host, "lease-repo", String(result.receipt?.opId), localAuthFixture());
      await realizeTaskPlanFixture(
        repo,
        String((result.receipt as Record<string, unknown>).packagePath),
        (planPath) => host.run("lease-repo", { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
        typeof action.title === "string" ? action.title : undefined,
      );
      // dec_2665E58BA5AE42E37793193748/CH1: fixture compute tasks receive explicit node assignments.
      const shown = await host.run(
        "lease-repo",
        { kind: "task-show", taskId: result.receipt.taskId },
        localAuthFixture(),
      );
      const assigned = await host.run(
        "lease-repo",
        {
          kind: "task-assign",
          taskId: result.receipt.taskId,
          nodeId,
          expectedVersion: JSON.parse(shown.evidence).revision,
        },
        localAuthFixture(),
      );
      if (assigned.outcome !== "applied") throw new Error(JSON.stringify(assigned));
    }
    return result;
  };
  const commandOn = (target: FleetTlsCenter, nodeId: string, action: Record<string, unknown>, waitMs = 5_000) =>
    runFleetTaskCommandClient({
      port: target.port,
      ca: cert,
      servername: "localhost",
      nodeId,
      credential: `secret-${nodeId}`,
      opId: randomUUID(),
      repoId: "lease-repo",
      taskId: typeof action.taskId === "string" ? action.taskId : null,
      action: action as never,
      waitMs,
    });
  const eventCount = (): number => fleetLedgerRevision(repo, "lease-repo");
  return {
    root,
    repo,
    stateRoot,
    writerEpochStateRoot: path.join(userRoot, "fleet"),
    host,
    center,
    owners,
    peer: (nodeId: string) => ({
      port: center.port,
      ca: cert,
      servername: "localhost",
      nodeId,
      credential: `secret-${nodeId}`,
      repoId: "lease-repo",
    }),
    command,
    commandOn,
    openHost,
    openCenter,
    closeHost,
    eventCount,
    close: closeFixtures,
  };
}

function isExpectedStaleWriterClose(reason: unknown): boolean {
  return (
    reason instanceof Error &&
    "code" in reason &&
    (reason as Error & { readonly code?: unknown }).code === "writer_epoch_stale"
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
