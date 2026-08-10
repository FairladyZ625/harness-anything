// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  createDaemonAuthorityCommandSubmissionV2,
  authoritySubmissionWriteError,
  gateAuthoritySubmissionForRecovery,
  makeDaemonAuthorityWriteCoordinator
} from "../src/index.ts";
import {
  authorityCompileRejected,
  receiptToFlushReport
} from "../src/authority/authority-command-submission.ts";
import { gateCutoverAdmission } from "../src/authority/production/cutover-admission.ts";
import {
  defaultProductionRecoveryAdmissionTimeoutMs
} from "../src/authority/production/production-recovery-admission.ts";
import {
  createProductionPlannedCommandSubmission
} from "../src/authority/production/production-progress-append-submission.ts";
import {
  productionAuthorityCommandHasPurePlan
} from "../src/authority/production/production-authority-pure-command-plan.ts";
import type {
  ProductionAuthorityCommandPlanInput,
  ProductionCanonicalAttemptCompilerV2
} from "../src/authority/production/production-authority-attempt-compiler.ts";
import type {
  ProductionAuthorityAttemptPlanV1
} from "../src/authority/production/production-authority-attempt-plan.ts";
import { defaultRepoWriteRequestTimeoutMs } from "../src/runtime/repo-write-client-contract.ts";
import { runWithRepoWriteTelemetry } from "../src/runtime/repo-write-telemetry-context.ts";
import {
  encodeSemanticMutationEnvelopeV2,
  operationIdDiagnosticV2,
  semanticRequestDigestV2,
  type AuthorityRecoveryAttemptV2,
  type AuthoritySubmissionService,
  type ProtocolSchemaTupleV2
} from "@harness-anything/application";
import { v2Claims, v2Envelope } from "./authority-v2-fixtures.ts";

test("genuine authority journal failures remain JournalUnavailable and serialize without stacks", () => {
  const failure = new Error("EACCES: authority journal cannot append") as Error & { code: string };
  failure.code = "EACCES";
  const writeError = authoritySubmissionWriteError(failure);
  assert.deepEqual(writeError, {
    _tag: "JournalUnavailable",
    cause: {
      name: "Error",
      message: "EACCES: authority journal cannot append",
      code: "EACCES"
    }
  });
  assert.doesNotMatch(JSON.stringify(writeError), /stack/u);
});

test("WIP publication rejection keeps its stable public code and actionable reason", () => {
  const reason = "TASK_WIP_LIMIT_REACHED: full (30/30); run `ha task transition task_OLD planned`.";
  const error = authorityCompileRejected(new Error(reason));

  assert.equal(error.code, "task_wip_limit_reached");
  assert.equal(error.message, reason);
});

test("task-plan publication rejection keeps its stable public code and repair command", () => {
  const reason = "TASK_PLAN_PLACEHOLDER: replace task_plan.md, then retry `ha task transition task_NEW active`.";
  const error = authorityCompileRejected(new Error(reason));

  assert.equal(error.code, "task_plan_placeholder");
  assert.equal(error.message, reason);
});

test("return-to-idea publication rejection keeps its stable public code and cleanup commands", () => {
  const reason = "TASK_RETURN_TO_IDEA_BLOCKED: release task_OLD, then retire Execution exe_OLD.";
  const error = authorityCompileRejected(new Error(reason));

  assert.equal(error.code, "task_return_to_idea_blocked");
  assert.equal(error.message, reason);
});

test("recovery gate waits before admitting legacy, V2, and V2 recovery ingress", async () => {
  let submissions = 0;
  let releaseRecovery!: () => void;
  let recovering = true;
  const recovery = new Promise<void>((resolve) => {
    releaseRecovery = () => {
      recovering = false;
      resolve();
    };
  });
  const service = gateAuthoritySubmissionForRecovery({
    submit: async (envelope) => {
      submissions += 1;
      return {
        tag: "COMMITTED",
        workspaceId: envelope.workspaceId,
        opId: envelope.opId,
        semanticDigest: envelope.claimedDigest,
        commitSha: "c".repeat(40),
        receiptId: "receipt-legacy"
      };
    },
    submitV2: async (attempt) => {
      submissions += 1;
      const envelope = authorityCommandAttemptFixture().envelope;
      return {
        tag: "COMMITTED",
        workspaceId: "workspace-command-service",
        opId: operationIdDiagnosticV2(envelope.operationId),
        semanticDigest: "d".repeat(64),
        commitSha: "e".repeat(40),
        receiptId: Buffer.from(attempt.requestId).toString("hex")
      };
    },
    resumeV2: async (recoveryAttempt) => {
      submissions += 1;
      return {
        tag: "COMMITTED",
        workspaceId: recoveryAttempt.witness.workspaceId,
        opId: recoveryAttempt.witness.opId,
        semanticDigest: recoveryAttempt.witness.semanticDigest,
        commitSha: "f".repeat(40),
        receiptId: recoveryAttempt.attempt.requestId
      };
    },
    getOperation: async () => undefined
  }, async () => {
    if (!recovering) return undefined;
    await recovery;
    return undefined;
  });
  const legacyPromise = service.submit({
    workspaceId: "workspace-recovery",
    opId: "op-recovery",
    claimedDigest: "a".repeat(64),
    command: "task.append",
    operation: { opId: "op-recovery", entityId: "task/task_RECOVERY", kind: "progress_append", payload: { path: "progress.md", append: "x" } },
    delegationToken: "token",
    channelNonceDigest: "b".repeat(64),
    protocol: { wire: 1, event: 1, receipt: 1, digest: 1, commandRegistry: 1 }
  });
  const fixture = authorityCommandAttemptFixture();
  const v2Promise = service.submitV2!(fixture.attempt);
  const recoveryAttempt = authorityRecoveryAttemptFixture(fixture);
  const recoveryV2Promise = service.resumeV2!(recoveryAttempt);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submissions, 0);
  releaseRecovery();
  const [legacy, v2, recoveryV2] = await Promise.all([
    legacyPromise,
    v2Promise,
    recoveryV2Promise
  ]);

  assert.equal(legacy.tag, "COMMITTED");
  assert.equal(v2.tag, "COMMITTED");
  assert.equal(v2.opId, fixture.expectedOpId);
  assert.equal(recoveryV2.tag, "COMMITTED");
  assert.equal(recoveryV2.opId, fixture.expectedOpId);
  assert.equal(submissions, 3);
});

test("cutover admission preserves V2 recovery admission", async () => {
  let admitted = 0;
  let resumed = 0;
  const fixture = authorityCommandAttemptFixture();
  const service = gateCutoverAdmission({
    submit: async () => { throw new Error("unused"); },
    resumeV2: async (recovery) => {
      resumed += 1;
      return {
        tag: "INDETERMINATE",
        workspaceId: recovery.witness.workspaceId,
        opId: recovery.witness.opId,
        semanticDigest: recovery.witness.semanticDigest,
        reason: "fixture"
      };
    },
    getOperation: async () => undefined
  }, {
    runDuringOpenAdmission: async (operation) => {
      admitted += 1;
      return operation();
    }
  } as import("@harness-anything/application").AuthorityCutoverControlService);

  await service.resumeV2!(authorityRecoveryAttemptFixture(fixture));
  assert.equal(admitted, 1);
  assert.equal(resumed, 1);
});

test("planned durable submission accepts every specialized coordinator ingress with exact planned content", async (t) => {
  const cases = [
    {
      ingress: "provenance-session",
      command: { rootDir: "/fixture", action: { kind: "session-export", sessionId: "session-ingress" } },
      operation: { entityId: "entity/session/session-ingress", kind: "doc_write" }
    },
    {
      ingress: "decision-transition",
      ingressAdapter: "decision-transition",
      command: { rootDir: "/fixture", action: { kind: "decision-transition" } },
      operation: { entityId: "decision/dec_INGRESS", kind: "doc_write" }
    },
    {
      ingress: "task-claim",
      ingressAdapter: "task-claim",
      command: { rootDir: "/fixture", action: { kind: "task-claim" } },
      operation: { entityId: "task/task_INGRESS", kind: "doc_write" }
    },
    {
      ingress: "observed-write",
      ingressAdapter: "observed-write",
      command: { rootDir: "/fixture", action: { kind: "task-amend" } },
      operation: { entityId: "task/task_INGRESS", kind: "doc_write" }
    },
    {
      ingress: "script-ingest",
      command: { rootDir: "/fixture", action: { kind: "script-run" } },
      operation: { entityId: "task/task_INGRESS", kind: "script_ingest" }
    }
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.ingress, async () => {
      const attempt = authorityCommandAttemptFixture();
      const currentSession = {
        runtime: "codex" as const,
        sessionId: "session-ingress",
        source: "runtime" as const,
        detectedAt: "2026-07-24T00:00:00.000Z"
      };
      const expected = {
        command: fixture.command,
        attribution: {},
        currentSession,
        ...(fixture.ingressAdapter ? { ingressAdapter: fixture.ingressAdapter } : {})
      } as unknown as ProductionAuthorityCommandPlanInput;
      const submission = createProductionPlannedCommandSubmission({
        repoId: "canonical",
        authorityGeneration: 7,
        authorityService: {
          submitV2: async () => committedAttemptReceipt(attempt)
        } as AuthoritySubmissionService,
        compiler: {
          activatePlannedCommand: () => attempt.attempt
        } as unknown as ProductionCanonicalAttemptCompilerV2,
        expected,
        plan: {
          targetEntityId: fixture.operation.entityId
        } as ProductionAuthorityAttemptPlanV1
      });
      const coordinator = makeDaemonAuthorityWriteCoordinator(submission, {
        command: fixture.command as never,
        attribution: {} as never,
        currentSession,
        ...(fixture.ingressAdapter ? { ingressAdapter: fixture.ingressAdapter } : {})
      });

      assert.deepEqual(Object.keys(submission), ["submit", "submitDurable"]);
      await runEffect(coordinator.enqueue({
        opId: `op-${fixture.ingress}`,
        ...fixture.operation
      } as never));
      const report = await runEffect(coordinator.flush("explicit"));
      assert.equal(report.committed, true);
      assert.equal(report.watermark, attempt.expectedOpId);
    });
  }
});

test("planned durable submission still rejects specialized finalize content that differs from its plan", async () => {
  const attempt = authorityCommandAttemptFixture();
  const currentSession = {
    runtime: "codex" as const,
    sessionId: "session-ingress",
    source: "runtime" as const,
    detectedAt: "2026-07-24T00:00:00.000Z"
  };
  const plannedCommand = {
    rootDir: "/fixture",
    action: { kind: "task-claim", taskId: "task_PLANNED" }
  };
  const submission = createProductionPlannedCommandSubmission({
    repoId: "canonical",
    authorityGeneration: 7,
    authorityService: {
      submitV2: async () => committedAttemptReceipt(attempt)
    } as AuthoritySubmissionService,
    compiler: {
      activatePlannedCommand: () => attempt.attempt
    } as unknown as ProductionCanonicalAttemptCompilerV2,
    expected: {
      command: plannedCommand,
      attribution: {},
      currentSession,
      ingressAdapter: "task-claim"
    } as unknown as ProductionAuthorityCommandPlanInput,
    plan: {
      targetEntityId: "task/task_PLANNED"
    } as ProductionAuthorityAttemptPlanV1
  });
  const coordinator = makeDaemonAuthorityWriteCoordinator(submission, {
    command: {
      ...plannedCommand,
      action: { ...plannedCommand.action, taskId: "task_DIFFERENT" }
    } as never,
    attribution: {} as never,
    currentSession,
    ingressAdapter: "task-claim"
  });

  await runEffect(coordinator.enqueue({
    opId: "op-task-claim-different",
    entityId: "task/task_PLANNED",
    kind: "doc_write"
  }));
  await assert.rejects(
    runEffect(coordinator.flush("explicit")),
    /AUTHORITY_PLANNED_INPUT_MISMATCH/u
  );
});

test("multi-operation task creation stays on the direct child lane", () => {
  assert.equal(productionAuthorityCommandHasPurePlan({
    rootDir: "/repo",
    action: {
      kind: "new-task",
      title: "Task with provenance",
      titleProvided: true,
      taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG9"
    }
  }), false);
});

test("multi-operation execution submit stays on the direct child lane", () => {
  assert.equal(productionAuthorityCommandHasPurePlan({
    rootDir: "/repo",
    action: {
      kind: "task-submit",
      taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG6",
      executionId: "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5",
      leaseToken: null,
      submission: {
        completionClaim: "ready",
        deliverables: [],
        verificationNotes: [],
        knownGaps: [],
        residualRisks: [],
        outputs: []
      },
      callerIdempotencyKey: "task-submit-direct-child-test",
      dryRun: false
    }
  }), false);
});

test("ordinary status transition stays on the durable child lane", () => {
  assert.equal(productionAuthorityCommandHasPurePlan({
    rootDir: "/repo",
    action: {
      kind: "status-set",
      taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG6",
      status: "active",
      force: false
    }
  }), true);
});

test("one submission method carries every governed ingress discriminator", async () => {
  const fixture = authorityCommandAttemptFixture();
  const compiled: string[] = [];
  const submission = createDaemonAuthorityCommandSubmissionV2({
    authorityService: {
      submit: async () => { throw new Error("unused"); },
      submitV2: async () => { throw new Error("stop after compile"); },
      getOperation: async () => undefined
    },
    attemptCompiler: {
      compile: async (input) => {
        compiled.push(input.ingress);
        return fixture.attempt;
      }
    }
  });
  const common = {
    command: {} as never,
    attribution: {} as never,
    currentSession: {} as never
  };
  const operation = {
    opId: "op-ingress",
    entityId: "task/task_INGRESS",
    kind: "progress_append" as const
  };
  const inputs = [
    { ...common, ingress: "generic" as const, canonicalEntityId: operation.entityId },
    { ...common, ingress: "provenance-session" as const, operation },
    { ...common, ingress: "decision-transition" as const, operation },
    { ...common, ingress: "task-claim" as const, operation },
    { ...common, ingress: "observed-write" as const, operation },
    { ...common, ingress: "script-ingest" as const, operation }
  ];
  const telemetry: Array<{ ingress: string; phase: string }> = [];
  for (const input of inputs) {
    await assert.rejects(
      runWithRepoWriteTelemetry(
        (phase) => telemetry.push({ ingress: input.ingress, phase }),
        () => submission.submit(input)
      ),
      /stop after compile/u
    );
  }
  assert.deepEqual(compiled, inputs.map((input) => input.ingress));
  assert.deepEqual(
    telemetry,
    inputs.flatMap((input) => [
      { ingress: input.ingress, phase: "compile" },
      { ingress: input.ingress, phase: "git" }
    ])
  );
});

test("write coordinator routes specialized semantics through the durable submission entry", async () => {
  const cases = [
    { ingressAdapter: "decision-transition", ingress: "decision-transition", actionKind: "decision-transition", operationKind: "doc_write" },
    { ingressAdapter: "task-claim", ingress: "task-claim", actionKind: "task-claim", operationKind: "doc_write" },
    { ingressAdapter: "observed-write", ingress: "observed-write", actionKind: "task-amend", operationKind: "doc_write" },
    { ingressAdapter: undefined, ingress: "script-ingest", actionKind: "script-run", operationKind: "script_ingest" }
  ] as const;
  for (const fixture of cases) {
    let observedIngress = "";
    const coordinator = makeDaemonAuthorityWriteCoordinator({
      submit: async () => {
        throw new Error("settlement-only entry must not serve durable coordinator admission");
      },
      submitDurable: async (submission) => {
        observedIngress = submission.ingress;
        const receipt = {
          tag: "COMMITTED",
          workspaceId: "workspace-ingress",
          opId: `op-${fixture.ingress}`,
          semanticDigest: "a".repeat(64),
          revision: 1,
          commitSha: "b".repeat(40),
          previousCommit: null
        };
        return {
          admission: Promise.resolve({ kind: "terminal", receipt }),
          settlement: Promise.resolve(receipt)
        };
      }
    }, {
      command: {
        rootDir: "/fixture",
        json: true,
        action: { kind: fixture.actionKind }
      } as never,
      attribution: {} as never,
      currentSession: {
        runtime: "codex",
        sessionId: "session-ingress",
        source: "runtime",
        detectedAt: "2026-07-24T00:00:00.000Z"
      },
      ...(fixture.ingressAdapter ? { ingressAdapter: fixture.ingressAdapter } : {})
    });
    await runEffect(coordinator.enqueue({
      opId: `op-${fixture.ingress}`,
      entityId: "task/task_INGRESS",
      kind: fixture.operationKind
    } as never));
    await runEffect(coordinator.flush("explicit"));
    assert.equal(observedIngress, fixture.ingress);
  }
});

function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return new Promise((resolve, reject) => {
    Effect.runCallback(effect, {
      onExit: (exit) => exit._tag === "Success"
        ? resolve(exit.value)
        : reject(new Error(String(exit.cause)))
    });
  });
}

test("production recovery admission expires before the repo-write transport deadline", () => {
  assert.ok(defaultProductionRecoveryAdmissionTimeoutMs < defaultRepoWriteRequestTimeoutMs);
});

test("recovery gate preserves unresolved outer recovery instead of returning a terminal receipt", async () => {
  let recoverySubmissions = 0;
  const fixture = authorityCommandAttemptFixture();
  const service = gateAuthoritySubmissionForRecovery({
    submit: async () => {
      throw new Error("legacy admission not used");
    },
    resumeV2: async () => {
      recoverySubmissions += 1;
      throw new Error("unresolved recovery must remain gated");
    },
    getOperation: async () => undefined
  }, () => "AUTHORITY_RECOVERY_IN_PROGRESS:repoId=canonical");

  await assert.rejects(
    service.resumeV2!(authorityRecoveryAttemptFixture(fixture)),
    /AUTHORITY_RECOVERY_IN_PROGRESS:repoId=canonical/u
  );
  assert.equal(recoverySubmissions, 0);
});

test("stale daemon generation receipts expose a stable retryable write error code", () => {
  const failure = (() => {
    try {
      receiptToFlushReport({
        tag: "RETRYABLE_NOT_COMMITTED",
        workspaceId: "workspace-generation-fence",
        opId: "op-generation-fence",
        semanticDigest: "a".repeat(64),
        reason: "The daemon generation is stale.",
        errorCode: "DAEMON_GENERATION_FENCED",
        errorContext: {
          schema: "daemon-generation-write-rejection/v1",
          machineId: "machine-generation",
          attemptedDaemonGeneration: 1,
          currentDaemonGeneration: 2,
          workspaceId: "workspace-generation-fence",
          opId: "op-generation-fence",
          stage: "before-terminal-journal"
        }
      }, "explicit");
    } catch (error) {
      return error;
    }
    throw new Error("receiptToFlushReport must reject a retryable fenced receipt");
  })();

  assert.deepEqual(failure, {
    _tag: "WriteRejected",
    code: "DAEMON_GENERATION_FENCED",
    context: {
      schema: "daemon-generation-write-rejection/v1",
      machineId: "machine-generation",
      attemptedDaemonGeneration: 1,
      currentDaemonGeneration: 2,
      workspaceId: "workspace-generation-fence",
      opId: "op-generation-fence",
      stage: "before-terminal-journal"
    },
    reason: "The daemon generation is stale.",
    retryable: true
  });
});

test("post-publish generation loss remains an authority indeterminate report with original coordinates", () => {
  const report = receiptToFlushReport({
    tag: "INDETERMINATE",
    workspaceId: "workspace-generation-fence",
    opId: "op-generation-indeterminate",
    semanticDigest: "b".repeat(64),
    commitSha: "c".repeat(40),
    reason: "Canonical outcome requires current-generation reconciliation.",
    errorCode: "DAEMON_GENERATION_FENCED",
    errorContext: {
      schema: "daemon-generation-write-rejection/v1",
      machineId: "machine-generation",
      attemptedDaemonGeneration: 1,
      currentDaemonGeneration: 2,
      workspaceId: "workspace-generation-fence",
      opId: "op-generation-indeterminate",
      stage: "before-terminal-visibility"
    }
  }, "explicit");

  assert.equal("status" in report && report.status, "indeterminate");
  if (!("status" in report)) assert.fail("expected an indeterminate authority flush report");
  assert.deepEqual(report.operationIds, ["op-generation-indeterminate"]);
  assert.equal(report.cause.kind, "authority");
  if (report.cause.kind !== "authority") assert.fail("expected authority coordinates");
  assert.equal(report.cause.workspaceId, "workspace-generation-fence");
  assert.equal(report.cause.semanticDigest, "b".repeat(64));
  assert.equal(report.cause.observedCommitSha, "c".repeat(40));
  assert.equal(report.cause.evidence, "Canonical outcome requires current-generation reconciliation.");
  assert.equal(report.cause.errorCode, "DAEMON_GENERATION_FENCED");
  assert.equal(report.cause.errorContext?.stage, "before-terminal-visibility");
  assert.equal("committed" in report, false);
  assert.equal("watermark" in report, false);
  assert.equal("canonicalCommitSha" in report, false);
  assert.equal("publicationMode" in report, false);
});

function authorityCommandAttemptFixture() {
  const schemaTuple: ProtocolSchemaTupleV2 = {
    wire: 2, event: 2, receipt: 2, digest: 2, policy: 2,
    commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1,
    localState: 1, applyJournal: 1
  };
  const claims = v2Claims("workspace-command-service", Buffer.alloc(32, 12), schemaTuple);
  const envelope = v2Envelope(claims, Buffer.alloc(32, 6), "task-command-service", "command service\n", 4);
  return {
    envelope,
    attempt: {
      requestId: "command-service-v2",
      presentationToken: Buffer.from("server-bound-token"),
      envelope: encodeSemanticMutationEnvelopeV2(envelope)
    },
    expectedOpId: operationIdDiagnosticV2(envelope.operationId)
  };
}

function committedAttemptReceipt(
  fixture: ReturnType<typeof authorityCommandAttemptFixture>
) {
  const semanticDigest =
    Buffer.from(semanticRequestDigestV2(fixture.envelope)).toString("hex");
  return {
    tag: "COMMITTED" as const,
    workspaceId: fixture.envelope.workspaceId,
    opId: fixture.expectedOpId,
    semanticDigest,
    revision: 1,
    commitSha: "a".repeat(40),
    previousCommit: null,
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2" as const,
      semanticRequestDigest: semanticDigest,
      semanticMutationSetDigest: "b".repeat(64),
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: "c".repeat(64),
      canonicalMutationSet: {
        registryVersion: 1,
        mutations: []
      }
    },
    integrityTuple: {
      schema: "authority-integrity-tuple/v2" as const,
      canonicalEventDigest: "d".repeat(64),
      changeSetDigest: "e".repeat(64),
      semanticMutationSetDigest: "b".repeat(64),
      actorAxesBindingDigest: "c".repeat(64)
    }
  };
}

function authorityRecoveryAttemptFixture(
  fixture: ReturnType<typeof authorityCommandAttemptFixture>
): AuthorityRecoveryAttemptV2 {
  return {
    schema: "authority-recovery-attempt/v1",
    attempt: fixture.attempt,
    witness: {
      repoId: "canonical",
      outerOpId: "repo-write:outer",
      outerRequestDigest: "a".repeat(64),
      outerGeneration: 404,
      authorityGeneration: 3,
      requestId: fixture.attempt.requestId,
      workspaceId: fixture.envelope.workspaceId,
      opId: fixture.expectedOpId,
      semanticDigest: Buffer.from(semanticRequestDigestV2(fixture.envelope)).toString("hex"),
      admittedAtMs: "1",
      canonicalRequestEnvelope: Buffer.from(fixture.attempt.envelope).toString("base64url"),
      attribution: {
        actor: {
          principal: { kind: "person", personId: "person_zeyu" },
          executor: null
        },
        principalSource: {
          kind: "daemon-authenticated",
          providerId: "local-socket"
        },
        executorSource: "absent"
      }
    }
  };
}
