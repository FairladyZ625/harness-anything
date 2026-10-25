#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const options = { baseline: null, current: null, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--baseline", "--current", "--out"].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    options[flag.slice(2)] = path.resolve(value);
  }
  if (!options.current || !options.out) throw new Error("--current and --out are required");
  return options;
}

export function compare(baseline, current) {
  if (baseline.schema !== "perf-baseline-suite/v1" || current.schema !== "perf-baseline-suite/v1")
    throw new Error("baseline files must use perf-baseline-suite/v1");
  const previous = new Map((baseline.kernel?.runs ?? []).map((run) => [run.events, run]));
  const lines = [
    "# Performance baseline commit comparison",
    "",
    `- Previous: \`${baseline.basisRevision}\` (${baseline.measuredAt}) on ${baseline.host.cpuModel ?? "unknown CPU"}.`,
    `- Current: \`${current.basisRevision}\` (${current.measuredAt}) on ${current.host.cpuModel ?? "unknown CPU"}.`,
    "- Same-host comparison is preferred; runner or CPU changes can shift absolute latency.",
    "",
    "| Events | Path | Previous p95 ms | Current p95 ms | Change |",
    "|---:|---|---:|---:|---:|",
  ];
  let comparisons = 0;
  for (const run of current.kernel?.runs ?? []) {
    const old = previous.get(run.events);
    if (!old) continue;
    for (const [name, field] of [
      ["projection catch-up", "catchUpMs"],
      ["task list", "taskList"],
      ["single task detail", "singleTaskRead"],
      ["fact search", "factSearch"],
      ["relation graph", "relationGraph"],
    ]) {
      const before = field === "catchUpMs" ? old.catchUpMs : old.reads[field]?.p95Ms;
      const after = field === "catchUpMs" ? run.catchUpMs : run.reads[field]?.p95Ms;
      if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
      const change = before ? ((after - before) / before) * 100 : null;
      lines.push(
        `| ${run.events.toLocaleString()} | ${name} | ${before.toFixed(2)} | ${after.toFixed(2)} | ${change === null ? "n/a" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`} |`,
      );
      comparisons += 1;
    }
  }
  if (comparisons === 0) lines.push("| — | no matching event-size points | — | — | — |");
  lines.push("", `Matched metrics: ${comparisons}.`, "");
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const current = JSON.parse(readFileSync(options.current, "utf8"));
  const markdown = options.baseline
    ? compare(JSON.parse(readFileSync(options.baseline, "utf8")), current)
    : `# Performance baseline commit comparison\n\nCurrent revision: \`${current.basisRevision}\`. No previous nightly cache was available.\n`;
  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, markdown, "utf8");
  process.stdout.write(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
