import { orchestrateRuntimeSessionsAwait } from "../../src/runtime-orchestration.ts";
import { readSquadRecoveryState } from "../../src/squad-run-state.ts";
import { READ_SESSION_ID } from "./g38-read-ledger.mjs";
import { readRollback } from "../../../cli/test/fixtures/g38-read-rollback.mjs";
import { readEffectiveDispatchArchiveRetention } from "../../src/repo-cell-settings-state.ts";
import { readFactEvidenceSources } from "../../src/dispatch-stream-archive.ts";
import { ARCHIVE_READ_PROBES } from "./g38-read-archive.mjs";
import { readHomeOverview } from "../../src/home/home-overview-read.ts";
import { readFleetOverviewFromHost } from "../../src/fleet/fleet-overview-read.ts";
import { readClaimableTasks } from "../../src/task-claimable-read.ts";
import { readEntityAssignmentDirectory } from "../../src/entity-assignment-directory.ts";
import { readRepoInFlightWork } from "../../src/repo-in-flight-work.ts";
import { makeScheduleScheduler } from "../../src/schedule-scheduler.ts";
import { READ_TASK_ID } from "./g38-read-ledger.mjs";
import assert from "node:assert/strict";
import { createJsonRpcProtocolServer } from "../../src/protocol/json-rpc-server.ts";
import { daemonHelloParams } from "../../src/client/daemon-hello.ts";
const now = () => "2026-11-05T00:00:00.000Z";

export const HOST_READ_PROBES = {
  ...ARCHIVE_READ_PROBES,
  "protocol-lifecycle-enable": {
    reads: ["method:protocol.dispatchLifecycle.enable"],
    run: async () => {
      const server = createJsonRpcProtocolServer({
        host: new Proxy(
          {},
          {
            get: () => {
              throw new Error("Negotiation must not access repository state");
            },
          },
        ),
        build: { loadedBuildId: null, commit: null, builtAt: null },
        authContext: { transportKind: "unix-socket" },
        emit: async () => undefined,
      });
      try {
        await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: daemonHelloParams() });
        const response = await server.handle({
          jsonrpc: "2.0",
          id: 2,
          method: "protocol.dispatchLifecycle.enable",
          params: {},
        });
        assert.equal(response.result.ok, true);
        return response.result;
      } finally {
        server.close();
      }
    },
    size: () => 1,
  },
  "agent-rollback": {
    reads: ["command:agent-rollback"],
    run: readRollback,
    size: () => 1,
  },
  "archive-retention-inputs": {
    reads: ["background:archive-retention-inputs"],
    run: ({ projection }) => ({
      policy: readEffectiveDispatchArchiveRetention(projection),
      sources: readFactEvidenceSources(projection),
    }),
    size: (value) => value.sources.length,
  },
  "runtime-await": {
    reads: ["command:runtime-sessions-await", "method:repo.agentRuntime.sessions.await"],
    run: ({ runtime }) =>
      orchestrateRuntimeSessionsAwait(
        { runtimeSessionIds: [READ_SESSION_ID] },
        {
          readSession: (runtimeSessionId) => runtime.read("repo.agentRuntime.sessions.read", { runtimeSessionId }),
          readTaskDispatches: (taskIds) => runtime.read("repo.task.dispatches", { taskIds }),
          awaitSignal: () => {
            throw new Error("The seeded completed runtime did not settle");
          },
          codedError: (code, message) => Object.assign(new Error(message), { code }),
        },
      ),
    size: () => 1,
  },
  "squad-recovery": {
    reads: ["background:squad-recovery"],
    run: ({ rootDir, projection }) => readSquadRecoveryState(rootDir, projection),
    size: (result) => result.states.size,
  },
  "agent-version-rpc": {
    reads: ["method:repo.agent.version.read"],
    run: ({ runtime, projection }) =>
      runtime.read("repo.agent.version.read", {
        agentId: "g38-agent",
        revision: projection.getEntity("agent", "g38-agent").workspaceRevision,
      }),
    size: () => 1,
  },

  "home-overview": {
    reads: ["method:daemon.gui.home.read"],
    run: ({ runtime }) =>
      readHomeOverview({
        context: {
          input: { userRoot: runtime.userRoot },
          cells: new Map([["g38-read", runtime]]),
          warming: new Map(),
          unavailable: new Map(),
        },
        auth: {},
        timeoutMs: 30000,
      }),
    size: (result) => {
      if (result.repos.some((repo) => repo.status === "unavailable"))
        throw new Error("Home overview degraded instead of executing its reads");
      return result.repos.length;
    },
  },
  "fleet-overview": {
    reads: ["method:repo.fleet.overview.read"],
    run: ({ runtime }) =>
      readFleetOverviewFromHost({
        repoId: "g38-read",
        mode: "local",
        cell: runtime,
        binding: runtime.binding,
        fleetReplicas: [],
        nodeSessions: [],
        keycloakCenter: runtime.keycloakCenter,
        now: now(),
        userRoot: runtime.userRoot,
        daemon: { daemonId: "g38", startedAt: now() },
      }),
    size: () => 1,
  },
  "claimable-tasks": {
    reads: ["method:repo.tasks.claimable"],
    run: ({ runtime }) =>
      readClaimableTasks({
        repoId: "g38-read",
        binding: runtime.nodeBinding,
        settings: runtime.settings.read(),
        now: now(),
        page: (query) => runtime.read("repo.tasks.list", query),
        readTask: async (taskId) => (await runtime.read("repo.tasks.runtimeContext.read", { taskId })).snapshot.task,
        readAssignments: async () =>
          (
            await runtime.read("repo.triadic.relationGraph", {
              facet: "edges",
              relationType: "assigned-to",
              state: "active",
              limit: 500,
            })
          ).edges,
      }),
    size: (result) => result.tasks.length,
  },
  "assignment-directory": {
    reads: ["method:repo.tasks.assignmentDirectory"],
    run: ({ runtime }) =>
      readEntityAssignmentDirectory(
        "g38-read",
        `task/${READ_TASK_ID}`,
        runtime.binding,
        async (taskId) => (await runtime.read("repo.tasks.runtimeContext.read", { taskId })).snapshot.task,
      ),
    size: (result) => result.people.length + result.nodes.length + result.teams.length,
  },
  "explain-actions": {
    reads: ["command:explain", "method:repo.entity.actions.explain"],
    run: ({ runtime }) =>
      runtime.read(
        "repo.entity.actions.explain",
        {
          schema: "entity-action-explain-request/v1",
          mode: "object",
          entityKind: null,
          refs: [`task/${READ_TASK_ID}`],
        },
        runtime.binding,
      ),
    size: (result) => result.subjects.length,
  },
  "event-tail": {
    reads: ["method:observe.tail"],
    run: ({ runtime }) =>
      runtime.observeTail({ kind: "events", direction: "history" }, { userRoot: runtime.userRoot, daemonId: "g38" }),
    size: (result) => result.items.length,
  },
  "schedule-poll": {
    reads: ["background:schedule-poll"],
    run: async ({ runtime }) => {
      const scheduler = makeScheduleScheduler({
        cells: new Map([["g38-read", runtime]]),
        localBinding: () => runtime.binding,
        now,
        setTimer: () => 0,
        clearTimer: () => {},
      });
      try {
        await scheduler.start();
      } finally {
        scheduler.close();
      }
    },
    size: () => 0,
  },
  "in-flight-work": {
    reads: ["background:in-flight-work"],
    run: ({ projection }) => readRepoInFlightWork({ projection, repoId: "g38-read", queueDepth: 0 }),
    size: (result) => result.length,
  },
  "node-auto-claim-assignments": {
    reads: ["background:node-auto-claim-assignments"],
    run: ({ runtime }) => runtime.readNodeAutoClaimAssignments(runtime.nodeBinding),
    size: (result) => result.length,
  },
};
