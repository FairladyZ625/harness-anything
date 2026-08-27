import { cliInput, defineCliCommand } from "../../../preset/src/preset-command-contract.ts";

const ciWriteTopology = {
  commandClass: "repo-write" as const,
  admission: {
    local: "direct" as const,
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
    summary: "Pull structured GitHub Actions observations and append canonical CI events.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--limit",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use --limit with an integer from 1 to 100.",
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
