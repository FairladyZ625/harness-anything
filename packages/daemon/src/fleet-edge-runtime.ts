import { readFileSync } from "node:fs";
import path from "node:path";
import {
  openEntityStore,
  resolveHarnessLayout,
  type AgentRuntimeEventV1,
  type EntityStore,
} from "../../kernel/src/index.ts";
import { readAgentDeclaration, resolveSquadDispatchTarget } from "./agent-entities.ts";
import type { PreparedRuntimeLaunch, RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import {
  readFleetAssignmentClient,
  readFleetReceiptClient,
  runFleetRuntimeArchiveClient,
  runFleetRuntimeEventClient,
  runFleetRuntimeReadClient,
  type FleetPeerOptions,
} from "./fleet/edge.ts";
import { fleetEdgeCredential } from "./fleet-edge-task.ts";
import { locateFleetMirrorView } from "./fleet-edge-mirror.ts";
import { validateAgentRuntimeOverview, type AgentRuntimeOverviewResult } from "./agent-runtime-contract.ts";
import { makeRuntimeSpawner, type RuntimeDaemonRoute, type RuntimeLauncher } from "./runtime-spawn.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";

export interface FleetEdgeRuntimeRequest {
  readonly payload: {
    readonly host: string;
    readonly port: number;
    readonly caPath: string;
    readonly servername?: string;
    readonly nodeId: string;
    readonly credential?: string;
    readonly rosterPath?: string;
    readonly assignmentId: string;
    readonly repoId: string;
    readonly viewRoot: string;
    readonly quotaBytes: number;
    readonly workspaceRoot: string;
    readonly method:
      | "repo.agentRuntime.spawn"
      | "repo.agentRuntime.cancel"
      | "repo.agentRuntime.overview"
      | "repo.agentRuntime.sessions.read";
    readonly action: JsonObject;
  };
}
type RuntimePorts = {
  readonly runtimeInstances: () => readonly RuntimeInstanceSummary[];
  readonly prepareRuntimeLaunch: (
    instanceId: string,
    request: {
      readonly cwd: string;
      readonly prompt: string;
      readonly model?: string;
      readonly effort?: string;
      readonly providerSessionId?: string;
      readonly permissionMode?: string;
    },
  ) => Promise<PreparedRuntimeLaunch>;
  readonly prepareWorkerGitEnvironment: (instanceId: string) => Promise<NodeJS.ProcessEnv | null>;
};
const runtimeOverviewPageLimit = 16;

export async function readFleetRuntimeSessionsPaged(readPage: (payload: JsonObject) => Promise<unknown>): Promise<
  readonly {
    readonly runtimeSessionId: string;
    readonly providerSessionId: string | null;
    readonly instanceId: string;
    readonly liveness: "live" | "stale" | "unknown" | "exited";
    readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | null;
  }[]
> {
  const sessions: Array<{
    readonly runtimeSessionId: string;
    readonly providerSessionId: string | null;
    readonly instanceId: string;
    readonly liveness: "live" | "stale" | "unknown" | "exited";
    readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | null;
  }> = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await readPage({ limit: runtimeOverviewPageLimit, ...(cursor === null ? {} : { cursor }) });
    const issues = validateAgentRuntimeOverview(result);
    if (issues.length) throw edgeRuntimeError("runtime_read_invalid", issues.join("; "));
    const overview = result as AgentRuntimeOverviewResult;
    if (!overview.page)
      throw edgeRuntimeError("runtime_read_invalid", "A paged runtime overview omitted its page receipt.");
    sessions.push(
      ...overview.sessions.map(({ runtimeSessionId, providerSessionId, instanceId, liveness, activity }) => ({
        runtimeSessionId,
        providerSessionId,
        instanceId,
        liveness,
        outcome: activity.outcome,
      })),
    );
    cursor = overview.page.nextCursor;
    if (cursor !== null && seen.has(cursor))
      throw edgeRuntimeError("runtime_read_invalid", `Runtime overview repeated cursor ${cursor}.`);
    if (cursor !== null) seen.add(cursor);
  } while (cursor !== null);
  return sessions;
}

export function openFleetEdgeRuntime(input: {
  readonly request: FleetEdgeRuntimeRequest["payload"];
  readonly daemonGeneration: number;
  readonly daemonRoute: RuntimeDaemonRoute;
  readonly ports: RuntimePorts;
  readonly launch?: RuntimeLauncher;
  readonly now?: () => string;
}) {
  // Provider signals already remain in the edge-local dispatch JSONL, while remote status
  // polls the canonical session read below. Forwarding stream frames would create a second,
  // non-canonical synchronization surface with no consumer or settlement contract.
  const request = input.request,
    credential = fleetEdgeCredential(request.nodeId, request.credential, request.rosterPath),
    peer: FleetPeerOptions = {
      hostname: request.host,
      port: request.port,
      ca: readFileSync(request.caPath, "utf8"),
      ...(request.servername ? { servername: request.servername } : {}),
      nodeId: request.nodeId,
      credential,
      assignmentId: request.assignmentId,
    },
    runtimeReadTimeoutMs = readFleetEdgeConfig(request.workspaceRoot)?.waitTimeoutMs,
    runtimeReadPeer: FleetPeerOptions = {
      ...peer,
      ...(runtimeReadTimeoutMs === undefined ? {} : { timeoutMs: runtimeReadTimeoutMs }),
    },
    now = input.now ?? (() => new Date().toISOString()),
    stream = { publish: () => ({}) as never };
  let entityStore: EntityStore | undefined;
  const getEntityStore = (): EntityStore => (entityStore ??= openEntityStore(request.workspaceRoot));
  let tail = Promise.resolve();
  const schedule = (work: () => void | Promise<void>): void => {
    tail = tail.then(work).then(
      () => undefined,
      () => undefined,
    );
  };
  const spawner = makeRuntimeSpawner({
    repoId: request.repoId,
    rootDir: request.workspaceRoot,
    daemonGeneration: input.daemonGeneration,
    runtimeDaemonRoute: input.daemonRoute,
    remote: {
      existing: async (opId) => {
        const receipt = await readFleetReceiptClient({ ...peer, opId });
        return receipt.opId === opId && ["applied", "pending"].includes(String(receipt.outcome))
          ? (receipt as JsonObject)
          : null;
      },
      taskContext: async (taskId) => {
        const assigned = await readFleetAssignmentClient(peer);
        if (assigned.repoId !== request.repoId || assigned.taskId !== taskId)
          throw edgeRuntimeError(
            "assignment_scope_mismatch",
            `Task ${taskId} is outside assignment ${request.assignmentId}.`,
          );
        const view = locateFleetMirrorView(request.viewRoot, request.repoId);
        const materializedRoot = resolveHarnessLayout(request.workspaceRoot).authoredRoot;
        const packagePathsFor = (logical: string): string[] => {
          const packagePath = logical.slice(0, -"/INDEX.md".length);
          const indexPath = path.join(materializedRoot, ...logical.split("/"));
          try {
            const body = readFileSync(indexPath, "utf8");
            return body.split(/\r?\n/u).some((line) => line === `task_id: ${taskId}` || line === `taskId: ${taskId}`)
              ? [packagePath]
              : [];
          } catch {
            return [];
          }
        };
        const candidates =
          view === null
            ? []
            : [...view.entries.keys()]
                .filter((logical) => logical.startsWith("tasks/") && logical.endsWith("/INDEX.md"))
                .flatMap(packagePathsFor);
        if (view === null || candidates.length !== 1)
          throw edgeRuntimeError(
            "runtime_task_package_unavailable",
            `Task ${taskId} requires exactly one current mirrored task package;` +
              " run ha daemon fleet edge sync, then retry.",
          );
        const packageRoot = path.join(materializedRoot, ...candidates[0]!.split("/"));
        const planPath = path.join(packageRoot, "task_plan.md");
        let plan: string;
        try {
          plan = readFileSync(planPath, "utf8");
        } catch {
          throw edgeRuntimeError(
            "runtime_task_package_unavailable",
            `Task ${taskId} has no readable mirrored task plan; run ha daemon fleet edge sync, then retry.`,
          );
        }
        return {
          executionId: assigned.executionId,
          packageRoot,
          planPath,
          plan,
          mission: `Your task package is ${packageRoot}.\nRead task_plan.md in that package and complete the task.`,
        };
      },
      readRuntimeSessions: () =>
        readFleetRuntimeSessionsPaged((payload) =>
          runFleetRuntimeReadClient({
            ...runtimeReadPeer,
            repoId: request.repoId,
            method: "repo.agentRuntime.overview",
            payload,
          }),
        ),
      publish: async (draft) => {
        const response = await runFleetRuntimeEventClient({
          ...peer,
          repoId: request.repoId,
          opId: draft.opId,
          eventType: draft.type,
          payload: draft.payload,
          ...(draft.resultBody === undefined ? {} : { resultBody: draft.resultBody }),
        });
        return { event: response.event as unknown as AgentRuntimeEventV1, receipt: response.receipt as JsonObject };
      },
      archive: async (archive) =>
        (await runFleetRuntimeArchiveClient({
          ...peer,
          repoId: request.repoId,
          archive: archive as unknown as Readonly<Record<string, unknown>>,
        })) as { readonly outcome: string; readonly nextAction?: string },
    },
    stream,
    now,
    runtimeInstances: input.ports.runtimeInstances,
    prepareLaunch: input.ports.prepareRuntimeLaunch,
    prepareWorkerGitEnvironment: input.ports.prepareWorkerGitEnvironment,
    resolveAgent: (agentId) =>
      readAgentDeclaration({ rootDir: request.workspaceRoot, agentId, entityStore: getEntityStore() }),
    resolveSquadDispatchTarget: (leaderId, workerId) =>
      resolveSquadDispatchTarget({
        rootDir: request.workspaceRoot,
        leaderId,
        workerId,
        entityStore: getEntityStore(),
      }),
    ...(input.launch ? { launch: input.launch } : {}),
    schedule,
  });
  const ready = spawner.adopt();
  return {
    run: async (method: FleetEdgeRuntimeRequest["payload"]["method"], action: JsonObject): Promise<JsonObject> => {
      await ready;
      return method === "repo.agentRuntime.spawn"
        ? spawner.spawn(action, edgeBinding())
        : method === "repo.agentRuntime.cancel"
          ? spawner.cancel(action, edgeBinding())
          : ((await runFleetRuntimeReadClient({
              ...runtimeReadPeer,
              repoId: request.repoId,
              method,
              payload: action,
            })) as JsonObject);
    },
    close: () => {
      spawner.close();
    },
  };
}

function edgeBinding() {
  return { actor: { principal: { personId: "fleet-edge" }, executor: null }, source: "local" as const };
}
function edgeRuntimeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
