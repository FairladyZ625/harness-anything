import { cliInput, defineRepoReadCommand } from "../../../preset/src/preset-command-contract.ts";

const isoTimestamp = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9]{2}:[0-9]{2})$",
  eventListLimit = "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$";

export const eventProtocolCommands = Object.freeze([
  defineRepoReadCommand({
    id: "event-list",
    phase: "Ledger-Read",
    path: ["event", "list"],
    summary:
      "List canonical ledger events newest-first, with optional type/entity/actor/time filters and cursor paging.",
    method: "repo.task.read",
    inputs: [
      cliInput("--type", "single", false, { code: "invalid_field" }),
      cliInput(
        "--entity",
        "single",
        false,
        { code: "invalid_field" },
        {
          format: "<kind/id> (or a bare entity id)",
        },
      ),
      cliInput(
        "--actor",
        "single",
        false,
        { code: "invalid_field" },
        {
          format: "<executor-id or person-id>",
        },
      ),
      cliInput("--after", "single", false, { code: "invalid_field" }, { regex: isoTimestamp }),
      cliInput("--before", "single", false, { code: "invalid_field" }, { regex: isoTimestamp }),
      cliInput("--limit", "single", false, { code: "invalid_field" }, { regex: eventListLimit }),
      cliInput("--cursor", "single", false, { code: "invalid_field" }, { regex: "^[0-9]+$" }),
    ],
  }),
  defineRepoReadCommand({
    id: "event-show",
    phase: "Ledger-Read",
    path: ["event", "show", "<op-id>"],
    summary: "Print the complete canonical event JSON for an op id or event id.",
    method: "repo.task.read",
    inputs: [],
  }),
]);
