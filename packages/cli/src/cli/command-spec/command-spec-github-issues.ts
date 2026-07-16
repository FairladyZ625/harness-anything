import { runGithubIssuesCommand } from "../../commands/github-issues.ts";
import { parseGithubIssuesArgs } from "../parsers/github-issues.ts";
import { defineCommandSpecs } from "./types.ts";

export const githubIssuesCommandSpecs = defineCommandSpecs([
  {
    kind: "snapshot-github",
    usage: "snapshot github <owner/repo#number|issue-url> [--json]",
    options: [{ flag: "--json", description: "Emit command-receipt/v2 JSON." }],
    summary: "Read one fresh GitHub Issue snapshot without local or external writes.",
    examples: ["harness-anything snapshot github owner/repo#123 --json"],
    parse: parseGithubIssuesArgs,
    run: runGithubIssuesCommand,
    receiptContract: { data: ["report"], paths: [] },
    eventPolicy: { conflictMarkerPreflight: false, runtimeEvent: "none" }
  },
  {
    kind: "list-github",
    usage: "list github <owner/repo> [--raw-status <status>] [--label <label>] [--json]",
    options: [
      { flag: "--raw-status", description: "Filter by preserved GitHub raw status." },
      { flag: "--label", description: "Filter the repository issue list by label." },
      { flag: "--json", description: "Emit command-receipt/v2 JSON." }
    ],
    summary: "List fresh GitHub Issue snapshots for one repository.",
    examples: ["harness-anything list github owner/repo --json"],
    parse: parseGithubIssuesArgs,
    run: runGithubIssuesCommand,
    receiptContract: { data: ["rows", "report"], paths: [] },
    eventPolicy: { conflictMarkerPreflight: false, runtimeEvent: "none" }
  }
]);
