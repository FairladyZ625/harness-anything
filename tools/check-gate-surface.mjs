#!/usr/bin/env node
/**
 * Meta-governance checker for ADR-0023 D7.
 *
 * This checker verifies that the structured gate manifest stays consistent with
 * package.json aggregate scripts, .github/workflows/rewrite-ci.yml, and the
 * documented branch-protection surface.
 *
 * Honest boundary: branch protection validation reads .github/branch-protection.md
 * only. It does not call the GitHub API and cannot detect documentation versus
 * hosted-repository drift, such as the ADR-0022 enforce_admins mismatch. API
 * reconciliation needs credentials and belongs in a nightly/manual gate.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { boundaryAllowlistAuthorityFindings } from "./gate-surface-boundary-policy.mjs";

const DEFAULT_ROOT = process.cwd();
const MANIFEST_GATE_RUNNER = "node tools/run-manifest-gates.mjs";
const INFRASTRUCTURE_RUN_COMMANDS = new Set([
  "npm ci",
  "git diff --check",
  "mkdir -p artifacts/gui-e2e",
  "sudo apt-get update && sudo apt-get install -y xvfb"
]);

export function checkGateSurface(root = DEFAULT_ROOT) {
  const findings = [];
  const manifest = readJson(path.join(root, "tools/gate-manifest.json"));
  const packageJson = readJson(path.join(root, "package.json"));
  const workflowText = readText(path.join(root, ".github/workflows/rewrite-ci.yml"));
  const branchProtectionText = readText(path.join(root, ".github/branch-protection.md"));

  const gates = Array.isArray(manifest.gates) ? manifest.gates : [];
  const gatesById = new Map(gates.map((gate) => [gate.id, gate]));
  const commandToGateIds = buildCommandIndex(gates);
  const packageScripts = packageJson.scripts ?? {};
  const workflow = parseRewriteCi(workflowText);
  const branchContexts = parseBranchProtectionContexts(branchProtectionText);

  checkPackageScripts({ findings, manifest, gates, gatesById, commandToGateIds, packageScripts });
  checkRewriteCi({ findings, manifest, gates, workflow, commandToGateIds });
  checkBranchProtection({ findings, manifest, gates, branchContexts });
  checkTierReasons({ findings, gates });
  checkBoundaryFields({ findings, gates, packageScripts });

  return {
    ok: findings.length === 0,
    findings,
    counts: {
      findings: findings.length,
      gates: gates.length,
      packageCheckCommands: splitShellAndList(packageScripts.check ?? "").length,
      packageCheckPrCommands: splitShellAndList(packageScripts["check:pr"] ?? "").length,
      pullRequestJobs: workflow.pullRequestJobs.length,
      branchProtectionContexts: branchContexts.length
    }
  };
}

function checkPackageScripts({ findings, manifest, gates, gatesById, commandToGateIds, packageScripts }) {
  const actualCheckIds = mapAggregateCommands({
    findings,
    aggregateName: "check",
    commands: splitShellAndList(packageScripts.check ?? ""),
    manifest,
    gates,
    commandToGateIds
  });
  const actualCheckPrIds = mapAggregateCommands({
    findings,
    aggregateName: "check:pr",
    commands: splitShellAndList(packageScripts["check:pr"] ?? ""),
    manifest,
    gates,
    commandToGateIds
  });

  compareIdSets({
    findings,
    label: "package.json scripts.check",
    expected: manifest.surfaces?.packageJson?.check ?? [],
    actual: actualCheckIds
  });
  compareIdSets({
    findings,
    label: "package.json scripts.check:pr",
    expected: manifest.surfaces?.packageJson?.checkPr ?? [],
    actual: actualCheckPrIds
  });

  for (const gate of gates) {
    const packageSurface = gate.executionSurfaces?.packageJson;
    if (!packageSurface) {
      findings.push(formatFinding("package-json", `${gate.id} is missing executionSurfaces.packageJson.`));
      continue;
    }

    if (!gate.aggregate && Boolean(packageSurface.check) !== actualCheckIds.includes(gate.id)) {
      findings.push(formatFinding(
        "package-json",
        `${gate.id} executionSurfaces.packageJson.check=${packageSurface.check} but scripts.check membership is ${actualCheckIds.includes(gate.id)}.`
      ));
    }
    if (!gate.aggregate && Boolean(packageSurface.checkPr) !== actualCheckPrIds.includes(gate.id)) {
      findings.push(formatFinding(
        "package-json",
        `${gate.id} executionSurfaces.packageJson.checkPr=${packageSurface.checkPr} but scripts.check:pr membership is ${actualCheckPrIds.includes(gate.id)}.`
      ));
    }

    if (packageSurface.check || packageSurface.checkPr || packageSurface.script) {
      checkCommandResolvableInPackageScripts({ findings, gate, packageScripts });
    }
  }

  for (const id of [...(manifest.surfaces?.packageJson?.check ?? []), ...(manifest.surfaces?.packageJson?.checkPr ?? [])]) {
    if (!gatesById.has(id)) {
      findings.push(formatFinding("package-json", `manifest.surfaces.packageJson references unknown gate id ${id}.`));
    }
  }
}

function checkRewriteCi({ findings, manifest, gates, workflow, commandToGateIds }) {
  const helperJobs = manifest.surfaces?.rewriteCi?.helperJobsNotRegisteredAsGates ?? [];
  const actualPullRequestGateJobs = workflow.pullRequestJobs.filter((job) => !helperJobs.includes(job.id)).map((job) => job.id);
  const actualNonPullRequestGateJobs = workflow.nonPullRequestJobs.map((job) => job.id);

  compareIdSets({
    findings,
    label: ".github/workflows/rewrite-ci.yml pull_request gate jobs",
    expected: manifest.surfaces?.rewriteCi?.pullRequestGateJobs ?? [],
    actual: actualPullRequestGateJobs
  });
  compareIdSets({
    findings,
    label: ".github/workflows/rewrite-ci.yml non-pull_request gate jobs",
    expected: manifest.surfaces?.rewriteCi?.nonPullRequestGateJobs ?? [],
    actual: actualNonPullRequestGateJobs
  });

  const jobsById = new Map(workflow.jobs.map((job) => [job.id, job]));
  for (const job of workflow.pullRequestJobs.filter((candidate) => !helperJobs.includes(candidate.id))) {
    for (const command of job.runCommands) {
      if (INFRASTRUCTURE_RUN_COMMANDS.has(command)) {
        continue;
      }
      const runnerInvocation = parseManifestRunnerCommand(command);
      if (runnerInvocation) {
        if (runnerInvocation.workflowJob !== job.id) {
          findings.push(formatFinding("rewrite-ci", `${job.id} runs manifest gate runner for ${runnerInvocation.workflowJob ?? "no workflow job"}.`));
        }
        continue;
      }
      const mappedIds = commandToGateIds.get(command) ?? [];
      if (mappedIds.length === 0) {
        findings.push(formatFinding("rewrite-ci", `${job.id} runs ${JSON.stringify(command)} but no manifest gate declares that command.`));
      }
    }
  }

  for (const gate of gates) {
    const rewriteSurface = gate.executionSurfaces?.rewriteCi;
    if (!rewriteSurface) {
      findings.push(formatFinding("rewrite-ci", `${gate.id} is missing executionSurfaces.rewriteCi.`));
      continue;
    }

    if (gate.tier === "pr-required") {
      if ((rewriteSurface.pullRequestJobs ?? []).length === 0) {
        findings.push(formatFinding("rewrite-ci", `${gate.id} is pr-required but declares no pull-request workflow job.`));
      }
      for (const jobId of rewriteSurface.pullRequestJobs ?? []) {
        const job = jobsById.get(jobId);
        if (!job || !job.isPullRequestJob) {
          findings.push(formatFinding("rewrite-ci", `${gate.id} expects pull-request job ${jobId}, but that job is not a pull_request job.`));
          continue;
        }
        if (!jobRunsGateCommand({ job, gate, manifest, gates })) {
          findings.push(formatFinding("rewrite-ci", `${gate.id} expects ${jobId} to run ${JSON.stringify(gate.command)}, but the command is absent.`));
        }
      }
    }
  }
}

function checkBranchProtection({ findings, manifest, gates, branchContexts }) {
  const manifestContexts = manifest.surfaces?.branchProtection?.requiredContexts ?? [];
  compareIdSets({
    findings,
    label: ".github/branch-protection.md required contexts",
    expected: manifestContexts,
    actual: branchContexts
  });

  const declaredRequiredContexts = new Set();
  for (const gate of gates) {
    const branchSurface = gate.executionSurfaces?.branchProtection;
    if (!branchSurface) {
      findings.push(formatFinding("branch-protection", `${gate.id} is missing executionSurfaces.branchProtection.`));
      continue;
    }
    const gateContexts = gate.githubContext?.requiredContexts ?? [];
    if (Boolean(branchSurface.required) !== gateContexts.length > 0) {
      findings.push(formatFinding(
        "branch-protection",
        `${gate.id} executionSurfaces.branchProtection.required=${branchSurface.required} but githubContext.requiredContexts has ${gateContexts.length} entries.`
      ));
    }
    compareIdSets({
      findings,
      label: `${gate.id} branch protection contexts`,
      expected: gateContexts,
      actual: branchSurface.contexts ?? []
    });

    if (gate.tier === "pr-required" && gateContexts.length === 0) {
      findings.push(formatFinding("branch-protection", `${gate.id} is pr-required but declares no required context.`));
    }
    for (const context of gateContexts) {
      declaredRequiredContexts.add(context);
      if (!branchContexts.includes(context)) {
        findings.push(formatFinding("branch-protection", `${gate.id} requires context ${context}, but .github/branch-protection.md does not list it.`));
      }
    }
  }

  for (const context of branchContexts) {
    if (!declaredRequiredContexts.has(context)) {
      findings.push(formatFinding("branch-protection", `.github/branch-protection.md lists ${context}, but no manifest gate declares that required context.`));
    }
  }
}

function checkTierReasons({ findings, gates }) {
  for (const gate of gates) {
    if (gate.tier !== "pr-required" && isBlank(gate.tierReason)) {
      findings.push(formatFinding("tier-reason", `${gate.id} is ${gate.tier} but has an empty tierReason.`));
    }
  }
}

function checkBoundaryFields({ findings, gates, packageScripts }) {
  for (const gate of gates.filter((candidate) => candidate.category === "boundary")) {
    if (!Array.isArray(gate.authoritySource) || gate.authoritySource.length === 0) {
      findings.push(formatFinding("boundary", `${gate.id} is boundary but has no authoritySource.`));
    }
    if (!Array.isArray(gate.consumerScope) || gate.consumerScope.length === 0) {
      findings.push(formatFinding("boundary", `${gate.id} is boundary but has no consumerScope.`));
    }
    if (!gate.allowlistPolicy || typeof gate.allowlistPolicy !== "object") {
      findings.push(formatFinding("boundary", `${gate.id} is boundary but has no allowlistPolicy.`));
    } else {
      for (const finding of boundaryAllowlistAuthorityFindings(gate, packageScripts)) {
        findings.push(formatFinding("boundary", finding));
      }
    }
    if (gate.bypassFixtureRequired !== true) {
      findings.push(formatFinding("boundary", `${gate.id} is boundary but bypassFixtureRequired is not true.`));
    }
  }
}

function mapAggregateCommands({ findings, aggregateName, commands, manifest, gates, commandToGateIds }) {
  const ids = [];
  for (const command of commands) {
    const runnerInvocation = parseManifestRunnerCommand(command);
    if (runnerInvocation) {
      const expandedIds = expandManifestRunnerIds({ invocation: runnerInvocation, manifest, gates });
      if (runnerInvocation.packageSurface === null) {
        findings.push(formatFinding("package-json", `package.json scripts.${aggregateName} uses manifest gate runner without --package-surface.`));
      }
      ids.push(...expandedIds);
      continue;
    }

    const mappedIds = commandToGateIds.get(command) ?? [];
    if (mappedIds.length === 0) {
      findings.push(formatFinding("package-json", `package.json scripts.${aggregateName} contains ${JSON.stringify(command)} but no manifest gate declares that command.`));
      continue;
    }
    ids.push(...mappedIds);
  }
  return ids;
}

function checkCommandResolvableInPackageScripts({ findings, gate, packageScripts }) {
  const commandScriptNames = [];
  if (gate.command === "npm test") {
    commandScriptNames.push("test");
  }

  const npmRunMatch = /^npm run ([^&\s]+)$/.exec(gate.command);
  if (npmRunMatch) {
    commandScriptNames.push(npmRunMatch[1]);
  }

  const surfaceScript = gate.executionSurfaces?.packageJson?.script;
  if (surfaceScript) {
    commandScriptNames.push(surfaceScript);
  }

  for (const scriptName of new Set(commandScriptNames)) {
    if (!Object.hasOwn(packageScripts, scriptName)) {
      findings.push(formatFinding("package-json", `${gate.id} references package script ${scriptName}, but package.json does not define it.`));
    }
  }
}

function jobRunsGateCommand({ job, gate, manifest, gates }) {
  if (job.runCommands.includes(gate.command)) {
    return true;
  }
  if (job.runCommands.some((command) => manifestRunnerCoversGate({ command, gateId: gate.id, workflowJob: job.id, manifest, gates }))) {
    return true;
  }
  const parts = splitShellAndList(gate.command);
  return parts.length > 1 && parts.every((part) => jobRunsCommandPart({ job, part, manifest, gates }));
}

function manifestRunnerCoversGate({ command, gateId, workflowJob, manifest, gates }) {
  const invocation = parseManifestRunnerCommand(command);
  if (!invocation || invocation.workflowJob !== workflowJob) {
    return false;
  }
  return expandManifestRunnerIds({ invocation, manifest, gates }).includes(gateId);
}

function jobRunsCommandPart({ job, part, manifest, gates }) {
  if (job.runCommands.includes(part)) {
    return true;
  }
  const gatesById = new Map(gates.map((gate) => [gate.id, gate]));
  for (const command of job.runCommands) {
    const invocation = parseManifestRunnerCommand(command);
    if (!invocation || invocation.workflowJob !== job.id) {
      continue;
    }
    const expandedGates = expandManifestRunnerIds({ invocation, manifest, gates })
      .map((id) => gatesById.get(id))
      .filter(Boolean);
    if (expandedGates.some((gate) => gate.command === part)) {
      return true;
    }
  }
  return false;
}

function buildCommandIndex(gates) {
  const commandToGateIds = new Map();
  for (const gate of gates) {
    if (isBlank(gate.command)) {
      continue;
    }
    const existing = commandToGateIds.get(gate.command) ?? [];
    existing.push(gate.id);
    commandToGateIds.set(gate.command, existing);
  }
  return commandToGateIds;
}

function parseRewriteCi(text) {
  const lines = text.split(/\r?\n/);
  const jobs = [];
  let inJobs = false;
  let current = null;

  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) {
      continue;
    }

    const jobMatch = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      current = {
        id: jobMatch[1],
        ifExpressions: [],
        runCommands: [],
        nodeVersions: []
      };
      jobs.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    const ifMatch = /^\s+if:\s*(.+?)\s*$/.exec(line);
    if (ifMatch) {
      current.ifExpressions.push(unquoteYamlScalar(ifMatch[1]));
      continue;
    }

    const runMatch = /^\s+(?:-\s*)?run:\s*(.+?)\s*$/.exec(line);
    if (runMatch) {
      const command = unquoteYamlScalar(runMatch[1]);
      if (command === "|" || command === ">") {
        current.runCommands.push("<unsupported-multiline-run>");
      } else {
        current.runCommands.push(command);
      }
      continue;
    }

    const nodeVersionMatch = /^\s+node-version:\s*(.+?)\s*$/.exec(line);
    if (nodeVersionMatch) {
      const value = unquoteYamlScalar(nodeVersionMatch[1]);
      for (const version of extractNumbers(value)) {
        current.nodeVersions.push(version);
      }
      continue;
    }

    const matrixNodeMatch = /^\s+node-version:\s*\[(.+?)\]\s*$/.exec(line);
    if (matrixNodeMatch) {
      for (const version of extractNumbers(matrixNodeMatch[1])) {
        current.nodeVersions.push(version);
      }
    }
  }

  for (const job of jobs) {
    job.isPullRequestJob = job.ifExpressions.some((expression) => expression.includes("github.event_name == 'pull_request'"));
    job.isNonPullRequestJob = job.ifExpressions.some((expression) => expression.includes("github.event_name != 'pull_request'"));
  }

  return {
    jobs,
    pullRequestJobs: jobs.filter((job) => job.isPullRequestJob),
    nonPullRequestJobs: jobs.filter((job) => job.isNonPullRequestJob)
  };
}

function parseBranchProtectionContexts(text) {
  const lines = text.split(/\r?\n/);
  const contexts = [];
  let inContexts = false;

  for (const line of lines) {
    if (line.toLowerCase().includes("requires these status contexts:")) {
      inContexts = true;
      continue;
    }
    if (!inContexts) {
      continue;
    }

    const bulletMatch = /^-\s+(.+?)\s*$/.exec(line);
    if (bulletMatch) {
      contexts.push(bulletMatch[1]);
      continue;
    }
    if (contexts.length > 0 && line.trim() === "") {
      break;
    }
  }

  return contexts;
}

function splitShellAndList(script) {
  return script
    .split(/\s+&&\s+/)
    .map((command) => command.trim())
    .filter(Boolean);
}

function parseManifestRunnerCommand(command) {
  let normalized = command
    .replace(/\s+2>&1\s+\|\s+tee\s+artifacts\/gui-e2e\/gui-e2e\.log\s*$/u, "")
    .trim();
  if (normalized.startsWith("xvfb-run --auto-servernum ")) {
    normalized = normalized.slice("xvfb-run --auto-servernum ".length).trim();
  }
  if (!normalized.startsWith(MANIFEST_GATE_RUNNER)) {
    return null;
  }
  const args = normalized.slice(MANIFEST_GATE_RUNNER.length).trim().split(/\s+/).filter(Boolean);
  const invocation = {
    packageSurface: null,
    workflowJob: null,
    exclude: new Set()
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--package-surface") {
      invocation.packageSurface = value ?? null;
      index += 1;
      continue;
    }
    if (arg === "--workflow-job") {
      invocation.workflowJob = value ?? null;
      index += 1;
      continue;
    }
    if (arg === "--exclude") {
      for (const id of String(value ?? "").split(",")) {
        const trimmed = id.trim();
        if (trimmed) {
          invocation.exclude.add(trimmed);
        }
      }
      index += 1;
      continue;
    }
    if (arg === "--shard") {
      index += 1;
      continue;
    }
  }

  return invocation;
}

function expandManifestRunnerIds({ invocation, manifest, gates }) {
  if (invocation.packageSurface) {
    return (manifest.surfaces?.packageJson?.[invocation.packageSurface] ?? [])
      .filter((id) => !invocation.exclude.has(id));
  }

  if (invocation.workflowJob) {
    return gates
      .filter((gate) => !gate.aggregate)
      .filter((gate) => gate.executionSurfaces?.rewriteCi?.pullRequestJobs?.includes(invocation.workflowJob))
      .map((gate) => gate.id)
      .filter((id) => !invocation.exclude.has(id));
  }

  return [];
}

function compareIdSets({ findings, label, expected, actual }) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const id of expectedSet) {
    if (!actualSet.has(id)) {
      findings.push(formatFinding("surface-drift", `${label} is missing manifest entry ${id}.`));
    }
  }
  for (const id of actualSet) {
    if (!expectedSet.has(id)) {
      findings.push(formatFinding("surface-drift", `${label} contains unmanifested entry ${id}.`));
    }
  }
}

function extractNumbers(value) {
  return [...String(value).matchAll(/\d+/g)].map((match) => Number(match[0]));
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function isBlank(value) {
  return typeof value !== "string" || value.trim() === "";
}

function formatFinding(scope, message) {
  return `[${scope}] ${message}`;
}

function printResult(result) {
  if (result.ok) {
    console.log(`Gate surface check passed (${result.counts.gates} manifest gates, 0 drift findings).`);
    return;
  }

  console.error(`Gate surface check failed with ${result.findings.length} finding(s):`);
  for (const finding of result.findings) {
    console.error(`- ${finding}`);
  }
}

function parseArgs(argv) {
  const rootFlagIndex = argv.indexOf("--root");
  if (rootFlagIndex === -1) {
    return { root: DEFAULT_ROOT };
  }
  const root = argv[rootFlagIndex + 1];
  if (isBlank(root)) {
    throw new Error("--root requires a path");
  }
  return { root: path.resolve(root) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { root } = parseArgs(process.argv.slice(2));
    const result = checkGateSurface(root);
    printResult(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`Gate surface check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
