import { runExternalCommand } from "../../commands/external.ts";
import { parseGithubIssuesArgs } from "../parsers/github-issues.ts";
import { defineCommandSpecs } from "./types.ts";

export const githubIssuesCommandSpecs = defineCommandSpecs([
  {
    kind: "external-snapshot",
    usage: "external snapshot <github|multica> <ref> [--status <status>] [--title <title>] [--json]",
    options: [{ flag: "--status", description: "Set the Multica snapshot status." }, { flag: "--title", description: "Set the Multica snapshot title." }, { flag: "--json", description: "Emit command-receipt/v2 JSON." }],
    aliases: ["snapshot github <ref> (deprecated, use external snapshot github)", "snapshot multica <ref> (deprecated, use external snapshot multica)"],
    aliasDisplay: { "snapshot github <ref> (deprecated, use external snapshot github)": "hidden", "snapshot multica <ref> (deprecated, use external snapshot multica)": "hidden" },
    summary: "Read one fresh external-provider snapshot without local or external writes.",
    examples: ["harness-anything external snapshot github owner/repo#123 --json", "harness-anything external snapshot multica EXT-123 --json"],
    parse: parseGithubIssuesArgs,
    run: runExternalCommand,
    receiptContract: { data: ["report"], paths: [] },
    eventPolicy: { conflictMarkerPreflight: false, runtimeEvent: "none" }
  },
  {
    kind: "external-list",
    usage: "external list github <owner/repo> [--raw-status <status>] [--label <label>] [--json]",
    options: [
      { flag: "--raw-status", description: "Filter by preserved GitHub raw status." },
      { flag: "--label", description: "Filter the repository issue list by label." },
      { flag: "--json", description: "Emit command-receipt/v2 JSON." }
    ],
    aliases: ["list github <owner/repo> (deprecated, use external list github)"],
    aliasDisplay: { "list github <owner/repo> (deprecated, use external list github)": "hidden" },
    summary: "List fresh external-provider snapshots for one repository.",
    examples: ["harness-anything external list github owner/repo --json"],
    parse: parseGithubIssuesArgs,
    run: runExternalCommand,
    receiptContract: { data: ["rows", "report"], paths: [] },
    eventPolicy: { conflictMarkerPreflight: false, runtimeEvent: "none" }
  }
]);
