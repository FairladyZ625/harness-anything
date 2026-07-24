// harness-test-tier: integration
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createDaemonGenerationWitness,
  calculateDaemonArtifactIdentity,
  decodeRepoWriteCommandReceiptV2,
  defaultDaemonRuntimePolicy,
  encodeRepoWriteChildLaunchConfig,
  encodeRepoWriteProgressCommand,
  forkRepoWriteProcess,
  publishNextDaemonGeneration,
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
import {
  productionAuthorityActor,
  productionAuthorityConnection
} from "./helpers/production-authority-connection.ts";
import {
  createProductionAuthorityLifecycleFixture,
  fixtureGit
} from "./helpers/production-authority-lifecycle-fixture.ts";

const cutoverTest = process.platform === "win32" ? test.skip : test;
const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4";
const entrypoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const entrypointArtifactIdentity =
  calculateDaemonArtifactIdentity(entrypoint).identity;

cutoverTest("production child owns the only writer lock and restart lookup returns the exact receipt", async () => {
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
    assert.equal(
      JSON.stringify(decodeRepoWriteCommandReceiptV2(
        lookup.receipt,
        "$.lookup.receipt"
      )),
      JSON.stringify(receipt)
    );
  } finally {
    await first?.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
    await parentReader?.stop().catch(() => undefined);
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
