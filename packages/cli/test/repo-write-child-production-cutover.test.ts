// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildDocSyncSubmitRequest,
  createDaemonGenerationWitness,
  calculateDaemonArtifactIdentity,
  decodeRepoWriteCommandReceiptV2,
  defaultDaemonRuntimePolicy,
  encodeRepoWriteChildLaunchConfig,
  encodeRepoWriteProgressCommand,
  forkRepoWriteProcess,
  localUserDaemonEndpoint,
  publishNextDaemonGeneration,
  requestLocalDaemonJsonRpc,
  readOrCreateDaemonMachineId,
  repoWriteChildLaunchConfigSchema,
  RepoWriteProcessSupervisor,
  type HarnessDaemonRuntime
} from "@harness-anything/daemon";
import {
  makeTaskHolderService,
  taskHolderActor
} from "@harness-anything/kernel";
import { daemonActorAttribution } from "../src/composition/actor-attribution.ts";
import { defaultCliAdapterProvider } from "../src/composition/adapter-registry.ts";
import { cliDaemonServiceHostServices } from "../src/composition/daemon-service-host-services.ts";
import { dispatchDocSyncSubmitToWriter } from "../../daemon/src/service/doc-sync-writer-dispatch.ts";
import {
  productionAuthorityActor,
  productionAuthorityConnection
} from "./helpers/production-authority-connection.ts";
import {
  createProductionAuthorityLifecycleFixture,
  fixtureGit
} from "./helpers/production-authority-lifecycle-fixture.ts";
import {
  pollUntil,
  runRawJsonAsync,
  runRawJsonMaybeFail,
  stopDaemon
} from "./helpers/daemon-cli.ts";

const cutoverTest = process.platform === "win32" ? test.skip : test;
const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4";
const entrypoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const entrypointArtifactIdentity =
  calculateDaemonArtifactIdentity(entrypoint).identity;

cutoverTest("production child reports semantic startup phases before READY", async (t) => {
  const fixture = createProductionAuthorityLifecycleFixture();
  seedLargeAuthorityStartupLog(fixture.serviceRoot);
  const userRoot = path.join(fixture.root, "daemon-user");
  const endpoint = path.join(userRoot, "daemon.sock");
  const startupProgress: Array<{ readonly phase: string; readonly workUnit: string }> = [];
  let transport: ReturnType<typeof forkRepoWriteProcess> | undefined;
  let supervisor: RepoWriteProcessSupervisor | undefined;
  try {
    const machineId = readOrCreateDaemonMachineId(userRoot);
    const generationRecord = publishNextDaemonGeneration({
      userRoot,
      endpointIdentity: endpoint,
      machineId,
      daemonInstanceId: "production-child-startup-progress-test"
    });
    supervisor = new RepoWriteProcessSupervisor({
      repoId: "canonical",
      generation: generationRecord.daemonGeneration,
      expectedArtifactIdentity: entrypointArtifactIdentity,
      spawn: () => {
        transport = forkRepoWriteProcess({
          modulePath: entrypoint,
          args: [
            "__repo-write-child",
            encodeRepoWriteChildLaunchConfig({
              schema: repoWriteChildLaunchConfigSchema,
              repoId: "canonical",
              canonicalRoot: fixture.repoRoot,
              authoredRoot: "harness",
              authorityManifest: fixture.manifestPath,
              userRoot,
              endpointIdentity: endpoint,
              machineId,
              generation: generationRecord.daemonGeneration,
              entrypointArtifactIdentity,
              runtimePolicy: defaultDaemonRuntimePolicy
            })
          ],
          cwd: fixture.repoRoot,
          env: { ...process.env, HARNESS_DAEMON_SERVER_HOST: "1" }
        });
        return transport;
      }
    });
    const starting = supervisor.start();
    assert.ok(transport);
    transport.onMessage((message) => {
      if (message.kind === "startup-progress") {
        startupProgress.push({ phase: message.phase, workUnit: message.workUnit });
      }
    });
    await starting;

    assert.deepEqual(startupProgress, [
      { phase: "artifact-identity", workUnit: "canonical" },
      { phase: "authority-manifest", workUnit: "canonical" },
      { phase: "conflict-marker-preflight", workUnit: "canonical" },
      { phase: "runtime-create", workUnit: "canonical" },
      { phase: "runtime-start", workUnit: "canonical" },
      { phase: "authority-lifecycle-compose", workUnit: "canonical" },
      { phase: "authority-start-repo", workUnit: "canonical" },
      {
        phase: "authority-start-repo",
        workUnit: "canonical:authority-state:operations.jsonl:2048"
      },
      {
        phase: "authority-start-repo",
        workUnit: "canonical:authority-state:operations.jsonl:4096"
      },
      { phase: "child-host-start", workUnit: "canonical" }
    ]);
    t.diagnostic(JSON.stringify({ startupProgress }));
  } finally {
    await supervisor?.stop().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function seedLargeAuthorityStartupLog(serviceRoot: string): void {
  const stateDirectory = path.join(
    serviceRoot,
    "authority",
    Buffer.from("canonical", "utf8").toString("base64url")
  );
  mkdirSync(stateDirectory, { recursive: true });
  const rows = Array.from({ length: 4_097 }, (_, index) => JSON.stringify({
    schema: "authority-service-state/v1",
    table: "operation",
    key: `workspace-startup-noise\u0000op-${index}`,
    value: {
      workspaceId: "workspace-startup-noise",
      opId: `op-${index}`,
      semanticDigest: "a".repeat(64),
      state: "RECEIVED"
    }
  }));
  writeFileSync(path.join(stateDirectory, "operations.jsonl"), `${rows.join("\n")}\n`);
}

cutoverTest("two signed production repos own distinct child locks and route through one daemon", { timeout: 60_000 }, async (t) => {
  const fixture = createProductionAuthorityLifecycleFixture({ repoIds: ["alpha", "beta"] });
  const userRoot = path.join(fixture.root, "daemon-user");
  const endpoint = localUserDaemonEndpoint(userRoot);
  const [alpha, beta] = fixture.repos;
  assert.ok(alpha && beta);
  const foreground = startProductionForegroundDaemon(fixture, alpha.repoRoot, "alpha", userRoot);
  try {
    await waitForProductionLocks(fixture, foreground, userRoot);

    const owners = fixture.repos.map((repo) => {
      const lockPath = path.join(repo.repoRoot, ".harness/locks/global.lock");
      assert.equal(existsSync(lockPath), true, lockPath);
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
      assert.equal(lock.ownerKind, "daemon");
      assert.equal(lock.repoId, repo.repoId);
      assert.equal(lock.canonicalRoot, realpathSync(repo.repoRoot));
      assert.equal(lock.userRoot, userRoot);
      assert.equal(lock.endpoint, endpoint);
      assert.equal(typeof lock.pid, "number");
      assert.equal(processCwd(lock.pid as number), realpathSync(repo.repoRoot));
      return lock;
    });
    assert.notEqual(owners[0]?.pid, owners[1]?.pid);

    const [alphaStatus, betaStatus] = await Promise.all([
      requestRepoStatus(alpha.repoRoot, userRoot, "alpha"),
      requestRepoStatus(beta.repoRoot, userRoot, "beta")
    ]);
    assert.equal(alphaStatus.requestedRepo && (alphaStatus.requestedRepo as Record<string, unknown>).state, "attached");
    assert.equal(betaStatus.requestedRepo && (betaStatus.requestedRepo as Record<string, unknown>).state, "attached");
    assert.deepEqual(
      (alphaStatus.repos as Array<Record<string, unknown>>).map((repo) => repo.repoId),
      ["alpha", "beta"]
    );
    t.diagnostic(JSON.stringify({
      repoCount: owners.length,
      owners: owners.map((owner) => ({ repoId: owner.repoId, pid: owner.pid, canonicalRoot: owner.canonicalRoot })),
      routes: [
        (alphaStatus.requestedRepo as Record<string, unknown>).repoId,
        (betaStatus.requestedRepo as Record<string, unknown>).repoId
      ]
    }));
  } finally {
    await stopDaemon(alpha.repoRoot, userRoot).catch(() => undefined);
    await foreground.result;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

cutoverTest("stale multi-repo locks recover serially and a second userRoot reports the complete conflict set without leaked children", { timeout: 60_000 }, async (t) => {
  const fixture = createProductionAuthorityLifecycleFixture({ repoIds: ["alpha", "beta"] });
  const firstUserRoot = path.join(fixture.root, "daemon-first");
  const secondUserRoot = path.join(fixture.root, "daemon-second");
  const [alpha] = fixture.repos;
  assert.ok(alpha);
  let foreground: ReturnType<typeof startProductionForegroundDaemon> | undefined;
  try {
    for (const repo of fixture.repos) writeStaleDaemonLock(repo.repoRoot, repo.repoId, firstUserRoot);
    foreground = startProductionForegroundDaemon(fixture, alpha.repoRoot, "alpha", firstUserRoot);
    await waitForProductionLocks(fixture, foreground, firstUserRoot);
    const firstOwners = fixture.repos.map((repo) =>
      JSON.parse(readFileSync(path.join(repo.repoRoot, ".harness/locks/global.lock"), "utf8")) as Record<string, unknown>);
    assert.equal(firstOwners.every((owner) => owner.userRoot === firstUserRoot), true);

    const second = runRawJsonMaybeFail(alpha.repoRoot, [
      "--repo", "alpha", "daemon", "start", "--foreground", "--user-root", secondUserRoot,
      "--authority-manifest", fixture.manifestPath
    ], productionDaemonEnv(secondUserRoot));
    assert.notEqual(second.status, 0);
    const diagnostic = JSON.stringify(second.receipt);
    assert.match(diagnostic, /DAEMON_REPO_LOCK_SET_CONFLICT/u);
    assert.match(diagnostic, /alpha@/u);
    assert.match(diagnostic, /beta@/u);
    assert.match(diagnostic, /daemon-repository-ownership-invariants/u);
    assert.doesNotMatch(diagnostic, /takeover.in.progress/iu);
    for (const [index, repo] of fixture.repos.entries()) {
      const owner = JSON.parse(readFileSync(path.join(repo.repoRoot, ".harness/locks/global.lock"), "utf8")) as Record<string, unknown>;
      assert.equal(owner.pid, firstOwners[index]?.pid);
      assert.equal(owner.userRoot, firstUserRoot);
    }
    assert.equal(existsSync(localUserDaemonEndpoint(secondUserRoot)), false);
    t.diagnostic(diagnostic);
  } finally {
    await stopDaemon(alpha.repoRoot, firstUserRoot).catch(() => undefined);
    await stopDaemon(alpha.repoRoot, secondUserRoot).catch(() => undefined);
    await foreground?.result;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

cutoverTest("production child restart preserves receipt identity and returns its visible successor", async () => {
  const fixture = createProductionAuthorityLifecycleFixture();
  const userRoot = path.join(fixture.root, "daemon-user");
  const endpoint = path.join(userRoot, "daemon.sock");
  let parentReader: HarnessDaemonRuntime | undefined;
  let first: RepoWriteProcessSupervisor | undefined;
  let restarted: RepoWriteProcessSupervisor | undefined;
  try {
    installProgressTask(fixture.authoredRoot);
    fixtureGit(fixture.authoredRoot, "add", ".");
    fixtureGit(fixture.authoredRoot, "commit", "-q", "-m", "seed progress pilot");
    const actor = productionAuthorityActor();
    const attribution = daemonActorAttribution(
      actor,
      { kind: "agent", id: "codex" }
    );
    await makeTaskHolderService({ rootInput: fixture.repoRoot }).claim({
      taskId,
      principal: taskHolderActor(
        attribution.taskHolderPrincipal,
        attribution.executor
      ),
      ttlMs: 60_000
    });
    const holderPath = path.join(
      fixture.repoRoot,
      `.harness/task-holders/${taskId}.json`
    );
    const holderBefore = readFileSync(holderPath, "utf8");

    const machineId = readOrCreateDaemonMachineId(userRoot);
    const generationRecord = publishNextDaemonGeneration({
      userRoot,
      endpointIdentity: endpoint,
      machineId,
      daemonInstanceId: "production-child-cutover-test"
    });
    const generationWitness = createDaemonGenerationWitness({
      userRoot,
      endpointIdentity: endpoint,
      machineId,
      daemonGeneration: generationRecord.daemonGeneration
    });
    parentReader = defaultCliAdapterProvider().createDaemonRuntime({
      rootDir: fixture.repoRoot,
      layoutOverrides: { authoredRoot: "harness" },
      writeOwnership: "reader",
      materializerPollMs: false,
      generationAxes: {
        machineId,
        daemonGeneration: generationRecord.daemonGeneration
      },
      generationWitness
    });
    const parentStatus = await parentReader.start();
    assert.equal(parentStatus.writeOwnership, "reader");
    assert.equal(parentStatus.lockPath, undefined);

    const spawnForGeneration = (daemonGeneration: number) =>
      forkRepoWriteProcess({
      modulePath: entrypoint,
      args: [
        "__repo-write-child",
        encodeRepoWriteChildLaunchConfig({
          schema: repoWriteChildLaunchConfigSchema,
          repoId: "canonical",
          canonicalRoot: fixture.repoRoot,
          authoredRoot: "harness",
          authorityManifest: fixture.manifestPath,
          userRoot,
          endpointIdentity: endpoint,
          machineId,
          generation: daemonGeneration,
          entrypointArtifactIdentity,
          runtimePolicy: defaultDaemonRuntimePolicy
        })
      ],
      cwd: fixture.repoRoot,
      env: {
        ...process.env,
        HARNESS_DAEMON_SERVER_HOST: "1"
      }
    });
    first = new RepoWriteProcessSupervisor({
      repoId: "canonical",
      generation: generationRecord.daemonGeneration,
      expectedArtifactIdentity: entrypointArtifactIdentity,
      spawn: () => spawnForGeneration(generationRecord.daemonGeneration)
    });
    await first.start();
    const lockPath = path.join(fixture.repoRoot, ".harness/locks/global.lock");
    assert.equal(existsSync(lockPath), true);
    assert.equal(
      JSON.parse(readFileSync(lockPath, "utf8")).pid,
      first.status().pid
    );

    const receipt = await first.submit(encodeRepoWriteProgressCommand({
      command: {
        rootDir: fixture.repoRoot,
        layoutOverrides: { authoredRoot: "harness" },
        json: true,
        action: {
          kind: "progress-append",
          taskId,
          text: "production child cutover\n",
          evidence: [],
          dryRun: false
        }
      },
      context: {
        actor,
        authorityConnection: productionAuthorityConnection(actor),
        currentSession: {
          runtime: "codex",
          sessionId: "session-production-child",
          source: "manual",
          detectedAt: "2026-07-24T00:00:00.000Z"
        },
        executor: { kind: "agent", id: "codex" }
      }
    }));
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(readFileSync(holderPath, "utf8"), holderBefore);
    assert.match(
      readFileSync(
        path.join(fixture.authoredRoot, `tasks/${taskId}/progress.md`),
        "utf8"
      ),
      /production child cutover/u
    );
    const recovery = receipt.details?.data?.repoWrite as {
      readonly outerOpId: string;
      readonly repoId: string;
      readonly generation: number;
    };
    assert.equal(recovery.repoId, "canonical");
    assert.equal(recovery.generation, generationRecord.daemonGeneration);

    await first.stop();
    first = undefined;
    assert.equal(existsSync(lockPath), false);
    const restartedGeneration = publishNextDaemonGeneration({
      userRoot,
      endpointIdentity: endpoint,
      machineId,
      daemonInstanceId: "production-child-cutover-restart"
    });
    assert.equal(
      restartedGeneration.daemonGeneration,
      generationRecord.daemonGeneration + 1
    );
    restarted = new RepoWriteProcessSupervisor({
      repoId: "canonical",
      generation: restartedGeneration.daemonGeneration,
      expectedArtifactIdentity: entrypointArtifactIdentity,
      spawn: () =>
        spawnForGeneration(restartedGeneration.daemonGeneration)
    });
    await restarted.start();
    const lookup = await restarted.lookup(recovery.outerOpId);
    assert.equal(lookup.state, "committed");
    if (lookup.state !== "committed") return;
    const visible = decodeRepoWriteCommandReceiptV2(lookup.receipt, "$.lookup.receipt");
    assert.equal(visible.command, receipt.command);
    assert.equal(visible.action, receipt.action);
    assert.equal(visible.meta.generatedAt, receipt.meta.generatedAt);
    assert.equal(visible.settlement?.receiptId, receipt.settlement?.receiptId);
    assert.equal(visible.settlement?.acceptedAt, receipt.settlement?.acceptedAt);
    assert.equal(visible.settlement?.acceptedCommitSha, receipt.settlement?.acceptedCommitSha);
    assert.equal(visible.settlement?.canonicalVisibility, "visible");
  } finally {
    await first?.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
    await parentReader?.stop().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

cutoverTest("doc-sync submits a working-tree file larger than the repo-writer IPC frame", async () => {
  const fixture = createProductionAuthorityLifecycleFixture();
  const userRoot = path.join(fixture.root, "daemon-user");
  const endpoint = path.join(userRoot, "daemon.sock");
  let supervisor: RepoWriteProcessSupervisor | undefined;
  try {
    mkdirSync(path.join(fixture.repoRoot, "tools"), { recursive: true });
    writeFileSync(
      path.join(fixture.repoRoot, "tools/write-road-registry.json"),
      readFileSync(fileURLToPath(new URL("../../../tools/write-road-registry.json", import.meta.url)))
    );
    const largeRelativePath = "tasks/task_A/artifacts/subject-logs/large.raw.jsonl";
    const largeAbsolutePath = path.join(fixture.authoredRoot, largeRelativePath);
    mkdirSync(path.dirname(largeAbsolutePath), { recursive: true });
    writeFileSync(largeAbsolutePath, `${"x".repeat(1_100_000)}\n`, "utf8");

    const actor = productionAuthorityActor();
    const request = buildDocSyncSubmitRequest(
      fixture.repoRoot,
      "canonical",
      [largeRelativePath],
      { kind: "agent", id: "codex" },
      cliDaemonServiceHostServices.docSync,
      {
        runtime: "codex",
        sessionId: "session-large-doc-sync",
        source: "manual",
        detectedAt: "2026-07-31T00:00:00.000Z"
      }
    );
    assert.ok(Buffer.byteLength(JSON.stringify(request)) > 1024 * 1024);

    const machineId = readOrCreateDaemonMachineId(userRoot);
    const generationRecord = publishNextDaemonGeneration({
      userRoot,
      endpointIdentity: endpoint,
      machineId,
      daemonInstanceId: "production-child-large-doc-sync-test"
    });
    supervisor = new RepoWriteProcessSupervisor({
      repoId: "canonical",
      generation: generationRecord.daemonGeneration,
      expectedArtifactIdentity: entrypointArtifactIdentity,
      spawn: () => forkRepoWriteProcess({
        modulePath: entrypoint,
        args: [
          "__repo-write-child",
          encodeRepoWriteChildLaunchConfig({
            schema: repoWriteChildLaunchConfigSchema,
            repoId: "canonical",
            canonicalRoot: fixture.repoRoot,
            authoredRoot: "harness",
            authorityManifest: fixture.manifestPath,
            userRoot,
            endpointIdentity: endpoint,
            machineId,
            generation: generationRecord.daemonGeneration,
            entrypointArtifactIdentity,
            runtimePolicy: defaultDaemonRuntimePolicy
          })
        ],
        cwd: fixture.repoRoot,
        env: { ...process.env, HARNESS_DAEMON_SERVER_HOST: "1" }
      })
    });
    await supervisor.start();

    const result = await dispatchDocSyncSubmitToWriter({
      rootDir: fixture.repoRoot,
      request,
      actor,
      executor: { kind: "agent", id: "codex" },
      authority: {
        available: true,
        context: productionAuthorityConnection(actor),
        assertActive: () => undefined
      },
      supervisor
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    // Publication commits with zero checkout, so it must not touch anything the
    // worktree already tracks. It also must not delete the author's own file:
    // the previous checkout-based publisher reached an empty `status --short`
    // only by removing large.raw.jsonl from the worktree after committing it,
    // which is the clobber this path exists to eliminate. Untracked generated
    // and authored paths therefore remain until the materializer merges.
    const trackedWorktreeChanges = fixtureGit(fixture.authoredRoot, "status", "--short")
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("??"));
    assert.deepEqual(trackedWorktreeChanges, []);
    assert.equal(existsSync(largeAbsolutePath), true, "publication must leave the authored file in place");
    assert.equal(fixtureGit(
      fixture.authoredRoot,
      "cat-file",
      "-s",
      `sessions/session-large-doc-sync:${largeRelativePath}`
    ), "1100001");
  } finally {
    await supervisor?.stop().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function installProgressTask(authoredRoot: string): void {
  writeFileSync(path.join(authoredRoot, "harness.yaml"), [
    "schema: harness-anything/v1",
    "project: production-child",
    "settings:",
    "  tasks:",
    "    leaseEnforcement: true",
    ""
  ].join("\n"));
  const taskRoot = path.join(authoredRoot, "tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "title: Production child",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref: ",
    "  titleSnapshot: Production child",
    "  url: ",
    "  bindingCreatedAt: 2026-07-24T00:00:00.000Z",
    `  bindingFingerprint: sha256:${"b".repeat(64)}`,
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "provenance:",
    "  - {runtime: \"human\", sessionId: \"fixture\", boundAt: \"2026-07-24T00:00:00.000Z\"}",
    "---",
    "",
    "# Production child",
    ""
  ].join("\n"));
}

function productionDaemonEnv(userRoot: string): Record<string, string> {
  return {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    HARNESS_DAEMON_REQUEST_TIMEOUT_MS: "35000",
    CODEX_THREAD_ID: "production-multi-repo-test"
  };
}

function startProductionForegroundDaemon(
  fixture: ReturnType<typeof createProductionAuthorityLifecycleFixture>,
  repoRoot: string,
  repoId: string,
  userRoot: string
): { readonly result: Promise<void>; readonly failure: () => unknown } {
  let failure: unknown;
  const result = runRawJsonAsync(repoRoot, [
    "--repo", repoId, "daemon", "start", "--foreground", "--user-root", userRoot,
    "--authority-manifest", fixture.manifestPath
  ], productionDaemonEnv(userRoot)).then(
    (receipt) => {
      if (receipt.ok !== true) failure = new Error(JSON.stringify(receipt));
    },
    (error: unknown) => {
      failure = error;
    }
  );
  return { result, failure: () => failure };
}

async function waitForProductionLocks(
  fixture: ReturnType<typeof createProductionAuthorityLifecycleFixture>,
  foreground: ReturnType<typeof startProductionForegroundDaemon>,
  userRoot: string
): Promise<void> {
  const state = await pollUntil(
    async () => {
      let status: Record<string, unknown> | undefined;
      try {
        status = await requestRepoStatus(fixture.repos[0]!.repoRoot, userRoot, fixture.repos[0]!.repoId);
      } catch {
        // The foreground daemon may not have activated its socket yet.
      }
      return { failure: foreground.failure(), status };
    },
    (candidate) => candidate.failure !== undefined
      || Array.isArray(candidate.status?.repos)
        && (candidate.status.repos as Array<Record<string, unknown>>).length === fixture.repos.length
        && (candidate.status.repos as Array<Record<string, unknown>>).every((repo) => repo.state === "attached"),
    (state, error) => JSON.stringify({ state, error: String(error ?? "") }),
    { timeoutMs: 20_000 }
  );
  if (state.failure) throw state.failure;
}

async function requestRepoStatus(
  repoRoot: string,
  userRoot: string,
  repoId: string
): Promise<Record<string, unknown>> {
  const receipt = await requestLocalDaemonJsonRpc(
    repoRoot,
    "repo.daemon.status",
    { repo: { repoId } },
    1_000,
    { userRoot, allowLegacySocket: false }
  );
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  return ((receipt.details as Record<string, unknown>).data ?? {}) as Record<string, unknown>;
}

function writeStaleDaemonLock(repoRoot: string, repoId: string, userRoot: string): void {
  const lockPath = path.join(repoRoot, ".harness/locks/global.lock");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({
    pid: 999_999_999,
    hostname: hostname(),
    acquiredAt: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z",
    ownerToken: `stale-${repoId}`,
    ownerKind: "daemon",
    repoId,
    canonicalRoot: repoRoot,
    userRoot,
    endpoint: path.join(userRoot, "daemon.sock")
  }), "utf8");
}

function processCwd(pid: number): string {
  if (process.platform === "linux") return realpathSync(`/proc/${pid}/cwd`);
  if (process.platform === "darwin") {
    const output = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
    const cwd = output.split("\n").find((line) => line.startsWith("n"))?.slice(1);
    if (cwd) return realpathSync(cwd);
  }
  throw new Error(`process cwd inspection is unsupported on ${process.platform}`);
}
