import { cliInput, defineCliCommand, defineRepoReadCommand } from "../../../preset/src/preset-command-contract.ts";
const settingsWriteTopology = {
  commandClass: "repo-write" as const,
  admission: {
    local: "direct" as const,
    "remote-center": "direct" as const,
    "remote-edge": "via-center-forward" as const,
  },
};
const settingValueInput = (name: string) =>
  cliInput(
    name,
    "single",
    false,
    {
      code: "invalid_field",
      nextAction: `Use ${name} with a non-empty Settings identifier or relative scaffold path.`,
    },
    { regex: "^[A-Za-z0-9][A-Za-z0-9/_.@-]*$" },
  );

export const settingsProtocolCommands = Object.freeze([
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
