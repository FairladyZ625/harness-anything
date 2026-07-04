import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  harnessSupplyChainReleaseReadiness,
  validateSupplyChainReleaseReadiness
} from "../packages/gui/src/distribution/supply-chain-release-readiness.ts";

const root = process.cwd();
const errors = [];
const policy = harnessSupplyChainReleaseReadiness;

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

function run(command) {
  const [binary, ...args] = command.split(" ");
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    record(`${command} failed${output ? `:\n${output}` : ""}`);
    return "";
  }

  return result.stdout;
}

const policyValidation = validateSupplyChainReleaseReadiness(policy);
for (const error of policyValidation.errors) {
  record(`supply-chain release readiness policy invalid: ${error.code}: ${error.message}`);
}

validatePackageMetadata();
validatePackageLock();
validateDependabot();
validateDocsAndWorkflow();

for (const command of policy.auditCommands) {
  run(command.command);
}

const sbomOutput = run(policy.sbom.generationCommand);
if (sbomOutput) validateSbom(sbomOutput);

if (errors.length > 0) {
  console.error("Supply chain check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Supply chain check passed with ${policy.sbom.format} SBOM and release/license gates.`);

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
    if (packageJson.private !== policy.releaseBoundary.packagesPrivate) {
      record(`${packagePath} must remain private before an explicit release task`);
    }
    if (packageJson.version !== policy.releaseBoundary.workspaceVersion) {
      record(`${packagePath} must remain version ${policy.releaseBoundary.workspaceVersion} before an explicit release task`);
    }
  }

  const rootPackage = readJson("package.json");
  if (rootPackage.scripts?.["harness:check-supply-chain"] !== "node tools/check-supply-chain.mjs") {
    record("package.json must expose harness:check-supply-chain as node tools/check-supply-chain.mjs");
  }
  for (const scriptName of ["check", "check:pr"]) {
    if (!rootPackage.scripts?.[scriptName]?.includes("npm run harness:check-supply-chain")) {
      record(`package.json script ${scriptName} must run npm run harness:check-supply-chain`);
    }
  }
}

function validatePackageLock() {
  if (!existsSync(path.join(root, "package-lock.json"))) {
    record("package-lock.json is required for npm audit, SBOM, and OSV release evidence");
    return;
  }

  const lock = readJson("package-lock.json");
  if (lock.lockfileVersion !== 3 || typeof lock.packages !== "object" || lock.packages === null) {
    record("package-lock.json must be lockfileVersion 3 with packages metadata");
    return;
  }

  const rootLock = lock.packages[""];
  if (rootLock?.license !== policy.licensePolicy.projectLicense) {
    record(`package-lock.json root package must declare ${policy.licensePolicy.projectLicense}`);
  }

  for (const [packagePath, metadata] of Object.entries(lock.packages)) {
    if (!packagePath.startsWith("node_modules/")) continue;
    if (isWorkspaceLink(packagePath)) continue;
    if (!metadata.resolved || !metadata.integrity) {
      record(`package-lock.json entry ${packagePath} must include resolved URL and integrity for release SBOM traceability`);
    }
    const packageName = packageNameFromNodeModules(packagePath);
    if (!metadata.license) {
      record(`package-lock.json entry ${packagePath} must include license metadata`);
    } else if (!isAllowedDependencyLicense(packageName, metadata.license)) {
      record(`package-lock.json entry ${packagePath} has unreviewed license ${metadata.license}`);
    }
  }

  const electron = lock.packages["node_modules/electron"];
  if (!electron?.version) {
    record("package-lock.json must contain electron for desktop release upgrade awareness");
  }
}

function validateDependabot() {
  if (!existsSync(path.join(root, ".github/dependabot.yml"))) {
    record(".github/dependabot.yml is required");
    return;
  }
  const body = read(".github/dependabot.yml");
  const entries = parseDependabotEntries(body);
  for (const directory of policy.dependabot.directories) {
    const entry = entries.find((candidate) => candidate.directory === directory && candidate.packageEcosystem === policy.dependabot.ecosystem);
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
  const supplyDoc = "docs-release/m2-5-supply-chain-license.md";
  if (!existsSync(path.join(root, supplyDoc))) {
    record(`Missing supply-chain release documentation: ${supplyDoc}`);
  } else {
    requireIncludes(supplyDoc, policy.osv.liveScanCommand, "OSV live scan command");
    requireIncludes(supplyDoc, policy.osv.releaseEvidencePath, "OSV release evidence path");
    requireIncludes(supplyDoc, "not part of the default local gate", "OSV default-gate boundary");
    requireIncludes(supplyDoc, "AGPL network-service release note checklist", "AGPL network-service release note checklist");
    for (const checklistItem of policy.licensePolicy.networkServiceReleaseChecklist) {
      requireChecklistItem(supplyDoc, checklistItem);
    }
    requireIncludes(supplyDoc, "release artifact SBOM", "release artifact SBOM boundary");
    requireIncludes(supplyDoc, "Electron upgrades require security review", "Electron upgrade security review");
    requireIncludes(supplyDoc, "release artifacts are not published", "non-shipped release artifact boundary");
  }

  requireIncludes("README.md", "docs-release/m2-5-supply-chain-license.md", "M2.5 supply-chain license doc link");
  requireIncludes("README.md", "OSV readiness", "OSV readiness");
  requireIncludes("README.md", "AGPL network-service release-note checklist", "AGPL release checklist");
  requireIncludes("docs-release/m2-5-product-line.md", "m2-5-supply-chain-license.md", "supply-chain product-line link");

  const workflow = read(".github/workflows/rewrite-ci.yml");
  if (!workflow.includes("npm run harness:check-supply-chain")) {
    record(".github/workflows/rewrite-ci.yml must run npm run harness:check-supply-chain");
  }

  collectReleaseOverclaims();
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

  if (parsed.bomFormat !== policy.sbom.format || parsed.specVersion !== policy.sbom.specVersion || !Array.isArray(parsed.components)) {
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
    if (!isWorkspace && policy.sbom.requiresComponentHash && (!Array.isArray(component.hashes) || component.hashes.length === 0)) {
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
  const review = policy.licensePolicy.reviewedDependencyLicenseChoices.find((choice) =>
    choice.packageName === packageName &&
    choice.declaredLicenseExpression === declaredLicense &&
    policy.licensePolicy.allowedDependencyLicenses.includes(choice.electedLicense)
  );
  return Boolean(review);
}

function hasReviewedDependencyLicenseChoice(packageName) {
  return policy.licensePolicy.reviewedDependencyLicenseChoices.some((choice) =>
    choice.packageName === packageName &&
    policy.licensePolicy.allowedDependencyLicenses.includes(choice.electedLicense)
  );
}

function isWorkspaceLink(packagePath) {
  return packageNameFromNodeModules(packagePath).startsWith("@harness-anything/");
}

function packageNameFromNodeModules(packagePath) {
  return packagePath.replace(/^node_modules\//u, "");
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
  const shippedClaim = /\b(shipped|available|implemented|complete|completed|ready|production-ready|supported|released|published)\b/i;
  const negativeOrFuture = /\b(no|not|never|without|unshipped|planned|future|later|requires|remain|remains|before|deferred|placeholder|not part of)\b/i;
  const riskySubjects = [
    { name: "npm release", subject: /\bnpm\b[^.!?\n;|]*\brelease\b/i },
    { name: "release artifact", subject: /\brelease\b[^.!?\n;|]*\bartifacts?\b/i },
    { name: "signed installer", subject: /\bsigned\b[^.!?\n;|]*\binstallers?\b/i },
    { name: "auto-update", subject: /\bauto-?update\b/i }
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
