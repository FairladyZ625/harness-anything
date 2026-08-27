import {
  cliInput,
  defineCliCommand,
  defineRepoReadCommand,
  presetCommands,
  presetMethods,
} from "../../../preset/src/preset-command-contract.ts";
import { agentProtocolCommands } from "./daemon-protocol-commands-agent.ts";
import { decisionLifecycleProtocolCommands } from "./daemon-protocol-commands-decision-lifecycle.ts";
import { decisionRelationProtocolCommands } from "./daemon-protocol-commands-decision-relations.ts";
import { docFactProtocolCommands } from "./daemon-protocol-commands-doc-fact.ts";
import { runtimeConfigProtocolCommands } from "./daemon-protocol-commands-runtime-config.ts";
import { runtimeFleetProtocolCommands, scheduleProtocolCommands } from "./daemon-protocol-commands-runtime-fleet.ts";
import { taskSurfaceProtocolCommands } from "./daemon-protocol-commands-task-surface.ts";
import { taskExecutionProtocolCommands } from "./daemon-protocol-commands-task.ts";
import { daemonGuiActionMethods } from "./daemon-protocol-gui-actions.ts";
import { DaemonProtocolContractError, type JsonObject } from "./json-rpc-types.ts";

const settingsWriteTopology = {
    commandClass: "repo-write" as const,
    admission: {
      local: "direct" as const,
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
        nextAction: `Use ${name} with a non-empty Settings identifier or relative scaffold path.`,
      },
      { regex: "^[A-Za-z0-9][A-Za-z0-9/_.@-]*$" },
    ),
  settingsProtocolCommands = Object.freeze([
    defineRepoReadCommand({
      id: "settings-read",
      actionKind: "settings-read",
      phase: "Settings-Kind",
      path: ["settings", "read"],
      summary: "Read the repository Settings entity from the canonical projection.",
      method: "repo.settings.read",
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
        cliInput(
          "--locale",
          "single",
          false,
          {
            code: "invalid_field",
            nextAction: "Use --locale en-US or --locale zh-CN.",
          },
          { enum: ["en-US", "zh-CN"] },
        ),
        settingValueInput("--task-scaffold"),
        settingValueInput("--repository-scaffold"),
        cliInput("--idempotency-key", "single", false, {
          code: "invalid_field",
          nextAction: "Use one stable non-empty idempotency key, or omit it for automatic allocation.",
        }),
      ],
      ...settingsWriteTopology,
    }),
  ]);

export const daemonOwnedProtocolCommands = Object.freeze([
  ...taskSurfaceProtocolCommands,
  ...agentProtocolCommands,
  ...taskExecutionProtocolCommands,
  ...docFactProtocolCommands,
  ...decisionLifecycleProtocolCommands,
  ...decisionRelationProtocolCommands,
  ...runtimeConfigProtocolCommands,
  ...runtimeFleetProtocolCommands,
  ...scheduleProtocolCommands,
  ...settingsProtocolCommands,
] as const);

export const runtimePromptInputs = daemonOwnedProtocolCommands
  .find((command) => command.id === "runtime-run")!
  .inputs.filter((input) => ["--prompt", "--prompt-file"].includes(input.name));

export const squadPromptInputs = runtimePromptInputs.map(
  (input) =>
    ({
      ...input,
      error: {
        code: "invalid_field",
        nextAction: "Use exactly one of --prompt <text> or --prompt-file <path>.",
      },
    }) as const,
);

export const effectiveDaemonOwnedProtocolCommands = Object.freeze(
  daemonOwnedProtocolCommands.map((command) =>
    command.id === "repo-bootstrap"
      ? defineCliCommand({
          ...command,
          inputs: [
            ...command.inputs,
            cliInput("--add-npm-scripts", "boolean", false, {
              code: "invalid_field",
              nextAction: "Use --add-npm-scripts once.",
            }),
          ],
        })
      : command,
  ),
);

export const squadBoundaryProtocolCommands = Object.freeze(
  effectiveDaemonOwnedProtocolCommands.map((command) =>
    command.id === "squad-run"
      ? defineCliCommand({
          ...command,
          inputs: [...command.inputs.filter((input) => input.name !== "--prompt"), ...squadPromptInputs].map((input) =>
            input.name === "--cwd"
              ? {
                  ...input,
                  required: true,
                  error: {
                    code: "missing_field",
                    nextAction: "Add --cwd <repository-relative-directory> to declare the Squad write boundary.",
                  },
                }
              : input,
          ),
        })
      : command,
  ),
);

export const taskRelationQueryInputs = Object.freeze([
  cliInput(
    "--updated-after",
    "single",
    false,
    {
      code: "invalid_field",
      nextAction: "Use an ISO-8601 UTC timestamp with --updated-after.",
    },
    {
      regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$",
    },
  ),
  cliInput(
    "--updated-before",
    "single",
    false,
    {
      code: "invalid_field",
      nextAction: "Use an ISO-8601 UTC timestamp with --updated-before.",
    },
    {
      regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$",
    },
  ),
  cliInput(
    "--limit",
    "single",
    false,
    {
      code: "invalid_field",
      nextAction: "Use an integer from 1 to 500 with --limit.",
    },
    { regex: "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$" },
  ),
  cliInput("--cursor", "single", false, {
    code: "invalid_field",
    nextAction: "Use the cursor returned by the previous page.",
  }),
]);

export const factQueryInputs = Object.freeze([
  cliInput(
    "--observed-after",
    "single",
    false,
    {
      code: "invalid_field",
      nextAction: "Use an ISO-8601 UTC timestamp with --observed-after.",
    },
    {
      regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$",
    },
  ),
  cliInput(
    "--observed-before",
    "single",
    false,
    {
      code: "invalid_field",
      nextAction: "Use an ISO-8601 UTC timestamp with --observed-before.",
    },
    {
      regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$",
    },
  ),
  cliInput(
    "--limit",
    "single",
    false,
    {
      code: "invalid_field",
      nextAction: "Use an integer from 1 to 500 with --limit.",
    },
    { regex: "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$" },
  ),
  cliInput("--cursor", "single", false, {
    code: "invalid_field",
    nextAction: "Use the cursor returned by the previous page.",
  }),
]);

export const queryEvolvedProtocolCommands = Object.freeze(
  squadBoundaryProtocolCommands.map((command) =>
    command.id === "task-list" || command.id === "relation-list"
      ? defineCliCommand({
          ...command,
          inputs: [...command.inputs, ...taskRelationQueryInputs],
        })
      : command.id === "fact-search"
        ? defineCliCommand({
            ...command,
            inputs: [...command.inputs, ...factQueryInputs],
          })
        : command,
  ),
);

export const daemonProtocolCommands = Object.freeze([
  ...queryEvolvedProtocolCommands.map((command) =>
    command.id === "daemon-stop" ? defineCliCommand({ ...command, method: "daemon.stop" }) : command,
  ),
  ...presetCommands,
]);

export const thinCliCommands = Object.freeze(
  daemonProtocolCommands
    .filter((command) => !("internal" in command && command.internal))
    .map(({ usage, summary, help }) => ({
      usage,
      summary,
      help,
    })),
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

export function commandDescriptorForAction(kind: string) {
  const descriptor =
    daemonProtocolCommands.find((entry) => commandAcceptsAction(entry, kind)) ??
    presetMethods.find((entry) => entry.actionKind === kind);
  if (!descriptor)
    throw new DaemonProtocolContractError("unsupported_command", `No command descriptor exists for ${kind}.`);
  return descriptor;
}

export function commandClassForAction(kind: string): "repo-read" | "repo-write" | "arbiter" | "admin" {
  return commandDescriptorForAction(kind).commandClass;
}

export function actionForDaemonMethod(method: string, payload: JsonObject): JsonObject & { readonly kind: string } {
  if (method === "repo.task.run") {
    const action = payload.action as JsonObject & { readonly kind: string },
      descriptor = daemonProtocolCommands.find((entry) => commandAcceptsAction(entry, action.kind));
    if (descriptor?.method !== method)
      throw new DaemonProtocolContractError(
        "unsupported_command",
        `${action.kind} requires its closed method descriptor.`,
      );
    return action;
  }
  const descriptor = [...presetMethods, ...daemonGuiActionMethods].find((entry) => entry.method === method);
  if (!descriptor)
    throw new DaemonProtocolContractError("unsupported_command", `No action descriptor exists for ${method}.`);
  const command = presetCommands.find((entry) => entry.method === method),
    defaults = command && "actionDefaults" in command ? command.actionDefaults : {};
  return { ...defaults, kind: descriptor.actionKind, ...payload };
}

function commandAcceptsAction(entry: (typeof daemonProtocolCommands)[number], kind: string): boolean {
  return ("actionKind" in entry ? entry.actionKind : entry.id) === kind;
}
