import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/client";
import {
  eventObjectTarget,
  makeTaskEventStore,
  type AgentRuntimeEventV1,
  type FrozenWritePlan,
} from "@harness-anything/kernel";
import type { WriterEpochFenceDescriptor } from "@harness-anything/daemon/client";
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

/** Seed accepted events; the public reader must work without owner control files. */
export async function seedSquadRunState(
  rootDir: string,
  repoId: string,
  writerFence: WriterEpochFenceDescriptor,
): Promise<string> {
  const store = makeTaskEventStore({ rootDir, repoId, writerFence: () => writerFence }),
    squadRunId = SEEDED_SQUAD_RUN_ID,
    dispatchId = "dispatch_0000000000000000000000a1",
    identity = {
      squadRunId,
      squadId: "core-squad",
      taskId: "task-gui-smoke",
      executionId: "execution-gui",
      mission: "Resident GUI squad run",
      leaderAgentId: "terra",
    },
    definitionSnapshot = {
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
    values = [
      {
        type: "runtime_dispatch_requested",
        payload: {
          dispatchId,
          runtimeSessionId: "runtime-squad-leader",
          instanceId: "codex-gui",
          installationId: "installation-gui",
          kindId: "codex",
          idempotencyKey: "squad-gui",
          definitionSnapshotRef: "artifact:runtime-definition/squad-gui",
          definitionSnapshot,
          taskId: identity.taskId,
          executionId: identity.executionId,
          squadRun: identity,
        },
      },
      {
        type: "runtime_squad_run_observed",
        payload: {
          ...identity,
          ownerDispatchId: dispatchId,
          runRevision: 3,
          phase: "converged",
          error: null,
          currentLeaderRuntimeSessionId: null,
          leaderTurns: [
            {
              turnId: "leader-1",
              trigger: { kind: "initial" },
              dispatchId,
              runtimeSessionId: "runtime-squad-leader",
              decision: { kind: "converged" },
            },
          ],
          workerAttempts: [
            {
              attemptId: "worker-1",
              workerId: "terra",
              leaderTurnId: "leader-1",
              taskId: null,
              executionId: null,
              dispatchId: null,
              runtimeSessionId: null,
              rejection: null,
              branch: null,
              baseSha: null,
            },
          ],
          workerCallbackCount: 0,
          pendingLeaderCallbackCount: 0,
          synthesisReportPath: `artifacts/reports/${squadRunId}.md`,
        },
      },
    ];
  for (const value of values) {
    const revision = store.read().revision + 1,
      event = {
        schema: "agent-runtime-event/v1",
        eventId: `squad-gui-${revision}`,
        opId: `squad-gui-${revision}`,
        workspaceRevision: revision,
        actor: { principal: { personId: "person-gui" }, executor: null },
        source: "local",
        occurredAt: "2026-08-13T00:05:00.000Z",
        ...value,
      } as AgentRuntimeEventV1;
    store.append({ event, plan: runtimeWritePlan(event), blobs: [] });
  }
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
          dispatchId: "dispatch_0123456789abcdef01234567",
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
