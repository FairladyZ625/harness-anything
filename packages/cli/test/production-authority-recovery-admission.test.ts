// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { taskEntityId } from "../../kernel/src/index.ts";
import {
  productionAuthorityActor,
  productionAuthorityConnection
} from "./helpers/production-authority-connection.ts";
import {
  createProductionAuthorityLifecycleFixture as createFixture,
  productionTuple,
  productionWriterRuntime as writerRuntime
} from "./helpers/production-authority-lifecycle-fixture.ts";
import { daemonActorAttribution } from "../src/composition/actor-attribution.ts";
import {
  createCliProductionAuthorityLifecycle as createProductionAuthorityLifecycle
} from "../src/composition/production-authority-lifecycle.ts";
import { openDurableAuthorityServiceState } from "@harness-anything/daemon";

test("new production writes do not wait for unrelated historical recovery", async () => {
  const fixture = createFixture();
  try {
    const seeded = openDurableAuthorityServiceState({
      serviceStateRoot: fixture.serviceRoot,
      repoId: "canonical"
    });
    await seeded.operationRegistry.put({
      workspaceId: "workspace-production",
      opId: "namespace-production:unrelated-pending-history",
      semanticDigest: "a".repeat(64),
      state: "PREPARED",
      authorityIntegrity: {
        schema: "authority-operation-integrity/v2",
        semanticRequestDigest: "a".repeat(64),
        semanticMutationSetDigest: "b".repeat(64),
        mutationRegistryVersion: 1,
        actorAxesBindingDigest: "c".repeat(64),
        canonicalMutationSet: {
          registryVersion: 1,
          mutations: [{
            entity: { registryVersion: 1, entityKind: "task", canonicalRef: "task/task_HISTORY" },
            action: { registryVersion: 1, action: "append" }
          }]
        }
      },
      recordedProtocol: {
        kind: "semantic-mutation-envelope/v2",
        schemaTuple: productionTuple()
      },
      canonicalRequestEnvelope: "durable-history-envelope"
    });
    await seeded.close();

    const lifecycle = createProductionAuthorityLifecycle({
      manifestPath: fixture.manifestPath,
      backgroundRecovery: true,
      daemonLogService: {
        append: async () => { throw new Error("TEST_UNRELATED_RECOVERY_DIAGNOSTIC_FAILED"); },
        list: async () => ({
          schema: "daemon-log-page/v1",
          entries: [],
          nextCursor: null,
          truncated: false,
          droppedCount: 0
        })
      }
    });
    const started = await lifecycle.startRepo(
      { repoId: "canonical", canonicalRoot: fixture.repoRoot },
      writerRuntime(fixture.authoredRoot)
    );
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) return;
    const actor = productionAuthorityActor();
    const receipt = await started.component.bindConnection(productionAuthorityConnection(actor)).submit({
      ingress: "generic",
      command: {
        rootDir: fixture.repoRoot,
        json: true,
        action: { kind: "progress-append", taskId: "task_A", text: "admitted during recovery\n", dryRun: false }
      },
      attribution: daemonActorAttribution(actor, { kind: "agent", id: "codex" }),
      currentSession: {
        runtime: "codex",
        sessionId: "session-recovery-admission",
        source: "manual",
        detectedAt: new Date().toISOString()
      },
      canonicalEntityId: taskEntityId("task_A")
    });

    assert.equal(receipt.tag, "COMMITTED", JSON.stringify(receipt));
    assert.match(
      readFileSync(path.join(fixture.authoredRoot, "tasks/task_A/progress.md"), "utf8"),
      /admitted during recovery/u
    );
    await lifecycle.stopAll("daemon-shutdown");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
