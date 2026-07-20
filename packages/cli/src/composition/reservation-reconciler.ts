import {
  makeCoordinatedExecutionAuthoredStore,
  makeExecutionReservationReconciler,
  makeRuntimeEventAppendPromise,
  makeRuntimeEventLedgerService,
  makeTaskHolderService,
  type TaskHolderPrincipal
} from "@harness-anything/application";
import {
  Effect,
} from "effect";
import {
  makeJournaledWriteCoordinator,
  makeMarkdownArtifactStore,
  type HarnessLayoutInput,
  type WriteAttribution,
  type WriteCoordinator
} from "@harness-anything/kernel";
import { makeDaemonQueuedOperationalWriteCoordinator, type CliDaemonRuntime } from "@harness-anything/daemon";

export function makeDaemonReservationReconciler(rootInput: HarnessLayoutInput, runtime?: CliDaemonRuntime): () => Promise<void> {
  const appendLeaseEvent = runtime
    ? makeRuntimeEventAppendPromise(makeRuntimeEventLedgerService({
        rootInput,
        coordinator: makeDaemonQueuedOperationalWriteCoordinator(runtime, "runtime-event-lease-reconcile", {
          scope: "operational",
          kind: "system",
          id: "daemon-runtime"
        })
      }))
    : undefined;
  return makeExecutionReservationReconciler({
    rootInput,
    taskHolderService: makeTaskHolderService({ rootInput, ...(appendLeaseEvent ? { appendLeaseEvent } : {}) }),
    authoredStoreForLease: ({ executionId, principal }) => makeCoordinatedExecutionAuthoredStore({
      rootInput,
      coordinator: makeJournaledWriteCoordinator({
        rootDir: typeof rootInput === "string" ? rootInput : rootInput.rootDir,
        ...(typeof rootInput === "string" || !rootInput.layoutOverrides ? {} : { layoutOverrides: rootInput.layoutOverrides }),
        attribution: reservationReconciliationAttribution(executionId, principal),
        ...commitAuthorFromLease(principal)
      }),
      artifactStore: makeMarkdownArtifactStore(
        typeof rootInput === "string"
          ? { rootDir: rootInput }
          : { rootDir: rootInput.rootDir, ...(rootInput.layoutOverrides ? { layoutOverrides: rootInput.layoutOverrides } : {}) }
      )
    })
  });
}

export function failClosedReservationReconcilerCoordinator(): WriteCoordinator {
  const fail = () => Effect.fail({
    _tag: "WriteRejected" as const,
    reason: "Reservation reconciliation cannot author entity state without the original lease principal attribution.",
    code: "identity_required",
    retryable: false
  });
  return {
    enqueue: () => fail(),
    flush: () => fail(),
    recover: fail()
  };
}

export function reservationReconciliationAttribution(
  executionId: string,
  holder: TaskHolderPrincipal
): WriteAttribution {
  const personId = holder.principal?.personId?.trim();
  const executor = holder.executor;
  if (!personId || holder.responsibleHuman !== `person:${personId}`) {
    throw new Error(`orphan execution reservation has no trustworthy principal: ${executionId}`);
  }
  if (executor !== null && (executor.kind !== "agent" || executor.id.trim().length === 0)) {
    throw new Error(`orphan execution reservation has invalid executor attribution: ${executionId}`);
  }
  return {
    actor: {
      principal: { kind: "person", personId },
      executor: executor ? { kind: "agent", id: executor.id } : null
    },
    principalSource: {
      kind: "migration",
      evidenceRef: `recovery-of:${executionId}`
    },
    executorSource: executor ? "client-asserted" : "none"
  };
}

function commitAuthorFromLease(holder: TaskHolderPrincipal): {
  readonly commitAuthor?: { readonly name: string; readonly email: string };
} {
  const name = holder.principal.displayName?.trim();
  const email = holder.principal.primaryEmail?.trim();
  return name && email ? { commitAuthor: { name, email } } : {};
}
