import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  compareSupplyChainVersions,
  harnessSupplyChainReleaseReadiness,
  parseSupplyChainVersion,
  validateSupplyChainReleaseReadiness,
} from "../packages/kernel/src/domain/supply-chain-release-readiness.ts";
import { selectManifestGateIds } from "./run-manifest-gates.mjs";

const root = process.cwd();
const errors = [];
const policy = harnessSupplyChainReleaseReadiness;
const requiredBins = new Map([
  ["@harness-anything/cli", { "harness-anything": "dist/cli/src/index.js", ha: "dist/cli/src/index.js" }],
  ["@harness-anything/daemon", { "harness-anything-daemon": "dist/index.js" }],
]);
const manifestGateRunner = "node tools/run-manifest-gates.mjs";
const gateManifest = existsSync(path.join(root, "tools/gate-manifest.json"))
  ? readJson("tools/gate-manifest.json")
  : null;

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
  const body = normalizeText(read(file));
  if (!body.includes(normalizeText(text))) record(`${file} must mention ${description}`);
}

function runNpm(command) {
  const [binary, ...args] = command.split(" ");
  return spawnSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // npm ships as npm.cmd on Windows, and Node has refused to execute .cmd
    // directly. The audit commands are literals and registry package names have
    // already passed policy validation before they can reach this shell.
    shell: process.platform === "win32",
  });
}

function run(command) {
  const result = runNpm(command);
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    record(`${command} failed${output ? `:\n${output}` : ""}`);
    return "";
  }

  return result.stdout;
}

const unavailableAudits = [];
const transientNpmFailure =
  /\b(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|Service Unavailable|50[024] (?:Internal Server Error|Bad Gateway|Gateway Timeout)|(?:E|HTTP(?:\/\d+(?:\.\d+)?)?\s+|audit (?:response )?)5\d{2})\b/iu;
const permanentNpmFailure = /\b(?:E?40[134]|Unauthorized|Forbidden|Not Found)\b/iu;
const knownSeverities = new Set(["info", "low", "moderate", "high", "critical"]);
const githubAdvisoryUrl =
  /^https:\/\/github\.com\/(?:advisories|[^/?#]+\/[^/?#]+\/security\/advisories)\/(GHSA-[^/?#]+)(?:[?#].*)?$/u;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseNpmJson(stdout) {
  if (!stdout?.trim()) return undefined;
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function classifyNpmFailure(result, parsed) {
  if (!result.status || result.error || permanentNpmFailure.test(`${result.stdout}\n${result.stderr}`))
    return undefined;
  if (parsed === undefined) {
    if (/^\s*[[{"]/mu.test(result.stdout ?? "")) return undefined;
    return transientNpmFailure.exec(`${result.stdout}\n${result.stderr}`)?.[0];
  }
  // npm audit JSON reports server faults at the top level. npm view uses npm's error envelope.
  if (typeof parsed?.message === "string" && Number.isInteger(parsed.statusCode)) {
    return parsed.statusCode >= 500 && parsed.statusCode < 600 ? `HTTP ${parsed.statusCode}` : undefined;
  }
  if (typeof parsed?.message === "string" && typeof parsed.uri === "string") {
    return transientNpmFailure.exec(parsed.message)?.[0];
  }
  if (typeof parsed?.error?.code === "string") {
    return transientNpmFailure.exec(`${parsed.error.code}\n${parsed.error.summary ?? ""}`)?.[0];
  }
  return undefined;
}

function handleNpmFailure(command, result, parsed, expected, warningTitle) {
  const unavailable = classifyNpmFailure(result, parsed);
  if (unavailable) {
    const entry = `${command}: ${unavailable}`;
    unavailableAudits.push(entry);
    console.log(`::warning title=${warningTitle}::${entry}`);
    return true;
  }
  const detail = result.stderr?.trim() || result.error?.code;
  record(`${command} failed: expected ${expected}${detail ? `\n${detail}` : ""}`);
  return false;
}

function isHighSeverity(severity) {
  return severity === "high" || severity === "critical";
}

function runAudit({ name, command }, lockInstances) {
  const result = runNpm(command);
  const report = parseNpmJson(result.stdout);
  if (report?.auditReportVersion !== 2 || !isObject(report.vulnerabilities)) {
    handleNpmFailure(command, result, report, "an npm v2 audit report", "Supply chain audit did not run");
    return;
  }
  const vulnerabilityResults = Object.entries(report.vulnerabilities);
  const counts = report.metadata?.vulnerabilities;
  const production = name === "npm-audit-production";
  const highFindings = vulnerabilityResults.filter(([, finding]) => isHighSeverity(finding?.severity));
  if (production && (counts?.high > 0 || counts?.critical > 0 || highFindings.length > 0)) {
    record(`${command} failed: production audit found high or critical vulnerabilities`);
    return;
  }
  for (const severity of ["high", "critical"]) {
    const count = counts?.[severity];
    if (count === undefined) continue;
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > highFindings.filter(([, finding]) => finding.severity === severity).length
    ) {
      record(`${command} failed: metadata reports ${severity} vulnerabilities missing from the report entries`);
      return;
    }
  }
  const roots = traceHighAdvisories(command, report.vulnerabilities, highFindings);
  if (!roots?.length) return;
  if (production) {
    record(`${command} failed: production audit found high or critical root advisories`);
    return;
  }
  reviewHighAdvisories(command, roots, lockInstances);
}

function traceHighAdvisories(command, vulnerabilities, highFindings) {
  const roots = [];
  const explained = { high: new Set(), critical: new Set() };
  const dependents = new Map();
  for (const [name, finding] of Object.entries(vulnerabilities)) {
    if (!knownSeverities.has(finding?.severity) || !Array.isArray(finding.via) || finding.via.length === 0) {
      record(`${command} failed: invalid audit finding for ${name}`);
      return;
    }
    for (const cause of finding.via) {
      if (typeof cause === "string" && Object.hasOwn(vulnerabilities, cause)) {
        if (!dependents.has(cause)) dependents.set(cause, []);
        dependents.get(cause).push(name);
      } else if (!knownSeverities.has(cause?.severity)) {
        record(`${command} failed: invalid audit root or transitive reference for ${name}`);
        return;
      } else if (isHighSeverity(cause.severity)) {
        if (cause.name !== name) {
          record(`${command} failed: advisory for ${cause.name} cannot be a direct root for ${name}`);
          return;
        }
        roots.push(cause);
        explained.high.add(name);
        if (cause.severity === "critical") explained.critical.add(name);
      }
    }
  }
  // A Set iterator visits appended names, so each reachable name and its edges are visited once.
  for (const names of Object.values(explained)) {
    for (const name of names) {
      for (const dependent of dependents.get(name) ?? []) names.add(dependent);
    }
  }
  for (const [name, { severity }] of highFindings) {
    if (!explained[severity].has(name)) {
      record(`${command} failed: ${name} has no matching ${severity} root advisory`);
      return;
    }
  }
  return roots;
}

function reviewHighAdvisories(command, roots, lockInstances) {
  const reviewed = new Map();
  for (const { name: packageName, severity, url } of roots) {
    const ghsaId = typeof url === "string" ? githubAdvisoryUrl.exec(url)?.[1] : undefined;
    if (!ghsaId) {
      record(`${command} failed: unrecognized ${severity} advisory URL for ${packageName}`);
      return;
    }
    const advisory = policy.reviewedUnpatchedDevAdvisories.find(
      (entry) => entry.packageName === packageName && entry.ghsaId === ghsaId,
    );
    if (!advisory) {
      record(`${command} failed: unreviewed ${severity} advisory ${ghsaId} for ${packageName}`);
      return;
    }
    reviewed.set(advisory, lockInstances?.get(packageName));
  }

  for (const [advisory, instances] of reviewed) {
    if (!validateDevInstances(advisory, instances)) return;
  }
  const patchQueries = new Map();
  for (const advisory of reviewed.keys()) {
    const { packageName } = advisory;
    if (!patchQueries.has(packageName)) patchQueries.set(packageName, queryPublishedVersions(packageName));
    if (!validatePatchAvailability(advisory, patchQueries.get(packageName))) return;
  }
  const now = Date.now();
  const expired = [...reviewed.keys()].find(({ expiresAt }) => now > Date.parse(expiresAt));
  if (expired) {
    record(`${command} failed: ${expired.ghsaId} for ${expired.packageName} expired at ${expired.expiresAt}`);
    return;
  }
  for (const { ghsaId, packageName, maxUnpatchedVersion, expiresAt } of reviewed.keys()) {
    const patchStatus = patchQueries.get(packageName) === null ? " (patch lookup unavailable)" : "";
    console.log(
      `::warning title=Reviewed unpatched dev advisory active::${ghsaId} for ${packageName} <= ${maxUnpatchedVersion} expires ${expiresAt}${patchStatus}`,
    );
  }
}

function validateDevInstances({ packageName, maxUnpatchedVersion }, instances) {
  if (!instances?.length) {
    record(`Reviewed dev advisory for ${packageName} has no lockfile instances`);
    return false;
  }
  const ceiling = parseSupplyChainVersion(maxUnpatchedVersion);
  for (const [packagePath, metadata] of instances) {
    if (metadata?.dev !== true || metadata.devOptional === true) {
      record(`Reviewed dev advisory requires ${packagePath} to have dev === true and devOptional !== true`);
      return false;
    }
    const version = parseSupplyChainVersion(metadata.version);
    if (!version || compareSupplyChainVersions(version, ceiling) > 0) {
      record(
        `Reviewed dev advisory for ${packageName}: ${packagePath} lockfile version ${metadata.version} exceeds ${maxUnpatchedVersion} or is invalid`,
      );
      return false;
    }
  }
  return true;
}

function queryPublishedVersions(packageName) {
  const command = `npm view ${packageName} versions --json`;
  const result = runNpm(command);
  const parsed = parseNpmJson(result.stdout);
  if (result.status === 0 && Array.isArray(parsed) && parsed.length > 0 && parsed.every(parseSupplyChainVersion)) {
    return parsed;
  }
  if (
    handleNpmFailure(
      command,
      result,
      parsed,
      "a non-empty JSON array of SemVer versions",
      "Supply chain patch lookup did not run",
    )
  )
    return null;
  return undefined;
}

function validatePatchAvailability({ packageName, maxUnpatchedVersion }, versions) {
  if (versions === undefined) return false;
  if (versions === null) return true;
  const ceiling = parseSupplyChainVersion(maxUnpatchedVersion);
  for (const version of versions) {
    const parsed = parseSupplyChainVersion(version);
    if (parsed.prerelease.length === 0 && compareSupplyChainVersions(parsed, ceiling) > 0) {
      record(
        `npm registry published ${version} for ${packageName} above ${maxUnpatchedVersion}; upgrade the dependency and remove the registration`,
      );
      return false;
    }
  }
  return true;
}

const policyValidation = validateSupplyChainReleaseReadiness(policy, Date.now());
for (const error of policyValidation.errors) {
  record(`supply-chain release readiness policy invalid: ${error.code}: ${error.message}`);
}

validatePackageMetadata();
const lockInstances = validatePackageLock(policyValidation.ok ? policy.reviewedUnpatchedDevAdvisories : []);
validateDependabot();
validateDocsAndWorkflow();

if (policyValidation.ok) {
  for (const command of policy.auditCommands) {
    const priorErrors = errors.length;
    runAudit(command, lockInstances);
    if (errors.length > priorErrors) break;
  }
}

const sbomOutput = run(policy.sbom.generationCommand);
if (sbomOutput) validateSbom(sbomOutput);

if (errors.length > 0) {
  console.error("Supply chain check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

if (unavailableAudits.length > 0) {
  console.log(
    `Supply chain check passed its available gates with ${policy.sbom.format} SBOM. ` +
      `Temporary npm endpoint failures left ${unavailableAudits.length} check(s) unverified.`,
  );
} else {
  console.log(`Supply chain check passed with ${policy.sbom.format} SBOM and release/license gates.`);
}

function validatePackageMetadata() {
  for (const packagePath of policy.workspacePackagePaths) {
    if (!existsSync(path.join(root, packagePath))) {
      record(`Missing workspace package: ${packagePath}`);
      continue;
    }
    const packageJson = readJson(packagePath);
    if (packageJson.license !== policy.licensePolicy.projectLicense) {
      record(`${packagePath} must declare license ${policy.licensePolicy.projectLicense}`);
    }
    const isPublic = packageJson.private !== true;
    if (isPublic) {
      validatePublicReadyPackageMetadata(packagePath, packageJson);
    } else {
      const expectedVersion =
        packagePath === "package.json"
          ? policy.releaseBoundary.productVersion
          : policy.releaseBoundary.internalWorkspaceVersion;
      if (packageJson.version !== expectedVersion) {
        record(`${packagePath} must use version ${expectedVersion}`);
      }
      if (packageJson.publishConfig) {
        record(`${packagePath} must not define publishConfig before explicit package release planning`);
      }
    }
  }

  const rootPackage = readJson("package.json");
  if (rootPackage.scripts?.["harness:check-supply-chain"] !== "node tools/check-supply-chain.mjs") {
    record("package.json must expose harness:check-supply-chain as node tools/check-supply-chain.mjs");
  }
  for (const scriptName of ["check", "check:pr"]) {
    if (!packageScriptRunsCommand(rootPackage, scriptName, "npm run harness:check-supply-chain")) {
      record(`package.json script ${scriptName} must run npm run harness:check-supply-chain`);
    }
  }
}

function validatePublicReadyPackageMetadata(packagePath, packageJson) {
  const directory = path.posix.dirname(packagePath);
  if (packageJson.private === true) {
    record(`${packagePath} must not be private for npm publish --dry-run preflight`);
  }
  if (packageJson.version !== policy.releaseBoundary.publicReadyPackageVersion) {
    record(
      `${packagePath} must use version ${policy.releaseBoundary.publicReadyPackageVersion} for npm publish --dry-run preflight`,
    );
  }
  if (packageJson.publishConfig?.access !== "public") {
    record(`${packagePath} must define publishConfig.access public for the scoped CLI package`);
  }
  if (packageJson.repository?.directory !== directory) {
    record(`${packagePath} must declare repository.directory ${directory}`);
  }
  if (packageJson.engines?.node !== ">=24") {
    record(`${packagePath} must declare Node >=24 runtime support`);
  }
  for (const [name, target] of Object.entries(requiredBins.get(packageJson.name) ?? {}))
    if (packageJson.bin?.[name] !== target) record(`${packagePath} must declare bin ${name} as ${target}`);
  if (
    !Array.isArray(packageJson.files) ||
    !packageJson.files.includes("dist") ||
    !packageJson.files.includes("README.md") ||
    !packageJson.files.includes("package.json")
  ) {
    record(`${packagePath} files must publish dist, README.md, and package.json only`);
  }
}

function validatePackageLock(reviewedAdvisories) {
  if (!existsSync(path.join(root, "package-lock.json"))) {
    record("package-lock.json is required for npm audit, SBOM, and OSV release evidence");
    return;
  }

  const lock = readJson("package-lock.json");
  if (lock.lockfileVersion !== 3 || !isObject(lock.packages)) {
    record("package-lock.json must be lockfileVersion 3 with packages metadata");
    return;
  }

  const rootLock = lock.packages[""];
  if (rootLock?.license !== policy.licensePolicy.projectLicense) {
    record(`package-lock.json root package must declare ${policy.licensePolicy.projectLicense}`);
  }

  const reviewedInstances = new Map(reviewedAdvisories.map(({ packageName }) => [packageName, []]));
  for (const [packagePath, metadata] of Object.entries(lock.packages)) {
    const packageName = packageNameFromNodeModules(packagePath);
    if (!packageName) continue;
    reviewedInstances.get(packageName)?.push([packagePath, metadata]);
    if (metadata?.name !== packageName) reviewedInstances.get(metadata?.name)?.push([packagePath, metadata]);
    if (!packagePath.startsWith("node_modules/") || isWorkspaceLink(packagePath)) continue;
    if (!metadata?.resolved || !metadata.integrity) {
      record(
        `package-lock.json entry ${packagePath} must include resolved URL and integrity for release SBOM traceability`,
      );
    }
    if (!metadata?.license) {
      record(`package-lock.json entry ${packagePath} must include license metadata`);
    } else if (!isAllowedDependencyLicense(packagePath.slice("node_modules/".length), metadata.license)) {
      record(`package-lock.json entry ${packagePath} has unreviewed license ${metadata.license}`);
    }
  }

  const electron = lock.packages["node_modules/electron"];
  if (!electron?.version) {
    record("package-lock.json must contain electron for desktop release upgrade awareness");
  }
  return reviewedInstances;
}

function validateDependabot() {
  if (!existsSync(path.join(root, ".github/dependabot.yml"))) {
    record(".github/dependabot.yml is required");
    return;
  }
  const body = read(".github/dependabot.yml");
  const entries = parseDependabotEntries(body);
  for (const directory of policy.dependabot.directories) {
    const entry = entries.find(
      (candidate) => candidate.directory === directory && candidate.packageEcosystem === policy.dependabot.ecosystem,
    );
    if (!entry) {
      record(`.github/dependabot.yml must cover ${policy.dependabot.ecosystem} directory ${directory}`);
      continue;
    }
    for (const label of policy.dependabot.requiredLabels) {
      if (!entry.labels.includes(label)) {
        record(`.github/dependabot.yml entry ${directory} must apply ${label} label`);
      }
    }
  }
}

function validateDocsAndWorkflow() {
  const supplyDoc = "docs-release/release-posture.md";
  if (!existsSync(path.join(root, supplyDoc))) {
    record(`Missing supply-chain release documentation: ${supplyDoc}`);
  } else {
    requireIncludes(supplyDoc, policy.osv.liveScanCommand, "OSV live scan command");
    requireIncludes(supplyDoc, policy.osv.releaseEvidencePath, "OSV release evidence path");
    requireIncludes(supplyDoc, "not part of the default local gate", "OSV default-gate boundary");
    requireIncludes(
      supplyDoc,
      "AGPL network-service release note checklist",
      "AGPL network-service release note checklist",
    );
    for (const checklistItem of policy.licensePolicy.networkServiceReleaseChecklist) {
      requireChecklistItem(supplyDoc, checklistItem);
    }
    requireIncludes(supplyDoc, "release artifact SBOM", "release artifact SBOM boundary");
    requireIncludes(supplyDoc, "Electron upgrades require security review", "Electron upgrade security review");
    requireIncludes(supplyDoc, "release artifacts are not published", "non-shipped release artifact boundary");
  }

  const workflow = read(".github/workflows/rewrite-ci.yml");
  if (!workflowCoversCommand(workflow, "npm run harness:check-supply-chain")) {
    record(".github/workflows/rewrite-ci.yml must run npm run harness:check-supply-chain");
  }

  collectReleaseOverclaims();
}

function packageScriptRunsCommand(packageJson, scriptName, requiredCommand) {
  const script = packageJson.scripts?.[scriptName] ?? "";
  return script.includes(requiredCommand) || manifestRunnerCommands(script).includes(requiredCommand);
}

function workflowCoversCommand(workflowBody, requiredCommand) {
  return (
    workflowBody.includes(requiredCommand) ||
    workflowRunCommands(workflowBody).some((command) => manifestRunnerCommands(command).includes(requiredCommand))
  );
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
    exclude: new Set(),
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
  return selectManifestGateIds(gateManifest, invocation);
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

function requireChecklistItem(file, text) {
  const body = read(file);
  const escaped = escapeRegExp(text).replace(/\s+/gu, "\\s+");
  const pattern = new RegExp(`^\\s*-\\s+\\[[ xX]\\]\\s+${escaped}\\s*[.;]?\\s*$`, "imu");
  if (!pattern.test(body)) record(`${file} must include AGPL checklist checkbox item: ${text}`);
}

function validateSbom(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    record("npm sbom did not emit valid JSON");
    return;
  }

  if (
    parsed.bomFormat !== policy.sbom.format ||
    parsed.specVersion !== policy.sbom.specVersion ||
    !Array.isArray(parsed.components)
  ) {
    record(`npm sbom output must be ${policy.sbom.format} ${policy.sbom.specVersion} with a component list`);
    return;
  }

  const rootLicense = parsed.metadata?.component?.licenses?.[0]?.license?.id;
  if (rootLicense !== policy.licensePolicy.projectLicense) {
    record(`npm sbom metadata component must declare ${policy.licensePolicy.projectLicense}`);
  }

  for (const component of parsed.components) {
    const isWorkspace = isHarnessWorkspaceComponent(component);
    if (policy.sbom.requiresComponentPurl && !component.purl) {
      record(`SBOM component ${component.name ?? "<unknown>"} must include purl`);
    }
    if (
      !isWorkspace &&
      policy.sbom.requiresComponentHash &&
      (!Array.isArray(component.hashes) || component.hashes.length === 0)
    ) {
      record(`SBOM component ${component.name ?? "<unknown>"} must include at least one hash`);
    }
    const licenseId = component.licenses?.[0]?.license?.id;
    if (policy.sbom.requiresComponentLicense && !licenseId && !hasReviewedDependencyLicenseChoice(component.name)) {
      record(`SBOM component ${component.name ?? "<unknown>"} must include license`);
    } else if (licenseId && !isWorkspace && !isAllowedDependencyLicense(component.name, licenseId)) {
      record(`SBOM component ${component.name ?? "<unknown>"} has unreviewed license ${licenseId}`);
    }
  }
}

function isAllowedDependencyLicense(packageName, declaredLicense) {
  if (policy.licensePolicy.allowedDependencyLicenses.includes(declaredLicense)) return true;
  const review = policy.licensePolicy.reviewedDependencyLicenseChoices.find(
    (choice) =>
      choice.packageName === packageName &&
      choice.declaredLicenseExpression === declaredLicense &&
      choice.electedLicense.length > 0 &&
      choice.rationale.length > 0,
  );
  return Boolean(review);
}

function hasReviewedDependencyLicenseChoice(packageName) {
  return policy.licensePolicy.reviewedDependencyLicenseChoices.some(
    (choice) => choice.packageName === packageName && choice.electedLicense.length > 0 && choice.rationale.length > 0,
  );
}

function isWorkspaceLink(packagePath) {
  return packagePath.startsWith("node_modules/@harness-anything/");
}

function packageNameFromNodeModules(packagePath) {
  return /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/u.exec(packagePath)?.[1];
}

function isHarnessWorkspaceComponent(component) {
  return typeof component.purl === "string" && component.purl.includes("%40harness-anything/");
}

function parseDependabotEntries(body) {
  const entries = [];
  let current;
  let inLabels = false;

  for (const line of body.split(/\r?\n/u)) {
    const packageEcosystem = line.match(/^\s*-\s+package-ecosystem:\s+"([^"]+)"/u);
    if (packageEcosystem) {
      current = { packageEcosystem: packageEcosystem[1], directory: "", labels: [] };
      entries.push(current);
      inLabels = false;
      continue;
    }

    if (!current) continue;

    const directory = line.match(/^\s*directory:\s+"([^"]+)"/u);
    if (directory) {
      current.directory = directory[1];
      inLabels = false;
      continue;
    }

    if (/^\s*labels:\s*$/u.test(line)) {
      inLabels = true;
      continue;
    }

    const label = line.match(/^\s*-\s+"([^"]+)"/u);
    if (inLabels && label) {
      current.labels.push(label[1]);
      continue;
    }

    if (/^\s*[a-zA-Z-]+:/u.test(line)) inLabels = false;
  }

  return entries;
}

function normalizeText(value) {
  return value.replace(/\s+/gu, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function collectReleaseOverclaims() {
  const shippedClaim =
    /\b(shipped|available|implemented|complete|completed|ready|production-ready|supported|released|published)\b/i;
  const negativeOrFuture =
    /\b(no|not|never|without|unshipped|planned|future|later|requires|remain|remains|before|deferred|placeholder|not part of)\b/i;
  const riskySubjects = [
    { name: "npm release", subject: /\bnpm\b[^.!?\n;|]*\brelease\b/i },
    { name: "release artifact", subject: /\brelease\b[^.!?\n;|]*\bartifacts?\b/i },
    { name: "signed installer", subject: /\bsigned\b[^.!?\n;|]*\binstallers?\b/i },
    { name: "auto-update", subject: /\bauto-?update\b/i },
  ];

  for (const docPath of ["README.md", ...listMarkdown("docs-release")]) {
    if (!existsSync(path.join(root, docPath))) continue;
    const content = read(docPath).replace(/\n\s*/gu, " ");
    for (const sentence of content.split(/(?<=[.!?])\s+/u)) {
      for (const clause of sentence.split(/\s*(?:;|\bbut\b|\bhowever\b)\s*/iu)) {
        if (!clause.trim()) continue;
        if (!shippedClaim.test(clause) || negativeOrFuture.test(clause)) continue;
        for (const claim of riskySubjects) {
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
