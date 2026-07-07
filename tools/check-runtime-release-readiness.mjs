import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  harnessRuntimeReleaseReadiness,
  validateRuntimeReleaseReadiness
} from "../packages/gui/src/distribution/runtime-release-readiness.ts";

const root = process.cwd();
const errors = [];
const commandBySurface = new Map(harnessRuntimeReleaseReadiness.commands.map((command) => [command.surface, command]));
const manifestGateRunner = "node tools/run-manifest-gates.mjs";
const gateManifest = existsSync(path.join(root, "tools/gate-manifest.json"))
  ? readJson("tools/gate-manifest.json")
  : null;
const releaseClaimSubjects = [
  { name: "npm release", subject: /\bnpm\b[^.!?\n;|]*\brelease\b/i },
  { name: "signed installer", subject: /\bsigned\b[^.!?\n;|]*\binstallers?\b/i },
  { name: "notarized build", subject: /\bnotarized\b[^.!?\n;|]*\bbuilds?\b/i },
  { name: "auto-update", subject: /\bauto-?update\b/i },
  { name: "release feed", subject: /\brelease feeds?\b/i },
  { name: "published artifact", subject: /\bpublished\b[^.!?\n;|]*\bartifacts?\b/i },
  { name: "release artifact", subject: /\brelease\b[^.!?\n;|]*\bartifacts?\b/i }
];
const shippedClaim = /\b(shipped|available|implemented|complete|completed|ready|production-ready|supported|released|published)\b/i;
const negativeOrFuture = /\b(no|not|never|without|unshipped|planned|future|later|requires|remain|remains|before|deferred|placeholder)\b/i;

const expectedDocs = [
  "docs-release/release-posture.md"
];

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function record(message) {
  errors.push(message);
}

function requireIncludes(file, text, description = text) {
  const body = read(file).replaceAll("\r\n", "\n");
  if (!body.includes(text)) record(`${file} must mention ${description}`);
}

function requireScript(packageJson, name, command) {
  if (packageJson.scripts?.[name] !== command) {
    record(`package.json script ${name} must be ${JSON.stringify(command)}`);
  }
}

const policyValidation = validateRuntimeReleaseReadiness(harnessRuntimeReleaseReadiness);
for (const error of policyValidation.errors) {
  record(`runtime release readiness policy invalid: ${error.code}: ${error.message}`);
}

const rootPackage = readJson("package.json");
if (rootPackage.engines?.node !== ">=24") record("package.json engines.node must remain >=24");
if (rootPackage.private !== true) record("root package must remain private before an explicit release task");
if (rootPackage.version !== harnessRuntimeReleaseReadiness.releaseBoundary.privateWorkspaceVersion) {
  record(`root package version must remain ${harnessRuntimeReleaseReadiness.releaseBoundary.privateWorkspaceVersion} before first release planning`);
}
requireScript(rootPackage, "test", "node tools/run-node-tests.mjs");
requireScript(rootPackage, "harness:check-runtime-release-readiness", "node tools/check-runtime-release-readiness.mjs");
requireScript(rootPackage, "harness:smoke-cli-package", "node tools/smoke-cli-package.mjs");

for (const [scriptName, requiredCommand] of [
  ["check", "npm run harness:check-runtime-release-readiness"],
  ["check:pr", "npm run harness:check-runtime-release-readiness"]
]) {
  if (!packageScriptRunsCommand(rootPackage, scriptName, requiredCommand)) {
    record(`package.json script ${scriptName} must run ${requiredCommand}`);
  }
}

for (const workspace of [
  "packages/kernel/package.json",
  "packages/application/package.json",
  "packages/daemon/package.json",
  "packages/cli/package.json",
  "packages/gui/package.json",
  "packages/adapters/local/package.json",
  "packages/adapters/multica/package.json",
  "packages/adapters/github-issues/package.json",
  "packages/adapters/linear/package.json"
]) {
  const packageJson = readJson(workspace);
  if (workspace === "packages/cli/package.json") {
    if (packageJson.private === true) record(`${workspace} must be public-ready for npm publish --dry-run preflight`);
    if (packageJson.version !== harnessRuntimeReleaseReadiness.releaseBoundary.cliPublishDryRunVersion) {
      record(`${workspace} must be ${harnessRuntimeReleaseReadiness.releaseBoundary.cliPublishDryRunVersion} for npm publish --dry-run preflight`);
    }
    if (packageJson.publishConfig?.access !== "public") record(`${workspace} must define publishConfig.access public for scoped npm dry-run preflight`);
  } else {
    if (packageJson.private !== true) record(`${workspace} must remain private before an explicit release task`);
    if (packageJson.version !== harnessRuntimeReleaseReadiness.releaseBoundary.privateWorkspaceVersion) {
      record(`${workspace} must remain ${harnessRuntimeReleaseReadiness.releaseBoundary.privateWorkspaceVersion} before first release planning`);
    }
  }
}

for (const docPath of expectedDocs) {
  if (!existsSync(path.join(root, docPath))) record(`Missing runtime/release documentation: ${docPath}`);
}

requireIncludes("docs-release/release-posture.md", "Status: source checkout and package smoke only", "runtime status");
requireIncludes("docs-release/release-posture.md", "Node 24 and Node 26", "Node 24/26 coverage");
requireIncludes("docs-release/release-posture.md", commandBySurface.get("source-run")?.command ?? "", "source-run command");
requireIncludes("docs-release/release-posture.md", commandBySurface.get("full-check")?.command ?? "", "full check command");
requireIncludes("docs-release/release-posture.md", commandBySurface.get("pr-check")?.command ?? "", "PR check command");
requireIncludes("docs-release/release-posture.md", commandBySurface.get("package-smoke")?.command ?? "", "package smoke command");
requireIncludes("docs-release/release-posture.md", commandBySurface.get("gui-build")?.command ?? "", "GUI build command");
requireIncludes("docs-release/release-posture.md", "signed installers, notarized builds, auto-update, release feeds, and published\n  artifacts are not shipped", "non-shipped release boundary");

executeSourceRunSmoke();
collectReleaseOverclaims();

const workflow = read(harnessRuntimeReleaseReadiness.ciWorkflowPath);
for (const snippet of [
  `node-version: [${harnessRuntimeReleaseReadiness.supportedNodeMajors.join(", ")}]`,
  "npm run check",
  "npm run test:fast",
  "npm run test:contract",
  "npm run test:integration",
  "npm run harness:check-runtime-release-readiness",
  commandBySurface.get("package-smoke")?.command,
  commandBySurface.get("gui-build")?.command
]) {
  if (snippet && !workflowCoversCommand(workflow, snippet)) record(`${harnessRuntimeReleaseReadiness.ciWorkflowPath} must include ${snippet}`);
}

for (const command of harnessRuntimeReleaseReadiness.commands) {
  if (command.requiredInCi && !workflowCoversCommand(workflow, command.command)) {
    record(`${harnessRuntimeReleaseReadiness.ciWorkflowPath} must run ${command.command}`);
  }
}

if (errors.length > 0) {
  console.error("Runtime release readiness check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Runtime release readiness check passed.");

function executeSourceRunSmoke() {
  const sourceRun = commandBySurface.get("source-run");
  if (!sourceRun) return;
  const [binary, ...args] = sourceRun.command.split(" ");
  const executable = binary === "node" ? process.execPath : binary;
  try {
    const stdout = execFileSync(executable, args, { cwd: root, encoding: "utf8" });
    const result = JSON.parse(stdout);
    if (result.ok !== true || result.schema !== "command-receipt/v2" || result.command !== "doctor" || result.details?.data?.report?.readOnly !== true) {
      record(`source-run command returned unexpected output: ${stdout}`);
    }
  } catch (error) {
    record(`source-run command failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function packageScriptRunsCommand(packageJson, scriptName, requiredCommand) {
  const script = packageJson.scripts?.[scriptName] ?? "";
  return script.includes(requiredCommand) || manifestRunnerCommands(script).includes(requiredCommand);
}

function workflowCoversCommand(workflowBody, requiredCommand) {
  return workflowBody.includes(requiredCommand) || workflowRunCommands(workflowBody)
    .some((command) => manifestRunnerCommands(command).includes(requiredCommand));
}

function workflowRunCommands(workflowBody) {
  return [...workflowBody.matchAll(/^\s+(?:-\s*)?run:\s*(.+?)\s*$/gmu)]
    .map((match) => unquoteYamlScalar(match[1]))
    .filter((command) => command !== "|" && command !== ">");
}

function manifestRunnerCommands(script) {
  if (!gateManifest) return [];
  const gatesById = new Map((gateManifest.gates ?? []).map((gate) => [gate.id, gate]));
  const commands = [];
  for (const command of splitShellAndList(script)) {
    const invocation = parseManifestRunnerCommand(command);
    if (!invocation) continue;
    for (const id of expandManifestRunnerIds(invocation)) {
      const gateCommand = gatesById.get(id)?.command;
      if (gateCommand) commands.push(gateCommand);
    }
  }
  return commands;
}

function parseManifestRunnerCommand(command) {
  if (!command.startsWith(manifestGateRunner)) return null;
  const args = command.slice(manifestGateRunner.length).trim().split(/\s+/).filter(Boolean);
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
        if (trimmed) invocation.exclude.add(trimmed);
      }
      index += 1;
    }
  }

  return invocation;
}

function expandManifestRunnerIds(invocation) {
  if (invocation.packageSurface) {
    return (gateManifest.surfaces?.packageJson?.[invocation.packageSurface] ?? [])
      .filter((id) => !invocation.exclude.has(id));
  }
  if (invocation.workflowJob) {
    return (gateManifest.gates ?? [])
      .filter((gate) => !gate.aggregate)
      .filter((gate) => gate.executionSurfaces?.rewriteCi?.pullRequestJobs?.includes(invocation.workflowJob))
      .map((gate) => gate.id)
      .filter((id) => !invocation.exclude.has(id));
  }
  return [];
}

function splitShellAndList(script) {
  return script
    .split(/\s+&&\s+/)
    .map((command) => command.trim())
    .filter(Boolean);
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function collectReleaseOverclaims() {
  for (const docPath of ["README.md", ...listMarkdown("docs-release")]) {
    if (!existsSync(path.join(root, docPath))) continue;
    const content = read(docPath).replace(/\n\s*/gu, " ");
    for (const sentence of content.split(/(?<=[.!?])\s+/u)) {
      for (const clause of sentence.split(/\s*(?:;|\bbut\b|\bhowever\b)\s*/iu)) {
        if (!clause.trim()) continue;
        if (!shippedClaim.test(clause) || negativeOrFuture.test(clause)) continue;
        for (const claim of releaseClaimSubjects) {
          if (claim.subject.test(clause)) {
            record(`${docPath} may overclaim ${claim.name}: ${clause.trim()}`);
          }
        }
      }
    }
  }
}

function listMarkdown(rootPath) {
  const absoluteRoot = path.join(root, rootPath);
  if (!existsSync(absoluteRoot)) return [];
  return readdirSync(absoluteRoot)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => path.join(rootPath, entry))
    .sort();
}
