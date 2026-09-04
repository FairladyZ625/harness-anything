#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deriveProtectedSurfaceRules } from "./check-pr-governance.mjs";
import { INFRASTRUCTURE_COMMANDS } from "./gate-infrastructure-commands.mjs";
import { parseGateWorkflow } from "./gate-workflow-parser.mjs";

const DEFAULT_ROOT = process.cwd();
const SURFACE_CLASSES = new Set(["local", "pr", "main-full", "nightly", "manual"]);
const POSITIVE_CONTROL_STATUSES = new Set(["covered", "documented-gap", "not-applicable"]);
export function checkGateManifestInvariants(root = DEFAULT_ROOT) {
  const manifest = readJson(path.join(root, "tools/gate-manifest.json"));
  const workflows = [
    {
      surfaceName: "rewriteCi",
      workflow: parseGateWorkflow(readFileSync(path.join(root, ".github/workflows/rewrite-ci.yml"), "utf8")),
    },
    {
      surfaceName: "prBody",
      workflow: parseGateWorkflow(readFileSync(path.join(root, ".github/workflows/pr-body.yml"), "utf8")),
    },
  ];
  const findings = [];
  const gates = Array.isArray(manifest.gates) ? manifest.gates : [];

  if (manifest.schema !== "harness-anything/gate-manifest/v2") {
    findings.push(`manifest schema must be harness-anything/gate-manifest/v2, got ${JSON.stringify(manifest.schema)}`);
  }
  checkProtectedSurfaceCoverage(manifest, root, findings);
  for (const { surfaceName, workflow } of workflows) {
    checkWorkflowInventory(manifest, workflow, surfaceName, findings);
    checkWorkflowCommands(manifest, workflow, gates, surfaceName, findings);
  }
  for (const gate of gates) {
    checkClassificationFields(gate, findings);
    for (const { surfaceName, workflow } of workflows) checkWorkflowMapping(gate, workflow, surfaceName, findings);
  }

  return {
    ok: findings.length === 0,
    findings,
    counts: {
      gates: gates.length,
      deterministic: gates.filter((gate) => gate.deterministic === true).length,
      findings: findings.length,
    },
  };
}

function checkProtectedSurfaceCoverage(manifest, root, findings) {
  const declarations = (manifest.gates ?? []).flatMap((gate) => {
    if (!gate.changeControl?.requiresGovernanceEvidence) return [];
    return (gate.changeControl.protectedSurfaces ?? [])
      .filter((surface) => typeof surface === "string" && surface.trim().length > 0)
      .map((surface) => ({ gateId: gate.id, surface: surface.trim() }));
  });
  if (declarations.length === 0) return;

  const trackedFiles = readTrackedFiles(root);
  for (const declaration of declarations) {
    const rules = deriveProtectedSurfaceRules({
      gates: [
        {
          id: declaration.gateId,
          changeControl: {
            requiresGovernanceEvidence: true,
            protectedSurfaces: [declaration.surface],
          },
        },
      ],
    });
    const matchesTrackedFile = trackedFiles.some((file) => rules.some((rule) => rule.matcher(file)));
    if (!matchesTrackedFile) {
      const derivedRules = rules.map((rule) => JSON.stringify(rule.display)).join(", ") || "none";
      findings.push(
        `${declaration.gateId} protected surface ${JSON.stringify(declaration.surface)} matches no tracked files (derived rules: ${derivedRules})`,
      );
    }
  }
}

function readTrackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.split("\0").filter(Boolean);
}

function checkWorkflowCommands(manifest, workflow, gates, surfaceName, findings) {
  const helpers = new Set(manifest.surfaces?.[surfaceName]?.helperJobsNotRegisteredAsGates ?? []);
  const commandToGates = new Map();
  for (const gate of gates) {
    const entries = commandToGates.get(gate.command) ?? [];
    entries.push(gate);
    commandToGates.set(gate.command, entries);
  }

  for (const job of workflow.values()) {
    if (helpers.has(job.id) || (!job.isPullRequestJob && !job.isNonPullRequestJob)) continue;
    for (const command of job.runCommands) {
      if (INFRASTRUCTURE_COMMANDS.has(command)) continue;
      const runner = parseManifestRunner(command);
      if (runner) {
        if (runner.workflowJob !== job.id) {
          findings.push(`workflow job ${job.id} invokes manifest runner for ${runner.workflowJob ?? "no job"}`);
        }
        continue;
      }

      const matchingGates = commandToGates.get(command) ?? [];
      if (matchingGates.length === 0) {
        findings.push(`workflow job ${job.id} runs unmanifested command ${JSON.stringify(command)}`);
        continue;
      }
      for (const gate of matchingGates) {
        const declaredJobs = job.isPullRequestJob
          ? (gate.executionSurfaces?.[surfaceName]?.pullRequestJobs ?? [])
          : (gate.executionSurfaces?.[surfaceName]?.nonPullRequestJobs ?? []);
        if (!declaredJobs.includes(job.id)) {
          findings.push(`workflow job ${job.id} runs ${gate.id}, but that gate does not declare the job`);
        }
      }
    }
  }
}

function checkWorkflowInventory(manifest, workflow, surfaceName, findings) {
  const surface = manifest.surfaces?.[surfaceName] ?? {};
  const helpers = new Set(surface.helperJobsNotRegisteredAsGates ?? []);
  const expectedPr = new Set(surface.pullRequestGateJobs ?? []);
  const expectedNonPr = new Set(surface.nonPullRequestGateJobs ?? []);
  const actualPr = [...workflow.values()]
    .filter((job) => job.isPullRequestJob && !helpers.has(job.id))
    .map((job) => job.id);
  const actualNonPr = [...workflow.values()]
    .filter((job) => job.isNonPullRequestJob && !helpers.has(job.id))
    .map((job) => job.id);

  compareInventory(`${surfaceName} workflow PR gate jobs`, expectedPr, actualPr, findings);
  compareInventory(`${surfaceName} workflow non-PR gate jobs`, expectedNonPr, actualNonPr, findings);
  for (const helper of helpers) {
    if (!workflow.has(helper)) findings.push(`workflow helper job ${helper} is declared but absent`);
  }
}

function compareInventory(label, expected, actual, findings) {
  const actualSet = new Set(actual);
  for (const jobId of expected) {
    if (!actualSet.has(jobId)) findings.push(`${label} is missing declared job ${jobId}`);
  }
  for (const jobId of actualSet) {
    if (!expected.has(jobId)) findings.push(`${label} contains unmanifested job ${jobId}`);
  }
}

function checkWorkflowMapping(gate, workflow, surfaceName, findings) {
  for (const jobId of gate.executionSurfaces?.[surfaceName]?.pullRequestJobs ?? []) {
    const job = workflow.get(jobId);
    if (!job?.isPullRequestJob) {
      findings.push(`${gate.id} declares PR workflow job ${jobId}, but that pull-request job does not exist`);
      continue;
    }
    if (!jobRunsGate(job, gate)) {
      findings.push(`${gate.id} declares PR workflow job ${jobId}, but its command is absent from that job`);
    }
  }

  for (const jobId of gate.executionSurfaces?.[surfaceName]?.nonPullRequestJobs ?? []) {
    const job = workflow.get(jobId);
    if (!job?.isNonPullRequestJob) {
      findings.push(`${gate.id} declares non-PR workflow job ${jobId}, but that non-PR job does not exist`);
      continue;
    }
    if (!jobRunsNonPrGate(job, gate)) {
      findings.push(`${gate.id} declares non-PR workflow job ${jobId}, but its command is absent from that job`);
    }
  }
}

function jobRunsGate(job, gate) {
  if (job.runCommands.includes(gate.command)) return true;
  return job.runCommands.some((command) => {
    const runner = parseManifestRunner(command);
    return runner?.workflowJob === job.id && !runner.excludes.has(gate.id);
  });
}

function parseManifestRunner(command) {
  const match = /^node tools\/run-manifest-gates\.mjs\b(.*)$/u.exec(command);
  if (!match) return null;
  const args = match[1] ?? "";
  const workflowJob = /(?:^|\s)--workflow-job\s+(\S+)/u.exec(args)?.[1] ?? null;
  const excludes = new Set((/(?:^|\s)--exclude\s+(\S+)/u.exec(args)?.[1] ?? "").split(",").filter(Boolean));
  return { workflowJob, excludes };
}

function jobRunsNonPrGate(job, gate) {
  if (jobRunsGate(job, gate)) return true;
  return gate.executionSurfaces?.packageJson?.check === true && job.runCommands.includes("npm run check");
}

function checkClassificationFields(gate, findings) {
  if (typeof gate.deterministic !== "boolean") {
    findings.push(`${gate.id} must declare deterministic as a boolean`);
  }

  const classes = gate.executionSurfaces?.classes;
  if (!Array.isArray(classes) || classes.length === 0) {
    findings.push(`${gate.id} must declare a non-empty executionSurfaces.classes array`);
  } else {
    for (const surface of classes) {
      if (!SURFACE_CLASSES.has(surface)) {
        findings.push(`${gate.id} declares unknown execution surface ${JSON.stringify(surface)}`);
      }
    }
  }

  if (gate.deterministic === true && !classes?.includes("pr")) {
    findings.push(`${gate.id} is deterministic but executionSurfaces.classes omits pr`);
  }

  if (Array.isArray(classes)) checkSurfaceClassMapping(gate, classes, findings);

  const positiveControl = gate.positiveControl;
  if (!positiveControl || !POSITIVE_CONTROL_STATUSES.has(positiveControl.status)) {
    findings.push(`${gate.id} must declare positiveControl.status as covered, documented-gap, or not-applicable`);
  }
  if (
    !Array.isArray(positiveControl?.evidence) ||
    positiveControl.evidence.length === 0 ||
    positiveControl.evidence.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    findings.push(`${gate.id} must declare non-empty positiveControl.evidence`);
  }
}

function checkSurfaceClassMapping(gate, classes, findings) {
  const hasClass = (surface) => classes.includes(surface);
  const rewriteCi = gate.executionSurfaces?.rewriteCi ?? {};
  const prBody = gate.executionSurfaces?.prBody ?? {};
  const hasPrJobs = [...(rewriteCi.pullRequestJobs ?? []), ...(prBody.pullRequestJobs ?? [])].length > 0;
  const hasFullCheck = (rewriteCi.nonPullRequestJobs ?? []).includes("full-check") && rewriteCi.scheduleOnly !== true;
  const hasLocalScript = Boolean(gate.executionSurfaces?.packageJson?.script);

  if (hasClass("pr") !== hasPrJobs) {
    findings.push(`${gate.id} executionSurfaces.classes pr does not match its PR workflow jobs`);
  }
  if (hasClass("main-full") !== hasFullCheck) {
    findings.push(`${gate.id} executionSurfaces.classes main-full does not match its non-PR full-check mapping`);
  }
  if (hasClass("nightly") !== (rewriteCi.scheduleOnly === true)) {
    findings.push(`${gate.id} executionSurfaces.classes nightly does not match rewriteCi.scheduleOnly`);
  }
  if (hasClass("local") !== hasLocalScript) {
    findings.push(`${gate.id} executionSurfaces.classes local does not match its package script`);
  }
  if (hasClass("manual") !== (gate.tier === "manual-only")) {
    findings.push(`${gate.id} executionSurfaces.classes manual does not match its tier`);
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseArgs(argv) {
  const rootFlagIndex = argv.indexOf("--root");
  if (rootFlagIndex === -1) return { root: DEFAULT_ROOT };
  const root = argv[rootFlagIndex + 1];
  if (!root || root.startsWith("--")) throw new Error("--root requires a path");
  return { root: path.resolve(root) };
}

function printResult(result) {
  if (result.ok) {
    console.log(
      `Gate manifest invariants passed (${result.counts.deterministic}/${result.counts.gates} deterministic gates).`,
    );
    return;
  }
  console.error(`Gate manifest invariants failed with ${result.findings.length} finding(s):`);
  for (const finding of result.findings) console.error(`- ${finding}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { root } = parseArgs(process.argv.slice(2));
    const result = checkGateManifestInvariants(root);
    printResult(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`Gate manifest invariants failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
