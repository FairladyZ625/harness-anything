import {
  cliInput,
  defineCliCommand,
  defineRepoReadCommand,
  presetCommands,
  presetMethods,
} from "../../../preset/src/preset-command-contract.ts";
import type { EntityActionContract } from "../../../kernel/src/index.ts";
import { agentProtocolCommands } from "./daemon-protocol-commands-agent.ts";
import { decisionLifecycleProtocolCommands } from "./daemon-protocol-commands-decision-lifecycle.ts";
import { decisionRelationProtocolCommands } from "./daemon-protocol-commands-decision-relations.ts";
import { docFactProtocolCommands } from "./daemon-protocol-commands-doc-fact.ts";
import { eventProtocolCommands } from "./daemon-protocol-commands-event.ts";
import { runtimeConfigProtocolCommands } from "./daemon-protocol-commands-runtime-config.ts";
import { runtimeFleetProtocolCommands, scheduleProtocolCommands } from "./daemon-protocol-commands-runtime-fleet.ts";
import { taskSurfaceProtocolCommands } from "./daemon-protocol-commands-task-surface.ts";
import { taskExecutionProtocolCommands } from "./daemon-protocol-commands-task.ts";
import { peopleProtocolCommands } from "./daemon-protocol-commands-people.ts";
import { ciObservationProtocolCommands } from "./daemon-protocol-commands-ci.ts";
import { relationProtocolCommands } from "./daemon-protocol-commands-relation.ts";
import { daemonGuiActionMethods, daemonStreamFacets } from "./daemon-protocol-gui-actions.ts";
import { daemonGuiReadMethods } from "./daemon-protocol-gui-reads.ts";
import { DaemonProtocolContractError, type JsonObject } from "./json-rpc-types.ts";
import { AGENDA_PIN_CRITERIA } from "./daemon-protocol-vocabulary.ts";

const settingsWriteTopology = {
    commandClass: "repo-write" as const,
    admission: {
      local: "direct" as const,
      "remote-proxy": "rejected" as const,
      "remote-center": "direct" as const,
      "remote-edge": "via-center-forward" as const,
    },
  },
  settingValueInput = (name: string) =>
    cliInput(
      name,
      "single",
      false,
      {
        code: "invalid_field",
      },
      { regex: "^[A-Za-z0-9][A-Za-z0-9/_.@-]*$" },
    ),
  positiveSettingInput = (name: string) =>
    cliInput(name, "single", false, { code: "invalid_field" }, { regex: "^[1-9][0-9]*$" }),
  settingsProtocolCommands = Object.freeze([
    defineRepoReadCommand({
      id: "settings-read",
      actionKind: "settings-read",
      phase: "Settings-Kind",
      path: ["settings", "read"],
      summary: "Read the repository Settings entity from the canonical projection.",
      method: "repo.task.read",
      inputs: [],
    }),
    defineRepoReadCommand({
      id: "settings-show",
      actionKind: "settings-read",
      phase: "Settings-Kind",
      path: ["settings", "show"],
      summary: "Alias of settings read: show the repository Settings entity from the canonical projection.",
      method: "repo.task.read",
      inputs: [],
    }),
    defineCliCommand({
      id: "settings-update",
      actionKind: "settings-update",
      phase: "Settings-Kind",
      path: ["settings", "update"],
      summary: "Update the Settings-owned harness.yaml facet through the canonical writer.",
      method: "repo.task.run",
      inputs: [
        settingValueInput("--default-vertical"),
        settingValueInput("--default-preset"),
        settingValueInput("--default-profile"),
        settingValueInput("--default-reviewer"),
        cliInput(
          "--review-independence",
          "single",
          false,
          { code: "invalid_field" },
          {
            enum: ["execution", "principal"],
          },
        ),
        positiveSettingInput("--review-return-budget"),
        cliInput("--closeout-profile", "single", false, { code: "invalid_field" }, { enum: ["standard", "strict"] }),
        cliInput("--closeout-review", "single", false, { code: "invalid_field" }, { enum: ["true", "false"] }),
        cliInput("--closeout-consent", "single", false, { code: "invalid_field" }, { enum: ["true", "false"] }),
        cliInput(
          "--closeout-fact-disposition",
          "single",
          false,
          { code: "invalid_field" },
          { enum: ["true", "false"] },
        ),
        cliInput("--closeout-code-doc", "single", false, { code: "invalid_field" }, { enum: ["true", "false"] }),
        cliInput(
          "--locale",
          "single",
          false,
          {
            code: "invalid_field",
          },
          { enum: ["en-US", "zh-CN"] },
        ),
        settingValueInput("--task-scaffold"),
        settingValueInput("--repository-scaffold"),
        cliInput("--wal-flush-adaptive", "single", false, { code: "invalid_field" }, { enum: ["true", "false"] }),
        positiveSettingInput("--wal-flush-events"),
        positiveSettingInput("--wal-flush-bytes"),
        positiveSettingInput("--wal-flush-milliseconds"),
        cliInput(
          "--ci-workflows",
          "repeated",
          false,
          { code: "invalid_field" },
          {
            regex: "^[A-Za-z0-9][A-Za-z0-9/_.@-]*$",
            format: "workflow names, or none to disable CI witnessing (unconfigured repositories witness none)",
          },
        ),
        cliInput(
          "--gates-from-document",
          "boolean",
          false,
          { code: "invalid_field" },
          {
            format: "import the settings.gates block declared in harness.yaml",
          },
        ),
        cliInput(
          "--expected-version",
          "single",
          false,
          {
            code: "invalid_field",
          },
          { regex: "^(?:0|[1-9][0-9]*)$", projection: "number" as const },
        ),
        cliInput("--idempotency-key", "single", false, {
          code: "invalid_field",
        }),
      ],
      ...settingsWriteTopology,
    }),
  ]);

const doctorProtocolCommands = Object.freeze([
  defineRepoReadCommand({
    id: "doctor-health",
    actionKind: "doctor-health",
    phase: "W3",
    path: ["doctor", "health"],
    summary:
      "Run the read-only repository health checks behind ha doctor: delivered cuts, executor " +
      "attribution, orphan leases, WIP pressure, caller-visible doc debt, and build drift.",
    method: "repo.task.read",
    inputs: [],
  }),
]);
const entityPinProtocolCommands = Object.freeze([
  defineCliCommand({
    id: "entity-pin",
    phase: "Entity-Pin",
    path: ["pin", "<entity-ref>"],
    summary: `Pin an existing entity only when it is ${AGENDA_PIN_CRITERIA}.`,
    method: "repo.task.run",
    inputs: [],
    ...settingsWriteTopology,
  }),
  defineCliCommand({
    id: "entity-unpin",
    phase: "Entity-Pin",
    path: ["unpin", "<entity-ref>"],
    summary: "Remove an entity from the repository agenda pins.",
    method: "repo.task.run",
    inputs: [],
    ...settingsWriteTopology,
  }),
]);

export const daemonOwnedProtocolCommands = Object.freeze([
  ...entityPinProtocolCommands,
  ...taskSurfaceProtocolCommands,
  ...doctorProtocolCommands,
  ...agentProtocolCommands,
  ...taskExecutionProtocolCommands,
  ...docFactProtocolCommands,
  ...decisionLifecycleProtocolCommands,
  ...decisionRelationProtocolCommands,
  ...relationProtocolCommands,
  ...runtimeConfigProtocolCommands,
  ...runtimeFleetProtocolCommands,
  ...scheduleProtocolCommands,
  ...settingsProtocolCommands,
  ...eventProtocolCommands,
  ...peopleProtocolCommands,
  ...ciObservationProtocolCommands,
] as const);

export const daemonProtocolCommands = Object.freeze([...daemonOwnedProtocolCommands, ...presetCommands] as const);

export const thinCliCommands = Object.freeze(
  daemonProtocolCommands.filter((command) => !("internal" in command && command.internal)).map((command) => command),
);

export function resolveThinCliCommand(args: readonly string[]): (typeof daemonProtocolCommands)[number] | undefined {
  const matches = daemonProtocolCommands.filter(
    (entry) => !("internal" in entry && entry.internal) && entry.path.every((token, index) => args[index] === token),
  );
  if (matches.length < 2) return matches[0];
  const target = args[matches[0]!.path.length] ?? "";
  return matches.find((entry) =>
    "positionalFields" in entry
      ? target.startsWith("preset:")
      : "positionalRegex" in entry
        ? new RegExp(entry.positionalRegex, "u").test(target)
        : true,
  );
}

// The Task Action explain catalog must quote the command the router actually
// accepts, so usage comes from the protocol declaration, never a second
// synthesis of the ingress name.
export function taskActionCommandUsage(action: EntityActionContract): string {
  const ingress = action.execution?.ingress;
  if (!ingress) throw new Error(`Task Action ${action.id} has no Task command ingress.`);
  const command = daemonProtocolCommands.find((entry) => entry.id === ingress);
  if (!command) throw new Error(`Task Action ${action.id} ingress ${ingress} has no protocol command.`);
  return command.usage;
}

export function commandDescriptorForAction(kind: string) {
  const descriptor = commandDescriptorByActionKind.get(kind) ?? presetMethodByActionKind.get(kind);
  if (!descriptor)
    throw new DaemonProtocolContractError("unsupported_command", `No command descriptor exists for ${kind}.`);
  return descriptor;
}

export function commandClassForAction(kind: string): "repo-read" | "repo-write" | "arbiter" | "admin" {
  return commandDescriptorForAction(kind).commandClass;
}

export function actionForDaemonMethod(method: string, payload: JsonObject): JsonObject & { readonly kind: string } {
  if (method === "repo.task.run" || method === "repo.task.read") {
    const action = payload.action as JsonObject & { readonly kind: string },
      descriptor = commandDescriptorByActionKind.get(action.kind);
    if (descriptor?.method !== method)
      throw new DaemonProtocolContractError(
        "unsupported_command",
        `${action.kind} requires its closed method descriptor.`,
      );
    return action;
  }
  const descriptor = actionDescriptorByMethod.get(method);
  if (!descriptor)
    throw new DaemonProtocolContractError("unsupported_command", `No action descriptor exists for ${method}.`);
  // A GUI action may pin the closed parts of its action the renderer cannot say
  // (repo.task.pin's pinned-only amend patch); the declared payload is spread last,
  // so the ingress stays the only writer of those fields.
  const command = presetCommandByMethod.get(method),
    defaults =
      "actionDefaults" in descriptor
        ? descriptor.actionDefaults
        : command && "actionDefaults" in command
          ? command.actionDefaults
          : {};
  return { ...defaults, kind: descriptor.actionKind, ...payload };
}

const commandDescriptorByActionKind: ReadonlyMap<string, (typeof daemonProtocolCommands)[number]> = new Map(
    [...daemonProtocolCommands].reverse().map((entry) => ["actionKind" in entry ? entry.actionKind : entry.id, entry]),
  ),
  presetMethodByActionKind: ReadonlyMap<string, (typeof presetMethods)[number]> = new Map(
    presetMethods.map((entry) => [entry.actionKind, entry]),
  ),
  actionDescriptorByMethod: ReadonlyMap<
    string,
    (typeof presetMethods)[number] | (typeof daemonGuiActionMethods)[number]
  > = new Map([...presetMethods, ...daemonGuiActionMethods].map((entry) => [entry.method, entry])),
  presetCommandByMethod: ReadonlyMap<string, (typeof presetCommands)[number]> = new Map(
    presetCommands.map((entry) => [entry.method, entry]),
  );

// Method-name sets consumed by the RPC validation entry; built once beside the descriptor maps.
export const daemonMethodNameSets: {
  readonly guiRead: ReadonlySet<string>;
  readonly guiAction: ReadonlySet<string>;
  readonly stream: ReadonlySet<string>;
} = {
  guiRead: new Set(daemonGuiReadMethods.map((entry) => entry.method)),
  guiAction: new Set(daemonGuiActionMethods.map((entry) => entry.method)),
  stream: new Set(daemonStreamFacets.map((entry) => entry.method)),
};
