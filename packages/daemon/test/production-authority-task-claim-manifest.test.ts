// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createDurableAuthorityBindingRuntimeV2,
  createProductionCanonicalAttemptCompiler,
  loadAuthorityProductionManifest,
  openAuthorityProductionKeyMaterial,
  openDurableAuthorityServiceState
} from "../src/index.ts";
import {
  executionDeclaration,
  sha256Text,
  taskHolderActor,
  type ExecutionRecord,
  type WriteOp
} from "../../kernel/src/index.ts";
import { daemonActorAttribution } from "../../cli/src/composition/actor-attribution.ts";
import { productionAuthorityHostServices } from "../../cli/src/composition/production-authority-host-services.ts";
import {
  productionAuthorityActor,
  productionAuthorityConnection
} from "../../cli/test/helpers/production-authority-connection.ts";
import {
  createProductionAuthorityLifecycleFixture
} from "../../cli/test/helpers/production-authority-lifecycle-fixture.ts";

test("production authority manifest accepts the atomic planned-task claim write set", async () => {
  const fixture = createProductionAuthorityLifecycleFixture();
  const state = openDurableAuthorityServiceState({
    serviceStateRoot: fixture.serviceRoot,
    repoId: "canonical"
  });
  try {
    const taskId = "task_01KYRN0B6HXCR6DQPXBA4YYP9D";
    const executionId = "exe_01KYRN0B6HXCR6DQPXBA4YYP9D";
    const plannedIndex = `---\ntask_id: ${taskId}\n  status: planned\n---\n`;
    const activeIndex = plannedIndex.replace("status: planned", "status: active");
    const taskPlan = "# Plan\n\nExercise the production claim authority manifest.\n";
    const taskRoot = path.join(fixture.authoredRoot, "tasks", taskId);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), plannedIndex);
    writeFileSync(path.join(taskRoot, "task_plan.md"), taskPlan);

    const config = loadAuthorityProductionManifest(fixture.manifestPath).repos[0]!;
    const keyMaterial = openAuthorityProductionKeyMaterial({
      config,
      serviceStateRoot: fixture.serviceRoot
    });
    const nowMs = 1_800_000_000_000;
    const bindingRuntime = createDurableAuthorityBindingRuntimeV2({
      config,
      table: state.bindingState,
      proofKeys: {
        resolve: (header) => keyMaterial.keyStore
          .proofKeyResolver(keyMaterial.registry, nowMs)
          .resolve(header)
      },
      nowMs: () => nowMs
    });
    const actor = productionAuthorityActor();
    const attribution = daemonActorAttribution(actor, { kind: "agent", id: "codex" });
    const currentSession = {
      runtime: "codex" as const,
      sessionId: "session-production-atomic-claim",
      source: "runtime" as const,
      detectedAt: "2026-07-30T00:00:00.000Z"
    };
    const execution: ExecutionRecord = {
      schema: "execution/v2",
      execution_id: executionId,
      task_ref: `task/${taskId}`,
      state: "active",
      primary_actor: taskHolderActor(
        attribution.taskHolderPrincipal,
        attribution.executor
      ),
      claimed_at: "2026-07-30T00:00:00.001Z",
      submitted_at: null,
      closed_at: null,
      session_bindings: [{
        binding_id: `primary:${currentSession.sessionId}`,
        session_ref: `session/${currentSession.sessionId}`,
        role: "primary",
        archive_status: "pending",
        attached_at: "2026-07-30T00:00:00.002Z",
        session: currentSession,
        capture_range: {
          range_id: `primary:${currentSession.sessionId}:2026-07-30T00:00:00.002Z`,
          coordinate: "timestamp",
          start_at: "2026-07-30T00:00:00.002Z",
          end_at: null,
          bounds: "inclusive"
        }
      }],
      outputs: [],
      submission: null
    };
    const operation: WriteOp = {
      opId: "op-production-atomic-claim",
      entityId: `entity/execution/${executionId}`,
      kind: "doc_write",
      payload: {
        entityDocument: {
          declaration: {
            kind: executionDeclaration.kind,
            storageForm: executionDeclaration.storageForm,
            rootResolver: executionDeclaration.rootResolver
          },
          identity: { taskId, executionId },
          body: executionDeclaration.documentCodec.encode(execution)
        },
        companionWrites: [{ taskId, path: "INDEX.md", body: activeIndex }],
        preconditions: [
          { taskId, path: `executions/${executionId}.md`, bodySha256: null },
          { taskId, path: "INDEX.md", bodySha256: sha256Text(plannedIndex) },
          { taskId, path: "task_plan.md", bodySha256: sha256Text(taskPlan) }
        ]
      }
    };
    const compiler = createProductionCanonicalAttemptCompiler({
      config,
      writerGeneration: config.authorityGeneration + 1,
      keyStore: keyMaterial.keyStore,
      keyRegistry: keyMaterial.registry,
      bindingRuntime,
      context: productionAuthorityConnection(actor),
      authoredRoot: fixture.authoredRoot,
      hostServices: productionAuthorityHostServices,
      nowMs: () => nowMs,
      randomUuid: () => "00000000-0000-4000-8000-000000000001",
      random128: () => Buffer.alloc(16, 0x45)
    });

    const attempt = await compiler.compile({
      ingress: "task-claim",
      command: {
        rootDir: fixture.repoRoot,
        action: { kind: "task-claim", taskId, execution: true }
      },
      attribution,
      currentSession,
      operation
    });

    assert.ok(attempt.requestId.length > 0);
    assert.ok(attempt.envelope.byteLength > 0);
  } finally {
    await state.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
