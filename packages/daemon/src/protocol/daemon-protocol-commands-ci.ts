import { cliInput, defineCliCommand } from "../../../preset/src/preset-command-contract.ts";

const ciWriteTopology = {
  commandClass: "repo-write" as const,
  admission: {
    local: "direct" as const,
    "remote-proxy": "rejected" as const,
    "remote-center": "direct" as const,
    "remote-edge": "via-center-forward" as const,
  },
};

export const ciObservationProtocolCommands = Object.freeze([
  defineCliCommand({
    id: "ci-observe-pull",
    actionKind: "ci-observe-pull",
    phase: "PLT-TestEng-W1",
    path: ["ci", "observe", "pull"],
    summary:
      "Pull GitHub Actions CI observations; --run imports named runs, --task resolves the task delivery commit to its first covering successful main run.",
    method: "repo.task.run",
    inputs: [
      cliInput("--run", "repeated", false, { code: "invalid_field" }, { field: "runs", regex: "^[1-9][0-9]{0,19}$" }),
      cliInput("--task", "single", false, { code: "invalid_field" }, { field: "taskId", conflictsWith: ["--run"] }),
      cliInput(
        "--limit",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          regex: "^(?:[1-9]|[1-9][0-9]|100)$",
          jsonFields: ["limit"],
          jsonAllowedFields: ["limit"],
        },
      ),
    ],
    ...ciWriteTopology,
  }),
]);
