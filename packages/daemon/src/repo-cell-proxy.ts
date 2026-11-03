import { consumeKnownError } from "@harness-anything/kernel";
import { nodeLocalWriteCommandTopology } from "@harness-anything/preset/internal/preset-command-contract";
import { acquireRepoStorageLock } from "@harness-anything/storage";
import path from "node:path";
import { makeAgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { readReplicaGeneration } from "./fleet/replica-generation.ts";
import { readReplicaHealth } from "./fleet/replica-health.ts";
import { commandDescriptorForAction, repoCellExecutionForAction } from "./protocol/daemon-protocol-commands.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import { acquireWorkspaceLock, causeClassOf } from "./repo-cell-lock.ts";
import type { RepoCellOpenInput } from "./repo-cell-open.ts";
import { operationId } from "./repo-cell-proof.ts";
import { failed } from "./repo-cell-settlement.ts";
import type { RepoCell, RepoCellBinding } from "./repo-cell-types.ts";
import { admitRepoMode } from "./repo-mode.ts";
import { openRepoReadClient, type RepoReadWorkerFactory } from "./repo-read-pool.ts";
import { runtimeOutcomeSettled, runtimeSettlementGraceMs } from "./runtime-settlement.ts";
import { preparePersonActionExplanationBinding } from "./task-action-explanation-read.ts";
import { openTerminalHost } from "./terminal-host.ts";
import { openWriterSupervisor } from "./writer-supervisor.ts";

const writerAttached = (cell: { readonly state: string }): boolean => cell.state === "attached";

/** Host-side RepoCell boundary: admission, bounded read RPC, writer proxy and live streams. */
export async function openRepoCellProxy(
  input: RepoCellOpenInput & { readonly onStatus?: (status: ReturnType<RepoCell["status"]>) => void },
  options: { readonly createReadWorker?: RepoReadWorkerFactory } = {},
): Promise<RepoCell> {
  const lock = await acquireRepoStorageLock(input.storage, () => acquireWorkspaceLock(input.rootDir));
  let relayRuntimeSignal: NonNullable<RepoCellOpenInput["onRuntimeSignal"]> = () => undefined;
  // Orchestration waiters (runtime batch, agent create, sessions.await) park on these sets; an exit
  // signal or outcome notification re-checks the domain settle predicate. Activity and heartbeat
  // signals change no settle input, and waking every parked wait for each provider frame turned the
  // host thread into a re-read loop proportional to provider output times parked waits.
  const outcomeWaiters = new Map<string, Set<() => void>>(),
    signalWaiters = new Set<() => void>(),
    pokeSignalWaiters = (): void => {
      const waiters = [...signalWaiters];
      signalWaiters.clear();
      for (const waiter of waiters) waiter();
    },
    pokeOutcomeWaiters = (runtimeSessionId: string | undefined): void => {
      pokeSignalWaiters();
      if (typeof runtimeSessionId !== "string") return;
      const waiters = [...(outcomeWaiters.get(runtimeSessionId) ?? [])];
      outcomeWaiters.delete(runtimeSessionId);
      for (const waiter of waiters) waiter();
    };
  // Read per use: the first `ha daemon fleet edge sync` writes fleet-edge.json after this cell opened.
  const edgeConfig = () => (input.mode === "remote-edge" ? readFleetEdgeConfig(input.rootDir) : null);
  let replicaOnly = false;
  let supervisor: Awaited<ReturnType<typeof openWriterSupervisor>>;
  try {
    supervisor = await openWriterSupervisor(
      {
        ...input,
        onRuntimeOutcome: (event) => {
          pokeOutcomeWaiters(event.payload.runtimeSessionId);
          input.onRuntimeOutcome?.(event);
        },
        onRuntimeSignal: (runtimeSessionId, signal) => {
          relayRuntimeSignal(runtimeSessionId, signal);
          if (signal.type === "exit") pokeOutcomeWaiters(runtimeSessionId);
          input.onRuntimeSignal?.(runtimeSessionId, signal);
        },
      },
      {
        onAttachStatus: input.onStatus,
        onPublishedStatus: (status) => {
          input.onStatus?.(status);
        },
      },
    );
  } catch (error) {
    // An edge answers replica reads even when its own runtime ledger cannot attach; its writer
    // state reports that failure, and every write rejects with it.
    if (edgeConfig() === null) {
      await lock.close();
      throw error;
    }
    replicaOnly = true;
    consumeKnownError(error);
    const lastError = error instanceof Error ? error.message : String(error),
      baseStatus = () => ({
        repoId: input.repoId,
        rootDir: input.rootDir,
        mode: "remote-edge" as const,
        state: "unavailable" as const,
        generation: null,
        queueDepth: null,
        recoveryMs: null,
        materialization: null,
        lastError,
        causeClass: causeClassOf(error),
      }),
      replicaStatus = () => {
        const config = edgeConfig();
        if (!config) return baseStatus();
        const viewDir = path.join(config.viewRoot, "repos", input.repoId, "views", config.nodeId),
          generation = readReplicaGeneration(viewDir),
          health = readReplicaHealth(viewDir),
          failure = health.modelFailure ?? health.syncFailure;
        // A center-token/network failure affects synchronization, not the readability of a
        // generation already installed on this edge. Keep it on replica read warnings; only a
        // model failure makes that generation unavailable to repository reads.
        if (generation !== null && health.modelFailure === null)
          return {
            ...baseStatus(),
            state: "attached" as const,
            projectionReadable: true,
            generation: generation.metadata.ledgerGeneration,
            lastError: null,
            causeClass: null,
          };
        if (failure !== null)
          return {
            ...baseStatus(),
            lastError: failure.message,
            causeClass: causeClassOf(Object.assign(new Error(failure.message), { code: failure.code })),
          };
        return baseStatus();
      },
      rejectWrite = async (): Promise<never> => {
        throw cellCodedError("repo_unavailable", lastError);
      };
    supervisor = {
      status: replicaStatus,
      request: rejectWrite,
      control: rejectWrite,
      bootstrapReceipt: () => undefined,
      ledgerCut: () => null,
      close: async () => undefined,
    };
  }
  const reads = openRepoReadClient(input, options.createReadWorker);
  const query = <T>(method: string, args: readonly unknown[] = [], binding?: RepoCellBinding): Promise<T> => {
    if (closed) return Promise.reject(cellCodedError("repo_unavailable", "RepoCell is closed."));
    const status = supervisor.status();
    const observeEvents = method === "observeTail" && (args[0] as { kind?: unknown } | null)?.kind === "events";
    const independent =
      (method === "read" && args[0] === "repo.entity.locator.read") || (method === "observeTail" && !observeEvents);
    const replicaRead =
      input.mode === "remote-edge" &&
      ((method === "read" && args[0] !== "repo.agent.skills.list") ||
        method === "explainBasis" ||
        method === "readNodeAutoClaimAssignments" ||
        observeEvents ||
        (method === "run" &&
          commandDescriptorForAction((args[0] as { kind: string }).kind).admission["remote-edge"] === "edge-replica"));
    if (
      !independent &&
      !replicaRead &&
      !writerAttached(status) &&
      !(status.state === "unavailable" && status.projectionReadable === true)
    )
      return Promise.reject(cellCodedError("repo_unavailable", status.lastError ?? "RepoWriterCell is not ready."));
    return reads.request(method, args, binding);
  };
  const readSession = (runtimeSessionId: string) =>
    query<import("@harness-anything/kernel").RuntimeSession | null>("readSession", [runtimeSessionId]);
  const runtime = makeAgentRuntimeStreamHub({
    readSession,
    canAttach: (session) => query<boolean>("canAttach", [session]),
    ...(input.now ? { now: () => new Date(input.now!()) } : {}),
  });
  const terminalHost = openTerminalHost({
    repoId: input.repoId,
    rootDir: input.rootDir,
    daemonGeneration: supervisor.status().generation ?? Date.now() * 1_000 + (process.pid % 1_000),
    ...(input.now ? { now: input.now } : {}),
  });
  const replica = { kick: () => undefined, close: () => undefined, ledgerCut: supervisor.ledgerCut };
  const latched = () => supervisor.status().lastError ?? "RepoCell is unavailable.";
  relayRuntimeSignal = runtime.publish;
  let closed = false;
  const run: RepoCell["run"] = async (action, binding, signal) => {
    if (closed)
      return {
        outcome: "op_rejected",
        opId: operationId(action, binding, input.repoId, 0),
        code: "repo_unavailable",
      } as never;
    if (input.mode === "remote-edge" && action.kind === "receipt-show")
      return failed(
        operationId(action, binding, input.repoId, 0),
        cellCodedError(
          "replica_unavailable",
          "Canonical acceptance and follower progress belong to the center writer, not this edge runtime ledger.",
        ),
      ) as Awaited<ReturnType<RepoCell["run"]>>;
    if (repoCellExecutionForAction(action.kind) === "query-only") {
      try {
        return await query("run", [action], binding);
      } catch (error) {
        return failed(operationId(action, binding, input.repoId, 0), error) as Awaited<ReturnType<RepoCell["run"]>>;
      }
    }
    // Writes must yield once so a close started in the same turn wins admission.
    await Promise.resolve();
    if (closed)
      return {
        outcome: "op_rejected",
        opId: "closed",
        code: "repo_unavailable",
      } as never;
    return supervisor.request("run", { action }, binding, signal);
  };
  const admitTerminalWrite = (binding: RepoCellBinding): void => {
    const admission = admitRepoMode(input.mode ?? "local", nodeLocalWriteCommandTopology, binding.source);
    if (!admission.ok) throw cellCodedError(admission.code, admission.nextAction);
    if (closed || supervisor.status().state !== "attached")
      throw cellCodedError("repo_unavailable", "RepoWriterCell is unavailable.");
  };
  const terminal: RepoCell["terminal"] = {
    list: terminalHost.list,
    attach: terminalHost.attach,
    detach: terminalHost.detach,
    close: terminalHost.close,
    spawn: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.spawn(payload);
    },
    spawnTrusted: (launch, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.spawnTrusted(launch);
    },
    input: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.input(payload);
    },
    resize: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.resize(payload);
    },
    terminate: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.terminate(payload);
    },
  };
  return {
    scheduleOccurrenceSettlementOwner: (dispatchId) => query("scheduleOccurrenceSettlementOwner", [dispatchId]),
    hasBuiltinExecutor: (claimFence) => supervisor.request("hasBuiltinExecutor", { claimFence }),
    get bootstrapReceipt() {
      return supervisor.bootstrapReceipt() as RepoCell["bootstrapReceipt"];
    },
    run,
    presetRun: (action, binding) => supervisor.request("presetRun", { action }, binding),
    spawnRuntime: (payload, binding) => supervisor.request("spawnRuntime", payload, binding),
    handoffRuntime: (payload, binding) => supervisor.request("handoffRuntime", payload, binding),
    cancelRuntime: (payload, binding) => supervisor.request("cancelRuntime", payload, binding),
    steerRuntime: (payload, binding) => supervisor.request("steerRuntime", payload, binding),
    runtimeIngress: (action, binding) => supervisor.request("runtimeIngress", { action }, binding),
    catalog: {
      snapshot: () => supervisor.request("catalog", { method: "snapshot", args: [] }),
      preset: (payload) => supervisor.request("catalog", { method: "preset", args: [payload] }),
      reread: (payload) => supervisor.request("catalog", { method: "reread", args: [payload] }),
    },
    terminal,
    read: async (method, payload = {}, binding) => {
      if (method === "repo.entity.actions.explain") {
        const at = await query<{ revision: number; binding: RepoCellBinding }>("explainBasis", [payload], binding);
        const prepared = await preparePersonActionExplanationBinding(
          {
            revision: at.revision,
            repoId: input.repoId,
            now: () => input.now?.() ?? new Date().toISOString(),
            binding: { ...binding, ...at.binding, keycloakAuthorization: binding?.keycloakAuthorization },
          },
          payload,
        );
        return query("read", [method, payload, at.revision], prepared);
      }
      return query("read", [method, payload], binding);
    },
    readEventWitness: (revision) => query("readEventWitness", [revision]),
    readNodeAutoClaimAssignments: (binding) => query("readNodeAutoClaimAssignments", [], binding),
    workspaceSummary: () => query("read", ["repo.workspace.summary.read", {}]),
    workspaceScope: (payload) => query("read", ["repo.workspace.scope.read", payload]),
    observeTail: (payload, daemon, binding) => query("observeTail", [payload, daemon], binding),
    replica,
    verifyReadiness: async () => {
      const status = supervisor.status();
      if (!writerAttached(status)) throw cellCodedError("repo_unavailable", latched());
      // Attach already verifies the projection in its writer. Readiness consumes that published
      // cut; waiting for a cold read worker would put runtime recovery ahead of ledger readiness.
      if (
        status.projectionReadable !== true ||
        status.projectionWatermark === undefined ||
        status.projectionWatermark !== status.ledgerRevision
      )
        throw cellCodedError("repo_unavailable", "RepoCell L2 projection is not ready.");
      return { cellState: "attached", l2State: "ready" } as const;
    },
    attach: async (runtimeSessionId, afterCursor) => {
      const status = supervisor.status();
      if (!writerAttached(status)) throw cellCodedError("repo_unavailable", latched());
      return runtime.attach(runtimeSessionId, afterCursor);
    },
    awaitRuntimeOutcome: async (runtimeSessionId) => {
      const now = input.now ?? (() => new Date().toISOString());
      while (!runtimeOutcomeSettled(await readSession(runtimeSessionId), now())) {
        await new Promise<void>((resolve) => {
          const waiter = () => {
            waiters.delete(waiter);
            clearTimeout(timer);
            resolve();
          };
          // The settle predicate is also time-based (post-exit grace), so a missed signal cannot
          // park a waiter forever; each wake re-reads the projection and either returns or rearms.
          const timer = setTimeout(() => {
            waiters.delete(waiter);
            resolve();
          }, runtimeSettlementGraceMs);
          timer.unref?.();
          const waiters = outcomeWaiters.get(runtimeSessionId) ?? new Set<() => void>();
          waiters.add(waiter);
          outcomeWaiters.set(runtimeSessionId, waiters);
        });
      }
    },
    awaitRuntimeSignal: async () => {
      await new Promise<void>((resolve) => {
        const waiter = () => {
          signalWaiters.delete(waiter);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signalWaiters.delete(waiter);
          resolve();
        }, runtimeSettlementGraceMs);
        timer.unref?.();
        signalWaiters.add(waiter);
      });
    },
    runtime,
    status: () => {
      const status = supervisor.status();
      if (!closed && status.state === "attached") return status;
      const { projectionWatermark: _watermark, ledgerRevision: _revision, ...unreadable } = status;
      return unreadable;
    },
    statusCuts: () => {
      // A remote edge can serve its installed replica while its local writer/projection is
      // unavailable. Do not make host status depend on querying that unrelated local projection.
      if (closed || replicaOnly || supervisor.status().state !== "attached") return null;
      const status = supervisor.status();
      return { projectionWatermark: status.projectionWatermark, ledgerRevision: status.ledgerRevision };
    },
    inFlightWork: () => query("inFlightWork", [supervisor.status().queueDepth ?? 0]),
    settlePendingMaterialization: (context) => supervisor.request("settlePendingMaterialization", context),
    backup: (request) => supervisor.request("backup", request),
    pruneReplicationLog: (beforeSequence) => supervisor.request("pruneReplicationLog", beforeSequence),
    close: async () => {
      if (closed) return;
      closed = true;
      runtime.close();
      await terminal.close();
      try {
        await supervisor.close();
      } finally {
        replica.close();
        await reads.close();
        await lock.close();
      }
    },
  };
}
