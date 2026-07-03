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
  "docs-release/m2-5-runtime-release.md",
  "docs-release/m2-5-gui-distribution.md"
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
if (rootPackage.version !== harnessRuntimeReleaseReadiness.releaseBoundary.workspaceVersion) {
  record(`root package version must remain ${harnessRuntimeReleaseReadiness.releaseBoundary.workspaceVersion} before first release planning`);
}
requireScript(rootPackage, "test", "node tools/run-node-tests.mjs");
requireScript(rootPackage, "harness:check-runtime-release-readiness", "node tools/check-runtime-release-readiness.mjs");
requireScript(rootPackage, "harness:smoke-cli-package", "node tools/smoke-cli-package.mjs");

for (const [scriptName, requiredCommand] of [
  ["check", "npm run harness:check-runtime-release-readiness"],
  ["check:pr", "npm run harness:check-runtime-release-readiness"]
]) {
  if (!rootPackage.scripts?.[scriptName]?.includes(requiredCommand)) {
    record(`package.json script ${scriptName} must run ${requiredCommand}`);
  }
}

for (const workspace of [
  "packages/kernel/package.json",
  "packages/application/package.json",
  "packages/cli/package.json",
  "packages/gui/package.json",
  "packages/adapters/local/package.json",
  "packages/adapters/multica/package.json",
  "packages/adapters/github-issues/package.json",
  "packages/adapters/linear/package.json"
]) {
  const packageJson = readJson(workspace);
  if (packageJson.private !== true) record(`${workspace} must remain private before an explicit release task`);
  if (packageJson.version !== harnessRuntimeReleaseReadiness.releaseBoundary.workspaceVersion) {
    record(`${workspace} must remain ${harnessRuntimeReleaseReadiness.releaseBoundary.workspaceVersion} before first release planning`);
  }
}

for (const docPath of expectedDocs) {
  if (!existsSync(path.join(root, docPath))) record(`Missing runtime/release documentation: ${docPath}`);
}

requireIncludes("README.md", "Use Node.js 24 or newer", "Node 24 minimum");
requireIncludes("README.md", commandBySurface.get("source-run")?.command ?? "", "source-run command");
requireIncludes("README.md", commandBySurface.get("full-check")?.command ?? "", "full check command");
requireIncludes("README.md", "Node 24 and Node 26", "Node 24/26 CI coverage");
requireIncludes("README.md", "package smoke", "package smoke validation");
requireIncludes("README.md", "docs-release/m2-5-runtime-release.md", "M2.5 runtime release doc link");
requireIncludes("README.md", "No signed desktop installer, notarized build, or auto-update capability is\n  claimed", "non-shipped desktop release boundary");
requireIncludes("README.md", "No npm package release is claimed", "non-shipped npm release boundary");

requireIncludes("docs-release/m2-5-runtime-release.md", "Status: source checkout and package smoke only", "runtime status");
requireIncludes("docs-release/m2-5-runtime-release.md", "Node 24 and Node 26", "Node 24/26 coverage");
requireIncludes("docs-release/m2-5-runtime-release.md", commandBySurface.get("source-run")?.command ?? "", "source-run command");
requireIncludes("docs-release/m2-5-runtime-release.md", commandBySurface.get("full-check")?.command ?? "", "full check command");
requireIncludes("docs-release/m2-5-runtime-release.md", commandBySurface.get("pr-check")?.command ?? "", "PR check command");
requireIncludes("docs-release/m2-5-runtime-release.md", commandBySurface.get("package-smoke")?.command ?? "", "package smoke command");
requireIncludes("docs-release/m2-5-runtime-release.md", commandBySurface.get("gui-build")?.command ?? "", "GUI build command");
requireIncludes("docs-release/m2-5-runtime-release.md", "signed installers, notarized builds, auto-update, release feeds, and published\n  artifacts are not shipped", "non-shipped release boundary");

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
  if (snippet && !workflow.includes(snippet)) record(`${harnessRuntimeReleaseReadiness.ciWorkflowPath} must include ${snippet}`);
}

for (const command of harnessRuntimeReleaseReadiness.commands) {
  if (command.requiredInCi && !workflow.includes(command.command)) {
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
    if (result.ok !== true || result.receipt !== "CommandReceipt/v1" || result.command !== "doctor" || result.data?.report?.readOnly !== true) {
      record(`source-run command returned unexpected output: ${stdout}`);
    }
  } catch (error) {
    record(`source-run command failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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
