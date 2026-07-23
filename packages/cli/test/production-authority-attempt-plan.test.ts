// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  actorAxesBindingTokenDigestV2,
  decodeActorAxesBindingV2,
  decodeSemanticMutationEnvelopeV2,
  encodeActorAxesBindingV2,
  encodeSemanticMutationEnvelopeV2
} from "../../application/src/index.ts";
import { taskEntityId } from "../../kernel/src/index.ts";
import {
  attemptFromProgressAppendPlan,
  createDurableAuthorityBindingRuntimeV2,
  createProductionCanonicalAttemptCompiler,
  loadAuthorityProductionManifest,
  openAuthorityProductionKeyMaterial,
  openDurableAuthorityServiceState
} from "../../daemon/src/index.ts";
import { daemonActorAttribution } from "../src/composition/actor-attribution.ts";
import { productionAuthorityHostServices } from "../src/composition/production-authority-host-services.ts";
import {
  productionAuthorityActor,
  productionAuthorityConnection
} from "./helpers/production-authority-connection.ts";
import {
  createProductionAuthorityLifecycleFixture as createFixture
} from "./helpers/production-authority-lifecycle-fixture.ts";
import {
  createRepoWriteProceedingOutcomeV1,
  repoWriteActorStampDigestV1
} from "../../daemon/src/runtime/repo-write-outcome-schema.ts";

test("progress append planning is pure and activation validates exact durable recovery material", async () => {
  const fixture = createFixture();
  const state = openDurableAuthorityServiceState({
    serviceStateRoot: fixture.serviceRoot,
    repoId: "canonical"
  });
  try {
    const config = loadAuthorityProductionManifest(fixture.manifestPath).repos[0]!;
    const writerGeneration = config.authorityGeneration + 1;
    const keyMaterial = openAuthorityProductionKeyMaterial({
      config,
      serviceStateRoot: fixture.serviceRoot
    });
    const proofKeys = {
      resolve: (header: Parameters<ReturnType<typeof keyMaterial.keyStore.proofKeyResolver>["resolve"]>[0]) =>
        keyMaterial.keyStore.proofKeyResolver(keyMaterial.registry, 1_800_000_000_000).resolve(header)
    };
    const bindingRuntime = createDurableAuthorityBindingRuntimeV2({
      config,
      table: state.bindingState,
      proofKeys,
      nowMs: () => 1_800_000_000_000
    });
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000005",
      "00000000-0000-4000-8000-000000000006"
    ];
    const compiler = createProductionCanonicalAttemptCompiler({
      config,
      writerGeneration,
      keyStore: keyMaterial.keyStore,
      keyRegistry: keyMaterial.registry,
      bindingRuntime,
      context: productionAuthorityConnection(productionAuthorityActor()),
      authoredRoot: fixture.authoredRoot,
      hostServices: productionAuthorityHostServices,
      nowMs: () => 1_800_000_000_000,
      randomUuid: () => ids.shift()!,
      random128: () => Buffer.alloc(16, 0x44)
    });
    const actor = productionAuthorityActor();
    const compileInput = {
      command: {
        rootDir: fixture.repoRoot,
        action: {
          kind: "progress-append" as const,
          taskId: "task_A",
          text: "planned exactly once\n",
          dryRun: false
        }
      },
      attribution: daemonActorAttribution(actor, { kind: "agent" as const, id: "codex" }),
      currentSession: {
        runtime: "codex" as const,
        sessionId: "session-production",
        source: "manual" as const,
        detectedAt: "2026-07-23T00:00:00.000Z"
      },
      canonicalEntityId: taskEntityId("task_A")
    };
    const bindingLog = path.join(state.stateDirectory, "bindings.jsonl");
    const beforeEntries = JSON.stringify(state.bindingState.entries());
    const beforeBytes = existsSync(bindingLog) ? readFileSync(bindingLog) : null;

    const plan = await compiler.planProgressAppend(compileInput);

    assert.equal(JSON.stringify(state.bindingState.entries()), beforeEntries);
    assert.deepEqual(existsSync(bindingLog) ? readFileSync(bindingLog) : null, beforeBytes);
    assert.equal(plan.commandKind, "progress-append");
    assert.equal(plan.targetEntityId, taskEntityId("task_A"));
    assert.equal(plan.tokenId, "admission-production:00000000-0000-4000-8000-000000000001");
    assert.equal(plan.bindingId, "binding:00000000-0000-4000-8000-000000000002");
    assert.equal(plan.requestId, "authority-command:00000000-0000-4000-8000-000000000003");
    assert.equal(plan.plannedAtMs, "1800000000000");
    assert.equal(plan.expiresAtMs, "1800000300000");
    assert.match(plan.innerOpId, /:44444444444444444444444444444444$/u);
    assert.match(plan.semanticDigest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
    const exactAttempt = attemptFromProgressAppendPlan(plan);
    assert.equal(
      decodeActorAxesBindingV2(exactAttempt.presentationToken).claims.tokenId,
      plan.tokenId
    );
    const actorStamp = productionAuthorityActor();
    const proceeding = createRepoWriteProceedingOutcomeV1({
      repoId: config.repoId,
      workspaceId: config.workspaceId,
      generation: writerGeneration,
      outerOpId: "outer-progress-op",
      innerOpId: plan.innerOpId,
      authoritySemanticDigest: plan.semanticDigest,
      canonicalCommand: {
        commandName: "task.progress.append",
        actor: actorStamp,
        context: {},
        payload: {}
      },
      authenticatedContext: { actor: actorStamp },
      receiptSeed: {
        schema: "repo-write-receipt-seed/v1",
        renderer: "cli-command-receipt/v2@1",
        generatedAt: "2026-07-23T00:00:00.000Z",
        command: "task progress append",
        action: "append",
        actorStampDigest: repoWriteActorStampDigestV1(actorStamp)
      },
      recoveryContext: plan
    });
    const outerWitness = {
      outerOpId: proceeding.outerOpId,
      outerRequestDigest: proceeding.requestDigest,
      outerGeneration: proceeding.generation
    };
    await assert.rejects(
      compiler.activateRecoveryProgressAppend(plan, outerWitness),
      /AUTHORITY_ATTEMPT_RECOVERY_AUTHORIZATION_UNAVAILABLE/u
    );
    assert.equal(JSON.stringify(state.bindingState.entries()), beforeEntries);
    let staleActivationRan = false;
    const staleCompiler = createProductionCanonicalAttemptCompiler({
      config,
      writerGeneration,
      keyStore: keyMaterial.keyStore,
      keyRegistry: keyMaterial.registry,
      bindingRuntime,
      context: productionAuthorityConnection(actor),
      authoredRoot: fixture.authoredRoot,
      hostServices: productionAuthorityHostServices,
      runAuthorizedRecoveryPlan: async () => {
        staleActivationRan = true;
        throw new Error("DAEMON_GENERATION_FENCED");
      }
    });
    await assert.rejects(
      staleCompiler.activateRecoveryProgressAppend(plan, outerWitness),
      /DAEMON_GENERATION_FENCED/u
    );
    assert.equal(staleActivationRan, true);
    assert.equal(JSON.stringify(state.bindingState.entries()), beforeEntries);

    compiler.activatePlannedProgressAppend(plan);
    const afterFirstActivation = JSON.stringify(state.bindingState.entries());
    assert.equal(state.bindingState.entries().length, 1);
    compiler.activatePlannedProgressAppend(plan);
    assert.equal(JSON.stringify(state.bindingState.entries()), afterFirstActivation);
    assert.equal(await bindingRuntime.consumeOperation({
      tokenId: plan.tokenId,
      maximum: 1,
      opId: plan.innerOpId
    }), "consumed");
    const afterInnerConsume = JSON.stringify(state.bindingState.entries());
    compiler.activatePlannedProgressAppend(plan);
    assert.equal(JSON.stringify(state.bindingState.entries()), afterInnerConsume);
    const [bindingKey, bindingRow] = state.bindingState.entries<Record<string, unknown>>()[0]!;
    state.bindingState.put(bindingKey, {
      ...bindingRow,
      record: {
        ...(bindingRow.record as Record<string, unknown>),
        active: false
      }
    });
    const recoveryConfig = {
      ...config,
      revocationEpochs: {
        ...config.revocationEpochs,
        workspace: config.revocationEpochs.workspace + 1n
      }
    };
    const recoveryCompiler = createProductionCanonicalAttemptCompiler({
      config: recoveryConfig,
      writerGeneration,
      keyStore: keyMaterial.keyStore,
      keyRegistry: keyMaterial.registry,
      bindingRuntime,
      context: {
        ...productionAuthorityConnection(actor),
        channelBinding: {
          digest: Buffer.alloc(32, 0x77),
          source: "transport-observed"
        }
      },
      authoredRoot: fixture.authoredRoot,
      hostServices: productionAuthorityHostServices,
      runAuthorizedRecoveryPlan: async (witness, useDurableProceeding) => {
        assert.deepEqual(witness, outerWitness);
        return useDurableProceeding(proceeding);
      }
    });
    assert.throws(
      () => recoveryCompiler.activatePlannedProgressAppend(plan),
      /AUTHORITY_ATTEMPT_PLAN_TOKEN_CURRENT_ADMISSION_MISMATCH/u
    );
    await recoveryCompiler.activateRecoveryProgressAppend(plan, outerWitness);
    assert.equal(
      (state.bindingState.get<{ readonly record: { readonly active: boolean } }>(bindingKey))?.record.active,
      false
    );
    const staleWriterCompiler = createProductionCanonicalAttemptCompiler({
      config: recoveryConfig,
      writerGeneration: writerGeneration + 1,
      keyStore: keyMaterial.keyStore,
      keyRegistry: keyMaterial.registry,
      bindingRuntime,
      context: productionAuthorityConnection(actor),
      authoredRoot: fixture.authoredRoot,
      hostServices: productionAuthorityHostServices,
      runAuthorizedRecoveryPlan: async (_witness, useDurableProceeding) =>
        useDurableProceeding(proceeding)
    });
    await assert.rejects(
      staleWriterCompiler.activateRecoveryProgressAppend(plan, outerWitness),
      /AUTHORITY_ATTEMPT_RECOVERY_OUTER_BINDING_MISMATCH/u
    );
    const mismatchedProceeding = createRepoWriteProceedingOutcomeV1({
      ...proceeding,
      recoveryContext: { ...plan, semanticDigest: "0".repeat(64) }
    });
    const mismatchedRecoveryCompiler = createProductionCanonicalAttemptCompiler({
      config: recoveryConfig,
      writerGeneration,
      keyStore: keyMaterial.keyStore,
      keyRegistry: keyMaterial.registry,
      bindingRuntime,
      context: productionAuthorityConnection(actor),
      authoredRoot: fixture.authoredRoot,
      hostServices: productionAuthorityHostServices,
      runAuthorizedRecoveryPlan: async (_witness, useDurableProceeding) =>
        useDurableProceeding(mismatchedProceeding)
    });
    await assert.rejects(
      mismatchedRecoveryCompiler.activateRecoveryProgressAppend(plan, outerWitness),
      /AUTHORITY_ATTEMPT_RECOVERY_PLAN_BINDING_MISMATCH/u
    );
    const differentActor = { ...actorStamp, personId: "person_mallory" };
    const actorMismatchedProceeding = createRepoWriteProceedingOutcomeV1({
      repoId: config.repoId,
      workspaceId: config.workspaceId,
      generation: writerGeneration,
      outerOpId: proceeding.outerOpId,
      innerOpId: plan.innerOpId,
      authoritySemanticDigest: plan.semanticDigest,
      canonicalCommand: {
        ...proceeding.canonicalCommand,
        actor: differentActor
      },
      authenticatedContext: { actor: differentActor },
      receiptSeed: {
        ...proceeding.receiptSeed,
        actorStampDigest: repoWriteActorStampDigestV1(differentActor)
      },
      recoveryContext: plan
    });
    const actorMismatchedCompiler = createProductionCanonicalAttemptCompiler({
      config: recoveryConfig,
      writerGeneration,
      keyStore: keyMaterial.keyStore,
      keyRegistry: keyMaterial.registry,
      bindingRuntime,
      context: productionAuthorityConnection(actor),
      authoredRoot: fixture.authoredRoot,
      hostServices: productionAuthorityHostServices,
      runAuthorizedRecoveryPlan: async (_witness, useDurableProceeding) =>
        useDurableProceeding(actorMismatchedProceeding)
    });
    await assert.rejects(
      actorMismatchedCompiler.activateRecoveryProgressAppend(plan, {
        ...outerWitness,
        outerRequestDigest: actorMismatchedProceeding.requestDigest
      }),
      /AUTHORITY_ATTEMPT_RECOVERY_ACTOR_BINDING_MISMATCH/u
    );

    const secondPlan = await compiler.planProgressAppend(compileInput);
    const beforeTamper = JSON.stringify(state.bindingState.entries());
    const secondAttempt = attemptFromProgressAppendPlan(secondPlan);
    const secondToken = decodeActorAxesBindingV2(secondAttempt.presentationToken);
    const badProof = Uint8Array.from(secondToken.proof);
    badProof[0] = badProof[0]! ^ 0xff;
    assert.throws(
      () => compiler.activatePlannedProgressAppend({
        ...secondPlan,
        presentationTokenBase64url: Buffer.from(encodeActorAxesBindingV2({
          ...secondToken,
          proof: badProof
        })).toString("base64url")
      }),
      /TOKEN_PROOF_INVALID/u
    );
    assert.equal(JSON.stringify(state.bindingState.entries()), beforeTamper);

    const secondEnvelope = decodeSemanticMutationEnvelopeV2(secondAttempt.envelope);
    assert.throws(
      () => compiler.activatePlannedProgressAppend({
        ...secondPlan,
        envelopeBase64url: Buffer.from(encodeSemanticMutationEnvelopeV2({
          ...secondEnvelope,
          binding: {
            ...secondEnvelope.binding,
            admissionTokenRef: {
              tokenId: `${secondPlan.tokenId}:splice`,
              tokenDigest: actorAxesBindingTokenDigestV2(secondAttempt.presentationToken)
            }
          }
        })).toString("base64url")
      }),
      /(REQUEST_DIGEST_MISMATCH|AUTHORITY_ATTEMPT_PLAN_(DIGEST|TOKEN_REF)_MISMATCH)/u
    );
    assert.equal(JSON.stringify(state.bindingState.entries()), beforeTamper);
    assert.throws(
      () => compiler.activatePlannedProgressAppend({
        ...secondPlan,
        semanticDigest: "0".repeat(64)
      }),
      /AUTHORITY_ATTEMPT_PLAN_DIGEST_MISMATCH/u
    );
    assert.equal(JSON.stringify(state.bindingState.entries()), beforeTamper);
    assert.throws(
      () => compiler.activatePlannedProgressAppend({
        ...secondPlan,
        attribution: {
          ...secondPlan.attribution,
          actor: {
            ...secondPlan.attribution.actor,
            principal: { personId: "person_spliced" }
          }
        }
      }),
      /AUTHORITY_ATTEMPT_PLAN_ATTRIBUTION_MISMATCH/u
    );
    assert.equal(JSON.stringify(state.bindingState.entries()), beforeTamper);
    const wrongConfigCompiler = createProductionCanonicalAttemptCompiler({
      config: { ...config, workspaceId: "workspace-spliced" },
      writerGeneration,
      keyStore: keyMaterial.keyStore,
      keyRegistry: keyMaterial.registry,
      bindingRuntime,
      context: productionAuthorityConnection(actor),
      authoredRoot: fixture.authoredRoot,
      hostServices: productionAuthorityHostServices
    });
    assert.throws(
      () => wrongConfigCompiler.activatePlannedProgressAppend(secondPlan),
      /AUTHORITY_ATTEMPT_PLAN_TOKEN_CONFIG_MISMATCH/u
    );
    assert.equal(JSON.stringify(state.bindingState.entries()), beforeTamper);
  } finally {
    await state.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
