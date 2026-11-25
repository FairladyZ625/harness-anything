#!/usr/bin/env node
/**
 * Unified offline CLI entrypoint for the HA retrospective system (`tools/retro/`).
 *
 * Implements dec_D8EECF29C93D0C300252060A10 §3:
 *   node tools/retro/cli.mjs <extract|eval|distill|audit|prune> [options]
 *
 * Unified exit codes:
 *   0 = success and all enabled gates passed
 *   1 = business/gate failure (regression, private leakage, holdout tamper, etc.)
 *   2 = invalid CLI arguments, schema failure, or unreachable origin/main (fail-closed)
 *   3 = wall-clock or cost budget exceeded (partial output emitted)
 */
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runEvalCli } from "./eval.mjs";
import { runExtractCli } from "./extract.mjs";

const BUDGET_EXIT_CODE = 3;

export const EXIT_CODES = Object.freeze({
  OK: 0,
  GATE_FAILURE: 1,
  INVALID_INPUT: 2,
  BUDGET_EXCEEDED: BUDGET_EXIT_CODE,
});

export const SUBCOMMANDS = Object.freeze(["extract", "eval", "distill", "audit", "prune"]);

export function formatCliUsage() {
  return [
    "Usage: node tools/retro/cli.mjs <extract|eval|distill|audit|prune> [options]",
    "",
    "Subcommands:",
    "  extract   Extract sanitized positive/negative cases from read-only projection & Git history",
    "  eval      Replay cases in isolated checkouts with three-stage funnel scoring",
    "  distill   Cluster failures and distill semantic rules or static gates (Slice S3)",
    "  audit     Run read-only offline governance audits and export rolling baselines (Slice S4)",
    "  prune     Audit retired/stale rules and quarantine entries (Slice S4)",
    "",
    "Exit codes:",
    "  0  Success and all enabled gates passed",
    "  1  Gate/validation failure (private leakage, holdout tamper, regression)",
    "  2  Invalid CLI arguments, input schema error, or fail-closed precondition",
    "  3  Budget truncation (--max-wall-ms / --max-cost-usd)",
  ].join("\n");
}

export async function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? ((line) => console.log(line));
  const stderr = io.stderr ?? ((line) => console.error(line));

  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    stdout(formatCliUsage());
    return command ? EXIT_CODES.OK : EXIT_CODES.INVALID_INPUT;
  }

  if (!SUBCOMMANDS.includes(command)) {
    stderr(`Unknown retro subcommand: ${command}\n\n${formatCliUsage()}`);
    return EXIT_CODES.INVALID_INPUT;
  }

  if (command === "extract") {
    return runExtractCli(rest, { stdout, stderr });
  }

  if (command === "eval") {
    return runEvalCli(rest, { stdout, stderr });
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    stdout(`retro ${command}: scheduled for a subsequent retro slice (see dec_D8EECF29C93D0C300252060A10).`);
    return EXIT_CODES.OK;
  }

  stderr(`Subcommand "retro ${command}" is not yet implemented.`);
  return EXIT_CODES.INVALID_INPUT;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = EXIT_CODES.GATE_FAILURE;
    });
}
