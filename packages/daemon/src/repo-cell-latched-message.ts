import type { RepoCellStatus } from "./repo-cell-types.ts";

/** Operator guidance for a latched RepoCell, chosen by the cause class of the latch. */
export function repoCellLatchedMessage(causeClass: RepoCellStatus["causeClass"], lastError: string | null): string {
  return causeClass === "infrastructure"
    ? [
        "this workspace stays latched until its Git or lock infrastructure ",
        "recovers: repair the infrastructure cause below, then rerun the command; ",
        "the next attempt re-probes the workspace and re-attaches automatically ",
        "once it verifies. Cause: ",
        `${lastError ?? "RepoCell is unavailable."}`,
        "",
      ].join("")
    : causeClass === "projection"
      ? [
          "this workspace stays latched until its projection verifies: run ha ",
          "daemon projection rebuild to repair the projection cause below; this ",
          "command remains available while latched and re-attaches automatically ",
          "once the projection verifies. Cause: ",
          `${lastError ?? "RepoCell is unavailable."}`,
          "",
        ].join("")
      : [
          "this workspace stays latched until its ledger data verifies: repair the ",
          "data-shape cause below, then rerun the command; the next attempt ",
          "re-probes the ledger and re-attaches automatically once the data ",
          "verifies. Cause: ",
          `${lastError ?? "RepoCell is unavailable."}`,
          "",
        ].join("");
}
