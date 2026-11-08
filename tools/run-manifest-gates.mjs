#!/usr/bin/env node
/**
 * Executes gate commands from tools/gate-manifest.json.
 *
 * This runner keeps aggregate check chains, CI job gate steps, and changed-path
 * local checks derived from the manifest so adding a gate changes the manifest
 * entry, not every consumer surface. Workflow jobs and changed-path checks run
 * every selected command before reporting failure; package aggregates retain
 * their explicit `&&` short-circuit semantics.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readTestQuarantine } from "./test-quarantine.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repoRoot, "tools/gate-manifest.json");

export function parseManifestGateArgs(args) {
  const options = {
    packageSurface: null,
    workflowJob: null,
    shard: null,
    exclude: new Set(),
    changed: null,
    changedPaths: null,
    eventName: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--package-surface") {
      options.packageSurface = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--workflow-job") {
      options.workflowJob = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--shard") {
      options.shard = parsePositiveInteger(requireValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--exclude") {
      for (const id of requireValue(args, index, arg).split(",")) {
        const trimmed = id.trim();
        if (trimmed) {
          options.exclude.add(trimmed);
        }
      }
      index += 1;
      continue;
    }
    if (arg === "--changed") {
      options.changed = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown run-manifest-gates option: ${arg}`);
  }

  const selectorCount =
    Number(Boolean(options.packageSurface)) +
    Number(Boolean(options.workflowJob)) +
    Number(options.changed !== null && !options.packageSurface && !options.workflowJob);
  if (selectorCount !== 1) {
    throw new Error("exactly one of --package-surface, --workflow-job, or standalone --changed is required");
  }

  if (options.packageSurface !== null && !["check", "checkPr"].includes(options.packageSurface)) {
    throw new Error("--package-surface must be check or checkPr");
  }

  return options;
}

export function selectManifestGateIds(manifest, options) {
  let gates;
  if (options.packageSurface) {
    const ids = manifest.surfaces?.packageJson?.[options.packageSurface];
    if (!Array.isArray(ids)) {
      throw new Error(`manifest has no packageJson surface ${options.packageSurface}`);
    }
    const gatesById = new Map(manifest.gates.map((gate) => [gate.id, gate]));
    gates = ids.map((id) => gatesById.get(id) ?? { id });
  } else if (options.workflowJob) {
    const eventJobKey =
      options.eventName === "pull_request" ? "pullRequestJobs" : options.eventName ? "nonPullRequestJobs" : null;
    gates = manifest.gates
      .filter((gate) => !gate.aggregate)
      .filter((gate) =>
        eventJobKey
          ? [
              ...(gate.executionSurfaces?.rewriteCi?.[eventJobKey] ?? []),
              ...(gate.executionSurfaces?.prBody?.[eventJobKey] ?? []),
            ].includes(options.workflowJob)
          : [
              ...(gate.executionSurfaces?.rewriteCi?.pullRequestJobs ?? []),
              ...(gate.executionSurfaces?.rewriteCi?.nonPullRequestJobs ?? []),
              ...(gate.executionSurfaces?.prBody?.pullRequestJobs ?? []),
              ...(gate.executionSurfaces?.prBody?.nonPullRequestJobs ?? []),
            ].includes(options.workflowJob),
      );
  } else {
    gates = manifest.gates
      .filter((gate) => !gate.aggregate && gate.deterministic === true)
      .filter((gate) => gate.executionSurfaces?.classes?.includes("local"))
      .filter((gate) => gate.executionSurfaces?.classes?.includes("pr"));
    return selectChangedLocalGates(gates, options.changedPaths)
      .map((gate) => gate.id)
      .filter((id) => !(options.exclude ?? new Set()).has(id));
  }

  const exclude = options.exclude ?? new Set();
  return selectGatesForChangedPaths(gates, options.changedPaths)
    .map((gate) => gate.id)
    .filter((id) => !exclude.has(id));
}

function selectChangedLocalGates(gates, changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return [];
  const scopedGates = gates.filter((gate) => gate.localPathGlobs !== undefined);
  for (const gate of scopedGates) validateLocalPathGlobs(gate);
  return scopedGates.filter((gate) =>
    changedPaths.some((changedPath) => {
      const normalizedPath = changedPath.replaceAll("\\", "/");
      return gate.localPathGlobs.some((glob) => pathMatchesGlob(normalizedPath, glob));
    }),
  );
}

export function selectGatesForChangedPaths(gates, changedPaths) {
  if (!Array.isArray(changedPaths)) return gates;
  if (changedPaths.length === 0) return [];

  const scopedGates = gates.filter((gate) => gate.localPathGlobs !== undefined);
  for (const gate of scopedGates) validateLocalPathGlobs(gate);
  if (scopedGates.length === 0) return gates;

  const selectedIds = new Set();
  for (const changedPath of changedPaths) {
    const normalizedPath = changedPath.replaceAll("\\", "/");
    const matches = scopedGates.filter((gate) =>
      gate.localPathGlobs.some((glob) => pathMatchesGlob(normalizedPath, glob)),
    );
    if (matches.length === 0) return gates;
    for (const gate of matches) selectedIds.add(gate.id);
  }
  return gates.filter((gate) => selectedIds.has(gate.id));
}

function validateLocalPathGlobs(gate) {
  if (
    !Array.isArray(gate.localPathGlobs) ||
    gate.localPathGlobs.length === 0 ||
    gate.localPathGlobs.some((glob) => typeof glob !== "string" || glob.length === 0 || glob.startsWith("/"))
  ) {
    throw new Error(`manifest gate ${gate.id} localPathGlobs must be a non-empty array of relative globs`);
  }
}

function pathMatchesGlob(filePath, glob) {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`${expression}$`, "u").test(filePath);
}

export function buildManifestGatePlan(manifest, options) {
  const gateIds = selectManifestGateIds(manifest, options);
  // A workflow job that runs zero gates still exits 0: it reads as green while proving nothing. The
  // guard is scoped to --workflow-job because standalone --changed legitimately selects nothing when
  // the working tree has no changes; a CI job has no such legitimate empty state.
  if (options.workflowJob && gateIds.length === 0) {
    throw new Error(explainEmptyWorkflowJobSelection(manifest, options));
  }
  const gatesById = new Map(manifest.gates.map((gate) => [gate.id, gate]));
  const gates = gateIds.map((id) => {
    const gate = gatesById.get(id);
    if (!gate) {
      throw new Error(`manifest surface references unknown gate id ${id}`);
    }
    if (!gate.command || typeof gate.command !== "string") {
      throw new Error(`manifest gate ${id} has no executable command`);
    }
    return gate;
  });

  return collapseCompositeCoveredCommands(dedupeCommands(applyShardOption(gates, options.shard)));
}

/**
 * Names the job, the event surface the runner read, and the concrete reason the selection was empty.
 * A bare "no gates selected" would force the next reader to re-derive the selector, which is the
 * defect this guard exists to remove.
 */
function explainEmptyWorkflowJobSelection(manifest, options) {
  const job = options.workflowJob;
  const eventName = options.eventName ?? null;
  const selectedJobKey = eventName === "pull_request" ? "pullRequestJobs" : eventName ? "nonPullRequestJobs" : null;
  const declarations = jobDeclarations(manifest, job);
  const selected =
    selectedJobKey === null ? declarations : declarations.filter((entry) => entry.jobKey === selectedJobKey);
  const selectedIds = uniqueIds(selected);
  const header = `workflow job "${job}" selected 0 gates for event "${eventName ?? "unknown"}"`;
  const consequence = "A job that runs no gates proves nothing.";

  if (Array.isArray(options.changedPaths) && options.changedPaths.length === 0) {
    return `${header}. --changed ${options.changed ?? "<base>"} reported 0 changed paths, so changed-path narrowing removed every gate. Re-run with a base that differs, or drop --changed so the job runs its declared gates. ${consequence}`;
  }
  if (declarations.length === 0) {
    return `${header}: no gate declares it in executionSurfaces.rewriteCi or executionSurfaces.prBody (pullRequestJobs/nonPullRequestJobs). Add the job to the gate declarations for the events its \`if:\` allows, or remove the manifest-runner step from the job. ${consequence}`;
  }
  if (selected.length === 0) {
    const otherJobKey = selectedJobKey === "pullRequestJobs" ? "nonPullRequestJobs" : "pullRequestJobs";
    const otherIds = uniqueIds(declarations.filter((entry) => entry.jobKey === otherJobKey));
    return `${header}: event "${eventName}" selects ${selectedJobKey}, but the job is declared only in ${otherJobKey} (${otherIds.length} gate(s): ${summarizeIds(otherIds)}). A declaration on the surface for another event is invisible to this run. Add the job to ${selectedJobKey} for the gates that must run, or change the job's \`if:\` to the events whose surface declares it. ${consequence}`;
  }
  if (selected.every((entry) => entry.gate.aggregate)) {
    return `${header}: all ${selectedIds.length} declaration(s) are aggregate gates (${summarizeIds(selectedIds)}), and job selection excludes aggregate gates. Declare the concrete gates on ${selectedJobKey}. ${consequence}`;
  }
  const exclude = options.exclude ?? new Set();
  if (selected.every((entry) => entry.gate.aggregate || exclude.has(entry.gate.id))) {
    return `${header}: every concrete gate it selects is removed by --exclude (${summarizeIds(selectedIds)}). Excluding every gate leaves the job green over nothing; narrow the exclusion. ${consequence}`;
  }
  return `${header}. Add at least one gate to the selected surface for this job. ${consequence}`;
}

function jobDeclarations(manifest, job) {
  const declarations = [];
  for (const gate of manifest.gates) {
    for (const surfaceName of ["rewriteCi", "prBody"]) {
      const surface = gate.executionSurfaces?.[surfaceName];
      if (!surface) continue;
      for (const jobKey of ["pullRequestJobs", "nonPullRequestJobs"]) {
        if ((surface[jobKey] ?? []).includes(job)) declarations.push({ gate, jobKey });
      }
    }
  }
  return declarations;
}

function uniqueIds(declarations) {
  return [...new Set(declarations.map((entry) => entry.gate.id))];
}

function summarizeIds(ids) {
  return ids.length <= 5 ? ids.join(", ") : `${ids.slice(0, 5).join(", ")}, +${ids.length - 5} more`;
}

function dedupeCommands(gates) {
  const seen = new Set();
  const commands = [];
  for (const gate of gates) {
    if (seen.has(gate.command)) {
      continue;
    }
    seen.add(gate.command);
    commands.push({ id: gate.id, command: gate.command });
  }
  return commands;
}

function applyShardOption(gates, shard) {
  if (shard === null || shard === undefined) {
    return gates.map((gate) => ({ ...gate }));
  }

  return gates.map((gate) => {
    if (gate.shardable !== true) {
      throw new Error(`manifest gate ${gate.id} is not shardable but --shard was provided`);
    }
    return { ...gate, command: `${gate.command} -- --shard ${shard}` };
  });
}

function collapseCompositeCoveredCommands(commands) {
  const commandSet = new Set(commands.map((entry) => entry.command));
  const coveredParts = new Set();

  for (const entry of commands) {
    const parts = splitShellAndList(entry.command);
    if (parts.length <= 1 || !parts.every((part) => commandSet.has(part))) {
      continue;
    }
    for (const part of parts) {
      coveredParts.add(part);
    }
  }

  return commands.filter((entry) => !coveredParts.has(entry.command));
}

export function splitShellAndList(command) {
  return command
    .split(/\s+&&\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function readManifest() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function readChangedPaths(revision) {
  const changed = [
    readGitOutput(["diff", "--name-only", "-z", revision, "--"]),
    readGitOutput(["diff", "--name-only", "-z", "--"]),
    readGitOutput(["diff", "--cached", "--name-only", "-z", "--"]),
  ].join("");
  const untracked = readGitOutput(["ls-files", "--others", "--exclude-standard", "-z"]);
  return [...new Set(`${changed}${untracked}`.split("\0").filter(Boolean))].sort();
}

export function runCommand(label, command, failureHint = null, { cwd = repoRoot } = {}) {
  console.log(`\n▶ ${label}  (${command})`);
  const started = Date.now();
  const result = spawnSync(command, {
    cwd,
    env: process.env,
    // The runner has to start before it can report anything, so a hardcoded POSIX shell made
    // every Windows lane fail at "spawnSync /bin/sh ENOENT" with no gate output at all.
    shell: true,
    stdio: "inherit",
  });
  const elapsedS = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    console.error(`✖ ${label} failed to launch: ${result.error.message}`);
    if (failureHint) console.error(`↳ Fix: ${failureHint}`);
    return { ok: false, durationMs: Date.now() - started };
  }
  if (result.status !== 0) {
    console.error(`✖ ${label} failed (exit ${result.status ?? "signal"}) after ${elapsedS}s`);
    if (failureHint) console.error(`↳ Fix: ${failureHint}`);
    return { ok: false, durationMs: Date.now() - started };
  }
  console.log(`✓ ${label} (${elapsedS}s)`);
  return { ok: true, durationMs: Date.now() - started };
}

/**
 * Run every gate in the plan and decide the aggregate verdict only at the end.
 *
 * A workflow job must not stop at the first red gate: the local PR-body entry and the single CI
 * job exist so one run reports every failing check. Package aggregates keep their historical
 * short-circuit through `stopOnFailure`.
 */
export function runManifestGatePlan(plan, { execute, stopOnFailure = false } = {}) {
  const run = execute ?? ((entry) => runCommand(entry.id, entry.command, entry.failureHint));
  const results = [];
  for (const entry of plan) {
    const result = run(entry);
    results.push({ id: entry.id, ...result });
    if (!result.ok && stopOnFailure) break;
  }
  return {
    results,
    failedGateIds: results.filter((result) => !result.ok).map((result) => result.id),
  };
}

function main(argv) {
  const options = parseManifestGateArgs(argv);
  options.eventName = process.env.GITHUB_EVENT_NAME ?? null;
  if (options.changed !== null) options.changedPaths = readChangedPaths(options.changed);
  readTestQuarantine(repoRoot);
  if (shouldSkipTestQuarantine(options.workflowJob, process.env)) process.env.HARNESS_TEST_QUARANTINE = "skip";
  if (options.shard !== null) process.env.HARNESS_TEST_SHARD = String(options.shard);
  if (options.workflowJob === "integration-shard" || options.workflowJob === "windows-integration-shard")
    process.env.HARNESS_TEST_TIER = "integration";
  else if (options.workflowJob === "gui-build") process.env.HARNESS_TEST_TIER = "gui";
  else if (options.workflowJob) process.env.HARNESS_TEST_TIER ||= "contract";
  const manifest = readManifest();
  const plan = buildManifestGatePlan(manifest, options);
  const hints = new Map(manifest.gates.map((gate) => [gate.id, gate.failureHint]));
  const planWithHints = plan.map((entry) =>
    hints.get(entry.id) ? { ...entry, failureHint: hints.get(entry.id) } : entry,
  );
  const selector = options.packageSurface
    ? `package:${options.packageSurface}`
    : options.workflowJob
      ? `workflow:${options.workflowJob}`
      : `changed:${options.changed}`;
  if (options.changed !== null) {
    console.log(`Changed path selection (${options.changed}): ${options.changedPaths.length} path(s).`);
  }
  console.log(`Manifest gate runner (${selector}): ${plan.length} command(s).`);
  const { failedGateIds } = runManifestGatePlan(planWithHints, {
    stopOnFailure: Boolean(options.packageSurface),
  });
  if (failedGateIds.length > 0) {
    console.error(`\nManifest gate runner failed (${selector}): ${failedGateIds.join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nManifest gate runner passed (${selector}).`);
}

function readGitOutput(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

const l0WorkflowJobs = new Set([
  "pr-body-lint",
  "typecheck",
  "fast-contract",
  "integration-shard",
  "boundaries",
  "package-policy",
  "supply-chain",
  "gui-build",
]);

export function shouldSkipTestQuarantine(workflowJob, env) {
  return Boolean(workflowJob && l0WorkflowJobs.has(workflowJob) && env.GITHUB_EVENT_NAME === "pull_request");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Manifest gate runner failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
