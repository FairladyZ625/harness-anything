import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseReviewMarkdown } from "../../../application/src/index.ts";
import { checkTaskProjection } from "../../../kernel/src/index.ts";
import { listTaskIndexPaths, normalizeRelativeDocumentPath, readFrontmatter, readScalar, resolveHarnessLayout } from "../../../kernel/src/layout/index.ts";
import { commandRegistry } from "../cli/command-registry.ts";
import { relativePath } from "../cli/path.ts";
import type { CheckProfile, CliResult } from "../cli/types.ts";
import { isInvalidPreset, materializePresetTaskDocuments, resolvePresetEntry } from "./extensions/state.ts";

const FORCE_STATUS_AUDIT_MARKER = "FORCE_STATUS_SET_AUDIT";

interface ProfileValidationIssue {
  readonly code: string;
  readonly source: string;
  readonly severity: "warning" | "hard-fail";
  readonly message: string;
  readonly repairHint: string;
}

export function runCheckProfile(
  rootDir: string,
  action: { readonly kind: "check"; readonly profile: CheckProfile; readonly strict: boolean; readonly postMerge: boolean }
): CliResult {
  const profilePostMerge = action.postMerge || action.profile === "private-harness" || action.profile === "target-project" || action.strict;
  const projection = checkTaskProjection({ rootDir, postMerge: profilePostMerge });
  const validatorIssues = validateCheckProfile(rootDir, action.profile, action.strict);
  const warnings = [...projection.warnings, ...validatorIssues];
  const validatorHardFailCount = validatorIssues.filter((issue) => issue.severity === "hard-fail").length;
  const hardFailCount = warnings.filter((issue) => issue.severity === "hard-fail").length;
  const ok = hardFailCount === 0;
  const validatorSummary = summarizeValidatorIssues(validatorIssues);
  const profileReport = {
    schema: "harness-check-profile-report/v1",
    profile: action.profile,
    strict: action.strict,
    postMerge: profilePostMerge,
    projection: projection.report,
    validators: validatorSummary,
    summary: {
      rowCount: projection.rows.length,
      warningCount: warnings.length,
      hardFailCount
    }
  };
  return {
    ok,
    command: checkCommandName(action),
    profile: action.profile,
    rows: projection.rows.length,
    warnings,
    commands: commandRegistry,
    report: action.profile === "source-package" ? projection.report : profileReport,
    error: ok ? undefined : {
      code: projection.report.summary.hardFailCount > 0 && validatorHardFailCount === 0 ? "projection_check_failed" : "check_profile_failed",
      hint: `Harness check profile ${action.profile} found hard-fail issues.`
    }
  };
}

function validateCheckProfile(rootDir: string, profile: CheckProfile, strict: boolean): ReadonlyArray<ProfileValidationIssue> {
  const issues: ProfileValidationIssue[] = [];
  if (profile !== "source-package" || strict) {
    const taskDirs = listTaskIndexPaths(rootDir).map((indexPath) => path.dirname(indexPath));
    for (const taskDir of taskDirs) {
      issues.push(...validateTaskPackageContracts(rootDir, taskDir, profile, strict));
    }
  }

  if (profile === "private-harness" || profile === "target-project") {
    issues.push(...validateContextDocs(rootDir, strict));
    issues.push(...validateGovernanceGeneratedViews(rootDir, strict));
  }

  return issues;
}

function checkCommandName(action: { readonly profile: CheckProfile; readonly strict: boolean; readonly postMerge: boolean }): string {
  if (action.profile === "source-package" && !action.strict && !action.postMerge) return "check";
  if (action.profile === "source-package" && !action.strict && action.postMerge) return "check --post-merge";
  return `check:${action.profile}`;
}

function validateTaskPackageContracts(rootDir: string, taskDir: string, profile: CheckProfile, strict: boolean): ReadonlyArray<ProfileValidationIssue> {
  const issues: ProfileValidationIssue[] = [];
  const relativeTaskDir = relativePath(rootDir, taskDir);
  const indexPath = path.join(taskDir, "INDEX.md");
  const indexBody = readFileSync(indexPath, "utf8");
  const frontmatter = readFrontmatter(indexBody);
  if (!frontmatter) {
    issues.push(profileIssue("task-plan-contract", "task_index_frontmatter_missing", "hard-fail", `${relativeTaskDir}/INDEX.md is missing frontmatter.`, "Restore task package frontmatter before running check profiles."));
    return issues;
  }
  const vertical = readScalar(frontmatter, "vertical");
  const metadataDriven = vertical === "software/coding";
  issues.push(...validateMetadataDrivenTaskPackage(rootDir, taskDir, relativeTaskDir, frontmatter));

  const taskPlanPath = path.join(taskDir, "task_plan.md");
  if (!existsSync(taskPlanPath)) {
    issues.push(profileIssue("task-plan-contract", "task_plan_missing", "hard-fail", `${relativeTaskDir}/task_plan.md is missing.`, "Restore task_plan.md from the task template or supersede the package."));
  } else {
    const taskPlanBody = readFileSync(taskPlanPath, "utf8");
    if (!/Task Contract:\s*harness-task(?:\/|\s+)v1/u.test(taskPlanBody) && profile !== "source-package") {
      issues.push(profileIssue("task-plan-contract", "task_contract_marker_missing", strictSeverity(strict), `${relativeTaskDir}/task_plan.md lacks Task Contract: harness-task/v1.`, "Add the task contract marker or keep this package outside strict M2 profiles."));
    }
    if (hasTemplatePlaceholder(taskPlanBody)) {
      issues.push(profileIssue("task-plan-contract", "task_plan_placeholder", "hard-fail", `${relativeTaskDir}/task_plan.md still contains template placeholders.`, "Replace scaffold placeholders before treating the task package as implementation-ready."));
    }
  }

  const progressPath = path.join(taskDir, "progress.md");
  if (existsSync(progressPath) && readFileSync(progressPath, "utf8").includes(FORCE_STATUS_AUDIT_MARKER)) {
    issues.push(profileIssue(
      "completion-policy",
      "forced_terminal_status_set",
      "warning",
      `${relativeTaskDir}/progress.md contains forced terminal status audit evidence.`,
      "Review FORCE_STATUS_SET_AUDIT before treating this terminal state as normal completion."
    ));
  }

  const reviewPath = path.join(taskDir, "review.md");
  if (existsSync(reviewPath)) {
    const parsed = parseReviewMarkdown(readFileSync(reviewPath, "utf8"));
    for (const issue of parsed.issues) {
      issues.push(profileIssue("review-schema", "review_schema_invalid", "hard-fail", `${relativeTaskDir}/review.md failed review schema validation.`, JSON.stringify(issue)));
    }
  } else if (profile !== "source-package") {
    issues.push(profileIssue("review-schema", "review_missing", strictSeverity(strict), `${relativeTaskDir}/review.md is missing.`, "Add review.md before strict private-harness/target-project validation."));
  }

  const visualPath = path.join(taskDir, "visual_map.md");
  if (existsSync(visualPath)) {
    const visualBody = readFileSync(visualPath, "utf8");
    if (!/\| Phase ID \| Kind \| Depends On \| State \| Completion \|/u.test(visualBody)) {
      issues.push(profileIssue("visual-map", "visual_phase_table_missing", strictSeverity(strict), `${relativeTaskDir}/visual_map.md lacks the canonical phase table.`, "Add the Visual Map Contract phase table."));
    }
    if (hasTemplatePlaceholder(visualBody)) {
      issues.push(profileIssue("visual-map", "visual_map_placeholder", "hard-fail", `${relativeTaskDir}/visual_map.md still contains template placeholders.`, "Replace scaffold placeholders in the visual map."));
    }
  } else if (profile !== "source-package" && !metadataDriven) {
    issues.push(profileIssue("visual-map", "visual_map_missing", strictSeverity(strict), `${relativeTaskDir}/visual_map.md is missing.`, "Add visual_map.md or record why this task is exempt."));
  }

  const executionPath = path.join(taskDir, "execution_strategy.md");
  if (existsSync(executionPath)) {
    const executionBody = readFileSync(executionPath, "utf8");
    if (/\| worker subagent \| pending \|/u.test(executionBody)) {
      issues.push(profileIssue("subagent-authorization", "worker_authorization_pending", strictSeverity(strict), `${relativeTaskDir}/execution_strategy.md has pending worker authorization.`, "Resolve worker authorization as authorized, denied, or not-needed before strict validation."));
    }
  }

  const lessonPath = path.join(taskDir, "lesson_candidates.md");
  if (existsSync(lessonPath)) {
    const lessonBody = readFileSync(lessonPath, "utf8");
    if (hasTemplatePlaceholder(lessonBody) && !/Task-level status \| pending-review/u.test(lessonBody)) {
      issues.push(profileIssue("lesson-routing", "lesson_placeholder", strictSeverity(strict), `${relativeTaskDir}/lesson_candidates.md contains unresolved placeholders.`, "Resolve lesson candidate routing before closeout."));
    }
  }

  const status = readScalar(frontmatter, "  status");
  if ((status === "done" || status === "in_review") && !existsSync(path.join(taskDir, "walkthrough.md")) && !existsSync(path.join(taskDir, "closeout.md"))) {
    issues.push(profileIssue("completion-consistency", "closeout_missing", strictSeverity(strict), `${relativeTaskDir} is ${status} without closeout evidence.`, "Add walkthrough.md/closeout.md before claiming completion."));
  }

  return issues;
}

function validateMetadataDrivenTaskPackage(
  rootDir: string,
  taskDir: string,
  relativeTaskDir: string,
  frontmatter: string
): ReadonlyArray<ProfileValidationIssue> {
  const vertical = readScalar(frontmatter, "vertical");
  const presetId = readScalar(frontmatter, "preset");
  if (!vertical || vertical === "default") return [];
  if (vertical !== "software/coding") {
    return [profileIssue(
      "metadata-contract",
      "unsupported_vertical_metadata",
      "hard-fail",
      `${relativeTaskDir}/INDEX.md records unsupported vertical ${vertical}.`,
      "Use software/coding until project custom vertical checks are enabled by P10/P11."
    )];
  }
  if (!presetId || presetId === "default") {
    return [profileIssue(
      "metadata-contract",
      "metadata_preset_missing",
      "hard-fail",
      `${relativeTaskDir}/INDEX.md records software/coding without a concrete preset.`,
      "Record the selected preset in task frontmatter or rebuild the task package."
    )];
  }
  const profile = readScalar(frontmatter, "profile") || undefined;

  const preset = resolvePresetEntry(rootDir, presetId);
  if (!preset) {
    return [profileIssue(
      "metadata-preset",
      "metadata_preset_not_found",
      "hard-fail",
      `${relativeTaskDir}/INDEX.md references unknown preset ${presetId}.`,
      "Install the preset or update the task frontmatter to a valid preset id."
    )];
  }
  if (isInvalidPreset(preset)) {
    return preset.issues.map((issue) => profileIssue(
      "metadata-preset",
      issue.code,
      "hard-fail",
      `${relativeTaskDir}/INDEX.md preset ${presetId} is blocked by active ${preset.layer} preset validation: ${issue.message}`,
      "Fix or remove the active preset override before running check."
    ));
  }

  const materialized = materializePresetTaskDocuments(preset.manifest, { profileId: profile, locale: "zh-CN" });
  const issues: ProfileValidationIssue[] = [];
  if (!materialized.ok) {
    issues.push(...materialized.issues.map((issue) => profileIssue(
      "metadata-template",
      issue.code,
      "hard-fail",
      `${relativeTaskDir}/INDEX.md preset ${presetId} cannot materialize required template metadata: ${issue.message}`,
      "Fix the preset/template metadata before running check."
    )));
    return issues;
  }

  for (const document of materialized.documents) {
    let safeDocumentPath: string;
    try {
      safeDocumentPath = normalizeRelativeDocumentPath(document.materializeAs);
    } catch (error) {
      issues.push(profileIssue(
        "metadata-template",
        "invalid_materialized_path",
        "hard-fail",
        `${relativeTaskDir}/INDEX.md preset ${presetId} has invalid materialized path ${document.materializeAs}: ${error instanceof Error ? error.message : "invalid path"}.`,
        "Fix the preset/template metadata before running check."
      ));
      continue;
    }
    const documentPath = path.join(taskDir, safeDocumentPath);
    const relativeDocumentPath = `${relativeTaskDir}/${document.materializeAs}`;
    if (!existsSync(documentPath)) {
      issues.push(profileIssue(
        "metadata-template",
        "metadata_document_missing",
        "hard-fail",
        `${relativeDocumentPath} is required by vertical ${vertical} preset ${presetId}.`,
        "Restore the required materialized document or rebuild the task package from the preset."
      ));
      continue;
    }
    let body: string;
    try {
      body = readFileSync(documentPath, "utf8");
    } catch {
      issues.push(profileIssue(
        "metadata-template",
        "metadata_document_unreadable",
        "hard-fail",
        `${relativeDocumentPath} could not be read as a file.`,
        "Restore the required materialized document as a readable file."
      ));
      continue;
    }
    for (const anchor of document.requiredAnchors) {
      if (!body.includes(anchor)) {
        issues.push(profileIssue(
          "metadata-template",
          "metadata_required_anchor_missing",
          "hard-fail",
          `${relativeDocumentPath} is missing required anchor ${anchor}.`,
          "Restore the required anchor or rebuild the document from the selected template."
        ));
      }
    }
    if (document.fallbackUsed) {
      issues.push(profileIssue(
        "metadata-template",
        "metadata_locale_fallback_used",
        "warning",
        `${relativeDocumentPath} used locale fallback ${document.locale}.`,
        "Review locale settings once project default locale is configured."
      ));
    }
  }

  return issues;
}

function validateContextDocs(rootDir: string, strict: boolean): ReadonlyArray<ProfileValidationIssue> {
  const issues: ProfileValidationIssue[] = [];
  for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
    const filePath = path.join(rootDir, fileName);
    if (!existsSync(filePath)) {
      issues.push(profileIssue("context-docs", "context_doc_missing", strictSeverity(strict), `${fileName} is missing.`, `Add ${fileName} or keep the project outside strict target-project/private-harness profiles.`));
    }
  }
  return issues;
}

function validateGovernanceGeneratedViews(rootDir: string, strict: boolean): ReadonlyArray<ProfileValidationIssue> {
  const layout = resolveHarnessLayout(rootDir);
  const issues: ProfileValidationIssue[] = [];
  const generatedRegistry = path.join(layout.generatedRoot, "Module-Registry.md");
  const authoredModules = path.join(layout.authoredRoot, "modules.json");
  if (existsSync(authoredModules) && !existsSync(generatedRegistry)) {
    issues.push(profileIssue("governance-boundary", "module_registry_projection_missing", strictSeverity(strict), ".harness/generated/Module-Registry.md is missing for authored modules.json.", "Run harness module scaffold/register or governance rebuild to regenerate local views."));
  }
  return issues;
}

function profileIssue(source: string, code: string, severity: "warning" | "hard-fail", message: string, repairHint: string): ProfileValidationIssue {
  return { source, code, severity, message, repairHint };
}

function strictSeverity(strict: boolean): "warning" | "hard-fail" {
  return strict ? "hard-fail" : "warning";
}

function hasTemplatePlaceholder(body: string): boolean {
  return /\[(?:用一句话|说明|为什么|路径|风险|owner|负责人|该产物|这份资料|标准 \d|步骤 \d|范围|未采用|什么时候必须确认)[^\]]*\]/u.test(body);
}

function summarizeValidatorIssues(issues: ReadonlyArray<ProfileValidationIssue>): ReadonlyArray<{ readonly source: string; readonly warningCount: number; readonly hardFailCount: number; readonly codes: ReadonlyArray<string> }> {
  const sources = [...new Set(issues.map((issue) => issue.source))].sort();
  return sources.map((source) => {
    const sourceIssues = issues.filter((issue) => issue.source === source);
    return {
      source,
      warningCount: sourceIssues.filter((issue) => issue.severity === "warning").length,
      hardFailCount: sourceIssues.filter((issue) => issue.severity === "hard-fail").length,
      codes: [...new Set(sourceIssues.map((issue) => issue.code))].sort()
    };
  });
}

export function isCheckProfile(value: string): value is CheckProfile {
  return value === "source-package" || value === "private-harness" || value === "target-project";
}
