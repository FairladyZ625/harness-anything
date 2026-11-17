import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import {
  cliInput,
  defineEdgeReplicaQueryOnlyReadCommand,
} from "@harness-anything/preset/internal/preset-command-contract";

const isoTimestamp = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9]{2}:[0-9]{2})$",
  eventListLimit = daemonProtocolFleetPolicy.defaultValue.protocol.listLimitPattern;

export const eventProtocolCommands = Object.freeze([
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "event-list",
    repositoryRead: true,
    phase: "Ledger-Read",
    path: ["event", "list"],
    summary:
      "List canonical ledger events newest-first, with optional type/entity/actor/time filters and cursor paging.",
    method: "repo.task.read",
    inputs: [
      cliInput("--type", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput(
        "--entity",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", format: "<kind/id> (or a bare entity id)" },
      ),
      cliInput(
        "--actor",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", format: "<executor-id or person-id>" },
      ),
      cliInput("--after", "single", false, { code: "invalid_field" }, { pathKind: "non-path", regex: isoTimestamp }),
      cliInput("--before", "single", false, { code: "invalid_field" }, { pathKind: "non-path", regex: isoTimestamp }),
      cliInput("--limit", "single", false, { code: "invalid_field" }, { pathKind: "non-path", regex: eventListLimit }),
      cliInput("--cursor", "single", false, { code: "invalid_field" }, { pathKind: "non-path", regex: "^[0-9]+$" }),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "event-show",
    repositoryRead: true,
    phase: "Ledger-Read",
    path: ["event", "show", "<op-id>"],
    summary: "Print the complete canonical event JSON for an op id or event id.",
    method: "repo.task.read",
    inputs: [],
  }),
]);
