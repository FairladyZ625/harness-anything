import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DurableRepoWriteOutcomeStoreV1,
  ProductionProgressAppendOperationHost,
  ReceiptSettlementStore,
  encodeRepoWriteCommand,
  type AuthorityRepoComponent,
  type AuthorityRepoConnectionBinding,
  type HarnessDaemonRuntime,
  type ProductionProgressAppendCompileInput,
  type RepoWriteDocSyncExecution,
  type RepoWriteParentMessage
} from "../../src/index.ts";
import { waitForCurrentAuthoritySettlementRelease } from "../../src/runtime/authority-durable-acceptance-context.ts";
import { repoWriteProtocolType } from "../../src/runtime/repo-write-protocol.ts";
import { cliDaemonCommandHostServices } from "../../../cli/src/composition/daemon-command-host-services.ts";
import { parseNewTaskArgs } from "../../../cli/src/cli/parsers/new-task.ts";
import type { ParsedCommand } from "../../../cli/src/cli/types.ts";

export const progressOperationTaskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4";

export function productionProgressOperationHost(
  store: DurableRepoWriteOutcomeStoreV1,
  authorityComponent: AuthorityRepoComponent,
  events: string[],
  outcomeDirectory: string,
  executeDocSyncSubmit?: () => Promise<RepoWriteDocSyncExecution>,
  requireOuterProceeding = true,
  runtimeEventTail?: {
    readonly materializerDelayMs: number;
    readonly timing: { startedAt?: number; finishedAt?: number };
    readonly failures?: Array<{ readonly requestId: string; readonly command: string; readonly reason: string }>;
  }
) {
  return new ProductionProgressAppendOperationHost({
    ...productionProgressOperationAxes(),
    runtime: progressOperationRuntime(events, requireOuterProceeding),
    authorityComponent,
    hostServices: runtimeEventTail
      ? runtimeEventTailHostServices(runtimeEventTail)
      : cliDaemonCommandHostServices,
    outcomeStore: store,
    settlementStore: new ReceiptSettlementStore({
      directory: path.join(outcomeDirectory, "settlements"),
      ...productionProgressOperationAxes()
    }),
    now: () => new Date("2026-07-24T00:00:00.000Z"),
    newOuterOpId: () => "outer-progress-operation",
    ...(runtimeEventTail?.failures ? {
      onBackgroundRuntimeEventFailure: (failure) => runtimeEventTail.failures!.push(failure)
    } : {}),
    ...(executeDocSyncSubmit ? { executeDocSyncSubmit } : {})
  });
}

export function progressOperationAuthorityComponent(
  events: string[],
  expectedRecovery?: {
    readonly outerOpId: string;
    readonly outerRequestDigest: string;
  },
  outcome: "committed" | "already-satisfied" = "committed"
): AuthorityRepoComponent {
  const bindConnection = (): AuthorityRepoConnectionBinding => ({
    ...terminalDurableSubmission(async () => { throw new Error("unplanned authority submit"); }),
    planCommand: async (expected) => {
      events.push("plan-fixed-attempt");
      return progressOperationPlan({
        ...expected,
        canonicalEntityId: `task/${progressOperationTaskId}`
      });
    },
    plannedCommandSubmission: ({ expected, plan: fixed, recovery }) => terminalDurableSubmission(
      async (actual) => {
        assert.deepEqual(actual, {
          ...expected,
          ingress: "generic",
          canonicalEntityId: fixed.targetEntityId
        });
        assert.equal(fixed.innerOpId, "inner-progress-operation");
        if (expectedRecovery) {
          assert.deepEqual(recovery, {
            ...expectedRecovery,
            outerGeneration: productionProgressOperationAxes().generation
          });
          events.push("inner-submit-recovery");
        } else {
          assert.equal(recovery, undefined);
          events.push("inner-submit");
        }
        return outcome === "already-satisfied"
          ? alreadySatisfiedEvidence(fixed.semanticDigest)
          : committedEvidence(fixed.semanticDigest);
      }
    ),
    planProgressAppend: async (expected) => {
      events.push("plan-fixed-attempt");
      return progressOperationPlan(expected);
    },
    plannedProgressAppendSubmission: ({ expected, plan: fixed, recovery }) => terminalDurableSubmission(
      async (actual) => {
        assert.deepEqual(actual, {
          ...expected,
          ingress: "generic"
        });
        assert.equal(fixed.innerOpId, "inner-progress-operation");
        if (expectedRecovery) {
          assert.deepEqual(recovery, {
            ...expectedRecovery,
            outerGeneration: productionProgressOperationAxes().generation
          });
          events.push("inner-submit-recovery");
        } else {
          assert.equal(recovery, undefined);
          events.push("inner-submit");
        }
        return committedEvidence(fixed.semanticDigest);
      }
    )
  });
  return {
    commandSubmissionV2: terminalDurableSubmission(
      async () => { throw new Error("unbound"); }
    ),
    cutoverControl: {} as AuthorityRepoComponent["cutoverControl"],
    bindConnection,
    stop: async () => undefined
  };
}

export function slowFailedProgressAuthorityComponent(
  events: string[],
  settlementDelayMs: number,
  timing: { startedAt?: number; finishedAt?: number }
): AuthorityRepoComponent {
  const bindConnection = (): AuthorityRepoConnectionBinding => ({
    ...terminalDurableSubmission(async () => { throw new Error("unplanned authority submit"); }),
    planCommand: async (expected) => {
      events.push("plan-fixed-attempt");
      return progressOperationPlan({
        ...expected,
        canonicalEntityId: `task/${progressOperationTaskId}`
      });
    },
    plannedCommandSubmission: ({ expected, plan: fixed }) => ({
      submit: async () => { throw new Error("durable acceptance fixture requires submitDurable"); },
      submitDurable: async (actual) => {
        assert.deepEqual(actual, {
          ...expected,
          ingress: "generic",
          canonicalEntityId: fixed.targetEntityId
        });
        events.push("inner-submit");
        const release = waitForCurrentAuthoritySettlementRelease();
        const settlement = release.then(() => {
          timing.startedAt = performance.now();
          const deadline = timing.startedAt + settlementDelayMs;
          while (performance.now() < deadline) {
            // Deliberately model synchronous Git/projection work in the child.
          }
          timing.finishedAt = performance.now();
          throw new Error("simulated slow canonical settlement failure");
        });
        return {
          admission: Promise.resolve({
            kind: "accepted",
            acceptance: {
              sessionId: "session-progress-early-return",
              acceptedCommitSha: "a".repeat(40),
              flush: {
                reason: "explicit",
                opCount: 1,
                committed: true,
                watermark: fixed.innerOpId
              }
            }
          }),
          settlement
        };
      }
    })
  });
  return {
    commandSubmissionV2: terminalDurableSubmission(
      async () => { throw new Error("unbound"); }
    ),
    cutoverControl: {} as AuthorityRepoComponent["cutoverControl"],
    bindConnection,
    stop: async () => undefined
  };
}

export function slowFailedDirectAuthorityComponent(
  events: string[],
  settlementDelayMs: number,
  timing: { startedAt?: number; finishedAt?: number }
): AuthorityRepoComponent {
  let submissionCount = 0;
  const bindConnection = (): AuthorityRepoConnectionBinding => ({
    ...terminalDurableSubmission(async () => {
      throw new Error("direct durable acceptance fixture requires submitDurable");
    }),
    submitDurable: async (actual) => {
      assert.equal(actual.ingress, "generic");
      assert.equal(actual.command.action.kind, "new-task");
      submissionCount += 1;
      events.push("inner-submit");
      const release = waitForCurrentAuthoritySettlementRelease();
      const settlement = release.then(() => {
        timing.startedAt ??= performance.now();
        const deadline = performance.now() + settlementDelayMs;
        while (performance.now() < deadline) {
          // Deliberately model synchronous Git/projection work in the child.
        }
        timing.finishedAt = performance.now();
        throw new Error("simulated slow direct canonical settlement failure");
      });
      return {
        admission: Promise.resolve({
          kind: "accepted",
          acceptance: {
            sessionId: "session-task-create-early-return",
            acceptedCommitSha: "a".repeat(40),
            flush: {
              reason: "explicit",
              opCount: 1,
              committed: true,
              watermark: `inner-task-create-${submissionCount}`
            }
          }
        }),
        settlement
      };
    }
  });
  return {
    commandSubmissionV2: terminalDurableSubmission(
      async () => { throw new Error("unbound"); }
    ),
    cutoverControl: {} as AuthorityRepoComponent["cutoverControl"],
    bindConnection,
    stop: async () => undefined
  };
}

function terminalDurableSubmission(
  submit: AuthorityRepoConnectionBinding["submit"]
): Pick<AuthorityRepoConnectionBinding, "submit" | "submitDurable"> {
  return {
    submit,
    submitDurable: async (input) => {
      const receipt = await submit(input);
      return {
        admission: Promise.resolve({ kind: "terminal", receipt }),
        settlement: Promise.resolve(receipt)
      };
    }
  };
}

function progressOperationPlan(expected: ProductionProgressAppendCompileInput) {
  return {
    schema: "production-authority-attempt-plan/v1" as const,
    commandKind: "progress-append" as const,
    targetEntityId: expected.canonicalEntityId,
    requestId: "authority-command:progress-operation",
    innerOpId: "inner-progress-operation",
    semanticDigest: "1".repeat(64),
    tokenId: "token-progress-operation",
    bindingId: "binding-progress-operation",
    plannedAtMs: "1",
    expiresAtMs: "300001",
    presentationTokenBase64url: "AQ",
    envelopeBase64url: "Ag",
    attribution: expected.attribution.writeAttribution
  };
}

function committedEvidence(semanticDigest: string) {
  return {
    tag: "COMMITTED" as const,
    workspaceId: productionProgressOperationAxes().workspaceId,
    opId: "inner-progress-operation",
    semanticDigest,
    revision: 1,
    commitSha: "a".repeat(40),
    previousCommit: null,
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2" as const,
      semanticRequestDigest: semanticDigest,
      semanticMutationSetDigest: "2".repeat(64),
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: "3".repeat(64),
      canonicalMutationSet: {
        registryVersion: 1,
        mutations: [{
          entity: {
            registryVersion: 1,
            entityKind: "task",
            canonicalRef: `task/${progressOperationTaskId}`
          },
          action: { registryVersion: 1, action: "progress-append" }
        }]
      }
    },
    integrityTuple: {
      schema: "authority-integrity-tuple/v2" as const,
      canonicalEventDigest: "4".repeat(64),
      changeSetDigest: "5".repeat(64),
      semanticMutationSetDigest: "2".repeat(64),
      actorAxesBindingDigest: "3".repeat(64)
    }
  };
}

function alreadySatisfiedEvidence(semanticDigest: string) {
  const integrity = committedEvidence(semanticDigest).authorityIntegrity;
  return {
    tag: "ALREADY_SATISFIED" as const,
    workspaceId: productionProgressOperationAxes().workspaceId,
    opId: "inner-progress-operation",
    semanticDigest,
    message: "目标状态已满足,本次无变更" as const,
    stateProof: {
      schema: "authority-already-satisfied-state-proof/v1" as const,
      entityKind: "task",
      canonicalRef: `task/${progressOperationTaskId}`,
      path: `tasks/${progressOperationTaskId}/INDEX.md`,
      field: "status",
      requestedValue: "active",
      observedValue: "active",
      observedEpoch: "epoch-status",
      observedRevision: "0",
      observedBlobDigest: "6".repeat(64)
    },
    authorityIntegrity: {
      ...integrity,
      canonicalMutationSet: {
        ...integrity.canonicalMutationSet,
        mutations: integrity.canonicalMutationSet.mutations.map((mutation) => ({
          ...mutation,
          action: { registryVersion: 1, action: "transition" }
        }))
      }
    }
  };
}

function progressOperationRuntime(
  events: string[],
  requireOuterProceeding: boolean
): HarnessDaemonRuntime {
  return {
    start: async () => { throw new Error("not used"); },
    stop: async () => undefined,
    status: () => ({ started: true }) as ReturnType<HarnessDaemonRuntime["status"]>,
    enqueueInteractiveWrite: async (request) => {
      if (requireOuterProceeding && !events.includes("outer-proceeding-fsynced")) {
        throw new Error("operational write started before durable PROCEEDING");
      }
      events.push("runtime-event-write");
      return {
        commandId: request.commandId,
        opIds: request.ops.map((op) => op.opId),
        durable: true,
        flush: {
          reason: "explicit",
          opCount: request.ops.length,
          committed: true
        }
      };
    },
    enqueueBackgroundBatch: async () => { throw new Error("not used"); },
    enqueueMaterializerBatch: async () => ({
      dryRun: false,
      merged: 0,
      considered: 0,
      branches: [],
      warnings: []
    }),
    enqueueAuthorityPublication: async () => { throw new Error("not used"); },
    queryExecutionEvidencePage: async () => ({ rows: [], nextCursor: null }),
    createAttributedCoordinator: () => { throw new Error("not used"); },
    assertWriteFenceHeld: async () => {
      if (!events.includes("outer-proceeding-fsynced")) {
        throw new Error("writer fence checked before durable PROCEEDING");
      }
    },
    admissionBudget: {
      acquire: () => { throw new Error("not used"); },
      snapshot: () => ({}) as never
    } as HarnessDaemonRuntime["admissionBudget"],
    subscribeProjectionChanges: () => () => undefined
  };
}

function runtimeEventTailHostServices(tail: {
  readonly materializerDelayMs: number;
  readonly timing: { startedAt?: number; finishedAt?: number };
}) {
  return {
    ...cliDaemonCommandHostServices,
    executeCommand: (command, options) => cliDaemonCommandHostServices.executeCommand(command, {
      ...options,
      deferCommandRuntimeEvent: (append) => options.deferCommandRuntimeEvent?.(async () => {
        tail.timing.startedAt = performance.now();
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, tail.materializerDelayMs));
          return await append();
        } finally {
          tail.timing.finishedAt = performance.now();
        }
      })
    })
  } satisfies typeof cliDaemonCommandHostServices;
}

export function progressOperationCommand(rootDir: string): ParsedCommand {
  return {
    rootDir,
    json: true,
    action: {
      kind: "progress-append",
      taskId: progressOperationTaskId,
      text: "child operation progress\n",
      evidence: [],
      dryRun: false
    }
  };
}

export function newTaskOperationCommand(rootDir: string): ParsedCommand {
  const parsed = parseNewTaskArgs(
    ["task", "create", "--title", "Direct early return task"],
    rootDir,
    true
  );
  if (!parsed?.ok) throw new Error("failed to build new-task fixture command");
  return parsed.value;
}

export function statusOperationCommand(rootDir: string): ParsedCommand {
  return {
    rootDir,
    json: true,
    action: {
      kind: "status-set",
      taskId: progressOperationTaskId,
      status: "active",
      force: false,
      dryRun: false
    }
  };
}

export function enableProgressOperationLease(authoredRoot: string): void {
  writeFileSync(path.join(authoredRoot, "harness.yaml"), [
    "schema: harness-anything/v1",
    "project: progress-operation",
    "settings:",
    "  tasks:",
    "    leaseEnforcement: true",
    ""
  ].join("\n"));
}

export function installProgressOperationTask(authoredRoot: string): void {
  const taskRoot = path.join(authoredRoot, "tasks", `${progressOperationTaskId}-progress-operation`);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${progressOperationTaskId}`,
    "title: Progress operation",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref: ",
    "  titleSnapshot: Progress operation",
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
    "# Progress operation",
    ""
  ].join("\n"));
  writeFileSync(path.join(taskRoot, "task_plan.md"), [
    "# Task Plan",
    "",
    "## Goal",
    "",
    "Exercise the exact same-state transition path with a substantive plan.",
    ""
  ].join("\n"));
}

export function progressOperationDurabilityEvents(events: string[]) {
  let target = "";
  return {
    beforePublishLink: (input: { readonly target: string }) => {
      target = input.target;
    },
    afterDirectoryFsync: (reason: string) => {
      if (reason !== "publish") return;
      if (target.endsWith(".proceeding.json")) events.push("outer-proceeding-fsynced");
      if (target.endsWith(".terminal.json")) events.push("outer-terminal-fsynced");
      target = "";
    }
  };
}

export function progressOperationSubmitMessage(
  command: ReturnType<typeof encodeRepoWriteCommand>
): Extract<RepoWriteParentMessage, { readonly kind: "submit" }> {
  return {
    protocol: repoWriteProtocolType,
    repoId: productionProgressOperationAxes().repoId,
    generation: productionProgressOperationAxes().generation,
    kind: "submit",
    requestId: "request-progress-early-return",
    command
  };
}

export function progressOperationProceedMessage(
  requestId: string,
  opId: string
): Extract<RepoWriteParentMessage, { readonly kind: "proceed" }> {
  return {
    protocol: repoWriteProtocolType,
    repoId: productionProgressOperationAxes().repoId,
    generation: productionProgressOperationAxes().generation,
    kind: "proceed",
    requestId,
    opId
  };
}

export function newTaskOperationDirectMessage(
  command: ReturnType<typeof encodeRepoWriteCommand>
): Extract<RepoWriteParentMessage, { readonly kind: "direct" }> {
  return {
    protocol: repoWriteProtocolType,
    repoId: productionProgressOperationAxes().repoId,
    generation: productionProgressOperationAxes().generation,
    kind: "direct",
    requestId: "request-task-create-early-return",
    command
  };
}

export function productionProgressOperationAxes() {
  return {
    repoId: "canonical",
    workspaceId: "workspace-production",
    generation: 2
  } as const;
}
