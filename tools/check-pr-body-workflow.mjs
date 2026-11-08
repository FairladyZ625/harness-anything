#!/usr/bin/env node
/**
 * Run every gate the pr-body workflow runs, locally, without stopping at the first failure.
 *
 * The gate set is derived twice, never hand-copied: the workflow names the pull-request jobs, and
 * tools/gate-manifest.json maps each job to the commands it owns. A new body check therefore enters
 * this entry by declaring itself in the manifest for the workflow, not by editing a second list.
 * `tools/check-gate-manifest-invariants.mjs` keeps the workflow job inventory and the manifest
 * declarations in sync, so this selector cannot silently miss a job the workflow added.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseGateWorkflow } from "./gate-workflow-parser.mjs";
import { pullRequestBase, repoRoot } from "./gates/git.mjs";
import {
  buildManifestGatePlan,
  parseManifestGateArgs,
  runCommand,
  runManifestGatePlan,
} from "./run-manifest-gates.mjs";

const WORKFLOW_PATH = ".github/workflows/pr-body.yml";
const MANIFEST_PATH = "tools/gate-manifest.json";

/**
 * The pull-request jobs the workflow declares, minus helper jobs the manifest explicitly says are
 * not gates (install-style setup jobs). Reading the workflow instead of a second list is what makes
 * a newly added check job visible here on the same commit that adds it.
 */
export function prBodyWorkflowJobs(manifest, workflow) {
  const helpers = new Set(manifest.surfaces?.prBody?.helperJobsNotRegisteredAsGates ?? []);
  return [...workflow.values()].filter((job) => job.isPullRequestJob && !helpers.has(job.id)).map((job) => job.id);
}

/**
 * Expand every pr-body workflow job into its manifest gate plan. A job that selects zero gates
 * throws through `buildManifestGatePlan`'s own diagnosis: an empty job must never read as green.
 */
export function buildPrBodyWorkflowPlan(manifest, workflowText) {
  const workflow = parseGateWorkflow(workflowText);
  const jobs = prBodyWorkflowJobs(manifest, workflow);
  if (jobs.length === 0) {
    throw new Error(`${WORKFLOW_PATH} declares no pull-request gate jobs`);
  }

  const plans = [];
  const commands = [];
  const seenCommands = new Set();
  for (const job of jobs) {
    const options = parseManifestGateArgs(["--workflow-job", job]);
    options.eventName = "pull_request";
    const plan = buildManifestGatePlan(manifest, options);
    plans.push({ job, plan });
    for (const entry of plan) {
      if (seenCommands.has(entry.command)) continue;
      seenCommands.add(entry.command);
      commands.push(entry);
    }
  }
  return { jobs, plans, commands };
}

function resolveCommit(rootDir, ref) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      `cannot resolve ${JSON.stringify(ref)} to a commit in ${rootDir}; fetch the base ref or pass --base explicitly`,
    );
  }
}

function prBodyFromGh(rootDir, number) {
  let output;
  try {
    output = execFileSync("gh", ["pr", "view", String(number), "--json", "body,baseRefOid"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`gh pr view ${number} failed (${detail.split(/\r?\n/u)[0]}); pass --body-file instead`);
  }
  const pr = JSON.parse(output);
  return { body: pr.body ?? "", base: pr.baseRefOid, label: `PR #${number}` };
}

function resolveBody(rootDir, options) {
  if (options.body !== null) {
    return { body: options.body, base: null, label: "--body" };
  }
  if (options.bodyFile !== null) {
    const absolute = path.resolve(rootDir, options.bodyFile);
    return {
      body: readFileSync(absolute, "utf8"),
      base: null,
      label: options.bodyFile,
    };
  }
  if (options.pr !== null) return prBodyFromGh(rootDir, options.pr);
  throw new Error("one of --pr, --body-file, or --body is required");
}

function parseCliArgs(argv) {
  const options = {
    root: null,
    pr: null,
    bodyFile: null,
    body: null,
    base: null,
    list: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--list") {
      options.list = true;
      continue;
    }
    if (!["--root", "--pr", "--body-file", "--body", "--base"].includes(token)) {
      throw new Error(`unknown argument: ${token}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value`);
    index += 1;
    if (token === "--root") options.root = value;
    else if (token === "--pr") options.pr = value;
    else if (token === "--body-file") options.bodyFile = value;
    else if (token === "--body") options.body = value;
    else if (token === "--base") options.base = value;
  }
  if (options.pr !== null && !/^\d+$/u.test(options.pr)) {
    throw new Error("--pr must be a pull request number");
  }
  const bodySources = [options.pr, options.bodyFile, options.body].filter((value) => value !== null);
  if (!options.list && bodySources.length !== 1) {
    throw new Error("exactly one of --pr, --body-file, or --body is required");
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node tools/check-pr-body-workflow.mjs (--pr <number> | --body-file <path> | --body <text>) [--base <ref>]",
      "       node tools/check-pr-body-workflow.mjs --list",
      "",
      "Runs every gate declared for the pull-request jobs in .github/workflows/pr-body.yml through",
      "tools/gate-manifest.json. Every gate runs even after an earlier one fails, then one summary",
      "lists all failures with their fix hints.",
      "",
      "  --pr <number>        read the body and comparison base from GitHub (requires gh auth)",
      "  --body-file <path>   read the body from a local file (used for rendered or combined trains)",
      "  --body <text>        pass the body inline",
      "  --base <ref>         comparison base (default: merge-base of origin/main and current HEAD)",
      "                       the entry always inspects the current checkout HEAD",
      "  --list               print the derived jobs, gates and commands without running them",
      "",
      "Exit codes: 0 all gates passed; 1 at least one gate failed; 2 the entry could not build a plan.",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

function loadInputs(rootDir) {
  const manifest = JSON.parse(readFileSync(path.join(rootDir, MANIFEST_PATH), "utf8"));
  const workflowText = readFileSync(path.join(rootDir, WORKFLOW_PATH), "utf8");
  return { manifest, workflowText };
}

function printPlan({ jobs, plans, commands }) {
  console.log(`PR body workflow jobs (${jobs.length}): ${jobs.join(", ")}`);
  console.log(`PR body workflow gates (${commands.length}): ${commands.map((entry) => entry.id).join(", ")}`);
  for (const { job, plan } of plans) {
    console.log(`\n${job}:`);
    for (const entry of plan) console.log(`  ${entry.id}  (${entry.command})`);
  }
}

function main(argv) {
  const options = parseCliArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  const rootDir = options.root ? path.resolve(options.root) : repoRoot();
  const { manifest, workflowText } = loadInputs(rootDir);
  const derived = buildPrBodyWorkflowPlan(manifest, workflowText);
  if (options.list) {
    printPlan(derived);
    return 0;
  }

  const source = resolveBody(rootDir, options);
  const baseSha = resolveCommit(rootDir, options.base ?? source.base ?? pullRequestBase(rootDir));
  // The entry only ever inspects the current checkout: supporting a detached --head split the
  // selected cut between governance (selected head) and the two diff gates (current HEAD).
  const headSha = resolveCommit(rootDir, "HEAD");
  const hints = new Map(manifest.gates.map((gate) => [gate.id, gate.failureHint]));
  const plan = derived.commands.map((entry) =>
    hints.get(entry.id) ? { ...entry, failureHint: hints.get(entry.id) } : entry,
  );

  const tempDir = mkdtempSync(path.join(tmpdir(), "pr-body-workflow-"));
  const eventPath = path.join(tempDir, "event.json");
  // The dependency gate reads the live body by path in CI; give the same manifest command the
  // same path locally instead of inventing a second input mode.
  writeFileSync(path.join(tempDir, "pr-body.md"), source.body, "utf8");
  writeFileSync(
    eventPath,
    JSON.stringify({ pull_request: { body: source.body, base: { sha: baseSha }, head: { sha: headSha } } }),
    "utf8",
  );

  const previousEnv = {
    PR_BODY: process.env.PR_BODY,
    PR_BASE_SHA: process.env.PR_BASE_SHA,
    PR_HEAD_SHA: process.env.PR_HEAD_SHA,
    GITHUB_EVENT_PATH: process.env.GITHUB_EVENT_PATH,
    GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
    RUNNER_TEMP: process.env.RUNNER_TEMP,
  };
  process.env.PR_BODY = source.body;
  process.env.PR_BASE_SHA = baseSha;
  process.env.PR_HEAD_SHA = headSha;
  process.env.GITHUB_EVENT_PATH = eventPath;
  process.env.GITHUB_EVENT_NAME = "pull_request";
  process.env.RUNNER_TEMP = tempDir;

  try {
    console.log(
      `PR body workflow check (${source.label}; base ${baseSha.slice(0, 12)}, head ${headSha.slice(0, 12)}):`,
    );
    console.log(`Derived ${derived.commands.length} gate(s) from ${derived.jobs.length} workflow job(s).`);
    const { failedGateIds } = runManifestGatePlan(plan, {
      execute: (entry) => runCommand(entry.id, entry.command, entry.failureHint, { cwd: rootDir }),
    });
    if (failedGateIds.length > 0) {
      console.error(
        `\nPR body workflow failed: ${failedGateIds.length}/${derived.commands.length} gate(s) failed: ${failedGateIds.join(", ")}.`,
      );
      for (const id of failedGateIds) {
        const hint = hints.get(id);
        console.error(`- ${id}${hint ? `: ${hint}` : ""}`);
      }
      console.error("\nEvery check above ran; fix all listed failures before pushing.");
      return 1;
    }
    console.log(`\nPR body workflow passed: ${derived.commands.length} gate(s) across ${derived.jobs.length} job(s).`);
    return 0;
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function entrypoint(argv) {
  try {
    return main(argv);
  } catch (error) {
    console.error(`PR body workflow check failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = entrypoint(process.argv.slice(2));
}
