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
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "ledger-audit-export",
    repositoryRead: true,
    phase: "Ledger-Read",
    path: ["ledger", "audit-export"],
    summary:
      "Export canonical ledger events as a hash-chained JSONL stream (sha256 or sm3) and deterministic manifest.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--algorithm",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", enum: ["sha256", "sm3"] },
      ),
      cliInput(
        "--from-revision",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", regex: "^[1-9][0-9]*$", projection: "number" },
      ),
      cliInput(
        "--to-revision",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", regex: "^[1-9][0-9]*$", projection: "number" },
      ),
      cliInput(
        "--date",
        "single",
        false,
        { code: "invalid_field" },
        {
          pathKind: "non-path",
          regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
          format: "YYYY-MM-DD",
          conflictsWith: ["--after", "--before"],
        },
      ),
      cliInput(
        "--after",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", regex: isoTimestamp, conflictsWith: ["--date"] },
      ),
      cliInput(
        "--before",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", regex: isoTimestamp, conflictsWith: ["--date"] },
      ),
      cliInput(
        "--prev-root-hash",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", regex: "^(?:sha256|sm3):[0-9a-f]{64}$", format: "<sha256|sm3>:<64-hex>" },
      ),
      cliInput(
        "--limit",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", regex: eventListLimit, projection: "number" },
      ),
      cliInput(
        "--cursor",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", regex: "^[0-9]+(?::[0-9]+)?$" },
      ),
      cliInput(
        "--output-dir",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "cli-local", pathReader: "cli-local" },
      ),
    ],
  }),
]);
