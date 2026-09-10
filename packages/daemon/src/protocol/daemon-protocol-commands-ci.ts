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
    summary: "Pull GitHub Actions CI observations; --run imports named runs instead of the latest --limit runs.",
    method: "repo.task.run",
    inputs: [
      cliInput("--run", "repeated", false, { code: "invalid_field" }, { field: "runs", regex: "^[1-9][0-9]{0,19}$" }),
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
