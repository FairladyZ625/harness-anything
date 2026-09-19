import { requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../../daemon/src/dispatch-stream.ts";
import {
  eventObjectTarget,
  makeTaskEventStore,
  makeTaskProjection,
  type AgentRuntimeEventV1,
  type FrozenWritePlan,
} from "../../kernel/src/index.ts";
import type { WriterEpochFenceDescriptor } from "../../daemon/src/writer-epoch.ts";
import { seedTriadicEvents } from "../test-support/triadic-ledger.mjs";

export function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
export interface Failure {
  readonly ok: boolean;
  readonly error?: { readonly code: string; readonly hint?: string };
}
export const SEEDED_SQUAD_RUN_ID = "squad_aabbccddeeff001122334455";

/** 种一个已收敛的 squad run 状态(G12 §2c):与 `ha squad run` 的持久化路径同构 ——
 * 派工流头部 + squad_run_state 记录;worker 派工刻意不落流,断言读面以 null 呈现。 */
export async function seedSquadRunState(rootDir: string, repoId: string): Promise<string> {
  const squadRunId = SEEDED_SQUAD_RUN_ID,
    leaderDispatchId = "dispatch_0000000000000000000000a1",
    workerDispatchId = "dispatch_0000000000000000000000b2";
  openDispatchStream(rootDir, {
    dispatchId: leaderDispatchId,
    taskId: "task-gui-smoke",
    executionId: "execution-gui",
    runtimeSessionId: "runtime-squad-leader",
    instanceId: "codex-gui",
    startedAt: "2026-08-13T00:05:00.000Z",
    agentId: "terra",
    agentName: "terra",
  });
  appendRuntimeWorkerRecord(rootDir, leaderDispatchId, {
    kind: "squad_run_state",
    squadRunId,
    revision: 3,
    state: {
      schema: "squad-run/v1",
      squadRunId,
      stateDispatchId: leaderDispatchId,
      squadId: "core-squad",
      taskId: "task-gui-smoke",
      runtimeInstanceId: "codex-gui",
      cwd: rootDir,
      mission: "Resident GUI squad run",
      model: null,
      effort: null,
      leaderAgentId: "terra",
      roster: "terra » terra",
      workers: ["terra"],
      leaderTurnBudget: 8,
      binding: { actor: { principal: { personId: "person-gui" }, executor: null }, source: "local" },
      leaderTurns: [
        {
          turnId: "leader-1",
          trigger: { kind: "initial" },
          dispatchId: leaderDispatchId,
          runtimeSessionId: "runtime-squad-leader",
          decision: { kind: "converged" },
        },
      ],
      leaderProviderSessionId: null,
      currentLeaderRuntimeSessionId: null,
      workerAttempts: [
        {
          attemptId: "worker-1",
          workerId: "terra",
          leaderTurnId: "leader-1",
          dispatchId: workerDispatchId,
          runtimeSessionId: "runtime-squad-worker",
          rejection: null,
        },
      ],
      observedWorkerRuntimeSessionIds: [],
      workerWaits: [],
      pendingLeaderTriggers: [],
      phase: "converged",
      revision: 3,
      error: null,
    },
  });
  // 首次 daemon 已把「无 squad run」的缓存标成 ready;fixture 直接落流绕过了
  // production writeState 的 upsert,因此在重启前显式标脏,让 resident daemon
  // 按真实 recovery 路径从 squad_run_state 重放。
  const store = makeTaskEventStore({ rootDir, repoId }),
    projection = makeTaskProjection({ rootDir, eventStore: store });
  projection.markSquadRunProjectionDirty();
  projection.close();
  await store.drain();
  return squadRunId;
}

export async function seedRuntime(
  rootDir: string,
  repoId: string,
  writerFence: WriterEpochFenceDescriptor,
): Promise<void> {
  const store = makeTaskEventStore({ rootDir, repoId, writerFence: () => writerFence }),
    base = store.read().revision,
    values = [
      [
        "runtime_installation_observed",
        {
          installationId: "installation-gui",
          kindId: "codex",
          protocolFamily: "codex",
          hostRef: "host:gui",
          version: "1.0.0",
          discoverySource: "wrapper",
          capabilities: ["structured_witness", "attach"],
        },
      ],
      [
        "runtime_dispatch_requested",
        {
          dispatchId: "dispatch-gui",
          runtimeSessionId: "runtime-gui",
          instanceId: "codex-gui",
          installationId: "installation-gui",
          kindId: "codex",
          idempotencyKey: "gui",
          definitionSnapshotRef: "artifact:runtime-definition/gui",
          definitionSnapshot: {
            schema: "agent-definition-snapshot/v1",
            configVersion: 1,
            instanceId: "codex-gui",
            installationId: "installation-gui",
            kindId: "codex",
            providerId: "openai",
            model: "gpt-gui",
            reasoningEffort: null,
            baseUrl: null,
            authMode: "subscription",
          },
        },
      ],
      [
        "runtime_session_started",
        {
          runtimeSessionId: "runtime-gui",
          instanceId: "codex-gui",
          installationId: "installation-gui",
          kindId: "codex",
          definitionSnapshotRef: "artifact:runtime-definition/gui",
          launchGeneration: 1,
          attachable: true,
        },
      ],
      [
        "runtime_session_task_bound",
        {
          runtimeSessionId: "runtime-gui",
          taskId: "task-gui",
          executionId: "execution-gui",
          providerSessionId: "provider-gui",
          transcriptRef: "file:runtime/gui.jsonl",
        },
      ],
    ] as const;
  for (const [index, [type, payload]] of values.entries()) {
    const revision = base + index + 1,
      event = {
        schema: "agent-runtime-event/v1",
        eventId: `event-runtime-gui-${revision}`,
        workspaceRevision: revision,
        opId: `op-runtime-gui-${revision}`,
        actor: { principal: { personId: "person-gui" }, executor: null },
        source: "local",
        occurredAt: `2026-08-13T00:00:0${index}.000Z`,
        type,
        payload,
      } as AgentRuntimeEventV1;
    store.append({ event, plan: runtimeWritePlan(event), blobs: [] });
  }
  await store.drain();
  await seedTriadicEvents(rootDir, repoId, writerFence);
}
export function runtimeWritePlan(event: AgentRuntimeEventV1): FrozenWritePlan {
  return Object.freeze({
    commandType: event.type,
    targets: Object.freeze(
      [
        {
          kind: "event_file",
          path: eventObjectTarget(event.opId),
          operation: "create",
        },
        {
          kind: "event_head",
          path: "harness/events/head.json",
          operation: "replace",
        },
        {
          kind: "projection_invalidation",
          projection: "agent-runtime/v1",
          key: event.opId,
        },
      ].map((target) => Object.freeze(target)),
    ),
  }) as FrozenWritePlan;
}
export async function seedEntityDeclarations(endpoint: string, repoId: string): Promise<void> {
  const agent = {
      schema: "agent-declaration/v1",
      id: "terra",
      name: "Terra",
      instructions: "Review precisely.",
      runtimes: [{ type: "codex", model: "gpt-5.6-terra" }],
      instance: "codex-gui",
      skills: [{ id: "review", path: "skills/review" }],
      prompts: ["prompt://review"],
      preset: "standard-task",
    },
    squad = {
      schema: "squad-declaration/v1",
      id: "core-squad",
      name: "Core Squad",
      leader: "terra",
      workers: ["terra"],
      leaderTurnBudget: 8,
      roster: "# Core Squad\n\nTerra leads review.",
    };
  for (const [method, declaration] of [
    ["repo.agent.entity.write", agent],
    ["repo.squad.entity.write", squad],
  ] as const) {
    const result = await requestDaemonJsonRpcAt(
      endpoint,
      method,
      { repo: { repoId }, payload: { declaration } },
      1_000,
    );
    if (result.ok !== true) throw new Error(`GUI entity fixture failed: ${JSON.stringify(result)}`);
  }
}
