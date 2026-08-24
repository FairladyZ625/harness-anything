import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  eventObjectTarget,
  makeTaskEventStore,
  type AgentRuntimeEventV1,
  type FrozenWritePlan,
} from "../../kernel/src/index.ts";
import { seedTriadicEvents } from "../test-support/triadic-ledger.mjs";

export function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
export interface Failure {
  readonly ok: boolean;
  readonly error?: { readonly code: string; readonly hint: string };
}
export function seedRuntime(rootDir: string, repoId: string): void {
  const store = makeTaskEventStore({ rootDir, repoId }),
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
  void store.drain();
  seedTriadicEvents(rootDir, repoId);
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
export function seedEntityDeclarations(rootDir: string): void {
  const agent = {
      schema: "agent-declaration/v1",
      id: "terra",
      name: "Terra",
      instructions: "Review precisely.",
      runtime_type: "codex",
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
      roster: "# Core Squad\n\nTerra leads review.",
    };
  for (const declaration of [agent, squad]) {
    const store = path.join(
      rootDir,
      "harness",
      "schema" in declaration && declaration.schema === "agent-declaration/v1"
        ? "agents"
        : "squads",
    );
    mkdirSync(store, { recursive: true });
    writeFileSync(
      path.join(store, `${declaration.id}.json`),
      `${JSON.stringify(declaration, null, 2)}\n`,
    );
  }
}
