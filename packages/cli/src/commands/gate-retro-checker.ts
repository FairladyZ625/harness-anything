import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findEntityRefs, readFrontmatter, readScalar, sha256Text } from "@harness-anything/kernel";
import type { HarnessLayoutInput } from "@harness-anything/kernel";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { relativePath } from "../cli/path.ts";
import { buildResolvableEntityIndex } from "./check-entity-refs.ts";
import { profileIssue, type ProfileValidationIssue } from "./check-profile-types.ts";

export function validateGateArchitectureRetrospectiveGate(rootInput: HarnessLayoutInput, taskDirs: ReadonlyArray<string>): ReadonlyArray<ProfileValidationIssue> {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const index = buildResolvableEntityIndex(rootInput);
  const issues: ProfileValidationIssue[] = [];
  for (const taskDir of taskDirs) {
    const relativeTaskDir = relativePath(rootDir, taskDir);
    const indexPath = path.join(taskDir, "INDEX.md");
    if (!existsSync(indexPath)) continue;
    const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
    if (!frontmatter || readScalar(frontmatter, "preset") !== "gate-architecture-retrospective") continue;

    issues.push(...validateGateRetroSnapshot(taskDir, relativeTaskDir));
    issues.push(...validateGateRetroAnalysis(taskDir, relativeTaskDir, index.refs));
  }
  return issues;
}

function validateGateRetroSnapshot(taskDir: string, relativeTaskDir: string): ReadonlyArray<ProfileValidationIssue> {
  const snapshotPath = path.join(taskDir, "artifacts", "gate-retro.snapshot.json");
  if (!existsSync(snapshotPath)) {
    return [profileIssue(
      "gate-retro-checker",
      "gate_retro_snapshot_missing",
      "hard-fail",
      `${relativeTaskDir}/artifacts/gate-retro.snapshot.json is required by preset gate-architecture-retrospective.`,
      "Run the gate-architecture-retrospective gather entrypoint before writing the final analysis."
    )];
  }
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as { readonly schema?: unknown };
    if (parsed.schema === "gate-architecture-retro-snapshot/v1") return validateMachineEvidenceRegistry(taskDir, relativeTaskDir, "artifacts/gate-retro.snapshot.json", snapshotPath);
    return [profileIssue(
      "gate-retro-checker",
      "gate_retro_snapshot_schema_invalid",
      "hard-fail",
      `${relativeTaskDir}/artifacts/gate-retro.snapshot.json must use schema gate-architecture-retro-snapshot/v1.`,
      "Regenerate the snapshot with the bundled gather entrypoint."
    )];
  } catch {
    return [profileIssue(
      "gate-retro-checker",
      "gate_retro_snapshot_unreadable",
      "hard-fail",
      `${relativeTaskDir}/artifacts/gate-retro.snapshot.json could not be parsed as JSON.`,
      "Restore a readable machine snapshot."
    )];
  }
}

function validateMachineEvidenceRegistry(
  taskDir: string,
  relativeTaskDir: string,
  evidencePath: string,
  absolutePath: string
): ReadonlyArray<ProfileValidationIssue> {
  const registryPath = path.join(taskDir, "artifacts", ".machine-evidence.registry.json");
  if (!existsSync(registryPath)) {
    return [profileIssue(
      "gate-retro-checker",
      "gate_retro_machine_evidence_registry_missing",
      "hard-fail",
      `${relativeTaskDir}/artifacts/.machine-evidence.registry.json must register ${evidencePath}.`,
      "Regenerate the snapshot through the bundled script entrypoint so machine gate input has a fresh hash registry."
    )];
  }
  try {
    const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as { readonly schema?: unknown; readonly entries?: unknown };
    if (parsed.schema !== "machine-evidence-registry/v1" || !Array.isArray(parsed.entries)) {
      return [machineEvidenceRegistryIssue(relativeTaskDir, "gate_retro_machine_evidence_registry_invalid", "Machine evidence registry schema is invalid.")];
    }
    const entry = parsed.entries.find((candidate: unknown) =>
      candidate &&
      typeof candidate === "object" &&
      (candidate as { readonly path?: unknown }).path === evidencePath
    ) as { readonly sha256?: unknown } | undefined;
    const actual = `sha256:${sha256Text(readFileSync(absolutePath, "utf8"))}`;
    if (!entry || entry.sha256 !== actual) {
      return [machineEvidenceRegistryIssue(relativeTaskDir, "gate_retro_machine_evidence_registry_stale", `${relativeTaskDir}/${evidencePath} does not match the registered machine evidence hash.`)];
    }
    return [];
  } catch {
    return [machineEvidenceRegistryIssue(relativeTaskDir, "gate_retro_machine_evidence_registry_invalid", "Machine evidence registry could not be parsed.")];
  }
}

function machineEvidenceRegistryIssue(relativeTaskDir: string, code: string, message: string): ProfileValidationIssue {
  return profileIssue(
    "gate-retro-checker",
    code,
    "hard-fail",
    message,
    `Regenerate ${relativeTaskDir}/artifacts/gate-retro.snapshot.json through the bundled script entrypoint before running the gate.`
  );
}

function validateGateRetroAnalysis(taskDir: string, relativeTaskDir: string, resolvableRefs: ReadonlySet<string>): ReadonlyArray<ProfileValidationIssue> {
  const analysisPath = path.join(taskDir, "artifacts", "gate-retro.analysis.md");
  if (!existsSync(analysisPath)) {
    return [profileIssue(
      "gate-retro-checker",
      "gate_retro_analysis_missing",
      "hard-fail",
      `${relativeTaskDir}/artifacts/gate-retro.analysis.md is required by preset gate-architecture-retrospective.`,
      "Write the final retrospective analysis from the scaffold and keep it under the task artifacts directory."
    )];
  }

  let body: string;
  try {
    body = readFileSync(analysisPath, "utf8");
  } catch {
    return [profileIssue(
      "gate-retro-checker",
      "gate_retro_analysis_unreadable",
      "hard-fail",
      `${relativeTaskDir}/artifacts/gate-retro.analysis.md could not be read as UTF-8 text.`,
      "Restore a readable markdown analysis artifact."
    )];
  }

  return [
    ...validateGateRetroMarkers(body, relativeTaskDir),
    ...validateGateRetroFindings(body, relativeTaskDir),
    ...validateGateRetroEntityRefs(body, relativeTaskDir, resolvableRefs)
  ];
}

function validateGateRetroMarkers(body: string, relativeTaskDir: string): ReadonlyArray<ProfileValidationIssue> {
  const issues: ProfileValidationIssue[] = [];
  for (const marker of gateRetroRequiredMarkers()) {
    if (!body.includes(marker)) {
      issues.push(profileIssue(
        "gate-retro-checker",
        "gate_retro_required_marker_missing",
        "hard-fail",
        `${relativeTaskDir}/artifacts/gate-retro.analysis.md is missing required marker ${marker}.`,
        "Preserve the gate-retro scaffold markers so the checker can verify the output shape."
      ));
    }
  }
  for (const placeholder of gateRetroPlaceholders()) {
    if (body.includes(placeholder)) {
      issues.push(profileIssue(
        "gate-retro-checker",
        "gate_retro_placeholder_remaining",
        "hard-fail",
        `${relativeTaskDir}/artifacts/gate-retro.analysis.md still contains scaffold placeholder text.`,
        "Replace scaffold placeholders with real command/output evidence or remove unused finding blocks."
      ));
    }
  }
  return issues;
}

function validateGateRetroFindings(body: string, relativeTaskDir: string): ReadonlyArray<ProfileValidationIssue> {
  const issues: ProfileValidationIssue[] = [];
  for (const [index, block] of gateRetroFindingBlocks(body).entries()) {
    if (!/\bCommand:\s*[\s\S]*?```(?:sh|bash|shell)?\s*[\r\n]+[\s\S]+?```/u.test(block) || !/\bOutput:\s*[\s\S]*?```(?:text|txt|log)?\s*[\r\n]+[\s\S]+?```/u.test(block)) {
      issues.push(profileIssue(
        "gate-retro-checker",
        "gate_retro_finding_evidence_missing",
        "hard-fail",
        `${relativeTaskDir}/artifacts/gate-retro.analysis.md finding ${index + 1} lacks a command and output evidence block.`,
        "Every rot accusation must include reproducible command and output evidence."
      ));
    }
    if (/Severity:\s*[^\n]*load-bearing/iu.test(block) && !/(?:decision\/dec_[A-Za-z0-9_]+|ha\s+decision\s+propose)/u.test(block)) {
      issues.push(profileIssue(
        "gate-retro-checker",
        "gate_retro_load_bearing_decision_missing",
        "hard-fail",
        `${relativeTaskDir}/artifacts/gate-retro.analysis.md finding ${index + 1} is load-bearing but does not cite a proposed decision.`,
        "Run ha decision propose for load-bearing issues and cite the decision ref in the finding."
      ));
    }
  }
  return issues;
}

function validateGateRetroEntityRefs(body: string, relativeTaskDir: string, resolvableRefs: ReadonlySet<string>): ReadonlyArray<ProfileValidationIssue> {
  const unresolved = [...new Set(findEntityRefs(body)
    .filter((ref) => !ref.externalHarness)
    .map((ref) => ref.raw))]
    .filter((ref) => !resolvableRefs.has(ref));
  return unresolved.map((ref) => profileIssue(
    "gate-retro-checker",
    "gate_retro_entity_ref_unresolved",
    "hard-fail",
    `${relativeTaskDir}/artifacts/gate-retro.analysis.md references unresolved entity ${ref}.`,
    "Replace bubble references with real task, decision, or fact refs from authored Harness packages."
  ));
}

function gateRetroRequiredMarkers(): ReadonlyArray<string> {
  return [
    "<!-- gate-retro:ground-truth-warning -->",
    "<!-- gate-retro:adr-checklist -->",
    "<!-- gate-retro:defect-patterns -->",
    "<!-- gate-retro:evidence-ledger -->",
    "<!-- gate-retro:decision-projection -->",
    "<!-- gate-retro:verdict -->"
  ];
}

function gateRetroPlaceholders(): ReadonlyArray<string> {
  return [
    "Replace with claim title",
    "替换为 claim 标题",
    "# command run from repository root",
    "# paste relevant output",
    "# paste relevant output; do not paraphrase the only evidence"
  ];
}

function gateRetroFindingBlocks(body: string): ReadonlyArray<string> {
  return [...body.matchAll(/<!--\s*finding:start\s*-->([\s\S]*?)<!--\s*finding:end\s*-->/gu)]
    .map((match) => match[1]);
}
